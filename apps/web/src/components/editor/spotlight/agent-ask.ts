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
import { agentAsk, agentChangeAsk, askCatalog, fallbackName, knowledgeFolderOf, folderClauseAsksQuestions, knowledgeOf, readsTokens, sourceFolderOf, type AgentAsk, type AskCatalogEntry } from '@/lib/shared/agent-ask';
import { starterFlow, starterSample, type AgentCard, type AgentCardTool, type AgentKnowledgeSetup, type AgentNotAdded } from '@/lib/shared/agent-card';
import { rootOf, type AgentTeamConfig } from '@/lib/shared/agent-teams'; // AG17: a team node's lead
import { reuseSentence } from '@/lib/shared/tenant-catalog'; // AG19:
import { agentChanges } from '@/lib/shared/agent-changes'; // AG04:
import { announceChange, announceSaved, designChange, publishChange, saveChange, testDraft } from '@/lib/client/agent-change'; // AG04: AG09: testDraft; ag3 carryover: announceSaved
import { pickedModel } from '../spotlight-model'; // AG04:
import { followsPractices, guardrailWords, type AgentConfig } from '@/lib/shared/agents';
import { AGENT_CHANGE_ASKED, applyChanges, draft as draftCall, useAssistant, type ChatItem } from '../assistant'; // AG17: the event; AG19: applyChanges
import { useAutonomous } from '../autonomous';
import { designPreview, smokeTestAgent, takeBackAgents } from '../new-agent';
import { writesOutside } from '@/lib/shared/run-check';
import { autonomyOf } from '../spotlight-autonomy';
import { useEditor } from '../store';
import type { Reply } from './reply';

type ToolConfig = AgentConfig['tools'][number];

/** One tool of the agent's config as the card shows it. */
export function cardTool(tool: ToolConfig): AgentCardTool { // AG19: exported: the card draws a reused agent's tools the same way
  const node = tool.type === 'node' ? tool : undefined;
  const operation = typeof node?.parameters?.operation === 'string' ? node.parameters.operation : undefined;
  const requireApproval = Boolean(tool.requireApproval);
  const name = 'name' in tool && tool.name ? tool.name : tool.type;
  // A write is what SB17's brief puts behind approval: `run-check.ts` `writesOutside`, one heuristic for both.
  return { name, ...(node && { type: node.nodeType }), ...(operation && { operation }), writes: Boolean(node && (requireApproval || writesOutside({ type: node.nodeType, parameters: node.parameters ?? {} }))), requireApproval };
}

/** The card from what the design route answered (`POST /api/agents/design` with `preview`). */
export function cardFromPreview(preview: Awaited<ReturnType<typeof designPreview>> & { notAdded?: AgentNotAdded[]; models?: string[] /* AG02: */; knowledge?: Omit<AgentKnowledgeSetup, 'state'> /* AG13: */; reuse?: AgentCard['reuse']; attached?: AgentCard['attached']; modelWhy?: AgentCard['modelWhy']; modelNote?: string; catalog?: AgentCard['catalog'] /* AG19: */ }, ask: AgentAsk, starter: boolean, message?: string /* AG02: the person's whole ask */): AgentCard {
  const config = (preview.config ?? {}) as Partial<AgentConfig>;
  const tools = config.tools ?? [];
  const knowledge = tools.find((t) => t.type === 'knowledge');
  // AG02: an agent whose job reads tokens has no secret masking on its messages: the card says why.
  const guardrails = guardrailWords(config.guardrails);
  if (!config.guardrails?.input?.enabled && readsTokens(`${message ?? ask.description} ${tools.map((t) => ('name' in t && t.name) || '').join(' ')}`)) guardrails.unshift('Doesn’t mask tokens in messages: its job reads them');
  return {
    name: config.name || ask.name || 'New agent',
    description: config.description || ask.description,
    ...(config.model && { model: `${config.model.provider}/${config.model.model}` }),
    tools: tools.filter((t) => t.type !== 'knowledge').map(cardTool),
    ...(knowledge && knowledge.type === 'knowledge' && { knowledge: ('collection' in knowledge && knowledge.collection) || knowledge.name }),
    practices: followsPractices(config.practices),
    guardrails,
    cases: preview.cases ?? [],
    needs: (preview.needs ?? []).map((n) => n.text),
    missing: (preview.missing ?? []).map((m) => m.capability),
    config: config as Record<string, unknown>,
    state: 'designed',
    ...(starter && { starter: true }),
    ...(message && { ask: message }), // AG02:
    ...(preview.notAdded?.length && { notAdded: preview.notAdded }), // AG02:
    ...(preview.models?.length && { models: preview.models }), // AG02:
    ...(preview.knowledge && { knowledgeSetup: preview.knowledge }), // AG13: what it will index, from where, how it is searched
    // AG19: an agent that already does the job, an existing knowledge base attached as it is, why this model, and what the design read of the tenant.
    ...(preview.reuse && { reuse: preview.reuse }),
    ...(preview.attached && { attached: preview.attached }),
    ...(preview.modelWhy && { modelWhy: preview.modelWhy }),
    ...(preview.modelNote && { modelNote: preview.modelNote }),
    ...(preview.catalog?.length && { catalog: preview.catalog }),
  };
}

