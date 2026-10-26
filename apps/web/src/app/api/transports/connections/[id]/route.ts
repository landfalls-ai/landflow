/**
 * One broker connection: GET it (no secret values), PATCH `{ name?, enabled?, config?, secrets? }` (a secret left empty
 * keeps its value, null clears it), DELETE it. Connections from the environment can't be changed here.
 */
import { error, handler, json, parseBody } from '@/lib/server/http';
import { transportConnections, TransportError } from '@/lib/server/transports/connections';
import { connectionView } from '@/lib/server/transports/view';
import { connectionUpdateSchema } from '@/lib/server/transports/schema';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

export const GET = handler(async (_request: Request, { params }: Ctx) => {
  const connection = transportConnections.get((await params).id);
  return connection ? json(connectionView(connection)) : error('Connection not found', 404);
});

export const PATCH = handler(async (request: Request, { params }: Ctx) => {
  const body = await parseBody(request, connectionUpdateSchema);
  if (!body.ok) return body.response;
  try {
    return json(connectionView(transportConnections.update((await params).id, body.data)));
  } catch (caught) {
    if (caught instanceof TransportError) return error(caught.message, caught.status);
    throw caught;
  }
});

export const DELETE = handler(async (_request: Request, { params }: Ctx) => {
  try {
    return transportConnections.delete((await params).id) ? json({ ok: true }) : error('Connection not found', 404);
  } catch (caught) {
    if (caught instanceof TransportError) return error(caught.message, caught.status);
    throw caught;
  }
});
