/**
 * The docs for agents, served at /llms.txt and /llms-full.txt (C25; docs/features/ai.md has the user view).
 * scripts/llms.mjs builds both files from docs/published.json; the host image carries them in `llms/`. The routes pass
 * one of two fixed names: nothing from the request reaches the file system, and nothing else in the folder is readable.
 */
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { envString } from './config/parse';
import { singleton } from './singleton';

export type LlmsFileName = 'llms.txt' | 'llms-full.txt';
const NAMES: readonly string[] = ['llms.txt', 'llms-full.txt'];

interface Cached {
  mtimeMs: number;
  size: number;
  text: string;
  etag: string;
}

/** Each file's text, read once and again only when its modification time or size changes (it is 1.1 MB). */
const cache = () => singleton('llms-files', () => new Map<string, Cached>());

/**
 * Where the bundle is: LANDFLOW_LLMS_DIR, else `<cwd>/llms` (the image; the host runs from apps/web), else the
 * repository's docs/ (development, after `pnpm docs:llms`). The first folder that holds the file wins. The comments
 * keep Turbopack from tracing the folders as server files (the whole docs/ tree would land in the standalone output).
 */
function folders(): string[] {
  const configured = envString('LANDFLOW_LLMS_DIR');
  return configured
    ? [configured]
    : [join(/*turbopackIgnore: true*/ process.cwd(), 'llms'), join(/*turbopackIgnore: true*/ process.cwd(), '..', '..', 'docs')];
}

/** The file and its entity tag, or undefined when this host was built without it (or the name is not one of the two). */
async function load(name: LlmsFileName): Promise<Cached | undefined> {
  if (!NAMES.includes(name)) return undefined;
  for (const folder of folders()) {
    const path = join(folder, name);
    try {
      const info = await stat(path);
      const held = cache().get(path);
      if (held && held.mtimeMs === info.mtimeMs && held.size === info.size) return held;
      const text = await readFile(path, 'utf8');
      const fresh = { mtimeMs: info.mtimeMs, size: info.size, text, etag: `"${createHash('sha256').update(text).digest('hex').slice(0, 24)}"` };
      cache().set(path, fresh);
      return fresh;
    } catch {
      // Not in this folder: try the next one.
    }
  }
  return undefined;
}

/** The file's text, or undefined. */
export async function llmsFile(name: LlmsFileName): Promise<string | undefined> {
  return (await load(name))?.text;
}

/** Whether an If-None-Match header names this tag (weak or strong, in a list, or `*`). */
function matches(header: string | null, etag: string): boolean {
  if (!header) return false;
  return header.split(',').some((v) => {
    const tag = v.trim().replace(/^W\//, '');
    return tag === '*' || tag === etag;
  });
}

/** The route body shared by both files: public, cacheable for an hour, plain text, 304 for an unchanged copy. */
export async function llmsResponse(name: LlmsFileName, request: Request): Promise<Response> {
  const file = await load(name);
  if (!file) return Response.json({ error: `${name} is not built into this host; run pnpm docs:llms` }, { status: 404 });
  const headers = { 'cache-control': 'public, max-age=3600', etag: file.etag, 'x-content-type-options': 'nosniff' };
  if (matches(request.headers.get('if-none-match'), file.etag)) return new Response(null, { status: 304, headers });
  return new Response(file.text, { headers: { ...headers, 'content-type': 'text/plain; charset=utf-8' } });
}
