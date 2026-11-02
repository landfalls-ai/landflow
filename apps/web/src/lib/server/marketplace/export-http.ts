/** The shared part of GET /api/agents/:id/export and /api/agent-teams/:id/export: query, preview or zip. */
import { currentPrincipal } from '../auth/guard';
import { error, json } from '../http';
import { zipFiles } from '../zip';
import type { ExportOptions, PluginExport } from './export';

const truthy = (value: string | null) => value === '1' || value === 'true';

/** `?format=claude-plugin` (the only one, and the default), `marketplace=1`, `preview=1`; a 400 response for another format. */
export function exportQuery(request: Request): { options: ExportOptions; preview: boolean } | Response {
  const params = new URL(request.url).searchParams;
  const format = params.get('format') ?? 'claude-plugin';
  if (format !== 'claude-plugin') return error('format must be claude-plugin');
  const user = currentPrincipal()?.user;
  return { options: { marketplace: truthy(params.get('marketplace')), author: user?.name || user?.email }, preview: truthy(params.get('preview')) };
}

/** The zip (`preview`: the file list as JSON, for the tree the pages show before downloading). */
export function exportResponse(plugin: PluginExport, preview: boolean): Response {
  if (preview) return json({ name: plugin.name, files: plugin.files.map((f) => ({ path: f.path, bytes: Buffer.byteLength(f.content) })) });
  const zip = zipFiles(plugin.files);
  return new Response(new Uint8Array(zip), {
    headers: { 'content-type': 'application/zip', 'content-disposition': `attachment; filename="${plugin.name}.zip"`, 'content-length': String(zip.length), 'cache-control': 'no-store' },
  });
}
