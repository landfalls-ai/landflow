import { alertsView, channelPatchSchema, withAlertErrors } from '@/lib/server/alerts/api';
import { alertStore } from '@/lib/server/alerts/store';
import { error, handler, json, parseBody } from '@/lib/server/http';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

/** PATCH { name?, config? } — a secret setting left empty keeps its saved value. */
export const PATCH = handler(async (request: Request, { params }: Ctx) => {
  const body = await parseBody(request, channelPatchSchema);
  if (!body.ok) return body.response;
  const { id } = await params;
  return withAlertErrors(() => json({ channel: alertStore.updateChannel(id, body.data), ...alertsView() }));
});

/** DELETE: the channel, and its place in every rule. */
export const DELETE = handler(async (_request: Request, { params }: Ctx) => {
  if (!alertStore.deleteChannel((await params).id)) return error('Alert channel not found', 404);
  return json(alertsView());
});
