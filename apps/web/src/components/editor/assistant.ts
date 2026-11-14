'use client';
/**
 * Client side of the editor assistant (docs/assistant.md): applying proposed
 * ops to the canvas with an undo, after-run suggestions cached per run, and
 * Spotlight's conversation, kept while the editor is open.
 */
import { isPhone } from '@/lib/client/use-phone';
import { nanoid } from 'nanoid';
import { toast } from 'sonner';
import { create } from 'zustand';
import { api, streamEvents } from '@/lib/client/api';
import { applyOps, digestRun, type AssistantOp, type DescriptorLookup, type NewAgentSpec, type RunDigest } from '@/lib/shared/assistant-ops';
import type { AgentTeamConfig } from '@/lib/shared/agent-teams';
import { teamFromLead } from '@/lib/shared/turn-into-team';
import type { ActivityKind, ActivityStep } from '@/lib/shared/activity';
import type { NodeRun } from '@/lib/shared/types';
import type { ReplyInfo } from '../ui/chat';
import { useEditor } from './store';
import { saveAgentFor, type AgentPlace } from './new-agent';
import { saveTeamFor } from './turn-into-team';

export type SuggestionKind = 'fix' | 'param' | 'data' | 'next';
export type ChangeKind = SuggestionKind | 'proposal';

export interface Suggestion {
  id: string;
  kind: SuggestionKind;
  title: string;
  detail: string;
  confidence: number;
  ops: AssistantOp[];
  dropped?: string[];
  warnings?: string[];
}

export interface SuggestResult {
  suggestions: Suggestion[];
  model: string;
  durationMs: number;
  skipped?: string;
}

export const editorLookup = (): DescriptorLookup => {
  const { nodeTypes } = useEditor.getState();
  return (type) => nodeTypes[type]?.descriptor;
};

/** Report an applied or dismissed change for the assistant metrics. Best effort. */
export function sendFeedback(kind: ChangeKind, action: 'applied' | 'dismissed', nodeType?: string) {
  const workflowId = useEditor.getState().workflowId || undefined;
  api('/api/assistant/feedback', { method: 'POST', json: { kind, action, workflowId, nodeType } }).catch(() => {});
}

/**
 * Apply one or more changes (each a list of ops) to the canvas as one step
 * with one undo. Ops that no longer fit (the workflow changed since they were
 * proposed) are skipped. Returns false when nothing applied.
 */
/** The flow being drafted on an empty canvas: one request, which Stop, New conversation and another workflow cancel. */
export const draft: { request?: AbortController } = {};

/** Undo for a change Spotlight applied by itself, by proposal id: its row's Undo button (a phone has no ⌘Z). */
export const undos = new Map<string, () => void>();

