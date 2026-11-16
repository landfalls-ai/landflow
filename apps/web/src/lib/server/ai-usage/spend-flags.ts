/**
 * The stored flags behind forecasts and unusual spend (SP23, docs/llm-gateway.md#forecasts-and-unusual-spend): one row
 * of `ai_spend_flags` for each unusual day of a person, agent, workflow, project or model, and for each monthly cap
 * forecast to be reached. `anomalies.ts` writes them every ten minutes; the cost alerts (`alerts.ts`), Needs you
 * (`spendItems`), the acknowledge route and the brain's `spend-anomaly` detector read them here. Writes go through the
 * row calls only (`upsert`, `delete`, `deleteBefore`), so Postgres mode replays them.
 *
 * Who is told what (docs/llm-gateway.md "Who sees what", rule 6): a flag about a person goes to that person and to
 * owners and admins; an agent's or workflow's to the people who can edit it; a project's (and its budget's forecast) to
 * the project's admins; a model's, and a credential cap's, to owners and admins only. A member never gets another
 * person's flag. Nothing here changes a cap, a budget or a run.
 */
import { createHash } from 'node:crypto';
import type { NeedsYouItem } from '../journal/needs-you';
import { formatCost, formatTokens } from '../../shared/ai-usage';
import { parseCapId } from '../../shared/llm-gateway';
import { projectRoleCan } from '../../shared/projects';
import { agentStore } from '../agents/store';
import { recordAudit } from '../audit';
import { database, type Database, type SqlValue } from '../db';
import { HttpError } from '../errors';
import { canResource, isInstanceAdmin, projectRole, type Actor } from '../projects/access';
import { getProject } from '../projects/store';
import { store } from '../store';

export const SPEND_DIMENSIONS = ['person', 'agent', 'workflow', 'project', 'model'] as const;
export type SpendDimension = (typeof SPEND_DIMENSIONS)[number];
export type SpendFlagKind = 'anomaly' | 'forecast';

export interface SpendFlag {
  id: string;
  kind: SpendFlagKind;
  /** `YYYY-MM-DD` in the instance's time zone; a forecast: the month's first day. */
  day: string;
  /** An anomaly: person, agent, workflow, project or model. A forecast: the cap's kind (user, agent, workflow, credential, project). */
  dimension: string;
  /** An id, `provider/model`, or a forecast's cap id. */
  key: string;
  /** "agent “Orders”", "Mia", "model anthropic/claude-sonnet-5-5", "project “Alpha”". */
  label: string;
  metric: 'cost' | 'tokens';
  /** The day's value (an anomaly) or the month to date (a forecast), in dollars or tokens. */
  value: number;
  baselineMedian?: number;
  baselineMad?: number;
  /** Two decimals; absent when the baseline was flat (MAD 0). */
  score?: string;
  baselineDays?: number;
  /** Distinct runs behind the day (an anomaly). */
  runs: number;
  /** The surfaces that made up the day ("Spotlight", "workflow runs"). */
  surfaces: string[];
  capMax?: number;
  p50?: number;
  reachesOn?: string;
  firstAt: string;
  updatedAt: string;
  lastAlertValue?: number;
  acknowledgedBy?: string;
  acknowledgedAt?: string;
}

interface FlagRow extends Record<string, SqlValue> {
  id: string;
  kind: string;
  day: string;
  dimension: string;
  key: string;
  label: string | null;
  metric: string;
  value: number;
  baseline_median: number | null;
  baseline_mad: number | null;
  score: string | null;
  baseline_days: number | null;
  runs: number;
  surfaces: string | null;
  cap_max: number | null;
  p50: number | null;
  reaches_on: string | null;
  first_at: string;
  updated_at: string;
  last_alert_value: number | null;
  acknowledged_by: string | null;
  acknowledged_at: string | null;
}

const num = (value: unknown): number | undefined => (value === null || value === undefined ? undefined : Number(value));

function fromRow(row: FlagRow): SpendFlag {
  return {
    id: row.id,
    kind: row.kind === 'forecast' ? 'forecast' : 'anomaly',
    day: row.day,
    dimension: row.dimension,
    key: row.key,
    label: row.label ?? row.key,
    metric: row.metric === 'tokens' ? 'tokens' : 'cost',
    value: Number(row.value),
    ...(num(row.baseline_median) !== undefined && { baselineMedian: num(row.baseline_median) }),
    ...(num(row.baseline_mad) !== undefined && { baselineMad: num(row.baseline_mad) }),
    ...(row.score && { score: row.score }),
    ...(num(row.baseline_days) !== undefined && { baselineDays: num(row.baseline_days) }),
    runs: Number(row.runs ?? 0),
    surfaces: row.surfaces ? row.surfaces.split('|').filter(Boolean) : [],
    ...(num(row.cap_max) !== undefined && { capMax: num(row.cap_max) }),
    ...(num(row.p50) !== undefined && { p50: num(row.p50) }),
    ...(row.reaches_on && { reachesOn: row.reaches_on }),
    firstAt: row.first_at,
    updatedAt: row.updated_at,
    ...(num(row.last_alert_value) !== undefined && { lastAlertValue: num(row.last_alert_value) }),
    ...(row.acknowledged_by && { acknowledgedBy: row.acknowledged_by }),
    ...(row.acknowledged_at && { acknowledgedAt: row.acknowledged_at }),
  };
}

