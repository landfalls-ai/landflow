'use client';
/**
 * "Create an agent …" typed into Spotlight, on any canvas (docs/assistant.md "Agents from Spotlight"): the ask is read
 * (`agentAsk`), the Agent architect designs the agent without saving it, and the reply shows it as a card to review.
 * Create imports it as a draft with its test cases; on an empty canvas it also lays out the starter flow (Chat message,
 * then Run an Agent) that runs it. On a brand-new draft in autonomous mode (decision D1) Create runs by itself.
 * Integration (wave sb3): Create ends with SB18's smoke test on the starter's pinned item, then the publish on a pass
 * when Spotlight creates alone (D3), else the row's Publish; ⌘Z of the starter flow takes the agent back (SB18).
 */
import { nanoid } from 'nanoid';
import { api } from '@/lib/client/api';
import { agentAsk, agentChangeAsk, fallbackName, type AgentAsk } from '@/lib/shared/agent-ask';
import { starterFlow, starterSample, type AgentCard, type AgentCardTool } from '@/lib/shared/agent-card';
import { agentChanges } from '@/lib/shared/agent-changes'; // AG04:
import { announceChange, designChange, publishChange, saveChange } from '@/lib/client/agent-change'; // AG04:
import { pickedModel } from '../spotlight-model'; // AG04:
import { followsPractices, guardrailWords, type AgentConfig } from '@/lib/shared/agents';
import { draft as draftCall, useAssistant, type ChatItem } from '../assistant';
import { useAutonomous } from '../autonomous';
import { designPreview, smokeTestAgent, takeBackAgents } from '../new-agent';
import { writesOutside } from '@/lib/shared/run-check';
import { autonomyOf } from '../spotlight-autonomy';
import { useEditor } from '../store';
import type { Reply } from './reply';

type ToolConfig = AgentConfig['tools'][number];

/** One tool of the agent's config as the card shows it. */
function cardTool(tool: ToolConfig): AgentCardTool {
  const node = tool.type === 'node' ? tool : undefined;
  const operation = typeof node?.parameters?.operation === 'string' ? node.parameters.operation : undefined;
  const requireApproval = Boolean(tool.requireApproval);
  const name = 'name' in tool && tool.name ? tool.name : tool.type;
  // A write is what SB17's brief puts behind approval: `run-check.ts` `writesOutside`, one heuristic for both.
  return { name, ...(node && { type: node.nodeType }), ...(operation && { operation }), writes: Boolean(node && (requireApproval || writesOutside({ type: node.nodeType, parameters: node.parameters ?? {} }))), requireApproval };
}

/** The card from what the design route answered (`POST /api/agents/design` with `preview`). */
export function cardFromPreview(preview: Awaited<ReturnType<typeof designPreview>>, ask: AgentAsk, starter: boolean): AgentCard {
  const config = (preview.config ?? {}) as Partial<AgentConfig>;
  const tools = config.tools ?? [];
  const knowledge = tools.find((t) => t.type === 'knowledge');
  return {
    name: config.name || ask.name || 'New agent',
    description: config.description || ask.description,
    ...(config.model && { model: `${config.model.provider}/${config.model.model}` }),
    tools: tools.filter((t) => t.type !== 'knowledge').map(cardTool),
    ...(knowledge && knowledge.type === 'knowledge' && { knowledge: ('collection' in knowledge && knowledge.collection) || knowledge.name }),
    practices: followsPractices(config.practices),
    guardrails: guardrailWords(config.guardrails),
    cases: preview.cases ?? [],
    needs: (preview.needs ?? []).map((n) => n.text),
    missing: (preview.missing ?? []).map((m) => m.capability),
    config: config as Record<string, unknown>,
    state: 'designed',
    ...(starter && { starter: true }),
  };
}

/**
 * The ask this canvas sends to the agent card, or undefined: the message is an agent ask and does not place the agent in
 * this flow. A placed ask on a canvas with steps stays the chat's `newAgent`; on an empty canvas there is no flow to place
 * it in, so it too gets the card and the starter flow.
 */
