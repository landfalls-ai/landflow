'use client';
/**
 * Spotlight's `newAgent` (docs/assistant.md#agents-and-teams): when no published agent fits a step, it proposes a
 * dedicated one. Applying the change adds the Run an Agent node; this has the Agent architect design the agent (a local
 * model, the tools it needs, a knowledge base when it works from documents, POST /api/agents/design) and points the node
 * at it. In autonomous mode (./autonomous.ts) the agent is smoke-tested first and published only after a pass; otherwise
 * it stays a draft for a person to check and publish. A test run waits for the agents being designed (`agentsSettled`).
 * SB16: Spotlight's agent card (./spotlight/agent-ask.ts) designs the agent without saving it (`designPreview`) and creates it on Create.
 */
import { api, ApiError } from '@/lib/client/api';
import type { AgentSmoke } from '@/lib/shared/agent-card'; // SB18:
import type { NewAgentSpec } from '@/lib/shared/assistant-ops';
import type { AgentCaseDraft } from '@/lib/shared/agent-card'; // SB16:
import { useAssistant, type AgentProgress } from './assistant';
import { useEditor } from './store';
import { pickedModel } from './spotlight-model'; // SB19:

/** Where the agent's step sits, for the architect's request. */
export interface AgentPlace {
  workflow?: string;
  after?: string;
  before?: string;
}

export interface Designed {
  agent: { id: string; name: string; model?: { provider: string; model: string }; tools: Array<{ type: string }> };
  needs: Array<{ text: string }>;
  missing: Array<{ capability: string }>;
  designed: boolean;
  /** SB16: the preview form (`preview: true`) answers the configuration instead of a saved agent, and the cases the brief made. */
  config?: Record<string, unknown>;
  cases?: AgentCaseDraft[];
}

const inFlight = new Set<Promise<void>>();

/** Resolves once every agent being designed is saved (or failed): a test run before that would find no agent. */
export async function agentsSettled(): Promise<void> {
  while (inFlight.size) await Promise.allSettled([...inFlight]);
}

/** SB16: the design the card shows: `POST /api/agents/design` with `preview: true`, which saves nothing. */
export function designPreview(spec: NewAgentSpec, place: AgentPlace = {}, signal?: AbortSignal): Promise<Designed> {
  return api<Designed>('/api/agents/design', { method: 'POST', json: { ...spec, ...place, ...pickedModel(), preview: true }, signal });
}

const toolCount = (designed: Designed['agent']) => {
  const knowledge = designed.tools.filter((t) => t.type === 'knowledge').length;
  const others = designed.tools.length - knowledge;
  return [others && `${others} tool${others === 1 ? '' : 's'}`, knowledge && `${knowledge} knowledge base${knowledge === 1 ? '' : 's'}`].filter(Boolean).join(' and ');
};

export function saveAgentFor(nodeId: string, spec: NewAgentSpec, place: AgentPlace = {}, options: { publish?: boolean } = {}): Promise<void> {
  // A row of the Spotlight panel's timeline: designing, then what the agent runs on and what is left to do.
  const progress = (patch: Partial<AgentProgress>) => useAssistant.getState().setAgent(nodeId, { name: spec.name, ...patch });
  const task = (async () => {
    progress({ state: 'designing' });
    try {
      const { agent, needs, missing, designed } = await api<Designed>('/api/agents/design', { method: 'POST', json: { ...spec, ...place, ...pickedModel() /* SB19 */ } });
      const node = useEditor.getState().nodes.find((n) => n.id === nodeId)?.data.wf;
      if (node) useEditor.getState().updateNode(nodeId, { parameters: { ...node.parameters, agentId: agent.id } });
      // SB18 (D3): the agent is tested on the item that reaches its step before anything is published.
      const has = toolCount(agent);
      const left = [...needs.map((n) => n.text), ...missing.map((m) => `not available here: ${m.capability}`)];
      const summary = [
        agent.model ? `${agent.model.provider}/${agent.model.model}` : 'no model yet',
        has,
        designed ? '' : 'only its instructions (the architect proposed nothing)',
        left.length ? `still to do: ${left.slice(0, 2).join('; ')}` : '',
      ]
        .filter(Boolean)
        .join(' · ');
      progress({ state: 'draft', agentId: agent.id, summary });
      if (agent.model) await smokeTestAgent(nodeId, { publish: options.publish });
      else progress({ state: 'untested', smoke: { state: 'untested', reason: 'it has no model yet' } });
    } catch (error) {
      progress({ state: 'failed', summary: `${(error as Error).message} The Run an Agent node has no agent yet: undo, or pick one.` });
    }
  })();
  inFlight.add(task);
  void task.finally(() => inFlight.delete(task));
  return task;
}

// SB18: the smoke test (docs/assistant.md "Agents and teams"), the publish after it and the take-back on Undo.

const SAMPLE_RUNS = 200;

/** The step before `nodeId` on its main input, the item that reaches it: its last run's first output, else the trigger's pinned item. */
export function itemReaching(nodeId: string): { item: Record<string, unknown>; nodeOutputs: Record<string, Array<{ json: Record<string, unknown> }>> } | undefined {
  const { nodes, edges, runs, pinData, nodeTypes } = useEditor.getState();
  const nodeOutputs: Record<string, Array<{ json: Record<string, unknown> }>> = {};
  for (const n of nodes) {
    const out = runs[n.id]?.filter((r) => r.source === 'main').at(-1)?.outputs.flat().slice(0, SAMPLE_RUNS);
    if (out?.length) nodeOutputs[n.data.wf.name] = out.map((i) => ({ json: i.json }));
  }
  const incoming = edges.find((e) => e.target === nodeId && (e.data?.connectionType ?? 'main') === 'main');
  const source = incoming && nodes.find((n) => n.id === incoming.source);
  if (!source) return undefined;
  const ran = runs[source.id]?.filter((r) => r.source === 'main' && r.status !== 'error').at(-1)?.outputs.flat()[0];
  if (ran) return { item: ran.json, nodeOutputs };
  const pinned = pinData[source.id]?.[0];
  if (pinned && nodeTypes[source.data.wf.type]?.descriptor.kind === 'trigger') return { item: pinned.json, nodeOutputs };
  return undefined;
}

