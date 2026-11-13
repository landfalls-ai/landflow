/**
 * Token & cost tracking with caps (docs/observability.md). Every model call — chat or embeddings, from a
 * workflow node, a chain, an agent, a tool — goes through telemetry/ai.ts, which asks the current usage
 * scope (./scope) whether the call may start and reports what it used. Here the calls are priced
 * (./prices), stored one row each in `ai_usage` (migration 400), and summed for the caps:
 *
 * - per execution (Workflow settings): tokens or cost of the whole run, sub-workflows and earlier
 *   segments (before a Wait) included;
 * - per workflow per day (Workflow settings), in the instance time zone;
 * - per agent (Agent → Settings): tokens or cost per day, cost per month;
 * - per model credential and per user who started the run (Settings → AI usage caps, ./caps.ts): tokens or
 *   cost per day or month. These depend on the call, so the meter hands them out per call (`callLimits`).
 *
 * Cached input (Anthropic cache reads and writes, OpenAI cached input) is stored on each row and priced at the
 * model's cache prices (./prices.ts).
 *
 * A call is refused once a cap is reached, and a call that goes over one stops the run with a
 * UsageCapError. Rows are kept for AI_USAGE_RETENTION_DAYS (default 400).
 */
import { nanoid } from 'nanoid';
import type { WorkflowSettings } from '@landflow/engine';
import type { AgentSettings } from '../../shared/agents';
import { EMPTY_USAGE, type AiCaps, type AiModelUsage, type AiUsageReport, type AiUsageTotals, type ExecutionAiUsage, type UsageCapSet } from '../../shared/ai-usage';
import { database, type Database, type SqlValue } from '../db';
import { logger } from '../telemetry/logger';
import { recordUsage } from '../usage/ledger';
import { instanceTimezone } from '../settings';
import { aiCaps, capSetActive } from './caps';
import { getUser } from '../auth/users';
import { noteUsage } from './notify';
import { estimateCost, findPrice, priceOverrides } from './prices';
import { currentUsageScope, runInUsageScope, UsageScope, type MeteredCall, type ModelCall, type UsageLimit, type UsageMeter } from './scope';

/** A user's name for messages; the id when the user is gone. */
const userName = (id: string) => getUser(id)?.name || id;

export { isUsageCapError, UsageCapError, UsageScope, currentUsageScope } from './scope';
export { aiCaps, saveAiCaps } from './caps';
export { DEFAULT_PRICES, findPrice, estimateCost, priceTable, savePriceOverrides } from './prices';

const DAY_MS = 86_400_000;
const PRICE_CACHE_MS = 5_000;

/** YYYY-MM-DD in `timezone` (as Insights counts days). */
function dayKey(ms: number, timezone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms);
  } catch {
    return new Date(ms).toISOString().slice(0, 10);
  }
}

interface SumRow {
  input: number | null;
  output: number | null;
  cache_read: number | null;
  cache_write: number | null;
  cost: number | null;
  calls: number | null;
}

const totalsOf = (row: SumRow | undefined): AiUsageTotals => ({
  inputTokens: Number(row?.input ?? 0),
  outputTokens: Number(row?.output ?? 0),
  ...(Number(row?.cache_read ?? 0) > 0 && { cacheReadTokens: Number(row?.cache_read) }),
  ...(Number(row?.cache_write ?? 0) > 0 && { cacheWriteTokens: Number(row?.cache_write) }),
  cost: Number(row?.cost ?? 0),
  calls: Number(row?.calls ?? 0),
});

const SUMS =
  'COALESCE(SUM(input_tokens), 0) AS input, COALESCE(SUM(output_tokens), 0) AS output, COALESCE(SUM(cache_read_tokens), 0) AS cache_read, COALESCE(SUM(cache_write_tokens), 0) AS cache_write, COALESCE(SUM(cost), 0) AS cost, COUNT(*) AS calls';

