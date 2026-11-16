/**
 * The runs and calls behind one row of the AI page's report (wave 13, SP09; docs/llm-gateway.md "The AI page"): what
 * `GET /api/insights/ai/runs` and `…/calls` answer, as JSON or CSV. A row of the report is a group (`group`) and one key
 * of it (`key`) over the report's period and filters; this lists what is behind it.
 *
 * Who may open what follows docs/llm-gateway.md "Who sees what" (rule 3): a call opens through run-spend.ts's own
 * `canOpenCall` (admin; the run, the agent or a role in the row's project; a call with none of those only for its own
 * person; never a child session of an agent the viewer can't read). What can't be opened is summed into `hidden`:
 * counts and cost, no names and no ids. Rows come from plain SQL over `ai_usage` (the daily rollup has no run ids) and
 * follow the report's visibility: an admin sees every row; anyone else the rows of their own, of a workflow or agent they
 * can read, except in the person group, which covers every row (D1) when no project, agent, workflow or credential
 * filter narrows it (under one, a person row holds only the rows the viewer can see, as `peopleTotals` does). Numbers,
 * names and ids only: never prompt text (constitution note 17).
 */
import { z } from 'zod';
import { agentStore } from '../agents/store';
import { getGoal } from '../goals/store';
import { visibleGoals } from '../goals/views';
import { database, type SqlValue } from '../db';
import { HttpError } from '../errors';
import { sourceKey } from '../llm-gateway/console';
import { canResource, isInstanceAdmin, projectRole, visibleIds, visibleProjectIds, type Actor } from '../projects/access';
import { getProject, homeProjectId } from '../projects/store';
import { store } from '../store';
import { isCallPurpose } from '../../shared/ai-call';
import {
  AI_SPEND_CSV_MAX_ROWS,
  AI_SPEND_GROUPS,
  AI_SPEND_PAGE_SIZE,
  AI_SPEND_PERIODS,
  type AiSpendCall,
  type AiSpendCallsPage,
  type AiSpendGroup,
  type AiSpendHidden,
  type AiSpendRun,
  type AiSpendRunsPage,
} from '../../shared/ai-spend';
import { emptySpendTotals } from '../../shared/run-spend';
import { canOpenCall, canOpenRun } from './run-spend';
import { currentRange } from './spend-report';
import { findPrice, priceOverrides } from './prices';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;
const round = (n: number) => Math.round(n * 1e8) / 1e8;
const text = z.string().trim().min(1).max(300);

/** The report's query (period, range and filters) plus what picks one row of one group and how to list it. */
export const aiSpendListQuerySchema = z
  .object({
    period: z.enum(AI_SPEND_PERIODS).default('7d'),
    from: z.string().regex(DAY).optional(),
    to: z.string().regex(DAY).optional(),
    projectId: text.optional(),
    agentId: text.optional(),
    workflowId: text.optional(),
    userId: text.optional(),
    credentialId: text.optional(),
    model: text.optional(),
    purpose: text.optional(),
    source: text.optional(),
    surface: text.optional(),
    group: z.enum(AI_SPEND_GROUPS),
    key: text,
    order: z.enum(['cost', 'recent']).optional(),
    cursor: z.string().max(600).optional(),
    format: z.enum(['json', 'csv']).default('json'),
  })
  .refine((q) => q.period !== 'custom' || (q.from && q.to), {
    message: 'A custom period needs from and to (YYYY-MM-DD)',
  })
  .refine((q) => !(q.from && q.to) || q.from <= q.to, {
    message: 'from is after to',
  });
export type AiSpendListQuery = z.infer<typeof aiSpendListQuerySchema>;

/** A problem with the query the caller can fix (400) or an id the caller can't read (404). */
export class SpendListError extends HttpError {
  static readonly errorName: string = 'SpendListError';
  constructor(message: string, status: 400 | 404) {
    super(message, status);
  }
}

