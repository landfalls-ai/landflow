/**
 * Failure alerts: the runner hands every run that failed for good to `notifyFailure` (next to the error workflow),
 * which checks the rules and sends through their channels. A rule's throttle allows one alert per workflow per
 * window; the alerts it holds back go out as one digest when the window ends, and a new window starts if there were
 * any (so a workflow failing every minute sends one message per window, not sixty). A ticker (every 30 s) sends due
 * digests and alerts on runs that have been waiting too long (once per run and rule).
 *
 * A channel gets one message per run even when several rules match. Sending never fails the run: errors are logged
 * and shown on the channel (its last delivery).
 */
import type { Workflow } from '@landflow/engine';
import type { AlertDelivery, AlertEvent, AlertRule } from '../../shared/alerts';
import type { ExecutionRecord } from '../../shared/types';
import { singleton } from '../singleton';
import { store } from '../store';
import { logger } from '../telemetry';
import { sendThrough } from './channels';
import { digestNotice, noticeFor, testNotice, type AlertNotice } from './message';
import { eventsOf, headlineEvent, matchingEvents, waitedTooLong, watches } from './rules';
import { AlertError, alertStore } from './store';

const TICK_MS = 30_000;

export const alerts = singleton('alerts', () => {
  let timer: ReturnType<typeof setInterval> | undefined;
  let ticking: Promise<void> | undefined;

  /** Send through a rule's channels (skipping those in `skip`, which collects the ones used). */
  async function dispatch(rule: AlertRule, notice: AlertNotice, skip = new Set<string>()): Promise<void> {
    for (const channelId of rule.channelIds) {
      if (skip.has(channelId)) continue;
      skip.add(channelId);
      await deliver(channelId, notice);
    }
  }

  async function deliver(channelId: string, notice: AlertNotice): Promise<AlertDelivery> {
    const attrs = { 'landflow.alert.channel': channelId, 'landflow.alert.event': notice.event, 'landflow.workflow.id': notice.workflow.id };
    let delivery: AlertDelivery;
    try {
      const channel = alertStore.channelForSending(channelId);
      if (!channel) return { at: new Date().toISOString(), ok: false, message: 'Channel not found' };
      delivery = { at: new Date().toISOString(), ok: true, message: await sendThrough(channel, notice) };
      logger.info('alert sent', { ...attrs, 'landflow.alert.kind': channel.kind });
    } catch (error) {
      delivery = { at: new Date().toISOString(), ok: false, message: (error as Error).message.slice(0, 500) };
      logger.warn('alert not sent', { ...attrs, error: delivery.message });
    }
    alertStore.recordDelivery(channelId, delivery);
    return delivery;
  }

  /**
   * Whether the rule's throttle holds this alert back (and counts it for the digest). Otherwise a window starts now.
   */
  function heldBack(rule: AlertRule, workflowId: string, notice: AlertNotice, now: number): boolean {
    if (!(rule.throttleMinutes > 0)) return false;
    const window = alertStore.throttle(rule.id, workflowId);
    if (window && Date.parse(window.windowUntil) > now) {
      alertStore.setThrottle(rule.id, workflowId, {
        ...window,
        suppressed: window.suppressed + 1,
        data: { ...window.data, workflowName: notice.workflow.name, last: { executionId: notice.execution?.id, error: notice.execution?.error, node: notice.execution?.node, event: notice.event, at: notice.at } },
      });
      return true;
    }
    alertStore.setThrottle(rule.id, workflowId, {
      windowUntil: new Date(now + rule.throttleMinutes * 60_000).toISOString(),
      suppressed: 0,
      data: { workflowName: notice.workflow.name, since: new Date(now).toISOString(), minutes: rule.throttleMinutes },
    });
    return false;
  }

  /** Alert on one event of one run, for each rule that matches, each channel once. */
  async function alertRun(record: ExecutionRecord, rules: { rule: AlertRule; event: AlertEvent }[], now: number) {
    const used = new Set<string>();
    for (const { rule, event } of rules) {
      const notice = noticeFor(rule, event, record);
      if (heldBack(rule, record.workflowId, notice, now)) continue;
      await dispatch(rule, notice, used);
    }
  }

  /** Send the digests of windows that ended; a window that held something back is followed by a new one. */
  async function sendDigests(now: number) {
    for (const window of alertStore.endedThrottles(now)) {
      const rule = alertStore.rule(window.ruleId);
      if (!rule || !rule.enabled || window.suppressed <= 0) {
        alertStore.clearThrottle(window.ruleId, window.workflowId);
        continue;
      }
      const minutes = Math.max(1, Math.round((now - Date.parse(window.data.since)) / 60_000));
      const notice = digestNotice(rule, { id: window.workflowId, name: window.data.workflowName }, {
        count: window.suppressed,
        minutes,
        since: window.data.since,
        event: window.data.last?.event,
        lastError: window.data.last?.error,
        lastExecutionId: window.data.last?.executionId,
      });
      alertStore.setThrottle(rule.id, window.workflowId, {
        windowUntil: new Date(now + rule.throttleMinutes * 60_000).toISOString(),
        suppressed: 0,
        data: { workflowName: window.data.workflowName, since: new Date(now).toISOString(), minutes: rule.throttleMinutes },
      });
      await dispatch(rule, notice);
    }
  }

  /** Alert on runs waiting longer than a rule allows, once per run and rule. */
  async function checkWaiting(now: number) {
    const rules = alertStore.rules().filter((rule) => rule.enabled && rule.events.includes('waiting') && rule.channelIds.length);
    const waiting = store.waitingExecutions();
    alertStore.pruneWaitingSent(new Set(waiting.map((record) => record.executionId)));
    if (!rules.length) return;
    for (const record of waiting) {
      const due = rules.filter((rule) => watches(rule, record, store.getWorkflow(record.workflowId)) && waitedTooLong(rule, record, now) && alertStore.markWaitingSent(rule.id, record.executionId));
      if (due.length) await alertRun(record, due.map((rule) => ({ rule, event: 'waiting' as const })), now);
    }
  }

  async function tick(now = Date.now()) {
    if (ticking) return ticking;
    ticking = (async () => {
      try {
        await sendDigests(now);
        await checkWaiting(now);
      } catch (error) {
        logger.warn('alert check failed', { error: (error as Error).message });
      } finally {
        ticking = undefined;
      }
    })();
    return ticking;
  }

  return {
    /** Run the ticker (bootstrap). */
    start() {
      if (timer) return;
      timer = setInterval(() => void tick(), TICK_MS);
      timer.unref?.();
    },

    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },

    /** Send due digests and waiting alerts now (the ticker's work; tests call it with a clock). */
    tick,

    /** A run finished: alert on it if it failed for good and a rule watches it. */
    async finished(record: ExecutionRecord, workflow?: Workflow, now = Date.now()): Promise<void> {
      const events = eventsOf(record);
      if (!events.length) return;
      const matched = alertStore
        .rules()
        .filter((rule) => watches(rule, record, workflow ?? store.getWorkflow(record.workflowId)))
        .map((rule) => ({ rule, events: matchingEvents(rule, events) }))
        .filter(({ events }) => events.length);
      if (!matched.length) return;
      await alertRun(record, matched.map(({ rule, events }) => ({ rule, event: headlineEvent(events) })), now);
    },

    /** Send a test alert through a saved channel. */
    async test(channelId: string): Promise<AlertDelivery> {
      if (!alertStore.channel(channelId)) throw new AlertError('Alert channel not found', 404);
      return deliver(channelId, testNotice());
    },
  };
});

/** The runner's hook: alert on a failed run in the background (never throws). */
export function notifyFailure(record: ExecutionRecord, workflow?: Workflow): void {
  void alerts.finished(record, workflow).catch((error) => logger.warn('failure alerts skipped', { 'landflow.execution.id': record.executionId, error: (error as Error).message }));
}

