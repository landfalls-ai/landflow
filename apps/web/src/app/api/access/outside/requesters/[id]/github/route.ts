/** DELETE /api/access/outside/requesters/:id/github (instance admins): clear the GitHub username an outside requester typed (unverified; it is one person's, so a squatted name can be freed) → the requester. Audited as `access.account.set`. */
import { clearRequesterGithub } from '@/lib/server/access/outside/admin';
import { handler, json } from '@/lib/server/http';
import { routeActor } from '@/lib/server/projects/http';

export const dynamic = 'force-dynamic';

export const DELETE = handler(async (_request: Request, { params }: { params: Promise<{ id: string }> }) => json(clearRequesterGithub(routeActor(), (await params).id)));
