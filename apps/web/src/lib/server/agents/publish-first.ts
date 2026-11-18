/**
 * AG21: publish an agent on a workflow's behalf (the workflow's publish with `agents: 'publish-first'`): the smoke test, then the
 * eval gate, then the publish, never skipping the gate (D3). Registered with lib/server/publish.ts by the publish route (publish.ts
 * cannot import it: the agent runtime reaches publish.ts through the Slack handlers).
 */
import { adoptRun, checkPublish } from './eval-gate';
import { smokeTest } from './smoke-test';
import { hasPrompt } from '../../shared/persona';
import { agentPublishing, type AgentPublishOutcome } from '../publish';
import { redeployIfDeployed } from '../kagent/deploy';
import { logger } from '../telemetry/logger';
import { agentStore, configOf } from './store';

/** What the smoke test is asked before an agent is published on a workflow's behalf. */
export const SMOKE_MESSAGE = 'Say hello in one short sentence and name what you can help with.';

/**
 * Publish an agent's draft the way `POST /api/agents/:id/publish` does, never skipping the eval gate (D3): the smoke test,
 * then the gate, then the publish. A failed smoke or a held gate publishes nothing and says why.
 */
export async function publishAgentChecked(agentId: string, options: { signal?: AbortSignal } = {}): Promise<AgentPublishOutcome> {
  const current = agentStore.get(agentId);
  if (!current) return { ok: false, status: 404, message: 'Agent not found' };
  if (!current.model?.model) return { ok: false, status: 409, message: `Choose a model for “${current.name}” before publishing it`, details: { agentId } };
  if (!hasPrompt(current)) return { ok: false, status: 409, message: `Describe the persona or add instructions to “${current.name}” before publishing it`, details: { agentId } };
  try {
    const smoke = await smokeTest(agentId, SMOKE_MESSAGE, options);
    if (smoke.state !== 'passed') return { ok: false, status: 409, message: `“${current.name}” did not pass its smoke test${smoke.reason ? `: ${smoke.reason}` : ''}`, details: { agentId, smoke } };
    const checked = JSON.stringify(configOf(current));
    const gate = await checkPublish(agentId, options);
    if (!gate.verdict.ok) return { ok: false, status: 409, message: `The eval gate held “${current.name}”: ${gate.verdict.reason ?? `it averages ${gate.verdict.average.toFixed(1)} / 5`}`, details: { agentId, gate: { verdict: gate.verdict, lowCases: gate.lowCases ?? [] } } }; // AG24: the score and the held run's lowest cases
    const now = agentStore.get(agentId);
    if (!now || JSON.stringify(configOf(now)) !== checked) return { ok: false, status: 409, message: `“${current.name}” changed while it was being checked: publish again`, details: { agentId } };
    const agent = agentStore.publish(agentId)!;
    if (gate.run && agent.published) adoptRun(gate.run, agent.published.version);
    try {
      await redeployIfDeployed(agent);
    } catch (error) {
      logger.warn('could not redeploy a published agent', { error, 'landflow.agent.id': agentId });
    }
    return { ok: true, version: agent.published!.version };
  } catch (error) {
    return { ok: false, status: (error as { status?: number }).status ?? 502, message: `“${current.name}” could not be checked: ${(error as Error).message}`, details: { agentId } };
  }
}

agentPublishing.run = publishAgentChecked;
