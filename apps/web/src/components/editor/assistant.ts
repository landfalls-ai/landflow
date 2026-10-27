'use client';
/**
 * Client side of the editor assistant (docs/assistant.md): applying proposed
 * ops to the canvas with an undo, after-run suggestions cached per run, and
 * Spotlight's conversation, kept while the editor is open.
 */
import { nanoid } from 'nanoid';
import { toast } from 'sonner';
import { create } from 'zustand';
import { api, streamEvents } from '@/lib/client/api';
import { applyOps, digestRun, type AssistantOp, type DescriptorLookup, type RunDigest } from '@/lib/shared/assistant-ops';
import type { NodeRun } from '@/lib/shared/types';
import { useEditor } from './store';

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
export function sendFeedback(kind: ChangeKind, action: 'applied' | 'dismissed') {
  api('/api/assistant/feedback', { method: 'POST', json: { kind, action } }).catch(() => {});
}

/**
 * Apply one or more changes (each a list of ops) to the canvas as one step
 * with one undo. Ops that no longer fit (the workflow changed since they were
 * proposed) are skipped. Returns false when nothing applied.
 */
export function applyChanges(changes: Array<{ ops: AssistantOp[]; kind: ChangeKind }>, label: string): boolean {
  const state = useEditor.getState();
  const lookup = editorLookup();
  let workflow = state.toWorkflow();
  const added: string[] = [];
  const dropped: string[] = [];
  let edited: string | undefined;
  let count = 0;
  for (const change of changes) {
    const result = applyOps(workflow, change.ops, lookup);
    workflow = result.workflow;
    added.push(...result.added.filter((id) => workflow.nodes.some((n) => n.id === id)));
    dropped.push(...result.dropped);
    count += result.applied.length;
    const op = result.applied.findLast((o) => o.op === 'setParameters' || o.op === 'renameNode');
    if (op?.op === 'renameNode') edited = workflow.nodes.find((n) => n.name === op.name)?.id;
    else if (op?.op === 'setParameters') edited = workflow.nodes.find((n) => n.name === op.node || n.id === op.node)?.id;
    if (result.applied.length) sendFeedback(change.kind, 'applied');
  }
  if (!count) {
    toast.error('Couldn’t apply the change', { description: dropped[0] ?? 'Nothing to change.' });
    return false;
  }
  // Select what changed: the last node added, else the node edited.
  const focusId = added.at(-1) ?? edited;
  const undo = state.replaceGraph(workflow, focusId ? { id: focusId, added: added.includes(focusId) } : undefined);
  const skipped = dropped.length ? `Skipped ${dropped.length}: ${dropped[0]}` : undefined;
  // Long enough to look at the canvas before deciding to undo.
  toast.success(label, { description: skipped, action: { label: 'Undo', onClick: undo }, duration: 15_000 });
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
    if (action === 'dismissed') sendFeedback(suggestion.kind, 'dismissed');
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
  state?: 'applied' | 'dismissed';
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
  | ({ kind: 'action' } & ReplyAction);

/** `testId`: the test-and-fix session the turn belongs to; Spotlight folds a finished session into one line. */
export type ChatItem =
  /** `auto`: written by a test-and-fix session, not typed. */
  | { id: string; role: 'user'; text: string; auto?: boolean; testId?: string }
  | { id: string; role: 'assistant'; parts: ReplyPart[]; done?: { model: string; durationMs: number; steps: number }; error?: string; testId?: string };

type StreamEvent =
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string; label: string; ok: boolean }
  | ({ type: 'proposal' } & Omit<Proposal, 'state'>)
  | { type: 'done'; model: string; durationMs: number; steps: number }
  | { type: 'error'; message: string };

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
  session?: 'fix' | 'review';
  /** The test-and-fix session the request belongs to. */
  testId?: string;
}

