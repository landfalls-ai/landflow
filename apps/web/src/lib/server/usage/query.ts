/**
 * Reading the usage ledger: events, grouped reports, and the daily rollups that outlive the raw events.
 *
 * Raw events are kept USAGE_RETENTION_DAYS (default 90). `usage_daily` holds one row per day, kind, workflow, node type,
 * signature and agent, recomputed from the raw events for recent days (hourly, and before a report that needs today),
 * and kept 400 days. A report over a window that starts after the raw events' cutoff reads the raw events (exact, to the
 * second); an older window reads the rollups (whole days).
 *
 * Scope: `only` lists the workflows and agents a member sees (undefined: everything, for owners and admins). Events tied
 * to neither (Spotlight asks, empty searches) are left out of a scoped report.
 */
import { ATTR_NAME, isUsageKind, type UsageEvent, type UsageFilter, type UsageGroup, type UsageGroupRow, type UsageKind, type UsageReport } from '../../shared/brain';
import { database, type Database, type SqlValue } from '../db';
import { dayOf, fromRow, type UsageRow } from './ledger';

const DAY_MS = 86_400_000;
const ROLLUP_DAYS = 400;

export const rawRetentionDays = () => {
  const n = Number(process.env.USAGE_RETENTION_DAYS);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 90;
};

export interface UsageScope {
  workflows?: Set<string>;
  agents?: Set<string>;
  /** Agent teams (the notebook's project suggestions). */
  teams?: Set<string>;
}

/** An ISO time from `from`/`to` (ISO or YYYY-MM-DD), else `fallback`. */
function isoOf(value: string | undefined, fallback: number, endOfDay = false): string {
  if (value && /^\d{4}-\d{2}-\d{2}$/.test(value)) return `${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`;
  const ms = value ? Date.parse(value) : NaN;
  return new Date(Number.isFinite(ms) ? ms : fallback).toISOString();
}

interface Where {
  sql: string;
  params: SqlValue[];
}

function scopeClause(scope: UsageScope | undefined, where: string[], params: SqlValue[]) {
  if (!scope || (!scope.workflows && !scope.agents)) return;
  const parts: string[] = [];
  const wf = [...(scope.workflows ?? [])];
  const ag = [...(scope.agents ?? [])];
  if (wf.length) {
    parts.push(`workflow_id IN (${wf.map(() => '?').join(', ')})`);
    params.push(...wf);
  }
  if (ag.length) {
    parts.push(`(workflow_id IS NULL OR workflow_id = '') AND agent_id IN (${ag.map(() => '?').join(', ')})`);
    params.push(...ag);
  }
  where.push(parts.length ? `(${parts.map((p) => `(${p})`).join(' OR ')})` : '1 = 0');
}

function filterClause(filter: UsageFilter, timeColumn: 'at' | 'day', scope?: UsageScope): Where {
  const now = Date.now();
  const where: string[] = [];
  const params: SqlValue[] = [];
  const from = isoOf(filter.from, now - 7 * DAY_MS);
  const to = isoOf(filter.to, now, true);
  if (timeColumn === 'at') {
    where.push('at >= ?', 'at <= ?');
    params.push(from, to);
  } else {
    where.push('day >= ?', 'day <= ?');
    params.push(dayOf(Date.parse(from)), dayOf(Date.parse(to)));
  }
  if (filter.kinds?.length) {
    where.push(`kind IN (${filter.kinds.map(() => '?').join(', ')})`);
    params.push(...filter.kinds);
  }
  const eq = (column: string, value: string | undefined) => {
    if (!value) return;
    where.push(`${column} = ?`);
    params.push(value);
  };
  eq('workflow_id', filter.workflowId);
  eq('agent_id', filter.agentId);
  eq('node_type', filter.nodeType);
  eq('signature', filter.signature);
  // Attributes live in the raw events only (usage_daily keeps none): usageReport reads those whenever they are asked for.
  if (timeColumn === 'at') {
    for (const [name, value] of Object.entries(filter.attrEquals ?? {})) {
      if (!ATTR_NAME.test(name)) continue;
      // SQLite reads a stored true/false back as 1/0, so a boolean matches either way.
      const bool = value === 'true' ? '1' : value === 'false' ? '0' : undefined;
      const text = `CAST(json_extract(attrs, '$.${name}') AS TEXT)`;
      where.push(bool ? `(${text} = ? OR ${text} = ?)` : `${text} = ?`);
      params.push(value, ...(bool ? [bool] : []));
    }
  }
  scopeClause(scope, where, params);
  return { sql: where.join(' AND '), params };
}

