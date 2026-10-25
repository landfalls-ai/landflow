/**
 * Fires Schedule triggers of active workflows and starts the poller. Single-process; leader election is out of scope.
 *
 * A Schedule node either has n8n's Trigger Rules (`unit: 'rules'`, `rule.interval[]`: every N seconds,
 * minutes, hours at a minute, days / weeks / months at a time of day, or a cron expression), checked every
 * second in the workflow's time zone (`settings.timezone`, else the host's), with a catch-up for seconds a
 * late tick skipped; or the older `every` + `unit` (seconds / minutes / hours), counted from activation.
 */
import type { JsonObject } from '@landflow/protocol';
import type { Workflow, WorkflowNode } from '@landflow/engine';
import { parseCron, timeParts, type TimeParts } from './agents/cron';
import { registry } from './plugins/registry';
import { poller } from './poller';
import { runWorkflow } from './runner';
import { instanceTimezone } from './settings';
import { singleton } from './singleton';
import { store } from './store';
import { fireTrigger, logger, recordScheduleLag } from './telemetry';

const UNIT_MS = { seconds: 1_000, minutes: 60_000, hours: 3_600_000 } as const;
/** How far back a tick looks for seconds it missed (a busy event loop, a laptop waking up). */
const CATCH_UP_SECONDS = 60;
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** One of n8n's Trigger Rules (`rule.interval[]`). */
export interface IntervalRule {
  field?: string;
  secondsInterval?: number;
  minutesInterval?: number;
  hoursInterval?: number;
  daysInterval?: number;
  weeksInterval?: number;
  monthsInterval?: number;
  triggerAtDay?: unknown;
  triggerAtDayOfMonth?: number;
  triggerAtHour?: number;
  triggerAtMinute?: number;
  expression?: string;
}

const DEFAULT_RULE: IntervalRule = { field: 'days', daysInterval: 1, triggerAtHour: 9, triggerAtMinute: 0 };

/** The host's IANA time zone. */
export const hostTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

/** The zone a workflow's schedules run in. */
export const scheduleTimeZone = (workflow: Pick<Workflow, 'settings'>) => workflow.settings?.timezone?.trim() || instanceTimezone();

/** A Schedule node still on `every` + `unit` (seconds / minutes / hours from activation). */
export function isLegacySchedule(parameters: Record<string, unknown>): boolean {
  if (typeof parameters.unit === 'string') return parameters.unit in UNIT_MS;
  return parameters.rule === undefined && parameters.every !== undefined;
}

