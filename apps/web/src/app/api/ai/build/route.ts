import { z } from 'zod';
import { roster } from '@/lib/server/assistant/roster';
import { buildFlow } from '@/lib/server/flow-builder';
import { error, handler, json, parseBody } from '@/lib/server/http';

export const dynamic = 'force-dynamic';

const Body = z.object({ prompt: z.string().trim().min(3).max(2000), model: z.string().max(100).optional() });

/** POST { prompt } → a validated flow draft from the local model. */
export const POST = handler(async (request: Request) => {
  const parsed = await parseBody(request, Body);
  if (!parsed.ok) return parsed.response;
  try {
    // The published agents and teams the caller can see, as Spotlight's chat gets them: a step that needs an agent runs
    // one of them when one fits, and Run an Agent and Run a Team need real ones.
    const { agents, teams } = roster();
    return json({ draft: await buildFlow(parsed.data.prompt, parsed.data.model, teams, agents) });
  } catch (e) {
    return error((e as Error).message, 502);
  }
});