/** AG02: the card's Model select: the agent runs on `model` (`provider/model`) from here on; Create sends the config as it is. */
export function setCardModel(itemId: string, model: string): void {
  const [provider, ...rest] = model.split('/');
  if (!['anthropic', 'ollama', 'openai'].includes(provider) || !rest.length) return;
  useAssistant.getState().updateParts(itemId, (parts) =>
    parts.map((p) => (p.kind === 'agentCard' && p.card.state === 'designed' ? { ...p, card: { ...p.card, model, config: { ...p.card.config, model: { ...(p.card.config.model as object | undefined), provider, model: rest.join('/') } } } } : p)),
  );
}

/** AG02: the nodes the editor offers (core ones only by a name of two or more words), by display name and plugin name: the tools a message may name. */
function nodeCatalog(): AskCatalogEntry[] {
  return askCatalog(Object.values(useEditor.getState().nodeTypes));
}

/**
 * The ask this canvas sends to the agent card, or undefined: the message is an agent ask and does not place the agent in
 * this flow. A placed ask on a canvas with steps stays the chat's `newAgent`; on an empty canvas there is no flow to place
 * it in, so it too gets the card and the starter flow.
 */
export function cardAskFor(message: string): AgentAsk | undefined {
  const nodes = useEditor.getState().nodes;
  const ask = agentAsk(message, nodes.map((n) => n.data.wf.name), nodeCatalog()); // AG02: the node and plugin names the editor offers
  return ask && (!ask.placed || !nodes.length) ? ask : undefined;
}

const patchReply = (id: string, fields: Partial<Reply>) => useAssistant.setState((s) => ({ items: s.items.map((i) => (i.id === id ? { ...(i as Reply), ...fields } : i)) }));
/** AG11: the cards whose smoke test passed in this page load: a card brought back from history offers Publish only after one of these. */
const testedHere = new Set<string>();
export const testedThisLoad = (itemId: string) => testedHere.has(itemId);
const patchCard = (itemId: string, fields: Partial<AgentCard>) =>
  (fields.smoke?.state === 'passed' && testedHere.add(itemId), useAssistant.getState().updateParts(itemId, (parts) => parts.map((p) => (p.kind === 'agentCard' ? { ...p, card: { ...p.card, ...fields } } : p))));

/** D1: Spotlight creates by itself only on a brand-new draft with the switch on. */
const createsAlone = () => useAutonomous.getState().on && autonomyOf(useEditor.getState().workflowId) === 'auto';

