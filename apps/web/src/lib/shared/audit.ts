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
  /** The project of the target (a workflow, credential, data table or agent's home project, an execution's workflow's, a project itself). */
  projectId?: string;
  summary: string;
  details?: Record<string, AuditValue>;
  /** Its link in the hash chain (lib/server/audit/chain.ts); absent for events from before the chain began, or not sealed yet. */
  chain?: AuditChainLink;
}

/** An event's place in the tamper-evident chain: its sequence number, the previous event's hash and its own (SHA-256, hex). */
export interface AuditChainLink {
  seq: number;
  prevHash: string;
  hash: string;
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
  'promotion_request.create': 'Asked for promotion approval',
  'promotion_request.approve': 'Approved a promotion',
  'promotion_request.reject': 'Rejected a promotion',
  'promotion_request.cancel': 'Withdrew a promotion request',
  'promotion_request.stale': 'Promotion request went stale',
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
  'audit.verify': 'Verified the audit log’s hash chain',
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
  /** The event's project (see AuditEvent.projectId). */
  projectId?: string;
  outcome?: AuditOutcome;
  /** ISO times, inclusive. */
  from?: string;
  to?: string;
  /** Text in the summary or target name. */
  q?: string;
}

/** GET /api/audit/verify: whether the stored events still form an unbroken hash chain. */
export interface AuditChainReport {
  ok: boolean;
  /** Chained events checked, and the first and last sequence numbers among them. */
  checked: number;
  firstSeq?: number;
  lastSeq?: number;
  /** The newest chained event as the chain records it, and the last event retention pruned (the chain goes on from its hash). */
  head?: { seq: number; hash: string; eventId?: string; at?: string };
  anchor?: { seq: number; hash: string; eventId?: string; at?: string };
  /** Events not chained yet (queue mode on Postgres seals them within seconds). */
  pending: number;
  /** Events from before the chain began (not chained). */
  legacy: number;
  /** The first problem: the sequence number where the chain breaks, the event there (when it still exists) and why. */
  brokenAt?: AuditChainProblem;
  /** Up to 20 problems, in chain order. */
  problems: AuditChainProblem[];
  verifiedAt: string;
}

export interface AuditChainProblem {
  seq?: number;
  eventId?: string;
  at?: string;
  reason: string;
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

/** A destination's settings; secret ones (`secret`, `apiKey`, `token`, `clientKey`, `clientKeyPassphrase`) never come back from the API (`secretsSet` lists those set). */
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
  /** TLS (syslog over TLS, https destinations): check the server's certificate (default true), against this CA (PEM) when given. */
  rejectUnauthorized?: boolean;
  ca?: string;
  /** mTLS: the client certificate (PEM, may include its chain) Landflow presents, its private key (PEM; secret) and the key's passphrase (secret). */
  clientCert?: string;
  clientKey?: string;
  clientKeyPassphrase?: string;
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

export const AUDIT_SECRET_FIELDS = ['secret', 'apiKey', 'token', 'clientKey', 'clientKeyPassphrase'] as const;

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
  /** The client certificate's subject, issuer and expiry, when mTLS is set up. */
  clientCertificate?: { subject: string; issuer: string; validTo: string; fingerprint: string };
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
