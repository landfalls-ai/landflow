/**
 * Looking across runs (docs/run-trace.md, "Search, compare and measures"): `GET /api/runs/search`, `/compare` and
 * `/measures` read the journal (`execution_events`) with plain SQL that runs the same on SQLite and Postgres (`LIKE` on
 * the stored event, `EXISTS`), then check each candidate run's events in code, so a word that only matches a field name
 * does not count. A run's numbers come from `foldJournal`, the fold the run page reads.
 */
import type { ExecutionSummary } from '../../shared/types';
import type { JournalEvent } from '../../shared/run-trace';
import { digestRun, measureOf, type RunDigest, type RunMeasure } from '../../shared/run-compare';
import { foldJournal } from '../../shared/run-trace-model';
import { database } from '../db';
import { parse } from '../db/rows';
import { store } from '../store';
import { rebuildJournal } from './index';
import { lastSeq, readAll as loadEvents } from './store';

export interface RunSearchFilters {
  /** Words in a span's name, input or output, a message, an artifact or a check. */
  text?: string;
  workflowId?: string;
  /** An actor (agent, model, person) by name or id: one that took part or was asked. */
  actor?: string;
  /** A tool call by its name. */
  tool?: string;
  status?: string;
  /** Some step (a tool call or a node) failed. */
  failedSteps?: boolean;
  /** A check failed: by (part of) its name; the empty string, any check. */
  failedCheck?: string;
  /** ISO dates or `YYYY-MM-DD`: runs started from / up to. */
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

export interface RunSearchHit {
  executionId: string;
  workflowId: string;
  workflowName: string;
  status: string;
  startedAt: string;
  durationMs: number;
  /** Where the words were found: `Developer · output: …the match…`. */
  matches: string[];
  /** Present when the search read the run's journal. */
  failedSteps?: number;
  failedChecks?: string[];
}

export interface RunSearchResult {
  items: RunSearchHit[];
  /** Another page follows. */
  more: boolean;
  /** The search stopped at the most runs it reads per request: narrow it down. */
  truncated?: boolean;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
/** Candidate runs read per request, and per query. */
const MAX_SCAN = 1000;
const BATCH = 100;
const SNIPPET = 140;

const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** `LIKE` pattern for a word, `\` as the escape character. */
const like = (word: string) => `%${word.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
/** The word as it sits inside a stored JSON string. */
const inJson = (word: string) => JSON.stringify(word).slice(1, -1);

/** The strings in a value (the leaves, not the keys), cut off after a few. */
function strings(value: unknown, out: string[] = [], depth = 0): string[] {
  if (out.length > 60 || depth > 6) return out;
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) strings(v, out, depth + 1);
  else if (isObject(value)) for (const v of Object.values(value)) strings(v, out, depth + 1);
  return out;
}

const around = (text: string, at: number) => {
  const start = Math.max(0, at - 40);
  const cut = text.slice(start, start + SNIPPET).replace(/\s+/g, ' ').trim();
  return `${start > 0 ? '…' : ''}${cut}${start + SNIPPET < text.length ? '…' : ''}`;
};

/** What a run's events say about the filters: every one that was asked must hold. */
function verify(events: JournalEvent[], filters: RunSearchFilters): { ok: boolean; matches: string[]; failedSteps: number; failedChecks: string[] } {
  const text = filters.text?.trim().toLowerCase();
  const actor = filters.actor?.trim().toLowerCase();
  const tool = filters.tool?.trim().toLowerCase();
  const check = filters.failedCheck?.trim().toLowerCase();
  const kinds = new Map<string, string>();
  const names = new Map<string, string>();
  const matches: string[] = [];
  let sawText = !text;
  let sawActor = !actor;
  let sawTool = !tool;
  let failedSteps = 0;
  const failedChecks: string[] = [];
  const has = (value: string | undefined, word: string) => Boolean(value) && value!.toLowerCase().includes(word);

  for (const event of events) {
    if (event.type === 'span.started') {
      kinds.set(event.spanId, event.kind);
      names.set(event.spanId, event.name);
      if (actor && (has(event.actor.name, actor) || has(event.actor.id, actor) || has(event.caller?.name, actor))) sawActor = true;
      if (tool && event.kind === 'tool' && (has(event.name, tool) || has(String(event.attrs?.tool ?? ''), tool))) sawTool = true;
    } else if (event.type === 'message' && actor && (has(event.from.name, actor) || has(event.from.id, actor) || has(event.to?.name, actor))) sawActor = true;
    else if (event.type === 'span.ended' && event.status === 'error') {
      const kind = kinds.get(event.spanId);
      if (kind === 'tool' || kind === 'step') failedSteps++;
    } else if (event.type === 'check' && event.check.status === 'fail' && (!check || has(event.check.name, check))) {
      if (!failedChecks.includes(event.check.name)) failedChecks.push(event.check.name);
    }
    if (text && matches.length < 3) {
      let fields: Array<[string, unknown]>;
      if (event.type === 'span.started') fields = [['name', event.name], ['input', event.input]];
      else if (event.type === 'span.ended') fields = [['output', event.output], ['error', event.error]];
      else if (event.type === 'message') fields = [['said', event.text]];
      else if (event.type === 'artifact') fields = [['artifact', [event.artifact.name, event.artifact.text, event.artifact.url]]];
      else if (event.type === 'check') fields = [['check', [event.check.name, event.check.message, event.check.subject]]];
      else fields = [];
      for (const [label, value] of fields) {
        const hit = strings(value).find((s) => s.toLowerCase().includes(text));
        if (!hit) continue;
        sawText = true;
        const who = event.type === 'span.started' ? event.actor.name : event.type === 'message' ? event.from.name : (names.get(event.spanId) ?? '');
        matches.push(`${who ? `${who} · ` : ''}${label}: ${around(hit, hit.toLowerCase().indexOf(text))}`);
        break;
      }
    }
  }
  const ok = sawText && sawActor && sawTool && (!filters.failedSteps || failedSteps > 0) && (filters.failedCheck === undefined || failedChecks.length > 0);
  return { ok, matches, failedSteps, failedChecks };
}

/** A date or a date-time as an ISO string; `to` of a plain date runs to the end of the day. */
function iso(value: string | undefined, end = false): string | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return end ? `${raw}T23:59:59.999Z` : `${raw}T00:00:00.000Z`;
  const time = Date.parse(raw);
  return Number.isNaN(time) ? undefined : new Date(time).toISOString();
}

/**
 * Runs matching every filter, newest first. `visible`: the workflow ids the caller may see (undefined: all). Running
 * executions are left out, like the executions list; a run without a journal matches only the filters that need none.
 */
export function searchRuns(filters: RunSearchFilters, visible?: Set<string>): RunSearchResult {
  const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(filters.limit ?? DEFAULT_LIMIT) || DEFAULT_LIMIT));
  const offset = Math.max(0, Math.floor(filters.offset ?? 0) || 0);
  const where = ["status <> 'running'"];
  const params: Array<string | number> = [];
  if (filters.workflowId) (where.push('workflow_id = ?'), params.push(filters.workflowId));
  if (filters.status) (where.push('status = ?'), params.push(filters.status));
  const from = iso(filters.from);
  const to = iso(filters.to, true);
  if (from) (where.push('started_at >= ?'), params.push(from));
  if (to) (where.push('started_at <= ?'), params.push(to));

  const exists = (clause: string, ...values: string[]) => {
    where.push(`EXISTS (SELECT 1 FROM execution_events e WHERE e.execution_id = executions.id AND ${clause})`);
    params.push(...values);
  };
  const text = filters.text?.trim().toLowerCase();
  if (text) {
    const a = like(text);
    const b = like(inJson(text));
    exists(a === b ? "LOWER(e.data) LIKE ? ESCAPE '\\'" : "(LOWER(e.data) LIKE ? ESCAPE '\\' OR LOWER(e.data) LIKE ? ESCAPE '\\')", ...(a === b ? [a] : [a, b]));
  }
  const actor = filters.actor?.trim().toLowerCase();
  if (actor) exists("e.type IN ('span.started', 'message') AND LOWER(e.data) LIKE ? ESCAPE '\\'", like(inJson(actor)));
  const tool = filters.tool?.trim().toLowerCase();
  if (tool) exists(`e.type = 'span.started' AND e.data LIKE '%"kind":"tool"%' AND LOWER(e.data) LIKE ? ESCAPE '\\'`, like(inJson(tool)));
  if (filters.failedSteps) exists(`e.type = 'span.ended' AND e.data LIKE '%"status":"error"%'`);
  if (filters.failedCheck !== undefined) {
    const name = filters.failedCheck.trim().toLowerCase();
    if (name) exists(`e.type = 'check' AND e.data LIKE '%"status":"fail"%' AND LOWER(e.data) LIKE ? ESCAPE '\\'`, like(inJson(name)));
    else exists(`e.type = 'check' AND e.data LIKE '%"status":"fail"%'`);
  }
  const journalFilters = Boolean(text || actor || tool || filters.failedSteps || filters.failedCheck !== undefined);

  const db = database();
  const sql = `SELECT summary FROM executions WHERE ${where.join(' AND ')} ORDER BY started_at DESC, id DESC LIMIT ? OFFSET ?`;
  const items: RunSearchHit[] = [];
  const want = offset + limit + 1;
  let matched = 0;
  let scanned = 0;
  let truncated = false;
  search: for (let page = 0; ; page++) {
    const rows = db.all<{ summary: string }>(sql, ...params, BATCH, page * BATCH);
    for (const row of rows) {
      const run = parse<ExecutionSummary>(row.summary);
      if (!run || (visible && !visible.has(run.workflowId))) continue;
      let hit: RunSearchHit = { executionId: run.id, workflowId: run.workflowId, workflowName: run.workflowName, status: run.status, startedAt: run.startedAt, durationMs: run.durationMs, matches: [] };
      if (journalFilters) {
        const found = verify(loadEvents(run.id), filters);
        if (!found.ok) continue;
        hit = { ...hit, matches: found.matches, failedSteps: found.failedSteps, failedChecks: found.failedChecks };
      }
      if (++matched > offset) items.push(hit);
      if (matched >= want) break search;
    }
    scanned += rows.length;
    if (rows.length < BATCH) break;
    if (scanned >= MAX_SCAN) {
      truncated = true;
      break;
    }
  }
  return { items: items.slice(0, limit), more: items.length > limit, ...(truncated && { truncated }) };
}

