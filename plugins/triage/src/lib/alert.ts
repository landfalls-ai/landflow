/** Alert normalisation: seven source formats to one canonical alert. Pure functions, no I/O. */
import { cleanLinks, firstStr, getPath, isObj, nul, sha256Hex, str, stringMap, toIso, tryJson, type Link, type LinkKind, type Obj } from './util';

export type Severity = 'sev1' | 'sev2' | 'sev3' | 'sev4';
export const FORMATS = ['alertmanager', 'grafana', 'datadog', 'cloudwatch', 'sentry', 'wazuh', 'generic'] as const;
export type AlertFormat = (typeof FORMATS)[number];
/** The formats auto-detection tries, in order. Generic is never auto-detected. */
export const DETECTABLE: AlertFormat[] = ['grafana', 'alertmanager', 'cloudwatch', 'sentry', 'wazuh', 'datadog'];

export interface CanonicalAlert {
  source: string;
  id: string;
  fingerprint: string | null;
  status: 'firing' | 'resolved';
  title: string;
  description: string;
  severity: Severity;
  severityRaw: string;
  service: string | null;
  entity: { kind: string; id: string };
  environment: string | null;
  startsAt: string | null;
  endsAt: string | null;
  groupKey: string | null;
  labels: Record<string, string>;
  links: Link[];
  tags: string[];
  dedupKey: string;
  raw?: unknown;
}

export interface NormalizeOptions {
  severityMap: Record<string, string>;
  defaultSeverity: Severity;
  generic?: {
    source?: string;
    titlePath?: string;
    severityPath?: string;
    servicePath?: string;
    idPath?: string;
    descriptionPath?: string;
    statusPath?: string;
    fingerprintPath?: string;
    environmentPath?: string;
  };
}

// --- severity ---------------------------------------------------------------------------------------------------

const WORDS: Record<string, Severity> = {
  sev1: 'sev1', 'sev-1': 'sev1', p1: 'sev1', p0: 'sev1', critical: 'sev1', crit: 'sev1', fatal: 'sev1', emergency: 'sev1', emerg: 'sev1', page: 'sev1', urgent: 'sev1', blocker: 'sev1',
  sev2: 'sev2', 'sev-2': 'sev2', p2: 'sev2', high: 'sev2', error: 'sev2', err: 'sev2', major: 'sev2', severe: 'sev2',
  sev3: 'sev3', 'sev-3': 'sev3', p3: 'sev3', warning: 'sev3', warn: 'sev3', medium: 'sev3', moderate: 'sev3', normal: 'sev3',
  sev4: 'sev4', 'sev-4': 'sev4', p4: 'sev4', p5: 'sev4', info: 'sev4', informational: 'sev4', low: 'sev4', minor: 'sev4', notice: 'sev4', debug: 'sev4', ok: 'sev4', none: 'sev4', success: 'sev4', sev5: 'sev4',
};
const NUMBERS: Record<string, Severity> = { '1': 'sev1', '2': 'sev2', '3': 'sev3', '4': 'sev4', '5': 'sev4' };

export function asSeverity(value: unknown): Severity | undefined {
  const s = str(value).trim().toLowerCase();
  if (!s) return undefined;
  return WORDS[s] ?? NUMBERS[s];
}

/** Wazuh rule levels (0-15): 13-15 sev1, 10-12 sev2, 7-9 sev3, 0-6 sev4. */
export function wazuhBand(level: number): Severity {
  if (level >= 13) return 'sev1';
  if (level >= 10) return 'sev2';
  if (level >= 7) return 'sev3';
  return 'sev4';
}

function mapSeverity(raw: unknown, opts: NormalizeOptions, source: AlertFormat): Severity {
  const key = str(raw).trim().toLowerCase();
  if (key) {
    const override = opts.severityMap[key];
    const overridden = asSeverity(override);
    if (overridden) return overridden;
    if (source === 'wazuh' && /^\d+$/.test(key)) return wazuhBand(Number(key));
    const known = asSeverity(key);
    if (known) return known;
  }
  return opts.defaultSeverity;
}

// --- shared helpers ---------------------------------------------------------------------------------------------

