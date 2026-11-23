// placeholder until C36-A merges: C36-A owns `outsideRoute` (feature check, Origin and JSON checks on writes, the session).
import { handler } from '../../http';
import { requesterFromRequest } from './sessions';
import type { OutsideRequester } from './identity';

export interface OutsideContext {
  req: Request;
  requester: OutsideRequester;
  params: Record<string, string>;
}

export function outsideRoute(fn: (ctx: OutsideContext) => Promise<Response>, _options: { write?: boolean } = {}) {
  return handler(async (req: Request, context?: { params?: Promise<Record<string, string>> }) => {
    const requester = await requesterFromRequest(req);
    if (!requester) return Response.json({ error: 'signed_out' }, { status: 401 });
    return fn({ req, requester, params: (await context?.params) ?? {} });
  });
}
