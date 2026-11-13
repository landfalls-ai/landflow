/**
 * Publish the draft as a new version (schedules, channels and the Run an Agent node use it), or unpublish. An agent
 * deployed to kagent gets the new version there too (`kagent` in the answer: its status, or why it couldn't be written);
 * unpublishing leaves kagent's copy as it is.
 */
import { adoptRun, checkPublish, EvalGateError, type GateResult } from '@/lib/server/agents/eval-gate';
import { agentStore, configOf } from '@/lib/server/agents/store';
import { z } from 'zod';
import { error, handler, json, parseBody } from '@/lib/server/http';
import { redeployIfDeployed } from '@/lib/server/kagent/deploy';
import { hasPrompt } from '@/lib/shared/persona';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

/**
 * With test cases, the draft is run against them first (the eval gate): a score below 3 / 5, or more than half a point under
 * the published version's last one, answers 409 with the verdict and the run. `{ "skipEval": true }` publishes anyway.
 */
export const POST = handler(async (request: Request, { params }: Ctx) => {
  const id = (await params).id;
  const current = agentStore.get(id);
  if (!current) return error('Agent not found', 404);
  if (!current.model?.model) return error('Choose a model before publishing');
  if (!hasPrompt(current)) return error('Describe the persona or add instructions before publishing');
  const body = await parseBody(request, z.object({ skipEval: z.unknown().optional() }).passthrough(), { optional: true });
  if (!body.ok) return body.response;
  let gate: GateResult | undefined;
  const checked = JSON.stringify(configOf(current));
  if (!body.data.skipEval) {
    try {
      gate = await checkPublish(id, { signal: request.signal });
    } catch (caught) {
      return error(`The eval gate could not run: ${(caught as Error).message}. Publish with the check skipped to go ahead.`, caught instanceof EvalGateError ? caught.status : 502);
    }
    if (!gate.verdict.ok) return json({ gate }, 409);
    // The builder autosaves while the cases run: what was scored must be what is published.
    const now = agentStore.get(id);
    if (!now || JSON.stringify(configOf(now)) !== checked) return error('The draft changed while the eval gate was checking it. Publish again to check the new draft.', 409);
  }
  const agent = agentStore.publish(id)!;
  if (gate?.run && agent.published) adoptRun(gate.run, agent.published.version);
  const kagent = await redeployIfDeployed(agent);
  return json({ agent: kagent && !('error' in kagent) ? (agentStore.get(id) ?? agent) : agent, ...(kagent && { kagent }), ...(gate && !gate.skipped && { gate }) });
});

export const DELETE = handler(async (_request: Request, { params }: Ctx) => {
  const agent = agentStore.unpublish((await params).id);
  return agent ? json({ agent }) : error('Agent not found', 404);
});
