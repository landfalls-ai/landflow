/** DELETE /api/api-keys/<id>: revoke one of your keys (owners and admins can revoke anyone's). It stops working at once. */
import { can } from '@/lib/shared/auth';
import { deleteApiKey, getApiKey, requireUser } from '@/lib/server/auth';
import { error, handler, json } from '@/lib/server/http';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

export const DELETE = handler(async (_request: Request, { params }: Ctx) => {
  const me = await requireUser();
  const key = getApiKey((await params).id);
  if (!key || (key.userId !== me.id && !can(me, 'users:manage'))) return error('API key not found', 404);
  deleteApiKey(key.id);
  return json({ ok: true });
});