interface AssistantState {
  /** The conversation is shown above Spotlight's bar. */
  open: boolean;
  workflowId?: string;
  items: ChatItem[];
  pending: boolean;
  abort?: AbortController;
  /** A test-and-fix session is running (./test-session.ts); aborting it stops the session. */
  testing?: AbortController;
  /** The flow builder is drafting a flow on the empty canvas. */
  drafting: boolean;
  /** The node a test-and-fix session is asking a fix for: the canvas marks it. */
  fixing?: string;
  /**
   * While Spotlight works on its own (drafting, testing and fixing), the conversation waits in a card at the side of the
   * canvas so the flow stays in view; true shows it in full instead.
   */
  detail: boolean;
  setOpen(open: boolean): void;
  /** Start over when another workflow is opened. */
  bind(workflowId: string): void;
  send(text: string, options?: SendOptions): Promise<void>;
  /** Add turns that didn't come from the chat (a flow the builder drafted, a fix from after-run suggestions). */
  append(items: ChatItem[]): void;
  stop(): void;
  reset(): void;
  setProposalState(itemId: string, proposalId: string, state: 'applied' | 'dismissed'): void;
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

export const useAssistant = create<AssistantState>((set, get) => ({
  open: false,
  items: [],
  pending: false,
  drafting: false,
  detail: false,

  setOpen(open) {
    set({ open });
  },

  bind(workflowId) {
    if (get().workflowId === workflowId) return;
    get().abort?.abort();
    get().testing?.abort();
    set({ workflowId, items: [], pending: false, abort: undefined, testing: undefined, fixing: undefined, detail: false });
    useSuggestions.getState().clear();
  },

  async send(text, options = {}) {
    const message = text.trim();
    if (!message || get().pending) return;
    const editor = useEditor.getState();
    const group = options.testId ? { testId: options.testId } : {};
    const user: ChatItem = { id: nanoid(8), role: 'user', text: message, ...(options.auto && { auto: true }), ...group };
    const reply: ChatItem = { id: nanoid(8), role: 'assistant', parts: [], ...group };
    const abort = new AbortController();
    const messages = historyOf(options.fresh ? [user] : [...get().items, user]);
    set((s) => ({ open: true, items: [...s.items, user, reply], pending: true, abort }));
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
          ...(options.mentions && { mentions: options.mentions }),
          ...(options.session && { session: options.session }),
        },
        (_event, data) => {
          const event = data as StreamEvent;
          if (event.type === 'text') patch((item) => ({ parts: [...item.parts, { kind: 'text', text: event.text }] }));
          else if (event.type === 'tool') patch((item) => ({ parts: [...item.parts, { kind: 'tool', tool: { name: event.name, label: event.label, ok: event.ok } }] }));
          else if (event.type === 'proposal') {
            const { type: _type, ...proposal } = event;
            patch((item) => ({ parts: [...item.parts, { kind: 'proposal', proposal }] }));
          } else if (event.type === 'done') patch(() => ({ done: { model: event.model, durationMs: event.durationMs, steps: event.steps } }));
          else if (event.type === 'error') patch(() => ({ error: event.message }));
        },
        abort.signal,
      );
    } catch (e) {
      if ((e as Error).name !== 'AbortError') patch(() => ({ error: (e as Error).message }));
    } finally {
      if (get().abort === abort) set({ pending: false, abort: undefined });
    }
  },

  append(items) {
    set((s) => ({ open: true, items: [...s.items, ...items] }));
  },

  stop() {
    get().abort?.abort();
    get().testing?.abort();
    set({ pending: false, abort: undefined, testing: undefined, fixing: undefined });
  },

  reset() {
    get().abort?.abort();
    get().testing?.abort();
    set({ items: [], pending: false, abort: undefined, testing: undefined, fixing: undefined, detail: false });
  },

  setProposalState(itemId, proposalId, state) {
    set((s) => ({
      items: s.items.map((item) =>
        item.id === itemId && item.role === 'assistant'
          ? { ...item, parts: item.parts.map((part) => (part.kind === 'proposal' && part.proposal.id === proposalId ? { ...part, proposal: { ...part.proposal, state } } : part)) }
          : item,
      ),
    }));
  },

  updateParts(itemId, fn) {
    set((s) => ({ items: s.items.map((item) => (item.id === itemId && item.role === 'assistant' ? { ...item, parts: fn(item.parts) } : item)) }));
  },
}));
