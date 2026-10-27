'use client';
/**
 * Spotlight in the editor (docs/assistant.md): one bar floating at the bottom of the canvas to build and fix the
 * workflow with the assistant. Bubbles above it suggest what to ask and complete what is typed (`@` a node on the
 * canvas, a node type this workflow may use); the conversation opens above the bar, and proposed changes wait for Apply.
 * On an empty canvas the first message drafts the whole flow. "Test and fix" (./test-session.ts) runs the workflow, has
 * failures fixed until a run passes, then offers to publish it. While Spotlight drafts, tests and fixes on its own, the
 * conversation waits in a card at the side of the canvas (SpotlightActivity), so the flow stays in view; it comes back
 * when the work is over, with the session folded into one line.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useReactFlow } from '@xyflow/react';
import { ArrowUp, Check, ChevronDown, ChevronRight, CircleCheck, CircleX, Loader2, Maximize2, MessageSquare, Minimize2, Play, Rocket, Sparkles, Square, SquarePen, Wrench, X } from 'lucide-react';
import { nanoid } from 'nanoid';
import { cn } from '@/lib/utils';
import { completeBubbles, idleBubbles, liveMentions, TEST_BUBBLE, type Bubble, type Mention, type SpotlightContext } from '@/lib/shared/spotlight';
import { Button } from '../ui/button';
import { useBuildFlow } from './ai-builder';
import { applyChanges, sendFeedback, suggestionKey, useAssistant, useSuggestions, type ChatItem, type Proposal, type ReplyAction, type ReplyPart, type Suggestion, type TestRun } from './assistant';
import { useEditor } from './store';
import { OpsDiff, Warnings } from './suggestions-card';
import { MAX_FIXES, productionNote, publishToProduction, testUntilItRuns } from './test-session';

const INPUT_ID = 'spotlight-input';

/** ⌘I and the empty canvas's hint: put the caret in Spotlight. */
export function focusSpotlight() {
  document.getElementById(INPUT_ID)?.focus();
}

type Reply = Extract<ChatItem, { role: 'assistant' }>;

/** After Apply the conversation steps aside so the change shows on the canvas; the toast has Undo. */
function applied(decide: (state: 'applied') => void) {
  decide('applied');
  useAssistant.getState().setOpen(false);
}

function ProposalCard({ itemId, proposal }: { itemId: string; proposal: Proposal }) {
  const decide = (state: 'applied' | 'dismissed') => useAssistant.getState().setProposalState(itemId, proposal.id, state);
  return (
    <div className={cn('animate-fade-up space-y-2 rounded-xl border bg-sf p-2.5', proposal.state === 'applied' ? 'border-gnbd' : 'border-acbd')}>
      <div className="text-[13px] font-semibold leading-snug text-t1">{proposal.summary}</div>
      <OpsDiff ops={proposal.ops} />
      <Warnings warnings={proposal.warnings} />
      {proposal.dropped.length > 0 && (
        <p className="text-[11px] text-t3" title={proposal.dropped.join('\n')}>
          {proposal.dropped.length} part{proposal.dropped.length === 1 ? '' : 's'} left out (hover for why)
        </p>
      )}
      <div className="flex items-center gap-1.5">
        {proposal.state === 'applied' ? (
          <span className="flex animate-pop items-center gap-1 text-[12px] font-semibold text-gn">
            <Check className="size-3.5" /> Applied
          </span>
        ) : proposal.state === 'dismissed' ? (
          <span className="text-[12px] text-t3">Dismissed</span>
        ) : (
          <>
            <Button size="sm" variant="primary" onClick={() => applyChanges([{ ops: proposal.ops, kind: 'proposal' }], proposal.summary) && applied(decide)}>
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
          </>
        )}
      </div>
    </div>
  );
}

/** One run of a test-and-fix session. */
function RunLine({ run }: { run: TestRun }) {
  return (
    <div className="flex items-start gap-1.5 text-[12.5px] leading-snug">
      {run.state === 'running' ? (
        <Loader2 className="mt-px size-3.5 shrink-0 animate-spin text-t3" />
      ) : run.state === 'passed' ? (
        <CircleCheck className="mt-px size-3.5 shrink-0 text-gn" />
      ) : (
        <CircleX className="mt-px size-3.5 shrink-0 text-rd" />
      )}
      <span className="min-w-0 [overflow-wrap:anywhere]">
        <span className="font-semibold text-t1">Test run {run.round}</span>
        <span className="text-t2"> · {run.state === 'running' ? 'running…' : run.state === 'passed' ? `no errors: ${run.summary}` : run.summary}</span>
      </span>
    </div>
  );
}