interface Row {
  id: string;
  at: string;
  execution_id: string | null;
  workflow_id: string | null;
  agent_id: string | null;
  session_id: string | null;
  user_id: string | null;
  project_id: string | null;
  goal_id: string | null;
  credential_id: string | null;
  surface: string | null;
  provider: string;
  model: string;
  operation: string;
  source: string | null;
  runtime: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost: number;
  gateway_request_id: string | null;
  node_id: string | null;
  span_id: string | null;
  purpose: string | null;
  iteration: number | null;
  caller_agent_id: string | null;
  duration_ms: number | null;
  stop_reason: string | null;
}

const COLUMNS =
  'id, at, execution_id, workflow_id, agent_id, session_id, user_id, project_id, goal_id, credential_id, surface, provider, model, operation, source, runtime, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost, gateway_request_id, node_id, span_id, purpose, iteration, caller_agent_id, duration_ms, stop_reason';

const num = (v: unknown) => Number(v ?? 0) || 0;

function range(query: AiSpendListQuery, now: number): { clause: string; params: SqlValue[] } {
  if (query.period === '24h')
    return {
      clause: 'at >= ? AND at <= ?',
      params: [new Date(now - DAY_MS).toISOString(), new Date(now).toISOString()],
    };
  // The report's own days (a bad or too long custom range, or one ending after today, is a 400 as there).
  const { from, to } = currentRange({ period: query.period, from: query.from, to: query.to }, now);
  return { clause: 'day >= ? AND day <= ?', params: [from, to] };
}

/** A column with no value: the report reads NULL and an empty text alike (`COALESCE(column, '')`). */
const unset = (column: string) => `(${column} IS NULL OR ${column} = '')`;

/** What this query selects: the SQL that narrows it, and the test that decides (the SQL is only a shortcut). */
interface Selection {
  sql: Array<{ clause: string; params: SqlValue[] }>;
  test: (row: Row) => boolean;
  /** Rows of every person count in this group (D1); every other group only the rows the viewer can see. */
  everyone: boolean;
  /** Matches nothing the viewer can open, by name: every row it matches is counted in `hidden`. */
  allHidden: boolean;
}