export function applyChanges(
  changes: Array<{ ops: AssistantOp[]; kind: ChangeKind; nodeType?: string }>,
  label: string,
  options: { publishAgents?: boolean; quiet?: boolean; onApplied?: (applied: { undo: () => void; skipped: string[] }) => void } = {},
): boolean {
  const state = useEditor.getState();
  const lookup = editorLookup();
  let workflow = state.toWorkflow();
  const added: string[] = [];
  const dropped: string[] = [];
  let edited: string | undefined;
  let count = 0;
  /** Teams to save once the graph is swapped: Spotlight's turnIntoTeam ops, read from the graph as it was. */
  const teams: Array<{ nodeId: string; config: AgentTeamConfig }> = [];
  /** Agents to save once the graph is swapped: Spotlight's newAgent ops, each with the Run an Agent node it added. */
  const agents: Array<{ nodeId: string; spec: NewAgentSpec; place: AgentPlace }> = [];
  for (const change of changes) {
    const before = workflow;
    const result = applyOps(workflow, change.ops, lookup);
    workflow = result.workflow;
    for (const op of result.applied) {
      if (op.op === 'addNode' && op.newAgent) {
        const node = result.workflow.nodes.find((n) => n.name === op.name && result.added.includes(n.id));
        if (node) {
          // Where it sits, by the steps either side of it, for the architect's request.
          const nameOf = (id: string) => result.workflow.nodes.find((n) => n.id === id)?.name;
          const main = result.workflow.connections.filter((c) => c.type === 'main');
          const after = nameOf(main.find((c) => c.target === node.id)?.source ?? '');
          const before = nameOf(main.find((c) => c.source === node.id)?.target ?? '');
          agents.push({ nodeId: node.id, spec: op.newAgent, place: { workflow: result.workflow.name, ...(after && { after }), ...(before && { before }) } });
        }
        continue;
      }
      if (op.op !== 'turnIntoTeam') continue;
      const lead = before.nodes.find((n) => n.name === op.node || n.id === op.node);
      const made = lead && teamFromLead(before, lead.id);
      if (lead && made && !('error' in made)) teams.push({ nodeId: lead.id, config: made.team });
    }
    added.push(...result.added.filter((id) => workflow.nodes.some((n) => n.id === id)));
    dropped.push(...result.dropped);
    count += result.applied.length;
    const op = result.applied.findLast((o) => o.op === 'setParameters' || o.op === 'renameNode');
    if (op?.op === 'renameNode') edited = workflow.nodes.find((n) => n.name === op.name)?.id;
    else if (op?.op === 'setParameters') edited = workflow.nodes.find((n) => n.name === op.node || n.id === op.node)?.id;
    if (result.applied.length) sendFeedback(change.kind, 'applied', change.nodeType);
  }
  if (!count) {
    toast.error('Couldn’t apply the change', { description: dropped[0] ?? 'Nothing to change.' });
    return false;
  }
  // Select what changed: the last node added, else the node edited.
  const focusId = added.at(-1) ?? edited;
  // Spotlight's own applies leave the selection alone: selecting would hide its chip and put the node in the composer.
  const undo = state.replaceGraph(workflow, focusId && !options.quiet ? { id: focusId, added: added.includes(focusId) } : undefined);
  for (const { nodeId, config } of teams) void saveTeamFor(nodeId, config);
  for (const { nodeId, spec, place } of agents) void saveAgentFor(nodeId, spec, place, { publish: options.publishAgents });
  options.onApplied?.({ undo, skipped: dropped });
  // Spotlight's own applies (autonomous mode, a test-and-fix session) are rows in its timeline, each with Undo.
  if (options.quiet) return true;
  const skipped = dropped.length ? `Skipped ${dropped.length}: ${dropped[0]}` : undefined;
  // Long enough to look at the canvas before deciding to undo.
  // A phone's toast sits over the run bar: shorter there.
  toast.success(label, { description: skipped, action: { label: 'Undo', onClick: undo }, duration: isPhone() ? 5_000 : 15_000 });
  return true;
}

const latestMain = (runs: NodeRun[] | undefined) => runs?.filter((r) => r.source === 'main').at(-1);

/** The last main run of every node on the canvas, digested for the assistant. */
export function runDigests(): Record<string, RunDigest> {
  const { runs, nodes } = useEditor.getState();
  const digests: Record<string, RunDigest> = {};
  for (const node of nodes) {
    const run = latestMain(runs[node.id]);
    if (run) digests[node.id] = digestRun(run);
  }
  return digests;
}

// ---------------------------------------------------------------------------
// Auto-suggest preference
// ---------------------------------------------------------------------------

const AUTO_KEY = 'landflow-assistant-auto';

export function readAutoSuggest(): boolean {
  try {
    return localStorage.getItem(AUTO_KEY) !== 'off';
  } catch {
    return true;
  }
}

export function writeAutoSuggest(on: boolean) {
  try {
    localStorage.setItem(AUTO_KEY, on ? 'on' : 'off');
  } catch {
    // Private mode: the toggle still works for this page.
  }
}

// ---------------------------------------------------------------------------
// After-run suggestions, cached per run
// ---------------------------------------------------------------------------

export interface SuggestionEntry {
  status: 'loading' | 'done' | 'error';
  result?: SuggestResult;
  error?: string;
  /** Suggestion id → what the user did with it. */
  handled: Record<string, 'applied' | 'dismissed'>;
}