/** Prices calls and writes them to `ai_usage`. One per process; tests can make their own over another database. */
export class AiUsageMeter implements UsageMeter {
  private prices?: { at: number; overrides: ReturnType<typeof priceOverrides> };
  private capsCache?: { at: number; caps: AiCaps };
  private pruned = 0;

  constructor(
    private readonly db: () => Database = database,
    private readonly timezone: () => string = instanceTimezone,
    private readonly retentionDays = Number(process.env.AI_USAGE_RETENTION_DAYS) || 400,
  ) {}

  cost(call: { provider: string; model: string; inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number }): number {
    if (!this.prices || Date.now() - this.prices.at > PRICE_CACHE_MS) this.prices = { at: Date.now(), overrides: priceOverrides(this.db()) };
    return estimateCost(findPrice(call.provider, call.model, this.prices.overrides), call.inputTokens, call.outputTokens, call.cacheReadTokens, call.cacheWriteTokens);
  }

  /** The price of a call for display (Run Trace): the same pricing as `cost`, and whether the model has a price at all (an unknown one is $0). */
  price(call: { provider: string; model: string; inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number }): { cost: number; priced: boolean } {
    if (!this.prices || Date.now() - this.prices.at > PRICE_CACHE_MS) this.prices = { at: Date.now(), overrides: priceOverrides(this.db()) };
    const price = findPrice(call.provider, call.model, this.prices.overrides);
    return { cost: estimateCost(price, call.inputTokens, call.outputTokens, call.cacheReadTokens, call.cacheWriteTokens), priced: price !== undefined };
  }

  /** Forget cached overrides (after Settings saves new prices). */
  invalidatePrices() {
    this.prices = undefined;
  }

  /** The caps per credential and per user (cached for a few seconds, like prices). */
  caps(): AiCaps {
    if (!this.capsCache || Date.now() - this.capsCache.at > PRICE_CACHE_MS) this.capsCache = { at: Date.now(), caps: aiCaps(this.db()) };
    return this.capsCache.caps;
  }

  /** Forget cached caps (after Settings saves new ones). */
  invalidateCaps() {
    this.capsCache = undefined;
  }

  /** The caps of Settings → AI usage caps that apply to `call`: its credential's, and its user's (or everyone's default). */
  callLimits(call: ModelCall, scope: UsageScope): UsageLimit[] {
    const caps = this.caps();
    const limits: UsageLimit[] = [];
    const where = 'Settings → AI prices → AI usage caps';
    const credentialSet = call.credentialId ? caps.credentials[call.credentialId] : undefined;
    if (call.credentialId && capSetActive(credentialSet)) {
      const id = call.credentialId;
      limits.push(...setLimits(credentialSet, `credential “${credentialSet.name || id}”`, where, (period) => this.sinceTotals('credential_id', id, period)));
    }
    const userId = scope.lookup('userId');
    if (userId) {
      const own = caps.users[userId];
      const set = capSetActive(own) ? own : caps.allUsers;
      if (capSetActive(set)) limits.push(...setLimits(set, own === set ? `user “${set.name || userName(userId)}”` : `user “${own?.name || userName(userId)}” (the cap for every user)`, where, (period) => this.sinceTotals('user_id', userId, period)));
    }
    return limits;
  }

  /** The users who started runs that used AI since `day` (a day key). */
  usersSince(day: string): string[] {
    return this.db()
      .all<{ user_id: string }>('SELECT DISTINCT user_id FROM ai_usage WHERE user_id IS NOT NULL AND day >= ?', day)
      .map((row) => row.user_id);
  }

  /** What a credential or user used today or this month (`column` is `credential_id` or `user_id`). */
  sinceTotals(column: 'credential_id' | 'user_id', id: string, period: 'day' | 'month', day = this.today()): AiUsageTotals {
    return period === 'day' ? this.sum(`${column} = ? AND day = ?`, id, day) : this.sum(`${column} = ? AND day >= ?`, id, `${day.slice(0, 7)}-01`);
  }