function selection(actor: Actor, query: AiSpendListQuery): Selection {
  const admin = isInstanceAdmin(actor);
  const { group, key } = query;
  if (key === 'other') throw new SpendListError('The tail “Other” is not a row of its own: filter by a group to open it', 400);
  const sql: Selection['sql'] = [];
  const filters: Array<[string, string | undefined]> = [
    ['project_id', query.projectId],
    ['agent_id', query.agentId],
    ['workflow_id', query.workflowId],
    ['user_id', query.userId],
    ['credential_id', query.credentialId],
  ];
  for (const [column, value] of filters) if (value) sql.push({ clause: `${column} = ?`, params: [value] });
  // The report's own filter forms (spend-report.ts `source`): a model row's key (`provider/model`) or a bare model
  // name, and `none` for a surface or a purpose that is not set.
  if (query.model)
    sql.push({
      clause: "(model = ? OR provider || '/' || model = ?)",
      params: [query.model, query.model],
    });
  for (const [column, value] of [
    ['surface', query.surface],
    ['purpose', query.purpose],
  ] as const)
    if (value) sql.push(value === 'none' ? { clause: unset(column), params: [] } : { clause: `${column} = ?`, params: [value] });
  const sourceFilter = query.source;
  const projects = admin ? undefined : visibleProjectIds(actor);
  const projectOf = (row: Row) => {
    const id =
      row.project_id ||
      (row.workflow_id ? homeProjectId('workflow', row.workflow_id) : row.agent_id ? homeProjectId('agent', row.agent_id) : undefined);
    return id && getProject(id) ? id : undefined;
  };
  // The project filter is the row's own column in SQL, but the report resolves a row without one to its home project.
  if (query.projectId)
    sql.splice(
      sql.findIndex((s) => s.clause === 'project_id = ?'),
      1,
    );
  const filterTest = (row: Row) =>
    (!query.projectId || projectOf(row) === query.projectId) && (!sourceFilter || sourceKey(row.source, row.runtime) === sourceFilter);

  const readable = new Map<string, boolean>();
  const can = (kind: 'workflow' | 'agent' | 'credential', id: string) => {
    const k = `${kind}:${id}`;
    let ok = readable.get(k);
    if (ok === undefined) readable.set(k, (ok = admin || canResource(actor, kind, id, 'read')));
    return ok;
  };
  const column = (name: 'workflow_id' | 'agent_id' | 'credential_id', kind: 'workflow' | 'agent' | 'credential'): Selection => {
    if (key === 'none')
      return {
        sql: [{ clause: unset(name), params: [] }],
        test: (r) => !r[name],
        everyone: false,
        allHidden: false,
      };
    if (key === 'shared')
      return {
        sql: [{ clause: `${name} IS NOT NULL`, params: [] }],
        test: (r) => Boolean(r[name] && !can(kind, r[name] as string)),
        everyone: false,
        allHidden: true,
      };
    if (!can(kind, key)) throw new SpendListError('Not found', 404);
    return {
      sql: [{ clause: `${name} = ?`, params: [key] }],
      test: (r) => r[name] === key,
      everyone: false,
      allHidden: false,
    };
  };
  const simple = (name: string, test: (r: Row) => boolean, none = key === 'none'): Selection =>
    none
      ? {
          sql: [{ clause: unset(name), params: [] }],
          test: (r) => !(r as unknown as Record<string, unknown>)[name],
          everyone: false,
          allHidden: false,
        }
      : {
          sql: [{ clause: `${name} = ?`, params: [key] }],
          test,
          everyone: false,
          allHidden: false,
        };

  let picked: Selection;
  switch (group as AiSpendGroup) {
    case 'workflow':
      picked = column('workflow_id', 'workflow');
      break;
    case 'agent':
      picked = column('agent_id', 'agent');
      break;
    case 'credential':
      picked = column('credential_id', 'credential');
      break;
    case 'person':
      picked = {
        ...simple('user_id', (r) => r.user_id === key),
        // Only a scoping filter narrows the report's rows; without one the person row is every row.
        everyone: !(query.projectId || query.agentId || query.workflowId || query.credentialId),
      };
      break;
    case 'surface':
      picked = simple('surface', (r) => r.surface === key);
      break;
    case 'purpose':
      picked = simple('purpose', (r) => r.purpose === key);
      break;
    case 'model': {
      const slash = key.indexOf('/');
      if (slash < 1) throw new SpendListError('A model key is provider/model', 400);
      const provider = key.slice(0, slash);
      const model = key.slice(slash + 1);
      picked = {
        sql: [{ clause: 'provider = ? AND model = ?', params: [provider, model] }],
        test: (r) => r.provider === provider && r.model === model,
        everyone: false,
        allHidden: false,
      };
      break;
    }
    case 'source':
      picked = {
        sql: [],
        test: (r) => sourceKey(r.source, r.runtime) === key,
        everyone: false,
        allHidden: false,
      };
      break;
    case 'goal': {
      if (key === 'none')
        picked = {
          sql: [{ clause: unset('goal_id'), params: [] }],
          test: (r) => !r.goal_id,
          everyone: false,
          allHidden: false,
        };
      else {
        const goalSees = (id: string) => {
          const goal = getGoal(id);
          return !goal || admin || visibleGoals(actor, [goal], projects).length > 0;
        };
        if (key === 'shared') {
          const memo = new Map<string, boolean>();
          const hiddenGoal = (id: string) => {
            let v = memo.get(id);
            if (v === undefined) memo.set(id, (v = !goalSees(id)));
            return v;
          };
          picked = {
            sql: [{ clause: 'goal_id IS NOT NULL', params: [] }],
            test: (r) => Boolean(r.goal_id && hiddenGoal(r.goal_id)),
            everyone: false,
            allHidden: true,
          };
        } else {
          if (!goalSees(key)) throw new SpendListError('Not found', 404);
          picked = {
            sql: [{ clause: 'goal_id = ?', params: [key] }],
            test: (r) => r.goal_id === key,
            everyone: false,
            allHidden: false,
          };
        }
      }
      break;
    }
    case 'project': {
      if (key === 'none')
        picked = {
          sql: [],
          test: (r) => !projectOf(r),
          everyone: false,
          allHidden: false,
        };
      else if (key === 'shared')
        picked = {
          sql: [],
          test: (r) => Boolean(projects && projectOf(r) && !projects.has(projectOf(r) as string)),
          everyone: false,
          allHidden: true,
        };
      else {
        if (projects && !projects.has(key)) throw new SpendListError('Not found', 404);
        picked = {
          sql: [],
          test: (r) => projectOf(r) === key,
          everyone: false,
          allHidden: false,
        };
      }
      break;
    }
  }
  return {
    ...picked,
    sql: [...sql, ...picked.sql],
    test: (r) => filterTest(r) && picked.test(r),
  };
}

