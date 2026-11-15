'use client';
/**
 * The empty canvas's first message (docs/assistant.md): the builder drafts the whole flow in one go, with test data on the
 * trigger, and the reply says what was built. Spotlight's composer and Build it's `?ask=` send both go through here.
 */
import { nanoid } from 'nanoid';
import type { BuiltFlow } from '../ai-builder';
import { testDraft, useAutonomous } from '../autonomous';
import { draft as draftCall, useAssistant, type ChatItem } from '../assistant';
import type { Reply } from './reply';

export async function draftWholeFlow(message: string, build: (prompt: string, signal?: AbortSignal) => Promise<BuiltFlow>): Promise<void> {
  const reply: ChatItem = { id: nanoid(8), role: 'assistant', parts: [] };
  useAssistant.getState().append([{ id: nanoid(8), role: 'user', text: message }, reply]);
  const patch = (fields: Partial<Reply>) => useAssistant.setState((s) => ({ items: s.items.map((i) => (i.id === reply.id ? { ...(i as Reply), ...fields } : i)) }));
  useAssistant.setState({ drafting: true });
  const abort = (draftCall.request = new AbortController());
  try {
    const flow = await build(message, abort.signal);
    const auto = useAutonomous.getState().on;
    const skipped = flow.dropped ? ` I left out ${flow.dropped} part${flow.dropped === 1 ? '' : 's'} that didn’t fit.` : '';
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
    useAssistant.setState({ drafting: false });
  }
}