const SERVICE_KEYS = ['service', 'service_name', 'app', 'application', 'app_kubernetes_io_name', 'job'];
const ENV_KEYS = ['environment', 'env', 'stage'];
const HOST_KEYS = ['instance', 'host', 'hostname', 'node', 'pod'];

function pick(map: Record<string, string>, keys: string[]): string {
  for (const k of keys) if (map[k]) return map[k];
  return '';
}

function entityFrom(labels: Record<string, string>, service: string): { kind: string; id: string } {
  if (labels.pod) return { kind: 'pod', id: labels.pod };
  for (const k of HOST_KEYS) if (labels[k]) return { kind: 'host', id: labels[k] };
  if (service) return { kind: 'service', id: service };
  return { kind: 'unknown', id: '' };
}

type Partial_ = Omit<CanonicalAlert, 'dedupKey' | 'raw' | 'fingerprint'> & { fingerprint?: string };

function finish(a: Partial_, raw: unknown, includeRaw: boolean): CanonicalAlert {
  const fingerprint = a.fingerprint?.trim() || null;
  const dedupKey = fingerprint ? `${a.source}:${fingerprint}` : `${a.source}:${sha256Hex(`${a.source}|${a.title}|${a.service ?? ''}`).slice(0, 16)}`;
  const out: CanonicalAlert = { ...a, fingerprint, id: a.id || fingerprint || '', dedupKey };
  if (includeRaw) out.raw = raw;
  return out;
}

function parseStatus(v: unknown): 'firing' | 'resolved' {
  return /^(resolved|ok|recovered|recovery|closed|normal|inactive|success)$/i.test(str(v).trim()) ? 'resolved' : 'firing';
}

function tagList(v: unknown): string[] {
  if (Array.isArray(v)) {
    return v
      .map((t) => (Array.isArray(t) ? `${str(t[0])}:${str(t[1])}` : str(t)).trim())
      .filter(Boolean)
      .slice(0, 100);
  }
  if (typeof v === 'string') return v.split(',').map((t) => t.trim()).filter(Boolean).slice(0, 100);
  return [];
}

function tagLabels(tags: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const t of tags) {
    const i = t.indexOf(':');
    if (i > 0 && !(t.slice(0, i) in out)) out[t.slice(0, i)] = t.slice(i + 1);
  }
  return out;
}

// --- detection --------------------------------------------------------------------------------------------------

const first = (a: unknown): Obj | undefined => (Array.isArray(a) && isObj(a[0]) ? a[0] : undefined);

function parseMessage(body: Obj): Obj | undefined {
  const m = body.Message;
  if (isObj(m)) return m;
  if (typeof m === 'string') {
    const parsed = tryJson(m);
    if (isObj(parsed)) return parsed;
  }
  return undefined;
}

export const MATCHERS: Record<Exclude<AlertFormat, 'generic'>, (b: Obj) => boolean> = {
  grafana: (b) => {
    const a = first(b.alerts);
    return !!a && isObj(a.labels) && (b.orgId !== undefined || 'silenceURL' in a || 'dashboardURL' in a || 'panelURL' in a || 'valueString' in a);
  },
  alertmanager: (b) => {
    const a = first(b.alerts);
    return !!a && isObj(a.labels) && (b.version !== undefined || 'groupKey' in b || 'receiver' in b || 'generatorURL' in a || 'fingerprint' in a);
  },
  cloudwatch: (b) => {
    const m = b.Type === 'Notification' ? parseMessage(b) : b.AlarmName !== undefined ? b : undefined;
    return !!m && m.AlarmName !== undefined && (m.NewStateValue !== undefined || m.Trigger !== undefined);
  },
  sentry: (b) => {
    const d = b.data;
    if (isObj(d) && (isObj(d.event) || isObj(d.issue) || isObj(d.issue_alert))) return true;
    return typeof b.culprit === 'string' && (b.project !== undefined || b.project_name !== undefined || isObj(b.event));
  },
  wazuh: (b) => isObj(b.rule) && b.rule.level !== undefined && (isObj(b.agent) || isObj(b.manager) || 'full_log' in b),
  datadog: (b) => b.alert_transition !== undefined || b.alert_id !== undefined || b.alert_type !== undefined || (b.event_type !== undefined && b.title !== undefined && (isObj(b.org) || b.link !== undefined)),
};