/** A filter naming something the caller can't read is a 404 (ids aren't confirmed), as `/api/insights/ai-usage` answers. */
function checkFilters(actor: Actor, query: AiSpendListQuery) {
  if (isInstanceAdmin(actor)) return;
  if (
    (query.projectId && !projectRole(actor, query.projectId)) ||
    (query.workflowId && !canResource(actor, 'workflow', query.workflowId, 'read')) ||
    (query.agentId && !canResource(actor, 'agent', query.agentId, 'read')) ||
    (query.credentialId && !canResource(actor, 'credential', query.credentialId, 'read'))
  ) {
    throw new SpendListError('Not found', 404);
  }
}

interface Scan {
  /** The rows the viewer may open, oldest first. */
  open: Row[];
  hiddenRows: Row[];
  /** Whether the viewer may open each run, by `runKey`. */
  runOpen: Map<string, boolean>;
  actor: Actor;
  /** Whether the viewer may read this workflow or agent (admins every one); one answer per id, shared by every list. */
  canRead: (kind: 'workflow' | 'agent', id: string) => boolean;
}

/** A run: an execution, else an agent session; a call with neither is in no run. */
const runKey = (row: Row): string | undefined =>
  row.execution_id ? `x:${row.execution_id}` : row.session_id ? `s:${row.session_id}` : undefined;

function scan(actor: Actor, query: AiSpendListQuery, now: number): Scan {
  checkFilters(actor, query);
  const admin = isInstanceAdmin(actor);
  const picked = selection(actor, query);
  const where = range(query, now);
  const clauses = [where.clause, ...picked.sql.map((s) => s.clause)];
  const params = [...where.params, ...picked.sql.flatMap((s) => s.params)];
  const rows = database().all<Row>(`SELECT ${COLUMNS} FROM ai_usage WHERE ${clauses.join(' AND ')} ORDER BY at, id`, ...params);

  const workflows = admin
    ? undefined
    : visibleIds(
        actor,
        'workflow',
        store.listWorkflows().map((w) => w.id),
      );
  const agents = admin
    ? undefined
    : visibleIds(
        actor,
        'agent',
        agentStore.list().map((a) => a.id),
      );
  const inReport = (row: Row) =>
    admin ||
    picked.everyone ||
    row.user_id === actor.id ||
    Boolean(row.workflow_id && workflows?.has(row.workflow_id)) ||
    Boolean(row.agent_id && agents?.has(row.agent_id));

  const open: Row[] = [];
  const hiddenRows: Row[] = [];
  const memo = new Map<string, boolean>();
  const openable = (row: Row) => {
    if (admin) return true;
    // The same facts decide for every row that shares them: one answer per combination.
    const k = [row.execution_id, row.agent_id, row.session_id, row.caller_agent_id, row.project_id, row.user_id].join('\u0000');
    let ok = memo.get(k);
    if (ok === undefined) memo.set(k, (ok = canOpenCall(actor, row)));
    return ok;
  };
  const readableMemo = new Map<string, boolean>();
  const canRead = (kind: 'workflow' | 'agent', id: string) => {
    const k = `${kind}:${id}`;
    let ok = readableMemo.get(k);
    if (ok === undefined) readableMemo.set(k, (ok = admin || canResource(actor, kind, id, 'read')));
    return ok;
  };
  const readableAgent = (id: string) => canRead('agent', id);
  for (const row of rows) {
    if (!picked.test(row) || !inReport(row)) continue;
    // An agent session of an agent the viewer can't read is never a listed run, whatever else could open its calls.
    const sessionOfUnreadable = !row.execution_id && row.session_id && row.agent_id && !readableAgent(row.agent_id);
    if (picked.allHidden || sessionOfUnreadable || !openable(row)) hiddenRows.push(row);
    else open.push(row);
  }
  const runOpen = new Map<string, boolean>();
  for (const row of open) {
    const k = runKey(row);
    if (k) runOpen.set(k, true);
  }
  return { open, hiddenRows, runOpen, actor, canRead };
}

