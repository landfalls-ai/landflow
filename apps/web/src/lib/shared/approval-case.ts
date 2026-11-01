/**
 * An approval with its evidence (docs/run-trace.md#an-approval-with-its-evidence), the part that reads one wait: what the
 * member wants and recommends in its own words, the case (what the tool acts on, its input made readable), the button that
 * names the action, and how an edited input is built from what the person typed. Pure: the decision card (run-trace/
 * approval-card.tsx) draws it, and the evidence it looked at is in approval-evidence.ts.
 */
import { targetOf } from './team-progress';
import { cut, type NeedsYouItem, type RunModel } from './run-trace-model';

export type ApprovalWait = Extract<NeedsYouItem, { kind: 'wait' }>;

export type CaseKind = 'review' | 'command' | 'file' | 'publish' | 'other';
export type ReviewVerdict = 'approve' | 'request_changes' | 'comment';

/** One line of the case: `block` is text that wraps (a review's body), `mono` code. */
export interface CaseRow {
  label: string;
  value: string;
  mono?: boolean;
  block?: boolean;
}

/** What Edit opens: a review's verdict and body, a command, or the whole input as JSON. */
export type CaseEdit =
  | { kind: 'review'; verdict: ReviewVerdict; body: string }
  | { kind: 'command'; command: string }
  | { kind: 'json'; json: string };

export interface ApprovalCase {
  /** Who wants it (a team member), when the wait says. */
  member?: string;
  /** The tool as the wait names it ("Comment on pull request", "Bash"). */
  toolName: string;
  /** What it acts on: "#5", a path, a branch. */
  target?: string;
  kind: CaseKind;
  rows: CaseRow[];
  verdict?: ReviewVerdict;
  /** The button that approves: named by the action. */
  verb: string;
  /** The tool call waiting (a tool approval), else absent (a guard's ask has the `ask` id instead). */
  callId?: string;
  ask?: string;
  /** The input as recorded; absent for an ask (its command is the whole input). */
  input?: Record<string, unknown>;
  edit: CaseEdit;
  /** What the member wants and recommends, one or two sentences. */
  words?: string;
}

const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const str = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value.trim() : undefined);

