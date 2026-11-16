'use client';
/** One reply of the timeline: its text, changes, runs, needs and buttons (docs/assistant.md#the-spotlight-panel). */
import { useState } from 'react';
import { cn } from '@/lib/utils';
import { Bot, Check, CircleCheck, CircleStop, CircleX, ExternalLink, Hand, Loader2, Play, Rocket, Sparkles } from 'lucide-react';
import { Button } from '../../ui/button';
import { holdsForClick, typedSession } from '../autonomous'; // SB04:
import { afterReply, useAutonomous } from '../autonomous';
import { LiveSteps, useLive } from '../building';
import { applyChanges, prefillSpotlight, undos, useAssistant, type AgentProgress, type ChatItem, type Need, type Outcome, type ReplyAction, type TestRun } from '../assistant';
import { useEditor } from '../store';
import { useAutonomyFacts } from '../spotlight-autonomy';
import { ActivityTrace } from '../../ui/activity-trace';
import { StatusSwap, StreamingText } from '../../ui/chat-motion';
import { AssistantRow, ChatError, ChatMarkdown, ReplyMeta, ShortReply } from '../../ui/chat';
import { MAX_FIXES, approveDestinations, productionNote, publishToProduction, testUntilItRuns, undoApplied } from '../test-session'; // SB03:
import { agentStep, runRow } from '../timeline';

import { ProposalCard, ProposalRow } from './proposal';
import { provisionalText } from '@/lib/shared/leaked-markup';
import { swapState } from './swap';
import { OPEN_CAPS_HREF, errorActions, type ErrorAction } from './states';
import { can } from '@/lib/shared/auth';
import { useViewer } from '../../auth/viewer';
import { yesText } from '@/lib/shared/run-check';

export type Reply = Extract<ChatItem, { role: 'assistant' }>;

