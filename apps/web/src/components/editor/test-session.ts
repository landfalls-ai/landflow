'use client';
/**
 * Spotlight's "Test and fix" (docs/assistant.md): run the workflow and, while a run doesn't pass
 * (lib/shared/run-check.ts) or doesn't do what the workflow was drafted for, tell the assistant what went wrong, apply
 * the fix it proposes and run again, up to MAX_FIXES times. Starting a session is the user's go-ahead for those fixes;
 * each one is applied with its own Undo. In autonomous mode (./autonomous.ts, on by default) a drafted flow or an applied
 * chat change starts a session by itself.
 * When a run passes, Spotlight offers to publish the workflow to production. Spotlight's stop button ends the session
 * (a run already going finishes). While it runs, Spotlight shows its progress in a card at the side of the canvas; the
 * session's turns share a `testId`, and once it is over the conversation comes back with them folded into one line and
 * the outcome below.
 */
import { nanoid } from 'nanoid';
import { toast } from 'sonner';
import { opsTitle } from '@/lib/shared/assistant-ops';
import { checkRun, destinationsOf, givenKept, hollowSteps, hostOf, multipliedSteps, needsPerson, isUnreadHost, NO_ADDRESS, sameFailure, type CheckedRun, type RunVerdict } from '@/lib/shared/run-check';
import { applyChanges, fixedNodes, ownRun, runDigests, undos, useAssistant, type Need, type Outcome, type ReplyPart } from './assistant';
import { nextRound } from './timeline';
import { agentsSettled } from './new-agent';
import { publishVersion, toastApprovalRequested } from './publish-control';
import { autonomyOf, needsAClick, notePublished, type Autonomy } from './spotlight-autonomy'; // SB03:
import { useEditor } from './store';
import { useTestListener } from './test-listener';

export const MAX_FIXES = 4;

/**
 * SB03: the destinations each workflow's test runs may send to for real, as the person said in this page's life (the
 * `sends` and `destination` rows): workflow id → destinations. A new destination asks again.
 */
export const sendsAllowed = new Map<string, Set<string>>();

/**
 * A yes for an expression destination holds for the one run that follows, and for the steps as the row showed them: each
 * key is the workflow, the step's id and its URL text, so a changed expression, or a step deleted and added back under the
 * same name, asks again.
 */
const approvedOnce = new Set<string>();

interface Sending {
  node: string;
  destination: string;
  /** The once-yes key of this step with this URL. */
  key: string;
}

/** The enabled steps that would send for real, each with its own destination. */
function sendingNow(): Sending[] {
  const { nodes, workflowId } = useEditor.getState();
  const live = nodes.filter((n) => !n.data.wf.disabled);
  return destinationsOf(live.map((n) => ({ name: n.data.wf.name, type: n.data.wf.type, parameters: n.data.wf.parameters }))).map((d) => {
    const step = live.find((n) => n.data.wf.name === d.node);
    return { ...d, key: `${workflowId} ${step?.id ?? d.node} ${JSON.stringify(step?.data.wf.parameters.url ?? '')}` };
  });
}

/**
 * Record the person's yes for these destinations of a workflow. An expression destination ("{{ … }}") is never kept: the
 * `once` keys the row listed cover the run that follows, and it asks again before the next one (contracts/sb1/needs-you.md).
 */
export function approveDestinations(workflowId: string, destinations: string[], once: readonly string[] = []): void {
  const set = sendsAllowed.get(workflowId) ?? new Set<string>();
  for (const destination of destinations) if (!isUnreadHost(destination) && destination !== NO_ADDRESS) set.add(destination);
  for (const key of once) approvedOnce.add(key);
  sendsAllowed.set(workflowId, set);
}

/** The enabled steps that would send for real, grouped by what the person has not said yes to yet. */
function unapproved(): Sending[] {
  const allowed = sendsAllowed.get(useEditor.getState().workflowId);
  return sendingNow().filter((d) => !allowed?.has(d.destination) && !approvedOnce.has(d.key));
}

const quoted = (names: string[]) => names.slice(0, 2).map((n) => `“${n}”`).join(' and ') + (names.length > 2 ? ` and ${names.length - 2} more` : '');
const listed = (items: string[]) => items.slice(0, 2).join(' and ') + (items.length > 2 ? ` and ${items.length - 2} more` : '');

