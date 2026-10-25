import { alertsView, channelCreateSchema, withAlertErrors } from '@/lib/server/alerts/api';
import { alertStore } from '@/lib/server/alerts/store';
import { handler, json, parseBody } from '@/lib/server/http';

export const dynamic = 'force-dynamic';

/** POST { name, kind, config } — a new alert channel; answers with it and the whole view. */
export const POST = handler(async (request: Request) => {
  const body = await parseBody(request, channelCreateSchema);
  if (!body.ok) return body.response;
  return withAlertErrors(() => {
    const channel = alertStore.createChannel(body.data);
    return json({ channel, ...alertsView() }, 201);
  });
});
