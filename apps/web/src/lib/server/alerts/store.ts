/**
 * Alert channels and rules in the database (migration 600), plus the throttle windows and the "waiting too long"
 * markers the service keeps. A channel's secret settings (a Slack webhook URL, a webhook signing secret) are sealed
 * with the credential vault's key and never leave this module unsealed except through `channelForSending`.
 */
import { nanoid } from 'nanoid';
import { ALERT_SECRET_FIELDS, type AlertChannel, type AlertChannelConfig, type AlertChannelKind, type AlertDelivery, type AlertRule } from '../../shared/alerts';
import { credentials } from '../credentials/vault';
import { database } from '../db';

export class AlertError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = 'AlertError';
  }
}

interface ChannelRow {
  id: string;
  name: string;
  kind: AlertChannelKind;
  created_at: string;
  updated_at: string;
  data: string;
}

interface RuleRow {
  id: string;
  name: string;
  enabled: number;
  created_at: string;
  updated_at: string;
  data: string;
}

/** What a channel row's `data` holds: its settings (secret ones sealed) and the last delivery. */
interface ChannelData {
  config: AlertChannelConfig;
  lastDelivery?: AlertDelivery;
}

export interface ThrottleState {
  /** When the window ends (ISO). */
  windowUntil: string;
  /** Alerts held back in the window. */
  suppressed: number;
  data: ThrottleData;
}

/** What a digest needs about the held-back alerts. */
export interface ThrottleData {
  workflowName: string;
  /** When the window started. */
  since: string;
  minutes: number;
  last?: { executionId?: string; error?: string; node?: string; event: string; at: string };
}

const SECRET = new Set<string>(ALERT_SECRET_FIELDS);
/** The settings each kind keeps (others are dropped). */
const FIELDS: Record<AlertChannelKind, (keyof AlertChannelConfig)[]> = {
  email: ['to'],
  slack: ['webhookUrl'],
  webhook: ['url', 'secret'],
  telegram: ['credentialId', 'chatId'],
};

const parse = <T>(text: string, fallback: T): T => {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
};

const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