/** Why a held publish was held, in words: "held by the eval gate: scored 2.5 of 5". */
const heldText = (error: unknown): string | undefined => {
  if (!(error instanceof ApiError) || error.status !== 409) return undefined;
  const verdict = (error.body as { gate?: { verdict?: { average?: number; reason?: string } } } | undefined)?.gate?.verdict;
  return verdict ? `held by the eval gate: scored ${verdict.average?.toFixed(1) ?? '?'} of 5${verdict.reason ? ` (${verdict.reason})` : ''}` : error.message;
};

/** Publish the agent's draft (no `skipEval`: a held eval gate leaves it a draft). True when it is published. */
export async function publishAgentFor(nodeId: string): Promise<boolean> {
  const progress = useAssistant.getState().agents.find((a) => a.nodeId === nodeId);
  if (!progress?.agentId) return false;
  const patch = (p: Partial<AgentProgress>) => useAssistant.getState().setAgent(nodeId, p);
  try {
    await api(`/api/agents/${progress.agentId}/publish`, { method: 'POST' });
    patch({ state: 'published', held: undefined });
    return true;
  } catch (error) {
    patch({ state: progress.smoke?.state === 'passed' ? 'tested' : 'draft', held: heldText(error) ?? (error as Error).message });
    return false;
  }
}

/**
 * Run the agent once on the item that reaches its step (the step's message resolved for it), then publish it when
 * `publish` and it passed (autonomous mode); otherwise a pass leaves it `tested`, with Publish on its row. No item yet:
 * `untested`, and a test session runs this when an item exists.
 */
export async function smokeTestAgent(nodeId: string, options: { publish?: boolean } = {}): Promise<AgentSmoke | undefined> {
  const progress = useAssistant.getState().agents.find((a) => a.nodeId === nodeId);
  const node = useEditor.getState().nodes.find((n) => n.id === nodeId);
  // The step is gone (its change was undone): nothing to test.
  if (!progress?.agentId || !node) return undefined;
  const patch = (p: Partial<AgentProgress>) => useAssistant.getState().setAgent(nodeId, p);
  const done = (smoke: AgentSmoke, state: AgentProgress['state'] = smoke.state === 'passed' ? 'tested' : smoke.state === 'untested' ? 'untested' : 'draft') => {
    patch({ state, smoke, held: undefined });
    return smoke;
  };
  const sample = itemReaching(nodeId);
  if (!sample) return done({ state: 'untested', reason: 'run the step before it once' });
  patch({ state: 'testing', smoke: { state: 'testing' }, held: undefined });
  try {
    const wanted = node.data.wf.parameters.message;
    const template = typeof wanted === 'string' && wanted.trim() ? wanted : '{{ $json.chatInput ?? $json.text }}';
    const resolved = await api<{ ok: boolean; value?: unknown; error?: string }>('/api/expressions/preview', {
      method: 'POST',
      json: { value: template, items: [{ json: sample.item }], itemIndex: 0, nodeOutputs: sample.nodeOutputs, parameters: node.data.wf.parameters, workflowId: useEditor.getState().workflowId || undefined },
    });
    const resolvedText = !resolved.ok ? '' : typeof resolved.value === 'string' ? resolved.value.trim() : resolved.value == null ? '' : JSON.stringify(resolved.value);
    // Like the Run an Agent node at run time: an empty message falls back to the item's chatInput.
    const chat = typeof sample.item.chatInput === 'string' ? sample.item.chatInput.trim() : '';
    const message = resolvedText || chat;
    if (!message) return done({ state: 'untested', reason: resolved.ok ? 'the step’s message is empty for that item' : (resolved.error ?? 'the step’s message could not be read') });
    const { smoke } = await api<{ smoke: AgentSmoke }>(`/api/agents/${progress.agentId}/smoke-test`, { method: 'POST', json: { message: message.slice(0, 4000) } });
    done(smoke);
    if (smoke.state === 'passed' && options.publish) await publishAgentFor(nodeId);
    return smoke;
  } catch (error) {
    return done({ state: 'failed', reason: (error as Error).message });
  }
}

/**
 * Undo of a change that added agents: take back the ones Spotlight made for those steps, when nothing else uses them
 * (DELETE /api/agents/design). The row then reads "Removed “X” (nothing else used it)" or "Kept “X”: used by …".
 */
export async function takeBackAgents(nodeIds: string[], workflowId: string): Promise<void> {
  await agentsSettled();
  for (const nodeId of nodeIds) {
    const progress = useAssistant.getState().agents.find((a) => a.nodeId === nodeId);
    if (!progress?.agentId || progress.taken) continue;
    try {
      const answer = await api<{ deleted: boolean; usedBy?: string[] }>('/api/agents/design', { method: 'DELETE', json: { agentId: progress.agentId, workflowId } });
      useAssistant.getState().setAgent(nodeId, { taken: answer.deleted ? { deleted: true } : { deleted: false, usedBy: answer.usedBy ?? [] } });
    } catch {
      // Not the caller's to delete, or already gone: the row stays as it was.
    }
  }
}
