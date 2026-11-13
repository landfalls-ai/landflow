/**
 * POST /api/transports/connections/:id/test: a round trip through the kind's provider. With a body (`{ kind, config,
 * secrets }`) it tests the form's values before they are saved (secrets left empty fall back to the saved ones). A kind
 * whose driver hasn't landed answers `ok: false` with "No driver for <kind> yet".
 */
import { z } from 'zod';
import { handler, json, parseBody } from '@/lib/server/http';
import { transportConnections } from '@/lib/server/transports/connections';
import { connectionTestSchema } from '@/lib/server/transports/schema';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

export const POST = handler(async (request: Request, { params }: Ctx) => {
  const { id } = await params;
  const text = await request.clone().text();
  let input: z.output<typeof connectionTestSchema> | undefined;
  if (text.trim()) {
    const body = await parseBody(request, connectionTestSchema);
    if (!body.ok) return body.response;
    input = body.data;
  }
  return json(await transportConnections.test(id, input));
});
