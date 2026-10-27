/**
 * The time-based alert rules, checked by the service's ticker (which runs on the leader in queue mode, so one process
 * evaluates them, whichever process ran the workflows or announced the plugins):
 *
 * - `failureRate`: per workflow, at least `minRuns` production runs started in the last `windowMinutes` and more than
 *   `percent` % of them failed. One alert per workflow per window (the rule remembers the window it alerted for); a
 *   workflow that still fails when the window ends alerts again.
 * - `plugin`: a plugin whose every endpoint is offline for longer than the rule's grace period (a restart announces
 *   again within seconds and never alerts), and, when asked, a message when it is back. The plugin registry's events
 *   (`plugin.offline`, a new announce) stamp when an outage began; the ticker reconciles with the registry's status.
 *
 * What a rule remembers lives in `alert_state` (./store.ts), so a new leader carries on where the old one stopped.
 */
import { DEFAULT_FAILURE_RATE, DEFAULT_PLUGIN_GRACE_SECONDS, type AlertRule } from '../../shared/alerts';
import type { ExecutionSummary } from '../../shared/types';
import { database } from '../db';
import { registry } from '../plugins/registry';
import { store } from '../store';
import { customNotice, durationText, publicUrl, type AlertNotice } from './message';
import { inScope } from './rules';
import { alertStore } from './store';

/** Sends a notice through a rule's channels. */
export type Dispatch = (rule: AlertRule, notice: AlertNotice) => Promise<void>;

const MANUAL_MODES = new Set(['manual', 'chat']);
const MAX_ROWS = 50_000;

const activeRules = (kind: AlertRule['kind']) => alertStore.rules().filter((rule) => rule.kind === kind && rule.enabled && rule.channelIds.length);

// ---------------------------------------------------------------------------
// Failure rate
// ---------------------------------------------------------------------------

export interface RateWindow {
  workflowId: string;
  workflowName: string;
  /** Runs that ended for good in the window (a failed run with an automatic retry pending counts for neither side). */
  total: number;
  failed: number;
  /** The most recent failure, for the message. */
  lastError?: { executionId: string; message: string; node?: string };
}

/** Production runs that started at or after `since` (ISO), by workflow: finished ones, top-level, not evaluation or debug runs. */
export function runsSince(since: string, options: { includeManual?: boolean } = {}): Map<string, RateWindow> {
  const rows = database().all<{ summary: string }>(
    `SELECT summary FROM executions WHERE started_at >= ? AND parent_id IS NULL AND status IN ('success', 'error') ORDER BY started_at DESC LIMIT ${MAX_ROWS}`,
    since,
  );
  const byWorkflow = new Map<string, RateWindow>();
  for (const row of rows) {
    let summary: ExecutionSummary;
    try {
      summary = JSON.parse(row.summary) as ExecutionSummary;
    } catch {
      continue;
    }
    if (summary.debug || summary.evaluation || summary.parentExecutionId) continue;
    if (MANUAL_MODES.has(summary.mode) && !options.includeManual) continue;
    if (summary.status === 'error' && summary.retryAt) continue;
    const window = byWorkflow.get(summary.workflowId) ?? { workflowId: summary.workflowId, workflowName: summary.workflowName, total: 0, failed: 0 };
    window.total += 1;
    if (summary.status === 'error') {
      window.failed += 1;
      // Newest first: the first failure seen is the latest.
      window.lastError ??= { executionId: summary.id, message: summary.error?.message ?? 'Unknown error', ...(summary.error?.nodeName && { node: summary.error.nodeName }) };
    }
    byWorkflow.set(summary.workflowId, window);
  }
  return byWorkflow;
}

/** Whether a window breaches a rule's failure-rate limits. */
export const breaches = (window: Pick<RateWindow, 'total' | 'failed'>, limits: { minRuns: number; percent: number }) => window.total >= limits.minRuns && window.total > 0 && (window.failed / window.total) * 100 > limits.percent;