/** "pull_request_review_write" → "Pull request review write"; names that already read well stay as they are. */
export function readableTool(name: string): string {
  if (!/^[a-z0-9]+(?:[_-][a-z0-9]+)+$/.test(name)) return name;
  const words = name.replace(/[_-]+/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const VERDICTS: Record<string, ReviewVerdict> = { approve: 'approve', approved: 'approve', request_changes: 'request_changes', requestchanges: 'request_changes', comment: 'comment', commented: 'comment' };

/** The verdict a review's input carries (`event` in GitHub's API: APPROVE, REQUEST_CHANGES, COMMENT). */
function verdictOf(input: Record<string, unknown> | undefined): ReviewVerdict | undefined {
  const raw = str(input?.event) ?? str(input?.verdict) ?? str(input?.state);
  return raw ? VERDICTS[raw.toLowerCase().replace(/[\s-]+/g, '_')] : undefined;
}

export const VERDICT_LABEL: Record<ReviewVerdict, string> = { approve: 'Approve', request_changes: 'Request changes', comment: 'Comment' };

function kindOf(tool: string, input: Record<string, unknown> | undefined, ask: boolean): CaseKind {
  if (ask) return 'command';
  const name = tool.toLowerCase();
  if (verdictOf(input) && (/review/.test(name) || typeof input?.body === 'string' || typeof input?.pullNumber === 'number' || typeof input?.pull_number === 'number')) return 'review';
  if (/review/.test(name) && typeof input?.body === 'string') return 'review';
  if (/publish/.test(name)) return 'publish';
  if (typeof input?.command === 'string' || /^(bash|shell|sh|exec|run command|run the command|command)\b/.test(name)) return 'command';
  if (str(input?.path ?? input?.file_path ?? input?.filePath) && /write|edit|create|update|save|put|delete|remove/.test(name)) return 'file';
  return 'other';
}

/** The first `max` sentences of a text, cut. */
export function sentences(text: string, max = 2, chars = 260): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const parts = flat.match(/[^.!?]+[.!?]+(?=\s|$)|[^.!?]+$/g) ?? [flat];
  return cut(parts.slice(0, max).join(' ').trim(), chars);
}

/**
 * What the member says about the tool: the reason it gave (an ask's `reason`, else the reason on its latest turn) and its
 * last words before the wait (a message to its manager, or what it said between tool calls). One or two sentences.
 */
export function approvalWords(model: RunModel | undefined, wait: ApprovalWait): string | undefined {
  const reason = str(wait.attrs.reason);
  const member = str(wait.attrs.member);
  let said: string | undefined;
  let turnReason: string | undefined;
  if (model && member) {
    const same = (name: string) => name.trim().toLowerCase() === member.toLowerCase();
    const before = Date.parse(wait.since) || Infinity;
    const actor = model.actors.find((a) => same(a.actor.name))?.actor;
    const heard: Array<{ at: number; seq: number; text: string }> = [];
    for (const m of model.messages) if (same(m.from.name) && Date.parse(m.at) <= before) heard.push({ at: Date.parse(m.at), seq: m.seq, text: m.text });
    if (actor) {
      for (const span of model.order) {
        if (span.actor.id !== actor.id) continue;
        for (const w of span.said) if (Date.parse(w.at) <= before) heard.push({ at: Date.parse(w.at), seq: w.seq, text: w.text });
      }
      const turn = (model.turns[actor.id] ?? []).filter((t) => Date.parse(t.at) <= before).at(-1);
      turnReason = turn?.reason ?? [...(turn?.did ?? [])].reverse().find((d) => d.reason)?.reason;
    }
    heard.sort((a, b) => a.at - b.at || a.seq - b.seq);
    said = heard.at(-1)?.text.trim() || undefined;
  }
  const why = reason ?? turnReason;
  const parts = [why && sentences(why, 1), said && sentences(said, 1)].filter((p): p is string => Boolean(p));
  // The same thing said twice is said once.
  const unique = parts.filter((p, i) => parts.findIndex((q) => q.toLowerCase() === p.toLowerCase() || q.toLowerCase().includes(p.toLowerCase()) || p.toLowerCase().includes(q.toLowerCase())) === i);
  return unique.length ? cut(unique.join(' '), 300) : undefined;
}

const valueText = (value: unknown, max = 160): string => {
  if (typeof value === 'string') return cut(value.replace(/\s+/g, ' ').trim(), max);
  if (value === undefined || value === null) return '';
  try {
    return cut(JSON.stringify(value), max);
  } catch {
    return cut(String(value), max);
  }
};

/** Keys that say where a tool acts (shown as the target, not repeated as rows). */
const PLUMBING = new Set(['owner', 'repo', 'method', 'pullNumber', 'pull_number', 'issue_number', 'issueNumber', 'number']);

/** The input as key: value rows, the long ones last. */
function otherRows(input: Record<string, unknown>, skip: Set<string> = new Set()): CaseRow[] {
  const rows: CaseRow[] = [];
  for (const [key, value] of Object.entries(input)) {
    if (skip.has(key) || value === undefined || value === null || value === '') continue;
    const text = valueText(value, 200);
    if (text) rows.push({ label: key, value: text, ...(typeof value === 'string' && value.length > 80 && { block: true }), ...(typeof value !== 'string' && { mono: true }) });
  }
  return rows.slice(0, 8);
}

/** The repository an input names ("plugins"), shown before the target ("plugins · #5"). */
const repoOf = (input: Record<string, unknown> | undefined) => str(input?.repo) ?? str(input?.repository);

/** The case of an approval wait: what is asked, on what, with what input, and the button that approves it. */
export function approvalCase(wait: ApprovalWait, model?: RunModel): ApprovalCase {
  const attrs = wait.attrs;
  const calls = Array.isArray(attrs.calls) ? attrs.calls.filter(isObject) : [];
  const call = calls[0];
  const ask = str(attrs.ask);
  const command = str(attrs.command);
  const input = isObject(call?.input) ? call.input : undefined;
  const toolName = str(attrs.tool) ?? str(call?.tool) ?? (ask ? 'Bash' : 'a tool');
  const kind = kindOf(toolName, ask ? { command } : input, Boolean(ask));
  const member = str(attrs.member);
  const targetBase = str(attrs.target) ?? targetOf(input);
  const repo = repoOf(input);
  const target = targetBase ? (repo && !targetBase.includes(repo) ? `${repo} · ${targetBase}` : targetBase) : repo;
  const words = approvalWords(model, wait);
  const common = { ...(member && { member }), toolName: readableTool(toolName), ...(target && { target }), ...(call?.id !== undefined && !ask && { callId: String(call.id) }), ...(ask && { ask }), ...(input && { input }), ...(words && { words }) };

  if (kind === 'review') {
    const verdict = verdictOf(input) ?? 'comment';
    const body = str(input?.body) ?? '';
    const rows: CaseRow[] = [{ label: 'Verdict', value: VERDICT_LABEL[verdict] }, ...(body ? [{ label: 'Review', value: body, block: true }] : [])];
    return { ...common, kind, rows, verdict, verb: verbOf(kind, toolName, verdict), edit: { kind: 'review', verdict, body } };
  }
  if (kind === 'command') {
    const text = command ?? str(input?.command) ?? '';
    const cwd = str(attrs.cwd) ?? str(input?.cwd);
    const rows: CaseRow[] = [{ label: 'Command', value: text, mono: true, block: true }, ...(cwd ? [{ label: 'In', value: cwd, mono: true }] : [])];
    return { ...common, kind, rows, verb: verbOf(kind, toolName), edit: { kind: 'command', command: text } };
  }
  const json = JSON.stringify(input ?? {}, null, 2);
  if (kind === 'file') {
    const path = str(input?.path ?? input?.file_path ?? input?.filePath) ?? '';
    const rows: CaseRow[] = [{ label: 'Path', value: path, mono: true }, ...otherRows(input ?? {}, new Set(['path', 'file_path', 'filePath']))];
    return { ...common, kind, rows, verb: verbOf(kind, toolName), edit: { kind: 'json', json } };
  }
  const rows = otherRows(input ?? {}, PLUMBING);
  return { ...common, kind, rows, verb: verbOf(kind, toolName), edit: { kind: 'json', json } };
}

/** The button that approves, named by what it does. */
export function verbOf(kind: CaseKind, toolName: string, verdict?: ReviewVerdict): string {
  if (kind === 'review') return verdict === 'approve' ? 'Post review & approve' : verdict === 'request_changes' ? 'Post review & request changes' : 'Post review comment';
  if (kind === 'command') return 'Run the command';
  if (kind === 'publish') return /notes?/i.test(toolName) ? 'Publish notes' : 'Publish';
  if (kind === 'file') return 'Write the file';
  return `Approve: ${readableTool(toolName)}`;
}

/** What a draft of the edit comes to as the input sent with the approval. */
export type EditResult = { ok: true; changed: boolean; input?: Record<string, unknown>; command?: string } | { ok: false; error: string };

const EVENT_OF: Record<ReviewVerdict, string> = { approve: 'APPROVE', request_changes: 'REQUEST_CHANGES', comment: 'COMMENT' };

/**
 * The edited input from what the person typed. A review keeps the recorded input and changes its verdict and body (the verdict
 * is written in the style the input used: GitHub's APPROVE or a lower-case word); a command changes `command` (for a guard's
 * ask, `command` is the whole answer); anything else is JSON that must be an object.
 */
export function editedInput(c: ApprovalCase, draft: CaseEdit): EditResult {
  if (draft.kind === 'command') {
    const command = draft.command.trim();
    if (!command) return { ok: false, error: 'The command is empty' };
    if (c.ask) return { ok: true, changed: c.edit.kind === 'command' && c.edit.command.trim() !== command, command };
    const input = { ...(c.input ?? {}), command };
    return { ok: true, changed: c.edit.kind === 'command' && c.edit.command.trim() !== command, input };
  }
  if (draft.kind === 'review') {
    const original = c.input ?? {};
    const upper = typeof original.event === 'string' && original.event === original.event.toUpperCase();
    const key = 'verdict' in original && !('event' in original) ? 'verdict' : 'event';
    const input: Record<string, unknown> = { ...original, [key]: upper || key === 'event' ? EVENT_OF[draft.verdict] : draft.verdict, body: draft.body };
    const was = c.edit.kind === 'review' ? c.edit : undefined;
    return { ok: true, changed: !was || was.verdict !== draft.verdict || was.body !== draft.body, input };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(draft.json);
  } catch (error) {
    return { ok: false, error: `Not valid JSON: ${(error as Error).message}` };
  }
  if (!isObject(parsed)) return { ok: false, error: 'The input must be a JSON object' };
  return { ok: true, changed: JSON.stringify(parsed) !== JSON.stringify(c.input ?? {}), input: parsed };
}
