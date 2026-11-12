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
import { checkRun, hollowSteps, multipliedSteps, needsPerson, sameFailure, sendingSteps, type CheckedRun, type RunVerdict } from '@/lib/shared/run-check';
import { applyChanges, fixedNodes, ownRun, runDigests, undos, useAssistant, type Need, type ReplyPart } from './assistant';
import { agentsSettled } from './new-agent';
import { publishVersion, toastApprovalRequested } from './publish-control';
import { useEditor } from './store';
import { useTestListener } from './test-listener';

export const MAX_FIXES = 4;

/** Workflows whose test runs may send for real, as the person said in this page's life (the `sends` row). */
export const sendsAllowed = new Set<string>();

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
  const { nodes, nodeTypes, workflowId } = useEditor.getState();
  if (!nodes.some((n) => nodeTypes[n.data.wf.type]?.descriptor.kind === 'trigger')) {
    return { what: 'trigger', text: 'Nothing starts this flow yet.', ...(goal && { goal }) };
  }
  const agent = nodes.find((n) => (n.data.wf.type === 'core.messageAgent' && !n.data.wf.parameters.agentId) || (n.data.wf.type === 'core.runTeam' && !n.data.wf.parameters.teamId));
  if (agent && !useAssistant.getState().agents.some((a) => a.nodeId === agent.id)) {
    return { what: 'agent', node: agent.data.wf.name, text: `“${agent.data.wf.name}” has no ${agent.data.wf.type === 'core.runTeam' ? 'team' : 'agent'} picked.`, ...(goal && { goal }) };
  }
  if (sendsAllowed.has(workflowId)) return undefined;
  const sending = sendingSteps(nodes.filter((n) => !n.data.wf.disabled).map((n) => ({ name: n.data.wf.name, type: n.data.wf.type, parameters: n.data.wf.parameters })));
  if (sending.length) {
    const named = sending.slice(0, 2).map((n) => `“${n}”`).join(' and ') + (sending.length > 2 ? ` and ${sending.length - 2} more` : '');
    return { what: 'sends', node: sending[0], text: `A test runs ${named} for real: ${sending.length === 1 ? 'it sends or changes' : 'they send or change'} things outside the flow.`, ...(goal && { goal }) };
  }
  return undefined;
}