/**
 * Before a run: a step that would send for real to a destination the person has not said yes to. The first run of a
 * session asks as `sends`; a later one, or a destination a fix brought in, as `destination` (with the fix to undo).
 */
function destinationNeed(goal: string | undefined, first: boolean, fix?: { item: string; proposals: string[] }): Need | undefined {
  const open = unapproved();
  if (!open.length) return undefined;
  // A step with no address yet is not a destination to say yes to: the person fills it in, before any run.
  const empty = [...new Set(open.filter((d) => d.destination === NO_ADDRESS).map((d) => d.node))];
  if (empty.length) return { what: 'address', node: empty[0], text: `${quoted(empty)} ${empty.length === 1 ? 'sends' : 'send'} to ${NO_ADDRESS}: open ${empty.length === 1 ? 'the step' : 'it'} and fill it in.`, ...(goal && { goal }) };
  // With anything still open, the row names every expression destination, the ones said yes to before too: one yes then
  // covers them all as they are now (a yes is for one run, so asking about only the new one would leave the rest asking).
  const rows = sendingNow().filter((d) => isUnreadHost(d.destination) || open.some((o) => o.key === d.key && o.node === d.node));
  const nodes = [...new Set(rows.map((d) => d.node))];
  const destinations = [...new Set(rows.map((d) => d.destination))];
  const once = rows.filter((d) => isUnreadHost(d.destination)).map((d) => d.key);
  return first
    ? { what: 'sends', node: nodes[0], nodes, once, destinations, text: `A test runs ${quoted(nodes)} for real: ${nodes.length === 1 ? 'it sends' : 'they send'} to ${listed(destinations)}.`, ...(goal && { goal }) }
    : { what: 'destination', node: nodes[0], nodes, once, destinations, text: `${quoted(nodes)} now ${nodes.length === 1 ? 'sends' : 'send'} to ${listed(destinations)}, which you haven't approved.`, ...(fix && { fix }), ...(goal && { goal }) };
}

/** Take back what a fix applied (newest first; proposals of one apply share one undo, which runs once). */
export function undoApplied(fix: { item: string; proposals: string[] }): void {
  const done = new Set<() => void>();
  for (const id of [...fix.proposals].reverse()) {
    const undo = undos.get(id);
    if (undo && !done.has(undo)) (done.add(undo), undo());
    undos.delete(id);
    useAssistant.getState().setProposalState(fix.item, id, 'undone');
  }
}

/** SB03: true once `done()` holds for the conversation (a card's Apply or Dismiss); false when the session stops. */
function untilAssistant(done: () => boolean, signal: AbortSignal): Promise<boolean> {
  if (done()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const finish = (value: boolean) => {
      unsubscribe();
      signal.removeEventListener('abort', onAbort);
      resolve(value);
    };
    const onAbort = () => finish(false);
    const unsubscribe = useAssistant.subscribe(() => {
      if (done()) finish(true);
    });
    signal.addEventListener('abort', onAbort);
  });
}

/** True once `done()` holds for the editor; false after `ms` (no limit by default) or when the session stops. */
function until(done: () => boolean, signal: AbortSignal, ms?: number): Promise<boolean> {
  if (done()) return Promise.resolve(true);
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (value: boolean) => {
      unsubscribe();
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve(value);
    };
    const onAbort = () => finish(false);
    const unsubscribe = useEditor.subscribe(() => {
      if (done()) finish(true);
    });
    if (ms !== undefined) timer = setTimeout(() => finish(done()), ms);
    signal.addEventListener('abort', onAbort);
  });
}

const isMain = (connectionType: string | undefined) => (connectionType ?? 'main') === 'main';

/** The run on the canvas. */
function canvasRun(): CheckedRun {
  const { nodes, edges, statuses, runStatus } = useEditor.getState();
  const ran: Record<string, { error?: string; items: number }> = {};
  for (const node of nodes) {
    const status = statuses[node.id];
    if (!status || status.state === 'idle' || status.state === 'running') continue;
    ran[node.id] = { ...(status.state === 'error' && { error: status.error ?? 'failed' }), items: (status.itemCounts ?? []).reduce((sum, n) => sum + n, 0) };
  }
  return {
    nodes: nodes.map((n) => ({ id: n.id, name: n.data.wf.name, sub: edges.some((e) => e.source === n.id && !isMain(e.data?.connectionType)) })),
    edges: edges.filter((e) => isMain(e.data?.connectionType)).map((e) => ({ source: e.source, target: e.target })),
    ran,
    status: runStatus,
    ...(runError() && { error: runError() }),
  };
}

