/**
 * Broker connections (Settings → Transports, owners and admins): GET lists them (config without secret values, which
 * secrets are set, the last Test and the plugins on each); POST `{ name, kind, enabled?, config?, secrets? }` adds one.
 * Connections from `LANDFLOW_TRANSPORT_<KIND>_URL` are listed too, read-only.
 */
import { handler, json, parseBody } from '@/lib/server/http';
import { transportConnections } from '@/lib/server/transports/connections';
import { connectionView, transportsView } from '@/lib/server/transports/view';
import { connectionCreateSchema } from '@/lib/server/transports/schema';

export const dynamic = 'force-dynamic';

export const GET = handler(async () => json({ connections: transportsView().connections }));

export const POST = handler(async (request: Request) => {
  const body = await parseBody(request, connectionCreateSchema);
  if (!body.ok) return body.response;
  return json(connectionView(transportConnections.create(body.data)), 201);
});
