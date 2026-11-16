'use client';
/**
 * Building, step by step (docs/assistant.md#building-step-by-step). While Spotlight works on a
 * change, its reply in the Spotlight panel lists the steps and ticks each one off (LiveSteps); the nodes the plan adds
 * appear on the canvas as dashed ghosts (the one being made shimmers) with dashed new connections; a thin bar on top of the
 * canvas shows how far the plan is. It is still a plan: nothing changes in the workflow until it is applied (by Apply, or
 * by autonomous mode as the reply ends).
 *
 * A proposal arrives whole, so its steps are revealed one by one on a short timer (`useReveal`); the tool calls before it
 * (Read the workflow, Searched nodes…) are steps as they stream.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { BaseEdge, Handle, Position, type Edge, type EdgeProps, type Node, type NodeProps } from '@xyflow/react';
import { create } from 'zustand';
import { buildSteps, planOf, stepProgress, mergeTrace, visibleGhosts, type BuildStep, type GhostNode, type Plan } from '@/lib/shared/build-steps';
import { nodeColor } from '@/lib/client/node-style';
import type { ActivityStep } from '@/lib/shared/activity';
import { cn } from '@/lib/utils';
import { ActivityTrace } from '../ui/activity-trace';
import { Button } from '../ui/button';
import { NodeIcon } from '../ui/icon';
import { edgePath, useLane } from '../canvas/edge-path';
import { applyChanges, editorLookup, sendFeedback, undos, useAssistant, useWorking, type AssistantTurn, type ChatItem, type Proposal } from './assistant';
import { holdsForClick, useAutonomous } from './autonomous';
import { LeftOut, Warnings } from './suggestions-card';
import { MOTION_MS, ghostFade } from './spotlight/states';
import { handleId, useEditor } from './store';
import { useAutonomyFacts } from './spotlight-autonomy';

/** How long a step takes to tick off once the plan is there. */
const STEP_MS = 520;

/** The steps revealed so far, for the reply they belong to. */
const useRevealed = create<{ reply?: string; revealed: number }>(() => ({ revealed: 0 }));

export interface Live {
  replyId: string;
  ask?: string;
  proposals: Array<{ itemId: string; proposal: Proposal }>;
  tools: Array<{ label: string; ok: boolean }>;
  text?: string;
  streaming: boolean;
  plan: Plan;
  revealed: number;
  steps: BuildStep[];
  progress: number;
}

/**
 * The reply being built: the last turn when it is the assistant's own reply to this chat. A test session's turn is not one,
 * nor is a turn brought back under "Earlier": that one keeps its ProposalCard (Apply and Dismiss) and plays no build.
 */
export function builtReply(items: readonly ChatItem[]): AssistantTurn | undefined {
  const last = items.at(-1);
  return last?.role === 'assistant' && !last.testId && !last.earlier ? last : undefined;
}

/** The change being built, if any: the last reply is still going or has proposals waiting. */
export function useLive(): Live | undefined {
  const items = useAssistant((s) => s.items);
  const streaming = useAssistant((s) => s.pending);
  const busy = useAssistant((s) => s.drafting || Boolean(s.testing));
  const working = useWorking();
  const nodes = useEditor((s) => s.nodes);
  const edges = useEditor((s) => s.edges);
  const reply = useRevealed((s) => s.reply);
  const revealedNow = useRevealed((s) => s.revealed);

  const asked = builtReply(items);
  const proposals = useMemo(() => (asked ? asked.parts.flatMap((p) => (p.kind === 'proposal' && !p.proposal.state && p.proposal.ops.length ? [{ itemId: asked.id, proposal: p.proposal }] : [])) : []), [asked]);
  const plan = useMemo(
    () => (asked && proposals.length ? planOf(useEditor.getState().toWorkflow(), proposals.flatMap((p) => p.proposal.ops), editorLookup()) : undefined),
    // The graph is read through the store; nodes and edges change it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [asked, proposals, nodes, edges],
  );
  const failed = Boolean(asked?.error) && !proposals.length;
  const active = Boolean(asked) && !busy && !working && !failed && (streaming || proposals.length > 0);
  const empty = useMemo<Plan>(() => ({ steps: [], nodes: [], links: [], dropped: [] }), []);
  const used = plan ?? empty;
  const revealed = asked && reply === asked.id ? Math.min(revealedNow, used.steps.length) : 0;
  const tools = useMemo(() => (asked ? asked.parts.flatMap((p) => (p.kind === 'tool' ? [{ label: p.tool.label, ok: p.tool.ok }] : [])) : []), [asked]);
  const steps = useMemo(() => buildSteps({ tools, plan: used, revealed, working: streaming, nodeCount: nodes.length }), [tools, used, revealed, streaming, nodes.length]);
  if (!active || !asked) return undefined;
  const text = asked.parts.findLast((p) => p.kind === 'text');
  const ask = items.findLast((i) => i.role === 'user' && !i.auto);
  return {
    replyId: asked.id,
    ask: ask?.role === 'user' ? ask.text : undefined,
    proposals,
    tools,
    text: text?.kind === 'text' ? text.text : undefined,
    streaming,
    plan: used,
    revealed,
    steps,
    progress: stepProgress(steps),
  };
}

