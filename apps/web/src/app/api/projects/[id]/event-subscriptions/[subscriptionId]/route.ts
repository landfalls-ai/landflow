/**
 * One event subscription of a project (docs/features/event-subscriptions.md); project admins, and instance owners and admins.
 * PATCH { name?, url?, events?, workflowIds?, nodeNames?, includeOutput?, ordered?, enabled?, newSecret? } — change it;
 *        turning it back on clears why it was off; `newSecret: true` replaces the signing secret and answers the new one once.
 * DELETE — remove it and the events still waiting for it.
 */
import { json, parseBody } from '@/lib/server/http';
import { deleteSubscription, EventSubscriptionError, getSubscription, subscriptionPatchSchema, updateSubscription } from '@/lib/server/outbox/subscriptions';
import { projectRoute, requireProject, routeActor } from '@/lib/server/projects/http';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string; subscriptionId: string }> };

/** The subscription, only when it belongs to the project in the URL (another project's id is a 404). */
async function owned(params: Ctx['params']) {
  const { id, subscriptionId } = await params;
  const project = requireProject(routeActor(), id, 'manage');
  const subscription = getSubscription(subscriptionId);
  if (!subscription || subscription.projectId !== project.id) throw new EventSubscriptionError('Event subscription not found', 404);
  return subscription;
}

export const PATCH = projectRoute(async (request: Request, { params }: Ctx) => {
  const subscription = await owned(params);
  const body = await parseBody(request, subscriptionPatchSchema);
  if (!body.ok) return body.response;
  return json(updateSubscription(subscription.id, body.data));
});

export const DELETE = projectRoute(async (_request: Request, { params }: Ctx) => {
  const subscription = await owned(params);
  deleteSubscription(subscription.id);
  return json({ ok: true });
});