export function detectFormat(body: unknown): Exclude<AlertFormat, 'generic'> | undefined {
  if (!isObj(body)) return undefined;
  return DETECTABLE.find((f) => f !== 'generic' && MATCHERS[f as Exclude<AlertFormat, 'generic'>](body)) as Exclude<AlertFormat, 'generic'> | undefined;
}

/** The payload objects an item can carry: the item itself, and its webhook `body` (an object or a JSON string). */
export function payloadCandidates(json: Obj): Obj[] {
  const out: Obj[] = [json];
  let body: unknown = json.body;
  if (typeof body === 'string') body = tryJson(body);
  if (isObj(body)) out.push(body);
  return out;
}

// --- per-format normalisers: one payload in, one or more alerts out --------------------------------------------

function fromAlertmanager(body: Obj, opts: NormalizeOptions, includeRaw: boolean, source: 'alertmanager' | 'grafana'): CanonicalAlert[] {
  const alerts = Array.isArray(body.alerts) ? body.alerts.filter(isObj) : [];
  const { alerts: _omit, ...rest } = body;
  return alerts.map((a) => {
    const labels = stringMap(a.labels);
    const annotations = stringMap(a.annotations);
    const service = pick(labels, SERVICE_KEYS);
    const severityRaw = firstStr(labels.severity, labels.priority, annotations.severity);
    const links: Array<{ kind: LinkKind; url: unknown }> = [
      { kind: 'runbook', url: annotations.runbook_url ?? annotations.runbook },
      { kind: 'dashboard', url: annotations.dashboard_url ?? annotations.dashboard },
      { kind: 'dashboard', url: a.dashboardURL },
      { kind: 'dashboard', url: a.panelURL },
      { kind: 'alert', url: a.generatorURL },
      { kind: 'other', url: a.silenceURL },
    ];
    return finish(
      {
        source,
        id: firstStr(a.fingerprint),
        fingerprint: firstStr(a.fingerprint) || undefined,
        status: parseStatus(a.status ?? body.status),
        title: firstStr(annotations.summary, annotations.title, labels.alertname, source === 'grafana' ? body.title : undefined) || 'Alert',
        description: firstStr(annotations.description, annotations.message),
        severity: mapSeverity(severityRaw, opts, source),
        severityRaw,
        service: nul(service),
        entity: entityFrom(labels, service),
        environment: nul(pick(labels, ENV_KEYS)),
        startsAt: toIso(a.startsAt) ?? null,
        endsAt: toIso(a.endsAt) ?? null,
        groupKey: nul(firstStr(body.groupKey)),
        labels,
        links: cleanLinks(links),
        tags: [],
      },
      { ...rest, alerts: [a] },
      includeRaw,
    );
  });
}

function fromDatadog(b: Obj, opts: NormalizeOptions, includeRaw: boolean): CanonicalAlert[] {
  const tags = tagList(b.tags);
  const labels = { ...tagLabels(tags) };
  const scope = firstStr(b.alert_scope, b.scope);
  if (scope) labels.scope = scope;
  const service = pick(labels, SERVICE_KEYS);
  const severityRaw = firstStr(b.priority, b.alert_priority, b.alert_type);
  const priority = firstStr(b.priority, b.alert_priority);
  const alertId = firstStr(b.alert_id);
  const transition = firstStr(b.alert_transition, b.alert_status, b.alert_type);
  const title = firstStr(b.alert_title, b.title, b.event_title) || 'Datadog alert';
  const host = firstStr(b.hostname, labels.host);
  return [
    finish(
      {
        source: 'datadog',
        id: firstStr(b.id, b.event_id, alertId),
        fingerprint: alertId ? (scope ? `${alertId}:${sha256Hex(scope).slice(0, 12)}` : alertId) : undefined,
        status: /recover|resolved|^ok$|success/i.test(transition) ? 'resolved' : 'firing',
        title,
        description: firstStr(b.text_only_msg, b.body, b.event_msg, b.message),
        severity: mapSeverity(priority || b.alert_type, opts, 'datadog'),
        severityRaw,
        service: nul(service),
        entity: host ? { kind: 'host', id: host } : entityFrom(labels, service),
        environment: nul(pick(labels, ENV_KEYS)),
        startsAt: toIso(b.date ?? b.last_updated_date ?? b.last_updated) ?? null,
        endsAt: null,
        groupKey: null,
        labels,
        links: cleanLinks([{ kind: 'alert', url: b.link ?? b.url }, { kind: 'dashboard', url: b.snapshot }]),
        tags,
      },
      b,
      includeRaw,
    ),
  ];
}