/** Events matching `filter`, newest first. */
export function listUsageEvents(filter: UsageFilter = {}, options: { limit?: number; scope?: UsageScope } = {}, db: Database = database()): UsageEvent[] {
  const { sql, params } = filterClause(filter, 'at', options.scope);
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 5_000);
  return db.all<UsageRow>(`SELECT * FROM usage_events WHERE ${sql} ORDER BY at DESC LIMIT ${limit}`, ...params).map(fromRow);
}

const GROUP_COLUMNS: Record<UsageGroup, string> = {
  day: 'day',
  kind: 'kind',
  workflow: 'workflow_id',
  nodeType: 'node_type',
  signature: 'signature',
  agent: 'agent_id',
  model: "json_extract(attrs, '$.model')",
  // Replaced by the attribute `usageReport` was asked for (a name checked against ATTR_NAME).
  attr: 'NULL',
};

interface GroupRow {
  key: string | null;
  count: number;
  failures: number;
  duration_sum: number;
  duration_max: number;
  duration_n: number;
  items: number;
  tokens: number;
  cost: number;
}

/** A row counts as a failure when it is one (`node.failed`) or says so (`run.finished` with status error, a thumbs down). */
const FAILURE_SQL = `CASE WHEN kind = 'node.failed' OR json_extract(attrs, '$.status') = 'error' OR json_extract(attrs, '$.rating') = 'down' THEN 1 ELSE 0 END`;

const sampleMessage = (signature: string, db: Database) =>
  db.get<{ message: string }>('SELECT message FROM usage_events WHERE signature = ? AND message IS NOT NULL ORDER BY at DESC LIMIT 1', signature)?.message;

