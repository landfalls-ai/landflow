/** PUT /api/settings/networks/:id { name?, description? } renames or describes a network; DELETE removes it and revokes its runners (C29). A built-in admin's. */
import { requireUser } from '@/lib/server/auth';
import { handler, json, parseBody } from '@/lib/server/http';
import { deleteNetwork, updateNetwork } from '@/lib/server/networks/store';
import { networkUpdateSchema } from '@/lib/server/networks/schema';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

export const PUT = handler(async (request: Request, { params }: Params) => {
  const me = await requireUser('settings:manage');
  const body = await parseBody(request, networkUpdateSchema);
  if (!body.ok) return body.response;
  return json({ network: updateNetwork((await params).id, body.data, me) });
});

export const DELETE = handler(async (_request: Request, { params }: Params) => {
  const me = await requireUser('settings:manage');
  deleteNetwork((await params).id, me);
  return json({ ok: true });
});