export function cardAskFor(message: string): AgentAsk | undefined {
  const nodes = useEditor.getState().nodes;
  const ask = agentAsk(message, nodes.map((n) => n.data.wf.name));
  return ask && (!ask.placed || !nodes.length) ? ask : undefined;
}

const patchReply = (id: string, fields: Partial<Reply>) => useAssistant.setState((s) => ({ items: s.items.map((i) => (i.id === id ? { ...(i as Reply), ...fields } : i)) }));
const patchCard = (itemId: string, fields: Partial<AgentCard>) =>
  useAssistant.getState().updateParts(itemId, (parts) => parts.map((p) => (p.kind === 'agentCard' ? { ...p, card: { ...p.card, ...fields } } : p)));

/** D1: Spotlight creates by itself only on a brand-new draft with the switch on. */
const createsAlone = () => useAutonomous.getState().on && autonomyOf(useEditor.getState().workflowId) === 'auto';

/** Designs the agent the message asks for and shows it as a card; the canvas stays as it is until Create. */
export async function designAgentCard(message: string, ask: AgentAsk, options: { starter: boolean }): Promise<void> {
  const designName = ask.name ?? fallbackName(ask.description);
  const reply: ChatItem = { id: nanoid(8), role: 'assistant', parts: [{ kind: 'text', text: `Designing “${designName}”…` }] };
  useAssistant.getState().append([{ id: nanoid(8), role: 'user', text: message }, reply]);
  // The design is an agent's, not a flow's: the panel shows "Designing “…”" (the agent row), never the flow placeholder.
  const rowId = `card:${reply.id}`;
  useAssistant.getState().setAgent(rowId, { name: designName, state: 'designing' });
  const workflowAtStart = useEditor.getState().workflowId;
  // As `draftWholeFlow` does: a plan card still waiting for Build it is stopped by this ask, not left to build later.
  draftCall.request?.abort();
  const abort = (draftCall.request = new AbortController());
  try {
    const workflow = useEditor.getState().name;
    const spec = { name: designName, description: ask.description, instructions: '', ...(ask.tools.length && { tools: ask.tools }), ...(ask.knowledge && { knowledge: ask.knowledge }) };
    const preview = await designPreview(spec, workflow && !/^untitled/i.test(workflow) ? { workflow } : {}, abort.signal);
    const card = { ...cardFromPreview(preview, ask, options.starter), workflowId: workflowAtStart };
    const alone = createsAlone();
    patchReply(reply.id, {
      parts: [
        { kind: 'text', text: `Designed “${card.name}”. ${alone ? 'Creating it now.' : `Review it, then create it${options.starter ? ' with a flow that runs it' : ''}.`}` },
        { kind: 'agentCard', card },
      ],
    });
    if (alone) queueMicrotask(() => void createFromCard(reply.id, card));
  } catch (e) {
    if (abort.signal.aborted) patchReply(reply.id, { parts: [{ kind: 'text', text: 'Stopped: no agent was designed.' }] });
    else patchReply(reply.id, { parts: [{ kind: 'text', text: 'No agent was designed.' }], error: `Couldn’t design the agent: ${(e as Error).message}` });
  } finally {
    if (draftCall.request === abort) draftCall.request = undefined;
    useAssistant.setState((st) => ({ agents: st.agents.filter((a) => a.nodeId !== rowId) }));
  }
}

const creating = new Set<string>();

/**
 * Create: the agent as a draft (the import route), a test case each for the eval gate, and, with the starter flow, the
 * Chat message and Run an Agent steps as one undoable change. A failure leaves the canvas as it was.
 */