/** Open the node a run failed at, by name. */
export function openNodeNamed(name: string) {
  const node = useEditor.getState().nodes.find((n) => n.data.wf.name === name);
  if (node) useEditor.getState().openNode(node.id);
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
    need.what === 'sends' || need.what === 'destination'
      ? { label: 'Run it for real', act: () => (approveDestinations(useEditor.getState().workflowId, need.destinations ?? [], need.once ?? []), goOn()) } // SB03:
      : need.what === 'blocked' || need.what === 'address'
        ? { label: 'Open the step', act: () => need.node && openNodeNamed(need.node) }
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
          {need.state === 'dismissed' ? 'Left for later.' : need.what === 'sends' || need.what === 'destination' ? yesText(need.destinations) : need.what === 'blocked' || need.what === 'address' ? 'Left for you to change.' : need.what === 'trigger' ? 'Trigger added.' : 'Testing again.'}
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
          ) : need.what === 'destination' ? (
            // SB03: take the change that brought the new destination back, then test on.
            <Button size="sm" variant="ghost" disabled={busy || !need.fix} onClick={() => (need.fix && undoApplied(need.fix), goOn())}>
              Undo that change
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
  // The newest failed run while nothing is working: the person can open the node or ask Spotlight to fix it.
  const failedHere = useAssistant((s) => !s.pending && !s.testing && s.items.flatMap((i) => (i.role === 'assistant' ? i.parts.flatMap((p) => (p.kind === 'run' ? [p.run] : [])) : [])).at(-1) === run) && run.state === 'failed';
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
      {failedHere && at && (
        <div className="mt-1 flex flex-wrap gap-1 pl-5">
          {errorActions({ message: full || row.reason, node: { id: at, name: `“${at}”` } }, { admin: false, canRetry: false }).map((a) => (
            <button
              key={a.id}
              type="button"
              onClick={() => (a.id === 'open-node' ? openNodeNamed(at) : a.id === 'fix-node' && prefillSpotlight(a.prefill))}
              className={cn('min-h-7 rounded-full border px-2.5 text-[11.5px] font-semibold max-md:min-h-11', a.id === 'fix-node' ? 'border-ac text-ac hover:bg-acdim' : 'border-hair text-t2 hover:bg-acdim')}
            >
              {a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** An agent the Agent architect designs for a step: designing, then what it runs on, with its page. */
export function AgentRow({ agent }: { agent: AgentProgress }) {
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

// SB11:
/** A question back (`ask_user`): the question, one chip per choice, and a hint that one's own answer works too. A chip is sent as the next message, typed by the person. */
export function AskRow({ itemId, ask, busy = false }: { itemId: string; ask: { question: string; choices: string[]; answered?: string }; busy?: boolean }) {
  return (
    <div className="flex animate-in flex-col gap-1.5">
      <p className="text-[13px] leading-snug text-t1 [overflow-wrap:anywhere]">{ask.question}</p>
      <div className="flex flex-wrap gap-1.5">
        {ask.choices.map((choice) => {
          const picked = ask.answered === choice;
          return (
            <button
              key={choice}
              type="button"
              disabled={busy || ask.answered !== undefined}
              aria-pressed={ask.answered === undefined ? undefined : picked}
              onClick={() => void useAssistant.getState().answerAsk(itemId, choice)}
              className={cn(
                'min-h-7 rounded-full border px-2.5 text-[12px] font-semibold max-md:min-h-9',
                picked ? 'border-ac bg-acdim text-ac' : 'border-hair text-t2 enabled:hover:bg-acdim',
                ask.answered !== undefined && !picked && 'opacity-50',
              )}
            >
              {choice}
            </button>
          );
        })}
      </div>
      {ask.answered === undefined && <span className="text-[11.5px] text-t3">or type your own answer</span>}
    </div>
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

/** Try again after a failed reply: the same message, sent again in its place; `resume` carries on from the step it stopped at. */
function retryReply(replyId: string, resume?: { checkpoint: string }) {
  const { items, pending } = useAssistant.getState();
  const at = items.findIndex((i) => i.id === replyId);
  const asked = items[at - 1];
  if (pending || at < 1 || asked?.role !== 'user') return;
  useAssistant.setState({ items: items.filter((_, i) => i !== at && i !== at - 1) });
  void useAssistant
    .getState()
    // Continue keeps what the failed reply had proposed: they are not in `pending` (the reply left the items), the server holds them.
    .send(asked.text, { ...typedSession(asked.text), ...(resume && { resume, carry: items[at] }) })
    .then(() => afterReply(asked.text));
}

/** The error under a failed reply, with the buttons its kind offers (`errorActions`). */
function ReplyError({ item, canRetry }: { item: Reply; canRetry: boolean }) {
  const admin = can(useViewer(), 'settings:manage');
  const list = errorActions({ message: item.error ?? '', kind: item.errorKind, step: item.errorStep, checkpoint: item.checkpoint }, { admin, canRetry });
  const run = (a: ErrorAction) => {
    if (a.id === 'retry') retryReply(item.id);
    else if (a.id === 'continue' && item.checkpoint) retryReply(item.id, { checkpoint: item.checkpoint });
    else if (a.id === 'open-caps') window.open(OPEN_CAPS_HREF, '_blank', 'noopener');
  };
  const extra = list.filter((a) => a.id !== 'retry').map((a) => ({ label: a.label, primary: 'primary' in a && a.primary, onClick: () => run(a) }));
  return <ChatError message={item.error!} onRetry={list.some((a) => a.id === 'retry') ? () => run({ id: 'retry', label: 'Try again' }) : undefined} actions={extra} />;
}

/**
 * A reply: the trace of what it did (live while it works, "N steps · T s" once done), its words (streamed, then the checked
 * text cut to two sentences), then its changes, runs and buttons, and the footer (model · time · steps · tokens · cost).
 * A reply that did not come from the chat stream (a drafted flow, a fix offered by the after-run card) keeps its parts in order.
 */
export function ReplyView({ item, live, status }: { item: Reply; live: boolean; status?: string }) {
  const autonomous = useAutonomous((s) => s.on);
  const spotlightBusy = useAssistant((s) => s.pending || Boolean(s.testing));
  const building = useLive();
  const pending = item.parts.flatMap((p) => (p.kind === 'proposal' && !p.proposal.state ? [p.proposal] : []));
  const lastTool = item.parts.findLast((p) => p.kind === 'tool');
  const applyAll = () => {
    const onApplied = ({ undo }: { undo: () => void }) => {
      for (const p of pending) undos.set(p.id, undo);
    };
    if (!applyChanges(pending.map((p) => ({ ops: p.ops, kind: 'proposal' as const })), `Applied ${pending.length} changes`, { onApplied })) return;
    for (const p of pending) useAssistant.getState().setProposalState(item.id, p.id, 'applied');
  };
  const isLast = useAssistant((s) => s.items.at(-1)?.id === item.id);
  const steps = building?.replyId === item.id ? building : undefined;
  // A test run shows its own progress; a change being built shows its steps.
  const own = item.parts.some((p) => p.kind === 'run' || p.kind === 'action');
  // Rows, not cards: Spotlight applied them itself (a session's fix, autonomous mode), or is about to (autonomous mode on
  // while the reply still has changes to apply). A turn applied by hand stays a card when the switch flips later.
  // SB04: a change that waits for a click (asks first, or one that removes a step) stays a card with Apply and Dismiss, in a session or an autonomous reply too.
  // Re-render when what holdsForClick reads changes (the switch, the published read arriving, the workflow opening).
  useAutonomyFacts((s) => s.workflows);
  useAutonomyFacts((s) => s.switchOn);
  useEditor((s) => s.workflowId);
  const waits = pending.length > 0 && holdsForClick(pending);
  const asRows = !waits && (Boolean(item.testId || item.auto) || (autonomous && !item.earlier && (live || spotlightBusy) && pending.length > 0));
  // Within a session, the reply's texts are one: its first sentence, the rest on "Show more".
  // Autonomous replies that changed the flow too: the rows say what was done.
  const session = Boolean(item.testId) || (Boolean(item.auto) && !live && item.parts.some((p) => p.kind === 'proposal'));
  // A session's fix: its row says what it did and opens on the model's words; the prose would say it twice.
  const quietText = Boolean(item.testId) && !live && item.parts.some((p) => p.kind === 'proposal' && p.proposal.state);
  const partsText = item.parts.flatMap((p) => (p.kind === 'text' ? [p.text] : [])).join('\n\n');
  // From the chat stream: the words come in item.text (provisional while streaming), the trace in item.steps.
  const streamed = item.steps !== undefined;
  const provisional = streamed && live && !item.parts.some((p) => p.kind === 'text');
  // Provisional words hold back a local model's leaked tool markup and <think> text (the checked text has none).
  const text = streamed ? (provisional ? provisionalText(item.text ?? partsText) : (item.text ?? partsText)) : partsText;
  const firstText = item.parts.findIndex((p) => p.kind === 'text');
  const firstProposal = item.parts.findIndex((p) => p.kind === 'proposal');
  const hasTrace = (item.steps?.length ?? 0) > 0;
  // SB11: a question back shows its words in its own row (never cut to two sentences).
  const asked = item.parts.find((p) => p.kind === 'ask');
  const words = quietText || !text.trim() || (asked && asked.ask.question.trim() === text.trim()) ? null : provisional ? (
    <StreamingText text={text} streaming />
  ) : streamed ? (
    <ShortReply text={text} sentences={session ? 1 : 2} />
  ) : null;
  // Working until the first words arrive (a trace's own live line says it once there are steps), so the line cross-fades to the text.
  const swap = swapState({ live, streamed, hasSteps: Boolean(steps), own, hasWords: Boolean(words), hasTrace });
  return (
    <AssistantRow mark={swap.spinner ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}>
      {streamed && steps && <LiveSteps live={steps} trace={item.steps} durationMs={item.meta?.durationMs} />}
      {streamed && !steps && hasTrace && !quietText && <ActivityTrace steps={item.steps!} live={live} durationMs={item.meta?.durationMs ?? item.done?.durationMs} />}
      {swap.mounted && (
        <StatusSwap working={swap.working} silent={swap.silent} label={status ?? (lastTool?.kind === 'tool' ? `${lastTool.tool.label}…` : 'Thinking…')}>
          {words}
        </StatusSwap>
      )}
      {item.parts.map((part, i) =>
        part.kind === 'text' ? (
          streamed || quietText ? null : session ? (
            i === firstText && <ChatMarkdown key={i} text={partsText} />
          ) : (
            <ChatMarkdown key={i} text={part.text} />
          )
        ) : part.kind === 'proposal' ? (
          steps ? (
            !streamed && i === firstProposal && <LiveSteps key="steps" live={steps} />
          ) : asRows && (part.proposal.state || live || spotlightBusy) ? (
            <ProposalRow key={part.proposal.id} proposal={part.proposal} fix={Boolean(item.testId)} />
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
        ) : part.kind === 'ask' ? (
          // SB11:
          <AskRow key={i} itemId={item.id} ask={part.ask} busy={spotlightBusy} />
        ) : null,
      )}
      {!streamed && steps && firstProposal < 0 && <LiveSteps live={steps} />}
      {item.error && <ReplyError item={item} canRetry={isLast && !item.testId && !live && !spotlightBusy} />}
      {!live && !asRows && pending.length > 1 && (
        <Button size="sm" variant="outline" onClick={applyAll}>
          <Check className="size-3.5" /> Apply all ({pending.length})
        </Button>
      )}
      {/* What answered and how: model · time · steps · tokens · cost; a session's fixes are rows, which say what they did. */}
      {(item.meta ?? item.done) && !live && !item.testId && <ReplyMeta info={item.meta ?? item.done} copy={partsText || undefined} />}
    </AssistantRow>
  );
}