function hiddenOf(rows: Row[], open: Map<string, boolean>): AiSpendHidden {
  const runs = new Set<string>();
  let cost = 0;
  for (const row of rows) {
    const k = runKey(row);
    // A run with some calls open is listed; its other calls are in `calls` and `cost` only.
    if (k && !open.get(k)) runs.add(k);
    cost += num(row.cost);
  }
  return { runs: runs.size, calls: rows.length, cost: round(cost) };
}

// ---- runs ----

interface RunItem extends AiSpendRun {
  id: string;
}

function runsOf(scanned: Scan): RunItem[] {
  const { actor, open, canRead } = scanned;
  const admin = isInstanceAdmin(actor);
  const overrides = priceOverrides();
  const priced = (row: Row) => findPrice(row.provider, row.model, overrides) !== undefined || num(row.cost) > 0;
  const runs = new Map<string, RunItem>();
  const readableAgent = (id: string) => canRead('agent', id);
  const runHref = new Map<string, boolean>();
  for (const row of open) {
    const k = runKey(row);
    if (!k) continue;
    let run = runs.get(k);
    if (!run) {
      const base: RunItem = {
        ...emptySpendTotals(),
        runs: 1,
        id: k,
        label: '',
        at: row.at,
      };
      if (row.execution_id) {
        base.executionId = row.execution_id;
        const workflowId = row.workflow_id ?? undefined;
        if (workflowId && canRead('workflow', workflowId)) {
          base.workflowId = workflowId;
          base.label = store.getWorkflow(workflowId)?.name ?? 'A workflow';
        }
        let may = runHref.get(row.execution_id);
        if (may === undefined) runHref.set(row.execution_id, (may = admin || canOpenRun(actor, row.execution_id)));
        if (may) base.href = `/runs/${row.execution_id}?tab=spend`;
      } else {
        base.sessionId = row.session_id as string;
      }
      run = base;
      runs.set(k, run);
    }
    if (row.agent_id && readableAgent(row.agent_id)) {
      run.agentId ??= row.agent_id;
      // A run is named by its workflow; one the viewer reads only through its agent, and a session, by the agent.
      if (!run.label) run.label = agentStore.get(row.agent_id)?.name ?? 'An agent';
      if (run.sessionId && !run.href) run.href = `/agents/${row.agent_id}?tab=sessions&session=${run.sessionId}`;
    }
    run.inputTokens += num(row.input_tokens);
    run.outputTokens += num(row.output_tokens);
    run.cacheReadTokens += num(row.cache_read_tokens);
    run.cacheWriteTokens += num(row.cache_write_tokens);
    run.cost += num(row.cost);
    run.calls += 1;
    if (!priced(row)) run.unpricedCalls += 1;
  }
  return [...runs.values()].map((run) => ({
    ...run,
    cost: round(run.cost),
    label: run.label || (run.executionId ? 'A workflow run' : 'An agent session'),
  }));
}

