/**
 * Cost alerts: a rule of kind `cost` alerts once per period (day or month) when AI usage reaches its threshold (default
 * 80%) of any cap that has a period: a workflow's daily caps (Workflow settings), an agent's daily and monthly caps
 * (Agent → Abilities → Guardrails), and the caps per credential and per user (Settings → AI caps). The alert goes out before the
 * cap stops anything, through the rule's channels. Per-execution caps have no period and are not watched.
 *
 * The alert service's ticker calls `checkCosts` (on the leader in queue mode, where the model calls happen on workers);
 * a process that runs the service also checks soon after each model call it records (`noteUsage`), so a run that burns
 * through a cap within seconds is still warned.
 */
import { DEFAULT_COST_THRESHOLD_PERCENT, type AlertRule } from '../../shared/alerts';
import type { UsageCapSet } from '../../shared/ai-usage';
import { formatCost, formatTokens } from '../../shared/ai-usage';
import { agentStore } from '../agents/store';
import { getUser } from '../auth/users';
import { customNotice, publicUrl, type AlertNotice } from '../alerts/message';
import { alertStore } from '../alerts/store';
import { store } from '../store';
// Load-bearing: importing budgets/enforce registers the stop's audit and log (onStopOpened) as a side effect.
import { sweepBudgets } from '../budgets/enforce';
import { getBudget, listBudgets } from '../budgets/store';
import { getProject } from '../projects/store';
import { projectCapId } from '../../shared/project-budget';
import { aiUsageMeter, type AiUsageMeter } from './index';
import { amountOf, baselineSentence, flagHref, listFlags, noteAlerted, type SpendFlag } from './spend-flags'; // SP23:

/** One cap with a period, and what it has used in the current one. */
export interface WatchedCap {
  /** Stable, e.g. `workflow:wf_1:day:cost`. */
  id: string;
  /** "workflow “Orders”", "credential “OpenAI prod”". */
  subject: string;
  period: 'day' | 'month';
  metric: 'tokens' | 'cost';
  max: number;
  used: number;
  /** Where it is set. */
  setIn: string;
  /** The page that shows it. */
  link: string;
}

const positive = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0);

function fromSet(set: UsageCapSet, prefix: string, subject: string, setIn: string, link: string, totals: (period: 'day' | 'month') => { inputTokens: number; outputTokens: number; cost: number }): WatchedCap[] {
  const caps: WatchedCap[] = [];
  for (const period of ['day', 'month'] as const) {
    const tokens = positive(set[period === 'day' ? 'dayTokens' : 'monthTokens']);
    const cost = positive(set[period === 'day' ? 'dayCost' : 'monthCost']);
    const used = totals(period);
    if (tokens) caps.push({ id: `${prefix}:${period}:tokens`, subject, period, metric: 'tokens', max: tokens, used: used.inputTokens + used.outputTokens, setIn, link });
    if (cost) caps.push({ id: `${prefix}:${period}:cost`, subject, period, metric: 'cost', max: cost, used: used.cost, setIn, link });
  }
  return caps;
}

/** One person's own user caps (their own set, or the default for everyone), even before their first call; nothing else is built. */
export function userCaps(userId: string, meter: AiUsageMeter = aiUsageMeter()): WatchedCap[] {
  const configured = meter.caps();
  const settingsLink = `${publicUrl()}/settings#ai-caps`;
  const totals = (period: 'day' | 'month') => meter.sinceTotals('user_id', userId, period);
  const own = configured.users[userId];
  if (own) return fromSet(own, `user:${userId}`, `user “${own.name || userId}”`, 'Settings → AI caps', settingsLink, totals);
  if (configured.allUsers) return fromSet(configured.allUsers, `user:${userId}`, `user “${userName(userId)}” (the cap for every user)`, 'Settings → AI caps', settingsLink, totals);
  return [];
}