// ---- one run folded ---------------------------------------------------------

const digests = new Map<string, RunDigest>();
const MAX_CACHED = 300;

/**
 * The numbers of a saved run, from its journal (rebuilt first when it has none). Cached by the last journal number, so a
 * finished run is folded once.
 */
export function digestOf(executionId: string): RunDigest | undefined {
  const record = store.getExecution(executionId);
  if (!record) return undefined;
  const workflow = record.workflow ?? store.getWorkflow(record.workflowId);
  if (record.status !== 'running') rebuildJournal(record, workflow);
  const key = `${executionId}:${lastSeq(executionId)}:${record.status}`;
  let digest = digests.get(key);
  if (!digest) {
    digest = digestRun(foldJournal(loadEvents(executionId)), { executionId, workflowId: record.workflowId, workflowName: record.workflowName });
    // A finished run's wall time is the record's when the journal never saw the run end.
    if (!digest.durationMs && record.durationMs) digest = { ...digest, durationMs: record.durationMs };
    if (digests.size >= MAX_CACHED) digests.delete(digests.keys().next().value!);
    digests.set(key, digest);
  }
  return digest;
}

/** A workflow's last runs as points over time, oldest first. */
export function measuresOf(workflowId: string, limit = 30): RunMeasure[] {
  const runs = store.listExecutions({ workflowId, limit: Math.min(100, Math.max(1, Math.floor(limit) || 30)) });
  const points: RunMeasure[] = [];
  for (const run of runs.reverse()) {
    const digest = digestOf(run.id);
    if (digest) points.push({ ...measureOf(digest), startedAt: digest.startedAt ?? run.startedAt });
  }
  return points;
}