  record(call: MeteredCall, scope: UsageScope) {
    const now = Date.now();
    try {
      this.db().insertNew('ai_usage', {
        id: `au_${nanoid(14)}`,
        at: new Date(now).toISOString(),
        day: this.today(now),
        execution_id: scope.lookup('executionId'),
        workflow_id: scope.lookup('workflowId'),
        agent_id: scope.lookup('agentId'),
        session_id: scope.lookup('sessionId'),
        user_id: scope.lookup('userId'),
        credential_id: call.credentialId,
        cache_read_tokens: call.cacheReadTokens,
        cache_write_tokens: call.cacheWriteTokens,
        provider: call.provider,
        model: call.model,
        operation: call.operation,
        input_tokens: call.inputTokens,
        output_tokens: call.outputTokens,
        cost: call.cost,
      });
      noteUsage();
      recordUsage({
        kind: 'ai.call',
        workflowId: scope.lookup('workflowId'),
        agentId: scope.lookup('agentId'),
        executionId: scope.lookup('executionId'),
        actorId: scope.lookup('userId'),
        tokens: (call.inputTokens ?? 0) + (call.outputTokens ?? 0),
        cost: call.cost,
        attrs: { provider: call.provider, model: call.model, operation: call.operation, input: call.inputTokens, output: call.outputTokens },
      });
      if (now - this.pruned > DAY_MS / 24) {
        this.pruned = now;
        this.db().deleteBefore('ai_usage', 'at', new Date(now - this.retentionDays * DAY_MS).toISOString());
      }
    } catch (error) {
      // Accounting must never fail the call itself.
      logger.warn('could not record AI usage', { error });
    }
  }

  today(now = Date.now()): string {
    return dayKey(now, this.timezone());
  }

  /** Sums over `where` (a fixed SQL condition with ? placeholders). */
  sum(where: string, ...params: SqlValue[]): AiUsageTotals {
    return totalsOf(this.db().get<SumRow>(`SELECT ${SUMS} FROM ai_usage WHERE ${where}`, ...params));
  }

  workflowDay(workflowId: string, day = this.today()): AiUsageTotals {
    return this.sum('workflow_id = ? AND day = ?', workflowId, day);
  }

  agentDay(agentId: string, day = this.today()): AiUsageTotals {
    return this.sum('agent_id = ? AND day = ?', agentId, day);
  }

  agentMonth(agentId: string, day = this.today()): AiUsageTotals {
    return this.sum('agent_id = ? AND day >= ?', agentId, `${day.slice(0, 7)}-01`);
  }