/** One run of one node: a new run means new suggestions. */
export const suggestionKey = (workflowId: string, nodeId: string, run: NodeRun) => `${workflowId}:${nodeId}:${run.startedAt}`;

interface SuggestionsState {
  entries: Record<string, SuggestionEntry>;
  /** Ask for suggestions unless this run already has them (or is being asked about). `force` asks again. */
  request(nodeId: string, run: NodeRun, force?: boolean): void;
  handle(key: string, suggestion: Suggestion, action: 'applied' | 'dismissed'): void;
  clear(): void;
}

export const useSuggestions = create<SuggestionsState>((set, get) => ({
  entries: {},

  request(nodeId, run, force = false) {
    const editor = useEditor.getState();
    const key = suggestionKey(editor.workflowId, nodeId, run);
    const existing = get().entries[key];
    if (existing && (existing.status === 'loading' || !force)) return;
    const update = (patch: Partial<SuggestionEntry>) =>
      set((s) => ({ entries: { ...s.entries, [key]: { ...(s.entries[key] ?? { status: 'loading', handled: {} }), ...patch } } }));
    update({ status: 'loading', error: undefined, handled: {} });
    api<SuggestResult>('/api/assistant/suggest', { method: 'POST', json: { workflow: editor.toWorkflow(), workflowId: editor.workflowId, nodeId, run: digestRun(run) } })
      .then((result) => update({ status: 'done', result }))
      .catch((e: Error) => update({ status: 'error', error: e.message }));
  },

  handle(key, suggestion, action) {
    set((s) => {
      const entry = s.entries[key];
      return entry ? { entries: { ...s.entries, [key]: { ...entry, handled: { ...entry.handled, [suggestion.id]: action } } } } : s;
    });
    // The key is workflowId:nodeId:startedAt.
    const nodeId = key.split(':')[1];
    if (action === 'dismissed') sendFeedback(suggestion.kind, 'dismissed', useEditor.getState().nodes.find((n) => n.id === nodeId)?.data.wf.type);
  },

  clear() {
    set({ entries: {} });
  },
}));

/** After a failed run, have the failed node's suggestions ready before its panel is opened (a test-and-fix session asks itself). */
export function prefetchFailure() {
  if (!readAutoSuggest() || useAssistant.getState().testing) return;
  const { runs } = useEditor.getState();
  const failed = Object.entries(runs).find(([, list]) => latestMain(list)?.status === 'error');
  if (failed) useSuggestions.getState().request(failed[0], latestMain(failed[1])!);
}

// ---------------------------------------------------------------------------
// Spotlight's conversation (the builder chat)
// ---------------------------------------------------------------------------

export interface Proposal {
  id: string;
  summary: string;
  ops: AssistantOp[];
  dropped: string[];
  warnings: string[];
  state?: 'applied' | 'dismissed' | 'undone';
  /** Ops that no longer fit when it was applied. */
  skipped?: number;
}

/**
 * Something only the person can do before Spotlight tests on (docs/assistant.md#test-and-fix): pick a credential, pick
 * an agent, add a trigger, or say a test may send for real. Its row has the button that does it and one that goes on.
 */
export interface Need {
  what: 'credential' | 'agent' | 'trigger' | 'sends';
  text: string;
  /** The node it is about, to open. */
  node?: string;
  /** The session's goal, to test on with. */
  goal?: string;
  state?: 'done' | 'dismissed';
}

/**
 * How a test-and-fix session that didn't pass ended, as a card: why, in one line, and what to do next: open the node it
 * stopped at, undo every fix it applied (back to the flow as it was before), or try again.
 */
export interface Outcome {
  text: string;
  /** The node it stopped at. */
  node?: string;
  goal?: string;
  /** The fixes it applied, oldest first: undoing the oldest puts the flow back as it was before the session. */
  fixes: Array<{ item: string; proposal: string }>;
  /** The editor's edit count when it stopped (`edits` in ./store.ts): any edit since and Undo all is no longer offered. */
  edits: number;
  state?: 'undone';
}

export interface ToolActivity {
  name: string;
  label: string;
  ok: boolean;
}