function fromCloudWatch(b: Obj, opts: NormalizeOptions, includeRaw: boolean): CanonicalAlert[] {
  const m = (b.Type === 'Notification' ? parseMessage(b) : b) ?? b;
  const name = str(m.AlarmName);
  const arn = str(m.AlarmArn);
  const stateValue = str(m.NewStateValue);
  const trigger = isObj(m.Trigger) ? m.Trigger : {};
  const dims = (Array.isArray(trigger.Dimensions) ? trigger.Dimensions : []).filter(isObj);
  const labels: Record<string, string> = {};
  for (const d of dims) {
    const k = firstStr(d.name, d.Name);
    if (k) labels[k] = firstStr(d.value, d.Value);
  }
  if (trigger.Namespace) labels.Namespace = str(trigger.Namespace);
  if (trigger.MetricName) labels.MetricName = str(trigger.MetricName);
  if (m.AWSAccountId) labels.AWSAccountId = str(m.AWSAccountId);
  const regionCode = /^arn:aws[a-z-]*:cloudwatch:([a-z0-9-]+):/.exec(arn)?.[1] ?? '';
  if (regionCode) labels.Region = regionCode;
  else if (m.Region) labels.Region = str(m.Region);
  const kinds: Array<[string, string, string]> = [
    ['FunctionName', 'lambda', 'FunctionName'], ['InstanceId', 'ec2', 'InstanceId'], ['DBInstanceIdentifier', 'rds', 'DBInstanceIdentifier'], ['DBClusterIdentifier', 'rds-cluster', 'DBClusterIdentifier'],
    ['ServiceName', 'ecs-service', 'ServiceName'], ['LoadBalancer', 'load-balancer', 'LoadBalancer'], ['QueueName', 'sqs', 'QueueName'], ['TableName', 'dynamodb', 'TableName'], ['ClusterName', 'cluster', 'ClusterName'],
  ];
  let entity = { kind: 'unknown', id: '' };
  for (const [dim, kind] of kinds) if (labels[dim]) { entity = { kind, id: labels[dim] }; break; }
  if (!entity.id && dims[0]) entity = { kind: 'resource', id: firstStr(dims[0].value, dims[0].Value) };
  const service = labels.ServiceName || labels.FunctionName || entity.id || '';
  const hint = /\b(sev-?[1-4]|p[0-4])\b/i.exec(`${name} ${str(m.AlarmDescription)}`)?.[1].replace('-', '');
  const severityRaw = hint ?? stateValue;
  const severity = hint ? mapSeverity(hint, opts, 'cloudwatch') : stateValue === 'ALARM' ? mapSeverity(stateValue, { ...opts, severityMap: { alarm: 'sev2', ...opts.severityMap } }, 'cloudwatch') : stateValue === 'INSUFFICIENT_DATA' ? mapSeverity(stateValue, { ...opts, severityMap: { insufficient_data: 'sev3', ...opts.severityMap } }, 'cloudwatch') : mapSeverity(stateValue, { ...opts, severityMap: { ok: 'sev4', ...opts.severityMap } }, 'cloudwatch');
  const link = regionCode && name ? `https://console.aws.amazon.com/cloudwatch/home?region=${regionCode}#alarmsV2:alarm/${encodeURIComponent(name)}` : '';
  return [
    finish(
      {
        source: 'cloudwatch',
        id: firstStr(b.MessageId) || `${name}@${str(m.StateChangeTime)}`,
        fingerprint: arn || name || undefined,
        status: stateValue === 'OK' ? 'resolved' : 'firing',
        title: name || firstStr(b.Subject) || 'CloudWatch alarm',
        description: firstStr(m.NewStateReason, m.AlarmDescription),
        severity,
        severityRaw,
        service: nul(service),
        entity,
        environment: nul(pick(labels, ENV_KEYS)),
        startsAt: toIso(m.StateChangeTime ?? b.Timestamp) ?? null,
        endsAt: null,
        groupKey: null,
        labels,
        links: cleanLinks([{ kind: 'alert', url: link }]),
        tags: [],
      },
      b,
      includeRaw,
    ),
  ];
}