  /** Totals, per model and per day, for one execution, workflow or agent (or everything) since `from` (a day key). */
  report(filter: {
    executionId?: string;
    workflowId?: string;
    agentId?: string;
    from?: string;
    to?: string;
    group?: 'workflow' | 'agent';
    /** Only usage of these workflows or agents (a member's view: the rows of neither are left out). */
    within?: { workflows: ReadonlySet<string>; agents: ReadonlySet<string> };
  }): AiUsageReport {
    const clauses: string[] = [];
    const params: SqlValue[] = [];
    const add = (sql: string, value: SqlValue | undefined) => {
      if (value === undefined || value === '') return;
      clauses.push(sql);
      params.push(value);
    };
    add('execution_id = ?', filter.executionId);
    add('workflow_id = ?', filter.workflowId);
    add('agent_id = ?', filter.agentId);
    add('day >= ?', filter.from);
    add('day <= ?', filter.to);
    if (filter.within) {
      const ors: string[] = [];
      for (const [column, ids] of [['workflow_id', filter.within.workflows], ['agent_id', filter.within.agents]] as const) {
        if (!ids.size) continue;
        ors.push(`${column} IN (${[...ids].map(() => '?').join(', ')})`);
        params.push(...ids);
      }
      clauses.push(ors.length ? `(${ors.join(' OR ')})` : '1 = 0');
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const db = this.db();
    const totals = totalsOf(db.get<SumRow>(`SELECT ${SUMS} FROM ai_usage ${where}`, ...params));
    const models = db
      .all<SumRow & { provider: string; model: string }>(`SELECT provider, model, ${SUMS} FROM ai_usage ${where} GROUP BY provider, model ORDER BY cost DESC, input DESC`, ...params)
      .map((row): AiModelUsage => ({ provider: row.provider, model: row.model, ...totalsOf(row) }));
    const days = db.all<SumRow & { day: string }>(`SELECT day, ${SUMS} FROM ai_usage ${where} GROUP BY day ORDER BY day`, ...params).map((row) => ({ day: row.day, ...totalsOf(row) }));
    const report: AiUsageReport = { totals, models, days };
    if (filter.group === 'workflow') {
      const grouped = clauses.length ? `${where} AND workflow_id IS NOT NULL` : 'WHERE workflow_id IS NOT NULL';
      report.workflows = db
        .all<SumRow & { workflow_id: string }>(`SELECT workflow_id, ${SUMS} FROM ai_usage ${grouped} GROUP BY workflow_id ORDER BY cost DESC`, ...params)
        .map((row) => ({ workflowId: row.workflow_id, ...totalsOf(row) }));
    }
    if (filter.group === 'agent') {
      const grouped = clauses.length ? `${where} AND agent_id IS NOT NULL` : 'WHERE agent_id IS NOT NULL';
      report.agents = db
        .all<SumRow & { agent_id: string }>(`SELECT agent_id, ${SUMS} FROM ai_usage ${grouped} GROUP BY agent_id ORDER BY cost DESC`, ...params)
        .map((row) => ({ agentId: row.agent_id, ...totalsOf(row) }));
    }
    if (filter.workflowId) report.today = this.workflowDay(filter.workflowId);
    if (filter.agentId) {
      report.today = this.agentDay(filter.agentId);
      report.month = this.agentMonth(filter.agentId);
    }
    return report;
  }
}

const holder = globalThis as { __landflowAiUsageMeter?: AiUsageMeter };

/** The process's meter, over the instance database. */
export function aiUsageMeter(): AiUsageMeter {
  return (holder.__landflowAiUsageMeter ??= new AiUsageMeter());
}

const tokensOf = (totals: AiUsageTotals) => totals.inputTokens + totals.outputTokens;

/** The limits of one cap set as scope limits: tokens and cost, per day and per month. */
function setLimits(set: UsageCapSet, subject: string, setIn: string, totals: (period: 'day' | 'month') => AiUsageTotals): UsageLimit[] {
  const limits: UsageLimit[] = [];
  for (const [period, label] of [['day', 'today'], ['month', 'this month']] as const) {
    const tokens = positive(set[period === 'day' ? 'dayTokens' : 'monthTokens']);
    const cost = positive(set[period === 'day' ? 'dayCost' : 'monthCost']);
    if (tokens) limits.push({ metric: 'tokens', max: tokens, subject: `${subject} ${label}`, setIn, used: () => tokensOf(totals(period)) });
    if (cost) limits.push({ metric: 'cost', max: cost, subject: `${subject} ${label}`, setIn, used: () => totals(period).cost });
  }
  return limits;
}
const positive = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0);