/** Designs the agent the message asks for and shows it as a card; the canvas stays as it is until Create. */
export async function designAgentCard(message: string, ask: AgentAsk, options: { starter: boolean }): Promise<void> {
  const designName = ask.name ?? fallbackName(ask.description, ask.tools, nodeCatalog());
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
    const spec = { name: designName, description: ask.description, instructions: '', ask: message.slice(0, 4000) /* AG02: the whole ask */, ...(ask.tools.length && { tools: ask.tools }), ...(ask.knowledge && { knowledge: ask.knowledge }), ...(ask.knowledgeFolder && { knowledgeFolder: ask.knowledgeFolder, ...((ask.knowledge || folderClauseAsksQuestions(message, ask.knowledgeFolder)) && { knowledgeAsked: true }) }) /* AG13: a folder is a source only when the ask wants knowledge (ag3 fix: 'answers emails from the Inbox folder' is not one) */ };
    const preview = await designPreview(spec, workflow && !/^untitled/i.test(workflow) ? { workflow } : {}, abort.signal);
    const card = { ...cardFromPreview(preview, ask, options.starter, message), workflowId: workflowAtStart };
    const alone = createsAlone();
    patchReply(reply.id, {
      parts: [
        // ag1-int: a fallback design (the architect's call failed or proposed nothing) says so; the card's Left row says why.
        { kind: 'text', text: `${preview.designed === false ? `Made “${card.name}” from your words only: the Agent architect did not design it, so it has no tools yet.` : `Designed “${card.name}”.`} ${card.reuse ? (card.reuse.gaps.length ? (alone ? `“${card.reuse.name}” is the closest but lacks ${card.reuse.gaps.join(', ')}: creating a new one.` : `“${card.reuse.name}” is the closest but lacks ${card.reuse.gaps.join(', ')}: use it, or create a new one.`) : alone ? `“${card.reuse.name}” already does this: using it.` : `“${card.reuse.name}” already does this: use it, or create a new one anyway.`) /* AG19: */ : alone ? 'Creating it now.' : `Review it, then create it${options.starter ? ' with a flow that runs it' : ''}.`}` },
        { kind: 'agentCard', card },
      ],
    });
    // AG19: a brand-new draft in autonomous mode uses the agent that already does the whole job (no gaps); Create is never the default when one does. One that lacks something the ask needs is the closest, not a reuse: the card shows its gaps and Create builds the new one.
    if (alone) queueMicrotask(() => (card.reuse && !card.reuse.gaps.length ? void useExistingAgent(reply.id, card) : void createFromCard(reply.id, card)));
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
 * AG19: Use <name>: the card's reuse row (docs/assistant.md "Agents and teams"). A Run an Agent step bound to the agent that
 * already does the job: on an empty canvas the starter flow with that agent, else after the selected step (or the last one);
 * no agent is made. The card goes and the reply says `reuseSentence`; a draft-only agent is placed too and the reply says it
 * must be published first.
 */
export function useExistingAgent(itemId: string, card: AgentCard): boolean {
  const reuse = card.reuse;
  if (!reuse) return false;
  const state = useEditor.getState();
  const notes: string[] = [];
  if (!state.nodes.length) {
    if (card.workflowId && state.workflowId !== card.workflowId) return false;
    const flow = starterFlow({ id: reuse.agentId, name: reuse.name }, starterSample({ name: reuse.name, cases: [] }));
    if (/^untitled/i.test(state.name) || !state.name) state.setMeta({ name: flow.name });
    if (!state.description?.trim()) state.setMeta({ description: card.description });
    state.applyTemplate({ id: 'agent-starter', title: flow.name, description: card.description, icon: 'lucide:bot', color: 'var(--viz-7)', nodes: flow.nodes, edges: flow.edges as never, pinData: flow.pinData as never });
    const blocked = flow.nodes.filter((t) => !useEditor.getState().nodeTypes[t.type]).map((t) => t.name);
    if (blocked.length) notes.push(`This workflow does not allow ${blocked.join(' and ')}, so the flow is incomplete.`);
  } else {
    const leaves = state.nodes.filter((n) => !state.edges.some((e) => e.source === n.id && e.data?.connectionType === 'main') && n.data.wf.type !== 'core.stickyNote');
    const after = state.nodes.find((n) => n.selected) ?? leaves.sort((a, b) => a.position.x - b.position.x).at(-1);
    const ok = applyChanges([{ ops: [{ op: 'addNode', type: 'core.messageAgent', name: reuse.name.slice(0, 60), parameters: { agentId: reuse.agentId, toolApprovals: 'askInChat' }, ...(after && { after: after.data.wf.name }) }], kind: 'proposal' }], `Run ${reuse.name}`, { quiet: true });
    if (!ok) return false;
  }
  const said = `${reuseSentence(reuse.name, reuse.why)}${reuse.published ? '' : ` It is not published yet: publish “${reuse.name}” before the flow runs.`}${notes.length ? ` ${notes.join(' ')}` : ''}`;
  useAssistant.getState().updateParts(itemId, (parts) => parts.filter((p) => p.kind !== 'agentCard').map((p) => (p.kind === 'text' && /^Designed “/.test(p.text) ? { ...p, text: said } : p)));
  return true;
}

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
    const { agent } = await api<{ agent: { id: string; name: string; tools?: Array<{ id: string; type: string; collection?: string }> /* AG13: */ } }>('/api/agents/import', { method: 'POST', json: { config: { ...card.config, name: card.name } /* AG09: the agent is named what the card shows */ } });
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
    // AG13: the knowledge base is indexed from the folder the ask named, before the smoke test (which then searches it).
    await indexKnowledge(itemId, card, agent);
    // D3: the smoke test on the starter's pinned item; the card's line then reads what the row reads.
    if (step) {
      const smoke = await smokeTestAgent(step, { publish });
      if (smoke) patchCard(itemId, { smoke });
      // AG05: and what became of the publish (published, or held with the gate's verdict) stays on the card.
      const followed = useAssistant.getState().agents.find((a) => a.nodeId === step)?.publish;
      if (followed) patchCard(itemId, { publish: followed });
    }
  } catch (e) {
    patchCard(itemId, { state: 'failed', error: (e as Error).message });
  } finally {
    creating.delete(itemId);
  }
}

