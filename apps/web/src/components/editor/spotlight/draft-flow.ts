'use client';
/**
 * The empty canvas's first message (docs/assistant.md): the builder drafts the whole flow in one go, with test data on the
 * trigger, and the reply says what was built. Spotlight's composer and Build it's `?ask=` send both go through here.
 */
import { nanoid } from 'nanoid';
import { api } from '@/lib/client/api'; // SB13:
import type { BuildPlan } from '@/lib/shared/build-plan'; // SB13:
import type { BuiltFlow } from '../ai-builder';
import { pickedModel } from '../spotlight-model'; // SB13:
import { testDraft, useAutonomous } from '../autonomous';
import { draft as draftCall, useAssistant, type ChatItem } from '../assistant';
import { autonomyOf } from '../spotlight-autonomy';
import { useEditor } from '../store';
import type { Reply } from './reply';
import { waitForBuildIt, type PlanPart } from './plan-part'; // SB13:

/**
 * SB13: stage 1 of the first draft. The plan route answers the steps in words; the card shows them. Autonomous on a new
 * draft (D1) builds at once; asks-first waits for the card's Build it (the canvas is not busy while it waits). Undefined:
 * stopped before the person agreed.
 */
async function planFirst(message: string, cardId: string, signal: AbortSignal, auto: boolean): Promise<BuildPlan | undefined> {
  const answer = await api<{ plan: BuildPlan; alternatives: PlanPart['alternatives'] }>('/api/ai/build/plan', { method: 'POST', json: { prompt: message, workflowId: useEditor.getState().workflowId || undefined, ...pickedModel() }, signal });
  const setState = (state: PlanPart['state']) => useAssistant.getState().updateParts(cardId, (parts) => parts.map((p) => (p.kind === 'plan' ? { ...p, plan: { ...p.plan, state } } : p)));
  useAssistant.getState().updateParts(cardId, () => [{ kind: 'plan', plan: { plan: answer.plan, alternatives: answer.alternatives, state: auto ? 'building' : 'waiting', prompt: message } }]);
  if (auto) return answer.plan;
  useAssistant.setState({ drafting: false });
  const agreed = await waitForBuildIt(cardId, signal);
  if (!agreed) return setState('stopped'), undefined;
  setState('building');
  useAssistant.setState({ drafting: true });
  return agreed;
}

/** SB13: where the plan card stands once the build is over. */
const markPlan = (cardId: string, state: PlanPart['state']) => useAssistant.getState().updateParts(cardId, (parts) => parts.map((p) => (p.kind === 'plan' ? { ...p, plan: { ...p.plan, state } } : p)));

export async function draftWholeFlow(message: string, build: (prompt: string, signal?: AbortSignal, plan?: BuildPlan) => Promise<BuiltFlow>): Promise<void> {
  // SB13: the plan card is its own item, before the build's reply; a plan still waiting for Build it is stopped by a new ask.
  draftCall.request?.abort();
  const card: ChatItem = { id: nanoid(8), role: 'assistant', parts: [] };
  const reply: ChatItem = { id: nanoid(8), role: 'assistant', parts: [] };
  useAssistant.getState().append([{ id: nanoid(8), role: 'user', text: message }, card]);
  const patchOf = (id: string) => (fields: Partial<Reply>) => useAssistant.setState((s) => ({ items: s.items.map((i) => (i.id === id ? { ...(i as Reply), ...fields } : i)) }));
  let patch = patchOf(card.id); // SB13: the card's, until the plan is agreed; then the build's reply
  useAssistant.setState({ drafting: true });
  const abort = (draftCall.request = new AbortController());
  try {
    // The same rule testDraft applies: "Testing it now" only where Spotlight does test the draft by itself (D1: a brand-new draft).
    const plan = await planFirst(message, card.id, abort.signal, useAutonomous.getState().on && autonomyOf(useEditor.getState().workflowId) === 'auto'); // SB13:
    if (!plan) return; // SB13: stopped at the card; the card says so
    useAssistant.getState().append([reply]); // SB13:
    patch = patchOf(reply.id); // SB13:
    const flow = await build(message, abort.signal, plan).catch((e) => (markPlan(card.id, 'stopped'), Promise.reject(e))); // SB13: plan
    markPlan(card.id, 'built'); // SB13:
    // The same rule testDraft applies: "Testing it now" only where Spotlight does test the draft by itself.
    const auto = useAutonomous.getState().on && autonomyOf(useEditor.getState().workflowId) === 'auto';
    // SB02: what the guards left for the person (the full summary is wave sb3's).
    const skipped = flow.left.length ? ` Left for you: ${flow.left.slice(0, 3).map((l) => l.text).join('; ')}${flow.left.length > 3 ? ` (and ${flow.left.length - 3} more)` : ''}.` : '';
    const pinned = flow.pinned ? ' Test data is pinned on the trigger.' : '';
    patch({
      parts: [{ kind: 'text', text: `Built “${flow.name}” with ${flow.nodes} nodes.${skipped}${pinned} ⌘Z undoes it.${auto ? ' Testing it now.' : ''}` }, { kind: 'action', action: 'test', goal: message }],
      done: { model: flow.model, durationMs: flow.durationMs, steps: 1 },
    });
    // Autonomous: no "Test and fix" click. It starts once the drafting card is gone (finally, below).
    if (auto) queueMicrotask(() => testDraft(reply.id, message));
  } catch (e) {
    if (abort.signal.aborted) patch({ parts: [{ kind: 'text', text: 'Stopped: nothing was drafted.' }] });
    else patch({ error: `Couldn’t build the flow: ${(e as Error).message}` });
  } finally {
    if (draftCall.request === abort) draftCall.request = undefined;
    if (!draftCall.request) useAssistant.setState({ drafting: false }); // SB13: not while a newer ask has taken over
  }
}