/** Why the run as a whole failed when no node did ("Workflow has no start node"), from the log's last line. */
function runError(): string | undefined {
  const { runStatus, log } = useEditor.getState();
  if (runStatus !== 'error') return undefined;
  const last = log.findLast((l) => l.kind === 'error');
  return last?.message.replace(/^Finished with error:\s*/, '') || undefined;
}

/** What the person has to do before a test can go on, or nothing. Checked before each session's first run. */
function beforeTesting(goal: string | undefined): Need | undefined {
  const { nodes, nodeTypes } = useEditor.getState();
  if (!nodes.some((n) => nodeTypes[n.data.wf.type]?.descriptor.kind === 'trigger')) {
    return { what: 'trigger', text: 'Nothing starts this flow yet.', ...(goal && { goal }) };
  }
  const agent = nodes.find((n) => (n.data.wf.type === 'core.messageAgent' && !n.data.wf.parameters.agentId) || (n.data.wf.type === 'core.runTeam' && !n.data.wf.parameters.teamId));
  if (agent && !useAssistant.getState().agents.some((a) => a.nodeId === agent.id)) {
    return { what: 'agent', node: agent.data.wf.name, text: `“${agent.data.wf.name}” has no ${agent.data.wf.type === 'core.runTeam' ? 'team' : 'agent'} picked.`, ...(goal && { goal }) };
  }
  return destinationNeed(goal, true); // SB03: per destination, not per workflow
}

/** Where the blocked step reaches: the host of its URL, else the one the error names. */
function blockedHost(node: string | undefined, error: string | undefined): string {
  const step = node ? useEditor.getState().nodes.find((n) => n.data.wf.name === node) : undefined;
  const fromUrl = step && typeof step.data.wf.parameters.url === 'string' ? hostOf(step.data.wf.parameters.url) : undefined;
  return fromUrl && !isUnreadHost(fromUrl) && fromUrl !== NO_ADDRESS ? fromUrl : (/Blocked: (\S+)/.exec(error ?? '')?.[1] ?? 'that address');
}

/** A failed run only the person can fix, as a row with the button that does it. */
function personNeed(result: RunVerdict, error: string | undefined, goal: string | undefined): Need | undefined {
  const what = needsPerson(error);
  if (!what) return undefined;
  const node = result.node;
  const step = node ?? 'a step';
  const text =
    what === 'blocked'
      ? `This host blocks “${step}” from reaching ${blockedHost(node, error)}. An admin can allow it (LANDFLOW_OUTBOUND_ALLOW), or change the address yourself.`
      : what === 'trigger'
      ? 'Nothing starts this flow yet.'
      : what === 'agent'
        ? `“${step}” has no agent picked.`
        : /credential/i.test(error ?? '')
          ? `“${step}” needs ${/No (.+?) credential selected/i.exec(error ?? '')?.[1] ? `a ${/No (.+?) credential selected/i.exec(error ?? '')?.[1]} credential` : 'a credential'} picked.`
          : `“${step}” was refused by the app (${error}): its credential is missing or wrong.`;
  return { what, text, ...(node && { node }), ...(goal && { goal }) };
}

/**
 * Steps of a run without errors that still don't do the job: one that does nothing (a filter without conditions) or one
 * that repeats every result (per-item code that handles all the items each time).
 */
function weakSteps(): Array<{ node: string; problem: string }> {
  const steps = useEditor.getState().nodes.map((n) => ({ id: n.id, name: n.data.wf.name, type: n.data.wf.type, parameters: n.data.wf.parameters }));
  return [...hollowSteps(steps), ...multipliedSteps(canvasRun(), steps)];
}