/** "Test and fix" after a drafted flow; "Ready for production" after a run passed. */
function ActionView({ itemId, action }: { itemId: string; action: ReplyAction }) {
  const busy = useAssistant((s) => s.pending || Boolean(s.testing));
  const [publishing, setPublishing] = useState(false);
  const mark = (state: 'done' | 'dismissed') => useAssistant.getState().updateParts(itemId, (parts) => parts.map((p) => (p.kind === 'action' && p.action === action.action ? { ...p, state } : p)));
  if (action.action === 'test') {
    return (
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Button
          size="sm"
          variant="primary"
          disabled={busy || Boolean(action.state)}
          onClick={() => {
            mark('done');
            void testUntilItRuns(action.goal);
          }}
        >
          <Play className="size-3" fill="currentColor" /> Test and fix
        </Button>
        <span className="text-[11.5px] text-t3">Runs it; when a step fails, Spotlight fixes it and runs it again (up to {MAX_FIXES} fixes).</span>
      </div>
    );
  }
  return (
    <div className="animate-fade-up space-y-2 rounded-xl border border-gnbd bg-sf p-2.5">
      <div className="flex items-center gap-1.5 text-[13px] font-semibold text-t1">
        <Rocket className="size-3.5 text-gn" /> Ready for production
      </div>
      <p className="text-[12px] leading-snug text-t2">{productionNote()}</p>
      {action.state === 'done' ? (
        <span className="flex animate-pop items-center gap-1 text-[12px] font-semibold text-gn">
          <Check className="size-3.5" /> Published
        </span>
      ) : action.state === 'dismissed' ? (
        <span className="text-[12px] text-t3">Not published</span>
      ) : (
        <div className="flex items-center gap-1.5">
          <Button
            size="sm"
            variant="primary"
            disabled={publishing}
            onClick={async () => {
              setPublishing(true);
              if (await publishToProduction()) mark('done');
              setPublishing(false);
            }}
          >
            {publishing ? <Loader2 className="size-3.5 animate-spin" /> : <Rocket className="size-3.5" />} Publish to production
          </Button>
          <Button size="sm" variant="ghost" onClick={() => mark('dismissed')}>
            Not now
          </Button>
        </div>
      )}
    </div>
  );
}

/** A reply: its text and proposals. While it streams, one line says what the assistant is doing. */
function ReplyView({ item, live, status }: { item: Reply; live: boolean; status?: string }) {
  const pending = item.parts.flatMap((p) => (p.kind === 'proposal' && !p.proposal.state ? [p.proposal] : []));
  const lastTool = item.parts.findLast((p) => p.kind === 'tool');
  const applyAll = () => {
    if (!applyChanges(pending.map((p) => ({ ops: p.ops, kind: 'proposal' as const })), `Applied ${pending.length} changes`)) return;
    for (const p of pending) useAssistant.getState().setProposalState(item.id, p.id, 'applied');
    useAssistant.getState().setOpen(false);
  };
  const meta = item.done && `${item.done.model} · ${(item.done.durationMs / 1000).toFixed(1)} s · ${item.done.steps} step${item.done.steps === 1 ? '' : 's'}`;
  // A test run shows its own progress.
  const working = live && !item.parts.some((p) => p.kind === 'run' || p.kind === 'action');
  return (
    <div className="flex animate-in gap-2" title={meta || undefined}>
      <span className="mt-0.5 grid size-5 shrink-0 place-items-center text-viz-7">{working ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}</span>
      <div className="min-w-0 flex-1 space-y-2">
        {item.parts.map((part, i) =>
          part.kind === 'text' ? (
            <div key={i} className="whitespace-pre-wrap text-[13px] leading-relaxed text-t1 [overflow-wrap:anywhere]">
              {part.text}
            </div>
          ) : part.kind === 'proposal' ? (
            <ProposalCard key={part.proposal.id} itemId={item.id} proposal={part.proposal} />
          ) : part.kind === 'run' ? (
            <RunLine key={i} run={part.run} />
          ) : part.kind === 'action' ? (
            <ActionView key={i} itemId={item.id} action={part} />
          ) : null,
        )}
        {working && (
          <div className="animate-pulse-soft truncate text-[12px] text-t3">{status ?? (lastTool?.kind === 'tool' ? `${lastTool.tool.label}…` : 'Thinking…')}</div>
        )}
        {item.error && <div className="rounded-[10px] border border-rdbd bg-rddim px-2.5 py-2 text-[12px] text-rd [overflow-wrap:anywhere]">{item.error}</div>}
        {!live && pending.length > 1 && (
          <Button size="sm" variant="outline" onClick={applyAll}>
            <Check className="size-3.5" /> Apply all ({pending.length})
          </Button>
        )}
      </div>
    </div>
  );
}