/** A failed run only the person can fix, as a row with the button that does it. */
function personNeed(result: RunVerdict, error: string | undefined, goal: string | undefined): Need | undefined {
  const what = needsPerson(error);
  if (!what) return undefined;
  const node = result.node;
  const text =
    what === 'trigger'
      ? 'Nothing starts this flow yet.'
      : what === 'agent'
        ? `“${node}” has no agent picked.`
        : /credential/i.test(error ?? '')
          ? `“${node}” needs ${/No (.+?) credential selected/i.exec(error ?? '')?.[1] ? `a ${/No (.+?) credential selected/i.exec(error ?? '')?.[1]} credential` : 'a credential'} picked.`
          : `“${node}” was refused by the app (${error}): its credential is missing or wrong.`;
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
export async function testUntilItRuns(goal?: string, options: { publishAgents?: boolean } = {}): Promise<void> {
  if (useAssistant.getState().pending || useAssistant.getState().testing) return;
  const abort = new AbortController();
  const { signal } = abort;
  const testId = nanoid(8);
  useAssistant.setState({ testing: abort, fixNotes: {} });
  try {
    // What only the person can do comes first: no run, no fix spent on it.
    const first = beforeTesting(goal);
    if (first) {
      ask(first);
      return;
    }
    let fixes = 0;
    let reviewed = false;
    /** The last failure, to tell a fix that changed nothing. */
    let lastFailure: string | undefined;
    /** What was applied so far: the assistant gets no history, so it hears what didn't help. */
    const tried: string[] = [];
    /** The fixes applied, newest last, for undoing one that changed nothing. */
    const lastApplied: Array<{ item: string; proposal: string }> = [];
    for (let round = 1; !signal.aborted; round++) {
      // An agent Spotlight is still designing (./new-agent.ts): the run needs it saved and pointed at first.
      await agentsSettled();
      const runItem = say([{ kind: 'run', run: { round, state: 'running' } }], testId);
      const result = await runOnce(signal);
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
          if (last) undos.get(last.proposal)?.();
          if (last) useAssistant.getState().setProposalState(last.item, last.proposal, 'undone');
          say([{ kind: 'text', text: `The last fix didn’t change the error${result.node ? ` at “${result.node}”` : ''}, so I undid it and stopped.` }]);
          return;
        }
        lastFailure = sameFailure(result.summary);
      } else lastFailure = undefined;
      // A step that does nothing, or repeats every result, isn't caught by a run: it needs a fix too.
      const hollow = result.passed ? weakSteps() : [];
      const failed = !result.passed || hollow.length > 0;
      if (hollow.length) setRun(runItem, { round, state: 'failed', summary: `no errors, but ${hollow.map((h) => h.problem).join('; ')}` });
      // A pass is reviewed against the goal once: a pass after the review's fix is the outcome.
      if (!failed && (!goal || reviewed || fixes >= MAX_FIXES)) {
        say([{ kind: 'action', action: 'publish' }]);
        return;
      }
      if (fixes >= MAX_FIXES) {
        say([{ kind: 'text', text: `Still failing${result.node ? ` at “${result.node}”` : ''} after ${MAX_FIXES} fixes${result.summary ? `: ${result.summary.replace(/^failed at “[^”]+”:\s*/, '').slice(0, 80)}` : ''}.` }]);
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
      if (!failed) reviewed = true;
      useAssistant.setState({ fixing: failed ? nodeId : undefined });
      await useAssistant.getState().send(request, { auto: true, fresh: true, session: failed ? 'fix' : 'review', withoutSelection: true, testId, ...(nodeId && { nodeId }) });
      useAssistant.setState({ fixing: undefined });
      if (signal.aborted) return;
      const reply = useAssistant.getState().items.at(-1);
      if (reply?.role !== 'assistant' || reply.error) {
        say([{ kind: 'text', text: `I couldn’t work out a fix${result.node ? ` for “${result.node}”` : ''}, so I stopped.` }]);
        return;
      }
      const proposals = reply.parts.flatMap((p) => (p.kind === 'proposal' && !p.proposal.state ? [p.proposal] : []));
      if (!proposals.length) {
        // Nothing to change: a run the review said yes to is ready; a "no" without a fix, or a failed run, needs the person.
        const said = reply.parts.find((p) => p.kind === 'text');
        const yes = said?.kind === 'text' && /^\s*yes\b/i.test(said.text);
        if (!failed && yes) say([{ kind: 'action', action: 'publish' }]);
        else if (!failed) say([{ kind: 'text', text: 'It runs, but doesn’t do all you asked yet, and I have no change for it: tell me what to change.' }]);
        // The reply above already says why.
        else say([{ kind: 'text', text: `I found no fix for “${result.node ?? 'this step'}”, so I stopped. Tell me what it should do, or open it.` }]);
        return;
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
        say([{ kind: 'text', text: 'The canvas changed while I worked, so the fix no longer fits: I stopped.' }]);
        return;
      }
      lastApplied.push({ item: reply.id, proposal: proposals.at(-1)!.id });
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
    // Over: the conversation comes back from the side with the outcome.
    if (useAssistant.getState().testing === abort) useAssistant.setState({ testing: undefined, fixing: undefined });
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
    if (result.approvalRequired) toastApprovalRequested(result);
    else toast.success(`Published version ${result.published?.versionNumber ?? ''}`.trim(), { description: 'Production triggers run this version now' });
    return true;
  } catch (e) {
    toast.error(`Publish failed: ${(e as Error).message}`);
    return false;
  }
}