/** A run of a test-and-fix session (./test-session.ts). */
export interface TestRun {
  round: number;
  state: 'running' | 'passed' | 'failed';
  summary?: string;
}

/** A button in the conversation: start a test-and-fix session, or publish what passed. */
export interface ReplyAction {
  action: 'test' | 'publish';
  state?: 'done' | 'dismissed';
  /** Test: what the workflow is for (the description it was drafted from), to check a passing run against. */
  goal?: string;
}

/** One block of an assistant reply, in the order it streamed. */
export type ReplyPart =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; tool: ToolActivity }
  | { kind: 'proposal'; proposal: Proposal }
  | { kind: 'run'; run: TestRun }
  | { kind: 'needs'; need: Need }
  | { kind: 'outcome'; outcome: Outcome }
  | ({ kind: 'action' } & ReplyAction);

/**
 * `testId`: the test-and-fix session the turn belongs to; Spotlight folds a finished session into one line.
 * An assistant turn that streamed (`send`) also holds what the chat stream says (C3 in lib/server/assistant/chat.ts):
 * `steps` (the activity trace), `text` (provisional while streaming, the checked reply at the end), `thinking` (the
 * words of steps that also called tools, which never reach the reply) and `meta` (model, time, steps, tokens, cost).
 */
export type ChatItem =
  /** `auto`: written by a test-and-fix session, not typed. */
  | { id: string; role: 'user'; text: string; auto?: boolean; testId?: string }
  /** `auto`: autonomous mode applied its changes (drawn as rows, whatever the switch says later). */
  | {
      id: string;
      role: 'assistant';
      parts: ReplyPart[];
      done?: { model: string; durationMs: number; steps: number };
      error?: string;
      testId?: string;
      auto?: boolean;
      steps?: ActivityStep[];
      text?: string;
      thinking?: string[];
      meta?: ReplyInfo;
      /** What a failed reply can be continued from (`error` events); the actions come with the chat's error buttons. */
      checkpoint?: string;
      /** When the running model step began (to time it). */
      stepStartedAt?: number;
    };

export type AssistantTurn = Extract<ChatItem, { role: 'assistant' }>;

/** The chat stream's events (C3, lib/server/assistant/chat.ts), as Spotlight reads them. */
export type StreamEvent =
  | { type: 'step.start'; step: number; label: string }
  | { type: 'text.delta'; step: number; text: string }
  | { type: 'text'; text: string; step?: number }
  | { type: 'thinking'; step: number; text: string }
  | { type: 'tool'; name: string; label: string; ok: boolean; id?: string; step?: number; durationMs?: number; detail?: string }
  | ({ type: 'proposal' } & Omit<Proposal, 'state'>)
  | { type: 'done'; model: string; durationMs: number; steps: number; usage?: { inputTokens: number; outputTokens: number }; costUsd?: number; local?: boolean }
  | { type: 'error'; message: string; checkpoint?: string; step?: number };

/** What kind of trace row a tool call is. */
export function toolKind(name: string): ActivityKind {
  if (/^search/.test(name)) return 'search';
  if (/^(get|read|describe)/.test(name)) return 'read';
  if (/^(propose|write|set|add|apply)/.test(name)) return 'write';
  if (/^(run|execute|test)/.test(name)) return 'run';
  return 'tool';
}

const clip = (text: string | undefined) => (text ? text.slice(0, 300) : undefined);

/** Close the model step that is running: it took until `now`. */
function settleModel(turn: AssistantTurn, now: number, status: 'ok' | 'failed' = 'ok'): ActivityStep[] {
  return (turn.steps ?? []).map((s) => (s.kind === 'model' && s.status === 'running' ? { ...s, status, ...(turn.stepStartedAt !== undefined && { durationMs: Math.max(0, now - turn.stepStartedAt) }) } : s));
}

/**
 * One chat event applied to a turn (a pure reducer, so the stream is tested without a store): `step.start` opens a
 * running model step; `text.delta` grows the provisional text and `text` replaces it with the checked one; `thinking`
 * goes to the trace and never to the reply; `tool` adds a timed step; `done` fills `meta` with the usage; `error` keeps the
 * checkpoint to continue from. `now` is for tests.
 */