/** The last reply offers "Test and fix" for a flow just drafted. */
const offersTest = (items: ChatItem[]) => {
  const last = items.at(-1);
  return last?.role === 'assistant' && last.parts.some((p) => p.kind === 'action' && p.action === 'test' && !p.state);
};

/** Spotlight works on its own: drafting a flow, testing and fixing it, or a drafted flow waiting for its test. */
const useWorking = () => useAssistant((s) => s.drafting || Boolean(s.testing) || offersTest(s.items));

/** Hide the conversation: while Spotlight works, back to its card at the side. */
function hideConversation(working: boolean) {
  if (working) useAssistant.setState({ detail: false });
  else useAssistant.getState().setOpen(false);
}

/** A finished test-and-fix session, folded into one line; its runs and fixes open on a click. */
function SessionGroup({ items, render }: { items: ChatItem[]; render: (item: ChatItem) => React.ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  const runs = items.flatMap((item) => (item.role === 'assistant' ? item.parts.flatMap((p) => (p.kind === 'run' && p.run.state !== 'running' ? [p.run] : [])) : []));
  // A fix is a round: one reply, whatever number of proposals it applied.
  const fixes = items.filter((item) => item.role === 'assistant' && item.parts.some((p) => p.kind === 'proposal' && p.proposal.state === 'applied')).length;
  const passed = runs.at(-1)?.state === 'passed';
  return (
    <div className="space-y-3">
      <button
        onClick={() => setExpanded((e) => !e)}
        aria-expanded={expanded}
        className="flex w-full animate-in items-center gap-1.5 rounded-lg px-1 py-0.5 text-left text-[12.5px] text-t2 transition-colors hover:bg-acdim hover:text-t1"
      >
        {passed ? <CircleCheck className="size-3.5 shrink-0 text-gn" /> : <Wrench className="size-3.5 shrink-0 text-t3" />}
        <span className="font-semibold text-t1">Test and fix</span>
        <span>
          · {runs.length} run{runs.length === 1 ? '' : 's'} · {fixes} fix{fixes === 1 ? '' : 'es'} applied
        </span>
        <ChevronRight className={cn('ml-auto size-3.5 shrink-0 transition-transform', expanded && 'rotate-90')} />
      </button>
      {expanded && items.map(render)}
    </div>
  );
}

function Conversation({ live, status }: { live: boolean; status?: string }) {
  const items = useAssistant((s) => s.items);
  const testing = useAssistant((s) => Boolean(s.testing));
  const working = useWorking();
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' });
  }, [items]);
  const { reset } = useAssistant.getState();
  const lastId = items.at(-1)?.id;
  const render = (item: ChatItem) =>
    item.role === 'user' && item.auto ? (
      <div key={item.id} className="ml-auto flex w-fit max-w-[85%] animate-in items-start gap-1.5 rounded-xl border border-dashed border-bd px-2.5 py-1 text-[12px] leading-snug text-t2 [overflow-wrap:anywhere]">
        <Wrench className="mt-0.5 size-3 shrink-0" />
        {item.text}
      </div>
    ) : item.role === 'user' ? (
      <div key={item.id} className="ml-auto w-fit max-w-[85%] animate-in whitespace-pre-wrap rounded-xl bg-ac2 px-3 py-1.5 text-[13px] leading-relaxed text-on-ac [overflow-wrap:anywhere]">
        {item.text}
      </div>
    ) : (
      <ReplyView key={item.id} item={item} live={live && item.id === lastId} status={status} />
    );
  // Consecutive turns of one test-and-fix session form a block; once the session is over it folds.
  const blocks: Array<{ testId?: string; items: ChatItem[] }> = [];
  for (const item of items) {
    const last = blocks.at(-1);
    if (item.testId && last?.testId === item.testId) last.items.push(item);
    else blocks.push({ testId: item.testId, items: [item] });
  }
  return (
    <div className="pointer-events-auto flex max-h-[min(44vh,440px)] animate-fade-up flex-col overflow-hidden rounded-2xl border border-hair bg-sf/95 shadow-pop backdrop-blur">
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-hair pl-3 pr-1">
        <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-t3">Spotlight</span>
        <button title="New conversation" aria-label="New conversation" onClick={reset} className="ml-auto grid size-6 place-items-center rounded-full text-t3 hover:bg-acdim hover:text-t1">
          <SquarePen className="size-3.5" />
        </button>
        {working ? (
          <button title="Back to the side (esc)" aria-label="Back to the side" onClick={() => hideConversation(true)} className="grid size-6 place-items-center rounded-full text-t3 hover:bg-acdim hover:text-t1">
            <Minimize2 className="size-3.5" />
          </button>
        ) : (
          <button title="Hide (esc)" aria-label="Hide the conversation" onClick={() => hideConversation(false)} className="grid size-6 place-items-center rounded-full text-t3 hover:bg-acdim hover:text-t1">
            <ChevronDown className="size-4" />
          </button>
        )}
      </div>
      <div ref={scroller} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3">
        {blocks.map((block, i) =>
          block.testId && !(testing && i === blocks.length - 1) ? <SessionGroup key={block.testId} items={block.items} render={render} /> : block.items.map(render),
        )}
      </div>
    </div>
  );
}