function toRow(flag: SpendFlag): FlagRow {
  return {
    id: flag.id,
    kind: flag.kind,
    day: flag.day,
    dimension: flag.dimension,
    key: flag.key,
    label: flag.label,
    metric: flag.metric,
    value: flag.value,
    baseline_median: flag.baselineMedian ?? null,
    baseline_mad: flag.baselineMad ?? null,
    score: flag.score ?? null,
    baseline_days: flag.baselineDays ?? null,
    runs: flag.runs,
    surfaces: flag.surfaces.length ? flag.surfaces.join('|') : null,
    cap_max: flag.capMax ?? null,
    p50: flag.p50 ?? null,
    reaches_on: flag.reachesOn ?? null,
    first_at: flag.firstAt,
    updated_at: flag.updatedAt,
    last_alert_value: flag.lastAlertValue ?? null,
    acknowledged_by: flag.acknowledgedBy ?? null,
    acknowledged_at: flag.acknowledgedAt ?? null,
  };
}

/** The flag's id: derived from its kind, day, dimension and key, so writing the same flag again is an upsert. */
export const flagId = (kind: SpendFlagKind, day: string, dimension: string, key: string): string => `sf_${createHash('sha256').update([kind, day, dimension, key].join('\u0000')).digest('hex').slice(0, 24)}`;

export function getFlag(id: string, db: Database = database()): SpendFlag | undefined {
  const row = db.get<FlagRow>('SELECT * FROM ai_spend_flags WHERE id = ?', id);
  return row && fromRow(row);
}

/** Flags of a kind from `sinceDay` on, newest day first. */
export function listFlags(kind: SpendFlagKind, sinceDay: string, db: Database = database()): SpendFlag[] {
  return db.all<FlagRow>('SELECT * FROM ai_spend_flags WHERE kind = ? AND day >= ? ORDER BY day DESC, updated_at DESC', kind, sinceDay).map(fromRow);
}

export function saveFlag(flag: SpendFlag, db: Database = database()) {
  db.upsert('ai_spend_flags', toRow(flag));
}

export function deleteFlag(id: string, db: Database = database()) {
  db.delete('ai_spend_flags', { id });
}

/** The alert service sent `value` for this flag: remembered so the next alert waits for the day's value to double. */
export function noteAlerted(id: string, value: number, db: Database = database()) {
  const flag = getFlag(id, db);
  if (flag && !(flag.lastAlertValue !== undefined && flag.lastAlertValue >= value)) saveFlag({ ...flag, lastAlertValue: value }, db);
}

export function pruneFlags(beforeDay: string, db: Database = database()) {
  db.deleteBefore('ai_spend_flags', 'day', beforeDay);
}

// ---- words ------------------------------------------------------------------------------------------------

export const amountOf = (metric: 'cost' | 'tokens', value: number): string => (metric === 'cost' ? formatCost(value) : `${formatTokens(Math.round(value))} tokens`);

const SURFACE_WORDS: Record<string, string> = { spotlight: 'Spotlight', architect: 'Agent architect', brain: 'Ask the brain', '': 'workflow and agent runs' };
export const surfaceWord = (surface: string): string => SURFACE_WORDS[surface] ?? surface;

/** "$12.40 against a usual $5.00 a day over 10 observed days". */
export function baselineSentence(flag: SpendFlag): string {
  if (flag.baselineMedian === undefined) return '';
  return `usually ${amountOf(flag.metric, flag.baselineMedian)} a day (median of ${flag.baselineDays ?? 0} observed days)`;
}

/** Where the AI page shows the flag: the day (or the month so far), narrowed to what the flag is about. */
export function flagHref(flag: Pick<SpendFlag, 'kind' | 'day' | 'dimension' | 'key'>, today?: string): string {
  const query = new URLSearchParams({ period: 'custom' });
  if (flag.kind === 'anomaly') {
    query.set('from', flag.day);
    query.set('to', flag.day);
    const name = { person: 'userId', agent: 'agentId', workflow: 'workflowId', project: 'projectId', model: 'model' }[flag.dimension];
    if (name) query.set(name, flag.key);
  } else {
    query.set('from', flag.day);
    query.set('to', today && today >= flag.day ? today : flag.day);
    const parsed = parseCapId(flag.key);
    const name = parsed && { user: 'userId', agent: 'agentId', workflow: 'workflowId', project: 'projectId', credential: 'credentialId' }[parsed.kind];
    if (parsed && name) query.set(name, parsed.subjectId);
  }
  return `/insights/ai?${query.toString()}`;
}

// ---- who is told ------------------------------------------------------------------------------------------