function fromSentry(b: Obj, opts: NormalizeOptions, includeRaw: boolean): CanonicalAlert[] {
  const data = isObj(b.data) ? b.data : {};
  const event = isObj(data.event) ? data.event : isObj(b.event) ? b.event : {};
  const issue = isObj(data.issue) ? data.issue : {};
  const project = isObj(issue.project) ? issue.project : {};
  const tags = tagList(event.tags);
  const labels = tagLabels(tags);
  const projectSlug = firstStr(project.slug, event.project, b.project_slug, b.project, labels.project);
  const environment = firstStr(event.environment, labels.environment, issue.environment);
  const levelRaw = firstStr(event.level, issue.level, b.level);
  const issueId = firstStr(event.issue_id, issue.id, b.id);
  const action = str(b.action);
  const resolved = action === 'resolved' || str(issue.status) === 'resolved';
  const rule = firstStr(data.triggered_rule, isObj(data.issue_alert) ? data.issue_alert.title : undefined, Array.isArray(b.triggering_rules) ? b.triggering_rules[0] : undefined);
  if (projectSlug) labels.project = projectSlug;
  if (rule) labels.rule = rule;
  if (event.platform) labels.platform = str(event.platform);
  if (event.release) labels.release = str(event.release);
  const culprit = firstStr(event.culprit, issue.culprit, b.culprit);
  return [
    finish(
      {
        source: 'sentry',
        id: firstStr(event.event_id, event.id, issueId),
        fingerprint: issueId || undefined,
        status: resolved ? 'resolved' : 'firing',
        title: firstStr(event.title, issue.title, b.message, event.message) || 'Sentry issue',
        description: culprit ? `Culprit: ${culprit}` : firstStr(event.message, b.message),
        severity: mapSeverity(levelRaw, opts, 'sentry'),
        severityRaw: levelRaw,
        service: nul(projectSlug),
        entity: culprit ? { kind: 'code', id: culprit } : { kind: projectSlug ? 'service' : 'unknown', id: projectSlug },
        environment: nul(environment),
        startsAt: toIso(issue.firstSeen ?? event.datetime ?? event.timestamp) ?? null,
        endsAt: resolved ? (toIso(issue.lastSeen) ?? null) : null,
        groupKey: null,
        labels,
        links: cleanLinks([{ kind: 'alert', url: event.web_url ?? issue.permalink ?? b.url }]),
        tags,
      },
      b,
      includeRaw,
    ),
  ];
}

function fromWazuh(b: Obj, opts: NormalizeOptions, includeRaw: boolean): CanonicalAlert[] {
  const rule = isObj(b.rule) ? b.rule : {};
  const agent = isObj(b.agent) ? b.agent : {};
  const data = isObj(b.data) ? b.data : {};
  const manager = isObj(b.manager) ? b.manager : {};
  const level = str(rule.level);
  const labels: Record<string, string> = {};
  const set = (k: string, v: unknown) => { const s = str(v); if (s) labels[k] = s; };
  set('rule_id', rule.id); set('rule_level', rule.level); set('agent_id', agent.id); set('agent_name', agent.name); set('agent_ip', agent.ip);
  set('srcip', data.srcip); set('dstip', data.dstip); set('srcuser', data.srcuser); set('dstuser', data.dstuser); set('location', b.location); set('manager', manager.name);
  const agentName = firstStr(agent.name, agent.id);
  const groups = tagList(rule.groups);
  const log = str(b.full_log).slice(0, 2000);
  return [
    finish(
      {
        source: 'wazuh',
        id: firstStr(b.id),
        fingerprint: rule.id !== undefined ? `${str(rule.id)}:${agentName || 'manager'}` : undefined,
        status: 'firing',
        title: firstStr(rule.description) || `Wazuh rule ${str(rule.id)}`,
        description: log,
        severity: mapSeverity(level, opts, 'wazuh'),
        severityRaw: level,
        service: null,
        entity: agentName ? { kind: 'host', id: agentName } : { kind: 'unknown', id: '' },
        environment: null,
        startsAt: toIso(b.timestamp) ?? null,
        endsAt: null,
        groupKey: null,
        labels,
        links: [],
        tags: groups,
      },
      b,
      includeRaw,
    ),
  ];
}

