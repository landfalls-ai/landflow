/**
 * The smoke test (docs/assistant.md "Agents and teams", decision D3 of the Spotlight pro-builder program): the draft agent
 * run once on one message, as `runEval` runs a case, with approvals denied and the session deleted after, so it never
 * reaches the agent's sessions or its grading. It says whether the draft answers at all; the eval gate (./eval-gate.ts)
 * is what scores it.
 */
import type { AgentSmoke } from '../../shared/agent-card';
import { HttpError } from '../errors';
import { newSession, runAgent } from './runtime';
import { agentStore } from './store';

const REPLY_LIMIT = 300;
const clip = (text: string) => (text.length > REPLY_LIMIT ? `${text.slice(0, REPLY_LIMIT - 1)}…` : text);

export class SmokeTestError extends HttpError {
  static readonly errorName: string = 'SmokeTestError';
  constructor(message: string, status = 400) {
    super(message, status, { expose: true });
  }
}

/** Runs the draft once on `message`. Throws 404 for an unknown agent and 400 for one with no model; every other outcome is an `AgentSmoke`. */
export async function smokeTest(agentId: string, message: string, options: { signal?: AbortSignal } = {}): Promise<AgentSmoke> {
  const agent = agentStore.get(agentId);
  if (!agent) throw new SmokeTestError('Agent not found', 404);
  if (!agent.model?.model) throw new SmokeTestError('Choose a model for this agent first');
  const started = Date.now();
  const session = newSession(agent, { source: 'test', userId: 'smoke-test', version: 'draft', title: 'Smoke test' });
  try {
    const result = await runAgent({ agent, session, message, approvals: 'deny', rootTrace: true, ...(options.signal && { signal: options.signal }) });
    const ms = Date.now() - started;
    const reply = (result.reply ?? '').trim();
    const timeline = result.session.timeline;
    if (result.reason === 'error') {
      const failed = timeline.findLast((e) => e.type === 'error');
      const text = failed && 'message' in failed ? String(failed.message) : 'the model or a tool failed';
      return { state: 'failed', reason: `The run ended with an error: ${clip(text)}`, ms };
    }
    if (!reply) {
      const denied = timeline.find((e) => e.type === 'tool' && (e.status === 'denied' || e.status === 'awaiting_approval'));
      if (denied && denied.type === 'tool') return { state: 'failed', reason: `It wanted a tool that needs approval: ${denied.label || denied.tool}`, ms };
      if (result.reason === 'max_iterations') return { state: 'failed', reason: 'It stopped at its step limit', ms };
      if (result.reason === 'budget') return { state: 'failed', reason: 'It stopped at its budget', ms };
      if (result.reason === 'canceled') return { state: 'failed', reason: 'The test was stopped', ms };
      return { state: 'failed', reason: 'No reply', ms };
    }
    if (result.reason !== 'completed') {
      return { state: 'failed', reason: result.reason === 'max_iterations' ? 'It stopped at its step limit' : result.reason === 'awaiting_approval' ? 'It wanted a tool that needs approval' : `The run stopped early (${result.reason})`, reply: clip(reply), ms };
    }
    return { state: 'passed', reply: clip(reply), ms };
  } finally {
    agentStore.deleteSession(agentId, session.id);
  }
}
