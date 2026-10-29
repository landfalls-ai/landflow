/**
 * DELETE /api/composites/:type — delete a library type (`local.<name>`), every version: whoever saved it, or an owner
 * or admin. Frames typed by it keep their nodes; their contract shows as unavailable. Plugin types go with the plugin.
 */
import { currentPrincipal } from '@/lib/server/auth/guard';
import { deleteLocalComposite, LOCAL_PREFIX, localCompositeOwner } from '@/lib/server/composites';
import { error, handler, json } from '@/lib/server/http';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ type: string }> };

export const DELETE = handler(async (_request: Request, ctx: Ctx) => {
  const { type } = await ctx.params;
  if (!type.startsWith(LOCAL_PREFIX)) return error('Only composite types saved on this instance (local.<name>) can be deleted; a plugin’s go with the plugin');
  const owner = localCompositeOwner(type);
  if (!owner) return error('Composite type not found', 404);
  const user = currentPrincipal()?.user;
  if (user && user.role !== 'owner' && user.role !== 'admin' && owner.createdBy !== user.id) return error('Only whoever saved this type, or an owner or admin, can delete it', 403);
  deleteLocalComposite(type);
  return json({ ok: true });
});
