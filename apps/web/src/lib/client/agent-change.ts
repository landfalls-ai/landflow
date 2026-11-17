/**
 * Changing an agent from Spotlight (docs/assistant.md "Changing an agent"), the calls the editor's card and the agent page's
 * panel share: design the change (`POST /api/agents/design` with `base` and `change`: a proposal, nothing saved), save it to the
 * draft and smoke-test it (Apply), and publish it (only after a pass, through the eval gate, never skipping it: decision D3).
 * No store and no server import: both surfaces keep their own state.
 */
import { api, ApiError } from '@/lib/client/api';
import { agentChanges } from '@/lib/shared/agent-changes';
import type { AgentPublish, AgentSmoke } from '@/lib/shared/agent-card';

/** What the design route answers for a change. */
export interface ChangeDesign {
  config: Record<string, unknown>;
  changes: string[];
  needs?: Array<{ text: string }>;
  missing?: Array<{ capability: string }>;
  designed?: boolean;
}

/** The change as a proposal: the config with the change made, and the lines that differ from the base. */
export function designChange(input: { name: string; description?: string; base: { agentId: string } | { config: Record<string, unknown> }; change: string; model?: string }, signal?: AbortSignal): Promise<ChangeDesign> {
  const { model, ...rest } = input;
  return api<ChangeDesign>('/api/agents/design', { method: 'POST', json: { description: '', instructions: '', ...rest, ...(model && { model }), preview: true }, signal }).then((design) => {
    // A design that ran and matched the base has `designed: true` and no changes ("No change"); one the model never proposed is a failure, not "already has it".
    if (design.designed === false) throw new Error('the model proposed nothing; nothing was changed');
    return design;
  });
}

/** The agent's saved draft as it is now, or undefined when it cannot be read. */
export async function readDraft(agentId: string): Promise<Record<string, unknown> | undefined> {
  try {
    return (await api<{ agent: Record<string, unknown> }>(`/api/agents/${agentId}`)).agent;
  } catch {
    return undefined;
  }
}

/** Apply: the config becomes the agent's draft (`PUT /api/agents/:id`: never a publish), then the draft runs once on `sample`. */
export async function saveChange(agentId: string, config: Record<string, unknown>, sample: string): Promise<AgentSmoke> {
  await api(`/api/agents/${agentId}`, { method: 'PUT', json: config });
  announceChange(agentId); // the agent's page shows the saved draft while the test runs
  try {
    const { smoke } = await api<{ smoke: AgentSmoke }>(`/api/agents/${agentId}/smoke-test`, { method: 'POST', json: { message: sample.slice(0, 4000) } });
    return smoke;
  } catch (e) {
    return { state: 'failed', reason: (e as Error).message };
  }
}

/** Publish after a pass: the eval gate runs the agent's cases; a hold is the answer (never skipped), not an error. */
export async function publishChange(agentId: string): Promise<AgentPublish> {
  try {
    await api(`/api/agents/${agentId}/publish`, { method: 'POST' });
    return { state: 'published' };
  } catch (e) {
    const verdict = e instanceof ApiError && e.status === 409 ? (e.body as { gate?: { verdict?: { average?: number; reason?: string } } } | undefined)?.gate?.verdict : undefined;
    if (verdict) return { state: 'held', ...(verdict.average !== undefined && { score: verdict.average }), ...(verdict.reason && { reason: verdict.reason }) };
    return { state: 'failed', reason: (e as Error).message };
  }
}

/** The agent's page reloads its draft on this window event (one listener in the builder). */
export const AGENT_CHANGED = 'landflow:agent-changed';
export function announceChange(agentId: string): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(AGENT_CHANGED, { detail: { agentId } }));
}

/**
 * Before Apply saves `config`: has the draft moved since the change was designed (`snapshot` is the draft's JSON then)? If so
 * nothing is saved and the card must show what applying does against the draft as it is now (`changes`, `snapshot`), then wait
 * for Apply again. The Changes row is the promise of what Apply does (lesson 22).
 */
export async function draftMoved(agentId: string, snapshot: string | undefined, config: Record<string, unknown>): Promise<{ snapshot: string; changes: string[] } | undefined> {
  if (!snapshot) return undefined;
  const current = await readDraft(agentId);
  if (!current || JSON.stringify(current) === snapshot) return undefined;
  return { snapshot: JSON.stringify(current), changes: agentChanges(current, config) };
}