export async function createFromCard(itemId: string, card: AgentCard): Promise<void> {
  if (creating.has(itemId)) return;
  creating.add(itemId);
  // D1/D3: published after a passing smoke test only when Spotlight creates alone (a brand-new draft, the switch on).
  const publish = createsAlone();
  let step: string | undefined;
  patchCard(itemId, { state: 'creating', error: undefined });
  try {
    const { agent } = await api<{ agent: { id: string; name: string } }>('/api/agents/import', { method: 'POST', json: { config: card.config } });
    const unsaved: string[] = [];
    for (const c of card.cases) {
      try {
        await api(`/api/agents/${agent.id}/eval-gate`, { method: 'POST', json: { input: c.input, ...(c.expected && { expected: c.expected }) } });
      } catch (e) {
        unsaved.push((e as Error).message);
      }
    }
    const notes: string[] = [];
    if (card.starter) {
      const state = useEditor.getState();
      if (card.workflowId && state.workflowId !== card.workflowId) {
        notes.push('The agent was created, but you left the workflow it was designed in, so its starter flow was not added. Add a Run an Agent step to the flow you want.');
      } else {
        const flow = starterFlow({ id: agent.id, name: card.name }, starterSample(card));
        const blocked = flow.nodes.filter((t) => !state.nodeTypes[t.type]).map((t) => t.name);
        // The name and description first: each is an undo step of its own, and the template goes last so one ⌘Z takes both steps back.
        if (/^untitled/i.test(state.name) || !state.name) state.setMeta({ name: flow.name });
        if (!state.description?.trim()) state.setMeta({ description: card.description });
        state.applyTemplate({ id: 'agent-starter', title: flow.name, description: card.description, icon: 'lucide:bot', color: 'var(--viz-7)', nodes: flow.nodes, edges: flow.edges as never, pinData: flow.pinData as never });
        if (blocked.length) notes.push(`This workflow does not allow ${blocked.join(' and ')}, so the starter flow is incomplete.`);
        // Integration (sb3): the Run an Agent step gets SB18's row (smoke test, Publish, Undo), as a step the chat adds does.
        step = useEditor.getState().nodes.find((n) => n.data.wf.type === 'core.messageAgent' && n.data.wf.parameters.agentId === agent.id)?.id;
        if (step) {
          useAssistant.getState().setAgent(step, { name: card.name, state: 'draft', agentId: agent.id, ...(card.model && { summary: card.model }) });
          takeBackOnUndo(step, useEditor.getState().workflowId);
        }
      }
    }
    const extra = [...unsaved.length ? [`${unsaved.length} test case${unsaved.length === 1 ? '' : 's'} not saved: ${unsaved[0]}`] : [], ...notes];
    patchCard(itemId, { state: 'created', agentId: agent.id, ...(extra.length && { needs: [...card.needs, ...extra] }) });
    // D3: the smoke test on the starter's pinned item; the card's line then reads what the row reads.
    if (step) {
      const smoke = await smokeTestAgent(step, { publish });
      if (smoke) patchCard(itemId, { smoke });
    }
  } catch (e) {
    patchCard(itemId, { state: 'failed', error: (e as Error).message });
  } finally {
    creating.delete(itemId);
  }
}

/** The starter flows' Run an Agent steps watched for ⌘Z: step id -> its workflow. One store subscription serves them all. */
const watched = new Map<string, string>();
let stopWatching: (() => void) | undefined;

/** How many ⌘Z watches are open (the editor store subscription is one, whatever the count). For tests. */
export const undoWatches = () => ({ steps: watched.size, subscribed: Boolean(stopWatching) });

/**
 * ⌘Z of the starter flow (the editor's own undo, not a Spotlight change) takes the agent back like SB18's Undo: the step is
 * gone and the redo stack grew. A step the person deletes by hand is not an undo and keeps the agent. A step is watched
 * until it is gone, taken back or its workflow is left; the one subscription ends with the last watch, so repeated
 * Creates add no subscriptions.
 */
function takeBackOnUndo(nodeId: string, workflowId: string): void {
  watched.set(nodeId, workflowId);
  if (stopWatching) return;
  stopWatching = useEditor.subscribe((now, before) => {
    for (const [id, workflow] of [...watched]) {
      if (now.workflowId !== workflow) watched.delete(id);
      else if (before.nodes.some((n) => n.id === id) && !now.nodes.some((n) => n.id === id)) {
        watched.delete(id);
        if (now.history.future > before.history.future) void takeBackAgents([id], workflow);
      }
    }
    if (!watched.size) {
      stopWatching?.();
      stopWatching = undefined;
    }
  });
}

/** Dismiss: the card goes away from the reply; nothing was created. */
export const dismissCard = (itemId: string): void =>
  useAssistant.getState().updateParts(itemId, (parts) => parts.filter((p) => p.kind !== 'agentCard').map((p) => (p.kind === 'text' && /^Designed “/.test(p.text) ? { ...p, text: 'Dismissed: no agent was created.' } : p)));

