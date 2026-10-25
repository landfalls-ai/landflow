/**
 * The audit log (lib/server/audit): who did what, when and from where, kept in `audit_events`, emitted as OTel log
 * records and streamed to SIEM destinations through a durable outbox. Shapes shared by the API (/api/audit,
 * /api/settings/audit) and Settings → Audit log. No runtime imports beyond plain data.
 */

export type AuditOutcome = 'success' | 'failure' | 'denied';
export type AuditActorType = 'user' | 'api_key' | 'system' | 'anonymous';
/** Detail values are flat: ids, names, counts and flags, never request bodies or secrets. */
export type AuditValue = string | number | boolean | null | string[];

export interface AuditActor {
  type: AuditActorType;
  id?: string;
  /** Name and email as they were when the event happened (users can be renamed or removed later). */
  name?: string;
  email?: string;
}

export interface AuditTarget {
  type: string;
  id?: string;
  name?: string;
}

/** One audit event (GET /api/audit). */
export interface AuditEvent {
  /** Sortable by time: `aud_<ms><counter><random>`. */
  id: string;
  at: string;
  /** `<category>.<verb>`: `workflow.publish`, `auth.sign_in_failed`; `api.request` for the generic request layer. */
  action: string;
  category: string;
  outcome: AuditOutcome;
  actor: AuditActor;
  /** The API key the request used (its id, never the key). */
  apiKeyId?: string;
  ip?: string;
  userAgent?: string;
  requestId?: string;
  method?: string;
  /** The route pattern (`/api/workflows/[id]/publish`), never the raw URL or its query string. */
  route?: string;
  status?: number;
  target?: AuditTarget;
  summary: string;
  details?: Record<string, AuditValue>;
}

/** The domain events Landflow records, by action (the generic layer adds `api.request` for every other change). */
export const AUDIT_ACTIONS: Record<string, string> = {
  'auth.sign_in': 'Signed in',
  'auth.sign_in_failed': 'Failed sign-in',
  'auth.sign_out': 'Signed out',
  'auth.setup': 'Created the owner account',
  'auth.password_reset_request': 'Password reset link made',
  'auth.password_reset': 'Password reset',
  'user.invite': 'Invited a user',
  'user.invite_revoke': 'Revoked an invite',
  'user.invite_accept': 'Accepted an invite',
  'user.role_change': 'Changed a role',
  'user.remove': 'Removed a user',
  'api_key.create': 'Created an API key',
  'api_key.revoke': 'Revoked an API key',
  'workflow.create': 'Created a workflow',
  'workflow.update': 'Saved a workflow',
  'workflow.delete': 'Deleted a workflow',
  'workflow.import': 'Imported a workflow',
  'workflow.publish': 'Published a workflow',
  'workflow.rollback': 'Rolled a workflow back',
  'workflow.unpublish': 'Unpublished a workflow',
  'publish_request.create': 'Asked for publish approval',
  'publish_request.approve': 'Approved a publish',
  'publish_request.reject': 'Rejected a publish',
  'publish_request.cancel': 'Withdrew a publish request',
  'publish_request.stale': 'Publish request went stale',
  'publish_request.fail': 'Approved publish failed',
  'credential.create': 'Created a credential',
  'credential.update': 'Changed a credential',
  'credential.delete': 'Deleted a credential',
  'credential.use': 'Used a credential in a run',
  'settings.update': 'Changed settings',
  'execution.delete': 'Deleted an execution',
  'execution.stop': 'Stopped an execution',
  'execution.stop_all': 'Stopped all executions',
  'source_control.push': 'Pushed to Git',
  'source_control.pull': 'Pulled from Git',
  'sync.apply': 'Applied Git sync files',
  'plugin.register': 'Registered a plugin',
  'plugin.remove': 'Removed a plugin',
  'marketplace.install': 'Installed from a marketplace',
  'marketplace.uninstall': 'Uninstalled a marketplace plugin',
  'audit.export': 'Exported the audit log',
  'audit.test': 'Sent a test audit event',
  'api.request': 'API request',
};

/** Filters of GET /api/audit and /api/audit/export (query parameters of the same names). */
export interface AuditFilters {
  /** A user id, or part of a name or email. */
  actor?: string;
  /** Exact actions, or `workflow.*` for a whole category; comma-separated in the query. */
  action?: string[];
  targetType?: string;
  targetId?: string;
  outcome?: AuditOutcome;
  /** ISO times, inclusive. */
  from?: string;
  to?: string;
  /** Text in the summary or target name. */
  q?: string;
}

