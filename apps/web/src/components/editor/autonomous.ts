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
import { api } from '@/lib/client/api';
import { askKind } from '@/lib/shared/ask-kind';
import { applyChanges, undos, useAssistant } from './assistant';
import { autonomyOf, needsAClick, noteOpened, notePublished, noteSwitch, useAutonomyFacts, type ChangeGraph } from './spotlight-autonomy';
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
    noteSwitch(on); // SB04:
  },
}));

export const autonomous = () => useAutonomous.getState().on;

// SB04: what the autonomy rule (./spotlight-autonomy.ts, decision D1) learns from this tab. The switch, as stored and as moved.
noteSwitch(useAutonomous.getState().on);
useAutonomous.subscribe((s) => noteSwitch(s.on));

// SB04: every workflow the editor loads is noted once, with the node count of the same state; the first note wins.
// A workflow opened empty may have been published: one read of its versions says.
function opened(workflowId: string, nodeCount: number) {
  const known = Boolean(useAutonomyFacts.getState().workflows[workflowId]);
  noteOpened(workflowId, nodeCount);
  if (known || nodeCount > 0) return;
  void api<{ publishedVersionId?: string }>(`/api/workflows/${workflowId}/versions`, { background: true })
    .then((r) => {
      if (r.publishedVersionId) notePublished(workflowId);
    })
    .catch(() => {
      // Unread: the workflow stays what it was noted as (born empty); a publish from this tab ends it too.
    });
}
// A published workflow is not a new draft: `active` is set by a load and by every publish (the header, a rollback, a schedule, Spotlight's card).
useEditor.subscribe((state, prev) => {
  if (state.workflowId && state.active && (!prev.active || state.workflowId !== prev.workflowId)) {
    noteOpened(state.workflowId, state.nodes.length);
    notePublished(state.workflowId);
  }
});
useEditor.subscribe((state, prev) => {
  if (state.workflowId === prev.workflowId || !state.workflowId) return;
  const earlier = useAutonomyFacts.getState().workflows[prev.workflowId];
  // The same canvas under a new id (a new workflow's first save): its facts go with it. A load builds new nodes.
  if (prev.workflowId && earlier && state.nodes === prev.nodes && !useAutonomyFacts.getState().workflows[state.workflowId]) {
    useAutonomyFacts.setState((s) => ({ workflows: { ...s.workflows, [state.workflowId]: earlier } }));
    return;
  }
  opened(state.workflowId, state.nodes.length);
});
// A store that loaded before this module did.
if (useEditor.getState().workflowId) {
  const now = useEditor.getState();
  opened(now.workflowId, now.nodes.length);
  if (now.active) notePublished(now.workflowId);
}

/** The canvas as the rule reads it. */
export function canvasGraph(): ChangeGraph {
  const { nodes, edges } = useEditor.getState();
  return {
    nodes: nodes.map((n) => ({ id: n.data.wf.id, name: n.data.wf.name })),
    connections: edges.map((e) => ({ source: e.source, target: e.target, type: e.data?.connectionType })),
  };
}

/** The `session` a typed message is sent with: `auto` only on a brand-new draft and only for a change (a question is answered, never applied). */
export function typedSession(message: string): { session?: 'auto' } {
  return autonomyOf(useEditor.getState().workflowId) === 'auto' && askKind(message) === 'change' ? { session: 'auto' } : {};
}

/** Whether a reply's unset proposals wait for the person (asks first, or a change that needs a click): cards, not rows. */
export function holdsForClick(proposals: ReadonlyArray<{ ops: Parameters<typeof needsAClick>[0] }>): boolean {
  if (autonomyOf(useEditor.getState().workflowId) !== 'auto') return true;
  const before = canvasGraph();
  return proposals.some((p) => needsAClick(p.ops, before).length > 0);
}

/**
 * A flow was just drafted on the empty canvas: test and fix it now, in place of the "Test and fix" button. `replyId` is
 * the reply that offers the button: it is marked done, so the button doesn't stay behind.
 */
export function testDraft(replyId: string, goal: string): boolean {
  // The conversation was started over (or the draft stopped) before the test began.
  if (autonomyOf(useEditor.getState().workflowId) !== 'auto' || !useAssistant.getState().items.some((i) => i.id === replyId)) return false;
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
  // SB04: only on a brand-new draft, and a question is answered, never applied.
  if (autonomyOf(useEditor.getState().workflowId) !== 'auto' || askKind(goal) === 'question') return;
  const state = useAssistant.getState();
  const reply = state.items.at(-1);
  // A stopped reply never got its `done`: what it half proposed stays a proposal.
  if (!reply || reply.role !== 'assistant' || !reply.done || reply.error || state.pending || state.testing) return;
  const unset = reply.parts.flatMap((p) => (p.kind === 'proposal' && !p.proposal.state ? [p.proposal] : []));
  // SB04: what removes a step, or leaves one without its input, waits for Apply, with its reason on the card.
  const before = canvasGraph();
  const reasons = new Map(unset.map((p) => [p.id, needsAClick(p.ops, before)] as const));
  const held = unset.filter((p) => reasons.get(p.id)!.length);
  for (const p of held) {
    const waits = `Waits for you: ${reasons.get(p.id)!.join('; ')}`;
    useAssistant.getState().updateParts(reply.id, (parts) =>
      parts.map((part) => (part.kind === 'proposal' && part.proposal.id === p.id && !part.proposal.warnings.includes(waits) ? { ...part, proposal: { ...part.proposal, warnings: [waits, ...part.proposal.warnings] } } : part)),
    );
  }
  const open = unset.filter((p) => !reasons.get(p.id)!.length);
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