/** A grouped report: counts, failures, durations, items, tokens and cost per group, largest count first. */
export function usageReport(filter: UsageFilter = {}, groupBy: UsageGroup = 'kind', options: { scope?: UsageScope; limit?: number; labels?: (group: UsageGroup, key: string) => string | undefined } = {}, db: Database = database()): UsageReport {
  const now = Date.now();
  const from = isoOf(filter.from, now - 7 * DAY_MS);
  const to = isoOf(filter.to, now, true);
  const attrName = groupBy === 'attr' && filter.attr && ATTR_NAME.test(filter.attr) ? filter.attr : undefined;
  if (groupBy === 'attr' && !attrName) throw new Error('Group by an attribute needs its name: groupAttr=team');
  const raw = Date.parse(from) >= now - rawRetentionDays() * DAY_MS;
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 1_000);
  let rows: GroupRow[];
  if (raw || groupBy === 'model' || attrName || Object.keys(filter.attrEquals ?? {}).length) {
    const { sql, params } = filterClause({ ...filter, from, to }, 'at', options.scope);
    const column = attrName ? `json_extract(attrs, '$.${attrName}')` : GROUP_COLUMNS[groupBy];
    rows = db.all<GroupRow>(
      `SELECT ${column} AS key, COUNT(*) AS count, SUM(${FAILURE_SQL}) AS failures,
        COALESCE(SUM(duration_ms), 0) AS duration_sum, COALESCE(MAX(duration_ms), 0) AS duration_max, COUNT(duration_ms) AS duration_n,
        COALESCE(SUM(items), 0) AS items, COALESCE(SUM(tokens), 0) AS tokens, COALESCE(SUM(cost), 0) AS cost
       FROM usage_events WHERE ${sql} GROUP BY key ORDER BY count DESC LIMIT ${limit}`,
      ...params,
    );
  } else {
    rollupRecent(db);
    const { sql, params } = filterClause({ ...filter, from, to }, 'day', options.scope);
    rows = db.all<GroupRow>(
      `SELECT NULLIF(${GROUP_COLUMNS[groupBy]}, '') AS key, SUM(count) AS count, SUM(failures) AS failures, SUM(duration_sum) AS duration_sum,
        MAX(duration_max) AS duration_max, SUM(count) AS duration_n, SUM(items) AS items, SUM(tokens) AS tokens, SUM(cost) AS cost
       FROM usage_daily WHERE ${sql} GROUP BY key ORDER BY count DESC LIMIT ${limit}`,
      ...params,
    );
  }
  const toGroup = (r: GroupRow): UsageGroupRow => {
    const key = r.key === null || r.key === undefined ? '' : String(r.key);
    // A failure signature reads as one of its (redacted) messages.
    const label = key ? (options.labels?.(groupBy, key) ?? (groupBy === 'signature' ? sampleMessage(key, db) : undefined)) : undefined;
    return {
      key,
      ...(label && { label }),
      count: Number(r.count ?? 0),
      failures: Number(r.failures ?? 0),
      durationAvgMs: Number(r.duration_n) ? Math.round(Number(r.duration_sum ?? 0) / Number(r.duration_n)) : 0,
      durationMaxMs: Math.round(Number(r.duration_max ?? 0)),
      items: Number(r.items ?? 0),
      tokens: Number(r.tokens ?? 0),
      cost: Number(r.cost ?? 0),
    };
  };
  const groups = rows.map(toGroup);
  const totals = groups.reduce(
    (t, g) => ({
      count: t.count + g.count,
      failures: t.failures + g.failures,
      durationAvgMs: 0,
      durationMaxMs: Math.max(t.durationMaxMs, g.durationMaxMs),
      items: t.items + g.items,
      tokens: t.tokens + g.tokens,
      cost: t.cost + g.cost,
    }),
    { count: 0, failures: 0, durationAvgMs: 0, durationMaxMs: 0, items: 0, tokens: 0, cost: 0 },
  );
  const weighted = groups.reduce((sum, g) => sum + g.durationAvgMs * g.count, 0);
  totals.durationAvgMs = totals.count ? Math.round(weighted / totals.count) : 0;
  return { from, to, groupBy, rows: groups, totals };
}

/** The p-th percentile (0..1) of `duration_ms` over raw events matching `where`. */
export function percentile(where: string, params: SqlValue[], p = 0.95, db: Database = database()): number {
  const n = Number(db.get<{ n: number }>(`SELECT COUNT(duration_ms) AS n FROM usage_events WHERE ${where} AND duration_ms IS NOT NULL`, ...params)?.n ?? 0);
  if (!n) return 0;
  const offset = Math.min(n - 1, Math.floor(n * p));
  return Number(db.get<{ d: number }>(`SELECT duration_ms AS d FROM usage_events WHERE ${where} AND duration_ms IS NOT NULL ORDER BY duration_ms LIMIT 1 OFFSET ${offset}`, ...params)?.d ?? 0);
}

// ---------------------------------------------------------------------------
// Rollups and retention
// ---------------------------------------------------------------------------

let lastRollup = 0;

