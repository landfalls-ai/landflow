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
import { checkRun, destinationsOf, writesOutside, givenKept, hollowSteps, hostOf, multipliedSteps, needsPerson, rawMarkupSteps, isUnreadHost, NO_ADDRESS, sameFailure, type CheckedRun, type RunVerdict } from '@/lib/shared/run-check';
import { applyChanges, editorLookup, fixedNodes, ownRun, runDigests, undos, useAssistant, type ChatItem, type Need, type Outcome, type ReplyPart } from './assistant';
import { nextRound } from './timeline';
import { agentsSettled, itemReaching, smokeTestAgent } from './new-agent'; // SB18:
import { smokeLine, fixLine, type AgentCard, type AgentSmoke } from '@/lib/shared/agent-card'; // SB18: (AG20: fixLine)
import type { AgentFixEvent } from '@/lib/shared/agent-fix'; // AG20:
import { designChange, heldOf, readDraft, type ChangeDesign } from '@/lib/client/agent-change'; // AG20: AG22: heldOf, readDraft
import { api } from '@/lib/client/api'; // AG22:
import { keptToolOf } from '@/lib/shared/kept-tool';
import { agentDestinations } from '@/lib/shared/spotlight-approvals';
import { normalDestination, publishedLine, SPOTLIGHT_APPROVALS, unattendedLine, type SpotlightRunApprovals } from '@/lib/shared/fix-autonomy'; // AG22:
import { agentReplyText, agentUndoneBy, destinationsInText, droppedLine, fixAutonomyNow, fixesOf, heldLine, heldRequest, KEEP_REASON, keptTools, leftForNextRound, duplicatedSteps, sameFixTwice, toolsAdded, undoneBy, withoutSecrets, fixRemovals, type OwnFix, type RemovalsAllowed } from './fix-session'; // AG22:
import { followsPractices, guardrailWords, type AgentConfig } from '@/lib/shared/agents'; // AG20:
import { useBubbleData } from '@/lib/client/agent-bubble-data'; // ag4 review: the agent's name in what is left
import { pickedModel } from './spotlight-model'; // AG20:
import { publishVersion, toastApprovalRequested } from './publish-control';
import { autonomyOf, notePublished, type Autonomy } from './spotlight-autonomy'; // SB03:
import { agentBrief, type AgentBrief } from '@/lib/shared/agent-brief'; // wave ag5 fix pass: removals
import { useEditor } from './store';
import { testTriggerFor, useTestListener } from './test-listener';

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

/**
 * SB18: one yes per `scheme://host:port`. `destinationsOf` (lib/shared/run-check.ts) gives `host:port`; an HTTP Request's
 * plain-text URL adds its scheme here, so `https://x` and `http://x` ask apart. A step with an expression or no address keeps
 * what it had.
 */
export function withScheme(destination: string, type: string, url: unknown): string {
  if (type !== 'core.httpRequest' || isUnreadHost(destination) || destination === NO_ADDRESS) return destination;
  const scheme = /^\s*=?\s*(https?):\/\//i.exec(String(url ?? ''))?.[1]?.toLowerCase();
  return scheme ? `${scheme}://${destination}` : destination;
}

/** Whether the person said yes to this destination: its own scheme, or, for a bare `host:port` from before schemes, `http` only. */
function allowedBy(allowed: Set<string> | undefined, destination: string): boolean {
  if (!allowed) return false;
  if (allowed.has(destination)) return true;
  const bare = /^http:\/\/(.+)$/i.exec(destination)?.[1];
  return Boolean(bare && allowed.has(bare));
}