/** GET /api/audit */
export interface AuditPage {
  events: AuditEvent[];
  /** Pass as `cursor` for the next (older) page; absent on the last page. */
  nextCursor?: string;
}

/** Instance audit settings (Settings → Audit log). */
export interface AuditSettings {
  /** Days events are kept; 0 keeps them forever. */
  retentionDays: number;
  /** Record which credentials each run used (ids and names, never values). */
  credentialUse: boolean;
}

export const DEFAULT_AUDIT_SETTINGS: AuditSettings = { retentionDays: 365, credentialUse: true };

export type AuditDestinationKind = 'syslog' | 'http' | 'splunk';
/** The HTTP sink's flavours: JSON lines with an HMAC signature, Datadog's logs intake, or Elasticsearch's bulk API. */
export type AuditHttpPreset = 'generic' | 'datadog' | 'elastic';
export type SyslogProtocol = 'udp' | 'tcp' | 'tls';

/** A destination's settings; secret ones (`secret`, `apiKey`, `token`) never come back from the API (`secretsSet` lists those set). */
export interface AuditDestinationConfig {
  /** syslog: where, RFC 5424 over UDP, TCP or TLS. */
  host?: string;
  port?: number;
  protocol?: SyslogProtocol;
  /** syslog: 0–23 (default 13, "log audit"). */
  facility?: number;
  /** syslog: APP-NAME (default `landflow`). */
  appName?: string;
  /** syslog over TCP/TLS: RFC 6587 octet counting (default) or a newline after each message. */
  framing?: 'octet-counting' | 'newline';
  /** syslog over TLS: check the server's certificate (default true), against this CA (PEM) when given. */
  rejectUnauthorized?: boolean;
  ca?: string;
  /** http and splunk: the endpoint (Splunk: the HEC base URL, e.g. https://splunk:8088). */
  url?: string;
  preset?: AuditHttpPreset;
  /** http (generic): signs each body (`X-Landflow-Signature: sha256=HMAC(secret, "<timestamp>.<body>")`). Secret. */
  secret?: string;
  /** http (datadog: DD-API-KEY; elastic: `Authorization: ApiKey …`). Secret. */
  apiKey?: string;
  /** splunk: the HEC token. Secret. */
  token?: string;
  /** elastic: the index or data stream; splunk: the index. */
  index?: string;
  /** splunk: `source` and `sourcetype` (default `landflow` and `landflow:audit`). */
  source?: string;
  sourcetype?: string;
  /** datadog: `ddtags` (comma-separated `key:value`). */
  tags?: string;
}

export const AUDIT_SECRET_FIELDS = ['secret', 'apiKey', 'token'] as const;

export interface AuditDelivery {
  at: string;
  ok: boolean;
  message?: string;
}

/** A SIEM destination with where its outbox stands. */
export interface AuditDestination {
  id: string;
  name: string;
  kind: AuditDestinationKind;
  enabled: boolean;
  config: AuditDestinationConfig;
  secretsSet: string[];
  createdAt: string;
  updatedAt: string;
  /** Events waiting in the outbox, the oldest one's time, and the last delivery attempt. */
  pending: number;
  oldestPendingAt?: string;
  lastDelivery?: AuditDelivery;
}

export const AUDIT_DESTINATION_KINDS: readonly { id: AuditDestinationKind; label: string; hint: string }[] = [
  { id: 'syslog', label: 'Syslog', hint: 'RFC 5424 over UDP, TCP or TLS (rsyslog, syslog-ng, Vector, most SIEMs)' },
  { id: 'http', label: 'HTTP', hint: 'JSON lines with an HMAC signature; presets for Datadog logs and Elasticsearch' },
  { id: 'splunk', label: 'Splunk HEC', hint: 'Splunk’s HTTP Event Collector with a HEC token' },
];

/** GET /api/settings/audit */
export interface AuditSettingsView {
  settings: AuditSettings;
  destinations: AuditDestination[];
  /** Events also go out as OTel log records when OTLP export is configured (OTEL_EXPORTER_OTLP_ENDPOINT). */
  otlp: { enabled: boolean; endpoint?: string };
  /** Events stored now. */
  stored: number;
}
