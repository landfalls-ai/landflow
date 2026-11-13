'use client';
/**
 * Spotlight in the editor (docs/assistant.md#the-spotlight-panel): one panel at the right of the canvas, beside it rather
 * than over it, that builds and fixes the workflow with the assistant. It never moves: no draft, reply or test session
 * opens, closes or shifts it; only the person folds it (to a thin strip, or on a phone to a sheet's peek). Its header says
 * what Spotlight is doing; its timeline shows every turn: what was asked, each change (as a row once applied in autonomous
 * mode), each test run and fix, each agent the Agent architect designs, and how it ended; its input sits at the bottom,
 * with bubbles that suggest what to ask and complete what is typed (`@` a node on the canvas, a node type).
 * On an empty canvas the first message drafts the whole flow. "Test and fix" (./test-session.ts) runs the workflow, has
 * failures fixed until a run passes, then offers to publish it.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useReactFlow } from '@xyflow/react';
import { ArrowUp, Bot, Check, ChevronDown, ChevronRight, CircleCheck, CircleStop, CircleX, ExternalLink, Hand, Loader2, Mic, PanelRightClose, PanelRightOpen, Play, Rocket, Sparkles, Square, SquarePen, Undo2, Wrench, X, Zap } from 'lucide-react';
import { nanoid } from 'nanoid';
import { cn } from '@/lib/utils';
import { opsTitle } from '@/lib/shared/assistant-ops';
import { completeBubbles, idleBubbles, liveMentions, TEST_BUBBLE, type Bubble, type Mention, type SpotlightContext } from '@/lib/shared/spotlight';
import { Button } from '../ui/button';
import { useBuildFlow } from './ai-builder';
import { afterReply, testDraft, useAutonomous } from './autonomous';
import { LiveSteps, useLive } from './building';
import { applyChanges, draft as draftCall, sendFeedback, suggestionKey, undos, useAssistant, useSuggestions, useWorking, type AgentProgress, type ChatItem, type Need, type Outcome, type Proposal, type ReplyAction, type Suggestion, type TestRun } from './assistant';
import { useEditor } from './store';
import { isPhone, usePhone } from '@/lib/client/use-phone';
import { dictationSupported, useDictation } from './use-dictation';
import { LeftOut, OpsDiff, Warnings } from './suggestions-card';
import { MAX_FIXES, productionNote, publishToProduction, sendsAllowed, testUntilItRuns } from './test-session';
import { agentStep, firstSentence, foldLine, lastOutcomeOf, lastRunOf, openNeedOf, runRow, sessionFold, stepsOf, stoppedAtOf, titleOf } from './timeline';

const INPUT_ID = 'spotlight-input';

/** ⌘I and the empty canvas's hint: unfold the panel and put the caret in Spotlight. */
export function focusSpotlight() {
  useAssistant.getState().setCollapsed(false);
  requestAnimationFrame(() => document.getElementById(INPUT_ID)?.focus());
}

type Reply = Extract<ChatItem, { role: 'assistant' }>;

/** Open the node a run failed at, by name. */
function openNodeNamed(name: string) {
  const node = useEditor.getState().nodes.find((n) => n.data.wf.name === name);
  if (node) useEditor.getState().openNode(node.id);
}