type Order = 'cost' | 'recent';
const encode = (value: unknown[]) => Buffer.from(JSON.stringify(value)).toString('base64url');
function decode(cursor: string | undefined, order: Order): unknown[] | undefined {
  if (!cursor) return undefined;
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (Array.isArray(value) && value[0] === order && value.length === 3 && typeof value[2] === 'string') return value;
  } catch {
    // falls through
  }
  throw new SpendListError('The cursor is not valid for this list', 400);
}

/** Orders and pages a list by keyset: the cursor holds the order, the last sort value and the last id, so no row comes twice. */
function page<T extends { id: string; cost: number; at: string }>(
  items: T[],
  order: Order,
  cursor: string | undefined,
  size: number | undefined,
): { rows: T[]; next?: string } {
  const sorted = [...items].sort(order === 'cost' ? byCost : byRecent);
  const after = decode(cursor, order);
  let start = 0;
  if (after) {
    start = sorted.findIndex((item) => isAfter(item, order, after));
    if (start < 0) start = sorted.length;
  }
  const rows = size === undefined ? sorted.slice(start) : sorted.slice(start, start + size);
  const last = rows.at(-1);
  const more = size !== undefined && start + size < sorted.length;
  return {
    rows,
    ...(more &&
      last && {
        next: encode([order, order === 'cost' ? last.cost : last.at, last.id]),
      }),
  };
}

/** Whether `item` sorts after the cursor's position: `cost` is highest first, `recent` newest first, ties by id. */
function isAfter(item: { id: string; cost: number; at: string }, order: Order, after: unknown[]): boolean {
  const value = order === 'cost' ? item.cost : item.at;
  const previous = after[1] as number | string;
  if (value !== previous) return order === 'cost' ? (value as number) < (previous as number) : (value as string) < (previous as string);
  return item.id > (after[2] as string);
}

const byCost = <T extends { id: string; cost: number }>(a: T, b: T) => b.cost - a.cost || (a.id < b.id ? -1 : 1);
const byRecent = <T extends { id: string; at: string }>(a: T, b: T) => (a.at === b.at ? (a.id < b.id ? -1 : 1) : a.at < b.at ? 1 : -1);

function listRuns(
  actor: Actor,
  query: AiSpendListQuery,
  now: number,
  size: number | undefined,
): { runs: RunItem[]; hidden: AiSpendHidden; next?: string } {
  const order = query.order ?? 'cost';
  const scanned = scan(actor, query, now);
  const items = runsOf(scanned);
  const paged = page(items, order, query.cursor, size);
  return {
    runs: paged.rows,
    hidden: hiddenOf(scanned.hiddenRows, scanned.runOpen),
    ...(paged.next && { next: paged.next }),
  };
}

/** The runs behind one group row, costliest (or newest) first, a page of `AI_SPEND_PAGE_SIZE`; what can't be opened is in `hidden`. */
export function spendRuns(actor: Actor, query: AiSpendListQuery, now = Date.now()): AiSpendRunsPage {
  const { runs, hidden, next } = listRuns(actor, query, now, AI_SPEND_PAGE_SIZE);
  return {
    runs: runs.map(({ id: _id, ...run }) => run),
    hidden,
    ...(next && { next }),
  };
}

// ---- calls ----

interface CallItem extends AiSpendCall {
  id: string;
  cost: number;
  at: string;
}

