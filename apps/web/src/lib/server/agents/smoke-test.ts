/**
 * The smoke test (docs/assistant.md "Agents and teams", decision D3 of the Spotlight pro-builder program): the draft agent
 * run once on one message, as `runEval` runs a case, with approvals denied and the session deleted after, so it never
 * reaches the agent's sessions or its grading. It says whether the draft answers at all; the eval gate (./eval-gate.ts)
 * is what scores it.
 */
import { isPropertyVisible, withPropertyDefaults } from '@landflow/protocol';
import type { AgentSmoke, AgentSmokeTool } from '../../shared/agent-card';
import type { NodeToolConfig } from '../../shared/agents';
import { HttpError } from '../errors';
import { registry } from '../plugins/registry';
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

// AG05: what an honest smoke test looks at besides the reply (docs/agents.md "Eval gate", docs/assistant.md "Agents and teams").
const firstSentence = (text: string) => clip(text.trim().split(/(?<=[.!?])\s/)[0] ?? text.trim()).replace(/\s+/g, ' ');

/** AG05: nothing to work with: null, '', [], {}, or a list or object whose every part is empty. */
export function isEmptyOutput(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.every(isEmptyOutput);
  if (typeof value === 'object') return Object.values(value as Record<string, unknown>).every(isEmptyOutput);
  return false;
}

/** AG05: the first node tool whose visible required credential slot is unset, with how many others are the same. */
function tooLittleCredential(agent: { tools?: unknown[] }): { label: string; more: number } | undefined {
  const missing: string[] = [];
  for (const raw of agent.tools ?? []) {
    const tool = raw as NodeToolConfig;
    if (tool.type !== 'node') continue;
    const resolved = registry.resolve(tool.nodeType);
    if ('error' in resolved) continue;
    const { descriptor } = resolved;
    const parameters = withPropertyDefaults(descriptor.properties, tool.parameters);
    const lacking = (descriptor.credentials ?? []).some((c) => c.required && isPropertyVisible(c, parameters) && !tool.credentials?.[c.name]);
    if (lacking) missing.push(tool.name);
  }
  return missing.length ? { label: missing[0]!, more: missing.length - 1 } : undefined;
}

/** Runs the draft once on `message`. Throws 404 for an unknown agent and 400 for one with no model; every other outcome is an `AgentSmoke`. */
export async function smokeTest(agentId: string, message: string, options: { signal?: AbortSignal } = {}): Promise<AgentSmoke> {
  const agent = agentStore.get(agentId);
  if (!agent) throw new SmokeTestError('Agent not found', 404);
  if (!agent.model?.model) throw new SmokeTestError('Choose a model for this agent first');
  // AG05: a tool that cannot call anything without a credential nobody picked: say so, run nothing (no model call).
  const lacking = tooLittleCredential(agent);
  if (lacking) return { state: 'untested', reason: `needs a credential: ${lacking.label}${lacking.more ? ` and ${lacking.more} more` : ''}` };
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
    // AG05: each tool call as the timeline recorded it; the reply alone does not make a pass.
    const tools: AgentSmokeTool[] = [];
    for (const e of timeline) {
      if (e.type !== 'tool') continue;
      const name = e.label || e.tool;
      if (e.status === 'denied' || e.status === 'awaiting_approval') tools.push({ name, status: 'denied', note: 'needs approval: not sent' });
      else if (e.status === 'error' || e.error) tools.push({ name, status: 'error', note: firstSentence(e.error ?? 'the call failed') });
      else if (e.status === 'success' && isEmptyOutput(e.output) && !e.images?.length) tools.push({ name, status: 'empty', note: 'returned nothing to work with' });
      else if (e.status === 'success') tools.push({ name, status: 'success' });
    }
    const toolsField = tools.length ? { tools } : {};
    const errored = tools.find((t) => t.status === 'error');
    if (errored) return { state: 'failed', reason: `${errored.name} failed: ${errored.note}`, reply: clip(reply), ms, ...toolsField };
    const ran = tools.filter((t) => t.status !== 'denied');
    const empty = tools.find((t) => t.status === 'empty');
    if (empty && ran.length > 0 && ran.every((t) => t.status === 'empty')) return { state: 'failed', reason: `${empty.name} returned nothing to work with`, reply: clip(reply), ms, ...toolsField };
    const denied = tools.find((t) => t.status === 'denied');
    return { state: 'passed', reply: clip(reply), ms, ...(denied && { reason: `${denied.name} needs approval: not sent` }), ...toolsField };
  } finally {
    agentStore.deleteSession(agentId, session.id);
  }
}
