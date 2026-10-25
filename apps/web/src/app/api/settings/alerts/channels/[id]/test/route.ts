import { withAlertErrors } from '@/lib/server/alerts/api';
import { alerts } from '@/lib/server/alerts/service';
import { alertStore } from '@/lib/server/alerts/store';
import { handler, json } from '@/lib/server/http';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

/** POST: send a test alert through the saved channel; answers { delivery, channel } (delivery.ok false: why). */
export const POST = handler(async (_request: Request, { params }: Ctx) => {
  const { id } = await params;
  return withAlertErrors(async () => {
    const delivery = await alerts.test(id);
    return json({ delivery, channel: alertStore.channel(id) });
  });
});
