/**
 * The AI page's report (SP08, docs/llm-gateway.md "The AI page"): spend and tokens for 24 hours, 7, 30 or 90 days or a
 * custom range of up to 400 days, in ten groups, as a daily (hourly for 24 hours) series, against the previous period,
 * narrowed by filters. Day periods read the daily rollup (./rollup.ts); 24 hours reads the raw rows by hour. Runs are
 * counted on the raw rows (`COUNT(DISTINCT COALESCE(execution_id, session_id))`), never summed from rollup rows.
 *
 * Visibility is "Who sees what" (docs/llm-gateway.md, decision D1): owners and admins see every row; anyone else sees a
 * row when it is their own or they can read its workflow or agent. The person group, the person stack and `peopleTotals`
 * cover every row, by name; every other group holds the visible rows, with "Another ..." for what the viewer can't
 * read. No prompt text and no other person's email.
 */
import { agentStore } from '../agents/store';
import { credentials } from '../credentials/vault';
import { database } from '../db';
import { HttpError } from '../errors';
import { getGoal } from '../goals/store';
import { visibleGoals } from '../goals/views';
import { canResource, isInstanceAdmin, visibleIds, visibleProjectIds } from '../projects/access';
import type { Actor } from '../projects/access';
import { getProject, homeProjectId } from '../projects/store';
import { store } from '../store';
import { getUser } from '../auth/users';
import { CALL_PURPOSE_LABELS, isCallPurpose } from '../../shared/ai-call';
import {
  AI_SPEND_GROUPS,
  AI_SPEND_MAX_DAYS,
  type AiSpendFilters,
  type AiSpendGroup,
  type AiSpendPeriod,
  type AiSpendPoint,
  type AiSpendReport,
  type AiSpendRow,
  type AiSpendStack,
  type AiSpendTotals,
} from '../../shared/ai-spend';
import { aiUsageMeter } from './index';
import { findPrice, priceOverrides } from './prices';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const GROUP_LIMIT = 50;
const STACK_LIMIT = 5;
const MOVERS_EACH = 5;
/** A custom range longer than this has no previous period. */
const COMPARE_MAX_DAYS = 90;
const PERIOD_DAYS: Record<string, number> = { '7d': 7, '30d': 30, '90d': 90 };
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export interface AiSpendQuery {
  period: AiSpendPeriod;
  /** A custom range's first and last day. */
  from?: string;
  to?: string;
  filters?: AiSpendFilters;
  compare?: boolean;
  stack?: AiSpendGroup;
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

const SOURCE_LABELS: Record<string, string> = {
  'landflow:landflow': 'Landflow',
  'litellm:kagent': 'kagent',
  'litellm:claude': 'Claude Code on kagent',
  'litellm:other': 'Other clients of the gateway',
};

/**
 * `landflow:landflow`, or `litellm:<kagent|claude|other>`: a row without a source is Landflow's own, and so is an
 * imported row of runtime `landflow` (a call Landflow made outside a usage scope on the server's gateway key).
 */
export function sourceKey(source: string | null | undefined, runtime: string | null | undefined): string {
  if (source !== 'litellm' || runtime === 'landflow') return 'landflow:landflow';
  return runtime === 'kagent' || runtime === 'claude' ? `litellm:${runtime}` : 'litellm:other';
}

const SURFACE_LABELS: Record<string, string> = {
  spotlight: 'Spotlight',
  architect: 'Agent architect',
  brain: 'Ask the brain',
};

// ---------------------------------------------------------------------------
// Days and ranges
// ---------------------------------------------------------------------------

const utcOf = (day: string) => Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)));
const dayOfUtc = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const addDays = (day: string, n: number) => dayOfUtc(utcOf(day) + n * DAY_MS);
const spanDays = (from: string, to: string) => Math.round((utcOf(to) - utcOf(from)) / DAY_MS) + 1;
const validDay = (day: unknown): day is string => typeof day === 'string' && DAY.test(day) && dayOfUtc(utcOf(day)) === day;

export interface Range {
  hours: boolean;
  /** Days: `YYYY-MM-DD`; hours: ISO times. Both ends inclusive. */
  from: string;
  to: string;
  /** The buckets of the series: each day, or each hour's `YYYY-MM-DDTHH` prefix. */
  buckets: string[];
  /** Days: the first day read from the raw rows (yesterday and today are always exact); older days come from the rollup. */
  rawFrom: string;
}