export function applyStreamEvent(turn: AssistantTurn, event: StreamEvent, now: number = Date.now()): AssistantTurn {
  const steps = turn.steps ?? [];
  const checked = turn.parts.some((p) => p.kind === 'text');
  switch (event.type) {
    case 'step.start':
      // The new step's words start from nothing: the last step's provisional text went to the trace as thinking.
      return { ...turn, text: checked ? turn.text : '', steps: [...settleModel(turn, now), { id: `model${event.step}`, label: event.label, kind: 'model', status: 'running' }], stepStartedAt: now };
    case 'text.delta':
      return { ...turn, text: `${turn.text ?? ''}${event.text}` };
    case 'text': {
      const at = turn.parts.findLastIndex((p) => p.kind === 'text');
      const part: ReplyPart = { kind: 'text', text: event.text };
      return { ...turn, text: event.text, parts: at >= 0 ? turn.parts.map((p, i) => (i === at ? part : p)) : [...turn.parts, part] };
    }
    case 'thinking':
      return {
        ...turn,
        // Its deltas were provisional text: they belong to the trace now.
        text: checked ? turn.text : '',
        thinking: [...(turn.thinking ?? []), event.text],
        steps: [...steps, { id: `think${event.step}`, label: 'Thought', kind: 'think', status: 'ok', detail: clip(event.text) }],
      };
    case 'tool':
      return {
        ...turn,
        parts: [...turn.parts, { kind: 'tool', tool: { name: event.name, label: event.label, ok: event.ok } }],
        steps: [
          ...steps,
          { id: `tool${event.id ?? steps.length}`, label: event.label, kind: toolKind(event.name), status: event.ok ? 'ok' : 'failed', ...(event.durationMs !== undefined && { durationMs: event.durationMs }), ...(clip(event.detail) && { detail: clip(event.detail) }) },
        ],
      };
    case 'proposal': {
      const { type: _type, ...proposal } = event;
      return { ...turn, parts: [...turn.parts, { kind: 'proposal', proposal }] };
    }
    case 'done':
      return {
        ...turn,
        steps: settleModel(turn, now),
        done: { model: event.model, durationMs: event.durationMs, steps: event.steps },
        meta: { model: event.model, durationMs: event.durationMs, steps: event.steps, ...(event.usage && { inputTokens: event.usage.inputTokens, outputTokens: event.usage.outputTokens }), ...(event.costUsd !== undefined && { costUsd: event.costUsd }), ...(event.local && { local: true }) },
      };
    case 'error':
      return { ...turn, steps: settleModel(turn, now, 'failed'), error: event.message, ...(event.checkpoint && { checkpoint: event.checkpoint }) };
  }
}

export interface SendOptions {
  /** What the user tagged with Spotlight's bubbles: node ids on the canvas, node type ids. */
  mentions?: { nodes: string[]; types: string[] };
  /** Leave the selected node out of the context (its chip was removed). */
  withoutSelection?: boolean;
  /** Sent by a test-and-fix session: shown as a note, not as something the user typed. */
  auto?: boolean;
  /** The node to put in the context as if selected (the one a test run failed at). */
  nodeId?: string;
  /** Send without the earlier turns: a test-and-fix session's requests carry what they need (the run is in the context). */
  fresh?: boolean;
  /** A test-and-fix session's request: for a fix (a reply that proposes nothing is sent back once), or a review. */
  session?: 'fix' | 'review' | 'auto';
  /** The test-and-fix session the request belongs to. */
  testId?: string;
}

/** An agent Spotlight is having the Agent architect design (./new-agent.ts), shown as a row of its timeline. */
export interface AgentProgress {
  /** The Run an Agent node it is for. */
  nodeId: string;
  name: string;
  state: 'designing' | 'published' | 'draft' | 'failed';
  /** "ollama/qwen3-coder:30b · 1 knowledge base", or why it failed. */
  summary?: string;
  agentId?: string;
  /** The conversation item it follows. */
  after?: string;
}

const COLLAPSED_KEY = 'landflow-spotlight-collapsed';

