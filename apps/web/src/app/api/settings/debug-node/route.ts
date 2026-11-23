/**
 * the Local node override card of the Debug access dialog (Run Trace page): the owner setting behind the one-node local override (docs/specs/19-debug-token.md).
 * GET `{ enabled, allowedHosts }` (anyone who can read settings); PATCH `{ enabled?, allowedHosts? }` (owners only). Off by default.
 */
import { recordAudit } from '@/lib/server/audit';
import { debugNodePatchSchema, getDebugNodeSettings, updateDebugNodeSettings } from '@/lib/server/debug-node/settings';
import { requireUser } from '@/lib/server/auth';
import { error, handler, json, parseBody } from '@/lib/server/http';

export const dynamic = 'force-dynamic';

export const GET = handler(async () => json(getDebugNodeSettings()));

export const PATCH = handler(async (request: Request) => {
  const me = await requireUser();
  // Owners only: an admin cannot open a way from the host to a laptop.
  if (me.role !== 'owner') return error('Only an owner changes the local node override', 403);
  const body = await parseBody(request, debugNodePatchSchema);
  if (!body.ok) return body.response;
  const before = getDebugNodeSettings();
  let next;
  try {
    next = updateDebugNodeSettings(body.data);
  } catch (caught) {
    return error((caught as Error).message, 400);
  }
  recordAudit({
    action: 'settings.update',
    target: { type: 'settings', id: 'debug-node', name: 'Local node override' },
    summary: `${next.enabled === before.enabled ? 'Changed' : next.enabled ? 'Turned on' : 'Turned off'} the local node override${next.enabled ? ` (${next.allowedHosts.length} allowed host${next.allowedHosts.length === 1 ? '' : 's'})` : ''}`,
    details: { enabled: next.enabled, allowedHosts: next.allowedHosts },
  });
  return json(next);
});