/** A change waiting for Apply (autonomous mode off). */
function ProposalCard({ itemId, proposal }: { itemId: string; proposal: Proposal }) {
  const decide = (state: 'applied' | 'dismissed') => useAssistant.getState().setProposalState(itemId, proposal.id, state);
  return (
    <div className={cn('animate-fade-up space-y-2 rounded-xl border bg-sf p-2.5', proposal.state === 'applied' ? 'border-gnbd' : 'border-acbd')}>
      <div className="text-[13px] font-semibold leading-snug text-t1">{proposal.summary}</div>
      <OpsDiff ops={proposal.ops} />
      <Warnings warnings={proposal.warnings} />
      <LeftOut reasons={proposal.dropped} />
      <div className="flex items-center gap-1.5">
        {proposal.state === 'applied' ? (
          <span className="flex animate-pop items-center gap-1 text-[12px] font-semibold text-gn">
            <Check className="size-3.5" /> Applied
          </span>
        ) : proposal.state === 'dismissed' ? (
          <span className="text-[12px] text-t3">Dismissed</span>
        ) : (
          <>
            <Button size="sm" variant="primary" onClick={() => applyChanges([{ ops: proposal.ops, kind: 'proposal' }], proposal.summary) && decide('applied')}>
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

/**
 * A change as a row of the timeline: applied by Spotlight (autonomous mode, a fix). Its title says what it did, read from
 * its ops; the model's words and the diff open on a click. The latest one has Undo (a phone has no ⌘Z).
 */
function ProposalRow({ itemId, proposal, fix }: { itemId: string; proposal: Proposal; fix: boolean }) {
  const [open, setOpen] = useState(false);
  // Re-read on each render: the newest undo is the only one that is safe to use.
  const latest = useAssistant((s) => s.items.length) >= 0 && [...undos.keys()].at(-1) === proposal.id;
  const verb = proposal.state === 'applied' ? (fix ? 'Fixed' : 'Done') : proposal.state === 'dismissed' ? 'Not applied' : proposal.state === 'undone' ? 'Undone' : 'Applying';
  const undo = () => {
    undos.get(proposal.id)?.();
    undos.delete(proposal.id);
    useAssistant.getState().setProposalState(itemId, proposal.id, 'undone');
  };
  return (
    <div className="animate-in">
      <div className="flex items-start gap-1">
        <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex min-h-7 min-w-0 flex-1 items-start gap-1.5 rounded-md py-0.5 text-left text-[12.5px] leading-snug hover:bg-acdim">
          {proposal.state === 'applied' ? (
            <Wrench className="mt-px size-3.5 shrink-0 text-viz-7" />
          ) : proposal.state ? (
            <Undo2 className="mt-px size-3.5 shrink-0 text-t3" />
          ) : (
            <Loader2 className="mt-px size-3.5 shrink-0 animate-spin text-t3" />
          )}
          <span className={cn('min-w-0 flex-1 [overflow-wrap:anywhere]', proposal.state === 'undone' && 'line-through decoration-t3')}>
            <span className="font-semibold text-t1">{verb}</span>
            <span className="text-t2"> · {opsTitle(proposal.ops)}</span>
            {proposal.skipped ? <span className="text-warn"> ({proposal.skipped} part{proposal.skipped === 1 ? '' : 's'} skipped)</span> : null}
          </span>
          <ChevronRight className={cn('mt-px size-3.5 shrink-0 text-t3 transition-transform', open && 'rotate-90')} />
        </button>
        {proposal.state === 'applied' && latest && (
          <button type="button" onClick={undo} className="min-h-7 shrink-0 rounded-full px-2 text-[11.5px] font-semibold text-ac hover:bg-acdim max-md:min-h-11 max-md:px-3">
            Undo
          </button>
        )}
      </div>
      {open && (
        <div className="mt-1.5 space-y-1.5 pl-5">
          <p className="text-[12px] leading-snug text-t2">{proposal.summary}</p>
          <OpsDiff ops={proposal.ops} />
          <Warnings warnings={proposal.warnings} />
          {proposal.dropped.length > 0 && <p className="text-[11px] text-t3">Left out: {proposal.dropped.join('; ')}</p>}
        </div>
      )}
    </div>
  );
}

/**
 * Something only the person can do (docs/assistant.md#test-and-fix): what it is, the button that does it, and one that
 * tests on. Picking a credential or an agent opens the node; a trigger is one op; sending for real is a yes.
 */
function NeedRow({ itemId, need }: { itemId: string; need: Need }) {
  const busy = useAssistant((s) => s.pending || Boolean(s.testing));
  const mark = (state: 'done' | 'dismissed') => useAssistant.getState().updateParts(itemId, (parts) => parts.map((p) => (p.kind === 'needs' ? { ...p, need: { ...p.need, state } } : p)));
  const goOn = () => {
    mark('done');
    void testUntilItRuns(need.goal);
  };
  const primary =
    need.what === 'sends'
      ? { label: 'Run it for real', act: () => (sendsAllowed.add(useEditor.getState().workflowId), goOn()) }
      : need.what === 'trigger'
        ? { label: 'Add a manual trigger', act: () => applyChanges([{ ops: [{ op: 'addNode', type: 'core.manualTrigger', name: 'Start', ...(firstStep() && { before: firstStep() }) }], kind: 'proposal' }], 'Added a manual trigger', { quiet: true }) && goOn() }
        : { label: need.what === 'credential' ? 'Pick the credential' : `Pick ${need.what === 'agent' ? 'an agent' : 'it'}`, act: () => need.node && openNodeNamed(need.node) };
  return (
    <div role="group" aria-label="Needs you" className="animate-fade-up space-y-2 rounded-xl border border-warnbd bg-sf p-2.5">
      <div className="flex items-start gap-1.5 text-[12.5px] leading-snug">
        <Hand className="mt-px size-3.5 shrink-0 text-warn" />
        <span className="min-w-0 [overflow-wrap:anywhere]">
          <span className="font-semibold text-t1">Needs you · </span>
          <span className="text-t2">{need.text}</span>
        </span>
      </div>
      {need.state ? (
        <p className="pl-5 text-[11.5px] text-t3">
          {need.state === 'dismissed' ? 'Left for later.' : need.what === 'sends' ? 'You said yes: tests of this workflow run for real.' : need.what === 'trigger' ? 'Trigger added.' : 'Testing again.'}
        </p>
      ) : (
        <div className="flex flex-wrap gap-1.5 pl-5">
          <Button size="sm" variant="primary" disabled={busy} onClick={primary.act}>
            {primary.label}
          </Button>
          {need.what === 'sends' ? (
            <Button size="sm" variant="ghost" onClick={() => mark('dismissed')}>
              Not now
            </Button>
          ) : (
            <Button size="sm" variant="ghost" disabled={busy} onClick={goOn}>
              Test again
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * How a session that didn't pass ended: why, in one line, then what to do next. **Undo all fixes** puts the flow back as
 * it was before the session (the oldest fix's undo restores the graph from before it).
 */
function OutcomeCard({ itemId, outcome }: { itemId: string; outcome: Outcome }) {
  const busy = useAssistant((s) => s.pending || Boolean(s.testing));
  // Select the items, then filter: a selector that builds a new array each time re-renders forever.
  const items = useAssistant((s) => s.items);
  const applied = outcome.fixes.filter((f) => items.some((i) => i.id === f.item && i.role === 'assistant' && i.parts.some((p) => p.kind === 'proposal' && p.proposal.id === f.proposal && p.proposal.state === 'applied')));
  // Only while nothing changed since it stopped: no edit, undo or later Spotlight change. Restoring the graph from before
  // the session would take those with it, and leave a later change's own Undo pointing at a graph that is gone.
  const untouched = useEditor((s) => s.edits) === outcome.edits;
  const newest = useAssistant((s) => s.items.length) >= 0 && outcome.fixes.some((f) => f.proposal === [...undos.keys()].at(-1));
  const canUndo = applied.length > 0 && untouched && newest;
  const undoAll = () => {
    const first = applied[0];
    if (!first) return;
    undos.get(first.proposal)?.();
    for (const f of applied) {
      undos.delete(f.proposal);
      useAssistant.getState().setProposalState(f.item, f.proposal, 'undone');
    }
    useAssistant.getState().updateParts(itemId, (parts) => parts.map((p) => (p.kind === 'outcome' ? { ...p, outcome: { ...p.outcome, state: 'undone' as const } } : p)));
  };
  return (
    <div role="group" aria-label="Stopped" className="animate-fade-up space-y-2 rounded-xl border border-hair bg-sf p-2.5">
      <div className="flex items-start gap-1.5 text-[12.5px] leading-snug">
        <CircleStop className="mt-px size-3.5 shrink-0 text-t2" />
        <span className="min-w-0 [overflow-wrap:anywhere]">
          <span className="font-semibold text-t1">Stopped · </span>
          <span className="text-t2">{outcome.text}</span>
        </span>
      </div>
      {outcome.state === 'undone' && <p className="pl-5 text-[11.5px] text-t3">The flow is back as it was before the test.</p>}
      <div className="flex flex-wrap gap-1.5 pl-5">
        {outcome.node && (
          <Button size="sm" variant="primary" onClick={() => openNodeNamed(outcome.node!)}>
            Open “{outcome.node}”
          </Button>
        )}
        {canUndo && (
          <Button size="sm" variant="ghost" disabled={busy} title="Puts the flow back as it was before this test." onClick={undoAll}>
            Undo {applied.length === 1 ? 'the fix' : `all ${applied.length} fixes`}
          </Button>
        )}
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void testUntilItRuns(outcome.goal)}>
          Try again
        </Button>
      </div>
    </div>
  );
}

/** The first step after the trigger slot: where a new manual trigger goes in front of. */
function firstStep(): string | undefined {
  const { nodes, edges } = useEditor.getState();
  return nodes.find((n) => !edges.some((e) => e.target === n.id && (e.data?.connectionType ?? 'main') === 'main') && !edges.some((e) => e.source === n.id && (e.data?.connectionType ?? 'main') !== 'main'))?.data.wf.name;
}

/** One run of a test-and-fix session; a failed one opens the node it failed at. */
function RunLine({ run }: { run: TestRun }) {
  const row = runRow(run);
  const at = row.node;
  // The row keeps the error's first clause; the rest (often what to do) opens below, for touch and keyboard too.
  const full = (run.summary ?? '').replace(/^failed at “[^”]+”:?\s*/, '');
  const cut = run.state === 'failed' && full.length > row.reason.length + 1;
  const [more, setMore] = useState(false);
  const body = (
    <>
      {run.state === 'running' ? (
        <Loader2 className="mt-px size-3.5 shrink-0 animate-spin text-t3" />
      ) : run.state === 'passed' ? (
        <CircleCheck className="mt-px size-3.5 shrink-0 text-gn" />
      ) : (
        <CircleX className="mt-px size-3.5 shrink-0 text-rd" />
      )}
      <span className="min-w-0 [overflow-wrap:anywhere]">
        <span className="font-semibold text-t1">Run {run.round}</span>
        {row.node && <span className="text-t1"> · “{row.node}”</span>}
        <span className="text-t2"> · {row.reason}</span>
      </span>
    </>
  );
  const line = at ? (
    <button type="button" onClick={() => openNodeNamed(at)} title={`${run.summary}. Open “${at}”`} className="flex min-w-0 flex-1 items-start gap-1.5 rounded-md text-left text-[12.5px] leading-snug hover:bg-acdim">
      {body}
    </button>
  ) : (
    <div title={run.summary} className="flex min-w-0 flex-1 items-start gap-1.5 text-[12.5px] leading-snug">
      {body}
    </div>
  );
  return (
    <div>
      <div className="flex items-start gap-1">
        {line}
        {cut && (
          <button type="button" aria-expanded={more} aria-label={more ? 'Less' : 'The whole error'} onClick={() => setMore((m) => !m)} className="min-h-6 shrink-0 rounded-full px-1.5 text-[11.5px] font-semibold text-ac hover:bg-acdim max-md:min-h-11 max-md:px-2.5">
            {more ? 'Show less' : 'Show more'}
          </button>
        )}
      </div>
      {more && <p className="mt-1 pl-5 text-[12px] leading-snug text-t2 [overflow-wrap:anywhere]">{full}</p>}
    </div>
  );
}

/** An agent the Agent architect designs for a step: designing, then what it runs on, with its page. */
function AgentRow({ agent }: { agent: AgentProgress }) {
  const step = agentStep(agent);
  return (
    <div className="flex animate-in items-start gap-1.5 text-[12.5px] leading-snug">
      {agent.state === 'designing' ? <Loader2 className="mt-px size-3.5 shrink-0 animate-spin text-viz-7" /> : agent.state === 'failed' ? <CircleX className="mt-px size-3.5 shrink-0 text-rd" /> : <Bot className="mt-px size-3.5 shrink-0 text-viz-7" />}
      <span className="min-w-0 flex-1 text-t2 [overflow-wrap:anywhere]">{step.text}</span>
      {agent.agentId && (
        <a href={`/agents/${agent.agentId}`} target="_blank" rel="noopener" className="flex shrink-0 items-center gap-0.5 text-[11.5px] font-semibold text-ac hover:underline">
          Open <ExternalLink className="size-3" />
        </a>
      )}
    </div>
  );
}

/** Autonomous mode's switch: on, Spotlight applies its changes and tests and fixes the flow without waiting for a click. */
function AutonomousSwitch({ compact }: { compact?: boolean }) {
  const { on, set } = useAutonomous();
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label="Autonomous"
      title={on ? 'Autonomous: Spotlight applies its changes and tests and fixes the flow by itself. Click to ask first.' : 'Asks before applying and testing. Click to let Spotlight do it by itself.'}
      onClick={() => set(!on)}
      className={cn(
        'flex h-7 shrink-0 items-center gap-1 rounded-full border px-2 text-[11.5px] font-semibold transition-colors max-md:h-11 max-md:px-3',
        on ? 'border-transparent bg-ac2 text-on-ac hover:bg-ac2-hover' : 'border-bd text-t2 hover:text-t1',
      )}
    >
      <Zap className="size-3" fill={on ? 'currentColor' : 'none'} /> <span className={cn('max-md:sr-only', compact && 'sr-only')}>Autonomous</span>
    </button>
  );
}

/** "Test and fix" after a drafted flow (autonomous mode starts it by itself); "Ready for production" after a run passed. */
function ActionView({ itemId, action }: { itemId: string; action: ReplyAction }) {
  const busy = useAssistant((s) => s.pending || Boolean(s.testing));
  const [publishing, setPublishing] = useState(false);
  const mark = (state: 'done' | 'dismissed') => useAssistant.getState().updateParts(itemId, (parts) => parts.map((p) => (p.kind === 'action' && p.action === action.action ? { ...p, state } : p)));
  if (action.action === 'test') {
    // Started (by a click or by autonomous mode): the runs that follow say how it goes.
    if (action.state) return null;
    return (
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Button
          size="sm"
          variant="primary"
          disabled={busy}
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

/** A reply's text: in full in a conversation; within a test-and-fix session, its first sentence, the rest on "more". */
function ReplyText({ text, short }: { text: string; short: boolean }) {
  const [more, setMore] = useState(false);
  const first = firstSentence(text);
  const cut = short && !more && first.length < text.trim().length;
  return (
    <div className="whitespace-pre-wrap text-[13px] leading-relaxed text-t1 [overflow-wrap:anywhere]">
      {cut ? first : text}
      {cut && (
        <button type="button" onClick={() => setMore(true)} className="ml-1 text-[12px] font-semibold text-ac hover:underline max-md:min-h-11 max-md:px-1">
          Show more
        </button>
      )}
    </div>
  );
}

/** A reply: its text, its changes, its runs and buttons. While it streams, its steps (new look) or one line of what it is doing. */
function ReplyView({ item, live, status }: { item: Reply; live: boolean; status?: string }) {
  const autonomous = useAutonomous((s) => s.on);
  const spotlightBusy = useAssistant((s) => s.pending || Boolean(s.testing));
  const building = useLive();
  const pending = item.parts.flatMap((p) => (p.kind === 'proposal' && !p.proposal.state ? [p.proposal] : []));
  const lastTool = item.parts.findLast((p) => p.kind === 'tool');
  const applyAll = () => {
    if (!applyChanges(pending.map((p) => ({ ops: p.ops, kind: 'proposal' as const })), `Applied ${pending.length} changes`)) return;
    for (const p of pending) useAssistant.getState().setProposalState(item.id, p.id, 'applied');
  };
  const meta = item.done && `${item.done.model} · ${(item.done.durationMs / 1000).toFixed(1)} s · ${item.done.steps} step${item.done.steps === 1 ? '' : 's'}`;
  const steps = building?.replyId === item.id ? building : undefined;
  // A test run shows its own progress; a change being built shows its steps.
  const working = live && !steps && !item.parts.some((p) => p.kind === 'run' || p.kind === 'action');
  // Rows, not cards: Spotlight applied them itself (a session's fix, autonomous mode), or is about to (autonomous mode on
  // while the reply still has changes to apply). A turn applied by hand stays a card when the switch flips later.
  const asRows = Boolean(item.testId || item.auto) || (autonomous && (live || spotlightBusy) && pending.length > 0);
  // Within a session, the reply's texts are one: its first sentence, the rest on "Show more".
  // Autonomous replies that changed the flow too: the rows say what was done.
  const session = Boolean(item.testId) || (Boolean(item.auto) && !live && item.parts.some((p) => p.kind === 'proposal'));
  // A session's fix: its row says what it did and opens on the model's words; the prose would say it twice.
  const quietText = Boolean(item.testId) && !live && item.parts.some((p) => p.kind === 'proposal' && p.proposal.state);
  const sessionText = session ? item.parts.flatMap((p) => (p.kind === 'text' ? [p.text] : [])).join('\n\n') : '';
  const firstText = item.parts.findIndex((p) => p.kind === 'text');
  const firstProposal = item.parts.findIndex((p) => p.kind === 'proposal');
  return (
    <div className="flex animate-in gap-2" title={meta || undefined}>
      <span className="mt-0.5 grid size-5 shrink-0 place-items-center text-viz-7">{working ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}</span>
      <div className="min-w-0 flex-1 space-y-2">
        {item.parts.map((part, i) =>
          part.kind === 'text' ? (
            quietText ? null : session ? (
              i === firstText && <ReplyText key={i} text={sessionText} short />
            ) : (
              <ReplyText key={i} text={part.text} short={false} />
            )
          ) : part.kind === 'proposal' ? (
            steps ? (
              i === firstProposal && <LiveSteps key="steps" live={steps} />
            ) : asRows && (part.proposal.state || live || spotlightBusy) ? (
              <ProposalRow key={part.proposal.id} itemId={item.id} proposal={part.proposal} fix={Boolean(item.testId)} />
            ) : (
              // Not applied by Spotlight (a stopped reply, a change that no longer fits, a Fix bubble): the person decides.
              <ProposalCard key={part.proposal.id} itemId={item.id} proposal={part.proposal} />
            )
          ) : part.kind === 'run' ? (
            <RunLine key={i} run={part.run} />
          ) : part.kind === 'action' ? (
            <ActionView key={i} itemId={item.id} action={part} />
          ) : part.kind === 'needs' ? (
            <NeedRow key={i} itemId={item.id} need={part.need} />
          ) : part.kind === 'outcome' ? (
            <OutcomeCard key={i} itemId={item.id} outcome={part.outcome} />
          ) : null,
        )}
        {steps && firstProposal < 0 && <LiveSteps live={steps} />}
        {working && <div className="animate-pulse-soft truncate text-[12px] text-t3">{status ?? (lastTool?.kind === 'tool' ? `${lastTool.tool.label}…` : 'Thinking…')}</div>}
        {item.error && <div className="rounded-[10px] border border-rdbd bg-rddim px-2.5 py-2 text-[12px] text-rd [overflow-wrap:anywhere]">{item.error}</div>}
        {!live && !asRows && pending.length > 1 && (
          <Button size="sm" variant="outline" onClick={applyAll}>
            <Check className="size-3.5" /> Apply all ({pending.length})
          </Button>
        )}
      </div>
    </div>
  );
}

/** Every turn, in order, with the agents designed after the turn that created them. */
function Timeline({ live, status }: { live: boolean; status?: string }) {
  const items = useAssistant((s) => s.items);
  const agents = useAssistant((s) => s.agents);
  const scroller = useRef<HTMLDivElement>(null);
  const atEnd = useRef(true);
  const lastRole = items.at(-1)?.role;
  useEffect(() => {
    const el = scroller.current;
    // Reading further up: stay there, unless the person just sent something.
    if (el && (atEnd.current || lastRole === 'user')) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [items, agents, lastRole]);
  // Sizes change without new items: the bubbles row appears under it, the phone's dock changes height, a card grows.
  useEffect(() => {
    const el = scroller.current;
    const content = el?.firstElementChild;
    if (!el || !content) return;
    const follow = new ResizeObserver(() => {
      if (atEnd.current) el.scrollTop = el.scrollHeight;
    });
    follow.observe(el);
    follow.observe(content);
    return () => follow.disconnect();
  }, []);
  const lastId = items.at(-1)?.id;
  const placed = new Set(items.map((i) => i.id));
  // A finished session folds to one line; the person opens it. The one running stays open.
  const runningTest = useAssistant((s) => s.testingId);
  const [opened, setOpened] = useState<Set<string>>(new Set());
  const folds = new Map<string, ReturnType<typeof sessionFold>>();
  for (const item of items) if (item.testId && !folds.has(item.testId)) folds.set(item.testId, sessionFold(items, item.testId, item.testId === runningTest));
  const folded = (item: ChatItem) => Boolean(item.testId && folds.get(item.testId) && !opened.has(item.testId));
  const firstOf = new Set([...folds.keys()].map((id) => items.find((i) => i.testId === id)?.id));
  return (
    <div
      ref={scroller}
      onScroll={(e) => {
        const el = e.currentTarget;
        atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}
      className="min-h-0 flex-1 overflow-y-auto px-3 py-3"
    >
      <div className="space-y-3">
      {/* A test-and-fix session's own requests ("Test run 2 failed at …") say what its run row says: left out. */}
      {items.map((item) => (
        <div key={item.id} className={cn('space-y-3', ((item.role === 'user' && item.auto && !agents.some((a) => a.after === item.id)) || (folded(item) && !firstOf.has(item.id))) && 'hidden')}>
          {item.testId && firstOf.has(item.id) && folds.get(item.testId) && (
            <button
              type="button"
              aria-expanded={!folded(item)}
              onClick={() => setOpened((o) => { const next = new Set(o); if (next.has(item.testId!)) next.delete(item.testId!); else next.add(item.testId!); return next; })}
              className="flex min-h-7 w-full items-center gap-1.5 rounded-md text-left text-[12.5px] leading-snug text-t2 hover:bg-acdim"
            >
              {folds.get(item.testId)!.state === 'passed' ? <CircleCheck className="size-3.5 shrink-0 text-gn" /> : <CircleStop className="size-3.5 shrink-0 text-t3" />}
              <span className="min-w-0 flex-1 truncate">{foldLine(folds.get(item.testId)!)}</span>
              <ChevronRight className={cn('size-3.5 shrink-0 text-t3 transition-transform', !folded(item) && 'rotate-90')} />
            </button>
          )}
          {folded(item) ? null : item.role === 'user' && item.auto ? null : item.role === 'user' ? (
            <div className="ml-auto w-fit max-w-[90%] animate-in whitespace-pre-wrap rounded-xl bg-ac2 px-3 py-1.5 text-[13px] leading-relaxed text-on-ac [overflow-wrap:anywhere]">{item.text}</div>
          ) : (
            <ReplyView item={item} live={live && item.id === lastId} status={status} />
          )}
          {agents
            .filter((a) => a.after === item.id)
            .map((a) => (
              <AgentRow key={a.nodeId} agent={a} />
            ))}
        </div>
      ))}
      {agents
        .filter((a) => !a.after || !placed.has(a.after))
        .map((a) => (
          <AgentRow key={a.nodeId} agent={a} />
        ))}
      </div>
    </div>
  );
}

/**
 * While Spotlight works, the canvas keeps the whole flow in view as the panel and the logs change its size; once it is on
 * one node (fixing it, or it needs the person there), the camera goes to that node at a zoom you can read instead.
 */
function useFlowInView(working: boolean, focus: string | undefined) {
  const { fitView, setCenter, getZoom, getViewport } = useReactFlow();
  const nodeCount = useEditor((s) => s.nodes.length);
  const [size, setSize] = useState('');
  const moved = useRef(false);
  useEffect(() => {
    const pane = document.querySelector('.react-flow');
    if (!working || !pane || typeof ResizeObserver === 'undefined') return;
    moved.current = false;
    const observer = new ResizeObserver(() => setSize(`${pane.clientWidth}x${pane.clientHeight}`));
    observer.observe(pane);
    // The person zooms or pans: the view is theirs until Spotlight starts again.
    const mine = () => (moved.current = true);
    pane.addEventListener('wheel', mine, { passive: true });
    pane.addEventListener('pointerdown', mine);
    return () => {
      observer.disconnect();
      pane.removeEventListener('wheel', mine);
      pane.removeEventListener('pointerdown', mine);
    };
  }, [working]);
  // On a node: pan there, at least at a readable zoom. A node out of the flow's fit is the point of it.
  useEffect(() => {
    if (!focus || moved.current) return;
    const node = useEditor.getState().nodes.find((n) => n.data.wf.name === focus);
    if (!node) return;
    const timer = setTimeout(() => {
      if (moved.current) return;
      const pane = document.querySelector('.react-flow');
      const width = node.measured?.width ?? 200;
      const height = node.measured?.height ?? 80;
      const narrow = (pane?.clientWidth ?? 1000) < 600;
      // A desktop shows the whole flow readably at fit: move only when the node is out of the clear part of the canvas
      // (not under the zoom rail, the toolbar and minimap, or the Execute bar) or too small to read, and then pan rather
      // than zoom when the zoom is readable already.
      const zoom = getZoom();
      if (!narrow && pane) {
        const { x, y } = getViewport();
        const left = node.position.x * zoom + x;
        const top = node.position.y * zoom + y;
        const clear = { left: 72, top: 48, right: pane.clientWidth - 300, bottom: pane.clientHeight - 120 };
        if (zoom >= 0.75 && left >= clear.left && top >= clear.top && left + width * zoom <= clear.right && top + height * zoom <= clear.bottom) return;
      }
      void setCenter(node.position.x + width / 2, node.position.y + height / 2, { zoom: narrow ? Math.max(zoom, 0.85) : zoom >= 0.75 ? zoom : 1, duration: 500 });
    }, 200);
    return () => clearTimeout(timer);
  }, [focus, size, setCenter, getZoom, getViewport]);
  useEffect(() => {
    if (!working || !nodeCount || moved.current || focus) return;
    const timer = setTimeout(() => {
      const narrow = (document.querySelector('.react-flow')?.clientWidth ?? 1000) < 600;
      void fitView({ padding: narrow ? { left: '16px', top: '16px', bottom: '72px', right: '64px' } : { left: '72px', top: '56px', bottom: '120px', right: '72px' }, duration: 500, maxZoom: 1 });
    }, 160);
    return () => clearTimeout(timer);
  }, [working, nodeCount, size, fitView, focus]);
}

/** Whole seconds since `on` turned true; 0 while off. */
function useSeconds(on: boolean): number {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    setSeconds(0);
    if (!on) return;
    const started = Date.now();
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [on]);
  return seconds;
}


/**
 * The Spotlight panel, at the right of the editor. Desktop: a column beside the canvas (and its logs), folded to a thin
 * strip. Phone: a sheet under the canvas (which shrinks above it), folded to its header, a line and the input.
 */
export function SpotlightPanel({ hiddenOnPhone = false }: { hiddenOnPhone?: boolean }) {
  const collapsed = useAssistant((s) => s.collapsed);
  const items = useAssistant((s) => s.items);
  const agents = useAssistant((s) => s.agents);
  const drafting = useAssistant((s) => s.drafting);
  const testing = useAssistant((s) => Boolean(s.testing));
  const pending = useAssistant((s) => s.pending);
  const fixing = useAssistant((s) => s.fixing);
  const fixingName = useEditor((s) => (fixing ? s.nodes.find((n) => n.id === fixing)?.data.wf.name : undefined));
  const waiting = items.reduce((n, item) => n + (item.role === 'assistant' ? item.parts.filter((p) => p.kind === 'proposal' && !p.proposal.state).length : 0), 0);
  const designing = agents.find((a) => a.state === 'designing')?.name;
  const live = pending || drafting;
  const busy = live || testing || Boolean(designing);
  // How the last test ended, since the person last asked for something: older verdicts no longer hold.
  const run = lastRunOf(items.slice(items.findLastIndex((i) => i.role === 'user' && !i.auto) + 1));
  const need = openNeedOf(items);
  const ended = lastOutcomeOf(items);
  const title = titleOf({
    drafting,
    testing,
    pending,
    fixingName,
    designing,
    hasItems: items.length > 0,
    ...(need && !testing && { needs: need.what }),
    ...(run && run.state !== 'running' && !testing && { lastRun: run.state, stoppedAt: stoppedAtOf(run) }),
    // A pass the review said no to stopped, whatever the last run said.
    ...(ended && !testing && { lastRun: 'failed' as const, stoppedAt: ended.node }),
  });
  const { steps } = stepsOf(items, { live, drafting, agents });
  const latest = steps.at(-1)?.text;
  // The node Spotlight is on: the one it fixes, or the one it needs the person at.
  // An open need is where Spotlight waits only while it is idle: a new session fits the flow again.
  useFlowInView(drafting || testing, fixingName ?? (testing || drafting ? undefined : need?.node));

  const panel = useRef<HTMLElement>(null);

  // Toasts (bottom right) keep clear of the panel: left of the column, above the phone sheet.
  useEffect(() => {
    const el = panel.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const body = document.body.style;
    const phone = window.matchMedia('(max-width: 767px)');
    const update = () => {
      body.setProperty('--toast-right', phone.matches ? '16px' : `${el.offsetWidth + 16}px`);
      body.setProperty('--toast-bottom', phone.matches ? `${el.offsetHeight + 12}px` : '24px');
    };
    const observer = new ResizeObserver(update);
    observer.observe(el);
    update();
    return () => {
      observer.disconnect();
      body.removeProperty('--toast-right');
      body.removeProperty('--toast-bottom');
    };
  }, []);

  const { setCollapsed, reset, stop } = useAssistant.getState();
  const phoneHeight = useAssistant((s) => s.phoneHeight);
  const drag = useRef<number>(undefined);
  // One set of colours: violet while it works, amber when it needs you, green when it passed; a stop is neutral.
  const icon = busy ? (
    <Loader2 className="size-3.5 shrink-0 animate-spin text-viz-7" />
  ) : need ? (
    <Hand className="size-3.5 shrink-0 text-warn" />
  ) : run?.state === 'passed' && !ended ? (
    <CircleCheck className="size-3.5 shrink-0 text-gn" />
  ) : run?.state === 'failed' || ended ? (
    <CircleStop className="size-3.5 shrink-0 text-t3" />
  ) : (
    <Sparkles className="size-3.5 shrink-0 text-viz-7" />
  );
  // Drafting is one request: the header counts its seconds, and Stop cancels it.
  const draftSeconds = useSeconds(drafting);

  return (
    <aside
      ref={panel}
      aria-label="Spotlight"
      className={cn(
        'z-30 flex flex-col border-hair bg-sf',
        // One panel at a time under a phone's canvas.
        hiddenOnPhone && 'max-md:hidden',
        // Phone: a sheet under the canvas, which shrinks to the space above it.
        'max-md:shrink-0 max-md:rounded-t-2xl max-md:border-t',
        // Phone: three heights, folded to its bar, peek (the newest of the timeline) and half.
        collapsed ? 'max-md:max-h-[40dvh]' : phoneHeight === 'peek' ? 'max-md:h-[34dvh]' : 'max-md:h-[52dvh]',
        // Desktop: a column beside the canvas.
        'md:relative md:shrink-0 md:border-l',
        collapsed ? 'md:w-11' : 'md:w-[360px]',
      )}
    >
      {/* Desktop, folded: a strip with what Spotlight is doing. */}
      {collapsed && (
        <button
          type="button"
          onClick={() => focusSpotlight()}
          title={latest ? `${title}: ${latest}` : 'Show Spotlight (⌘I)'}
          aria-label="Show Spotlight"
          className="hidden flex-1 flex-col items-center gap-3 py-3 text-t3 hover:bg-acdim hover:text-t1 md:flex"
        >
          <PanelRightOpen className="size-4" />
          {icon}
          {waiting > 0 && <span className="rounded-full bg-viz-7 px-1.5 text-[10.5px] font-semibold leading-4 text-bg">{waiting}</span>}
          <span className="text-[11.5px] font-semibold text-t2 [writing-mode:vertical-rl]">{title}</span>
        </button>
      )}
      <div className={cn('flex min-h-0 flex-1 flex-col', collapsed && 'md:hidden')}>
        <div
          // A phone: drag the header up or down for the next height (the chevron goes between the bar and half).
          onPointerDown={(e) => {
            if (!isPhone() || (e.target as HTMLElement).closest('button, input, [role="switch"]')) return;
            drag.current = e.clientY;
            // The finger leaves the header as it drags: the header still gets the release.
            e.currentTarget.setPointerCapture(e.pointerId);
          }}
          onPointerUp={(e) => {
            const start = drag.current;
            drag.current = undefined;
            if (start === undefined || Math.abs(e.clientY - start) < 24) return;
            const heights = ['bar', 'peek', 'half'] as const;
            const at = collapsed ? 0 : phoneHeight === 'peek' ? 1 : 2;
            useAssistant.getState().setDock(heights[Math.max(0, Math.min(2, at + (e.clientY < start ? 1 : -1)))]);
          }}
          onPointerCancel={() => (drag.current = undefined)}
          className="relative flex h-11 shrink-0 items-center gap-1.5 border-b border-hair pl-3 pr-1.5 max-md:touch-none max-md:select-none"
        >
          <span className="absolute left-1/2 top-1 block h-1 w-8 -translate-x-1/2 rounded-full bg-hair md:hidden" aria-hidden />
          {icon}
          <span role="status" aria-live="polite" className="min-w-0 flex-1 truncate text-[13px] font-semibold text-t1" title={latest}>
            {title}
          </span>
          {/* Outside the live region: a screen reader would read the title again every second. */}
          {drafting && draftSeconds >= 2 && (
            <span aria-hidden className="-ml-1 shrink-0 text-[13px] text-t3 tabular-nums">
              · {draftSeconds} s
            </span>
          )}
          <AutonomousSwitch compact={live || testing} />
          {/* The composer has its own Stop while a reply streams; this one is for a test run, or when the panel is folded. */}
          {(collapsed ? live || testing : testing && !live) && (
            <button title="Stop" aria-label="Stop" onClick={stop} className="grid size-7 place-items-center rounded-full text-t3 hover:bg-rddim hover:text-rd disabled:opacity-40 max-md:size-11">
              <Square className="size-3" fill="currentColor" />
            </button>
          )}
          <button title="New conversation" aria-label="New conversation" onClick={reset} className="grid size-7 place-items-center rounded-full text-t3 hover:bg-acdim hover:text-t1 max-md:size-11">
            <SquarePen className="size-3.5" />
          </button>
          <button
            title={collapsed ? 'Show the conversation' : 'Hide the conversation'}
            aria-label={collapsed ? 'Show the conversation' : 'Hide the conversation'}
            aria-expanded={!collapsed}
            onClick={() => {
              // A phone unfolds to half; peek is a drag away.
              if (collapsed && isPhone()) useAssistant.setState({ phoneHeight: 'half' });
              setCollapsed(!collapsed);
              // Folding on a desktop hides this button: the strip that unfolds it takes the focus.
              if (!collapsed) requestAnimationFrame(() => document.querySelector<HTMLElement>('aside[aria-label="Spotlight"] button[aria-label="Show Spotlight"]')?.focus());
            }}
            className="grid size-7 place-items-center rounded-full text-t3 hover:bg-acdim hover:text-t1 max-md:size-11"
          >
            <PanelRightClose className="hidden size-4 md:block" />
            <ChevronDown className={cn('size-4 transition-transform md:hidden', collapsed && 'rotate-180')} />
          </button>
        </div>
        {collapsed ? (
          // Phone, folded: the step Spotlight is on.
          latest && (
            <p className="flex items-center gap-1.5 truncate px-3 py-1.5 text-[12px] text-t2 md:hidden">
              <span className="truncate">{latest}</span>
            </p>
          )
        ) : items.length || agents.length ? (
          <Timeline live={live} status={drafting ? 'Drafting the flow from the node catalog…' : undefined} />
        ) : (
          <div className="flex min-h-0 flex-1 flex-col justify-end gap-1.5 px-4 py-4 text-[12.5px] leading-snug text-t3">
            <p className="font-semibold text-t2">Build and fix this workflow with Spotlight.</p>
            <p>Describe a flow on an empty canvas and it drafts it, tests it and fixes what fails. On a flow, ask for a change; it uses your agents, or designs one on a local model. Type @ to point at a node.</p>
          </div>
        )}
        <Composer />
      </div>
    </aside>
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
  // How the last session ended, since the person last asked: what to offer next follows from it.
  const outcome = useAssistant((s) => {
    if (s.testing || s.pending) return undefined;
    if (openNeedOf(s.items)) return 'needs' as const;
    const run = lastRunOf(s.items.slice(s.items.findLastIndex((i) => i.role === 'user' && !i.auto) + 1));
    if (lastOutcomeOf(s.items)) return 'stopped' as const;
    return run?.state === 'passed' ? ('passed' as const) : run?.state === 'failed' ? ('stopped' as const) : undefined;
  });
  return useMemo(
    () => ({
      nodes: nodes.map((n) => {
        const { id, name, type } = n.data.wf;
        const descriptor = nodeTypes[type]?.descriptor;
        // An AI Agent needs a chat model; Run an Agent and Run a Team run on the agent's own (their model port is optional).
        const agent = type !== 'core.messageAgent' && type !== 'core.runTeam' && Boolean(descriptor?.inputs.some((p) => p.type === 'ai_languageModel'));
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
      ...(outcome && { outcome }),
    }),
    [nodes, edges, nodeTypes, runs, selectedId, outcome],
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

/** The input at the bottom of the panel, with its bubbles above it. */
function Composer() {
  const hasItems = useAssistant((s) => s.items.length > 0);
  const pending = useAssistant((s) => s.pending || Boolean(s.testing));
  const drafting = useAssistant((s) => s.drafting);
  const phone = usePhone();
  const working = useWorking();
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
  const blurTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(blurTimer.current), []);
  const [active, setActive] = useState(-1);
  const [mentions, setMentions] = useState<Mention[]>([]);
  const [withoutSelection, setWithoutSelection] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const live = pending || drafting;
  // Speech lands in the box to edit, appended to what's typed; it is never sent by voice alone.
  const dictation = useDictation((spoken) => {
    const typed = inputValue.current.trim();
    setText(typed ? `${typed} ${spoken}` : spoken);
  });
  const [canDictate, setCanDictate] = useState(false);
  useEffect(() => setCanDictate(dictationSupported()), []);
  const inputValue = useRef('');
  inputValue.current = draft;

  // A new selection is back in the context.
  useEffect(() => setWithoutSelection(false), [selectedName]);

  const bubbles = useMemo<Bubble[]>(() => {
    if (live) return [];
    if (draft.trim()) return focused ? completeBubbles(draft, caret, ctx) : [];
    if (working) return [];
    const offer: Bubble[] = fix ? [{ id: `fix:${fix.suggestion.id}`, label: /^fix\b/i.test(fix.suggestion.title) ? fix.suggestion.title : `Fix: ${fix.suggestion.title}`, kind: 'ask', text: '', caret: 0 }] : [];
    const idle = idleBubbles(ctx);
    // Unfocused, only what needs attention (a failure) or a start on an empty canvas.
    const quiet = focused || empty ? idle : idle.filter((b) => b.id.startsWith('why-'));
    return [...offer, ...quiet].slice(0, 3);
  }, [live, draft, caret, focused, ctx, working, fix, empty]);

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
      return;
    }
    await useAssistant.getState().send(message, {
      withoutSelection,
      // Autonomous: the model hears that its proposal is applied and tested as it ends, so it never says "click Apply".
      ...(useAutonomous.getState().on && { session: 'auto' as const }),
      ...(tagged.length && {
        mentions: {
          nodes: tagged.flatMap((m) => (m.kind === 'node' ? [m.id] : [])),
          types: tagged.flatMap((m) => (m.kind === 'type' ? [m.type] : [])),
        },
      }),
    });
    // Autonomous: what the reply proposed is applied and the flow tested, without Apply or Test and fix.
    await afterReply(message);
  };

  const choose = (bubble: Bubble) => {
    if (bubble.id === TEST_BUBBLE) {
      // Busy already: no message left behind without a session.
      if (useAssistant.getState().pending || useAssistant.getState().testing) return;
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
    } else if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.nativeEvent.isComposing) {
      handled();
      if (active >= 0 && bubbles[active]) choose(bubbles[active]);
      else void submit(draft);
    } else if (e.key === 'Escape') {
      handled();
      if (draft) setText('');
      else input.current?.blur();
    }
  };

    const placeholder = drafting || pending ? 'Spotlight is working on the flow…' : empty ? 'Describe the workflow you want…' : 'Ask or describe a change';

  return (
    <div className="shrink-0 space-y-2 border-t border-hair p-2.5">
      <div className="flex flex-col gap-2">
        {bubbles.length > 0 && (
          <div role="listbox" aria-label="Suggestions" className="flex flex-wrap gap-1.5">
            {bubbles.map((b, i) => (
              <button
                key={b.id}
                role="option"
                aria-selected={i === active}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(b)}
                style={{ animationDelay: `${i * 40}ms` }}
                className={cn(
                  'flex max-w-full animate-fade-up items-center gap-1.5 rounded-full border bg-sf px-3 py-1 text-[12.5px] text-t1 transition-colors hover:border-acbd',
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
          'rounded-2xl border bg-wl px-2.5 py-1.5 transition-colors',
          focused ? 'border-[color-mix(in_oklab,var(--viz-7)_45%,var(--bd))]' : 'border-hair',
        )}
      >
        {selectedName && !withoutSelection && !empty && (
          <span className="mb-1 flex w-fit max-w-full items-center gap-0.5 rounded-md border border-hair bg-wl py-0.5 pl-1.5 pr-0.5 text-[11.5px] text-t2" title="The selected node is part of what Spotlight sees">
            <span className="truncate">{selectedName}</span>
            <button onMouseDown={(e) => e.preventDefault()} onClick={() => setWithoutSelection(true)} aria-label={`Leave ${selectedName} out`} className="grid size-4 place-items-center rounded text-t3 hover:text-t1 max-md:size-9">
              <X className="size-3" />
            </button>
          </span>
        )}
        <div className="flex items-end gap-2">
        <Sparkles className="mb-[9px] size-4 shrink-0 text-viz-7" />
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
          onFocus={() => {
            clearTimeout(blurTimer.current);
            setFocused(true);
          }}
          // The bubbles fold a moment after the input loses focus: folding at once moves the timeline under a tap, which
          // then lands on nothing (a phone's first tap on a row after typing).
          onBlur={() => {
            if (phone) blurTimer.current = setTimeout(() => setFocused(false), 250);
            else setFocused(false);
          }}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          aria-label="Ask Spotlight"
          aria-autocomplete="list"
          className="max-h-[120px] min-h-[32px] min-w-0 flex-1 resize-none bg-transparent py-1.5 text-[13.5px] leading-5 text-t1 max-md:text-base outline-none placeholder:text-t3"
        />
        {!focused && !draft && !hasItems && <kbd className="mb-[9px] shrink-0 max-md:hidden rounded border border-hair px-1 font-mono text-[10.5px] text-t3">⌘I</kbd>}
        {canDictate && !live && (
          <button
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => (dictation.state === 'recording' ? dictation.stop() : void dictation.start())}
            disabled={dictation.state === 'transcribing'}
            aria-label={dictation.state === 'recording' ? 'Stop recording' : 'Dictate'}
            aria-pressed={dictation.state === 'recording'}
            title={dictation.error || (dictation.state === 'recording' ? 'Stop and transcribe' : 'Dictate (speech goes into the box to edit)')}
            className={cn(
              'mb-[2px] flex h-8 shrink-0 items-center gap-1 rounded-full px-2 text-t2 transition-colors hover:bg-acdim hover:text-t1 disabled:opacity-60 max-md:h-11 max-md:min-w-11 max-md:justify-center',
              dictation.state === 'recording' && 'bg-rd/15 text-rd hover:bg-rd/20 hover:text-rd',
              dictation.error && 'text-rd',
            )}
          >
            {dictation.state === 'transcribing' ? <Loader2 className="size-4 animate-spin" /> : dictation.state === 'recording' ? <Square className="size-3.5 animate-pulse" fill="currentColor" /> : <Mic className="size-4" />}
            {dictation.state === 'recording' && <span className="font-mono text-[11.5px] tabular-nums">{Math.floor(dictation.seconds / 60)}:{String(dictation.seconds % 60).padStart(2, '0')}</span>}
          </button>
        )}
        {live ? (
          <button
            onClick={() => useAssistant.getState().stop()}
            aria-label="Stop"
            title="Stop"
            className="mb-[2px] grid size-8 shrink-0 place-items-center rounded-full border border-bd text-t2 transition-colors hover:border-rd hover:text-rd disabled:opacity-50 max-md:size-11"
          >
            <Square className="size-3" fill="currentColor" />
          </button>
        ) : (
          <button
            onClick={() => void submit(draft)}
            disabled={!draft.trim()}
            aria-label="Send"
            className="mb-[2px] grid size-8 shrink-0 place-items-center rounded-full bg-ac2 text-on-ac transition-all hover:scale-105 disabled:opacity-30 disabled:hover:scale-100 max-md:size-11"
          >
            <ArrowUp className="size-4" />
          </button>
        )}
        </div>
      </div>
    </div>
  );
}
