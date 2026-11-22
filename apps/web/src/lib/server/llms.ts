/**
 * The docs for agents, served at /llms.txt and /llms-full.txt (C25; docs/features/ai.md has the user view).
 * scripts/llms.mjs builds both files from docs/published.json; the host image carries them in `llms/`. The routes pass
 * one of two fixed names: nothing from the request reaches the file system, and nothing else in the folder is readable.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { envString } from './config/parse';

export type LlmsFileName = 'llms.txt' | 'llms-full.txt';
const NAMES: readonly string[] = ['llms.txt', 'llms-full.txt'];

/**
 * Where the bundle is: LANDFLOW_LLMS_DIR, else `<cwd>/llms` (the image; the host runs from apps/web), else the
 * repository's docs/ (development, after `pnpm docs:llms`). The first folder that holds the file wins.
 */
function folders(): string[] {
  const configured = envString('LANDFLOW_LLMS_DIR');
  return configured ? [configured] : [join(process.cwd(), 'llms'), join(process.cwd(), '..', '..', 'docs')];
}

/** The file's text, or undefined when this host was built without it (or the name is not one of the two). */
export async function llmsFile(name: LlmsFileName): Promise<string | undefined> {
  if (!NAMES.includes(name)) return undefined;
  for (const folder of folders()) {
    try {
      return await readFile(join(folder, name), 'utf8');
    } catch {
      // Not in this folder: try the next one.
    }
  }
  return undefined;
}

/** The route body shared by both files: public, cacheable for an hour, plain text. */
export async function llmsResponse(name: LlmsFileName): Promise<Response> {
  const text = await llmsFile(name);
  if (text === undefined) {
    return Response.json({ error: `${name} is not built into this host; run pnpm docs:llms` }, { status: 404 });
  }
  return new Response(text, {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'public, max-age=3600',
      'x-content-type-options': 'nosniff',
    },
  });
}