function callsOf(scanned: Scan, rows: Row[]): CallItem[] {
  const { actor, canRead } = scanned;
  const admin = isInstanceAdmin(actor);
  const overrides = priceOverrides();
  const hasParts = new Set<string>();
  const db = database();
  const ids = rows.map((r) => r.id);
  const requests = rows.flatMap((r) => (r.gateway_request_id ? [r.gateway_request_id] : []));
  const byRequest = new Map(rows.filter((r) => r.gateway_request_id).map((r) => [r.gateway_request_id as string, r.id]));
  for (let i = 0; i < ids.length; i += 400) {
    const group = ids.slice(i, i + 400);
    for (const p of db.all<{ usage_id: string }>(
      `SELECT usage_id FROM ai_call_parts WHERE usage_id IN (${group.map(() => '?').join(',')})`,
      ...group,
    ))
      hasParts.add(p.usage_id);
  }
  for (let i = 0; i < requests.length; i += 400) {
    const group = requests.slice(i, i + 400);
    for (const p of db.all<{ gateway_request_id: string }>(
      `SELECT gateway_request_id FROM ai_call_parts WHERE gateway_request_id IN (${group.map(() => '?').join(',')})`,
      ...group,
    )) {
      const id = byRequest.get(p.gateway_request_id);
      if (id) hasParts.add(id);
    }
  }
  const agentOk = (id: string) => canRead('agent', id);
  const runOk = new Map<string, boolean>();
  return rows.map((row) => {
    let runHref: string | undefined;
    if (row.execution_id) {
      let ok = runOk.get(row.execution_id);
      if (ok === undefined) runOk.set(row.execution_id, (ok = admin || canOpenRun(actor, row.execution_id)));
      if (ok) runHref = `/runs/${row.execution_id}?tab=spend`;
    }
    return {
      id: row.id,
      usageId: row.id,
      at: row.at,
      provider: row.provider,
      model: row.model,
      ...(isCallPurpose(row.purpose) && { purpose: row.purpose }),
      ...(row.iteration !== null && row.iteration !== undefined && { iteration: num(row.iteration) }),
      ...(row.node_id && { nodeId: row.node_id }),
      ...(row.agent_id && agentOk(row.agent_id) && { agentId: row.agent_id }),
      ...(row.session_id && { sessionId: row.session_id }),
      ...(row.span_id && { spanId: row.span_id }),
      inputTokens: num(row.input_tokens),
      outputTokens: num(row.output_tokens),
      cacheReadTokens: num(row.cache_read_tokens),
      cacheWriteTokens: num(row.cache_write_tokens),
      cost: num(row.cost),
      priced: findPrice(row.provider, row.model, overrides) !== undefined || num(row.cost) > 0,
      ...(row.duration_ms !== null && row.duration_ms !== undefined && { durationMs: num(row.duration_ms) }),
      ...(row.stop_reason && { stopReason: row.stop_reason }),
      source: row.source === 'litellm' ? ('litellm' as const) : ('landflow' as const),
      hasParts: hasParts.has(row.id),
      ...(row.execution_id && { executionId: row.execution_id }),
      ...(runHref && { runHref }),
    };
  });
}

function listCalls(
  actor: Actor,
  query: AiSpendListQuery,
  now: number,
  size: number | undefined,
): { calls: AiSpendCall[]; hidden: AiSpendHidden; next?: string } {
  // Newest first by default (a call has no run total to rank by); `order=cost` ranks the dearest first.
  const order = query.order ?? 'recent';
  const scanned = scan(actor, query, now);
  // Page on the rows first, so only the page's rows are looked up for their splits.
  const rows = scanned.open.map((r) => ({
    id: r.id,
    at: r.at,
    cost: num(r.cost),
    row: r,
  }));
  const paged = page(rows, order, query.cursor, size);
  const calls = callsOf(
    scanned,
    paged.rows.map((r) => r.row),
  ).map(({ id: _id, ...call }) => call);
  return {
    calls,
    hidden: hiddenOf(scanned.hiddenRows, scanned.runOpen),
    ...(paged.next && { next: paged.next }),
  };
}

/** The calls behind one group row, newest first (or dearest first), a page of `AI_SPEND_PAGE_SIZE`; what can't be opened is in `hidden`. */
export function spendCalls(actor: Actor, query: AiSpendListQuery, now = Date.now()): AiSpendCallsPage {
  const { calls, hidden, next } = listCalls(actor, query, now, AI_SPEND_PAGE_SIZE);
  return { calls, hidden, ...(next && { next }) };
}