/**
 * AG13: Create indexes the folder into the new knowledge base (`POST /api/agents/:id/knowledge/:toolId/folder`), following it
 * on the card: indexing, then indexed with the counts, or failed with the error (the smoke test still runs and says so).
 */
async function indexKnowledge(itemId: string, card: AgentCard, agent: { id: string; tools?: Array<{ id: string; type: string; collection?: string }> }): Promise<void> {
  const setup = card.knowledgeSetup;
  if (!setup?.folder || setup.problem) return;
  const tool = agent.tools?.find((t) => t.type === 'knowledge' && t.collection === setup.collection);
  if (!tool) return;
  patchCard(itemId, { knowledgeSetup: { ...setup, state: 'indexing' } });
  try {
    const indexed = await api<NonNullable<AgentKnowledgeSetup['indexed']>>(`/api/agents/${agent.id}/knowledge/${tool.id}/folder`, { method: 'POST', json: { folder: setup.folder } });
    patchCard(itemId, { knowledgeSetup: { ...setup, state: 'indexed', indexed } });
    announceSaved(agent.id); // ag3 carryover: the canvas band read "0 docs" until a reload; it re-reads the documents now
  } catch (e) {
    patchCard(itemId, { knowledgeSetup: { ...setup, state: 'failed', error: (e as Error).message } });
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
/**
 * ag3 carryover: the folder a message under a card names: a knowledge clause ("answers from the folder runbooks"), or a short
 * answer that is only the source ("from the folder runbooks", "in runbooks/"), read as that clause would be.
 */
export function folderAnswerOf(message: string): string | undefined {
  const text = message.trim();
  const own = knowledgeFolderOf(text);
  if (own) return own;
  const SHORT = /^(?:(?:it\s+)?(?:answers?|reads?|uses?|searches?)\s+)?(?:from|in|under|inside)\s+(?:the\s+|our\s+)?(?:folder\s+\S+|\S+\s+folder|\S+\/)[.!]?$/i;
  return SHORT.test(text) ? knowledgeFolderOf(`answers questions ${text.replace(/^(?:(?:it\s+)?(?:answers?|reads?|uses?|searches?)\s+)/i, '')}`) : undefined;
}

/** ag3 fix pass: the card asked for a source (no folder, no existing base) or its folder had a problem: a reply naming a folder answers it. */
export const cardAsksSource = (card: AgentCard): boolean => Boolean(card.knowledgeSetup && !card.knowledgeSetup.existing && (!card.knowledgeSetup.folder || card.knowledgeSetup.problem));

/** The folder a message under `card` names, and whether it is the answer to the card's own question (then it is a source whatever the words). */
function folderUnder(message: string, card?: AgentCard): { folder: string; answer: boolean } | undefined {
  if (card && cardAsksSource(card)) {
    const folder = sourceFolderOf(message);
    if (folder) return { folder, answer: true };
  }
  const folder = folderAnswerOf(message);
  return folder ? { folder, answer: false } : undefined;
}

export function reviseCardFor(message: string): { itemId: string; card: AgentCard } | undefined {
  // ag3 carryover (the live pass): an answer that only names a source ("from the folder runbooks") starts with no change verb, so it
  // went to the flow builder ("Plan: Runbooks folder workflow"); under a card it revises the card's knowledge, as AG13 promised.
  // ag3 fix pass: when the card asked for a source, any reply naming a folder is that answer ("The folder is runbooks", "from the guides folder").
  const newest = newestCard();
  const kind = agentChangeAsk(message);
  const change = kind === 'change' || (kind === undefined && !!folderUnder(message, newest?.card));
  if (!change || cardAskFor(message) || workflowShaped(message)) return undefined;
  return newest;
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
  const items = useAssistant.getState().items;
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item.role !== 'assistant') continue;
    const part = item.parts.find((p) => p.kind === 'agentCard');
    if (part?.kind === 'agentCard') return part.card.state === 'designed' || part.card.state === 'created' ? { itemId: item.id, card: part.card } : undefined;
    if (!item.forCard) return undefined; // another reply is under the card: it is nobody's to change
  }
  return undefined;
}

