import { z } from 'zod';
import { buildFlow } from '@/lib/server/flow-builder';
import { error, handler, json, parseBody } from '@/lib/server/http';

export const dynamic = 'force-dynamic';

const Body = z.object({ prompt: z.string().trim().min(3).max(2000), model: z.string().max(100).optional() });

/** POST { prompt } → a validated flow draft from the local model. */
export const POST = handler(async (request: Request) => {
  const parsed = await parseBody(request, Body);
  if (!parsed.ok) return parsed.response;
  try {
    return json({ draft: await buildFlow(parsed.data.prompt, parsed.data.model) });
  } catch (e) {
    return error((e as Error).message, 502);
  }
});