function readCollapsed(): boolean {
  try {
    const saved = localStorage.getItem(COLLAPSED_KEY);
    // Not set yet: folded on a tablet or a small laptop, where the column would leave the canvas too narrow, and on a
    // phone, where the open sheet would cover the steps (docs/mobile.md#spotlights-dock).
    return saved ? saved === 'yes' : window.matchMedia('(max-width: 1099px)').matches;
  } catch {
    return false;
  }
}

interface AssistantState {
  /**
   * The Spotlight panel is folded to its pill (docs/assistant.md#the-spotlight-panel). Only the person changes it: no
   * draft, reply or test session opens, closes or moves the panel. Kept in the browser.
   */
  collapsed: boolean;
  setCollapsed(collapsed: boolean): void;
  /** A phone's open sheet: a third of the screen with the newest of the timeline, or half (docs/mobile.md#spotlights-dock). */
  phoneHeight: 'peek' | 'half';
  /** A phone's three heights: folded to its bar, peek or half. Only the person moves it, as with `collapsed`. */
  setDock(dock: 'bar' | 'peek' | 'half'): void;
  /** Agents being designed and those done, in the order they were asked for. */
  agents: AgentProgress[];
  setAgent(nodeId: string, patch: Partial<AgentProgress> & { name?: string }): void;
  workflowId?: string;
  items: ChatItem[];
  /** The checkpoint of the last reply that failed: it can be continued from there (the buttons come with the chat's error actions). */
  lastCheckpoint?: { replyId: string; checkpoint: string; step?: number };
  pending: boolean;
  abort?: AbortController;
  /** A test-and-fix session is running (./test-session.ts); aborting it stops the session. */
  testing?: AbortController;
  /** The running session's id (its items' `testId`): that session stays unfolded. */
  testingId?: string;
  /** The flow builder is drafting a flow on the empty canvas. */
  drafting: boolean;
  /** The node a test-and-fix session is asking a fix for: the canvas marks it. */
  fixing?: string;
  /** What a test-and-fix session fixed, by node id: a bubble on the node until dismissed (or a minute passes). */
  fixNotes: Record<string, { text: string; at: number }>;
  noteFix(nodeIds: string[], text: string): void;
  dismissFix(nodeId: string): void;
  /** ⌘I: unfold the panel (setCollapsed(!open)). */
  setOpen(open: boolean): void;
  /** Start over when another workflow is opened. */
  bind(workflowId: string): void;
  send(text: string, options?: SendOptions): Promise<void>;
  /** Add turns that didn't come from the chat (a flow the builder drafted, a fix from after-run suggestions). */
  append(items: ChatItem[]): void;
  stop(): void;
  reset(): void;
  setProposalState(itemId: string, proposalId: string, state: 'applied' | 'dismissed' | 'undone', skipped?: number): void;
  /** Change the parts of one reply (a test-and-fix session adds and updates its runs; buttons record what was chosen). */
  updateParts(itemId: string, fn: (parts: ReplyPart[]) => ReplyPart[]): void;
}

/** What the model sees of earlier turns: the text, plus a note of each proposal and whether it was applied. */
function historyOf(items: ChatItem[]) {
  return items.map((item) => {
    if (item.role === 'user') return { role: 'user' as const, content: item.text };
    const content = item.parts
      .map((part) => {
        if (part.kind === 'text') return part.text;
        if (part.kind === 'proposal') return `[Proposed “${part.proposal.summary}”: ${part.proposal.state ?? 'not applied yet'}]`;
        if (part.kind === 'run' && part.run.state !== 'running') return `[Test run ${part.run.round} ${part.run.state}: ${part.run.summary ?? ''}]`;
        return '';
      })
      .filter(Boolean)
      .join('\n');
    return { role: 'assistant' as const, content: content || item.error || '(no reply)' };
  });
}

/** The proposals in the conversation that are neither applied nor dismissed: the server counts them as part of the workflow. */
export function pendingProposals(items: ChatItem[]): Array<{ summary: string; ops: AssistantOp[] }> {
  return items.flatMap((item) => (item.role === 'assistant' ? item.parts.flatMap((part) => (part.kind === 'proposal' && !part.proposal.state ? [{ summary: part.proposal.summary, ops: part.proposal.ops }] : [])) : []));
}