/**
 * A question typed under an agent card ("why does it need the Hash tool?"): the chat answers it, also on an empty canvas
 * (where any other first message drafts a flow), and nothing is changed (lesson 22). Spotlight's own replies about the card
 * (a revise's, an answer to such a question) count as under it, so a second change or question still finds the card.
 */
export const agentCardQuestion = (message: string): boolean => cardQuestionFor(message) !== undefined;

/** The card a question is about (its item id), when the message is a question under the newest card. */
export const cardQuestionFor = (message: string): string | undefined => (agentChangeAsk(message) === 'question' ? newestCard()?.itemId : undefined);

/** Marks the assistant replies after the first `since` items as Spotlight's own, about the card `itemId`. */
export const keepUnderCard = (since: number, itemId: string): void =>
  useAssistant.setState((s) => ({ items: s.items.map((i, n) => (n >= since && i.role === 'assistant' && !i.parts.some((p) => p.kind === 'agentCard') ? { ...i, forCard: itemId } : i)) }));

const revising = new Set<string>();

/** One card's lines of what changed, as the reply says it. */
const sayChanges = (changes: string[]) => (changes.length ? changes.map((c) => c.charAt(0).toLowerCase() + c.slice(1)).join('; ') : '');

/** ag1-int: the tools a change named that the agent did not get, as the reply says them ("Not added: Slack (no plugin online has it)."). */
const sayNotAdded = (notAdded: AgentNotAdded[]) => (notAdded.length ? `Not added: ${notAdded.map((n) => `${n.name} (${n.reason})`).join('; ')}.` : '');

/** ag1-int: the reply to a revise. "No change … already has what you asked" only when nothing changed and nothing named was left out. */
export function reviseReply(name: string, changes: string[], notAdded: AgentNotAdded[], made: boolean): string {
  const left = sayNotAdded(notAdded);
  if (!changes.length) return left ? `No change to ${made ? `“${name}”` : 'the card above'}. ${left}` : made ? `No change: “${name}” already has what you asked.` : 'No change: the card above already has what you asked.';
  const said = made ? `Here is the change to “${name}”: ${sayChanges(changes)}.` : `Changed the card above: ${sayChanges(changes)}.`;
  return [said, left, made && 'Review it, then apply it to its draft.'].filter(Boolean).join(' ');
}

/**
 * Revises a card from a follow-up. A designed card is replaced in place with the new design and its `changes`; a created card
 * (an agent that exists) gets a new card below it with `base`, its `changes` and Apply to its draft. A revise is a proposal:
 * nothing is saved here, also in autonomous mode (an agent that exists is not a brand-new draft).
 */
