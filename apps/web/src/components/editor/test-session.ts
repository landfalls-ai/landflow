'use client';
/**
 * Spotlight's "Test and fix" (docs/assistant.md): run the workflow and, while a run doesn't pass
 * (lib/shared/run-check.ts) or doesn't do what the workflow was drafted for, tell the assistant what went wrong, apply
 * the fix it proposes and run again, up to MAX_FIXES times. Starting a session is the user's go-ahead for those fixes;
 * each one is applied with its own Undo.
 * When a run passes, Spotlight offers to publish the workflow to production. Spotlight's stop button ends the session
 * (a run already going finishes). While it runs, Spotlight shows its progress in a card at the side of the canvas; the
 * session's turns share a `testId`, and once it is over the conversation comes back with them folded into one line and
 * the outcome below.
 */
import { nanoid } from 'nanoid';
import { toast } from 'sonner';
import { checkRun, hollowSteps, multipliedSteps, type CheckedRun, type RunVerdict } from '@/lib/shared/run-check';
import { applyChanges, runDigests, useAssistant, type ReplyPart } from './assistant';
import { publishVersion, toastApprovalRequested } from './publish-control';
import { useEditor } from './store';
import { useTestListener } from './test-listener';

export const MAX_FIXES = 4;

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
  };
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
  run({ kind: 'run' });
  if (!(await until(() => useEditor.getState().running, signal, 3000))) {
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
export async function testUntilItRuns(goal?: string): Promise<void> {
  if (useAssistant.getState().pending || useAssistant.getState().testing) return;
  const abort = new AbortController();
  const { signal } = abort;
  const testId = nanoid(8);
  useAssistant.setState({ testing: abort, open: true, detail: false });
  try {
    let fixes = 0;
    /** What was applied so far: the assistant gets no history, so it hears what didn't help. */
    const tried: string[] = [];
    for (let round = 1; !signal.aborted; round++) {
      const runItem = say([{ kind: 'run', run: { round, state: 'running' } }], testId);
      const result = await runOnce(signal);
      if ('stopped' in result) {
        // The run that didn't happen gives way to why.
        useAssistant.setState((s) => ({ items: s.items.filter((item) => item.id !== runItem) }));
        say([{ kind: 'text', text: result.stopped }]);
        return;
      }
      setRun(runItem, { round, state: result.passed ? 'passed' : 'failed', summary: result.summary });
      // A step that does nothing, or repeats every result, isn't caught by a run: it needs a fix too.
      const hollow = result.passed ? weakSteps() : [];
      const failed = !result.passed || hollow.length > 0;
      if (hollow.length) setRun(runItem, { round, state: 'failed', summary: `no errors, but ${hollow.map((h) => h.problem).join('; ')}` });
      if (!failed && (!goal || fixes >= MAX_FIXES)) {
        say([{ kind: 'action', action: 'publish' }]);
        return;
      }
      if (fixes >= MAX_FIXES) {
        say([{ kind: 'text', text: `Still not right after ${MAX_FIXES} fixes.${result.node ? ` “${result.node}” shows what happened in its panel;` : ''} ask me about it, or change it by hand.` }]);
        return;
      }
      const at = hollow[0]?.node ?? result.node;
      const nodeId = at ? useEditor.getState().nodes.find((n) => n.data.wf.name === at)?.id : undefined;
      const asked = goal ? ` I asked for: “${goal}”.` : '';
      const before = tried.length ? ` Already tried: ${tried.map((t) => `“${t}”`).join('; ')}.` : '';
      const request = !result.passed
        ? `Test run ${round} ${result.summary}. Fix it.${before}`
        : hollow.length
          ? `Test run ${round} had no errors, but ${hollow.map((h) => h.problem).join('; ')}.${asked} Fix it.${before}`
          : `Test run ${round} had no errors: ${result.summary}.${outputOf(result.node)} Does that do what I asked for: “${goal}”? Check each part of what I asked against it. If not, fix it; if it does, say so in one sentence.${before}`;
      useAssistant.setState({ fixing: failed ? nodeId : undefined });
      await useAssistant.getState().send(request, { auto: true, fresh: true, session: failed ? 'fix' : 'review', withoutSelection: true, testId, ...(nodeId && { nodeId }) });
      useAssistant.setState({ fixing: undefined });
      if (signal.aborted) return;
      const reply = useAssistant.getState().items.at(-1);
      if (reply?.role !== 'assistant' || reply.error) {
        say([{ kind: 'text', text: 'I couldn’t work out a fix, so testing stops here.' }]);
        return;
      }
      const proposals = reply.parts.flatMap((p) => (p.kind === 'proposal' && !p.proposal.state ? [p.proposal] : []));
      if (!proposals.length) {
        // Nothing to change: a run without errors does what was asked; a failed one needs the user.
        if (!failed) say([{ kind: 'action', action: 'publish' }]);
        else say([{ kind: 'text', text: 'No change to try, so testing stops here.' }]);
        return;
      }
      const label = proposals.length === 1 ? `Spotlight applied “${proposals[0].summary}”` : `Spotlight applied ${proposals.length} fixes`;
      if (!applyChanges(proposals.map((p) => ({ ops: p.ops, kind: 'proposal' as const })), label)) {
        say([{ kind: 'text', text: 'The fix no longer fits the workflow, so testing stops here.' }]);
        return;
      }
      for (const proposal of proposals) useAssistant.getState().setProposalState(reply.id, proposal.id, 'applied');
      tried.push(...proposals.map((p) => p.summary));
      fixes++;
    }
  } finally {
    // Over: the conversation comes back from the side with the outcome.
    if (useAssistant.getState().testing === abort) useAssistant.setState({ testing: undefined, fixing: undefined, open: true, detail: false });
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
