/**
 * POST — Retry now: the subscription's waiting events are due at once and the ones given up on after 72 hours are queued
 * again. Answers `{ retried }`. Project admins, and instance owners and admins.
 */
import { json } from '@/lib/server/http';
import { EventSubscriptionError, getSubscription, retryNow } from '@/lib/server/outbox/subscriptions';
import { projectRoute, requireProject, routeActor } from '@/lib/server/projects/http';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string; subscriptionId: string }> };

export const POST = projectRoute(async (_request: Request, { params }: Ctx) => {
  const { id, subscriptionId } = await params;
  const project = requireProject(routeActor(), id, 'manage');
  const subscription = getSubscription(subscriptionId);
  if (!subscription || subscription.projectId !== project.id) throw new EventSubscriptionError('Event subscription not found', 404);
  return json({ retried: retryNow(subscription.id) });
});