/** Run the workflow once and judge it; `stopped` when the session can't go on. */
async function runOnce(signal: AbortSignal): Promise<RunVerdict | { stopped: string }> {
  await until(() => !useEditor.getState().running, signal);
  if (signal.aborted) return { stopped: 'Stopped.' };
  const { run } = useEditor.getState();
  if (!run) return { stopped: 'The editor can’t run the workflow right now.' };
  // This run is Spotlight's: its end is a row of the timeline, even once the session is over (no toast).
  run({ kind: 'run', by: 'spotlight' });
  const started = await until(() => useEditor.getState().running, signal, 3000);
  // A run followed from the server (the stream dropped) is matched by its execution, once the server names it.
  if (started) void until(() => Boolean(useEditor.getState().executionId), signal, 10000).then((named) => named && ownRun(useEditor.getState().executionId));
  if (!started) {
    if (signal.aborted) return { stopped: 'Stopped.' };
    if (useTestListener.getState().listening) return { stopped: 'The trigger waits for a test event: send one (or pin test data on the trigger), then test again.' };
    return { stopped: 'The run didn’t start.' };
  }
  await until(() => !useEditor.getState().running, signal);
  if (signal.aborted) return { stopped: 'Stopped.' };
  const { runStatus } = useEditor.getState();
  if (runStatus === 'canceled') return { stopped: 'The run stopped before it finished.' };
  if (runStatus === 'waiting') return { stopped: 'The run is waiting (a Wait node, a form or an approval) and goes on in the background, so testing stops here.' };
  return checkRun(canvasRun());
}

/** What the step a passing run ended at put out, for the review: the model compares it with the goal without a tool call. */
function outputOf(nodeName: string | undefined): string {
  const node = nodeName ? useEditor.getState().nodes.find((n) => n.data.wf.name === nodeName) : undefined;
  const sample = node && runDigests()[node.id]?.outputs[0]?.sample;
  if (!sample) return '';
  const json = JSON.stringify(sample);
  return ` “${nodeName}” put out: ${json.length > 1200 ? `${json.slice(0, 1200)}…` : json}.`;
}

/** A reply of the session's own: a run (in the session, with its `testId`), or the outcome (after it); returns its id. */
/**
 * Ask the person for something only they can do. An older question still open is taken out: the newest one is what
 * holds the session up (asking twice for the same yes reads as a stutter).
 */
function ask(need: Need): string {
  useAssistant.setState((s) => ({
    items: s.items.flatMap((item) => {
      if (item.role !== 'assistant' || !item.parts.some((p) => p.kind === 'needs' && !p.need.state)) return [item];
      const parts = item.parts.filter((p) => !(p.kind === 'needs' && !p.need.state));
      return parts.length ? [{ ...item, parts }] : [];
    }),
  }));
  return say([{ kind: 'needs', need }]);
}

function say(parts: ReplyPart[], testId?: string): string {
  const id = nanoid(8);
  useAssistant.getState().append([{ id, role: 'assistant', parts, ...(testId && { testId }) }]);
  return id;
}

const setRun = (itemId: string, run: Extract<ReplyPart, { kind: 'run' }>['run']) => useAssistant.getState().updateParts(itemId, (parts) => parts.map((p) => (p.kind === 'run' ? { ...p, run } : p)));

/**
 * Run, fix, run again until a run passes, MAX_FIXES fixes are spent, or the user stops it. With a `goal` (the description
 * the workflow was drafted from), a run without errors is checked against it as well: the assistant compares the output
 * with the goal and fixes what doesn't match.
 */