export const useAssistant = create<AssistantState>((set, get) => ({
  collapsed: readCollapsed(),
  phoneHeight: 'half',
  agents: [],
  fixNotes: {},

  noteFix(nodeIds, text) {
    const at = Date.now();
    // One note on the canvas at a time: the newest fix. Older ones are rows of the timeline.
    set({ fixNotes: Object.fromEntries(nodeIds.map((id) => [id, { text, at }])) });
  },

  dismissFix(nodeId) {
    set((s) => {
      const { [nodeId]: _gone, ...rest } = s.fixNotes;
      return { fixNotes: rest };
    });
  },
  items: [],
  pending: false,
  drafting: false,

  setCollapsed(collapsed) {
    try {
      localStorage.setItem(COLLAPSED_KEY, collapsed ? 'yes' : 'no');
    } catch {
      // Private mode: the choice still holds for this page.
    }
    set({ collapsed });
  },

  setOpen(open) {
    get().setCollapsed(!open);
  },

  setDock(dock) {
    if (dock !== 'bar') set({ phoneHeight: dock });
    get().setCollapsed(dock === 'bar');
  },

  setAgent(nodeId, patch) {
    set((s) => {
      const known = s.agents.some((a) => a.nodeId === nodeId);
      if (known) return { agents: s.agents.map((a) => (a.nodeId === nodeId ? { ...a, ...patch } : a)) };
      return { agents: [...s.agents, { nodeId, name: patch.name ?? 'Agent', state: 'designing', after: s.items.at(-1)?.id, ...patch }] };
    });
  },

  bind(workflowId) {
    if (get().workflowId === workflowId) return;
    get().abort?.abort();
    get().testing?.abort();
    draft.request?.abort();
    set({ workflowId, items: [], lastCheckpoint: undefined, agents: [], fixNotes: {}, pending: false, drafting: false, abort: undefined, testing: undefined, testingId: undefined, fixing: undefined });
    useSuggestions.getState().clear();
  },

  async send(text, options = {}) {
    const message = text.trim();
    if (!message || get().pending) return;
    const editor = useEditor.getState();
    const group = options.testId ? { testId: options.testId } : {};
    const user: ChatItem = { id: nanoid(8), role: 'user', text: message, ...(options.auto && { auto: true }), ...group };
    const reply: ChatItem = { id: nanoid(8), role: 'assistant', parts: [], steps: [], text: '', thinking: [], ...group };
    const abort = new AbortController();
    const messages = historyOf(options.fresh ? [user] : [...get().items, user]);
    const pending = options.fresh ? [] : pendingProposals(get().items).slice(-20);
    set((s) => ({ items: [...s.items, user, reply], pending: true, abort }));
    const patch = (fn: (item: Extract<ChatItem, { role: 'assistant' }>) => Partial<Extract<ChatItem, { role: 'assistant' }>>) =>
      set((s) => ({ items: s.items.map((item) => (item.id === reply.id && item.role === 'assistant' ? { ...item, ...fn(item) } : item)) }));
    try {
      await streamEvents(
        '/api/assistant/chat',
        {
          messages,
          workflow: editor.toWorkflow(),
          workflowId: editor.workflowId,
          selectedNodeId: options.nodeId ?? (options.withoutSelection ? undefined : (editor.openNodeId ?? editor.nodes.find((n) => n.selected)?.id)),
          runs: runDigests(),
          ...(pending.length && { pending }),
          ...(options.mentions && { mentions: options.mentions }),
          ...(options.session && { session: options.session }),
        },
        (_event, data) => {
          const event = data as StreamEvent;
          patch((item) => applyStreamEvent(item, event));
          if (event.type === 'error' && event.checkpoint) set({ lastCheckpoint: { replyId: reply.id, checkpoint: event.checkpoint, ...(event.step !== undefined && { step: event.step }) } });
        },
        abort.signal,
      );
    } catch (e) {
      if ((e as Error).name !== 'AbortError') patch(() => ({ error: (e as Error).message }));
    } finally {
      // Stopped or cut off: no row keeps spinning.
      patch((item) => ({ steps: item.steps?.map((s) => (s.status === 'running' ? { ...s, status: 'ok' as const } : s)) }));
      if (get().abort === abort) set({ pending: false, abort: undefined });
    }
  },

  append(items) {
    set((s) => ({ items: [...s.items, ...items] }));
  },

  stop() {
    get().abort?.abort();
    get().testing?.abort();
    draft.request?.abort();
    set({ pending: false, abort: undefined, testing: undefined, testingId: undefined, fixing: undefined });
  },

  reset() {
    get().abort?.abort();
    get().testing?.abort();
    draft.request?.abort();
    set({ items: [], lastCheckpoint: undefined, agents: [], fixNotes: {}, pending: false, drafting: false, abort: undefined, testing: undefined, testingId: undefined, fixing: undefined });
  },

  setProposalState(itemId, proposalId, state, skipped) {
    set((s) => ({
      items: s.items.map((item) =>
        item.id === itemId && item.role === 'assistant'
          ? { ...item, parts: item.parts.map((part) => (part.kind === 'proposal' && part.proposal.id === proposalId ? { ...part, proposal: { ...part.proposal, state, ...(skipped && { skipped }) } } : part)) }
          : item,
      ),
      // An undone fix leaves no "Fixed" bubble on the canvas (there is one at a time).
      ...(state === 'undone' && { fixNotes: {} }),
    }));
  },

  updateParts(itemId, fn) {
    set((s) => ({ items: s.items.map((item) => (item.id === itemId && item.role === 'assistant' ? { ...item, parts: fn(item.parts) } : item)) }));
  },
}));