export async function reviseAgentCard(itemId: string, card: AgentCard, message: string): Promise<void> {
  if (revising.has(itemId)) return;
  const made = card.state === 'created';
  const existing = made ? (card.base?.agentId ?? card.agentId) : card.base?.agentId;
  const reply: ChatItem = { id: nanoid(8), role: 'assistant', forCard: itemId, parts: [{ kind: 'text', text: `Changing “${card.name}”…` }] };
  useAssistant.getState().append([{ id: nanoid(8), role: 'user', text: message }, reply]);
  const rowId = `card:${reply.id}`;
  useAssistant.getState().setAgent(rowId, { name: card.name, state: 'designing' });
  draftCall.request?.abort();
  const abort = (draftCall.request = new AbortController());
  revising.add(itemId);
  try {
    // A created card's agent is the base; a pending card's own config is (a card that already proposes a change to an agent keeps its base).
    const base = made && existing ? { agentId: existing } : { config: card.config };
    // AG13: "from the folder runbooks" under a card adds the knowledge base (ag3 carryover: a bare answer too). ag3 fix pass: it is a source
    // when the card asked for one (read without the knowledge-clause gate) or the words ask for knowledge; never because a folder was named.
    const named = folderUnder(message, card);
    const input = { name: card.name, description: card.description, base, change: message, ...pickedModel(), ...(named && { knowledgeFolder: named.folder, ...((named.answer || knowledgeOf(message)) && { knowledgeAsked: true }) }) };
    const design = (await designChange(input, abort.signal)) as Awaited<ReturnType<typeof designChange>> & { knowledge?: Omit<AgentKnowledgeSetup, 'state'> };
    const notAdded = design.notAdded ?? []; // ag1-int: the tools the change named and the agent did not get
    const fresh = cardFromPreview({ config: design.config, needs: design.needs ?? [], missing: design.missing ?? [], designed: design.designed ?? true, cases: card.cases, notAdded, ...(design.knowledge && { knowledge: design.knowledge }) } as unknown as Parameters<typeof cardFromPreview>[0], { description: card.description, placed: false, tools: [] }, Boolean(card.starter));
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
    // AG09: a pending card's name is the revised design's (the server made a design-made name again from the new tools; its `changes` line says why).
    // AG13: a change that does not touch the knowledge keeps the Knowledge row the card had (while its agent still has the base, or it asked for a source).
    const keptSetup = !fresh.knowledgeSetup && card.knowledgeSetup && (fresh.knowledge || !card.knowledgeSetup.folder) ? card.knowledgeSetup : undefined;
    const next: AgentCard = { ...fresh, ...(keptSetup && { knowledgeSetup: keptSetup }), ...(card.workflowId && { workflowId: card.workflowId }), ...(card.ask && { ask: card.ask }), ...(card.models && { models: card.models }), changes };
    if (!made) {
      // ag1-int: the card's Not added row is the change's, and what the ask before it named that the agent still lacks.
      const squash = (v: string) => v.toLowerCase().replace(/[^a-z0-9]/g, '');
      const still = (card.notAdded ?? []).filter((n) => !notAdded.some((m) => squash(m.name) === squash(n.name)) && !next.tools.some((t) => squash(`${t.name} ${t.type ?? ''}`).includes(squash(n.name))));
      const rows = [...notAdded, ...still];
      patchCard(itemId, { ...next, state: 'designed', error: undefined, notAdded: rows.length ? rows : undefined, ...(card.base && { base: card.base }) });
      patchReply(reply.id, { parts: [{ kind: 'text', text: reviseReply(card.name, changes, notAdded, false) }] });
    } else {
      const change: AgentCard = { ...next, state: 'designed', base: { agentId: existing as string, name: card.name }, cases: [] };
      patchReply(reply.id, {
        parts: [
          { kind: 'text', text: reviseReply(card.name, changes, notAdded, true) },
          { kind: 'agentCard', card: change },
        ],
      });
    }
  } catch (e) {
    if (abort.signal.aborted) patchReply(reply.id, { parts: [{ kind: 'text', text: 'Stopped: nothing was changed.' }] });
    else patchReply(reply.id, { parts: [{ kind: 'text', text: 'Nothing was changed.' }], retry: { kind: 'agentRevise', itemId }, error: `Couldn’t change the agent: ${(e as Error).message}` });
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
    const smoke = await saveChange(agentId, card.config, starterSample({ name: card.name, cases: card.cases }), card.cases, card.replaceCaseIds);
    patchCard(itemId, { state: 'created', agentId, smoke });
  } catch (e) {
    patchCard(itemId, { state: 'failed', error: (e as Error).message, smoke: undefined });
  } finally {
    applying.delete(itemId);
  }
}

/**
 * AG17: Spotlight's changeAgent op: the change card for an agent a flow runs (the AG04 card, reused). The change is designed from the
 * person's words against the saved agent; Apply puts the draft (`applyAgentChange`: the PUT and the smoke test) and Publish is the
 * gate's (`publishAgentChange`). A saved agent is never a brand-new draft: Apply is always the person's click, also in autonomous mode.
 */