/** The period's range (a custom one checked: 400 for a bad or too long one); also the cache card's (cache-report.ts). */
export function currentRange(query: AiSpendQuery, now: number): Range {
  const meter = aiUsageMeter();
  const today = meter.today(now);
  if (query.period === '24h') {
    const from = new Date(now - DAY_MS).toISOString();
    return {
      hours: true,
      from,
      to: new Date(now).toISOString(),
      buckets: hourBuckets(now - DAY_MS, now),
      rawFrom: '',
    };
  }
  let from: string;
  let to = today;
  if (query.period === 'custom') {
    if (!validDay(query.from) || !validDay(query.to)) throw new HttpError('A custom range needs from and to as YYYY-MM-DD', 400);
    if (query.from > query.to) throw new HttpError('from must not be after to', 400);
    if (query.to > today) throw new HttpError('A custom range cannot end after today', 400);
    if (spanDays(query.from, query.to) > AI_SPEND_MAX_DAYS) throw new HttpError(`A custom range spans at most ${AI_SPEND_MAX_DAYS} days`, 400);
    from = query.from;
    to = query.to;
  } else {
    from = addDays(today, 1 - (PERIOD_DAYS[query.period] ?? 7));
  }
  return {
    hours: false,
    from,
    to,
    buckets: Array.from({ length: spanDays(from, to) }, (_, i) => addDays(from, i)),
    rawFrom: meter.today(now - DAY_MS),
  };
}

function hourBuckets(fromMs: number, toMs: number): string[] {
  const out: string[] = [];
  for (let at = Math.floor(fromMs / HOUR_MS) * HOUR_MS; at <= toMs; at += HOUR_MS) out.push(new Date(at).toISOString().slice(0, 13));
  return out;
}