/** `publishAgents`: an agent a fix creates is published so the next run can use it (autonomous mode, ./autonomous.ts). */
export async function testUntilItRuns(goal?: string, options: { publishAgents?: boolean; autonomy?: Autonomy } = {}): Promise<void> {
  if (useAssistant.getState().pending || useAssistant.getState().testing) return;
  const abort = new AbortController();
  const { signal } = abort;
  const testId = nanoid(8);
  useAssistant.setState({ testing: abort, testingId: testId, fixNotes: {} });
  try {
    // What only the person can do comes first: no run, no fix spent on it.
    const first = beforeTesting(goal);
    if (first) {
      ask(first);
      return;
    }
    let fixes = 0;
    // SB03: the fixes applied when the last review was asked; a pass is reviewed again after any fix since.
    let reviewedAt: number | undefined;
    /** SB03: what Spotlight may do alone, and the steps the flow had when the session started. */
    const autonomy = options.autonomy ?? autonomyOf(useEditor.getState().workflowId);
    const startNodes = useEditor.getState().nodes.map((n) => ({ id: n.id, name: n.data.wf.name, enabled: n.data.wf.disabled !== true }));
    let ran = false;
    /** The last failure, to tell a fix that changed nothing. */
    let lastFailure: string | undefined;
    /** What was applied so far: the assistant gets no history, so it hears what didn't help. */
    const tried: string[] = [];
    /** The fixes applied, newest last, for undoing one that changed nothing (or all of them, from the outcome card). */
    const lastApplied: Array<{ item: string; proposals: string[] }> = [];
    /** The session ends without a pass: a card with why and what to do next. */
    const stop = (text: string, node?: string) =>
      say([{ kind: 'outcome', outcome: { text, ...(node && { node }), ...(goal && { goal }), fixes: lastApplied.flatMap((a) => a.proposals.map((proposal) => ({ item: a.item, proposal }))), edits: useEditor.getState().edits } satisfies Outcome }]);
    // Runs count on through the conversation.
    for (let round = nextRound(useAssistant.getState().items); !signal.aborted; round++) {
      // An agent Spotlight is still designing (./new-agent.ts): the run needs it saved and pointed at first.
      await agentsSettled();
      if (signal.aborted) return; // stopped while an agent was being designed: no run
      // SB03: every run, not only the first: a destination the person never said yes to (a fix may have brought it in) stops the session.
      if (ran) {
        const last = lastApplied.at(-1);
        const need = destinationNeed(goal, false, last && { item: last.item, proposals: last.proposals });
        if (need) {
          ask(need);
          return;
        }
      }
      ran = true;
      const runItem = say([{ kind: 'run', run: { round, state: 'running' } }], testId);
      const result = await runOnce(signal);
      approvedOnce.clear(); // a yes for an expression destination covered that run only
      if ('stopped' in result) {
        // The run that didn't happen gives way to why.
        useAssistant.setState((s) => ({ items: s.items.filter((item) => item.id !== runItem) }));
        // Stopped by the person (■, New conversation, another workflow): nothing to add.
        if (!signal.aborted) say([{ kind: 'text', text: result.stopped }]);
        return;
      }
      setRun(runItem, { round, state: result.passed ? 'passed' : 'failed', summary: result.summary });
      if (!result.passed) {
        const failedNode = result.node ? useEditor.getState().nodes.find((n) => n.data.wf.name === result.node) : undefined;
        const error = failedNode ? (useEditor.getState().statuses[failedNode.id]?.error ?? runError()) : runError();
        const need = personNeed(result, error, goal);
        if (need) {
          ask(need);
          return;
        }
        // The same failure after a fix: the fix didn't help. Undo it and stop, rather than spend another.
        if (lastFailure && sameFailure(result.summary) === lastFailure) {
          const last = lastApplied.at(-1);
          if (last) undoApplied(last);
          lastApplied.pop();
          stop(`The last fix didn’t change the error${result.node ? ` at “${result.node}”` : ''}, so I undid it.`, result.node);
          return;
        }
        lastFailure = sameFailure(result.summary);
      } else lastFailure = undefined;
      // A step that does nothing, or repeats every result, isn't caught by a run: it needs a fix too.
      const hollow = result.passed ? weakSteps() : [];
      const failed = !result.passed || hollow.length > 0;
      if (hollow.length) setRun(runItem, { round, state: 'failed', summary: `no errors, but ${hollow.map((h) => h.problem).join('; ')}` });
      // SB03: a pass with steps this session removed is never "Ready for production": the outcome names them.
      // Steps turned off count with the removed ones: a pass that skips them is no pass.
      const removed = startNodes.filter((n) => {
        const now = useEditor.getState().nodes.find((m) => m.id === n.id);
        return !now || (n.enabled && now.data.wf.disabled === true);
      });
      if (!failed && removed.length) {
        const gone = removed.filter((n) => !useEditor.getState().nodes.some((m) => m.id === n.id)).length;
        const verb = gone === removed.length ? 'removed' : gone === 0 ? 'turned off' : 'removed or turned off';
        stop(`It runs, but this session ${verb} ${quoted(removed.map((n) => n.name))}, which the flow had before. Undo the fixes to get ${removed.length === 1 ? 'it' : 'them'} back.`, result.node);
        return;
      }
      // SB03: a pass is reviewed against the goal; a pass after any fix since the last review is reviewed once more.
      if (!failed && (!goal || reviewedAt === fixes)) {
        say([{ kind: 'action', action: 'publish' }]);
        return;
      }
      if (fixes >= MAX_FIXES && failed) {
        stop(`Still failing${result.node ? ` at “${result.node}”` : ''} after ${MAX_FIXES} fixes${result.summary ? `: ${result.summary.replace(/^failed at “[^”]+”:\s*/, '').slice(0, 80)}` : ''}.`, result.node);
        return;
      }
      const at = hollow[0]?.node ?? result.node;
      const nodeId = at ? useEditor.getState().nodes.find((n) => n.data.wf.name === at)?.id : undefined;
      const asked = goal ? ` I asked for: “${goal}”.` : '';
      const before = tried.length ? ` Already tried: ${tried.map((t) => `“${t}”`).join('; ')}.` : '';
      const request = !result.passed
        ? `Test run ${round} ${result.summary}.${asked} Fix it.${before}`
        : hollow.length
          ? `Test run ${round} had no errors, but ${hollow.map((h) => h.problem).join('; ')}.${asked} Fix it.${before}`
          : `Test run ${round} had no errors: ${result.summary}.${outputOf(result.node)} Does that do what I asked for: “${goal}”? Check each part of what I asked against it. If not, fix it; if it does, start your reply with "Yes," and say so in one sentence.${before}`;
      if (!failed) reviewedAt = fixes; // SB03:
      useAssistant.setState({ fixing: failed ? nodeId : undefined });
      await useAssistant.getState().send(request, { auto: true, fresh: true, session: failed ? 'fix' : 'review', autonomy, withoutSelection: true, testId, ...(nodeId && { nodeId }) });
      useAssistant.setState({ fixing: undefined });
      if (signal.aborted) return;
      const reply = useAssistant.getState().items.at(-1);
      if (reply?.role !== 'assistant' || reply.error) {
        stop(`I couldn’t work out a fix${result.node ? ` for “${result.node}”` : ''}.`, result.node);
        return;
      }
      const proposals = reply.parts.flatMap((p) => (p.kind === 'proposal' && !p.proposal.state ? [p.proposal] : []));
      if (!proposals.length) {
        // Nothing to change: a run the review said yes to is ready; a "no" without a fix, or a failed run, needs the person.
        const said = reply.parts.find((p) => p.kind === 'text');
        const yes = said?.kind === 'text' && /^\s*yes\b/i.test(said.text);
        if (!failed && yes) say([{ kind: 'action', action: 'publish' }]);
        else if (!failed) stop('It runs, but doesn’t do all you asked yet, and I have no change for it: tell me what to change.', result.node);
        // The reply above already says why.
        else stop(`I found no fix for “${result.node ?? 'this step'}”. Tell me what it should do, or open it.`, at);
        return;
      }
      // SB03: a fix never drops a step the person asked for or changes a value they gave: it is kept from it.
      const kept = givenKept(
        proposals.flatMap((p) => p.ops),
        useEditor.getState().nodes.map((n) => ({ id: n.id, name: n.data.wf.name, parameters: n.data.wf.parameters })),
        [goal, useEditor.getState().description, ...useAssistant.getState().items.flatMap((i) => (i.role === 'user' && !i.auto ? [i.text] : []))].filter(Boolean).join('\n'),
      );
      if (kept) {
        for (const proposal of proposals) useAssistant.getState().setProposalState(reply.id, proposal.id, 'dismissed');
        stop(`${kept[0].toUpperCase()}${kept.slice(1)} I kept it.`, at);
        return;
      }
      if (fixes >= MAX_FIXES) {
        for (const proposal of proposals) useAssistant.getState().setProposalState(reply.id, proposal.id, 'dismissed');
        stop('It runs, but doesn’t do all you asked yet, and I am out of fixes: tell me what to change.', result.node);
        return;
      }
      // SB03 (D1): asks-first, and a change that removes a step even under auto, waits for the person's Apply.
      const graph = { nodes: useEditor.getState().nodes.map((n) => ({ id: n.id, name: n.data.wf.name })), connections: useEditor.getState().edges.map((e) => ({ source: e.source, target: e.target, type: e.data?.connectionType })) };
      const reasons = autonomy === 'auto' ? needsAClick(proposals.flatMap((p) => p.ops), graph) : [];
      if (autonomy === 'asks-first' || reasons.length) {
        if (reasons.length) {
          const note = `Waits for you: ${reasons.join(', ')}`;
          useAssistant.getState().updateParts(reply.id, (parts) => parts.map((p) => (p.kind === 'proposal' && !p.proposal.state ? { ...p, proposal: { ...p.proposal, warnings: [...p.proposal.warnings, note] } } : p)));
        }
        const decided = () => {
          const item = useAssistant.getState().items.find((i) => i.id === reply.id);
          return item?.role === 'assistant' && proposals.every((p) => item.parts.some((x) => x.kind === 'proposal' && x.proposal.id === p.id && x.proposal.state));
        };
        await untilAssistant(decided, signal);
        if (signal.aborted) {
          // New conversation, another workflow: the reply is gone, and so is the session's place to speak.
          if (useAssistant.getState().items.some((i) => i.id === reply.id)) stop('You stopped before the change was applied.', at);
          return;
        }
        const item = useAssistant.getState().items.find((i) => i.id === reply.id);
        const taken = proposals.filter((p) => item?.role === 'assistant' && item.parts.some((x) => x.kind === 'proposal' && x.proposal.id === p.id && x.proposal.state === 'applied'));
        if (!taken.length) {
          stop('You kept the flow as it was.', at);
          return;
        }
        lastApplied.push({ item: reply.id, proposals: taken.map((p) => p.id) });
        for (const proposal of taken) useAssistant.getState().noteFix(fixedNodes(proposal.ops, nodeId), opsTitle(proposal.ops));
        tried.push(...taken.map((p) => p.summary));
        fixes++;
        continue;
      }
      const label = proposals.length === 1 ? `Spotlight applied “${proposals[0].summary}”` : `Spotlight applied ${proposals.length} fixes`;
      let skipped = 0;
      const applied = applyChanges(proposals.map((p) => ({ ops: p.ops, kind: 'proposal' as const })), label, {
        publishAgents: options.publishAgents,
        quiet: true,
        onApplied: ({ undo, skipped: dropped }) => {
          for (const p of proposals) undos.set(p.id, undo);
          skipped = dropped.length;
        },
      });
      if (!applied) {
        for (const proposal of proposals) useAssistant.getState().setProposalState(reply.id, proposal.id, 'dismissed');
        stop('The canvas changed while I worked, so the fix no longer fits.', at);
        return;
      }
      lastApplied.push({ item: reply.id, proposals: proposals.map((p) => p.id) });
      for (const proposal of proposals) {
        useAssistant.getState().setProposalState(reply.id, proposal.id, 'applied', skipped);
        // A bubble on what it fixed, until dismissed.
        useAssistant.getState().noteFix(fixedNodes(proposal.ops, nodeId), opsTitle(proposal.ops));
      }
      tried.push(...proposals.map((p) => p.summary));
      fixes++;
    }
  } catch (e) {
    // A bug must not end a session in silence.
    if (!signal.aborted) say([{ kind: 'text', text: `Testing stopped: ${(e as Error).message}` }]);
  } finally {
    approvedOnce.clear(); // a yes covers the run that follows it, not a later session
    // Over: the conversation comes back from the side with the outcome.
    if (useAssistant.getState().testing === abort) useAssistant.setState({ testing: undefined, testingId: undefined, fixing: undefined });
  }
}

