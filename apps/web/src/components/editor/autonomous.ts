'use client';
/**
 * Spotlight's autonomous mode (docs/assistant.md#autonomous-mode), on unless turned off: Spotlight doesn't wait for a
 * click. A flow it drafts on an empty canvas goes straight into Test and fix; the changes a chat reply proposes are
 * applied as the reply ends (each with Undo, as Apply would) and the flow is tested and fixed again. Publishing to
 * production still takes a person's click. An agent it creates is designed by the Agent architect and published, so the
 * flow can run it while it is tested (./new-agent.ts); unpublishing it is one click on its page.
 * The choice is kept in the browser (localStorage), like the after-run suggestions' switch.
 */
import { create } from 'zustand';
import { applyChanges, undos, useAssistant } from './assistant';
import { useEditor } from './store';
import { testUntilItRuns } from './test-session';

const KEY = 'landflow-spotlight-autonomous';

function read(): boolean {
  try {
    return localStorage.getItem(KEY) !== 'off';
  } catch {
    return true;
  }
}

export const useAutonomous = create<{ on: boolean; set(on: boolean): void }>((set) => ({
  on: read(),
  set(on) {
    try {
      localStorage.setItem(KEY, on ? 'on' : 'off');
    } catch {
      // Private mode: the switch still works for this page.
    }
    set({ on });
  },
}));

export const autonomous = () => useAutonomous.getState().on;

/**
 * A flow was just drafted on the empty canvas: test and fix it now, in place of the "Test and fix" button. `replyId` is
 * the reply that offers the button: it is marked done, so the button doesn't stay behind.
 */
export function testDraft(replyId: string, goal: string): boolean {
  // The conversation was started over (or the draft stopped) before the test began.
  if (!autonomous() || !useAssistant.getState().items.some((i) => i.id === replyId)) return false;
  useAssistant.getState().updateParts(replyId, (parts) => parts.map((p) => (p.kind === 'action' && p.action === 'test' ? { ...p, state: 'done' } : p)));
  void testUntilItRuns(goal, { publishAgents: true });
  return true;
}

/**
 * A chat reply has ended: apply what it proposed, as one step with one Undo, then test and fix the flow against what
 * the workflow is for plus this request. Nothing happens for a reply that proposed nothing, failed, or was stopped; a
 * change that only renames or moves nodes isn't tested (nothing a run does changes).
 */
export async function afterReply(goal: string): Promise<void> {
  if (!autonomous()) return;
  const state = useAssistant.getState();
  const reply = state.items.at(-1);
  // A stopped reply never got its `done`: what it half proposed stays a proposal.
  if (!reply || reply.role !== 'assistant' || !reply.done || reply.error || state.pending || state.testing) return;
  const open = reply.parts.flatMap((p) => (p.kind === 'proposal' && !p.proposal.state ? [p.proposal] : []));
  if (!open.length) return;
  const label = open.length === 1 ? `Applied: ${open[0].summary}` : `Applied ${open.length} changes`;
  let skipped = 0;
  const applied = applyChanges(open.map((p) => ({ ops: p.ops, kind: 'proposal' as const })), label, {
    publishAgents: true,
    quiet: true,
    onApplied: ({ undo, skipped: dropped }) => {
      for (const p of open) undos.set(p.id, undo);
      skipped = dropped.length;
    },
  });
  // Not applied: the proposals stay as cards for the person to decide.
  if (!applied) return;
  for (const p of open) useAssistant.getState().setProposalState(reply.id, p.id, 'applied', skipped);
  useAssistant.setState((s) => ({ items: s.items.map((i) => (i.id === reply.id && i.role === 'assistant' ? { ...i, auto: true } : i)) }));
  if (open.every((p) => p.ops.every((op) => op.op === 'renameNode'))) return;
  const purpose = useEditor.getState().description?.trim();
  await testUntilItRuns(purpose && purpose !== goal ? `${purpose} (Latest change: ${goal})` : goal, { publishAgents: true });
}