/** Reveals the plan's steps one by one while the change is being built. */
function useReveal(live: Live | undefined) {
  const id = live?.replyId;
  const total = live?.plan.steps.length ?? 0;
  const reply = useRevealed((s) => s.reply);
  const revealed = useRevealed((s) => s.revealed);
  useEffect(() => {
    if (id && reply !== id) useRevealed.setState({ reply: id, revealed: 0 });
  }, [id, reply]);
  useEffect(() => {
    if (!id || reply !== id || revealed >= total) return;
    const timer = setTimeout(() => useRevealed.setState((s) => ({ revealed: s.revealed + 1 })), revealed === 0 ? 250 : STEP_MS);
    return () => clearTimeout(timer);
  }, [id, reply, total, revealed]);
}

/** The thin bar on top of the canvas: how far the plan is. Also runs the reveal. */
export function BuildProgressBar() {
  const live = useLive();
  useReveal(live);
  if (!live) return null;
  const done = !live.streaming && live.revealed >= live.plan.steps.length;
  return (
    <div role="progressbar" aria-label="Progress of the change" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(live.progress * 100)} className="pointer-events-none absolute inset-x-0 top-0 z-30 h-[3px] bg-hair/60">
      <div className={cn('h-full rounded-r-full transition-[width] duration-500 ease-out', done ? 'bg-gn' : 'lf-shimmer')} style={{ width: `${Math.max(live.progress, live.streaming ? 0.04 : 0) * 100}%` }} />
    </div>
  );
}

/**
 * A change being built, as the steps of its reply in the Spotlight panel's timeline: each ticks off as the ghosts appear
 * on the canvas. Apply and Dismiss when autonomous mode is off; on, Spotlight applies it as the reply ends.
 */