interface Step {
  id: string;
  icon: 'busy' | 'passed' | 'failed' | 'fix' | 'note';
  text: string;
}

const firstSentence = (text: string) => text.trim().split(/(?<=[.!?])\s+/)[0] ?? '';

/** What Spotlight did since the user last asked for something, one step a line, for its card at the side. */
function stepsOf(items: ChatItem[], live: boolean, drafting: boolean): { ask?: string; steps: Step[] } {
  const start = items.findLastIndex((item) => item.role === 'user' && !item.auto);
  const asked = items[start];
  const steps: Step[] = [];
  const rest = items.slice(start + 1);
  rest.forEach((item, i) => {
    if (item.role === 'user') return;
    const key = (part: string | number) => `${item.id}:${part}`;
    if (item.error) {
      steps.push({ id: key('error'), icon: 'failed', text: item.error });
      return;
    }
    const runs = item.parts.flatMap((p) => (p.kind === 'run' ? [p.run] : []));
    for (const run of runs) {
      steps.push({
        id: key(`run${run.round}`),
        icon: run.state === 'running' ? 'busy' : run.state,
        text: `Test run ${run.round} · ${run.state === 'running' ? 'running…' : run.state === 'passed' ? `no errors: ${run.summary}` : run.summary}`,
      });
    }
    if (runs.length) return;
    const proposals = item.parts.flatMap((p) => (p.kind === 'proposal' ? [p.proposal] : []));
    for (const proposal of proposals) steps.push({ id: key(proposal.id), icon: 'fix', text: `${proposal.state === 'applied' ? 'Fixed' : 'Proposed'}: ${proposal.summary}` });
    if (live && i === rest.length - 1) {
      const tool = item.parts.findLast((p) => p.kind === 'tool');
      steps.push({ id: key('live'), icon: 'busy', text: tool?.kind === 'tool' ? `${tool.tool.label}…` : drafting ? 'Drafting the flow from the node catalog…' : 'Thinking…' });
      return;
    }
    const text = item.parts.find((p) => p.kind === 'text');
    if (!proposals.length && text?.kind === 'text') steps.push({ id: key('text'), icon: item.parts.some((p) => p.kind === 'action') ? 'passed' : 'note', text: firstSentence(text.text) });
  });
  return { ask: asked?.role === 'user' ? asked.text : undefined, steps };
}

const STEP_ICON: Record<Step['icon'], React.ReactNode> = {
  busy: <Loader2 className="mt-px size-3.5 shrink-0 animate-spin text-viz-7" />,
  passed: <CircleCheck className="mt-px size-3.5 shrink-0 text-gn" />,
  failed: <CircleX className="mt-px size-3.5 shrink-0 text-rd" />,
  fix: <Wrench className="mt-px size-3.5 shrink-0 text-viz-7" />,
  note: <Sparkles className="mt-px size-3.5 shrink-0 text-t3" />,
};

/**
 * While Spotlight drafts, tests and fixes on its own, its conversation waits here, at the top left of the canvas: what
 * it is doing now, and one line per step. The flow stays in view; the conversation comes back when the work is over.
 */