/** The last reply offers "Test and fix" for a flow just drafted. */
export const offersTest = (items: ChatItem[]) => {
  const last = items.at(-1);
  return last?.role === 'assistant' && last.parts.some((p) => p.kind === 'action' && p.action === 'test' && !p.state);
};

/** Spotlight works on its own: drafting a flow, testing and fixing it, or a drafted flow waiting for its test. */
export const useWorking = () => useAssistant((s) => s.drafting || Boolean(s.testing) || offersTest(s.items));

/** The execution of the last run Spotlight started: its end is a row, not a toast, even once the session is over. */
let ownedRun: string | undefined;
export const ownRun = (executionId: string | undefined) => (ownedRun = executionId);

/** A run Spotlight started (a test-and-fix session, a draft's first test): its timeline says how it went, not a toast. */
export function spotlightOwnsRun(): boolean {
  const { executionId } = useEditor.getState();
  if (executionId && executionId === ownedRun) return true;
  const s = useAssistant.getState();
  return Boolean(s.testing || s.pending || s.drafting) || s.items.some((item) => item.role === 'assistant' && item.parts.some((p) => p.kind === 'run' && p.run.state === 'running'));
}

/**
 * The node that shows what a fix changed, once applied: the node the fix was asked for when the fix touched it (or touched
 * nothing by name), else the first node its ops change or add (by its name after the change). One bubble, not one per
 * node: on a small canvas several would cover the flow.
 */
export function fixedNodes(ops: AssistantOp[], fallback?: string): string[] {
  const nodes = useEditor.getState().nodes;
  const byName = (name: string) => nodes.find((n) => n.data.wf.name === name || n.id === name)?.id;
  const names = ops.flatMap((op) => {
    if (op.op === 'addNode') return [op.name];
    if (op.op === 'renameNode') return [op.name];
    if (op.op === 'setParameters' || op.op === 'setNodeSettings') return [op.node];
    if (op.op === 'connect') return [op.to];
    return [];
  });
  const ids = [...new Set(names.flatMap((name) => (name ? [byName(name)] : [])).filter((id): id is string => Boolean(id)))];
  const asked = fallback && nodes.some((n) => n.id === fallback) ? fallback : undefined;
  if (asked && (!ids.length || ids.includes(asked))) return [asked];
  return ids.slice(0, 1);
}
