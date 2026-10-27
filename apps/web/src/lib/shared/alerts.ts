/**
 * Failure alerts without an error workflow: channels (where an alert goes) and rules (which runs send one), shared by
 * the API (lib/server/alerts, /api/settings/alerts) and Settings → Alerts. No runtime imports beyond plain data.
 */

export type AlertChannelKind = 'email' | 'slack' | 'webhook' | 'telegram' | 'teams' | 'discord';

/**
 * What a rule reacts to. `failed`: a production run ended in error (after its last automatic retry); `timedOut`: it
 * failed by the workflow or a node timing out; `retriesExhausted`: an automatic retry failed and none is left;
 * `waiting`: a run has been waiting (for a form, a webhook, an approval…) longer than the rule's minutes.
 * The rest belong to rules of another kind (`AlertRuleKind`): `failureRate`, `pluginOffline` (and its recovery),
 * `costThreshold` and `evaluationScore`.
 */
export type AlertEvent = 'failed' | 'timedOut' | 'retriesExhausted' | 'waiting' | 'failureRate' | 'pluginOffline' | 'pluginOnline' | 'costThreshold' | 'evaluationScore';

/**
 * What a rule watches. `runs` (the default): single runs that failed or waited too long (the `events`);
 * `failureRate`: a workflow's share of failed runs over a window; `plugin`: plugins going offline (and back);
 * `cost`: AI usage reaching a share of a cap (Settings → AI usage caps, workflow and agent limits);
 * `evaluation`: a metric's average on an evaluation run falling below a score or dropping against the run before.
 */
export type AlertRuleKind = 'runs' | 'failureRate' | 'plugin' | 'cost' | 'evaluation';

export const ALERT_RULE_KINDS: readonly { id: AlertRuleKind; label: string; hint: string }[] = [
  { id: 'runs', label: 'Failed runs', hint: 'Each run that failed, timed out or waited too long' },
  { id: 'failureRate', label: 'Failure rate', hint: 'More than a share of a workflow’s runs failed within a window' },
  { id: 'plugin', label: 'Plugin offline', hint: 'A plugin went offline and stayed offline past a grace period (and when it is back)' },
  { id: 'cost', label: 'AI cost', hint: 'AI usage reached a share of a cap, before the cap stops runs' },
  { id: 'evaluation', label: 'Evaluation score', hint: 'A metric’s average fell below a score or dropped against the previous run' },
];

/** The event a non-`runs` rule alerts on (its `events`). */
export const RULE_KIND_EVENTS: Record<Exclude<AlertRuleKind, 'runs'>, AlertEvent[]> = {
  failureRate: ['failureRate'],
  plugin: ['pluginOffline', 'pluginOnline'],
  cost: ['costThreshold'],
  evaluation: ['evaluationScore'],
};

export const ALERT_EVENTS: readonly { id: AlertEvent; label: string; hint: string }[] = [
  { id: 'failed', label: 'Failed', hint: 'A run ended in error (after its last automatic retry)' },
  { id: 'timedOut', label: 'Timed out', hint: 'The workflow or a node hit its timeout' },
  { id: 'retriesExhausted', label: 'Retries exhausted', hint: 'The last automatic retry failed too' },
  { id: 'waiting', label: 'Waiting too long', hint: 'A run has been waiting longer than the minutes you set' },
];

export const ALERT_CHANNEL_KINDS: readonly { id: AlertChannelKind; label: string; hint: string }[] = [
  { id: 'email', label: 'Email', hint: 'Over the host’s SMTP server (LANDFLOW_SMTP_HOST)' },
  { id: 'slack', label: 'Slack', hint: 'An incoming webhook URL of a Slack app' },
  { id: 'webhook', label: 'Webhook', hint: 'A signed JSON POST to any URL' },
  { id: 'telegram', label: 'Telegram', hint: 'A saved Telegram API credential and a chat ID' },
  { id: 'teams', label: 'Microsoft Teams', hint: 'A Workflows (or incoming) webhook URL; sends an Adaptive Card' },
  { id: 'discord', label: 'Discord', hint: 'A channel webhook URL; sends an embed' },
];