const whole = (value: unknown, fallback: number, min: number, max = Number.MAX_SAFE_INTEGER) => {
  const n = Math.floor(Number(value ?? fallback));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

/** Week number since the epoch, weeks starting on Sunday (for "every N weeks"). */
const weekIndex = (t: TimeParts) => Math.floor((Date.UTC(t.year ?? 1970, t.month - 1, t.day) / 86_400_000 + 4) / 7);

/** Whether a rule fires in the second of `t` (wall-clock parts in the schedule's zone). Throws on an invalid cron. */
export function ruleMatcher(rule: IntervalRule): (t: TimeParts) => boolean {
  const field = rule.field ?? 'days';
  const minute = whole(rule.triggerAtMinute, 0, 0, 59);
  const hour = whole(rule.triggerAtHour, 0, 0, 23);
  const at = (t: TimeParts) => (t.second ?? 0) === 0 && t.minute === minute && t.hour === hour;
  switch (field) {
    case 'seconds': {
      const n = whole(rule.secondsInterval, 30, 1);
      return (t) => (t.second ?? 0) % n === 0;
    }
    case 'minutes': {
      const n = whole(rule.minutesInterval, 5, 1);
      return (t) => (t.second ?? 0) === 0 && t.minute % n === 0;
    }
    case 'hours': {
      const n = whole(rule.hoursInterval, 1, 1);
      return (t) => (t.second ?? 0) === 0 && t.minute === minute && t.hour % n === 0;
    }
    case 'days': {
      // Like cron's "*/N" on the day of the month: the 1st, then every N days.
      const n = whole(rule.daysInterval, 1, 1);
      return (t) => at(t) && (t.day - 1) % n === 0;
    }
    case 'weeks': {
      const n = whole(rule.weeksInterval, 1, 1);
      const raw = Array.isArray(rule.triggerAtDay) ? rule.triggerAtDay : rule.triggerAtDay === undefined ? [1] : [rule.triggerAtDay];
      const days = new Set(raw.map((d) => Number(d) % 7));
      return (t) => at(t) && days.has(t.weekday) && weekIndex(t) % n === 0;
    }
    case 'months': {
      const n = whole(rule.monthsInterval, 1, 1);
      const day = whole(rule.triggerAtDayOfMonth, 1, 1, 31);
      return (t) => at(t) && t.day === day && (t.month - 1) % n === 0;
    }
    case 'cronExpression': {
      const cron = parseCron(String(rule.expression ?? ''));
      // Five fields fire at second 0 of each matching minute.
      return (t) => cron.matches(t) && (cron.seconds || (t.second ?? 0) === 0);
    }
    default:
      throw new Error(`Unknown trigger interval "${field}"`);
  }
}

/** The rules of a Schedule node as one matcher: it fires when any rule does. */
export function scheduleMatcher(parameters: Record<string, unknown>): (t: TimeParts) => boolean {
  const raw = (parameters.rule as { interval?: IntervalRule[] } | undefined)?.interval;
  const rules = (Array.isArray(raw) && raw.length ? raw : [DEFAULT_RULE]).map(ruleMatcher);
  return (t) => rules.some((matches) => matches(t));
}

/** The item a rule-based run starts with (n8n's Schedule Trigger fields, plus `scheduledAt`). */
export function scheduleItem(at: Date, timeZone: string): JsonObject {
  const t = timeParts(at, timeZone);
  const two = (n: number | undefined) => String(n ?? 0).padStart(2, '0');
  return {
    scheduledAt: at.toISOString(),
    timestamp: at.toISOString(),
    'Day of week': WEEKDAY_NAMES[t.weekday],
    Year: String(t.year),
    Month: MONTH_NAMES[t.month - 1],
    'Day of month': two(t.day),
    Hour: two(t.hour),
    Minute: two(t.minute),
    Second: two(t.second),
    Timezone: timeZone,
  };
}

export const scheduler = singleton('scheduler', () => {
  /** Legacy schedules: when each last ran (ms). */
  const lastRun = new Map<string, number>();
  /** Rule schedules: the last second checked. */
  const checked = new Map<string, number>();
  const inFlight = new Set<string>();
  const warned = new Set<string>();
  let timer: NodeJS.Timeout | undefined;

  function fire(workflow: Workflow, node: WorkflowNode, key: string, item: JsonObject) {
    inFlight.add(key);
    // Each scheduled run is its own trace: trigger.fire → workflow.execute → …
    void fireTrigger({ source: 'schedule', workflowId: workflow.id, nodeName: node.name }, () =>
      runWorkflow({ workflow, mode: 'trigger', startNodeId: node.id, triggerItems: [{ json: item }] }),
    )
      .catch((error) => logger.warn('scheduled run failed', { 'landflow.workflow.id': workflow.id, 'landflow.workflow.name': workflow.name, error: (error as Error).message }))
      .finally(() => inFlight.delete(key));
  }

  function legacy(workflow: Workflow, node: WorkflowNode, key: string, now: number) {
    const every = Math.max(1, Number(node.parameters.every ?? 5));
    const unit = UNIT_MS[(node.parameters.unit as keyof typeof UNIT_MS) ?? 'minutes'] ?? UNIT_MS.minutes;
    const interval = Math.max(5_000, every * unit);
    const last = lastRun.get(key);
    if (last === undefined) {
      lastRun.set(key, now); // first sighting: wait one full interval
      return;
    }
    if (now - last < interval || inFlight.has(key)) return;
    lastRun.set(key, now);
    recordScheduleLag(workflow.id, now - (last + interval));
    fire(workflow, node, key, { scheduledAt: new Date(now).toISOString() });
  }

  function rules(workflow: Workflow, node: WorkflowNode, key: string, now: number) {
    const second = Math.floor(now / 1000);
    // First sighting: start with the current second.
    const from = Math.max((checked.get(key) ?? second - 1) + 1, second - CATCH_UP_SECONDS);
    checked.set(key, second);
    let matches: (t: TimeParts) => boolean;
    try {
      matches = scheduleMatcher(node.parameters);
    } catch (error) {
      const signature = `${key}:${JSON.stringify(node.parameters.rule)}`;
      if (!warned.has(signature)) {
        warned.add(signature);
        logger.warn('invalid schedule rule', { 'landflow.workflow.id': workflow.id, 'landflow.node.name': node.name, error: (error as Error).message });
      }
      return;
    }
    const zone = scheduleTimeZone(workflow);
    let due: number | undefined;
    for (let s = from; s <= second; s++) if (matches(timeParts(new Date(s * 1000), zone))) due = s;
    if (due === undefined || inFlight.has(key)) return;
    recordScheduleLag(workflow.id, now - due * 1000);
    fire(workflow, node, key, scheduleItem(new Date(due * 1000), zone));
  }

  /** One check of every active Schedule node (`now` for tests). */
  function tick(now = Date.now()) {
    const seen = new Set<string>();
    for (const workflow of store.listWorkflows()) {
      if (!workflow.active) continue;
      for (const node of workflow.nodes) {
        if (node.disabled || node.type !== 'core.schedule') continue;
        const key = `${workflow.id}:${node.id}`;
        seen.add(key);
        if (isLegacySchedule(node.parameters)) legacy(workflow, node, key, now);
        else rules(workflow, node, key, now);
      }
    }
    // Forget deactivated schedules, so re-activating starts afresh.
    for (const key of [...lastRun.keys()]) if (!seen.has(key)) lastRun.delete(key);
    for (const key of [...checked.keys()]) if (!seen.has(key)) checked.delete(key);
  }

  return {
    start() {
      if (timer) return;
      void registry; // ensure the registry singleton exists before the first tick
      timer = setInterval(() => tick(), 1_000);
      timer.unref?.();
      poller.start();
    },
    tick,
  };
});