/** The enabled steps that would send for real, each with its own destination. */
function sendingNow(): Sending[] {
  const { nodes, workflowId } = useEditor.getState();
  const live = nodes.filter((n) => !n.data.wf.disabled);
  return destinationsOf(live.map((n) => ({ name: n.data.wf.name, type: n.data.wf.type, parameters: n.data.wf.parameters }))).map((d) => {
    const step = live.find((n) => n.data.wf.name === d.node);
    return { ...d, destination: withScheme(d.destination, step?.data.wf.type ?? '', step?.data.wf.parameters.url), key: `${workflowId} ${step?.id ?? d.node} ${JSON.stringify(step?.data.wf.parameters.url ?? '')}` }; // SB18:
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
  forgetPendingYes(workflowId); // SB18: the row it answered is not kept for a reload any more
}

// SB18: a "Run it for real" row still waiting survives a reload of the page (this tab only, by workflow): its words, its
// destinations and its goal, never a yes.
const PENDING_KEY = (workflowId: string) => `landflow-spotlight-run-for-real:${workflowId}`;
const sticky = (need: Need | undefined) => (need && (need.what === 'sends' || need.what === 'destination') && !need.state ? need : undefined);

function writePending(workflowId: string, need: Need | undefined) {
  try {
    if (!workflowId) return;
    if (!need) sessionStorage.removeItem(PENDING_KEY(workflowId));
    else {
      const { what, text, destinations, nodes, once, node, goal } = need;
      sessionStorage.setItem(PENDING_KEY(workflowId), JSON.stringify({ what, text, destinations, nodes, once, node, goal }));
    }
  } catch {
    // Private mode or no storage: the row is not kept, as before.
  }
}

/** The pending row kept for this workflow in this tab, if any (never carries a yes). */
export function pendingNeedFor(workflowId: string): Need | undefined {
  try {
    const raw = sessionStorage.getItem(PENDING_KEY(workflowId));
    const need = raw ? (JSON.parse(raw) as Need) : undefined;
    return sticky(need && { ...need, state: undefined });
  } catch {
    return undefined;
  }
}

function forgetPendingYes(workflowId: string) {
  writePending(workflowId, undefined);
}

/** Keeps the open "Run it for real" row in step with the conversation, and brings it back when the workflow reopens. */
function watchPending() {
  let boundTo = '';
  let kept: Need | undefined;
  const openNeed = () => {
    for (const item of useAssistant.getState().items) if (item.role === 'assistant') for (const part of item.parts) if (part.kind === 'needs' && sticky(part.need)) return part.need;
    return undefined;
  };
  const sync = () => {
    const { workflowId, items } = useAssistant.getState();
    if (!workflowId) return;
    if (workflowId !== boundTo) {
      boundTo = workflowId;
      kept = undefined;
      // A workflow opened: its pending row comes back, still waiting for the click.
      const need = pendingNeedFor(workflowId);
      if (need && !items.length) {
        say([{ kind: 'needs', need }]);
        kept = need;
      }
      return;
    }
    const open = openNeed();
    if (open !== kept) {
      kept = open;
      writePending(workflowId, open);
    }
  };
  useAssistant.subscribe(sync);
  sync();
}
watchPending();

/**
 * AG22: the destinations an autonomous fix session counts as given: the ones a saved or published flow already sent to when the
 * session started, and the ones the person's words name. A brand-new draft's own URLs are the builder's, not the person's: they
 * still ask (lesson 21). The run request carries them as the approvals' `destinations`.
 */
function givenDestinations(workflowId: string, goal: string | undefined): string[] {
  const words = [goal, useEditor.getState().description, ...useAssistant.getState().items.flatMap((i) => (i.role === 'user' && !i.auto ? [i.text] : []))].filter(Boolean).join('\n');
  const own = autonomyOf(workflowId) === 'auto' ? [] : sendingNow().map((d) => d.destination).filter((d) => !isUnreadHost(d) && d !== NO_ADDRESS);
  return [...new Set([...own, ...destinationsInText(words)])];
}

/** The destinations the Run an Agent steps' own agents fix in their saved config (each asks-first node tool's fixed To, URL or channel): a snapshot, read once when a session starts. */
const boundAgentIds = (): string[] => [...new Set(useEditor.getState().nodes.flatMap((n) => (n.data.wf.type === 'core.messageAgent' && !n.data.wf.disabled && typeof n.data.wf.parameters?.agentId === 'string' && n.data.wf.parameters.agentId ? [n.data.wf.parameters.agentId] : [])))];
async function agentConfigDestinations(): Promise<string[]> {
  const ids = boundAgentIds();
  const found = await Promise.all(ids.map((id) => api<{ agent?: { tools?: AgentConfig['tools'] } }>(`/api/agents/${id}`, { background: true }).then((r) => agentDestinations({ tools: r.agent?.tools ?? [] }), () => [] as string[])));
  return found.flat();
}

/** The enabled steps that would send for real, grouped by what the person has not said yes to yet. */
function unapproved(): Sending[] {
  const allowed = sendsAllowed.get(useEditor.getState().workflowId);
  return sendingNow().filter((d) => !allowedBy(allowed, d.destination) && !approvedOnce.has(d.key)); // SB18:
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
  // AG20: an agent step whose reply is raw tool-call markup did not answer, whatever the run's status says.
  const digests = runDigests();
  const replies = steps.map((s) => {
    const sample = digests[s.id]?.outputs[0]?.sample;
    return { name: s.name, type: s.type, reply: sample === undefined ? undefined : JSON.stringify(sample) };
  });
  return [...hollowSteps(steps), ...multipliedSteps(canvasRun(), steps), ...rawMarkupSteps(replies)];
}


/**
 * ag5 carryover (the live pass's G): a flow whose trigger waits for a test event (a Webhook or Form trigger with no pinned
 * data) is tested with the event that trigger got last (the newest run that reached it, production or test), so the session
 * runs instead of stopping at "send one". Undefined when it never got one: then the run listens, as before.
 */
async function lastTriggerEvent(): Promise<{ items: Array<{ json: Record<string, unknown> }>; trigger: string; at: string } | undefined> {
  const nodeId = testTriggerFor({ kind: 'run' });
  if (!nodeId) return undefined;
  const { workflowId, nodes } = useEditor.getState();
  const trigger = nodes.find((n) => n.id === nodeId)?.data.wf.name ?? 'the trigger';
  try {
    const { executions } = await api<{ executions: Array<{ id: string; startedAt?: string }> }>(`/api/executions?workflowId=${encodeURIComponent(workflowId)}&limit=5`, { background: true });
    for (const summary of executions) {
      const { execution } = await api<{ execution: { startedAt?: string; runData?: Record<string, Array<{ outputs?: Array<Array<{ json?: Record<string, unknown> }>> }>> } }>(`/api/executions/${summary.id}`, { background: true });
      const item = execution.runData?.[nodeId]?.[0]?.outputs?.[0]?.[0]?.json;
      if (!item) continue;
      return { items: [{ json: withoutSecrets(item) }], trigger, at: execution.startedAt ?? summary.startedAt ?? '' };
    }
  } catch {
    /* no run to read: the run listens */
  }
  return undefined;
}

/** Run the workflow once and judge it; `stopped` when the session can't go on. */
async function runOnce(signal: AbortSignal, approvals?: SpotlightRunApprovals /* AG22: */, testId?: string): Promise<RunVerdict | { stopped: string }> {
  await until(() => !useEditor.getState().running, signal);
  if (signal.aborted) return { stopped: 'Stopped.' };
  const { run } = useEditor.getState();
  if (!run) return { stopped: 'The editor can’t run the workflow right now.' };
  const last = await lastTriggerEvent(); // ag5 carryover: a trigger that waits for a test event is tested with its last event
  if (signal.aborted) return { stopped: 'Stopped.' };
  if (last) say([{ kind: 'text', text: `I test it with the last call “${last.trigger}” got${last.at ? ` (${new Date(last.at).toLocaleString()})` : ''}, since it waits for a test event.` }], testId);
  // This run is Spotlight's: its end is a row of the timeline, even once the session is over (no toast).
  run({ kind: 'run', by: 'spotlight', ...(approvals && { approvals }), ...(last && { items: last.items }) }); // AG22: an autonomous fix session lets Spotlight approve its test run's tool calls
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
  if (runStatus === 'waiting') return { stopped: waitingLine() }; // AG22: an agent approval says so
  return checkRun(canvasRun());
}

/**
 * AG22: why a waiting test run stops the session: a tool approval Spotlight may not give (a destination nobody gave) says so, as
 * *Needs you*; any other wait keeps the line it had.
 */
export function waitingLine(): string {
  const { wait } = useEditor.getState();
  const approval = wait?.data?.approval as { calls?: Array<{ tool?: string; name?: string; destinations?: string[] }> } | undefined;
  if (approval) {
    const call = approval?.calls?.find((c) => !('state' in c)) ?? approval?.calls?.[0];
    const tool = call?.tool ?? call?.name;
    const to = call?.destinations?.[0];
    return `A test run waits for your approval${tool ? ` of “${tool}”` : ''}${to ? ` to ${to}` : ''}: Needs you, then test again.`;
  }
  return 'The run is waiting (a Wait node, a form or an approval) and goes on in the background, so testing stops here.';
}

/** AG22: the reply of each enabled Run an Agent step (and the tool calls its output lists), for the review beside the last node's output. */
function agentReply(): string {
  const digests = runDigests();
  const steps = useEditor.getState().nodes.filter((n) => n.data.wf.type === 'core.messageAgent' && !n.data.wf.disabled).map((n) => ({ name: n.data.wf.name, sample: digests[n.id]?.outputs[0]?.sample }));
  return agentReplyText(steps);
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

// SB18: what carries a session on after the person's yes ("Run it for real", a pick, a Publish): by workflow, in this page's life.
interface Paused {
  fixes: number;
  startNodes: Array<{ id: string; name: string; enabled: boolean }>;
  tried: string[];
  lastApplied: Array<{ item: string; proposals: string[] }>;
  lastFailure: string | undefined;
  lastFix?: 'flow' | 'agent';
  reviewedAt: number | undefined;
  ran: boolean;
  autonomy: Autonomy;
  publishAgents: boolean | undefined;
  ownFixes: OwnFix[]; // AG22: what this session fixed, which no later round undoes
  given: string[]; // AG22: the destinations given to this session
  changedAgents: ChangedAgent[]; // AG22:
  ownNodes: string[]; // wave ag5 fix pass: the node ids this session's applied proposals created
}
/** AG22: an agent the session changed, and whether its change is published. */
interface ChangedAgent {
  agentId: string;
  name: string;
  published: boolean;
}
const paused = new Map<string, Paused>();

/** SB18: what each step put out, field by field, for the review ("“Reply” has: answer, tokens"). */
export function outputFields(): string {
  const { nodes } = useEditor.getState();
  const digests = runDigests();
  const lines = nodes.flatMap((n) => {
    const first: unknown = digests[n.id]?.outputs[0]?.sample;
    const sample = Array.isArray(first) ? first[0] : first;
    if (!sample || typeof sample !== 'object' || Array.isArray(sample)) return [];
    const keys = Object.keys(sample as Record<string, unknown>).slice(0, 12);
    return keys.length ? [`“${n.data.wf.name}” has: ${keys.join(', ')}`] : [];
  });
  return lines.length ? ` Fields each step put out: ${lines.slice(0, 12).join('; ')}.` : '';
}

/**
 * SB18: the part of the goal a review says did not happen, from its reply ("No, it never sends the email"); undefined when
 * the reply names none, which reads as a pass.
 */
export function missingPart(text: string): string | undefined {
  if (/^\s*(?:yes|yep|yeah)\b/i.test(text)) return undefined;
  // Every reply that is not a yes counts as a no; a leading no / not yet / not quite is dropped before the named part.
  const rest = text.replace(/^\s*(?:no|not yet|not quite)\b[\s,.:;!-]*/i, '');
  const first = rest.split(/(?<=[.!?])\s/)[0]?.trim().replace(/[.!?]+$/, '') ?? '';
  return first.split(/\s+/).filter(Boolean).length >= 3 ? first : undefined;
}

/** SB18: the part of the goal a review reply names, from its text. */
const missingPartOf = (reply: { parts: ReplyPart[] }) => {
  const said = reply.parts.find((p) => p.kind === 'text');
  return said?.kind === 'text' ? missingPart(said.text) : undefined;
};

/** SB18: the agent a failed run stopped at ("Publish “X” first") when Spotlight made that agent for the step. */
function unpublishedAgentAt(node: string | undefined, error: string | undefined) {
  if (!node || !/^\s*Publish “.+” first/.test(error ?? '')) return undefined;
  const step = useEditor.getState().nodes.find((n) => n.data.wf.name === node);
  return step && useAssistant.getState().agents.find((a) => a.nodeId === step.id && a.agentId && !a.taken);
}

// AG20: what Spotlight reads of a failed run besides its one-line summary: the response body an HTTP node got back.
const errorBody = (node: string | undefined): string => {
  const step = node ? useEditor.getState().nodes.find((n) => n.data.wf.name === node) : undefined;
  return (step && runDigests()[step.id]?.error?.description) || '';
};

/** AG20: the cause in one clause, "HTTP 400 (… the JSON body needs a non-empty string field "report_text" …)": the error and its body's first words. */
const causeOf = (summary: string, body: string): string => {
  const error = summary.replace(/^failed at “[^”]+”:\s*/, '').slice(0, 80);
  const words = body.replace(/\s+/g, ' ').trim().split(' ').slice(0, 14).join(' ');
  return words ? `${error} (${words})` : error;
};

/**
 * AG20: what is left when a pass falls short and nothing can be proposed: when the missing part reads like a tool the
 * agent lacks, the step to connect it at ("connect a tool to “Question answerer”"), else the step to open.
 */
function leftForAgent(node: string | undefined, part?: string): string {
  const agentStep = useEditor.getState().nodes.find((n) => n.data.wf.type === 'core.messageAgent' && (n.data.wf.name === node || !node)) ?? useEditor.getState().nodes.find((n) => n.data.wf.type === 'core.messageAgent');
  const stepName = agentStep?.data.wf.name;
  // The agent's own name (the bubbles' read of it), else the step's.
  const agentId = typeof agentStep?.data.wf.parameters?.agentId === 'string' ? agentStep.data.wf.parameters.agentId : '';
  const known = agentId ? Object.entries(useBubbleData.getState().answers).find(([k, a]) => a && k.startsWith(`${agentId}|`))?.[1] : undefined;
  const name = known?.agent.name || stepName;
  if (name && /\b(?:tool|isn.t available|not available|no access|can.?t (?:query|reach|read|send)|lacks?|doesn.t have|has no)\b/i.test(part ?? 'tool')) {
    // What it lacks, as the person's words say it: a quoted name (a credential or tool), else "the <thing> tool".
    const lacking = /[“"]([^”"]{2,40})[”"]/.exec(part ?? '')?.[1] ?? /\b(?:the |a |an )?((?:[\w-]+ ){0,2}(?:tool|credential|connection))\b/i.exec(part ?? '')?.[1];
    // A phrase that is itself a complaint (“lacks a tool”, “has no tool”) names nothing: say “the tool it needs”.
    const names = lacking && !/\b(?:lacks?|has|have|no|an?|any|doesn.t|isn.t|not)\b/i.test(lacking) ? lacking : undefined;
    return `connect ${names ? `“${names}”` : 'the tool it needs'} to “${name}” (the + under Tool on the step), then tell me to test again, or tell me what to change.`;
  }
  return `open ${node ? `“${node}”` : 'the step'} and change it by hand, or tell me what to change.`;
}

/** Re-check 3: the rule the retry (and the review prompt) carries: an agent that states facts with nothing that could give them invents them. */
const AGENT_FACTS_RULE = 'An agent that states facts (numbers, records, names) with no tool or knowledge that could give them is inventing them: read the run log (get_run_log; its tool list says none) and call propose_agent_fix to connect the source the tenant has (list_tool_nodes, list_credentials), never a change to the flow or its prompt.';

/** AG20: what is left for the person when the same failure comes twice. */
const leftFor = (node: string | undefined) => `open ${node ? `“${node}”` : 'the step'} and fix it by hand, or tell me what it should do instead.`;

/** The change card's body from the design route's config (the same fields `cardFromPreview` fills; it cannot be imported here without a cycle with autonomous.ts). */
function cardOf(config: Partial<AgentConfig>, name: string, needs: Array<{ text: string }> = [], missing: Array<{ capability: string }> = []): AgentCard {
  const tools = config.tools ?? [];
  const knowledge = tools.find((t) => t.type === 'knowledge');
  return {
    name: config.name || name,
    description: config.description || '',
    ...(config.model && { model: `${config.model.provider}/${config.model.model}` }),
    tools: tools
      .filter((t) => t.type !== 'knowledge')
      .map((t) => {
        const node = t.type === 'node' ? t : undefined;
        const operation = typeof node?.parameters?.operation === 'string' ? node.parameters.operation : undefined;
        const requireApproval = Boolean(t.requireApproval);
        return { name: ('name' in t && t.name) || t.type, ...(node && { type: node.nodeType }), ...(operation && { operation }), writes: Boolean(node && (requireApproval || writesOutside({ type: node.nodeType, parameters: node.parameters ?? {} }))), requireApproval };
      }),
    ...(knowledge && knowledge.type === 'knowledge' && { knowledge: ('collection' in knowledge && knowledge.collection) || knowledge.name }),
    practices: followsPractices(config.practices),
    guardrails: guardrailWords(config.guardrails),
    cases: [],
    needs: needs.map((n) => n.text),
    missing: missing.map((m) => m.capability),
    config: config as Record<string, unknown>,
    state: 'designed',
  };
}

/**
 * The agent change card of an `agent-fix`, as the AG04 change card with the failed run's `fix` on it. Asks first: it waits for the
 * person's Apply (a saved agent is not a brand-new draft). AG22: in an autonomous fix session (`own.auto`) the card is shown as
 * applied (the session applies it right after), the design carries `keep` (the tools this session added) and a design that
 * removes one of them is dropped: `{ undone }`, nothing shown.
 */
async function showAgentFix(event: AgentFixEvent, attempt: number, signal: AbortSignal, testId: string, typedAsk = '', own?: { fixes: readonly OwnFix[]; auto: boolean }): Promise<string | { undone: OwnFix } | { noChange: true } | undefined> {
  try {
    const kept = own ? keptTools(event.agentId, own.fixes) : [];
    const base = own ? await readDraft(event.agentId) : undefined; // AG22: the tools it had, to tell what the change adds
    const design = await designChange({ name: event.agent, description: '', base: { agentId: event.agentId }, change: event.change, typedAsk, namedBy: `${event.fix.cause ?? ''}\n${typedAsk}` /* a tool the cause and the person's ask do not name is not added (the model's change text names only a read) */, ...(kept.length && { keep: { tools: kept, reason: KEEP_REASON } }), ...pickedModel() }, signal);
    // AG22: never undo the session's own tool. ag5 carryover (join 1): the design route puts a kept tool back (`keep`, AG24) and says so in
    // `dropped`, so a design that tried to remove one never shows it missing: that line counts as the undo, and the design is dropped.
    const restored = own ? ((design as { dropped?: string[] }).dropped ?? []).flatMap((line) => keptToolOf(line) ?? []) : [];
    const undone = own && (agentUndoneBy(event.agentId, design.config, own.fixes) ?? (restored.length ? own.fixes.find((f) => f.kind === 'agent' && f.agentId === event.agentId && f.toolsAdded?.some((t) => restored.includes(t))) : undefined));
    if (undone) return { undone };
    // Wave ag5 fix pass: a design that changes nothing publishes nothing: an autonomous session stops here, before any card or empty agent version.
    if (own?.auto && design.changes.length === 0) return { noChange: true };
    const fix = { ...event.fix, attempt };
    const card: AgentCard = { ...cardOf(design.config as Partial<AgentConfig>, event.agent, design.needs, design.missing), base: { agentId: event.agentId, name: event.agent }, changes: design.changes, cases: design.cases ?? [], ...(design.replaceCases?.length && { replaceCases: design.replaceCases }), askedChange: event.change, typedAsk, fix };
    if (own?.auto) card.state = 'creating'; // AG22: applied by the session, not waiting for a click
    if (own) lastDesign = { design, added: toolsAdded(base, design.config) };
    const id = nanoid(8);
    useAssistant.getState().append([{ id, role: 'assistant', testId, parts: [{ kind: 'text', text: fixLine(event.agent, fix) }, { kind: 'agentCard', card }] }]);
    return id;
  } catch (e) {
    if (!signal.aborted) say([{ kind: 'text', text: `I couldn’t design the change to “${event.agent}”: ${(e as Error).message}` }]);
    return undefined;
  }
}
/** AG22: the design the last `showAgentFix` made and the tools it adds (read by the session right after). */
let lastDesign: { design: ChangeDesign; added: string[] } | undefined;

/** The applied change's test stopped for a credential: the person picks it on the card (Pick it), in place. */
const needsPick = (card: AgentCard) => card.smoke?.state === 'untested' && Boolean(card.smoke.reason?.startsWith('needs a credential'));

/** The card of an item, or undefined once it is gone (dismissed, a new conversation). */
const cardIn = (itemId: string): AgentCard | undefined => {
  const item = useAssistant.getState().items.find((i) => i.id === itemId);
  const part = item?.role === 'assistant' ? item.parts.find((p) => p.kind === 'agentCard') : undefined;
  return part?.kind === 'agentCard' ? part.card : undefined;
};

/**
 * Waits for the person on the agent's change card: Apply (saves the draft and smoke-tests it), then Publish (through the
 * gate). Undefined when the agent is published and the session can run again; else why it stops.
 */
export async function agentFixOutcome(itemId: string, signal: AbortSignal): Promise<string | undefined> {
  // Once Apply has saved the change, "kept it as it was" would be wrong: the draft holds the change, it is just not published.
  let applied = false;
  const kept = () => (applied ? 'The change is saved to the draft, not published.' : 'You kept the agent as it was.');
  const settled = () => {
    const card = cardIn(itemId);
    if (card?.state === 'created') applied = true;
    // A test that stopped for a credential is not an answer: the card offers Pick it, and the session waits for the pick (its smoke result lands on the card).
    return !card || card.state === 'failed' || (card.state === 'created' && card.smoke?.state !== 'testing' && card.smoke !== undefined && !needsPick(card));
  };
  if (!(await untilAssistant(settled, signal))) return signal.aborted ? undefined : kept();
  let card = cardIn(itemId);
  if (!card) return kept();
  if (card.state === 'failed') return `Saving the change to “${card.name}” failed: ${card.error ?? 'unknown error'}. Left: open the agent and try again.`;
  if (card.smoke?.state !== 'passed') return `The change to “${card.name}” did not pass its test (${smokeLine(card.smoke)}). Left: open the agent and look at what it did.`;
  const published = () => {
    const now = cardIn(itemId);
    if (now?.state === 'created') applied = true;
    return !now || (now.publish !== undefined && now.publish.state !== 'publishing');
  };
  if (!(await untilAssistant(published, signal))) return signal.aborted ? undefined : kept();
  card = cardIn(itemId);
  if (!card) return kept();
  if (card.publish?.state === 'published') return undefined;
  if (card.publish?.state === 'held') return `Publishing “${card.name}” is held by its eval gate${card.publish.reason ? `: ${card.publish.reason}` : ''}. Left: open the agent, look at its cases, then publish it.`;
  return `Publishing “${card.name}” failed${card.publish?.reason ? `: ${card.publish.reason}` : ''}. Left: open the agent and publish it.`;
}

/**
 * AG22: what the session calls to apply and publish an agent change card and to pick a credential: the card's own code
 * (spotlight/agent-ask.ts, spotlight/agent-credential-picker.tsx) registers itself here when it loads.
 */
export const agentFixHooks: {
  apply?: (itemId: string, card: AgentCard) => Promise<void>;
  publish?: (itemId: string, card: AgentCard) => Promise<void>;
  pick?: (agentId: string) => Promise<{ state: 'picked'; smoke: AgentSmoke; line: string } | { state: 'ask' | 'none' | 'nothing' }>;
} = {};

/**
 * AG22: an autonomous fix session's agent fix: the card is applied by the session (the draft saved with its cases swapped, the
 * smoke test), the credential is picked when exactly one fits (several: the session waits on Pick it), the change is published
 * through the eval gate. A held gate is a finding: the line says the score, then one more fix from the lowest cases, then publish
 * again; out of fixes it stops with the verdict. It never skips the eval gate and never publishes anyway.
 */
async function autoAgentFix(ctx: { event: AgentFixEvent; signal: AbortSignal; testId: string; goal: string; fixes: number; ownFixes: OwnFix[]; changedAgents: ChangedAgent[]; tried: string[] }): Promise<{ kind: 'done'; used: number } | { kind: 'dropped'; used: number } | { kind: 'stop'; used: number; text: string }> {
  const { event, signal, testId, goal, ownFixes, changedAgents } = ctx;
  const hooks = agentFixHooks; // registered by agent-ask.ts and agent-credential-picker.tsx (they reach this module through ./autonomous: no import cycle)
  if (!hooks.apply || !hooks.publish) return { kind: 'stop', used: 0, text: `I couldn’t apply the change to “${event.agent}” here: the agent card isn’t loaded. Left: open the agent and apply it.` };
  let change = event.change;
  let used = 0;
  for (;;) {
    const attempt = ctx.fixes + used + 1;
    const shown = await showAgentFix({ ...event, change }, attempt, signal, testId, goal, { fixes: ownFixes, auto: true });
    if (signal.aborted) return { kind: 'stop', used, text: '' };
    if (!shown) return { kind: 'stop', used, text: `I couldn’t work out a change to “${event.agent}”.` };
    if (typeof shown === 'object' && 'noChange' in shown) return { kind: 'stop', used, text: `The design for “${event.agent}” changes nothing, so I changed and published nothing. Left: open the agent and change it, or tell me what it should do instead.` };
    if (typeof shown === 'object') {
      say([{ kind: 'text', text: droppedLine(shown.undone) }], testId);
      return { kind: 'dropped', used };
    }
    const designed = lastDesign;
    let card = cardIn(shown);
    if (!card) return { kind: 'stop', used, text: 'You kept the agent as it was.' };
    await hooks.apply(shown, card);
    used++;
    ownFixes.push({ kind: 'agent', agentId: event.agentId, toolsAdded: designed?.added ?? [], summary: designed?.added.length ? `added ${designed.added.map((t) => `“${t}”`).join(', ')} to “${event.agent}”` : `changed “${event.agent}”` });
    if (!changedAgents.some((a) => a.agentId === event.agentId)) changedAgents.push({ agentId: event.agentId, name: event.agent, published: false });
    for (const a of changedAgents) if (a.agentId === event.agentId) a.published = false;
    const settled = () => {
      const c = cardIn(shown);
      return !c || c.state === 'failed' || (c.state === 'created' && c.smoke !== undefined && c.smoke.state !== 'testing');
    };
    if (!(await untilAssistant(settled, signal))) return { kind: 'stop', used, text: '' };
    card = cardIn(shown);
    if (!card) return { kind: 'stop', used, text: 'You kept the agent as it was.' };
    if (card.state === 'failed') return { kind: 'stop', used, text: `Saving the change to “${card.name}” failed: ${card.error ?? 'unknown error'}. Left: open the agent and try again.` };
    if (needsPick(card)) {
      const picked = await (hooks.pick?.(event.agentId) ?? Promise.resolve({ state: 'ask' as const })).catch(() => ({ state: 'ask' as const }));
      if (picked.state === 'picked') say([{ kind: 'text', text: picked.line }], testId);
      else if (picked.state === 'none') return { kind: 'stop', used, text: `The change to “${card.name}” needs a credential and none you have fits it. Left: create one (Pick it, then Create one), then tell me to test again.` };
      else if (picked.state === 'ask' && !(await untilAssistant(() => !cardIn(shown) || !needsPick(cardIn(shown)!), signal))) return { kind: 'stop', used, text: '' };
      card = cardIn(shown);
      if (!card) return { kind: 'stop', used, text: 'You kept the agent as it was.' };
    }
    if (card.smoke?.state !== 'passed') return { kind: 'stop', used, text: `The change to “${card.name}” did not pass its test (${smokeLine(card.smoke)}). Left: open the agent and look at what it did.` };
    await hooks.publish(shown, card);
    if (signal.aborted) return { kind: 'stop', used, text: '' };
    card = cardIn(shown);
    if (card?.publish?.state === 'published') {
      for (const a of changedAgents) if (a.agentId === event.agentId) a.published = true;
      return { kind: 'done', used };
    }
    if (card?.publish?.state === 'held') {
      const held = heldOf(event.agentId);
      const line = heldLine(card.name, held, card.publish.reason);
      say([{ kind: 'text', text: line }], testId);
      if (ctx.fixes + used >= MAX_FIXES) return { kind: 'stop', used, text: `${line} I am out of fixes. Left: open the agent, look at its cases, then publish it.` };
      change = heldRequest(card.name, line, held?.lowCases ?? []);
      continue;
    }
    return { kind: 'stop', used, text: `Publishing “${card?.name ?? event.agent}” failed${card?.publish?.reason ? `: ${card.publish.reason}` : ''}. Left: open the agent and publish it.` };
  }
}

/**
 * AG22: the end of an autonomous fix session that passed: every agent the session changed is published (the gate runs; most are
 * published by their own fix already), then the workflow, with no `agents` choice: the agents' new versions are what its draft
 * pins (`publish-first` and `as-published` are never sent). Reads the versions back and says `publishedLine`, then
 * `unattendedLine` for each asks-first tool the unattended route lists. Four-eyes publishing: the publish is a request, said.
 * Returns whether it published.
 */
async function publishAtEnd(ctx: { signal: AbortSignal; testId: string; changedAgents: ChangedAgent[] }): Promise<boolean> {
  const { signal, testId, changedAgents } = ctx;
  const { publishChange } = await import('@/lib/client/agent-change');
  for (const a of changedAgents.filter((c) => !c.published)) {
    const result = await publishChange(a.agentId);
    if (result.state === 'published') a.published = true;
    else {
      const line = result.state === 'held' ? heldLine(a.name, heldOf(a.agentId), result.reason) : `Publishing “${a.name}” failed${result.reason ? `: ${result.reason}` : ''}.`;
      say([{ kind: 'outcome', outcome: { text: `${line} Left: open the agent, look at its cases, then publish it.`, fixes: [], edits: useEditor.getState().edits } }]);
      return false;
    }
  }
  if (signal.aborted) return false;
  const { workflowId, dirty, save } = useEditor.getState();
  if (dirty && !(await save?.())) {
    say([{ kind: 'outcome', outcome: { text: 'It passed, but I couldn’t save the flow, so nothing is published. Left: save it, then publish.', fixes: [], edits: useEditor.getState().edits } }]);
    return false;
  }
  try {
    const result = await publishVersion(workflowId); // no `agents`: the agents are published, so the draft's pins are their new versions
    notePublished(workflowId);
    if (result.approvalRequired) {
      toastApprovalRequested(result);
      say([{ kind: 'text', text: 'Publishing needs a second person: I sent the request for an approver. Nothing is live until it is approved.' }], testId);
      return true;
    }
    const versionId = result.published?.versionId;
    const pins = versionId ? await api<{ pins: Array<{ agentName?: string; nodeName?: string; version: number }> }>(`/api/workflows/${workflowId}/versions/${versionId}/pins`, { background: true }).then((r) => r.pins, () => []) : [];
    const agents = pins.map((p) => ({ name: p.agentName ?? p.nodeName ?? 'agent', version: p.version }));
    say([{ kind: 'text', text: publishedLine(result.published?.versionNumber ?? 0, agents) }], testId);
    // AG22: AG23's route (GET /api/workflows/:id/unattended-approvals) lists the asks-first tools a trigger run refuses; a host without it lists none (the integrator wires the route's shape).
    type Unattended = { tool: string; trigger?: string; line?: string };
    const unattended = await api<Unattended[] | { tools?: Unattended[] }>(`/api/workflows/${workflowId}/unattended-approvals`, { background: true }).then((r) => (Array.isArray(r) ? r : r.tools ?? []), () => [] as Unattended[]);
    for (const t of unattended) say([{ kind: 'text', text: t.line ?? unattendedLine(t.tool, t.trigger ?? 'trigger') }], testId);
    return true;
  } catch (e) {
    const body = (e as { body?: { code?: string; agents?: Array<{ name: string }> } }).body;
    say([{ kind: 'outcome', outcome: { text: body?.code === 'agent_changes_unpublished' ? `Publishing the workflow stopped: ${(body.agents ?? []).map((a) => `“${a.name}”`).join(', ')} has changes that are not published. Left: publish the agent, then the workflow.` : `Publishing the workflow failed: ${(e as Error).message}.`, fixes: [], edits: useEditor.getState().edits } }]);
    return false;
  }
}

/**
 * Run, fix, run again until a run passes, MAX_FIXES fixes are spent, or the user stops it. With a `goal` (the description
 * the workflow was drafted from), a run without errors is checked against it as well: the assistant compares the output
 * with the goal and fixes what doesn't match.
 */
/** `publishAgents`: an agent a fix creates is published so the next run can use it (autonomous mode, ./autonomous.ts). */
export async function testUntilItRuns(goal?: string, options: { publishAgents?: boolean; autonomy?: Autonomy; resume?: boolean } = {}): Promise<void> {
  if (useAssistant.getState().pending || useAssistant.getState().testing) return;
  const abort = new AbortController();
  const { signal } = abort;
  const testId = nanoid(8);
  useAssistant.setState({ testing: abort, testingId: testId, fixNotes: {} });
  const wfId = useEditor.getState().workflowId;
  // SB18: the person's yes goes on with the same session (its fixes, its starting steps, what it tried), never a fresh one.
  const resumed = options.resume ? paused.get(wfId) : undefined;
  paused.delete(wfId);
  try {
    let fixes = resumed?.fixes ?? 0;
    // SB03: the fixes applied when the last review was asked; a pass is reviewed again after any fix since.
    let reviewedAt: number | undefined = resumed?.reviewedAt;
    /** SB03: what Spotlight may do alone, and the steps the flow had when the session started. */
    // AG22: a test-and-fix session takes the switch alone (decision of 2026-11-18), on a saved or published flow too; builds keep autonomyOf.
    const autonomy: Autonomy = options.autonomy ?? resumed?.autonomy ?? fixAutonomyNow();
    /** AG22: what this session fixed (no later round undoes it), the agents it changed and the destinations given to it. */
    const ownFixes: OwnFix[] = resumed?.ownFixes ?? [];
    const changedAgents: ChangedAgent[] = resumed?.changedAgents ?? [];
    /** Wave ag5 fix pass: the steps this session added (an autonomous session removes or replaces them without a click). */
    const ownNodes = new Set<string>(resumed?.ownNodes ?? []);
    // Wave ag5 fix pass 2: the destinations the bound agents' own configs fix, as they stand NOW (when the session starts): the server no
    // longer reads the draft, which this session may edit, so an address the session sets later is never given by being configured.
    const given: string[] = resumed?.given ?? (autonomy === 'auto' ? [...givenDestinations(wfId, goal), ...(boundAgentIds().length ? await agentConfigDestinations() : [])] : []);
    if (!resumed && given.length) approveDestinations(wfId, given); // AG22: a destination the flow already sent to, or the ask names, needs no "Run it now?"

    const publishAgents = options.publishAgents ?? resumed?.publishAgents;
    const build = publishAgents === true; // AG22: autonomous.ts's build sessions (a drafted flow, an applied chat change) pass publishAgents: they keep D1, the publish is the person's click
    const startNodes = resumed?.startNodes ?? useEditor.getState().nodes.map((n) => ({ id: n.id, name: n.data.wf.name, enabled: n.data.wf.disabled !== true }));
    let ran = resumed?.ran ?? false;
    /** The last failure, to tell a fix that changed nothing. */
    let lastFailure: string | undefined = resumed?.lastFailure;
    /** AG20: what the last fix changed: an agent's change is not undone with the flow's. */
    let lastFix: 'flow' | 'agent' | undefined = resumed?.lastFix;
    /** What was applied so far: the assistant gets no history, so it hears what didn't help. */
    const tried: string[] = resumed?.tried ?? [];
    /** The fixes applied, newest last, for undoing one that changed nothing (or all of them, from the outcome card). */
    const lastApplied: Array<{ item: string; proposals: string[] }> = resumed?.lastApplied ?? [];
    /** SB18: a row waits for the person: the session's state is kept for the click that goes on. */
    const waitFor = (need: Need) => {
      paused.set(wfId, { fixes, startNodes, tried, lastApplied, lastFailure, lastFix, reviewedAt, ran, autonomy, publishAgents, ownFixes, given, changedAgents, ownNodes: [...ownNodes] });
      ask(need);
    };
    /** SB18: agents whose "Publish … first" was already handled once this session. */
    const agentTried = new Set<string>();
    // What only the person can do comes first: no run, no fix spent on it.
    const first = beforeTesting(goal);
    if (first) {
      waitFor(first);
      return;
    }
    /** The session ends without a pass: a card with why and what to do next. */
    const stop = (text: string, node?: string) =>
      say([{ kind: 'outcome', outcome: { text, ...(node && { node }), ...(goal && { goal }), fixes: lastApplied.flatMap((a) => a.proposals.map((proposal) => ({ item: a.item, proposal }))), edits: useEditor.getState().edits } satisfies Outcome }]);
    /** AG22: a pass the review accepted: asks first offers the publish; an autonomous session that applied a fix publishes the agents it changed, then the workflow.
     *  A session that fixed nothing offers the publish card: an untouched draft (the person's own hand edits too) is never published without a click. */
    const passed = async () => {
      if (autonomy !== 'auto' || build || (!ownFixes.length && !changedAgents.length)) return void say([{ kind: 'action', action: 'publish' }]);
      await publishAtEnd({ signal, testId, changedAgents });
    };
    // Runs count on through the conversation.
    for (let round = nextRound(useAssistant.getState().items); !signal.aborted; round++) {
      // An agent Spotlight is still designing (./new-agent.ts): the run needs it saved and pointed at first.
      await agentsSettled();
      if (signal.aborted) return; // stopped while an agent was being designed: no run
      // SB03: before every real run, the first too (the wait above can change a URL): a destination the person never said yes to stops the session.
      {
        const last = ran ? lastApplied.at(-1) : undefined;
        const need = destinationNeed(goal, false, last && { item: last.item, proposals: last.proposals });
        if (need) {
          waitFor(need); // SB18:
          return;
        }
      }
      // SB18: an agent Spotlight made, untested because no item reached its step yet, is tested now that one does.
      for (const a of useAssistant.getState().agents) {
        if (a.state === 'untested' && a.agentId && !a.taken && itemReaching(a.nodeId)) await smokeTestAgent(a.nodeId, { publish: autonomy === 'auto' });
        if (signal.aborted) return;
      }
      // SB18: asks-first, a tested agent waits for the person's Publish: a run now would stop at "Publish … first".
      {
        const waiting = autonomy === 'auto' ? undefined : useAssistant.getState().agents.find((a) => a.state === 'tested' && a.agentId && !a.taken && useEditor.getState().nodes.some((n) => n.id === a.nodeId));
        if (waiting) {
          waitFor({ what: 'publish', nodeId: waiting.nodeId, node: waiting.name, text: `Publish “${waiting.name}”: ${smokeLine(waiting.smoke)}.`, ...(goal && { goal }) });
          return;
        }
      }
      ran = true;
      const runItem = say([{ kind: 'run', run: { round, state: 'running' } }], testId);
      // AG22: an autonomous fix session's run carries Spotlight's approvals, with the destinations given (the person's yes too).
      const approvals: SpotlightRunApprovals | undefined = autonomy === 'auto' ? { approvals: SPOTLIGHT_APPROVALS, sessionId: testId, destinations: [...new Set([...given, ...(sendsAllowed.get(wfId) ?? [])].map(normalDestination))].filter((d) => d.length > 0 && d.length <= 2000).slice(0, 50) /* the run schema's limits: 50 strings of at most 2000 characters */ } : undefined;
      const result = await runOnce(signal, approvals, testId);
      approvedOnce.clear(); // a yes for an expression destination covered that run only
      if ('stopped' in result) {
        // The run that didn't happen gives way to why.
        useAssistant.setState((s) => ({ items: s.items.filter((item) => item.id !== runItem) }));
        // Stopped by the person (■, New conversation, another workflow): nothing to add.
        if (!signal.aborted) say([{ kind: 'text', text: result.stopped }]);
        return;
      }
      setRun(runItem, { round, state: result.passed ? 'passed' : 'failed', summary: result.summary });
      const executionId = useEditor.getState().executionId; // AG20: the fix reads this run's log
      if (!result.passed) {
        const failedNode = result.node ? useEditor.getState().nodes.find((n) => n.data.wf.name === result.node) : undefined;
        const error = failedNode ? (useEditor.getState().statuses[failedNode.id]?.error ?? runError()) : runError();
        // SB18: "Publish … first" at an agent Spotlight made is not a fix round: it is tested, and published on a pass.
        const unpublished = unpublishedAgentAt(result.node, error);
        if (unpublished) {
          if (agentTried.has(unpublished.nodeId)) {
            stop(`“${unpublished.name}” is not published yet: ${unpublished.held ?? smokeLine(unpublished.smoke)}. Open it, or tell me what to change.`, result.node);
            return;
          }
          agentTried.add(unpublished.nodeId);
          const smoke = await smokeTestAgent(unpublished.nodeId, { publish: autonomy === 'auto' });
          if (signal.aborted) return;
          const now = useAssistant.getState().agents.find((a) => a.nodeId === unpublished.nodeId);
          if (smoke?.state === 'passed' && now?.state === 'published') continue; // run again
          if (smoke?.state === 'passed' && autonomy !== 'auto') {
            waitFor({ what: 'publish', nodeId: unpublished.nodeId, node: unpublished.name, text: `Publish “${unpublished.name}”: ${smokeLine(smoke)}.`, ...(goal && { goal }) });
            return;
          }
          stop(`“${unpublished.name}” is not published: ${now?.held ?? smokeLine(smoke)}. Open it, or tell me what to change.`, result.node);
          return;
        }
        const need = personNeed(result, error, goal);
        if (need) {
          waitFor(need); // SB18:
          return;
        }
        // The same failure after a fix: the fix didn't help. Undo it and stop, rather than spend another.
        // AG20: two runs in a row failing at the same node with the same error (and the same response body) stop here, with what is left.
        const failure = sameFailure(`${result.summary} ${errorBody(result.node)}`);
        if (lastFailure && failure === lastFailure) {
          const last = lastApplied.at(-1);
          const undo = Boolean(last) && lastFix === 'flow';
          if (last && undo) {
            undoApplied(last);
            lastApplied.pop();
          }
          stop(`Still failing${result.node ? ` at “${result.node}”` : ''}: ${causeOf(result.summary, errorBody(result.node))}. The last fix didn’t change the error${undo ? ', so I undid it' : ''}. Left: ${leftFor(result.node)}`, result.node);
          return;
        }
        lastFailure = failure;
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
        await passed(); // AG22: asks first offers the publish; autonomous publishes
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
        ? `Test run ${round} ${executionId ? `(execution ${executionId}) ` : ''}${result.summary}.${asked} Fix it.${before}`
        : hollow.length
          ? `Test run ${round} ${executionId ? `(execution ${executionId}) ` : ''}had no errors, but ${hollow.map((h) => h.problem).join('; ')}.${asked} Read the run log (get_run_log) for what the agent said and which tools it has, then fix it.${before}`
          : `Test run ${round} ${executionId ? `(execution ${executionId}) ` : ''}had no errors: ${result.summary}.${outputOf(result.node)}${agentReply() /* AG22: the agent step's reply, not only the last node's */} Does that do what I asked for: “${goal}”?${outputFields() /* SB18: */} Check each part of what I asked against it. If the output falls short, read the run log (get_run_log): for a Run an Agent step it shows the agent's tools, tool calls and reply, so a tool the agent lacks is read there (propose_agent_fix), not guessed. ${AGENT_FACTS_RULE} If it does, start your reply with "Yes," and say so in one sentence. If not, start your reply with "No," and name the part of what I asked that did not happen, then fix it.${before}`;
      if (!failed) reviewedAt = fixes; // SB03:
      useAssistant.setState({ fixing: failed ? nodeId : undefined });
      await useAssistant.getState().send(request, { auto: true, fresh: true, session: failed ? 'fix' : 'review', autonomy, withoutSelection: true, testId, ...(nodeId && { nodeId }) });
      useAssistant.setState({ fixing: undefined });
      if (signal.aborted) return;
      let reply = useAssistant.getState().items.at(-1);
      if (reply?.role !== 'assistant' || reply.error) {
        stop(`I couldn’t work out a fix${result.node ? ` for “${result.node}”` : ''}.`, result.node);
        return;
      }
      // Re-check 3: a round that answers "no" and names no change, with a Run an Agent step in the flow, asks once more, as "Try again" did: the
      // agent may state facts it has no tool or knowledge to give, and the log says so. The same round then reaches the agent fix card.
      const noChange = (r: ChatItem | undefined) => r?.role === 'assistant' && !r.agentFix && !r.parts.some((p) => p.kind === 'proposal') && missingPartOf(r) !== undefined;
      if (!failed && goal && noChange(reply) && useEditor.getState().nodes.some((n) => n.data.wf.type === 'core.messageAgent' && !n.data.wf.disabled) && fixes < MAX_FIXES) {
        const again = `Test run ${round} ${executionId ? `(execution ${executionId}) ` : ''}did not do what I asked for: “${goal ?? ''}”. ${AGENT_FACTS_RULE}${before}`;
        useAssistant.setState({ fixing: nodeId });
        await useAssistant.getState().send(again, { auto: true, fresh: true, session: 'fix', autonomy, withoutSelection: true, testId, ...(nodeId && { nodeId }) });
        useAssistant.setState({ fixing: undefined });
        if (signal.aborted) return;
        const next = useAssistant.getState().items.at(-1);
        if (next?.role === 'assistant' && !next.error && (next.agentFix || next.parts.some((p) => p.kind === 'proposal'))) reply = next;
      }
      // AG20: the log shows the cause inside an agent: its change card goes through Apply, the smoke test and Publish, then the run goes again.
      // AG20: a run that passed can need it too: the agent said a tool is not available, and the review reads that from the log.
      if (reply.agentFix) {
        if (fixes >= MAX_FIXES) {
          stop(failed ? `Still failing${result.node ? ` at “${result.node}”` : ''} after ${MAX_FIXES} fixes. Left: ${leftFor(result.node)}` : `It runs, but doesn’t do all you asked yet, and I am out of fixes. Left: ${leftForAgent(result.node)}`, result.node);
          return;
        }
        // AG22: C3 one focused fix per round: flow proposals beside an agent fix are left for the next round, never a card to click mid-session.
        const beside = reply.parts.flatMap((p) => (p.kind === 'proposal' && !p.proposal.state ? [p.proposal] : []));
        if (beside.length) {
          for (const proposal of beside) useAssistant.getState().setProposalState(reply.id, proposal.id, 'dismissed');
          say([{ kind: 'text', text: leftForNextRound(beside.map((b) => b.summary)) }], testId);
        }
        const change = `changed the agent “${reply.agentFix.agent}”: ${reply.agentFix.change}`.slice(0, 200);
        // AG22: the same agent change twice is a stop, not a round.
        if (tried.includes(change)) {
          stop(`I already tried that change to “${reply.agentFix.agent}” and it didn’t help. Left: open the agent and change it, or tell me what it should do instead.`, result.node);
          return;
        }
        if (autonomy === 'auto') {
          // AG22: the session applies the agent fix itself: saved, smoke-tested, credential picked when one fits, published through the gate.
          const done = await autoAgentFix({ event: reply.agentFix, signal, testId, goal: goal ?? '', fixes, ownFixes, changedAgents, tried });
          if (signal.aborted) return;
          fixes += done.used;
          if (done.kind === 'stop') {
            stop(done.text, result.node);
            return;
          }
          if (done.kind === 'dropped') {
            // Dropped before it was shown (it would undo the session's own fix): it costs no round; what the reply said is left.
            stop(`It runs, but doesn’t do all you asked yet, and the only change left would undo my own earlier fix. Left: ${leftForAgent(result.node, missingPartOf(reply))}`, result.node);
            return;
          }
          tried.push(change);
          useAssistant.getState().noteFix(nodeId ? [nodeId] : [], `Changed “${reply.agentFix.agent}”`);
          lastFix = 'agent';
          continue;
        }
        const cardItem = await showAgentFix(reply.agentFix, fixes + 1, signal, testId, goal ?? '', { fixes: ownFixes, auto: false });
        if (signal.aborted) return;
        if (cardItem && typeof cardItem === 'object' && 'undone' in cardItem) {
          say([{ kind: 'text', text: droppedLine(cardItem.undone) }], testId);
          stop(`It runs, but doesn’t do all you asked yet, and the only change left would undo my own earlier fix. Left: ${leftForAgent(result.node, missingPartOf(reply))}`, result.node);
          return;
        }
        if (!cardItem || typeof cardItem === 'object') {
          stop(`I couldn’t work out a change to “${reply.agentFix.agent}”.`, result.node);
          return;
        }
        const why = await agentFixOutcome(cardItem, signal);
        if (signal.aborted) return;
        if (why) {
          stop(why, result.node);
          return;
        }
        const askedAdded = lastDesign?.added ?? [];
        ownFixes.push({ kind: 'agent', agentId: reply.agentFix.agentId, toolsAdded: askedAdded, summary: askedAdded.length ? `added ${askedAdded.map((t) => `“${t}”`).join(', ')} to “${reply.agentFix.agent}”` : `changed “${reply.agentFix.agent}”` });
        tried.push(change);
        useAssistant.getState().noteFix(nodeId ? [nodeId] : [], `Changed “${reply.agentFix.agent}”`);
        lastFix = 'agent';
        fixes++;
        continue;
      }
      // AG22: a proposal that would undo this session's own fix (a parameter set back, a step it added removed) is dropped before it is shown; it costs no round.
      const nodesBefore = useEditor.getState().nodes.map((n) => ({ id: n.id, name: n.data.wf.name, parameters: n.data.wf.parameters }));
      const proposals = reply.parts.flatMap((p) => (p.kind === 'proposal' && !p.proposal.state ? [p.proposal] : [])).filter((proposal) => {
        const undone = undoneBy(proposal.ops, ownFixes, { ownRemovalOk: autonomy === 'auto' });
        if (!undone) return true;
        useAssistant.getState().setProposalState(reply.id, proposal.id, 'dismissed');
        say([{ kind: 'text', text: droppedLine(undone) }], testId);
        return false;
      });
      // Wave ag4 carryover (the live pass's asks.md C): the card shows while the reply still works, so the person's Apply can
      // land before it ends: a fix they already applied is taken, and the run goes again (never "I found no fix").
      const appliedEarly = proposals.length ? [] : reply.parts.flatMap((p) => (p.kind === 'proposal' && p.proposal.state === 'applied' && !lastApplied.some((a) => a.item === reply.id && a.proposals.includes(p.proposal.id)) ? [p.proposal] : []));
      if (failed && appliedEarly.length) {
        lastApplied.push({ item: reply.id, proposals: appliedEarly.map((p) => p.id) });
        for (const p of appliedEarly) ownFixes.push(...fixesOf(p.ops, useEditor.getState().nodes.map((n) => ({ id: n.id, name: n.data.wf.name, parameters: n.data.wf.parameters })))); // AG22:
        for (const proposal of appliedEarly) useAssistant.getState().noteFix(fixedNodes(proposal.ops, nodeId), opsTitle(proposal.ops));
        tried.push(...appliedEarly.map((p) => p.summary));
        lastFix = 'flow';
        fixes++;
        continue;
      }
      if (!proposals.length) {
        // Nothing to change: a run the review said yes to is ready; a "no" without a fix, or a failed run, needs the person.
        const said = reply.parts.find((p) => p.kind === 'text');
        const yes = said?.kind === 'text' && /^\s*yes\b/i.test(said.text);
        // SB18: a "no" must name the part of the goal that did not happen; one that names none reads as a pass.
        const part = said?.kind === 'text' && !yes ? missingPart(said.text) : undefined;
        if (!failed && yes) await passed();
        else if (!failed && !part) {
          say([{ kind: 'text', text: 'Reviewed: nothing missing.' }]);
          await passed();
        } else if (!failed) stop(`It runs, but doesn’t do all you asked yet: ${part}. I have no change for it. Left: ${leftForAgent(result.node, part)}`, result.node);
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
      // AG22: the same fix twice (the same step, parameter and value) is a stop with what is left, never a loop.
      if (sameFixTwice(proposals.flatMap((p) => p.ops), ownFixes)) {
        for (const proposal of proposals) useAssistant.getState().setProposalState(reply.id, proposal.id, 'dismissed');
        stop(`I already made that fix (${proposals[0].summary}) and it didn’t help. Left: ${leftFor(at)}`, at);
        return;
      }
      if (fixes >= MAX_FIXES) {
        for (const proposal of proposals) useAssistant.getState().setProposalState(reply.id, proposal.id, 'dismissed');
        stop(`It runs, but doesn’t do all you asked yet${missingPartOf(reply) ? `: ${missingPartOf(reply)}` : ''}, and I am out of fixes: tell me what to change.`, result.node);
        return;
      }
      // SB03 (D1): asks-first, and a change that removes a step even under auto, waits for the person's Apply.
      // The person's decision of 2026-11-18: an autonomous session removes a step it added, or one the bound agent plainly does itself, without a click.
      const allowed: RemovalsAllowed | undefined = autonomy === 'auto' ? { own: ownNodes, duplicates: await repeatedByAgents() } : undefined;
      const removals = autonomy === 'auto' ? fixRemovals(proposals.flatMap((p) => p.ops), useEditor.getState().toWorkflow(), editorLookup(), allowed) : undefined;
      const reasons = removals?.reasons ?? [];
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
        for (const p of taken) ownFixes.push(...fixesOf(p.ops, nodesBefore)); // AG22:
        for (const proposal of taken) useAssistant.getState().noteFix(fixedNodes(proposal.ops, nodeId), opsTitle(proposal.ops));
        tried.push(...taken.map((p) => p.summary));
        lastFix = 'flow'; // AG20:
        fixes++;
        continue;
      }
      const removalLines = removals?.lines ?? [];
      const label = proposals.length === 1 ? `Spotlight applied “${proposals[0].summary}”` : `Spotlight applied ${proposals.length} fixes`;
      let skipped = 0;
      const applied = applyChanges(proposals.map((p) => ({ ops: p.ops, kind: 'proposal' as const })), label, {
        publishAgents, // SB18:
        quiet: true,
        onApplied: ({ undo, skipped: dropped, added }) => {
          for (const id of added ?? []) ownNodes.add(id); // only the ids these proposals created
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
      if (removalLines.length) say([{ kind: 'text', text: `${removalLines.join('. ')}.` }], testId); // each removal named with its reason
      for (const p of proposals) ownFixes.push(...fixesOf(p.ops, nodesBefore)); // AG22:
      for (const proposal of proposals) {
        useAssistant.getState().setProposalState(reply.id, proposal.id, 'applied', skipped);
        // A bubble on what it fixed, until dismissed.
        useAssistant.getState().noteFix(fixedNodes(proposal.ops, nodeId), opsTitle(proposal.ops));
      }
      tried.push(...proposals.map((p) => p.summary));
      lastFix = 'flow'; // AG20:
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

/** The steps of the canvas that plainly duplicate what the bound agent does (node id to the agent's name): the agents are read as the run uses them, published. */
async function repeatedByAgents(): Promise<Map<string, string>> {
  const workflow = useEditor.getState().toWorkflow();
  const ids = [...new Set(workflow.nodes.flatMap((n) => (n.type === 'core.messageAgent' && typeof n.parameters?.agentId === 'string' && n.parameters.agentId ? [n.parameters.agentId] : [])))];
  if (!ids.length) return new Map();
  const briefs = (await Promise.all(ids.map((id) => api<{ agent: Parameters<typeof agentBrief>[0] }>(`/api/agents/${id}`, { background: true }).then((r) => (r.agent ? agentBrief(r.agent) : undefined)).catch(() => undefined)))).filter((b): b is AgentBrief => Boolean(b));
  return duplicatedSteps({ nodes: workflow.nodes.map((n) => ({ id: n.id, type: n.type, name: n.name, parameters: n.parameters as Record<string, unknown> })), connections: workflow.connections }, briefs);
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