/** What publishing does for this workflow: a trigger that starts it on its own runs the new version; a manual one never does. */
export function productionNote(): string {
  const { nodes, nodeTypes } = useEditor.getState();
  const triggers = nodes.filter((n) => nodeTypes[n.data.wf.type]?.descriptor.kind === 'trigger');
  const live = triggers.filter((n) => n.data.wf.type !== 'core.manualTrigger');
  if (live.length) return `Publishing puts this version live: “${live[0].data.wf.name}” runs it from now on.`;
  return 'It only starts by hand, so publishing records this version; give it a schedule, webhook or app trigger to run on its own.';
}

/** Save the draft if needed and publish it (or ask for approval, with four-eyes publishing). */
export async function publishToProduction(): Promise<boolean> {
  const { workflowId, dirty, save } = useEditor.getState();
  if (dirty && !(await save?.())) return false;
  try {
    const result = await publishVersion(workflowId);
    notePublished(workflowId); // SB03: a published workflow is asks-first from here (an approval request counts)
    if (result.approvalRequired) toastApprovalRequested(result);
    else toast.success(`Published version ${result.published?.versionNumber ?? ''}`.trim(), { description: 'Production triggers run this version now' });
    return true;
  } catch (e) {
    toast.error(`Publish failed: ${(e as Error).message}`);
    return false;
  }
}
