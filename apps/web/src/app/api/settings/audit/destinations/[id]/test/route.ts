/** POST /api/settings/audit/destinations/:id/test — send one test event straight to the destination; answers `{ ok, message }`. */
import { auditDestinations } from '@/lib/server/audit/destinations';
import { sendTestEvent } from '@/lib/server/audit/outbox';
import { error, handler, json } from '@/lib/server/http';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

export const POST = handler(async (_request: Request, { params }: Ctx) => {
  const { id } = await params;
  if (!auditDestinations.get(id)) return error('Audit destination not found', 404);
  const result = await sendTestEvent(id);
  return json({ ...result, destination: auditDestinations.get(id) });
});
