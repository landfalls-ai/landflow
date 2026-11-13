/**
 * A Git sync directory on disk (the `landflow-sync/v1` layout the host's GET /api/sync/export writes): read its
 * managed files, and write an export into it. Only the paths the format owns are read, written or removed, so a
 * README, `.git` or anything else in the directory is left alone. The host's twin is apps/web/src/lib/server/sync/files.ts; the layout itself is in @landflow/protocol.
 */
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DATA_TABLES_DIR, isManagedPath, isSafePath, MANIFEST_FILE, SYNC_FORMAT, VARIABLES_FILE, WORKFLOW_SUFFIX, WORKFLOWS_DIR } from '@landflow/protocol/sync-format';
import { CliError } from '../errors';

// The layout's names and path rules are shared with the host (packages/protocol/src/sync-format.ts). The subpath import
// keeps the CLI bundle from pulling in the whole protocol package (zod, gRPC).
export { isManagedPath, isSafePath, MANIFEST_FILE, SYNC_FORMAT, VARIABLES_FILE, WORKFLOW_SUFFIX };

/** Path → text of the managed files, sorted by path. */
export type SyncFiles = Map<string, string>;

export const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** Every regular file under `root` as a `/`-separated path; dot-directories (`.git`, `.landflow`) and symlinks are skipped. */
function walk(root: string, prefix = ''): string[] {
  let entries: string[];
  try {
    entries = readdirSync(join(root, prefix));
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of entries.sort()) {
    const rel = prefix ? `${prefix}/${name}` : name;
    let stats;
    try {
      stats = lstatSync(join(root, rel));
    } catch {
      continue;
    }
    if (stats.isDirectory()) {
      if (!name.startsWith('.')) out.push(...walk(root, rel));
    } else if (stats.isFile()) out.push(rel);
  }
  return out;
}

export function readSyncDir(root: string): SyncFiles {
  const files: SyncFiles = new Map();
  for (const path of walk(root).filter(isManagedPath).sort()) {
    try {
      files.set(path, readFileSync(join(root, path), 'utf8'));
    } catch (caught) {
      throw new CliError('io', `Can't read ${join(root, path)}: ${(caught as NodeJS.ErrnoException).code ?? (caught as Error).message}`);
    }
  }
  return files;
}

/** Remove directories under `dir` that became empty, deepest first; `dir` itself stays. */
function removeEmptyDirs(root: string, dir: string): boolean {
  let entries: string[];
  try {
    entries = readdirSync(join(root, dir));
  } catch {
    return false;
  }
  let empty = true;
  for (const name of entries) {
    const rel = `${dir}/${name}`;
    let isDir = false;
    try {
      isDir = lstatSync(join(root, rel)).isDirectory();
    } catch {
      continue;
    }
    if (isDir && !name.startsWith('.') && removeEmptyDirs(root, rel)) {
      try {
        rmdirSync(join(root, rel));
        continue;
      } catch {
        // Not empty after all.
      }
    }
    empty = false;
  }
  return empty;
}

/** The first part of `path` (relative to `root`: a parent directory or the file) that is a symbolic link. */
function symlinkOn(root: string, path: string): string | undefined {
  const parts = path.split('/');
  for (let i = 1; i <= parts.length; i++) {
    const rel = parts.slice(0, i).join('/');
    try {
      if (lstatSync(join(root, rel)).isSymbolicLink()) return rel;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Write `files` under `root` (only safe, managed paths; unchanged files are not touched). With `mirror`, managed
 * files that `files` doesn't have are removed, so the directory matches the export exactly.
 */
export function writeSyncDir(root: string, files: SyncFiles, options: { mirror: boolean }): { written: string[]; removed: string[] } {
  const written: string[] = [];
  const removed: string[] = [];
  const writable = [...files].filter(([path]) => isSafePath(path) && isManagedPath(path));
  // Check every path before writing any, so a refusal leaves the directory as it was.
  for (const [path] of writable) {
    const link = symlinkOn(root, path);
    if (link) throw new CliError('io', `${join(root, link)} is a symbolic link: not writing through it`);
  }
  for (const [path, content] of writable) {
    const full = join(root, path);
    let current: string | undefined;
    try {
      current = readFileSync(full, 'utf8');
    } catch {
      current = undefined;
    }
    if (current === content) continue;
    try {
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
    } catch (caught) {
      throw new CliError('io', `Can't write ${full}: ${(caught as NodeJS.ErrnoException).code ?? (caught as Error).message}`);
    }
    written.push(path);
  }
  if (options.mirror) {
    for (const path of walk(root)) {
      if (!isManagedPath(path) || files.has(path)) continue;
      unlinkSync(join(root, path));
      removed.push(path);
    }
    removeEmptyDirs(root, WORKFLOWS_DIR);
    removeEmptyDirs(root, DATA_TABLES_DIR);
  }
  return { written, removed };
}

/** variables.json carries values (it was exported with them, or someone added them). */
export function hasVariableValues(files: SyncFiles): boolean {
  const text = files.get(VARIABLES_FILE);
  if (!text) return false;
  try {
    const parsed = JSON.parse(text) as { variables?: Array<Record<string, unknown>> };
    return Array.isArray(parsed.variables) && parsed.variables.some((v) => v && typeof v === 'object' && 'value' in v);
  } catch {
    return false;
  }
}

/** Equal as JSON (key order and whitespace aside); plain text equality for anything that isn't JSON. */
export function sameDocument(a: string, b: string): boolean {
  if (a === b) return true;
  const canonical = (text: string) => {
    try {
      return JSON.stringify(sortKeys(JSON.parse(text)));
    } catch {
      return undefined;
    }
  };
  const left = canonical(a);
  return left !== undefined && left === canonical(b);
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}