/** The range just before `range`, as long. */
function previousRange(range: Range): Range {
  if (range.hours) {
    const from = Date.parse(range.from);
    const length = Date.parse(range.to) - from;
    const start = from - length - 1;
    return {
      hours: true,
      from: new Date(start).toISOString(),
      to: new Date(from - 1).toISOString(),
      buckets: hourBuckets(start, from - 1),
      rawFrom: '',
    };
  }
  const length = spanDays(range.from, range.to);
  const from = addDays(range.from, -length);
  return {
    hours: false,
    from,
    to: addDays(range.from, -1),
    buckets: Array.from({ length }, (_, i) => addDays(from, i)),
    rawFrom: range.rawFrom,
  };
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

const KEYS = [
  'project_id',
  'goal_id',
  'agent_id',
  'workflow_id',
  'user_id',
  'credential_id',
  'surface',
  'purpose',
  'provider',
  'model',
  'source',
  'runtime',
] as const;
type Key = (typeof KEYS)[number];

/** A loaded row: the key columns (`''` for none), the sums and, in a series, its bucket. */
interface Row extends Record<Key, string> {
  at: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  calls: number;
}

interface RunRow extends Record<Key, string> {
  run: string;
}

type SqlParam = string | number;

interface Source {
  col: (name: string) => string;
  where: string;
  params: SqlParam[];
  sums: string;
  bucket: string;
}

function source(range: Pick<Range, 'hours' | 'from' | 'to'>, rollup: boolean, filters: AiSpendFilters): Source {
  const col = rollup ? (name: string) => name : (name: string) => `COALESCE(${name}, '')`;
  const where: string[] = [];
  const params: SqlParam[] = [];
  if (range.hours) {
    where.push('at >= ? AND at <= ?');
    params.push(range.from, range.to);
  } else {
    where.push('day >= ? AND day <= ?');
    params.push(range.from, range.to);
  }
  const equals = (name: string, value: string | undefined) => {
    if (value === undefined) return;
    where.push(`${col(name)} = ?`);
    params.push(value);
  };
  equals('agent_id', filters.agentId);
  equals('workflow_id', filters.workflowId);
  equals('user_id', filters.userId);
  equals('credential_id', filters.credentialId);
  if (filters.surface !== undefined) equals('surface', filters.surface === 'none' ? '' : filters.surface);
  if (filters.purpose !== undefined) equals('purpose', filters.purpose === 'none' ? '' : filters.purpose);
  if (filters.model !== undefined) {
    where.push(`(${col('model')} = ? OR ${col('provider')} || '/' || ${col('model')} = ?)`);
    params.push(filters.model, filters.model);
  }
  if (filters.source !== undefined) {
    const s = col('source');
    const r = col('runtime');
    if (filters.source === 'landflow:landflow') where.push(`(${s} <> 'litellm' OR ${r} = 'landflow')`);
    else if (filters.source === 'litellm:kagent' || filters.source === 'litellm:claude') {
      where.push(`(${s} = 'litellm' AND ${r} = ?)`);
      params.push(filters.source.slice('litellm:'.length));
    } else if (filters.source === 'litellm:other') where.push(`(${s} = 'litellm' AND ${r} NOT IN ('landflow', 'kagent', 'claude'))`);
    else where.push('1 = 0');
  }
  const sums = rollup
    ? `COALESCE(SUM(input_tokens), 0) AS input, COALESCE(SUM(output_tokens), 0) AS output, COALESCE(SUM(cache_read_tokens), 0) AS cache_read, COALESCE(SUM(cache_write_tokens), 0) AS cache_write, COALESCE(SUM(cost), 0) AS cost, COALESCE(SUM(calls), 0) AS calls`
    : `COALESCE(SUM(input_tokens), 0) AS input, COALESCE(SUM(output_tokens), 0) AS output, COALESCE(SUM(cache_read_tokens), 0) AS cache_read, COALESCE(SUM(cache_write_tokens), 0) AS cache_write, COALESCE(SUM(cost), 0) AS cost, COUNT(*) AS calls`;
  return {
    col,
    where: where.join(' AND '),
    params,
    sums,
    bucket: range.hours ? 'substr(at, 1, 13)' : 'day',
  };
}

interface RawSums {
  at?: string;
  input: number | string;
  output: number | string;
  cache_read: number | string;
  cache_write: number | string;
  cost: number | string;
  calls: number | string;
}

function toRow(raw: Record<string, unknown> & RawSums, columns: readonly Key[]): Row {
  const row = {
    at: String(raw.at ?? ''),
    input: Number(raw.input),
    output: Number(raw.output),
    cacheRead: Number(raw.cache_read),
    cacheWrite: Number(raw.cache_write),
    cost: Number(raw.cost),
    calls: Number(raw.calls),
  } as Row;
  for (const key of KEYS) row[key] = columns.includes(key) ? String(raw[key] ?? '') : '';
  return row;
}

/** The pieces of a range and where each is read: days before yesterday from the rollup, the rest from the raw rows. */
function segments(range: Range): Array<{ range: Pick<Range, 'hours' | 'from' | 'to'>; rollup: boolean }> {
  if (range.hours) return [{ range, rollup: false }];
  const out: Array<{
    range: Pick<Range, 'hours' | 'from' | 'to'>;
    rollup: boolean;
  }> = [];
  const lastOld = addDays(range.rawFrom, -1);
  if (range.from <= lastOld)
    out.push({
      range: {
        hours: false,
        from: range.from,
        to: range.to < lastOld ? range.to : lastOld,
      },
      rollup: true,
    });
  if (range.to >= range.rawFrom)
    out.push({
      range: {
        hours: false,
        from: range.from > range.rawFrom ? range.from : range.rawFrom,
        to: range.to,
      },
      rollup: false,
    });
  return out;
}

/** Rows of the range by distinct combination of `columns` (and by bucket when `bucketed`). */
function load(range: Range, filters: AiSpendFilters, columns: readonly Key[], bucketed: boolean): Row[] {
  return segments(range).flatMap(({ range: part, rollup }) => {
    const src = source(part, rollup, filters);
    const select = [...(bucketed ? [`${src.bucket} AS at`] : []), ...columns.map((c) => `${src.col(c)} AS ${c}`)];
    const group = [...(bucketed ? [src.bucket] : []), ...columns.map((c) => src.col(c))];
    const sql = `SELECT ${[...select, src.sums].join(', ')} FROM ${rollup ? 'ai_usage_daily' : 'ai_usage'} WHERE ${src.where}${group.length ? ` GROUP BY ${group.join(', ')}` : ''}`;
    return database()
      .all<Record<string, unknown> & RawSums>(sql, ...src.params)
      .map((raw) => toRow(raw, columns));
  });
}

/** Each run once per distinct combination of the key columns: counted on the raw rows. */
function loadRuns(range: Range, filters: AiSpendFilters): RunRow[] {
  const src = source(range, false, filters);
  // Raw rows cover the whole retention, so a run is counted once whatever days it spans.
  const sql = `SELECT DISTINCT COALESCE(execution_id, session_id) AS run, ${KEYS.map((c) => `${src.col(c)} AS ${c}`).join(', ')} FROM ai_usage WHERE ${src.where} AND COALESCE(execution_id, session_id) IS NOT NULL`;
  return database()
    .all<Record<string, unknown>>(sql, ...src.params)
    .map((raw) => {
      const row = { run: String(raw.run) } as RunRow;
      for (const key of KEYS) row[key] = String(raw[key] ?? '');
      return row;
    });
}

// ---------------------------------------------------------------------------
// Who sees what
// ---------------------------------------------------------------------------

interface Context {
  actor: Actor;
  admin: boolean;
  workflows?: Set<string>;
  agents?: Set<string>;
  projects?: Set<string>;
  /** Whether the viewer sees every row (admins). */
  visible(row: Record<Key, string>): boolean;
  /** Whether the row counts for the person group, its stack and `peopleTotals`. */
  people(row: Record<Key, string>): boolean;
  projectOf(row: Record<Key, string>): string | undefined;
}

function context(actor: Actor, filters: AiSpendFilters): Context {
  const admin = isInstanceAdmin(actor);
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
  const projects = admin ? undefined : visibleProjectIds(actor);
  const homes = new Map<string, string | undefined>();
  const home = (kind: 'workflow' | 'agent', id: string) => {
    const cacheKey = `${kind}:${id}`;
    if (!homes.has(cacheKey)) homes.set(cacheKey, homeProjectId(kind, id));
    return homes.get(cacheKey);
  };
  const visible = (row: Record<Key, string>) =>
    admin || row.user_id === actor.id || Boolean(row.workflow_id && workflows?.has(row.workflow_id)) || Boolean(row.agent_id && agents?.has(row.agent_id));
  // A filter by project, agent, workflow or credential could name what the viewer can't read: the person group then
  // holds the filtered rows the viewer can see. Under any other filter it keeps every row that matches (D1).
  const narrowing = Boolean(filters.projectId || filters.agentId || filters.workflowId || filters.credentialId);
  const projectOf = (row: Record<Key, string>) =>
    row.project_id || (row.workflow_id ? home('workflow', row.workflow_id) : row.agent_id ? home('agent', row.agent_id) : undefined);
  return {
    actor,
    admin,
    workflows,
    agents,
    projects,
    visible,
    people: narrowing ? visible : () => true,
    projectOf,
  };
}

const withProject = <T extends Record<Key, string>>(rows: T[], ctx: Context, filters: AiSpendFilters): T[] =>
  filters.projectId ? rows.filter((row) => ctx.projectOf(row) === filters.projectId) : rows;

/** A person's label in the person group: the name; an unnamed person is "Unnamed person" to everyone but admins and themselves. */
function personLabel(id: string, viewer: { id: string }, admin: boolean): string {
  const user = getUser(id);
  if (!user) return 'Someone';
  const name = user.name?.trim();
  if (admin || id === viewer.id) return name || user.email || 'Someone';
  return name && !name.includes('@') ? name : 'Unnamed person';
}

// ---------------------------------------------------------------------------
// Placing rows in groups
// ---------------------------------------------------------------------------

interface Placement {
  key: string;
  label: string;
  href?: string;
}

function placer(ctx: Context) {
  const { actor, admin } = ctx;
  const goals = new Map<string, { id: string; title: string } | null | undefined>();
  const goalFor = (id: string) => {
    if (!goals.has(id)) {
      const goal = getGoal(id);
      goals.set(id, goal && (visibleGoals(actor, [goal], ctx.projects)[0] ?? null));
    }
    return goals.get(id);
  };
  const credentialReadable = new Map<string, boolean>();
  const canReadCredential = (id: string) => {
    if (!credentialReadable.has(id)) credentialReadable.set(id, admin || canResource(actor, 'credential', id, 'read'));
    return credentialReadable.get(id) as boolean;
  };
  const sources = new Map<string, string>();

  return (group: AiSpendGroup, row: Record<Key, string>): Placement => {
    switch (group) {
      case 'project': {
        const projectId = ctx.projectOf(row);
        const project = projectId ? getProject(projectId) : undefined;
        if (!project) return { key: 'none', label: 'No project' };
        if (ctx.projects && !ctx.projects.has(project.id)) return { key: 'shared', label: 'Another project' };
        return {
          key: project.id,
          label: project.name,
          href: `/projects/${project.id}`,
        };
      }
      case 'goal': {
        if (!row.goal_id) return { key: 'none', label: 'No goal' };
        const goal = goalFor(row.goal_id);
        if (goal === undefined) return { key: row.goal_id, label: 'Deleted goal' };
        if (goal === null) return { key: 'shared', label: 'Another goal' };
        return { key: goal.id, label: goal.title };
      }
      case 'agent': {
        if (!row.agent_id) return { key: 'none', label: 'No agent' };
        if (ctx.agents && !ctx.agents.has(row.agent_id)) return { key: 'shared', label: 'Another agent' };
        const agent = agentStore.get(row.agent_id);
        return {
          key: row.agent_id,
          label: agent?.name ?? 'Deleted agent',
          ...(agent && { href: `/agents/${row.agent_id}` }),
        };
      }
      case 'workflow': {
        if (!row.workflow_id) return { key: 'none', label: 'No workflow' };
        if (ctx.workflows && !ctx.workflows.has(row.workflow_id)) return { key: 'shared', label: 'Another workflow' };
        const workflow = store.getWorkflow(row.workflow_id);
        return {
          key: row.workflow_id,
          label: workflow?.name ?? 'Deleted workflow',
          ...(workflow && { href: `/workflows/${row.workflow_id}` }),
        };
      }
      case 'person':
        if (!row.user_id) return { key: 'none', label: 'No person' };
        return {
          key: row.user_id,
          label: personLabel(row.user_id, actor, admin),
          href: `/insights/ai?userId=${encodeURIComponent(row.user_id)}`,
        };
      case 'model':
        return { key: `${row.provider}/${row.model}`, label: row.model };
      case 'source': {
        const cacheKey = `${row.source}|${row.runtime}`;
        if (!sources.has(cacheKey)) sources.set(cacheKey, sourceKey(row.source, row.runtime));
        const key = sources.get(cacheKey) as string;
        return { key, label: SOURCE_LABELS[key] ?? key };
      }
      case 'credential': {
        if (!row.credential_id) return { key: 'none', label: 'No credential' };
        if (!canReadCredential(row.credential_id)) return { key: 'shared', label: 'Another credential' };
        return {
          key: row.credential_id,
          label: credentials.get(row.credential_id)?.name ?? 'Deleted credential',
        };
      }
      case 'surface':
        return row.surface
          ? {
              key: row.surface,
              label: SURFACE_LABELS[row.surface] ?? row.surface,
            }
          : { key: 'none', label: 'Runs and agents' };
      case 'purpose':
        if (!row.purpose) return { key: 'none', label: 'No purpose' };
        return {
          key: row.purpose,
          label: isCallPurpose(row.purpose) ? CALL_PURPOSE_LABELS[row.purpose] : row.purpose,
        };
    }
  };
}

// ---------------------------------------------------------------------------
// Totals
// ---------------------------------------------------------------------------

interface Bucket extends AiSpendTotals {
  key: string;
  label: string;
  href?: string;
  runIds: Set<string>;
}

const newBucket = (p: Placement): Bucket => ({
  key: p.key,
  label: p.label,
  ...(p.href && { href: p.href }),
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  cost: 0,
  calls: 0,
  unpricedCalls: 0,
  runs: 0,
  runIds: new Set(),
});

function addRow(into: Bucket, row: Row, unpriced: boolean) {
  into.inputTokens += row.input;
  into.outputTokens += row.output;
  into.cacheReadTokens += row.cacheRead;
  into.cacheWriteTokens += row.cacheWrite;
  into.cost += row.cost;
  into.calls += row.calls;
  if (unpriced) into.unpricedCalls += row.calls;
}

interface Aggregate {
  total: Bucket;
  people: Bucket;
  groups: Record<AiSpendGroup, Map<string, Bucket>>;
}

function aggregate(rows: Row[], runs: RunRow[], ctx: Context, place: ReturnType<typeof placer>, unpricedOf: (row: Row) => boolean): Aggregate {
  const total = newBucket({ key: 'total', label: 'Total' });
  const people = newBucket({ key: 'people', label: 'Everyone' });
  const groups = Object.fromEntries(AI_SPEND_GROUPS.map((g) => [g, new Map<string, Bucket>()])) as Aggregate['groups'];
  const bucketOf = (group: AiSpendGroup, row: Record<Key, string>) => {
    const placed = place(group, row);
    let bucket = groups[group].get(placed.key);
    if (!bucket) groups[group].set(placed.key, (bucket = newBucket(placed)));
    return bucket;
  };
  for (const row of rows) {
    const unpriced = unpricedOf(row);
    if (ctx.people(row)) {
      addRow(people, row, unpriced);
      addRow(bucketOf('person', row), row, unpriced);
    }
    if (!ctx.visible(row)) continue;
    addRow(total, row, unpriced);
    for (const group of AI_SPEND_GROUPS) if (group !== 'person') addRow(bucketOf(group, row), row, unpriced);
  }
  for (const run of runs) {
    if (ctx.people(run)) {
      people.runIds.add(run.run);
      bucketOf('person', run).runIds.add(run.run);
    }
    if (!ctx.visible(run)) continue;
    total.runIds.add(run.run);
    for (const group of AI_SPEND_GROUPS) if (group !== 'person') bucketOf(group, run).runIds.add(run.run);
  }
  for (const bucket of [total, people, ...AI_SPEND_GROUPS.flatMap((g) => [...groups[g].values()])]) bucket.runs = bucket.runIds.size;
  return { total, people, groups };
}

const totalsOf = (b: AiSpendTotals): AiSpendTotals => ({
  inputTokens: b.inputTokens,
  outputTokens: b.outputTokens,
  cacheReadTokens: b.cacheReadTokens,
  cacheWriteTokens: b.cacheWriteTokens,
  cost: b.cost,
  calls: b.calls,
  unpricedCalls: b.unpricedCalls,
  runs: b.runs,
});

const tokensOf = (t: { inputTokens: number; outputTokens: number }) => t.inputTokens + t.outputTokens;

function sorted(buckets: Iterable<Bucket>): Bucket[] {
  return [...buckets].sort((a, b) => b.cost - a.cost || tokensOf(b) - tokensOf(a) || a.label.localeCompare(b.label));
}

interface FinishInput {
  group: AiSpendGroup;
  buckets: Map<string, Bucket>;
  whole: Bucket;
  previous?: Map<string, Bucket>;
  unpriced?: (bucket: Bucket) => boolean;
}

/** Sorted by cost then tokens, each with its share, the tail beyond 50 rolled into "Other". */
function finish({ group, buckets, whole, previous, unpriced }: FinishInput): AiSpendRow[] {
  const byCost = whole.cost > 0;
  const size = byCost ? whole.cost : tokensOf(whole);
  const shareOf = (b: { cost: number; inputTokens: number; outputTokens: number }) => (size > 0 ? (byCost ? b.cost : tokensOf(b)) / size : 0);
  const prevOf = (b?: Bucket) =>
    previous
      ? {
          cost: b?.cost ?? 0,
          inputTokens: b?.inputTokens ?? 0,
          outputTokens: b?.outputTokens ?? 0,
          calls: b?.calls ?? 0,
        }
      : undefined;
  const order = sorted(buckets.values());
  const row = (b: Bucket): AiSpendRow => {
    const p = prevOf(previous?.get(b.key));
    return {
      ...totalsOf(b),
      key: b.key,
      label: b.label,
      ...(b.href && { href: b.href }),
      share: shareOf(b),
      ...(p && { previous: p }),
      ...(group === 'model' && unpriced?.(b) && { unpriced: true }),
    };
  };
  const out = order.slice(0, GROUP_LIMIT).map(row);
  if (order.length > GROUP_LIMIT) {
    const rest = newBucket({ key: 'other', label: 'Other' });
    const restPrevious = newBucket({ key: 'other', label: 'Other' });
    for (const b of order.slice(GROUP_LIMIT)) {
      rest.inputTokens += b.inputTokens;
      rest.outputTokens += b.outputTokens;
      rest.cacheReadTokens += b.cacheReadTokens;
      rest.cacheWriteTokens += b.cacheWriteTokens;
      rest.cost += b.cost;
      rest.calls += b.calls;
      rest.unpricedCalls += b.unpricedCalls;
      for (const id of b.runIds) rest.runIds.add(id);
      const p = previous?.get(b.key);
      if (p) {
        restPrevious.cost += p.cost;
        restPrevious.inputTokens += p.inputTokens;
        restPrevious.outputTokens += p.outputTokens;
        restPrevious.calls += p.calls;
      }
    }
    rest.runs = rest.runIds.size;
    out.push({
      ...totalsOf(rest),
      key: 'other',
      label: 'Other',
      share: shareOf(rest),
      ...(previous && { previous: prevOf(restPrevious) }),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

function checkReadable(actor: Actor, filters: AiSpendFilters) {
  if (isInstanceAdmin(actor)) return;
  // An id the viewer can't read answers 404, so ids aren't confirmed.
  if (
    (filters.workflowId && !canResource(actor, 'workflow', filters.workflowId, 'read')) ||
    (filters.agentId && !canResource(actor, 'agent', filters.agentId, 'read')) ||
    (filters.credentialId && !canResource(actor, 'credential', filters.credentialId, 'read')) ||
    (filters.projectId && !visibleProjectIds(actor)?.has(filters.projectId))
  ) {
    throw new HttpError('Not found', 404);
  }
}

/** The filters as the report takes them: an empty one is no filter. */
const cleanFilters = (given: AiSpendFilters | undefined): AiSpendFilters =>
  Object.fromEntries(Object.entries(given ?? {}).filter(([, value]) => typeof value === 'string' && value !== '')) as AiSpendFilters;

/**
 * The report's own filter rules over raw `ai_usage` rows, for the cache card (cache-report.ts): the SQL for `range`
 * (an unreadable workflow, agent, project or credential answers 404 first, as in the report) and the test for the
 * project filter, which resolves a row with no project to its home project. Every filter applies.
 */
export function usageFilter(actor: Actor, given: AiSpendFilters | undefined, range: Range) {
  const filters = cleanFilters(given);
  checkReadable(actor, filters);
  const src = source(range, false, filters);
  const ctx = context(actor, filters);
  return {
    where: src.where,
    params: src.params,
    keep: (row: { project_id: string | null; workflow_id: string | null; agent_id: string | null }) =>
      !filters.projectId ||
      ctx.projectOf({ project_id: row.project_id ?? '', workflow_id: row.workflow_id ?? '', agent_id: row.agent_id ?? '' } as Record<Key, string>) === filters.projectId,
  };
}

export function aiSpendReport(actor: Actor, query: AiSpendQuery, now = Date.now()): AiSpendReport {
  const filters = cleanFilters(query.filters);
  const range = currentRange(query, now);
  checkReadable(actor, filters);

  const ctx = context(actor, filters);
  const place = placer(ctx);
  const overrides = priceOverrides();
  const priced = new Map<string, boolean>();
  const hasPrice = (provider: string, model: string) => {
    const key = `${provider}/${model}`;
    if (!priced.has(key)) priced.set(key, findPrice(provider, model, overrides) !== undefined);
    return priced.get(key) as boolean;
  };
  // run-spend.ts `callOf`'s rule on a combination: no current price and no cost.
  const unpricedRow = (row: Row) => row.cost <= 0 && !hasPrice(row.provider, row.model);

  const comparable = Boolean(query.compare) && (query.period !== 'custom' || spanDays(range.from, range.to) <= COMPARE_MAX_DAYS);
  const build = (r: Range) => {
    const rows = withProject(load(r, filters, KEYS, false), ctx, filters);
    const runs = withProject(loadRuns(r, filters), ctx, filters);
    return aggregate(rows, runs, ctx, place, unpricedRow);
  };
  const current = build(range);
  const before = comparable ? build(previousRange(range)) : undefined;

  const modelUnpriced = (b: Bucket) => {
    const slash = b.key.indexOf('/');
    return b.cost <= 0 && !hasPrice(b.key.slice(0, slash), b.key.slice(slash + 1));
  };
  const groups = Object.fromEntries(
    AI_SPEND_GROUPS.map((group) => [
      group,
      finish({
        group,
        buckets: current.groups[group],
        whole: group === 'person' ? current.people : current.total,
        previous: before?.groups[group],
        unpriced: modelUnpriced,
      }),
    ]),
  ) as Record<AiSpendGroup, AiSpendRow[]>;
  // The same model through two providers keeps one row each: name the provider when labels collide.
  const labels = new Map<string, number>();
  for (const row of groups.model) labels.set(row.label, (labels.get(row.label) ?? 0) + 1);
  for (const row of groups.model)
    if (row.key !== 'other' && (labels.get(row.label) ?? 0) > 1) row.label = `${row.label} (${row.key.slice(0, row.key.indexOf('/'))})`;

  const seriesRows = withProject(load(range, filters, query.stack ? KEYS : ['user_id', 'workflow_id', 'agent_id', 'project_id'], true), ctx, filters);
  const series = seriesOf(range, seriesRows, ctx);

  return {
    period: query.period,
    from: range.from,
    to: range.to,
    filters,
    totals: totalsOf(current.total),
    peopleTotals: totalsOf(current.people),
    ...(before && { previous: totalsOf(before.total) }),
    series,
    ...(query.stack && {
      stack: stackOf(query.stack, range, seriesRows, ctx, place),
    }),
    groups,
    movers: before ? moversOf(current, before) : [],
  };
}

const bucketAt = (range: Range, bucket: string) => (range.hours ? `${bucket}:00:00.000Z` : bucket);

function seriesOf(range: Range, rows: Row[], ctx: Context): AiSpendPoint[] {
  const points = new Map<string, AiSpendPoint>(
    range.buckets.map((b) => [
      b,
      {
        at: bucketAt(range, b),
        cost: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        calls: 0,
      },
    ]),
  );
  for (const row of rows) {
    if (!ctx.visible(row)) continue;
    const point = points.get(row.at);
    if (!point) continue;
    point.cost += row.cost;
    point.inputTokens += row.input;
    point.outputTokens += row.output;
    point.cacheReadTokens += row.cacheRead;
    point.calls += row.calls;
  }
  return [...points.values()];
}

/** The series split by `group`: its top 5 by cost (tokens when nothing cost anything) and "Other". */
function stackOf(group: AiSpendGroup, range: Range, rows: Row[], ctx: Context, place: ReturnType<typeof placer>): AiSpendStack {
  const scope = group === 'person' ? 'everyone' : 'visible';
  const inScope = scope === 'everyone' ? ctx.people : ctx.visible;
  const totals = new Map<string, { label: string; cost: number; tokens: number }>();
  const cells = new Map<string, { cost: number; tokens: number }>();
  const placed = new Map<Row, Placement>();
  for (const row of rows) {
    if (!inScope(row)) continue;
    const p = place(group, row);
    placed.set(row, p);
    const total = totals.get(p.key) ?? { label: p.label, cost: 0, tokens: 0 };
    total.cost += row.cost;
    total.tokens += row.input + row.output;
    totals.set(p.key, total);
  }
  const anyCost = [...totals.values()].some((t) => t.cost > 0);
  const top = [...totals]
    .sort(([, a], [, b]) => (anyCost ? b.cost - a.cost || b.tokens - a.tokens : b.tokens - a.tokens || b.cost - a.cost) || a.label.localeCompare(b.label))
    .slice(0, STACK_LIMIT);
  const keys = top.map(([key]) => key);
  const withOther = totals.size > keys.length;
  const stackRows = [...top.map(([key, t]) => ({ key, label: t.label })), ...(withOther ? [{ key: 'other', label: 'Other' }] : [])];
  for (const [row, p] of placed) {
    const key = keys.includes(p.key) ? p.key : 'other';
    const id = `${row.at}|${key}`;
    const cell = cells.get(id) ?? { cost: 0, tokens: 0 };
    cell.cost += row.cost;
    cell.tokens += row.input + row.output;
    cells.set(id, cell);
  }
  return {
    group,
    rows: stackRows,
    points: range.buckets.map((b) => ({
      at: bucketAt(range, b),
      cost: stackRows.map((r) => cells.get(`${b}|${r.key}`)?.cost ?? 0),
      tokens: stackRows.map((r) => cells.get(`${b}|${r.key}`)?.tokens ?? 0),
    })),
    scope,
  };
}

const NOT_A_ROW = new Set(['none', 'shared', 'other']);

/** The biggest rises and falls against the previous period across the groups, 5 each; never an "Another ...", "Other" or "No ..." row. */
function moversOf(current: Aggregate, before: Aggregate): AiSpendReport['movers'] {
  const all: AiSpendReport['movers'] = [];
  for (const group of AI_SPEND_GROUPS) {
    const keys = new Set([...current.groups[group].keys(), ...before.groups[group].keys()]);
    for (const key of keys) {
      if (NOT_A_ROW.has(key)) continue;
      const now = current.groups[group].get(key);
      const prior = before.groups[group].get(key);
      all.push({
        group,
        key,
        label: (now ?? prior)?.label ?? key,
        cost: now?.cost ?? 0,
        previousCost: prior?.cost ?? 0,
      });
    }
  }
  const delta = (m: { cost: number; previousCost: number }) => m.cost - m.previousCost;
  const rises = all
    .filter((m) => delta(m) > 0)
    .sort((a, b) => delta(b) - delta(a))
    .slice(0, MOVERS_EACH);
  const falls = all
    .filter((m) => delta(m) < 0)
    .sort((a, b) => delta(a) - delta(b))
    .slice(0, MOVERS_EACH);
  return [...rises, ...falls];
}
