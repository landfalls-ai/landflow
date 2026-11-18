'use client';
/**
 * AG25 (wave ag5): a Run an Agent step the build placed with no agent bound ("needs a new agent: <name>") is designed after
 * Apply (docs/assistant.md "Agents and teams"). The Agent architect designs it for the step (`designPreview`: the step's name,
 * the ask, the steps around it), then:
 * - a saved agent that already does the job (no gaps, published) is bound as it is, and the reply says so (AG19's sentence);
 * - on a brand-new draft with the switch on (`autonomyOf` is `auto`) and a design that needs nothing from the person, the
 *   card is created by itself (`createFromCard`: the agent, its cases, the smoke test, the publish through the eval gate,
 *   the step bound) and the timeline row says so;
 * - asks first, a saved flow, or a design that needs a credential, a folder or a choice (`needs`, `missing`, no model): the
 *   card waits for Create, which binds the step when it is created. Never a made-up source.
 * Undo of the build takes an agent made this way back (`takeBackAgents`, through the step watch in `createFromCard`).
 */
import { nanoid } from 'nanoid';
import { reuseSentence } from '@/lib/shared/tenant-catalog';
import { useAssistant, type ChatItem } from '../assistant';
import { useAutonomous } from '../autonomous';
import { holdForAgents, designPreview } from '../new-agent';
import { autonomyOf } from '../spotlight-autonomy';
import { useEditor } from '../store';
import { cardFromPreview, createFromCard, stepForCard } from './agent-ask';

/** The unbound Run an Agent steps among `nodeIds` (what the build just placed). */
export function unboundAgentSteps(nodeIds: readonly string[]): string[] {
  const { nodes } = useEditor.getState();
  return nodeIds.filter((id) => {
    const wf = nodes.find((n) => n.id === id)?.data.wf;
    return wf?.type === 'core.messageAgent' && !(typeof wf.parameters.agentId === 'string' && wf.parameters.agentId.trim());
  });
}

const oneLine = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** Designs each unbound step's agent; one task, which a test run waits for (`agentsSettled`). */
export function designUnboundAgents(nodeIds: readonly string[], ask: string): Promise<void> {
  const steps = unboundAgentSteps(nodeIds);
  if (!steps.length) return Promise.resolve();
  const task = (async () => {
    for (const nodeId of steps) await designFor(nodeId, ask);
  })();
  holdForAgents(task);
  return task;
}

async function designFor(nodeId: string, ask: string): Promise<void> {
  const editor = useEditor.getState();
  const node = editor.nodes.find((n) => n.id === nodeId);
  if (!node) return;
  const name = node.data.wf.name;
  const progress = (patch: Parameters<ReturnType<typeof useAssistant.getState>['setAgent']>[1]) => useAssistant.getState().setAgent(nodeId, { name, ...patch });
  progress({ state: 'designing' });
  try {
    const nameOf = (id: string) => editor.nodes.find((n) => n.id === id)?.data.wf.name;
    const main = editor.edges.filter((e) => (e.data?.connectionType ?? 'main') === 'main');
    const after = nameOf(main.find((e) => e.target === nodeId)?.source ?? '');
    const before = nameOf(main.find((e) => e.source === nodeId)?.target ?? '');
    const message = typeof node.data.wf.parameters.message === 'string' && !node.data.wf.parameters.message.includes('{{') ? node.data.wf.parameters.message.trim() : '';
    const description = message || `Does the “${name}” step of this flow: ${oneLine(ask, 160)}`;
    const place = { workflow: editor.name, ...(after && { after }), ...(before && { before }) };
    const spec = { name, description, instructions: '', ask: ask.slice(0, 4000) }; // the route reads `ask`: the whole ask, as the agent card's design sends it
    const preview = (await designPreview(spec, place)) as Parameters<typeof cardFromPreview>[0];
    const current = useEditor.getState().nodes.find((n) => n.id === nodeId);
    if (!current || (typeof current.data.wf.parameters.agentId === 'string' && current.data.wf.parameters.agentId)) {
      useAssistant.setState((s) => ({ agents: s.agents.filter((a) => a.nodeId !== nodeId) })); // the step is gone, or bound meanwhile
      return;
    }
    const reuse = preview.reuse;
    if (reuse?.agentId && !reuse.gaps.length && reuse.published) {
      useEditor.getState().updateNode(nodeId, { parameters: { ...current.data.wf.parameters, agentId: reuse.agentId } });
      progress({ state: 'published', agentId: reuse.agentId, summary: `${reuseSentence(reuse.name, reuse.why)}` });
      return;
    }
    // No reuse row on the card: Use <name> would add another step, and this step is the one the agent is for.
    const { reuse: _closest, ...bare } = cardFromPreview(preview, { name, description, placed: true, tools: [] }, false, ask);
    const card = { ...bare, workflowId: useEditor.getState().workflowId };
    const waits = card.needs.length > 0 || card.missing.length > 0 || !card.model;
    const alone = useAutonomous.getState().on && autonomyOf(useEditor.getState().workflowId) === 'auto';
    const text = alone && !waits ? `Creating “${card.name}” for “${name}” now.` : `Designed “${card.name}” for “${name}”. ${waits ? 'It needs something from you before it is created.' : 'Review it, then create it.'}`;
    const item: ChatItem = { id: nanoid(8), role: 'assistant', parts: [{ kind: 'text', text }, { kind: 'agentCard', card }] };
    useAssistant.getState().append([item]);
    stepForCard.set(item.id, nodeId);
    useAssistant.setState((s) => ({ agents: s.agents.filter((a) => a.nodeId !== nodeId) }));
    if (alone && !waits) await createFromCard(item.id, card);
  } catch (error) {
    progress({ state: 'failed', summary: `${(error as Error).message} The Run an Agent step has no agent yet: pick one, or ask Spotlight to create it.` });
  }
}