/** What a flag is about, as the audience rules see it: a kind of subject and its id. */
function subjectOf(flag: SpendFlag): { kind: 'person' | 'agent' | 'workflow' | 'project' | 'model' | 'credential'; id: string } | undefined {
  if (flag.kind === 'anomaly') return SPEND_DIMENSIONS.includes(flag.dimension as SpendDimension) ? { kind: flag.dimension as SpendDimension, id: flag.key } : undefined;
  const parsed = parseCapId(flag.key);
  if (!parsed) return undefined;
  return { kind: parsed.kind === 'user' ? 'person' : parsed.kind, id: parsed.subjectId };
}

/** Whether what the flag is about still exists (a deleted project's flags stay as history but leave Needs you). */
function subjectExists(subject: NonNullable<ReturnType<typeof subjectOf>>): boolean {
  switch (subject.kind) {
    case 'project':
      return Boolean(getProject(subject.id));
    case 'agent':
      return Boolean(agentStore.get(subject.id));
    case 'workflow':
      return Boolean(store.getWorkflow(subject.id));
    default:
      return true;
  }
}

/** The audience, read live: a transferred agent or workflow's flags follow its access now. */
export function inAudience(actor: Actor, flag: SpendFlag): boolean {
  const subject = subjectOf(flag);
  if (!subject || !subjectExists(subject)) return false;
  if (isInstanceAdmin(actor)) return true;
  switch (subject.kind) {
    case 'person':
      return subject.id === actor.id;
    case 'agent':
    case 'workflow':
      return canResource(actor, subject.kind, subject.id, 'update');
    case 'project':
      return projectRoleCan.manage(projectRole(actor, subject.id));
    default:
      return false; // a model, a credential's cap: owners and admins only
  }
}

const DAY_MS = 86_400_000;
/** Anomalies stay in Needs you this long unless acknowledged. */
export const ANOMALY_SHOWN_DAYS = 7;

const dayBefore = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00Z`) - days * DAY_MS).toISOString().slice(0, 10);

export function titleOf(flag: SpendFlag): string {
  if (flag.kind === 'forecast') {
    const cap = flag.capMax === undefined ? 'its monthly cap' : `its ${amountOf(flag.metric, flag.capMax)} monthly cap`;
    return `${flag.label} is on course to reach ${cap}${flag.reachesOn ? ` around ${flag.reachesOn}` : ''}`;
  }
  return `Unusual AI spend: ${flag.label} used ${amountOf(flag.metric, flag.value)} on ${flag.day}`;
}

export function detailOf(flag: SpendFlag): string {
  if (flag.kind === 'forecast') return `${amountOf(flag.metric, flag.value)} so far this month, forecast ${amountOf(flag.metric, flag.p50 ?? 0)} by the month’s end. Nothing is paused: raise the cap or slow down.`;
  const parts = [baselineSentence(flag), flag.score ? `score ${flag.score}` : 'new or flat baseline', `${flag.runs} run${flag.runs === 1 ? '' : 's'}`, flag.surfaces.length ? flag.surfaces.join(', ') : ''];
  return parts.filter(Boolean).join(' · ');
}

export type SpendNeedsYouItem = NeedsYouItem & { kind: 'spend'; flagId: string; flagKind: SpendFlagKind; href: string; canAcknowledge: boolean };

/** Needs you's items for `actor`: the unacknowledged anomalies of the last 7 days and this month's forecasts that are theirs to hear. */
export function spendItems(actor: Actor, today: string, db: Database = database()): SpendNeedsYouItem[] {
  const items: SpendNeedsYouItem[] = [];
  const flags = [...listFlags('anomaly', dayBefore(today, ANOMALY_SHOWN_DAYS), db), ...listFlags('forecast', `${today.slice(0, 7)}-01`, db)];
  for (const flag of flags) {
    if (flag.acknowledgedAt || !inAudience(actor, flag)) continue;
    items.push({
      executionId: '',
      workflowId: '',
      workflowName: '',
      kind: 'spend',
      flagId: flag.id,
      flagKind: flag.kind,
      href: flagHref(flag, today),
      canAcknowledge: true,
      title: titleOf(flag),
      detail: detailOf(flag),
      since: flag.updatedAt,
    });
  }
  return items;
}

/** POST …/flags/:id/ack: anyone in the flag's audience; a 404 for anyone else (the flag is not theirs to know). Clears it for everyone. */
export function acknowledgeFlag(id: string, actor: Actor, now = Date.now(), db: Database = database()): SpendFlag {
  const flag = getFlag(id, db);
  if (!flag || !inAudience(actor, flag)) throw new HttpError('Flag not found', 404);
  if (flag.acknowledgedAt) return flag;
  const next: SpendFlag = { ...flag, acknowledgedBy: actor.id, acknowledgedAt: new Date(now).toISOString() };
  saveFlag(next, db);
  recordAudit({
    action: 'ai.spend.acknowledged',
    target: { type: 'ai_spend_flag', id: flag.id, name: flag.label },
    summary: `Acknowledged ${flag.kind === 'forecast' ? 'the forecast over a cap' : 'unusual AI spend'} for ${flag.label} (${flag.day})`,
    details: { kind: flag.kind, day: flag.day, dimension: flag.dimension, key: flag.key },
  });
  return next;
}