/** Every cap with a period that is set now, with its current usage. */
export function watchedCaps(meter: AiUsageMeter = aiUsageMeter()): WatchedCap[] {
  const caps: WatchedCap[] = [];
  const base = publicUrl();
  for (const workflow of store.listWorkflows()) {
    const settings = workflow.settings ?? {};
    const perDay: UsageCapSet = { dayTokens: positive(settings.aiMaxTokensPerDay), dayCost: positive(settings.aiMaxCostPerDay) };
    caps.push(...fromSet(perDay, `workflow:${workflow.id}`, `workflow “${workflow.name}”`, 'Workflow settings → AI usage limits', `${base}/workflows/${workflow.id}`, (period) => (period === 'day' ? meter.workflowDay(workflow.id) : { inputTokens: 0, outputTokens: 0, cost: 0 })));
  }
  for (const agent of agentStore.list()) {
    const settings = agent.published?.config.settings ?? agent.settings;
    const set: UsageCapSet = { dayTokens: positive(settings?.dailyTokenLimit), dayCost: positive(settings?.dailyCostLimit), monthCost: positive(settings?.monthlyCostLimit) };
    caps.push(...fromSet(set, `agent:${agent.id}`, `agent “${agent.name}”`, `Agent “${agent.name}” → Abilities → Guardrails`, `${base}/agents/${agent.id}?tab=settings`, (period) => (period === 'day' ? meter.agentDay(agent.id) : meter.agentMonth(agent.id))));
  }
  const configured = meter.caps();
  const settingsLink = `${base}/settings#ai-caps`;
  for (const [id, set] of Object.entries(configured.credentials)) {
    caps.push(...fromSet(set, `credential:${id}`, `credential “${set.name || id}”`, 'Settings → AI caps', settingsLink, (period) => meter.sinceTotals('credential_id', id, period)));
  }
  for (const [id, set] of Object.entries(configured.users)) {
    caps.push(...fromSet(set, `user:${id}`, `user “${set.name || id}”`, 'Settings → AI caps', settingsLink, (period) => meter.sinceTotals('user_id', id, period)));
  }
  if (configured.allUsers) {
    // The default for every user without a set of their own: one cap per user who has used AI this month.
    const first = `${meter.today().slice(0, 7)}-01`;
    for (const id of meter.usersSince(first)) {
      if (configured.users[id]) continue;
      caps.push(...fromSet(configured.allUsers, `user:${id}`, `user “${userName(id)}” (the cap for every user)`, 'Settings → AI caps', settingsLink, (period) => meter.sinceTotals('user_id', id, period)));
    }
  }
  // PC14: a project's monthly budget is one more cap, so the cost alerts, Insights → AI and "Ask for more" see it like the others.
  for (const budget of listBudgets()) {
    const project = getProject(budget.projectId);
    if (!project) continue;
    const link = `${base}/projects/${encodeURIComponent(project.id)}?tab=settings#budget`;
    caps.push({ id: projectCapId(project.id), subject: `project “${project.name}”`, period: 'month', metric: 'cost', max: budget.monthlyUsd, used: meter.sinceTotals('project_id', project.id, 'month').cost, setIn: `Project “${project.name}” → Settings → AI budget`, link });
  }
  return caps;
}

function userName(id: string): string {
  return getUser(id)?.name || getUser(id)?.email || id;
}

const amount = (cap: WatchedCap, value: number) => (cap.metric === 'cost' ? formatCost(value) : `${formatTokens(Math.round(value))} tokens`);

/** The period a cap's usage belongs to now (`2026-10-27` or `2026-10`), so an alert is sent once for each. */
export const periodKey = (period: 'day' | 'month', today: string) => (period === 'day' ? today : today.slice(0, 7));

/** What happens when a cap is reached: a project's budget only refuses priced calls, and only with its hard stop on. */
function atFull(cap: WatchedCap): string {
  if (!/^project:[^:]+:month:cost$/.test(cap.id)) return 'Further model calls are refused with a clear error until the period ends or the cap is raised';
  const budget = getBudget(cap.id.split(':')[1]);
  return budget?.hardStop
    ? 'Priced model calls are refused until the month ends or the budget is raised or resumed; local (unpriced) models keep running'
    : 'Calls keep running; the project’s admins are told';
}