// AG04:
/**
 * A change typed under an agent card (docs/assistant.md "Changing an agent"): the newest agent card of this conversation when it
 * is designed (not yet created) or created, the message is a change in words, and it is not a new "create an agent …" (that
 * still makes a new card). A question is not one: it goes to the chat, answered and never applied.
 */
export function reviseCardFor(message: string): { itemId: string; card: AgentCard } | undefined {
  if (agentChangeAsk(message) !== 'change' || cardAskFor(message) || workflowShaped(message)) return undefined;
  return newestCard();
}

const WORKFLOW_WORDS = /\b(?:steps?|nodes?|triggers?|flows?|workflows?|webhooks?|cron|canvas)\b/i;
const WORKFLOW_WEAK = /\b(?:schedules?|connect|after|before|branch|branches)\b/i;
const AGENT_WORDS = /\b(?:agent|tools?|instructions?|persona|guardrails?|model)\b/i;

/**
 * A message that asks for a change to the flow on the canvas, not to the agent: it names a step, node, trigger or flow, or says
 * "after/before" a step that is on the canvas (a weaker word such as "schedule" counts unless the message is about the agent).
 * Only on a canvas that has steps; on an empty one there is no flow to change.
 */
function workflowShaped(message: string): boolean {
  const nodes = useEditor.getState().nodes;
  if (!nodes.length) return false;
  if (WORKFLOW_WORDS.test(message)) return true;
  const labels = nodes.flatMap((n) => {
    const wf = (n.data as { wf?: { name?: string } } | undefined)?.wf;
    return wf?.name ? [wf.name.toLowerCase()] : [];
  });
  if (/\b(?:after|before)\b/i.test(message) && labels.some((l) => message.toLowerCase().includes(l))) return true;
  return WORKFLOW_WEAK.test(message) && !AGENT_WORDS.test(message);
}

/**
 * The newest agent card of this conversation when it is designed (waiting for Create) or created, and the person is writing
 * right under it: it is in the newest assistant reply and nothing but the person's own messages came after it. A card many
 * turns old, or one with another reply after it, is nobody's to change (the message goes to the chat or the builder).
 */
function newestCard(): { itemId: string; card: AgentCard } | undefined {
  const last = [...useAssistant.getState().items].reverse().find((item) => item.role === 'assistant');
  const part = last?.parts.find((p) => p.kind === 'agentCard');
  if (!last || part?.kind !== 'agentCard') return undefined;
  return part.card.state === 'designed' || part.card.state === 'created' ? { itemId: last.id, card: part.card } : undefined;
}

/**
 * A question typed under an agent card ("why does it need the Hash tool?"): the chat answers it, also on an empty canvas
 * (where any other first message drafts a flow), and nothing is changed (lesson 22).
 */
export const agentCardQuestion = (message: string): boolean => agentChangeAsk(message) === 'question' && newestCard() !== undefined;

const revising = new Set<string>();

/** One card's lines of what changed, as the reply says it. */
const sayChanges = (changes: string[]) => (changes.length ? changes.map((c) => c.charAt(0).toLowerCase() + c.slice(1)).join('; ') : '');

/**
 * Revises a card from a follow-up. A designed card is replaced in place with the new design and its `changes`; a created card
 * (an agent that exists) gets a new card below it with `base`, its `changes` and Apply to its draft. A revise is a proposal:
 * nothing is saved here, also in autonomous mode (an agent that exists is not a brand-new draft).
 */