/** The caps of Workflow settings → AI usage limits, as scope limits. */
export function workflowLimits(scope: () => UsageScope, workflowId: string, settings: WorkflowSettings = {}, meter: AiUsageMeter = aiUsageMeter()): UsageLimit[] {
  const where = 'Workflow settings → AI usage limits';
  const limits: UsageLimit[] = [];
  const perRunTokens = positive(settings.aiMaxTokensPerExecution);
  const perRunCost = positive(settings.aiMaxCostPerExecution);
  const perDayTokens = positive(settings.aiMaxTokensPerDay);
  const perDayCost = positive(settings.aiMaxCostPerDay);
  if (perRunTokens) limits.push({ metric: 'tokens', max: perRunTokens, subject: 'this execution', setIn: where, used: () => tokensOf(scope().tree) });
  if (perRunCost) limits.push({ metric: 'cost', max: perRunCost, subject: 'this execution', setIn: where, used: () => scope().tree.cost });
  if (perDayTokens) limits.push({ metric: 'tokens', max: perDayTokens, subject: 'this workflow today', setIn: where, used: () => tokensOf(meter.workflowDay(workflowId)) });
  if (perDayCost) limits.push({ metric: 'cost', max: perDayCost, subject: 'this workflow today', setIn: where, used: () => meter.workflowDay(workflowId).cost });
  return limits;
}

/** The caps of Agent → Settings → Usage limits. */
export function agentLimits(agentId: string, name: string, settings: Partial<AgentSettings>, meter: AiUsageMeter = aiUsageMeter()): UsageLimit[] {
  const where = `Agent “${name}” → Settings → Usage limits`;
  const limits: UsageLimit[] = [];
  const dayTokens = positive(settings.dailyTokenLimit);
  const dayCost = positive(settings.dailyCostLimit);
  const monthCost = positive(settings.monthlyCostLimit);
  if (dayTokens) limits.push({ metric: 'tokens', max: dayTokens, subject: `agent “${name}” today`, setIn: where, used: () => tokensOf(meter.agentDay(agentId)) });
  if (dayCost) limits.push({ metric: 'cost', max: dayCost, subject: `agent “${name}” today`, setIn: where, used: () => meter.agentDay(agentId).cost });
  if (monthCost) limits.push({ metric: 'cost', max: monthCost, subject: `agent “${name}” this month`, setIn: where, used: () => meter.agentMonth(agentId).cost });
  return limits;
}

/** Open a scope for one execution segment (runner). `previous` is what earlier segments used. */
export function executionScope(
  info: { executionId: string; workflowId: string; settings?: WorkflowSettings; previous?: ExecutionAiUsage; userId?: string },
  meter: AiUsageMeter = aiUsageMeter(),
): UsageScope {
  let scope: UsageScope;
  const limits = workflowLimits(() => scope, info.workflowId, info.settings, meter);
  const parent = currentUsageScope();
  const { models, ...previousTotals } = info.previous ?? ({} as ExecutionAiUsage);
  const base = info.previous ? { totals: { ...EMPTY_USAGE, ...previousTotals }, models } : undefined;
  scope = new UsageScope({ executionId: info.executionId, workflowId: info.workflowId, ...(info.userId && { userId: info.userId }) }, limits, parent, parent ? undefined : meter, base);
  return scope;
}

/** Open a scope for one agent run (agents runtime). */
export function agentScope(info: { agentId: string; agentName: string; sessionId: string; settings: Partial<AgentSettings>; userId?: string }, meter: AiUsageMeter = aiUsageMeter()): UsageScope {
  const parent = currentUsageScope();
  return new UsageScope({ agentId: info.agentId, sessionId: info.sessionId, ...(info.userId && { userId: info.userId }) }, agentLimits(info.agentId, info.agentName, info.settings, meter), parent, parent ? undefined : meter);
}

export { runInUsageScope };

/** What the scope's execution used, for ExecutionRecord.aiUsage (absent when no model was called). */
export function executionUsage(scope: UsageScope): ExecutionAiUsage | undefined {
  if (!scope.own.calls) return undefined;
  const round = (cost: number) => Math.round(cost * 1e8) / 1e8;
  return { ...scope.own, cost: round(scope.own.cost), models: scope.modelTotals().map((m) => ({ ...m, cost: round(m.cost) })) };
}