/** Recompute `usage_daily` for `days` from the raw events. */
export function rollupDays(days: string[], db: Database = database()) {
  for (const day of days) {
    const rows = db.all<{
      kind: UsageKind;
      workflow_id: string | null;
      node_type: string | null;
      signature: string | null;
      agent_id: string | null;
      project_id: string | null;
      count: number;
      failures: number;
      duration_sum: number;
      duration_max: number;
      items: number;
      tokens: number;
      cost: number;
    }>(
      `SELECT kind, workflow_id, node_type, signature, agent_id, MAX(project_id) AS project_id, COUNT(*) AS count, SUM(${FAILURE_SQL}) AS failures,
        COALESCE(SUM(duration_ms), 0) AS duration_sum, COALESCE(MAX(duration_ms), 0) AS duration_max, COALESCE(SUM(items), 0) AS items,
        COALESCE(SUM(tokens), 0) AS tokens, COALESCE(SUM(cost), 0) AS cost
       FROM usage_events WHERE day = ? GROUP BY kind, workflow_id, node_type, signature, agent_id`,
      day,
    );
    db.transaction(() => {
      db.delete('usage_daily', { day });
      for (const r of rows) {
        db.upsert('usage_daily', {
          day,
          kind: r.kind,
          workflow_id: r.workflow_id ?? '',
          node_type: r.node_type ?? '',
          signature: r.signature ?? '',
          agent_id: r.agent_id ?? '',
          project_id: r.project_id,
          count: Number(r.count),
          failures: Number(r.failures ?? 0),
          duration_sum: Number(r.duration_sum),
          duration_max: Number(r.duration_max),
          items: Number(r.items),
          tokens: Number(r.tokens),
          cost: Number(r.cost),
        });
      }
    });
  }
}

/** Today's and yesterday's rollups, at most once a minute. */
export function rollupRecent(db: Database = database(), now = Date.now()) {
  if (now - lastRollup < 60_000) return;
  lastRollup = now;
  rollupDays([dayOf(now - DAY_MS), dayOf(now)], db);
}

/** Every day the raw events cover that has no rollup yet (after a backfill). */
export function rollupMissing(db: Database = database()) {
  const days = db.all<{ day: string }>(`SELECT DISTINCT day FROM usage_events WHERE day NOT IN (SELECT DISTINCT day FROM usage_daily)`).map((r) => r.day);
  rollupDays(days, db);
  return days.length;
}

/** Drop raw events past USAGE_RETENTION_DAYS and rollups past 400 days. */
export function pruneUsage(db: Database = database(), now = Date.now()): number {
  const removed = db.deleteBefore('usage_events', 'at', new Date(now - rawRetentionDays() * DAY_MS).toISOString());
  db.deleteBefore('usage_daily', 'day', dayOf(now - ROLLUP_DAYS * DAY_MS));
  return removed;
}

/** How many raw events there are, and the oldest one's time. */
export function ledgerSize(db: Database = database()): { events: number; oldest?: string } {
  const row = db.get<{ n: number; oldest: string | null }>('SELECT COUNT(*) AS n, MIN(at) AS oldest FROM usage_events');
  return { events: Number(row?.n ?? 0), ...(row?.oldest && { oldest: row.oldest }) };
}

/** The filter of GET /api/usage and /api/usage/events, from the query string. */
export function usageFilter(url: URL): UsageFilter {
  const param = (name: string) => url.searchParams.get(name)?.trim() || undefined;
  const kinds = (param('kinds') ?? '')
    .split(',')
    .map((k) => k.trim())
    .filter((k): k is UsageKind => isUsageKind(k));
  // `attr.team=billing` keeps events whose attribute equals the value; `groupAttr=team` names the attribute groupBy=attr groups by.
  const attrEquals: Record<string, string> = {};
  for (const [key, value] of url.searchParams) if (key.startsWith('attr.') && ATTR_NAME.test(key.slice(5))) attrEquals[key.slice(5)] = value;
  return {
    ...(Object.keys(attrEquals).length && { attrEquals }),
    ...(param('groupAttr') && { attr: param('groupAttr') }),
    ...(kinds.length && { kinds }),
    from: param('from'),
    to: param('to'),
    workflowId: param('workflowId'),
    agentId: param('agentId'),
    nodeType: param('nodeType'),
    signature: param('signature'),
  };
}