function fromGeneric(b: Obj, opts: NormalizeOptions, includeRaw: boolean): CanonicalAlert[] {
  const g = opts.generic ?? {};
  const get = (p: string | undefined, fallback: string) => getPath(b, (p ?? '').trim() || fallback);
  const title = firstStr(get(g.titlePath, 'title'));
  const severityRaw = firstStr(get(g.severityPath, 'severity'));
  const service = firstStr(get(g.servicePath, 'service'));
  const fingerprint = firstStr(g.fingerprintPath ? getPath(b, g.fingerprintPath) : undefined);
  const labels = stringMap(b.labels);
  return [
    finish(
      {
        source: (g.source ?? '').trim() || 'generic',
        id: firstStr(get(g.idPath, 'id')),
        fingerprint: fingerprint || undefined,
        status: parseStatus(g.statusPath ? getPath(b, g.statusPath) : b.status),
        title: title || 'Alert',
        description: firstStr(get(g.descriptionPath, 'description')),
        severity: mapSeverity(severityRaw, opts, 'generic'),
        severityRaw,
        service: nul(service),
        entity: entityFrom(labels, service),
        environment: nul(firstStr(g.environmentPath ? getPath(b, g.environmentPath) : undefined, b.environment, b.env)),
        startsAt: toIso(b.startsAt ?? b.timestamp ?? b.time) ?? null,
        endsAt: toIso(b.endsAt) ?? null,
        groupKey: null,
        labels,
        links: cleanLinks([{ kind: 'alert', url: b.url ?? b.link }, { kind: 'runbook', url: b.runbook ?? b.runbook_url }]),
        tags: tagList(b.tags),
      },
      b,
      includeRaw,
    ),
  ];
}

/** Normalise one payload of a known format into canonical alerts (an Alertmanager group gives one per alert). */
export function normalizePayload(format: AlertFormat, payload: Obj, opts: NormalizeOptions, includeRaw: boolean): CanonicalAlert[] {
  switch (format) {
    case 'alertmanager':
      return fromAlertmanager(payload, opts, includeRaw, 'alertmanager');
    case 'grafana':
      return fromAlertmanager(payload, opts, includeRaw, 'grafana');
    case 'datadog':
      return fromDatadog(payload, opts, includeRaw);
    case 'cloudwatch':
      return fromCloudWatch(payload, opts, includeRaw);
    case 'sentry':
      return fromSentry(payload, opts, includeRaw);
    case 'wazuh':
      return fromWazuh(payload, opts, includeRaw);
    case 'generic':
      return fromGeneric(payload, opts, includeRaw);
  }
}

/**
 * Normalise an item's JSON. `format` is a forced format or 'auto'. When auto-detection finds nothing the payload is
 * read as Generic with the default paths, so an alert from an unknown source still goes through triage (fail open).
 */
export function normalizeItem(json: Obj, format: AlertFormat | 'auto', opts: NormalizeOptions, includeRaw: boolean): CanonicalAlert[] {
  const candidates = payloadCandidates(json);
  if (format === 'auto') {
    for (const c of candidates) {
      const f = detectFormat(c);
      if (f) return normalizePayload(f, c, opts, includeRaw);
    }
    format = 'generic';
  }
  let payload = candidates[0];
  if (format !== 'generic') {
    const m = MATCHERS[format];
    payload = candidates.find(m) ?? (candidates[1] && ('headers' in json || 'query' in json || 'params' in json) ? candidates[1] : candidates[0]);
  } else if (candidates[1] && ('headers' in json || 'params' in json) && !('title' in json)) {
    payload = candidates[1];
  }
  const alerts = normalizePayload(format, payload, opts, includeRaw);
  if (alerts.length === 0) throw new Error(`The payload holds no ${format} alerts (empty "alerts" list)`);
  return alerts;
}