/** What the alert says about one cap. */
export function costNotice(rule: Pick<AlertRule, 'id' | 'name'>, cap: WatchedCap, threshold: number): AlertNotice {
  const percent = Math.floor((cap.used / cap.max) * 100);
  return customNotice({
    event: 'costThreshold',
    rule,
    about: { id: cap.id, name: `AI usage: ${cap.subject}` },
    subject: `AI cost: ${cap.subject} used ${percent}% of its ${cap.period === 'day' ? 'daily' : 'monthly'} ${cap.metric === 'cost' ? 'cost' : 'token'} cap`,
    facts: [
      { label: 'Cap', value: `${cap.subject}, ${amount(cap, cap.max)} per ${cap.period}` },
      { label: 'Used', value: `${amount(cap, cap.used)} of ${amount(cap, cap.max)} (${percent}%)` },
      { label: 'Alert at', value: `${threshold}% of a cap, once per ${cap.period}` },
      { label: 'Set in', value: cap.setIn },
      { label: 'What happens at 100%', value: atFull(cap) },
    ],
    link: cap.link,
  });
}

type Send = (rule: AlertRule, notice: AlertNotice) => Promise<void>;

// SP23: forecasts over a cap and unusual spend, from the flags `anomalies.ts` stores (docs/llm-gateway.md#forecasts-and-unusual-spend).

const LANDLEDGER_SENTENCE = 'Landflow flags this too; Landledger flags agent and model spikes as well, in its console and webhooks';
const DAY_MS = 86_400_000;

/** What the alert says about one flag: the figure, the baseline, the score, the distinct runs, and an Open link to the AI page at the day. */
export function spendNotice(rule: Pick<AlertRule, 'id' | 'name'>, flag: SpendFlag, today: string): AlertNotice {
  const link = `${publicUrl()}${flagHref(flag, today)}`;
  if (flag.kind === 'forecast') {
    return customNotice({
      event: 'costForecast',
      rule,
      about: { id: flag.key, name: `AI usage: ${flag.label}` },
      subject: `AI cost: ${flag.label} is forecast to reach its monthly ${flag.metric === 'cost' ? 'cost' : 'token'} cap${flag.reachesOn ? ` around ${flag.reachesOn}` : ''}`,
      facts: [
        { label: 'Cap', value: `${flag.label}, ${amountOf(flag.metric, flag.capMax ?? 0)} per month` },
        { label: 'So far this month', value: amountOf(flag.metric, flag.value) },
        { label: 'Forecast for the month', value: `${amountOf(flag.metric, flag.p50 ?? 0)} (the middle of the forecast)` },
        ...(flag.reachesOn ? [{ label: 'Reaches the cap around', value: flag.reachesOn }] : []),
        { label: 'What happens', value: 'Nothing yet: this is a heads-up before the cap. Raise the cap or slow the work down' },
      ],
      link,
    });
  }
  const agentOrModel = flag.dimension === 'agent' || flag.dimension === 'model';
  return customNotice({
    event: 'spendAnomaly',
    rule,
    about: { id: flag.key, name: `AI usage: ${flag.label}` },
    subject: `Unusual AI spend: ${flag.label} used ${amountOf(flag.metric, flag.value)} on ${flag.day}`,
    facts: [
      { label: 'Spent', value: `${amountOf(flag.metric, flag.value)} on ${flag.day}${flag.day === today ? ' so far' : ''}` },
      { label: 'Baseline', value: baselineSentence(flag) },
      { label: 'Score', value: flag.score ? `${flag.score} (3.5 or more is unusual)` : 'No score: the baseline was flat, so a big enough jump counts' },
      { label: 'Runs', value: String(flag.runs) },
      ...(flag.surfaces.length ? [{ label: 'Made up of', value: flag.surfaces.join(', ') }] : []),
      ...(agentOrModel ? [{ label: 'Also', value: LANDLEDGER_SENTENCE }] : []),
    ],
    link,
  });
}

