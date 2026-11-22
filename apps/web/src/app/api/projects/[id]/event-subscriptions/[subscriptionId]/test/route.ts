/**
 * POST — Send test: one signed `test` event straight to the subscription's URL. Answers `{ ok, status?, message }`; a
 * receiver that refuses is a 200 with `ok: false`. Project admins, and instance owners and admins.
 */
import { json } from '@/lib/server/http';
import { sendTestEvent } from '@/lib/server/outbox/dispatcher';
import { EventSubscriptionError, getSubscription } from '@/lib/server/outbox/subscriptions';
import { projectRoute, requireProject, routeActor } from '@/lib/server/projects/http';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string; subscriptionId: string }> };

export const POST = projectRoute(async (_request: Request, { params }: Ctx) => {
  const { id, subscriptionId } = await params;
  const project = requireProject(routeActor(), id, 'manage');
  const subscription = getSubscription(subscriptionId);
  if (!subscription || subscription.projectId !== project.id) throw new EventSubscriptionError('Event subscription not found', 404);
  return json(await sendTestEvent(subscription.id));
});