/** Channel settings; secret ones (`webhookUrl`, `secret`) never come back from the API, `secretsSet` lists those set. */
export interface AlertChannelConfig {
  /** email: comma-separated addresses. */
  to?: string;
  /** slack, teams, discord: the incoming webhook URL (secret). */
  webhookUrl?: string;
  /** webhook: where to POST. */
  url?: string;
  /** webhook: signs the body (X-Landflow-Signature: sha256=HMAC(secret, `${timestamp}.${body}`)); secret. */
  secret?: string;
  /** telegram: a saved `messaging.telegramApi` credential. */
  credentialId?: string;
  /** telegram: the chat, group or channel ID (or @channelusername). */
  chatId?: string;
}

/** The secret settings of a channel: stored encrypted, masked in the API. */
export const ALERT_SECRET_FIELDS = ['webhookUrl', 'secret'] as const;

export interface AlertDelivery {
  at: string;
  ok: boolean;
  /** Why it failed, or what the receiver said. */
  message?: string;
}

export interface AlertChannel {
  id: string;
  name: string;
  kind: AlertChannelKind;
  config: AlertChannelConfig;
  /** Secret fields that have a value. */
  secretsSet: string[];
  /** The last send (an alert or a test). */
  lastDelivery?: AlertDelivery;
  createdAt: string;
  updatedAt: string;
}

/** Which workflows a rule watches: all of them, these ids, or those with any of these tags. */
export interface AlertScope {
  mode: 'all' | 'ids' | 'tags';
  ids?: string[];
  tags?: string[];
}

export interface AlertRule {
  id: string;
  name: string;
  enabled: boolean;
  workflows: AlertScope;
  events: AlertEvent[];
  /** `waiting`: alert once a run has waited this long (default 60). */
  waitingMinutes?: number;
  /** Also runs started from the editor (manual and chat test runs). Off by default. */
  includeManual?: boolean;
  channelIds: string[];
  /** At most one alert per workflow in this many minutes; the rest go out as one digest when it ends. 0 = every one. */
  throttleMinutes: number;
  /** What the rule watches; absent = `runs`. */
  kind?: AlertRuleKind;
  /** `failureRate`: alert when at least `minRuns` runs started in the last `windowMinutes` and more than `percent` % failed; once per window. */
  failureRate?: { minRuns: number; percent: number; windowMinutes: number };
  /**
   * `plugin`: plugins to watch (none = all, builtin ones never go offline), how long one must stay offline before an alert
   * (a restart takes seconds), and whether to say when it is back.
   */
  plugins?: { ids?: string[]; graceSeconds: number; notifyRecovery: boolean };
  /** `cost`: alert once per period when usage reaches this share of any cap (default 80). */
  cost?: { thresholdPercent: number };
  /** `evaluation`: a metric (none = every metric) whose average fell below `below` (0–1 scores) or by more than `dropPercent` % against the run before. */
  evaluation?: { metric?: string; below?: number; dropPercent?: number };
  /** Made by a workflow's Settings → "Notify on failure": the workflow it belongs to. */
  shortcutFor?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AlertsView {
  channels: AlertChannel[];
  rules: AlertRule[];
  /** Whether email can go out (LANDFLOW_SMTP_HOST set). */
  email: { configured: boolean };
}

/** A workflow's "Notify on failure" shortcut: its rule (if any) and the channels to choose from. */
export interface WorkflowAlertView {
  rule?: AlertRule;
  channels: Pick<AlertChannel, 'id' | 'name' | 'kind'>[];
}

export const DEFAULT_THROTTLE_MINUTES = 10;
export const DEFAULT_WAITING_MINUTES = 60;

export const DEFAULT_FAILURE_RATE = { minRuns: 5, percent: 50, windowMinutes: 15 };
export const DEFAULT_PLUGIN_GRACE_SECONDS = 120;
export const DEFAULT_COST_THRESHOLD_PERCENT = 80;
