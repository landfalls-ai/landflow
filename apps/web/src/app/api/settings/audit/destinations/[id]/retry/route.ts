/** POST /api/settings/audit/destinations/:id/retry — deliver what is queued for the destination now (after fixing it), without waiting for the backoff. */
import { auditDestinations } from '@/lib/server/audit/destinations';
import { drainOutbox, retryDestinationNow } from '@/lib/server/audit/outbox';
import { error, handler, json } from '@/lib/server/http';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

export const POST = handler(async (_request: Request, { params }: Ctx) => {
  const { id } = await params;
  if (!auditDestinations.get(id)) return error('Audit destination not found', 404);
  const queued = retryDestinationNow(id);
  const delivered = await drainOutbox();
  return json({ queued, delivered, destination: auditDestinations.get(id) });
});