/** Alert once per cap and month on a forecast over the cap, and once per dimension, key and day on unusual spend (again when the day's value doubles). */
async function checkSpendFlags(rule: AlertRule, now: number, today: string, send: Send): Promise<void> {
  const cost = rule.cost;
  if (cost?.forecast !== false) {
    for (const flag of listFlags('forecast', `${today.slice(0, 7)}-01`)) {
      if (flag.acknowledgedAt) continue;
      const key = `forecast:${flag.key}:${flag.day.slice(0, 7)}`;
      if (alertStore.state(rule.id, key)) continue;
      alertStore.setState(rule.id, key, { value: flag.value, at: new Date(now).toISOString() }, new Date(now + 33 * DAY_MS).toISOString());
      noteAlerted(flag.id, flag.value);
      await send(rule, spendNotice(rule, flag, today));
    }
  }
  if (cost?.anomalies !== false) {
    const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - DAY_MS).toISOString().slice(0, 10);
    for (const flag of listFlags('anomaly', yesterday)) {
      if (flag.acknowledgedAt) continue;
      // Landledger flags agent and model spikes in its own console and webhooks: with the option on, those two stay out of the channels (Needs you and the inbox still show them).
      if (cost?.landledgerHandlesAgentModel && (flag.dimension === 'agent' || flag.dimension === 'model')) continue;
      const key = `anomaly:${flag.dimension}:${flag.key}:${flag.day}`;
      const sent = alertStore.state<{ value: number }>(rule.id, key);
      if (sent && !(flag.value >= 2 * Number(sent.data.value))) continue;
      alertStore.setState(rule.id, key, { value: flag.value, at: new Date(now).toISOString() }, new Date(now + 3 * DAY_MS).toISOString());
      noteAlerted(flag.id, flag.value);
      await send(rule, spendNotice(rule, flag, today));
    }
  }
}

/** Alert, once per period, on every cap that reached a cost rule's threshold. */
export async function checkCosts(now: number, send: Send, meter: AiUsageMeter = aiUsageMeter()): Promise<void> {
  const rules = alertStore.rules().filter((rule) => rule.kind === 'cost' && rule.enabled && rule.channelIds.length);
  if (!rules.length) return;
  const caps = watchedCaps(meter);
  const today = meter.today(now);
  for (const rule of rules) {
    const threshold = rule.cost?.thresholdPercent ?? DEFAULT_COST_THRESHOLD_PERCENT;
    // SP23: the forecast and unusual-spend states lapse the same way.
    for (const prefix of ['cost:', 'forecast:', 'anomaly:']) {
      for (const state of alertStore.states(rule.id, prefix)) {
        if (state.expiresAt && Date.parse(state.expiresAt) <= now) alertStore.clearState(rule.id, state.key);
      }
    }
    for (const cap of caps) {
      if (!(cap.used > 0) || (cap.used / cap.max) * 100 < threshold) continue;
      const key = `cost:${cap.id}:${periodKey(cap.period, today)}`;
      if (alertStore.state(rule.id, key)) continue;
      // Remembered for the rest of the period (and a day more, as the time zone may differ a little).
      alertStore.setState(rule.id, key, { used: cap.used, max: cap.max, at: new Date(now).toISOString() }, new Date(now + (cap.period === 'day' ? 2 : 33) * 86_400_000).toISOString());
      await send(rule, costNotice(rule, cap, threshold));
    }
    await checkSpendFlags(rule, now, today, send); // SP23:
  }
}

/** PC14: open the warnings and stops the month's spend of each project budget calls for (the alert service's ticker calls it; ../budgets/enforce.ts). */
export const sweepProjectBudgets = (now: number, meter: AiUsageMeter = aiUsageMeter()): Promise<void> => sweepBudgets(now, meter);