export async function checkFailureRates(now: number, dispatch: Dispatch): Promise<void> {
  for (const rule of activeRules('failureRate')) {
    const limits = { ...DEFAULT_FAILURE_RATE, ...rule.failureRate };
    const since = new Date(now - limits.windowMinutes * 60_000).toISOString();
    const windows = runsSince(since, { includeManual: rule.includeManual });
    // Windows that lapsed and no longer breach are forgotten; one that still breaches alerts again below.
    const remembered = alertStore.states<{ percent: number }>(rule.id, 'rate:');
    for (const state of remembered) {
      if (state.expiresAt && Date.parse(state.expiresAt) <= now) alertStore.clearState(rule.id, state.key);
    }
    for (const window of windows.values()) {
      if (!inScope(rule.workflows, window.workflowId, store.getWorkflow(window.workflowId)?.tags)) continue;
      if (!breaches(window, limits)) continue;
      const key = `rate:${window.workflowId}`;
      const current = alertStore.state(rule.id, key);
      if (current?.expiresAt && Date.parse(current.expiresAt) > now) continue;
      const percent = Math.round((window.failed / window.total) * 1000) / 10;
      alertStore.setState(rule.id, key, { percent, failed: window.failed, total: window.total, at: new Date(now).toISOString() }, new Date(now + limits.windowMinutes * 60_000).toISOString());
      const link = `${publicUrl()}/workflows/${window.workflowId}/executions`;
      await dispatch(
        rule,
        customNotice({
          event: 'failureRate',
          rule,
          about: { id: window.workflowId, name: window.workflowName },
          subject: `${percent}% of runs failed: ${window.workflowName}`,
          facts: [
            { label: 'Workflow', value: window.workflowName },
            { label: 'Failure rate', value: `${percent}% (${window.failed} of ${window.total} runs failed in the last ${durationText(limits.windowMinutes * 60_000)})` },
            { label: 'Rule', value: `At least ${limits.minRuns} runs and more than ${limits.percent}% failed in ${durationText(limits.windowMinutes * 60_000)}; at most one alert per window` },
            ...(window.lastError ? [{ label: 'Latest error', value: window.lastError.message.slice(0, 1_000) }, ...(window.lastError.node ? [{ label: 'Failed node', value: window.lastError.node }] : [])] : []),
          ],
          link,
        }),
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Plugins going offline
// ---------------------------------------------------------------------------

/** What a rule keeps for a plugin that is, or was, offline. */
interface OutageState {
  name: string;
  offlineSince: string;
  /** The offline alert went out (so a recovery message is due). */
  alerted?: boolean;
}

/** When the registry last reported each plugin offline, from its events: more exact than the ticker's. */
export const outageStamps = new Map<string, number>();

/** Feed a registry event in: remember when a plugin went offline, forget it when it announced or returned. */
export function noteRegistryEvent(event: { type: string; pluginId?: string }, at = Date.now()): void {
  if (!event.pluginId) return;
  if (event.type === 'plugin.offline') {
    if (!outageStamps.has(event.pluginId)) outageStamps.set(event.pluginId, at);
  } else if (event.type === 'plugin.registered' || event.type === 'plugin.updated' || event.type === 'plugin.removed') {
    outageStamps.delete(event.pluginId);
  }
}

export async function checkPlugins(now: number, dispatch: Dispatch): Promise<void> {
  const rules = activeRules('plugin');
  const plugins = registry.list();
  const byId = new Map(plugins.map((plugin) => [plugin.id, plugin]));
  for (const id of [...outageStamps.keys()]) if (byId.get(id)?.status !== 'offline') outageStamps.delete(id);
  for (const rule of rules) {
    const config = { ids: [] as string[], graceSeconds: DEFAULT_PLUGIN_GRACE_SECONDS, notifyRecovery: true, ...rule.plugins };
    const watched = (id: string) => !config.ids?.length || config.ids.includes(id);
    // A plugin that was removed (or is no longer watched) ends its outage without a message.
    for (const state of alertStore.states<OutageState>(rule.id, 'plugin:')) {
      const id = state.key.slice('plugin:'.length);
      if (!byId.has(id) || !watched(id)) alertStore.clearState(rule.id, state.key);
    }
    for (const plugin of plugins) {
      if (!watched(plugin.id) || plugin.transport === 'in-process') continue;
      const key = `plugin:${plugin.id}`;
      const state = alertStore.state<OutageState>(rule.id, key)?.data;
      const name = plugin.info.name || plugin.id;
      const link = `${publicUrl()}/plugins`;
      if (plugin.status === 'offline') {
        const since = state?.offlineSince ?? new Date(outageStamps.get(plugin.id) ?? now).toISOString();
        if (!state) alertStore.setState(rule.id, key, { name, offlineSince: since } satisfies OutageState);
        if (state?.alerted || now - Date.parse(since) < config.graceSeconds * 1_000) continue;
        alertStore.setState(rule.id, key, { name, offlineSince: since, alerted: true } satisfies OutageState);
        const errors = plugin.endpoints.filter((endpoint) => endpoint.lastError).map((endpoint) => `${endpoint.endpoint}: ${endpoint.lastError}`);
        await dispatch(
          rule,
          customNotice({
            event: 'pluginOffline',
            rule,
            about: { id: `plugin:${plugin.id}`, name: `Plugin ${name}` },
            subject: `Plugin offline: ${name}`,
            facts: [
              { label: 'Plugin', value: `${name} (${plugin.id})` },
              { label: 'Offline since', value: `${since.replace('T', ' ').replace(/\.\d+Z$/, ' UTC')} (${durationText(now - Date.parse(since))} ago)` },
              { label: 'Endpoints', value: plugin.endpoints.map((endpoint) => `${endpoint.endpoint} (${endpoint.status})`).join(', ') || 'none' },
              ...(errors.length ? [{ label: 'Error', value: errors.join('\n').slice(0, 1_000) }] : []),
              { label: 'Rule', value: `Offline for more than ${durationText(config.graceSeconds * 1_000)}` },
            ],
            link,
          }),
        );
      } else if (state) {
        alertStore.clearState(rule.id, key);
        if (state.alerted && config.notifyRecovery) {
          await dispatch(
            rule,
            customNotice({
              event: 'pluginOnline',
              rule,
              about: { id: `plugin:${plugin.id}`, name: `Plugin ${name}` },
              subject: `Plugin back online: ${name}`,
              facts: [
                { label: 'Plugin', value: `${name} (${plugin.id})` },
                { label: 'Was offline for', value: durationText(now - Date.parse(state.offlineSince)) },
              ],
              link,
              recovery: true,
            }),
          );
        }
      }
    }
  }
}
