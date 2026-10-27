/**
 * Cost alerts: a rule of kind `cost` alerts once per period (day or month) when AI usage reaches its threshold (default
 * 80%) of any cap that has a period: a workflow's daily caps (Workflow settings), an agent's daily and monthly caps
 * (Agent → Settings), and the caps per credential and per user (Settings → AI prices). The alert goes out before the
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
import { aiUsageMeter, type AiUsageMeter } from './index';

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
    caps.push(...fromSet(set, `agent:${agent.id}`, `agent “${agent.name}”`, `Agent “${agent.name}” → Settings → Usage limits`, `${base}/agents/${agent.id}`, (period) => (period === 'day' ? meter.agentDay(agent.id) : meter.agentMonth(agent.id))));
  }
  const configured = meter.caps();
  const settingsLink = `${base}/settings#ai-prices`;
  for (const [id, set] of Object.entries(configured.credentials)) {
    caps.push(...fromSet(set, `credential:${id}`, `credential “${set.name || id}”`, 'Settings → AI prices → AI usage caps', settingsLink, (period) => meter.sinceTotals('credential_id', id, period)));
  }
  for (const [id, set] of Object.entries(configured.users)) {
    caps.push(...fromSet(set, `user:${id}`, `user “${set.name || id}”`, 'Settings → AI prices → AI usage caps', settingsLink, (period) => meter.sinceTotals('user_id', id, period)));
  }
  if (configured.allUsers) {
    // The default for every user without a set of their own: one cap per user who has used AI this month.
    const first = `${meter.today().slice(0, 7)}-01`;
    for (const id of meter.usersSince(first)) {
      if (configured.users[id]) continue;
      caps.push(...fromSet(configured.allUsers, `user:${id}`, `user “${userName(id)}” (the cap for every user)`, 'Settings → AI prices → AI usage caps', settingsLink, (period) => meter.sinceTotals('user_id', id, period)));
    }
  }
  return caps;
}

function userName(id: string): string {
  return getUser(id)?.name || getUser(id)?.email || id;
}

const amount = (cap: WatchedCap, value: number) => (cap.metric === 'cost' ? formatCost(value) : `${formatTokens(Math.round(value))} tokens`);

/** The period a cap's usage belongs to now (`2026-10-27` or `2026-10`), so an alert is sent once for each. */
export const periodKey = (period: 'day' | 'month', today: string) => (period === 'day' ? today : today.slice(0, 7));

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
      { label: 'What happens at 100%', value: 'Further model calls are refused with a clear error until the period ends or the cap is raised' },
    ],
    link: cap.link,
  });
}

type Send = (rule: AlertRule, notice: AlertNotice) => Promise<void>;

/** Alert, once per period, on every cap that reached a cost rule's threshold. */
export async function checkCosts(now: number, send: Send, meter: AiUsageMeter = aiUsageMeter()): Promise<void> {
  const rules = alertStore.rules().filter((rule) => rule.kind === 'cost' && rule.enabled && rule.channelIds.length);
  if (!rules.length) return;
  const caps = watchedCaps(meter);
  const today = meter.today(now);
  for (const rule of rules) {
    const threshold = rule.cost?.thresholdPercent ?? DEFAULT_COST_THRESHOLD_PERCENT;
    for (const state of alertStore.states(rule.id, 'cost:')) {
      if (state.expiresAt && Date.parse(state.expiresAt) <= now) alertStore.clearState(rule.id, state.key);
    }
    for (const cap of caps) {
      if (!(cap.used > 0) || (cap.used / cap.max) * 100 < threshold) continue;
      const key = `cost:${cap.id}:${periodKey(cap.period, today)}`;
      if (alertStore.state(rule.id, key)) continue;
      // Remembered for the rest of the period (and a day more, as the time zone may differ a little).
      alertStore.setState(rule.id, key, { used: cap.used, max: cap.max, at: new Date(now).toISOString() }, new Date(now + (cap.period === 'day' ? 2 : 33) * 86_400_000).toISOString());
      await send(rule, costNotice(rule, cap, threshold));
    }
  }
}
