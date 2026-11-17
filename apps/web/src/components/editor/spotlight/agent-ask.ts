'use client';
/**
 * "Create an agent …" typed into Spotlight, on any canvas (docs/assistant.md "Agents from Spotlight"): the ask is read
 * (`agentAsk`), the Agent architect designs the agent without saving it, and the reply shows it as a card to review.
 * Create imports it as a draft with its test cases; on an empty canvas it also lays out the starter flow (Chat message,
 * then Run an Agent) that runs it. On a brand-new draft in autonomous mode (decision D1) Create runs by itself.
 */
import { nanoid } from 'nanoid';
import { api } from '@/lib/client/api';
import { agentAsk, type AgentAsk } from '@/lib/shared/agent-ask';
import { starterFlow, starterSample, type AgentCard, type AgentCardTool } from '@/lib/shared/agent-card';
import type { AgentConfig } from '@/lib/shared/agents';
import { draft as draftCall, useAssistant, type ChatItem } from '../assistant';
import { useAutonomous } from '../autonomous';
import { designPreview } from '../new-agent';
import { autonomyOf } from '../spotlight-autonomy';
import { useEditor } from '../store';
import type { Reply } from './reply';

/** Operations that send, create, change or delete outside: the verbs of `run-check.ts` `sends`, kept here until the integrator points this at `writesOutside`. */
const WRITES = /^(send|post|create|update|delete|remove|upload|write|publish|comment|add|merge|archive|reply|invite|insert|upsert|append|move|close|assign|execute|trigger)/i;

type ToolConfig = AgentConfig['tools'][number];

/** One tool of the agent's config as the card shows it. */
function cardTool(tool: ToolConfig): AgentCardTool {
  const node = tool.type === 'node' ? tool : undefined;
  const operation = typeof node?.parameters?.operation === 'string' ? node.parameters.operation : undefined;
  const requireApproval = Boolean(tool.requireApproval);
  const name = 'name' in tool && tool.name ? tool.name : tool.type;
  return { name, ...(node && { type: node.nodeType }), ...(operation && { operation }), writes: Boolean(node && (requireApproval || (operation && WRITES.test(operation)))), requireApproval };
}

/** The guardrails in words ("Masks secrets in messages", "Ignores instructions inside tool results"). */
export function guardrailWords(guardrails: AgentConfig['guardrails']): string[] {
  const where = { input: 'messages', output: 'answers', toolResult: 'tool results' } as const;
  const out: string[] = [];
  for (const place of ['input', 'output', 'toolResult'] as const) {
    const rule = guardrails?.[place];
    if (!rule?.enabled) continue;
    const verb = rule.action === 'block' ? 'Blocks' : 'Masks';
    const checks = rule.checks ?? {};
    const say = (what: string) => out.push(`${verb} ${what} in ${where[place]}`);
    if (checks.pii) say('personal data');
    if (checks.secrets) say('secrets');
    if (checks.keywords?.list?.length) say('listed words');
    if (checks.urls) say('links outside the allowed list');
    if (checks.jailbreak) out.push(place === 'toolResult' ? 'Ignores instructions inside tool results' : `${verb === 'Masks' ? 'Flags' : 'Blocks'} prompt injection in ${where[place]}`);
    if (checks.topical) say('off-topic requests');
    if (checks.nsfw) say('unsafe content');
    if (checks.grounded) say('answers its sources do not support');
    for (const custom of [...(checks.customRegex ?? []), ...(checks.custom ?? [])]) out.push(`${verb} “${custom.name}” in ${where[place]}`);
  }
  return out;
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
    practices: config.practices !== 'off',
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
  const reply: ChatItem = { id: nanoid(8), role: 'assistant', parts: [{ kind: 'text', text: `Designing ${ask.name ? `“${ask.name}”` : 'your agent'}…` }] };
  useAssistant.getState().append([{ id: nanoid(8), role: 'user', text: message }, reply]);
  useAssistant.setState({ drafting: true });
  const abort = (draftCall.request = new AbortController());
  try {
    const workflow = useEditor.getState().name;
    const spec = { name: ask.name ?? 'New agent', description: ask.description, instructions: '', ...(ask.tools.length && { tools: ask.tools }), ...(ask.knowledge && { knowledge: ask.knowledge }) };
    const preview = await designPreview(spec, workflow && !/^untitled/i.test(workflow) ? { workflow } : {}, abort.signal);
    const card = cardFromPreview(preview, ask, options.starter);
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
    else patchReply(reply.id, { error: `Couldn’t design the agent: ${(e as Error).message}` });
  } finally {
    if (draftCall.request === abort) draftCall.request = undefined;
    useAssistant.setState({ drafting: false });
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
    if (card.starter) {
      const flow = starterFlow({ id: agent.id, name: card.name }, starterSample(card));
      const state = useEditor.getState();
      // The name and description first: each is an undo step of its own, and the template goes last so one ⌘Z takes both steps back.
      if (/^untitled/i.test(state.name) || !state.name) state.setMeta({ name: flow.name });
      if (!state.description?.trim()) state.setMeta({ description: card.description });
      state.applyTemplate({ id: 'agent-starter', title: flow.name, description: card.description, icon: 'lucide:bot', color: 'var(--viz-7)', nodes: flow.nodes, edges: flow.edges as never, pinData: flow.pinData as never });
    }
    patchCard(itemId, { state: 'created', agentId: agent.id, ...(unsaved.length && { needs: [...card.needs, `${unsaved.length} test case${unsaved.length === 1 ? '' : 's'} not saved: ${unsaved[0]}`] }) });
  } catch (e) {
    patchCard(itemId, { state: 'failed', error: (e as Error).message });
  } finally {
    creating.delete(itemId);
  }
}

/** Dismiss: the card goes away from the reply; nothing was created. */
export const dismissCard = (itemId: string): void => useAssistant.getState().updateParts(itemId, (parts) => parts.filter((p) => p.kind !== 'agentCard'));