// ---- CSV ----

/** A cell as RFC 4180 writes it: quoted when it holds a comma, a quote or a line break. A text that a spreadsheet would run as a formula gets a leading apostrophe. */
function cell(value: string | number | boolean | undefined, textual = false): string {
  if (value === undefined) return '';
  let s = String(value);
  if (textual && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function csv(
  header: string[],
  rows: Array<Array<string | number | boolean | undefined>>,
  textColumns: Set<number>,
  hidden: AiSpendHidden,
  cut: boolean,
): string {
  const lines = [header.join(',')];
  for (const row of rows) lines.push(row.map((v, i) => cell(v, textColumns.has(i))).join(','));
  if (cut) lines.push(cell(`Cut at ${AI_SPEND_CSV_MAX_ROWS} rows: narrow the period or the filters to see the rest`));
  lines.push(cell(`Not listed (you can't open them): ${hidden.runs} runs, ${hidden.calls} calls, cost ${hidden.cost}`));
  return `${lines.join('\r\n')}\r\n`;
}

/** The runs behind a group row as CSV: the JSON page's columns, every row up to `AI_SPEND_CSV_MAX_ROWS`; never prompt text. */
export function spendRunsCsv(actor: Actor, query: AiSpendListQuery, now = Date.now()): string {
  const { runs, hidden } = listRuns(actor, { ...query, cursor: undefined }, now, undefined);
  const cut = runs.length > AI_SPEND_CSV_MAX_ROWS;
  const rows = runs
    .slice(0, AI_SPEND_CSV_MAX_ROWS)
    .map((r) => [
      r.executionId,
      r.sessionId,
      r.agentId,
      r.workflowId,
      r.label,
      r.at,
      r.runs,
      r.calls,
      r.inputTokens,
      r.outputTokens,
      r.cacheReadTokens,
      r.cacheWriteTokens,
      r.cost,
      r.unpricedCalls,
      r.href,
    ]);
  return csv(
    [
      'execution_id',
      'session_id',
      'agent_id',
      'workflow_id',
      'label',
      'first_call_at',
      'runs',
      'calls',
      'input_tokens',
      'output_tokens',
      'cache_read_tokens',
      'cache_write_tokens',
      'cost',
      'unpriced_calls',
      'href',
    ],
    rows,
    new Set([4]),
    hidden,
    cut,
  );
}

/** The calls behind a group row as CSV: the JSON page's columns, every row up to `AI_SPEND_CSV_MAX_ROWS`; never prompt text. */
export function spendCallsCsv(actor: Actor, query: AiSpendListQuery, now = Date.now()): string {
  const { calls, hidden } = listCalls(actor, { ...query, cursor: undefined }, now, undefined);
  const cut = calls.length > AI_SPEND_CSV_MAX_ROWS;
  const rows = calls
    .slice(0, AI_SPEND_CSV_MAX_ROWS)
    .map((c) => [
      c.usageId,
      c.at,
      c.executionId,
      c.sessionId,
      c.agentId,
      c.nodeId,
      c.provider,
      c.model,
      c.purpose,
      c.iteration,
      c.inputTokens,
      c.outputTokens,
      c.cacheReadTokens,
      c.cacheWriteTokens,
      c.cost,
      c.priced,
      c.durationMs,
      c.stopReason,
      c.source,
      c.runHref,
    ]);
  return csv(
    [
      'usage_id',
      'at',
      'execution_id',
      'session_id',
      'agent_id',
      'node_id',
      'provider',
      'model',
      'purpose',
      'iteration',
      'input_tokens',
      'output_tokens',
      'cache_read_tokens',
      'cache_write_tokens',
      'cost',
      'priced',
      'duration_ms',
      'stop_reason',
      'source',
      'run_href',
    ],
    rows,
    new Set([5, 6, 7, 17]),
    hidden,
    cut,
  );
}
