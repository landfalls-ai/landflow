import { z } from 'zod';
import { poller } from '@/lib/server/poller';
import { error, handler, json, parseBody } from '@/lib/server/http';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

/** Status of the workflow's poll triggers: interval, last poll, new items, errors. */
export const GET = handler(async (_request: Request, { params }: Ctx) => json({ polls: poller.status((await params).id) }));

/** POST { nodeId } — poll now instead of waiting for the interval. */
export const POST = handler(async (request: Request, { params }: Ctx) => {
  const body = await parseBody(request, z.object({ nodeId: z.string() }));
  if (!body.ok) return body.response;
  try {
    return json({ poll: await poller.pollNow((await params).id, body.data.nodeId) });
  } catch (caught) {
    return error((caught as Error).message, 409);
  }
});