export async function changeAgentCard(change: { agentId?: string; teamId?: string; change: string; nodeId?: string }): Promise<void> {
  const reply: ChatItem = { id: nanoid(8), role: 'assistant', parts: [{ kind: 'text', text: 'Changing the agent…' }] };
  useAssistant.getState().append([reply]);
  const rowId = `card:${reply.id}`;
  useAssistant.getState().setAgent(rowId, { name: 'the agent', state: 'designing' });
  draftCall.request?.abort();
  const abort = (draftCall.request = new AbortController());
  try {
    // A Run a Team node: the agent is the team's lead.
    let agentId = change.agentId ?? '';
    if (!agentId && change.teamId) {
      const { team } = await api<{ team: { draft?: AgentTeamConfig; published?: AgentTeamConfig } }>(`/api/agent-teams/${encodeURIComponent(change.teamId)}`);
      const lead = rootOf((team.published ?? team.draft) as AgentTeamConfig);
      agentId = lead?.kind === 'agent' ? lead.agentId : '';
      if (!agentId) throw new Error('the team has no lead agent');
    }
    const { agent } = await api<{ agent: { name: string; description?: string } }>(`/api/agents/${agentId}`);
    useAssistant.getState().setAgent(rowId, { name: agent.name, state: 'designing' });
    const design = (await designChange({ name: agent.name, description: agent.description ?? '', base: { agentId }, change: change.change, ...pickedModel() }, abort.signal)) as Awaited<ReturnType<typeof designChange>> & { knowledge?: Omit<AgentKnowledgeSetup, 'state'> };
    const notAdded = design.notAdded ?? [];
    const fresh = cardFromPreview({ config: design.config, needs: design.needs ?? [], missing: design.missing ?? [], designed: design.designed ?? true, cases: design.cases ?? [], notAdded, ...(design.knowledge && { knowledge: design.knowledge }) } as unknown as Parameters<typeof cardFromPreview>[0], { description: agent.description ?? '', placed: false, tools: [] }, false);
    const card: AgentCard = { ...fresh, state: 'designed', base: { agentId: agentId, name: agent.name }, changes: design.changes, cases: design.cases ?? [], ...(design.replaceCaseIds?.length && { replaceCaseIds: design.replaceCaseIds }) };
    patchReply(reply.id, { parts: [{ kind: 'text', text: reviseReply(agent.name, design.changes, notAdded, true) }, { kind: 'agentCard', card }] });
  } catch (e) {
    if (abort.signal.aborted) patchReply(reply.id, { parts: [{ kind: 'text', text: 'Stopped: nothing was changed.' }] });
    else patchReply(reply.id, { parts: [{ kind: 'text', text: 'Nothing was changed.' }], error: `Couldn’t change the agent: ${(e as Error).message}` });
  } finally {
    if (draftCall.request === abort) draftCall.request = undefined;
    useAssistant.setState((st) => ({ agents: st.agents.filter((a) => a.nodeId !== rowId) }));
  }
}

// AG17: an applied changeAgent op (assistant.ts) asks for the agent's change card.
// One listener only: under dev HMR this module reloads, and a second listener would open a second card.
const g = globalThis as { __landflowAgentChangeListener?: EventListener };
if (typeof window !== 'undefined') {
  if (g.__landflowAgentChangeListener) window.removeEventListener(AGENT_CHANGE_ASKED, g.__landflowAgentChangeListener);
  g.__landflowAgentChangeListener = (e) => void changeAgentCard((e as CustomEvent<{ agentId?: string; teamId?: string; change: string; nodeId?: string }>).detail);
  window.addEventListener(AGENT_CHANGE_ASKED, g.__landflowAgentChangeListener);
}

/** AG09: Test again: the smoke test on the draft as it is now (a credential may have been picked since); nothing is saved or published. */
export async function testAgentChange(itemId: string, card: AgentCard): Promise<void> {
  const agentId = card.base?.agentId;
  if (!agentId || card.smoke?.state === 'testing') return;
  patchCard(itemId, { smoke: { state: 'testing' } });
  patchCard(itemId, { smoke: await testDraft(agentId, starterSample({ name: card.name, cases: card.cases })) });
}

/** Publish an applied change: only after a pass, through the eval gate (a hold is shown on the card, never skipped). */
export async function publishAgentChange(itemId: string, card: AgentCard): Promise<void> {
  const agentId = card.base?.agentId;
  if (!agentId || card.smoke?.state !== 'passed' || card.publish?.state === 'publishing') return;
  patchCard(itemId, { publish: { state: 'publishing' } });
  patchCard(itemId, { publish: await publishChange(agentId) });
  announceChange(agentId);
}
