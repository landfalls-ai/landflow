/**
 * The workflow's edit lock (lib/server/auth/edit-locks.ts). GET: who holds it. POST { tabId, takeover? }: take or
 * renew it for this editor tab (the editor heartbeats every 10 s); `mine: false` means someone else is editing and
 * the editor is read-only. `takeover` replaces another holder: owners and admins, or the holder from another tab.
 * DELETE ?tabId=: release it (the editor does when it closes).
 */
import { z } from 'zod';
import { can } from '@/lib/shared/auth';
import { requireUser } from '@/lib/server/auth';
import { editLocks, LOCK_HEARTBEAT_MS, LOCK_TTL_MS } from '@/lib/server/auth/edit-locks';
import { error, handler, json, parseBody } from '@/lib/server/http';
import { store } from '@/lib/server/store';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

export const GET = handler(async (_request: Request, { params }: Ctx) => {
  await requireUser();
  return json({ lock: editLocks.get((await params).id) ?? null });
});

const schema = z.object({ tabId: z.string().min(8).max(100), takeover: z.boolean().optional() });

export const POST = handler(async (request: Request, { params }: Ctx) => {
  const me = await requireUser();
  const { id } = await params;
  if (!store.getWorkflow(id)) return error('Workflow not found', 404);
  const body = await parseBody(request, schema);
  if (!body.ok) return body.response;
  if (body.data.takeover) {
    const current = editLocks.get(id);
    if (current && current.userId !== me.id && !can(me, 'workflows:takeover')) return error(`Only owners and admins can take over from ${current.userName}`, 403);
  }
  const result = editLocks.acquire(id, { userId: me.id, userName: me.name, tabId: body.data.tabId }, { takeover: body.data.takeover });
  return json({ ...result, heartbeatMs: LOCK_HEARTBEAT_MS, ttlMs: LOCK_TTL_MS });
});

export const DELETE = handler(async (request: Request, { params }: Ctx) => {
  await requireUser();
  const tabId = new URL(request.url).searchParams.get('tabId');
  if (!tabId) return error('Send ?tabId=');
  return json({ released: editLocks.release((await params).id, tabId) });
});