export function LiveSteps({ live, trace, durationMs }: { live: Live; trace?: ActivityStep[]; durationMs?: number }) {
  const autonomous = useAutonomous((s) => s.on);
  const { streaming, plan, revealed, steps } = live;
  const ready = !streaming && live.proposals.length > 0;
  const all = revealed >= plan.steps.length;
  const dropped = live.proposals.reduce((n, p) => n + p.proposal.dropped.length, 0);
  const warnings = live.proposals.flatMap((p) => p.proposal.warnings);

  const decide = (state: 'applied' | 'dismissed') => {
    for (const { itemId, proposal } of live.proposals) useAssistant.getState().setProposalState(itemId, proposal.id, state);
  };
  // Re-render when what holdsForClick reads changes (the switch, the published read arriving, the workflow opening).
  useAutonomyFacts((s) => s.workflows);
  useAutonomyFacts((s) => s.switchOn);
  useEditor((s) => s.workflowId);
  const apply = () => {
    const label = live.proposals.length === 1 ? live.proposals[0].proposal.summary : `${live.proposals.length} changes`;
    // Each proposal keeps the one Undo, so the row it folds into can offer it.
    const onApplied = ({ undo }: { undo: () => void }) => {
      for (const p of live.proposals) undos.set(p.proposal.id, undo);
    };
    if (!applyChanges(live.proposals.map((p) => ({ ops: p.proposal.ops, kind: 'proposal' as const })), label, { onApplied })) return;
    decide('applied');
  };

  return (
    <div className="space-y-2">
      {/* The plan's steps once there are some, else what the chat stream says it did (with times): one trace line while it works. */}
      <ActivityTrace steps={mergeTrace(trace, steps)} live={streaming || !all} durationMs={durationMs} />
      {ready && <Warnings warnings={warnings} />}
      {ready && dropped > 0 && (
        <LeftOut reasons={live.proposals.flatMap((p) => p.proposal.dropped)} />
      )}
      {ready && all && (!autonomous || holdsForClick(live.proposals.map((p) => p.proposal))) && ( // SB04: a saved workflow, or a change that needs a click, shows Apply even with the switch on
        <div className="flex items-center gap-1.5">
          <Button size="sm" variant="primary" onClick={apply}>
            Apply
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              decide('dismissed');
              sendFeedback('proposal', 'dismissed');
            }}
          >
            Dismiss
          </Button>
          <span className="ml-auto text-[11px] text-t3">Nothing changes until you apply</span>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Ghosts on the canvas
// ---------------------------------------------------------------------------

export interface GhostData extends Record<string, unknown> {
  name: string;
  type: string;
  ins: string[];
  outs: string[];
  active: boolean;
  /** Apply: the ghost fades out as the real node fades in. Undo: it comes back for a moment, then fades out. */
  fade?: 'out' | 'back';
}
export type GhostFlowNode = Node<GhostData, 'ghost'>;
export type GhostFlowEdge = Edge<{ connectionType: string; active: boolean }, 'ghost'>;

const NONE = { nodes: [] as GhostFlowNode[], edges: [] as GhostFlowEdge[] };

/**
 * The ghosts that stay a moment after the change is applied (they fade out as the real nodes fade in; their ids carry a
 * prefix so they never share one with the real node) or come back when it is undone (docs/assistant.md#apply-and-undo).
 */
function useGhostTail(live: Live | undefined, shown: GhostFlowNode[]): GhostFlowNode[] {
  const last = useRef<{ nodes: GhostFlowNode[]; ids: string[] }>(undefined);
  const [tail, setTail] = useState<GhostFlowNode[]>([]);
  const ids = live?.proposals.map((p) => p.proposal.id) ?? [];
  if (live && shown.length) last.current = { nodes: shown, ids };
  const states = useAssistant((s) => s.items);
  // What the proposals of the last ghosts did since: applied, or undone again.
  const state = (id: string) => states.flatMap((i) => (i.role === 'assistant' ? i.parts.flatMap((p) => (p.kind === 'proposal' && p.proposal.id === id ? [p.proposal.state] : [])) : []))[0];
  const first = last.current?.ids[0];
  const now = first && !live ? state(first) : undefined;
  const seen = useRef<string>(undefined);
  useEffect(() => {
    const fade = ghostFade(now);
    if (!last.current || !first || !fade || seen.current === `${first}:${now}`) return;
    seen.current = `${first}:${now}`;
    setTail(last.current.nodes.map((n) => ({ ...n, id: `fade-${n.id}`, data: { ...n.data, active: false, fade } })));
    const timer = setTimeout(() => setTail([]), fade === 'out' ? MOTION_MS.ghosts + 60 : MOTION_MS.undoHold + MOTION_MS.ghosts + 60);
    return () => clearTimeout(timer);
  }, [now, first]);
  // A new change starts over.
  const going = Boolean(live);
  useEffect(() => {
    if (going) setTail((t) => (t.length ? [] : t));
  }, [going]);
  return tail;
}

/** The nodes and connections the plan adds, as React Flow nodes and edges to draw beside the real ones. */
export function useGhosts(): { nodes: GhostFlowNode[]; edges: GhostFlowEdge[] } {
  const live = useLive();
  const built = useMemo(() => {
    if (!live || !live.plan.nodes.length) return NONE;
    const shown = visibleGhosts(live.plan, live.revealed);
    // The one being made is the step in progress; once every step is reached nothing shimmers.
    const finished = live.revealed >= live.plan.steps.length && !live.streaming;
    const nodes: GhostFlowNode[] = shown.nodes.map((n: GhostNode & { active: boolean }) => ({
      id: n.id,
      type: 'ghost',
      position: { x: n.position[0], y: n.position[1] },
      data: { name: n.name, type: n.type, ins: n.ins, outs: n.outs, active: n.active && !finished },
      draggable: false,
      selectable: false,
      connectable: false,
      deletable: false,
      focusable: false,
    }));
    const edges: GhostFlowEdge[] = shown.links.map((l) => ({
      id: `ghost-edge-${l.id}`,
      type: 'ghost',
      source: l.source,
      target: l.target,
      sourceHandle: handleId(l.type, l.type === 'main' ? l.sourceIndex : 0),
      targetHandle: handleId(l.type, l.type === 'main' ? l.targetIndex : 0),
      data: { connectionType: l.type, active: l.step === live.revealed && !finished },
      selectable: false,
      deletable: false,
      focusable: false,
    }));
    return { nodes, edges };
  }, [live]);
  const tail = useGhostTail(live, built.nodes);
  return useMemo(() => (tail.length ? { nodes: tail, edges: [] as GhostFlowEdge[] } : built), [tail, built]);
}

/** A node the plan adds: a dashed tile in its colour; the one being made shimmers. */
export function GhostNodeView({ data }: NodeProps<GhostFlowNode>) {
  const info = useEditor((s) => s.nodeTypes[data.type]);
  const color = nodeColor(info);
  const isAi = (id: string) => id.startsWith('ai_');
  // Applied: fade out at once (the real node fades in beneath). Undone: show, then fade out.
  const [gone, setGone] = useState(false);
  useEffect(() => {
    if (!data.fade) return;
    const frame = requestAnimationFrame(() => setTimeout(() => setGone(true), data.fade === 'back' ? MOTION_MS.undoHold : 0));
    return () => cancelAnimationFrame(frame);
  }, [data.fade]);
  return (
    <div
      className={cn('pointer-events-none flex w-[88px] flex-col items-center gap-1.5', !data.fade && 'animate-node-in', data.fade && 'transition-opacity ease-out motion-reduce:transition-none')}
      style={{ ['--node' as string]: color, ...(data.fade && { opacity: gone ? 0 : 1, transitionDuration: `${MOTION_MS.ghosts}ms` }) }}
    >
      <div className={cn('relative grid size-[88px] place-items-center overflow-hidden rounded-2xl border-2 border-dashed bg-sf/80', data.active ? 'border-viz-7' : 'border-[color-mix(in_oklab,var(--node)_55%,var(--bd))]')}>
        {data.active && <span className="lf-shimmer absolute inset-x-0 bottom-0 h-[3px]" />}
        <NodeIcon icon={info?.descriptor.icon} size={26} style={{ color }} strokeWidth={1.7} />
      </div>
      <span className="max-w-[160px] truncate rounded-full border border-dashed border-bd bg-sf px-2 py-px text-[11px] leading-4 text-t2">{data.name}</span>
      {data.ins.map((id) => (
        <Handle key={`in-${id}`} id={id} type="target" position={isAi(id) ? Position.Bottom : Position.Left} className="!pointer-events-none !size-1 !min-h-0 !min-w-0 !border-0 !bg-transparent" style={isAi(id) ? undefined : { top: 44 }} isConnectable={false} />
      ))}
      {data.outs.map((id) => (
        <Handle key={`out-${id}`} id={id} type="source" position={isAi(id) ? Position.Top : Position.Right} className="!pointer-events-none !size-1 !min-h-0 !min-w-0 !border-0 !bg-transparent" style={isAi(id) ? undefined : { top: 44 }} isConnectable={false} />
      ))}
    </div>
  );
}

/** A connection the plan adds: dashed, in the assistant's violet. */
export function GhostEdgeView(props: EdgeProps<GhostFlowEdge>) {
  const { id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data } = props;
  const isAi = data?.connectionType !== 'main';
  const ends = { sourceX, sourceY, targetX, targetY, sourcePosition: sourcePosition ?? Position.Right, targetPosition: targetPosition ?? Position.Left };
  const [path] = edgePath(ends, isAi, useLane(ends, isAi));
  return <BaseEdge id={id} path={path} className="animate-in" style={{ stroke: 'var(--viz-7)', strokeWidth: data?.active ? 2.2 : 1.6, strokeDasharray: '6 5', opacity: data?.active ? 1 : 0.75 }} />;
}