export async function reviseAgentCard(itemId: string, card: AgentCard, message: string): Promise<void> {
  if (revising.has(itemId)) return;
  const made = card.state === 'created';
  const existing = made ? (card.base?.agentId ?? card.agentId) : card.base?.agentId;
  const reply: ChatItem = { id: nanoid(8), role: 'assistant', parts: [{ kind: 'text', text: `Changing “${card.name}”…` }] };
  useAssistant.getState().append([{ id: nanoid(8), role: 'user', text: message }, reply]);
  const rowId = `card:${reply.id}`;
  useAssistant.getState().setAgent(rowId, { name: card.name, state: 'designing' });
  draftCall.request?.abort();
  const abort = (draftCall.request = new AbortController());
  revising.add(itemId);
  try {
    // A created card's agent is the base; a pending card's own config is (a card that already proposes a change to an agent keeps its base).
    const base = made && existing ? { agentId: existing } : { config: card.config };
    const design = await designChange({ name: card.name, description: card.description, base, change: message, ...pickedModel() }, abort.signal);
    const fresh = cardFromPreview({ config: design.config, needs: design.needs ?? [], missing: design.missing ?? [], designed: design.designed ?? true, cases: card.cases } as unknown as Parameters<typeof cardFromPreview>[0], { description: card.description, placed: false, tools: [] }, Boolean(card.starter));
    let changes = design.changes;
    // A pending change to an agent lists what differs from the agent itself, not from the proposal before it.
    if (card.base && !made) {
      try {
        const saved = await api<{ agent: Record<string, unknown> }>(`/api/agents/${card.base.agentId}`);
        changes = agentChanges(saved.agent, design.config);
      } catch {
        // Keep what the route said.
      }
    }
    const next: AgentCard = { ...fresh, ...(card.workflowId && { workflowId: card.workflowId }), ...(card.ask && { ask: card.ask }), ...(card.models && { models: card.models }), changes };
    if (!made) {
      patchCard(itemId, { ...next, state: 'designed', error: undefined, ...(card.base && { base: card.base }) });
      patchReply(reply.id, { parts: [{ kind: 'text', text: changes.length ? `Changed the card above: ${sayChanges(changes)}.` : 'No change: the card above already has what you asked.' }] });
    } else {
      const change: AgentCard = { ...next, state: 'designed', base: { agentId: existing as string, name: card.name }, cases: [] };
      patchReply(reply.id, {
        parts: [
          { kind: 'text', text: changes.length ? `Here is the change to “${card.name}”: ${sayChanges(changes)}. Review it, then apply it to its draft.` : `No change: “${card.name}” already has what you asked.` },
          { kind: 'agentCard', card: change },
        ],
      });
    }
  } catch (e) {
    if (abort.signal.aborted) patchReply(reply.id, { parts: [{ kind: 'text', text: 'Stopped: nothing was changed.' }] });
    else patchReply(reply.id, { parts: [{ kind: 'text', text: 'Nothing was changed.' }], error: `Couldn’t change the agent: ${(e as Error).message}` });
  } finally {
    revising.delete(itemId);
    if (draftCall.request === abort) draftCall.request = undefined;
    useAssistant.setState((st) => ({ agents: st.agents.filter((a) => a.nodeId !== rowId) }));
  }
}

const applying = new Set<string>();

/**
 * Apply to its draft: the card's config becomes the agent's draft (PUT), then the draft is smoke-tested on the card's sample.
 * Nothing is published here; the person's Publish is `publishAgentChange`, and only after a pass (decision D3).
 */
export async function applyAgentChange(itemId: string, card: AgentCard): Promise<void> {
  const agentId = card.base?.agentId;
  if (!agentId || applying.has(itemId)) return;
  applying.add(itemId);
  patchCard(itemId, { state: 'creating', error: undefined });
  try {
    patchCard(itemId, { smoke: { state: 'testing' } });
    const smoke = await saveChange(agentId, card.config, starterSample({ name: card.name, cases: card.cases }));
    patchCard(itemId, { state: 'created', agentId, smoke });
  } catch (e) {
    patchCard(itemId, { state: 'failed', error: (e as Error).message, smoke: undefined });
  } finally {
    applying.delete(itemId);
  }
}

/** Publish an applied change: only after a pass, through the eval gate (a hold is shown on the card, never skipped). */
export async function publishAgentChange(itemId: string, card: AgentCard): Promise<void> {
  const agentId = card.base?.agentId;
  if (!agentId || card.smoke?.state !== 'passed' || card.publish?.state === 'publishing') return;
  patchCard(itemId, { publish: { state: 'publishing' } });
  patchCard(itemId, { publish: await publishChange(agentId) });
  announceChange(agentId);
}
