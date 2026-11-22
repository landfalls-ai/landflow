/**
 * A project's event subscriptions (docs/features/event-subscriptions.md): webhooks that receive the run events of the
 * project's workflows.
 * GET  — `{ subscriptions, canEdit }` with each one's backlog, dead events, last delivery and last error; never the secret
 *        (the project's members).
 * POST { name, url, events, workflowIds?, nodeNames?, includeOutput?, ordered? } — add one; answers 201 with the new
 *        subscription and its signing secret, shown only now (the project's admins, and instance owners and admins).
 */
import { json, parseBody } from '@/lib/server/http';
import { listSubscriptions, createSubscription, subscriptionInputSchema } from '@/lib/server/outbox/subscriptions';
import { projectRoute, requireProject, routeActor } from '@/lib/server/projects/http';
import { projectRoleCan } from '@/lib/shared/projects';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

export const GET = projectRoute(async (_request: Request, { params }: Ctx) => {
  const project = requireProject(routeActor(), (await params).id, 'read');
  return json({ subscriptions: listSubscriptions(project.id), canEdit: projectRoleCan.manage(project.role) });
});

export const POST = projectRoute(async (request: Request, { params }: Ctx) => {
  const actor = routeActor();
  const project = requireProject(actor, (await params).id, 'manage');
  const body = await parseBody(request, subscriptionInputSchema);
  if (!body.ok) return body.response;
  const { subscription, secret } = createSubscription(actor, project.id, body.data);
  return json({ subscription, secret }, 201);
});
