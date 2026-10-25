/**
 * Read files of a marketplace or plugin: GitHub (one recursive tree listing per repo and ref,
 * cached, then raw.githubusercontent.com per file, which doesn't count against the API rate
 * limit) or, for tests and LANDFLOW_MARKETPLACE_ALLOW_LOCAL=1, a local directory. Every request
 * has a timeout and a size cap; GITHUB_TOKEN, when set, goes only to GitHub's own hosts.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import type { ResolvedSource } from '../../shared/marketplace';
import { localAllowed } from './sources';

const TIMEOUT_MS = 20_000;
export const MAX_TEXT_BYTES = 512 * 1024;
const MAX_TREE_BYTES = 30 * 1024 * 1024;
const TREE_TTL_MS = 10 * 60_000;
const GITHUB_HOSTS = new Set(['api.github.com', 'raw.githubusercontent.com']);

export interface RepoFile {
  path: string;
  size?: number;
}

export interface RepoReader {
  /** Shown in errors and logs. */
  label: string;
  /** Files under the source's directory, paths relative to it. */
  list(): Promise<RepoFile[]>;
  bytes(path: string, maxBytes?: number): Promise<Buffer>;
  text(path: string, maxBytes?: number): Promise<string>;
}

export class FetchError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

/** GET with a timeout and a size cap; only http(s). */
export async function fetchLimited(url: string, options: { maxBytes?: number; accept?: string } = {}): Promise<{ body: Buffer; status: number }> {
  const target = new URL(url);
  if (target.protocol !== 'https:' && target.protocol !== 'http:') throw new FetchError(`Refusing to fetch ${target.protocol} URLs`);
  const token = process.env.GITHUB_TOKEN?.trim();
  const response = await fetch(target, {
    headers: {
      'user-agent': 'landflow-marketplace',
      accept: options.accept ?? '*/*',
      ...(token && GITHUB_HOSTS.has(target.hostname) && { authorization: `Bearer ${token}` }),
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) {
    const remaining = response.headers.get('x-ratelimit-remaining');
    if ((response.status === 403 || response.status === 429) && remaining === '0') {
      throw new FetchError('GitHub’s rate limit for unauthenticated requests (60 an hour) is used up. Set GITHUB_TOKEN on the host, or try again later.', response.status);
    }
    throw new FetchError(response.status === 404 ? `Not found: ${url}` : `${url} answered ${response.status} ${response.statusText}`, response.status);
  }
  const max = options.maxBytes ?? MAX_TEXT_BYTES;
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > max) throw new FetchError(`${url} is larger than ${Math.round(max / 1024)} KB`);
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = response.body?.getReader();
  if (reader) {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel().catch(() => {});
        throw new FetchError(`${url} is larger than ${Math.round(max / 1024)} KB`);
      }
      chunks.push(value);
    }
  }
  return { body: Buffer.concat(chunks), status: response.status };
}

export async function fetchJson<T>(url: string, maxBytes = MAX_TEXT_BYTES): Promise<T> {
  const { body } = await fetchLimited(url, { maxBytes, accept: 'application/json' });
  try {
    return JSON.parse(body.toString('utf8')) as T;
  } catch {
    throw new FetchError(`${url} isn’t valid JSON`);
  }
}

interface TreeEntry {
  path: string;
  type: 'blob' | 'tree' | 'commit';
  size?: number;
}

const trees = new Map<string, { at: number; files: RepoFile[] }>();

async function githubTree(owner: string, repo: string, ref: string): Promise<RepoFile[]> {
  const key = `${owner}/${repo}@${ref}`;
  const cached = trees.get(key);
  if (cached && Date.now() - cached.at < TREE_TTL_MS) return cached.files;
  const url = `https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`;
  const tree = await fetchJson<{ tree: TreeEntry[]; truncated?: boolean }>(url, MAX_TREE_BYTES);
  if (tree.truncated) throw new FetchError(`${owner}/${repo} is too large to list through the GitHub API`);
  const files = tree.tree.filter((e) => e.type === 'blob').map((e) => ({ path: e.path, size: e.size }));
  trees.set(key, { at: Date.now(), files });
  return files;
}

/** Forget cached listings (Refresh). */
export function clearTreeCache() {
  trees.clear();
}

function githubReader(source: Extract<ResolvedSource, { kind: 'github' }>): RepoReader {
  const prefix = source.path ? `${source.path.replace(/\/+$/, '')}/` : '';
  const raw = (path: string) =>
    `https://raw.githubusercontent.com/${source.owner}/${source.repo}/${encodeURIComponent(source.ref)}/${`${prefix}${path}`.split('/').map(encodeURIComponent).join('/')}`;
  const reader: RepoReader = {
    label: `${source.owner}/${source.repo}${source.path ? `/${source.path}` : ''}@${source.ref}`,
    async list() {
      const files = await githubTree(source.owner, source.repo, source.ref);
      return files.filter((f) => f.path.startsWith(prefix)).map((f) => ({ ...f, path: f.path.slice(prefix.length) }));
    },
    async bytes(path, maxBytes) {
      return (await fetchLimited(raw(path), { maxBytes })).body;
    },
    async text(path, maxBytes) {
      return (await reader.bytes(path, maxBytes)).toString('utf8');
    },
  };
  return reader;
}

const SKIP_DIRS = new Set(['node_modules', '.git', '.venv', '__pycache__']);

function localReader(root: string, path: string): RepoReader {
  if (!localAllowed()) throw new FetchError('Local marketplaces are disabled (LANDFLOW_MARKETPLACE_ALLOW_LOCAL=1)');
  const base = resolve(root, path);
  if (base !== resolve(root) && !base.startsWith(resolve(root) + sep)) throw new FetchError('Path escapes the marketplace directory');
  const inside = (file: string) => {
    const full = resolve(base, file);
    if (!full.startsWith(base + sep)) throw new FetchError(`Path escapes the plugin directory: ${file}`);
    return full;
  };
  const reader: RepoReader = {
    label: base,
    async list() {
      const files: RepoFile[] = [];
      const walk = (dir: string) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (entry.isDirectory()) {
            if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name));
          } else if (entry.isFile()) {
            const full = join(dir, entry.name);
            files.push({ path: relative(base, full).split(sep).join('/'), size: statSync(full).size });
          }
        }
      };
      walk(base);
      return files;
    },
    async bytes(file, maxBytes = MAX_TEXT_BYTES) {
      const full = inside(file);
      if (statSync(full).size > maxBytes) throw new FetchError(`${file} is larger than ${Math.round(maxBytes / 1024)} KB`);
      return readFileSync(full);
    },
    async text(file, maxBytes) {
      return (await reader.bytes(file, maxBytes)).toString('utf8');
    },
  };
  return reader;
}

export function readerFor(source: ResolvedSource): RepoReader {
  if (source.kind === 'github') return githubReader(source);
  if (source.kind === 'local') return localReader(source.root, source.path);
  throw new FetchError(source.reason);
}