function httpUrl(value: string, label: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AlertError(`The ${label} is not a URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new AlertError(`The ${label} must be an http(s) URL`);
  return url.toString();
}

/** Comma- or newline-separated addresses, each `a@b` or `Name <a@b>`. */
export function emailAddresses(value: string | undefined): string[] {
  return (value ?? '')
    .split(/[,;\n]/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/** The settings a channel of `kind` keeps, checked; unsealed. Throws an AlertError for missing or invalid ones. */
function checkedConfig(kind: AlertChannelKind, config: AlertChannelConfig): AlertChannelConfig {
  const kept = Object.fromEntries(FIELDS[kind].map((field) => [field, text(config[field])]).filter(([, value]) => value)) as AlertChannelConfig;
  switch (kind) {
    case 'email': {
      const addresses = emailAddresses(kept.to);
      if (!addresses.length) throw new AlertError('Enter at least one email address');
      const bad = addresses.find((address) => !/^[^\s@<>]+@[^\s@<>]+$/.test(/<([^>]+)>/.exec(address)?.[1] ?? address));
      if (bad) throw new AlertError(`"${bad}" is not an email address`);
      kept.to = addresses.join(', ');
      break;
    }
    case 'slack':
      if (!kept.webhookUrl) throw new AlertError('Enter the Slack incoming webhook URL');
      kept.webhookUrl = httpUrl(kept.webhookUrl, 'Slack webhook URL');
      break;
    case 'webhook':
      if (!kept.url) throw new AlertError('Enter the URL to POST to');
      kept.url = httpUrl(kept.url, 'webhook URL');
      break;
    case 'telegram':
      if (!kept.credentialId) throw new AlertError('Choose a Telegram API credential');
      if (!kept.chatId) throw new AlertError('Enter the Telegram chat ID');
      break;
  }
  return kept;
}

function seal(config: AlertChannelConfig): AlertChannelConfig {
  return Object.fromEntries(Object.entries(config).map(([key, value]) => [key, SECRET.has(key) && value ? credentials.sealSecret(String(value)) : value])) as AlertChannelConfig;
}

function view(row: ChannelRow): AlertChannel {
  const data = parse<ChannelData>(row.data, { config: {} });
  const config = Object.fromEntries(Object.entries(data.config).filter(([key]) => !SECRET.has(key))) as AlertChannelConfig;
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    config,
    secretsSet: Object.keys(data.config).filter((key) => SECRET.has(key) && (data.config as Record<string, unknown>)[key]),
    ...(data.lastDelivery && { lastDelivery: data.lastDelivery }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function ruleView(row: RuleRow): AlertRule {
  const data = parse<Partial<AlertRule>>(row.data, {});
  return {
    workflows: { mode: 'all' },
    events: ['failed'],
    channelIds: [],
    throttleMinutes: 0,
    ...data,
    id: row.id,
    name: row.name,
    enabled: Boolean(row.enabled),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export type RuleInput = Omit<AlertRule, 'id' | 'createdAt' | 'updatedAt'>;

export const alertStore = {
  channels(): AlertChannel[] {
    return database().all<ChannelRow>('SELECT * FROM alert_channels ORDER BY name').map(view);
  },

  channel(id: string): AlertChannel | undefined {
    const row = database().get<ChannelRow>('SELECT * FROM alert_channels WHERE id = ?', id);
    return row && view(row);
  },

  /** A channel with its secret settings unsealed, for sending. */
  channelForSending(id: string): (AlertChannel & { config: AlertChannelConfig }) | undefined {
    const row = database().get<ChannelRow>('SELECT * FROM alert_channels WHERE id = ?', id);
    if (!row) return undefined;
    const data = parse<ChannelData>(row.data, { config: {} });
    const config = Object.fromEntries(Object.entries(data.config).map(([key, value]) => [key, SECRET.has(key) && value ? credentials.openSecret(String(value)) : value])) as AlertChannelConfig;
    return { ...view(row), config };
  },

  createChannel(input: { name: string; kind: AlertChannelKind; config: AlertChannelConfig }): AlertChannel {
    const name = text(input.name);
    if (!name) throw new AlertError('Enter a name');
    const config = checkedConfig(input.kind, input.config);
    const now = new Date().toISOString();
    const id = `ach_${nanoid(12)}`;
    database().upsert('alert_channels', { id, name, kind: input.kind, created_at: now, updated_at: now, data: JSON.stringify({ config: seal(config) } satisfies ChannelData) });
    return this.channel(id)!;
  },

  /** Change a channel; a secret setting left empty keeps its saved value. */
  updateChannel(id: string, patch: { name?: string; config?: AlertChannelConfig }): AlertChannel {
    const row = database().get<ChannelRow>('SELECT * FROM alert_channels WHERE id = ?', id);
    if (!row) throw new AlertError('Alert channel not found', 404);
    const current = this.channelForSending(id)!;
    const name = patch.name === undefined ? row.name : text(patch.name);
    if (!name) throw new AlertError('Enter a name');
    let data = parse<ChannelData>(row.data, { config: {} });
    if (patch.config) {
      const merged: AlertChannelConfig = { ...patch.config };
      for (const field of ALERT_SECRET_FIELDS) if (!text(merged[field]) && current.config[field]) merged[field] = current.config[field];
      data = { ...data, config: seal(checkedConfig(row.kind, merged)) };
    }
    database().upsert('alert_channels', { id, name, kind: row.kind, created_at: row.created_at, updated_at: new Date().toISOString(), data: JSON.stringify(data) });
    return this.channel(id)!;
  },

  /** Delete a channel and take it out of every rule. */
  deleteChannel(id: string): boolean {
    const db = database();
    return db.transaction(() => {
      const gone = db.delete('alert_channels', { id }) > 0;
      if (gone) {
        for (const rule of this.rules()) {
          if (rule.channelIds.includes(id)) this.updateRule(rule.id, { channelIds: rule.channelIds.filter((other) => other !== id) });
        }
      }
      return gone;
    });
  },

  recordDelivery(id: string, delivery: AlertDelivery) {
    const row = database().get<ChannelRow>('SELECT * FROM alert_channels WHERE id = ?', id);
    if (!row) return;
    const data = parse<ChannelData>(row.data, { config: {} });
    database().upsert('alert_channels', { id, name: row.name, kind: row.kind, created_at: row.created_at, updated_at: row.updated_at, data: JSON.stringify({ ...data, lastDelivery: delivery }) });
  },

  rules(): AlertRule[] {
    return database().all<RuleRow>('SELECT * FROM alert_rules ORDER BY name').map(ruleView);
  },

  rule(id: string): AlertRule | undefined {
    const row = database().get<RuleRow>('SELECT * FROM alert_rules WHERE id = ?', id);
    return row && ruleView(row);
  },

  /** The "Notify on failure" rule of a workflow. */
  shortcutRule(workflowId: string): AlertRule | undefined {
    return this.rules().find((rule) => rule.shortcutFor === workflowId);
  },

  createRule(input: RuleInput): AlertRule {
    const now = new Date().toISOString();
    const rule: AlertRule = { ...input, id: `arl_${nanoid(12)}`, createdAt: now, updatedAt: now };
    this.saveRule(rule);
    return this.rule(rule.id)!;
  },

  updateRule(id: string, patch: Partial<RuleInput>): AlertRule {
    const current = this.rule(id);
    if (!current) throw new AlertError('Alert rule not found', 404);
    const rule: AlertRule = { ...current, ...patch, id, createdAt: current.createdAt, updatedAt: new Date().toISOString() };
    this.saveRule(rule);
    return this.rule(id)!;
  },

  saveRule(rule: AlertRule) {
    const name = text(rule.name);
    if (!name) throw new AlertError('Enter a name');
    const unknown = rule.channelIds.find((channelId) => !this.channel(channelId));
    if (unknown) throw new AlertError(`Alert channel ${unknown} not found`);
    const { id, enabled, createdAt, updatedAt, ...data } = rule;
    database().upsert('alert_rules', { id, name, enabled: enabled ? 1 : 0, created_at: createdAt, updated_at: updatedAt, data: JSON.stringify({ ...data, name }) });
  },

  deleteRule(id: string): boolean {
    const db = database();
    return db.transaction(() => {
      db.delete('alert_throttle', { rule_id: id });
      db.delete('alert_waiting_sent', { rule_id: id });
      return db.delete('alert_rules', { id }) > 0;
    });
  },

  throttle(ruleId: string, workflowId: string): ThrottleState | undefined {
    const row = database().get<{ window_until: string; suppressed: number; data: string }>(
      'SELECT window_until, suppressed, data FROM alert_throttle WHERE rule_id = ? AND workflow_id = ?',
      ruleId,
      workflowId,
    );
    return row && { windowUntil: row.window_until, suppressed: Number(row.suppressed), data: parse<ThrottleData>(row.data, { workflowName: workflowId, since: row.window_until, minutes: 0 }) };
  },

  setThrottle(ruleId: string, workflowId: string, state: ThrottleState) {
    database().upsert('alert_throttle', { rule_id: ruleId, workflow_id: workflowId, window_until: state.windowUntil, suppressed: state.suppressed, data: JSON.stringify(state.data) });
  },

  clearThrottle(ruleId: string, workflowId: string) {
    database().delete('alert_throttle', { rule_id: ruleId, workflow_id: workflowId });
  },

  /** Throttle windows that ended by `now`. */
  endedThrottles(now: number): Array<ThrottleState & { ruleId: string; workflowId: string }> {
    return database()
      .all<{ rule_id: string; workflow_id: string; window_until: string; suppressed: number; data: string }>('SELECT * FROM alert_throttle WHERE window_until <= ?', new Date(now).toISOString())
      .map((row) => ({
        ruleId: row.rule_id,
        workflowId: row.workflow_id,
        windowUntil: row.window_until,
        suppressed: Number(row.suppressed),
        data: parse<ThrottleData>(row.data, { workflowName: row.workflow_id, since: row.window_until, minutes: 0 }),
      }));
  },

  /** Mark "waiting too long" as sent for an execution; false when it was already. */
  markWaitingSent(ruleId: string, executionId: string): boolean {
    return database().insertNew('alert_waiting_sent', { rule_id: ruleId, execution_id: executionId, sent_at: new Date().toISOString() });
  },

  /** Forget the markers of executions that stopped waiting. */
  pruneWaitingSent(stillWaiting: Set<string>) {
    const db = database();
    for (const row of db.all<{ rule_id: string; execution_id: string }>('SELECT rule_id, execution_id FROM alert_waiting_sent')) {
      if (!stillWaiting.has(row.execution_id)) db.delete('alert_waiting_sent', { rule_id: row.rule_id, execution_id: row.execution_id });
    }
  },
};