export function SpotlightActivity() {
  const working = useWorking();
  const detail = useAssistant((s) => s.detail);
  const items = useAssistant((s) => s.items);
  const drafting = useAssistant((s) => s.drafting);
  const testing = useAssistant((s) => Boolean(s.testing));
  const pending = useAssistant((s) => s.pending);
  const fixing = useAssistant((s) => s.fixing);
  const fixingName = useEditor((s) => (fixing ? s.nodes.find((n) => n.id === fixing)?.data.wf.name : undefined));
  const nodeCount = useEditor((s) => s.nodes.length);
  const visible = working && !detail;
  const card = useRef<HTMLDivElement>(null);
  const { fitView } = useReactFlow();
  // The canvas changes size while Spotlight works (the logs open after a run): keep the whole flow in view, right of this
  // card and clear of the dock and the minimap.
  const [canvasSize, setCanvasSize] = useState('');
  useEffect(() => {
    const canvas = card.current?.parentElement;
    if (!visible || !canvas || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setCanvasSize(`${canvas.clientWidth}x${canvas.clientHeight}`));
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [visible]);
  useEffect(() => {
    if (!visible || !nodeCount || !card.current) return;
    const left = card.current.offsetLeft + card.current.offsetWidth + 32;
    const timer = setTimeout(() => void fitView({ padding: { left: `${left}px`, top: '48px', bottom: '180px', right: '72px' }, duration: 500, maxZoom: 1 }), 120);
    return () => clearTimeout(timer);
  }, [visible, nodeCount, canvasSize, fitView]);
  if (!visible) return null;
  const { ask, steps } = stepsOf(items, pending || drafting, drafting);
  const shown = steps.slice(-6);
  const last = items.at(-1);
  const test = last?.role === 'assistant' ? last.parts.find((p): p is Extract<ReplyPart, { kind: 'action' }> => p.kind === 'action' && p.action === 'test') : undefined;
  const title = drafting ? 'Drafting the flow' : testing ? (fixingName ? `Fixing “${fixingName}”` : 'Testing and fixing') : 'Flow drafted';
  return (
    <div ref={card} role="status" aria-live="polite" className="pointer-events-auto absolute left-3 top-3 z-20 w-[320px] max-w-[calc(100%-5rem)] animate-fade-up overflow-hidden rounded-2xl border border-hair bg-sf/95 shadow-pop backdrop-blur">
      <div className="flex h-9 items-center gap-1.5 border-b border-hair pl-3 pr-1">
        {drafting || testing ? <Loader2 className="size-3.5 shrink-0 animate-spin text-viz-7" /> : <Sparkles className="size-3.5 shrink-0 text-viz-7" />}
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold text-t1">{title}</span>
        {testing && (
          <button title="Stop testing" aria-label="Stop testing" onClick={() => useAssistant.getState().stop()} className="grid size-6 place-items-center rounded-full text-t3 hover:bg-rddim hover:text-rd">
            <Square className="size-3" fill="currentColor" />
          </button>
        )}
        <button title="Show the conversation" aria-label="Show the conversation" onClick={() => useAssistant.setState({ detail: true, open: true })} className="grid size-6 place-items-center rounded-full text-t3 hover:bg-acdim hover:text-t1">
          <Maximize2 className="size-3.5" />
        </button>
      </div>
      {ask && (
        <p className="truncate px-3 pt-2 text-[11.5px] text-t3" title={ask}>
          “{ask}”
        </p>
      )}
      <ol className="space-y-1.5 px-3 py-2">
        {steps.length > shown.length && <li className="text-[11px] text-t3">{steps.length - shown.length} earlier step{steps.length - shown.length === 1 ? '' : 's'}</li>}
        {shown.map((step) => (
          <li key={step.id} className="flex animate-in items-start gap-1.5 text-[12px] leading-snug">
            {STEP_ICON[step.icon]}
            <span className="line-clamp-2 min-w-0 text-t2 [overflow-wrap:anywhere]" title={step.text}>
              {step.text}
            </span>
          </li>
        ))}
      </ol>
      {test && !test.state && last && (
        <div className="border-t border-hair px-3 py-2">
          <ActionView itemId={last.id} action={test} />
        </div>
      )}
    </div>
  );
}

const latestMain = (runs: { source: string; status: string }[] | undefined) => runs?.filter((r) => r.source === 'main').at(-1);

/** What Spotlight knows of the canvas and the catalog, for its bubbles. */
function useSpotlightContext(): SpotlightContext {
  const nodes = useEditor((s) => s.nodes);
  const edges = useEditor((s) => s.edges);
  const nodeTypes = useEditor((s) => s.nodeTypes);
  const runs = useEditor((s) => s.runs);
  const selectedId = useEditor((s) => s.openNodeId ?? s.nodes.find((n) => n.selected)?.id);
  return useMemo(
    () => ({
      nodes: nodes.map((n) => {
        const { id, name, type } = n.data.wf;
        const descriptor = nodeTypes[type]?.descriptor;
        const agent = Boolean(descriptor?.inputs.some((p) => p.type === 'ai_languageModel'));
        return {
          id,
          name,
          type,
          trigger: descriptor?.kind === 'trigger',
          agent,
          hasModel: agent && edges.some((e) => e.target === id && e.data?.connectionType === 'ai_languageModel'),
          // A tool, model or memory connects to its agent: not where the flow ends.
          outgoing: edges.some((e) => e.source === id),
          failed: latestMain(runs[id])?.status === 'error',
          x: n.position.x,
        };
      }),
      types: Object.values(nodeTypes)
        .filter((t) => t.available && !t.blocked)
        .map((t) => ({ type: t.type, displayName: t.descriptor.displayName, plugin: t.pluginId === 'core' ? 'Built in' : t.pluginName, trigger: t.descriptor.kind === 'trigger', keywords: t.descriptor.keywords ?? [] })),
      selectedId,
    }),
    [nodes, edges, nodeTypes, runs, selectedId],
  );
}

/** The top after-run fix for a node that just failed, once the assistant has one (see prefetchFailure), unless offered already. */
function useFailureFix(offered: Set<string>): { nodeName: string; suggestion: Suggestion } | undefined {
  const entries = useSuggestions((s) => s.entries);
  const runs = useEditor((s) => s.runs);
  const nodes = useEditor((s) => s.nodes);
  const workflowId = useEditor((s) => s.workflowId);
  return useMemo(() => {
    for (const node of nodes) {
      const run = runs[node.id]?.filter((r) => r.source === 'main').at(-1);
      if (run?.status !== 'error') continue;
      const entry = entries[suggestionKey(workflowId, node.id, run)];
      const suggestion = entry?.result?.suggestions.find((s) => s.ops.length && !entry.handled[s.id] && !offered.has(s.id));
      if (suggestion) return { nodeName: node.data.wf.name, suggestion };
    }
    return undefined;
  }, [entries, runs, nodes, workflowId, offered]);
}

export function Spotlight() {
  const open = useAssistant((s) => s.open);
  const hasItems = useAssistant((s) => s.items.length > 0);
  const pending = useAssistant((s) => s.pending || Boolean(s.testing));
  const drafting = useAssistant((s) => s.drafting);
  const working = useWorking();
  const detail = useAssistant((s) => s.detail);
  const waiting = useAssistant((s) => s.items.reduce((n, item) => n + (item.role === 'assistant' ? item.parts.filter((p) => p.kind === 'proposal' && !p.proposal.state).length : 0), 0));
  const empty = useEditor((s) => s.nodes.length === 0);
  const selectedName = useEditor((s) => {
    const id = s.openNodeId ?? s.nodes.find((n) => n.selected)?.id;
    return id ? s.nodes.find((n) => n.id === id)?.data.wf.name : undefined;
  });
  const ctx = useSpotlightContext();
  const [offered, setOffered] = useState<Set<string>>(() => new Set());
  const fix = useFailureFix(offered);
  const { build } = useBuildFlow();
  const [draft, setDraft] = useState('');
  const [caret, setCaret] = useState(0);
  const [focused, setFocused] = useState(false);
  const [active, setActive] = useState(-1);
  const [mentions, setMentions] = useState<Mention[]>([]);
  const [withoutSelection, setWithoutSelection] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const live = pending || drafting;
  // While Spotlight works on its own, the conversation waits in its card at the side (unless asked for).
  const showConversation = open && hasItems && (!working || detail);

  // A new selection is back in the context.
  useEffect(() => setWithoutSelection(false), [selectedName]);

  const bubbles = useMemo<Bubble[]>(() => {
    if (live) return [];
    if (draft.trim()) return focused ? completeBubbles(draft, caret, ctx) : [];
    if (showConversation || working) return [];
    const offer: Bubble[] = fix ? [{ id: `fix:${fix.suggestion.id}`, label: `Fix: ${fix.suggestion.title}`, kind: 'ask', text: '', caret: 0 }] : [];
    const idle = idleBubbles(ctx);
    // Unfocused, only what needs attention (a failure) or a start on an empty canvas.
    const quiet = focused || empty ? idle : idle.filter((b) => b.id.startsWith('why-'));
    return [...offer, ...quiet].slice(0, 3);
  }, [live, draft, caret, focused, ctx, showConversation, working, fix, empty]);

  useEffect(() => setActive(-1), [bubbles]);

  const resize = () => {
    const el = input.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  };
  useEffect(resize, [draft]);
  // Also when the box changes width (a side panel opens, the dock wraps): the wrapped placeholder counts in scrollHeight.
  useEffect(() => {
    const el = input.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    let width = el.clientWidth;
    const observer = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      resize();
    });
    observer.observe(el);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setText = (text: string, at = text.length) => {
    setDraft(text);
    setCaret(at);
    requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.setSelectionRange(at, at);
    });
  };

  const submit = async (text: string, extra: Mention[] = []) => {
    const message = text.trim();
    if (!message || live) return;
    const tagged = liveMentions(message, [...mentions, ...extra]);
    setDraft('');
    setCaret(0);
    setMentions([]);
    if (!useEditor.getState().nodes.length) {
      // An empty canvas: the builder drafts the whole flow in one go, with test data on the trigger.
      const reply: ChatItem = { id: nanoid(8), role: 'assistant', parts: [] };
      useAssistant.getState().append([{ id: nanoid(8), role: 'user', text: message }, reply]);
      const patch = (fields: Partial<Reply>) => useAssistant.setState((s) => ({ items: s.items.map((i) => (i.id === reply.id ? { ...(i as Reply), ...fields } : i)) }));
      useAssistant.setState({ drafting: true, detail: false });
      try {
        const flow = await build(message);
        const skipped = flow.dropped ? ` I left out ${flow.dropped} part${flow.dropped === 1 ? '' : 's'} that didn’t fit.` : '';
        const pinned = flow.pinned ? ' Test data is pinned on the trigger.' : '';
        patch({
          parts: [{ kind: 'text', text: `Built “${flow.name}” with ${flow.nodes} nodes.${skipped}${pinned} ⌘Z undoes it.` }, { kind: 'action', action: 'test', goal: message }],
          done: { model: flow.model, durationMs: flow.durationMs, steps: 1 },
        });
      } catch (e) {
        patch({ error: `Couldn’t build the flow: ${(e as Error).message}` });
      } finally {
        useAssistant.setState({ drafting: false });
      }
      return;
    }
    await useAssistant.getState().send(message, {
      withoutSelection,
      ...(tagged.length && {
        mentions: {
          nodes: tagged.flatMap((m) => (m.kind === 'node' ? [m.id] : [])),
          types: tagged.flatMap((m) => (m.kind === 'type' ? [m.type] : [])),
        },
      }),
    });
  };

  const choose = (bubble: Bubble) => {
    if (bubble.id === TEST_BUBBLE) {
      useAssistant.getState().append([{ id: nanoid(8), role: 'user', text: bubble.label }]);
      void testUntilItRuns(useEditor.getState().description?.trim() || undefined);
      return;
    }
    if (bubble.id.startsWith('fix:') && fix) {
      const { suggestion, nodeName } = fix;
      setOffered((o) => new Set(o).add(suggestion.id));
      useAssistant.getState().append([
        { id: nanoid(8), role: 'user', text: `Fix “${nodeName}”` },
        {
          id: nanoid(8),
          role: 'assistant',
          parts: [
            { kind: 'text', text: suggestion.detail },
            { kind: 'proposal', proposal: { id: suggestion.id, summary: suggestion.title, ops: suggestion.ops, dropped: suggestion.dropped ?? [], warnings: suggestion.warnings ?? [] } },
          ],
        },
      ]);
      return;
    }
    if (bubble.send) {
      void submit(bubble.text, bubble.mention ? [bubble.mention] : []);
      return;
    }
    if (bubble.mention) setMentions((m) => [...m, bubble.mention!]);
    setText(bubble.text, bubble.caret);
  };

  /** Keys Spotlight handles stay here; the rest (⌘S, ⌘↵) still reach the editor. */
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const handled = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    if (bubbles.length && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && !draft.includes('\n')) {
      handled();
      setActive((a) => (e.key === 'ArrowDown' ? (a + 1) % bubbles.length : (a - 1 + bubbles.length) % bubbles.length));
    } else if (e.key === 'Tab' && !e.shiftKey && bubbles.length && draft.trim()) {
      handled();
      choose(bubbles[Math.max(0, active)]);
    } else if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
      handled();
      if (active >= 0 && bubbles[active]) choose(bubbles[active]);
      else void submit(draft);
    } else if (e.key === 'Escape') {
      handled();
      if (showConversation) hideConversation(working);
      else if (draft) setText('');
      else input.current?.blur();
    }
  };

  const placeholder = drafting || pending ? 'Spotlight is working on the flow…' : empty ? 'Describe the workflow you want…' : 'Ask, or describe a change…  @ tags a node';

  return (
    <div className="pointer-events-auto relative min-w-[min(300px,100%)] max-w-[540px] flex-[1_1_300px]">
      <div className="pointer-events-none absolute inset-x-0 bottom-full mb-2 flex flex-col gap-2">
        {showConversation && <Conversation live={live} status={drafting ? 'Drafting the flow from the node catalog…' : undefined} />}
        {bubbles.length > 0 && (
          <div role="listbox" aria-label="Suggestions" className="flex flex-wrap justify-center gap-1.5">
            {bubbles.map((b, i) => (
              <button
                key={b.id}
                role="option"
                aria-selected={i === active}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(b)}
                style={{ animationDelay: `${i * 40}ms` }}
                className={cn(
                  'pointer-events-auto flex max-w-full animate-fade-up items-center gap-1.5 rounded-full border bg-sf/95 px-3 py-1 text-[12.5px] text-t1 shadow-[0_6px_18px_rgba(0,0,0,0.08)] backdrop-blur transition-colors hover:border-acbd',
                  i === active ? 'border-ac' : 'border-hair',
                )}
              >
                {b.kind === 'ask' && <Sparkles className="size-3 shrink-0 text-viz-7" />}
                <span className="truncate">{b.label}</span>
                {b.hint && <span className="shrink-0 text-[11px] text-t3">{b.hint}</span>}
              </button>
            ))}
          </div>
        )}
      </div>

      <div
        className={cn(
          'flex items-end gap-2 rounded-2xl border bg-sf/95 px-2.5 py-1.5 shadow-pop backdrop-blur transition-colors',
          focused ? 'border-[color-mix(in_oklab,var(--viz-7)_45%,var(--bd))]' : 'border-hair',
        )}
      >
        <Sparkles className="mb-[9px] size-4 shrink-0 text-viz-7" />
        {selectedName && !withoutSelection && !empty && (
          <span className="mb-[5px] flex max-w-[150px] shrink-0 items-center gap-0.5 rounded-md border border-hair bg-wl py-0.5 pl-1.5 pr-0.5 text-[11.5px] text-t2" title="The selected node is part of what Spotlight sees">
            <span className="truncate">{selectedName}</span>
            <button onMouseDown={(e) => e.preventDefault()} onClick={() => setWithoutSelection(true)} aria-label={`Leave ${selectedName} out`} className="grid size-4 place-items-center rounded text-t3 hover:text-t1">
              <X className="size-3" />
            </button>
          </span>
        )}
        <textarea
          id={INPUT_ID}
          ref={input}
          rows={1}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setCaret(e.target.selectionStart);
          }}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          aria-label="Ask Spotlight"
          aria-autocomplete="list"
          className="max-h-[120px] min-h-[32px] min-w-0 flex-1 resize-none bg-transparent py-1.5 text-[13.5px] leading-5 text-t1 outline-none placeholder:text-t3"
        />
        {hasItems && !showConversation && (
          <button
            onClick={() => useAssistant.setState({ open: true, ...(working && { detail: true }) })}
            title="Show the conversation"
            aria-label="Show the conversation"
            className="mb-[3px] flex h-7 shrink-0 items-center gap-1 rounded-full px-2 text-[12px] text-t2 hover:bg-acdim hover:text-t1"
          >
            <MessageSquare className="size-3.5" />
            {waiting > 0 && <span className="rounded-full bg-viz-7 px-1.5 text-[10.5px] font-semibold leading-4 text-bg">{waiting}</span>}
          </button>
        )}
        {!focused && !draft && !hasItems && <kbd className="mb-[9px] shrink-0 rounded border border-hair px-1 font-mono text-[10.5px] text-t3">⌘I</kbd>}
        {live ? (
          <button
            onClick={() => useAssistant.getState().stop()}
            disabled={drafting}
            aria-label="Stop"
            title="Stop"
            className="mb-[2px] grid size-8 shrink-0 place-items-center rounded-full border border-bd text-t2 transition-colors hover:border-rd hover:text-rd disabled:opacity-50"
          >
            {drafting ? <Loader2 className="size-3.5 animate-spin" /> : <Square className="size-3" fill="currentColor" />}
          </button>
        ) : (
          <button
            onClick={() => void submit(draft)}
            disabled={!draft.trim()}
            aria-label="Send"
            className="mb-[2px] grid size-8 shrink-0 place-items-center rounded-full bg-ac2 text-on-ac transition-all hover:scale-105 disabled:opacity-30 disabled:hover:scale-100"
          >
            <ArrowUp className="size-4" />
          </button>
        )}
      </div>
    </div>
  );
}
