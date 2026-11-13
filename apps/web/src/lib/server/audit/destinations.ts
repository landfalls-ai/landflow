/**
 * SIEM destinations (Settings → Audit log): syslog (RFC 5424 over UDP, TCP or TLS), HTTP (JSON lines signed with
 * HMAC, or the Datadog and Elastic presets) and Splunk HEC, in the `audit_destinations` table. Secret settings
 * (`secret`, `apiKey`, `token`, and a client certificate's `clientKey` and `clientKeyPassphrase`) are sealed with the
 * credentials key and never leave the server; a PATCH that leaves one empty keeps the saved value (a PATCH without
 * `clientCert` drops the client certificate and its key). Syslog over TLS and HTTPS destinations can trust a private
 * CA and present a client certificate (mTLS); the certificate and key are checked to belong together when saved.
 * Disabling a destination stops queueing new events for it (queued ones wait); deleting it drops its outbox. A destination's `scope`
 * (migration-free: part of its data) limits it to chosen projects' events, plus instance-wide ones when `instance` is true; without
 * one it receives everything. The scope is applied when an event is queued (./store), so changing it affects new events only.
 */
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { AUDIT_SECRET_FIELDS, type AuditDelivery, type AuditDestination, type AuditDestinationScope, type AuditDestinationConfig, type AuditDestinationKind } from '../../shared/audit';
import { certificateInfo, keyPairProblem, pemCertificates } from '../auth/x509';
import { credentials } from '../credentials/vault';
import { database } from '../db';
import { parse } from '../db/rows';
import { HttpError } from '../errors';

export class AuditDestinationError extends HttpError {
  constructor(
    message: string,
    status = 400,
  ) {
    super(message, status, { expose: true });
  }
}

interface Row {
  id: string;
  name: string;
  kind: AuditDestinationKind;
  enabled: number;
  created_at: string;
  updated_at: string;
  data: string;
}

interface Data {
  config: AuditDestinationConfig;
  /** Which events it receives (absent: every event). */
  scope?: AuditDestinationScope;
  lastDelivery?: AuditDelivery;
}

const SECRET = new Set<string>(AUDIT_SECRET_FIELDS);
/** Secrets that belong to the client certificate: dropped with it. */
const CLIENT_SECRETS = new Set(['clientKey', 'clientKeyPassphrase']);

const configSchema = z.strictObject({
  host: z.string().max(255).optional(),
  port: z.number().int().min(1).max(65_535).optional(),
  protocol: z.enum(['udp', 'tcp', 'tls']).optional(),
  facility: z.number().int().min(0).max(23).optional(),
  appName: z.string().max(48).optional(),
  framing: z.enum(['octet-counting', 'newline']).optional(),
  rejectUnauthorized: z.boolean().optional(),
  ca: z.string().max(50_000).optional(),
  clientCert: z.string().max(50_000).optional(),
  clientKey: z.string().max(20_000).optional(),
  clientKeyPassphrase: z.string().max(500).optional(),
  url: z.string().max(2_000).optional(),
  preset: z.enum(['generic', 'datadog', 'elastic']).optional(),
  secret: z.string().max(500).optional(),
  apiKey: z.string().max(500).optional(),
  token: z.string().max(500).optional(),
  index: z.string().max(200).optional(),
  source: z.string().max(200).optional(),
  sourcetype: z.string().max(200).optional(),
  tags: z.string().max(1_000).optional(),
});

/** The projects a destination receives events of, and whether it also gets instance-wide events; `null` means every event. */
const scopeSchema = z.strictObject({ projectIds: z.array(z.string().trim().min(1).max(100)).max(500), instance: z.boolean() });

export const destinationCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  kind: z.enum(['syslog', 'http', 'splunk']),
  enabled: z.boolean().default(true),
  config: configSchema.default({}),
  scope: scopeSchema.nullable().optional(),
});
export const destinationPatchSchema = z.object({ name: z.string().trim().min(1).max(120), enabled: z.boolean(), config: configSchema, scope: scopeSchema.nullable() }).partial();

/** A scope with its project ids checked and de-duplicated; `null` or absent: no scope (every event). */
function checkedScope(scope: z.infer<typeof scopeSchema> | null | undefined): AuditDestinationScope | undefined {
  if (!scope) return undefined;
  const projectIds = [...new Set(scope.projectIds)];
  const known = new Set(projectIds.length ? database().all<{ id: string }>(`SELECT id FROM projects WHERE id IN (${projectIds.map(() => '?').join(', ')})`, ...projectIds).map((row) => row.id) : []);
  const unknown = projectIds.filter((id) => !known.has(id));
  if (unknown.length) throw new AuditDestinationError(`Unknown project${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}`);
  if (!projectIds.length && !scope.instance) throw new AuditDestinationError('Choose at least one project, or instance events: a destination with neither would receive nothing');
  return { projectIds, instance: scope.instance };
}

function httpUrl(value: string | undefined, what: string): string {
  if (!value?.trim()) throw new AuditDestinationError(`Enter the ${what}`);
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new AuditDestinationError(`The ${what} is not a valid URL`);
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new AuditDestinationError(`The ${what} must start with http:// or https://`);
  return url.toString();
}

/** TLS settings (unsealed): the CA to trust or no verification, and the client certificate with its key (mTLS). */
function tlsSettings(config: AuditDestinationConfig): AuditDestinationConfig {
  if (config.ca && !pemCertificates(config.ca).length) throw new AuditDestinationError('The CA certificate isn’t a PEM certificate (-----BEGIN CERTIFICATE-----)');
  if (config.clientKey && !config.clientCert) throw new AuditDestinationError('Enter the client certificate for the private key');
  if (config.clientCert) {
    if (!config.clientKey) throw new AuditDestinationError('Enter the client certificate’s private key');
    const problem = keyPairProblem(config.clientCert, config.clientKey, config.clientKeyPassphrase);
    if (problem) throw new AuditDestinationError(`Client certificate: ${problem}`);
  }
  return {
    ...(config.rejectUnauthorized === false && { rejectUnauthorized: false }),
    ...(config.ca && { ca: config.ca }),
    ...(config.clientCert && { clientCert: config.clientCert, clientKey: config.clientKey, ...(config.clientKeyPassphrase && { clientKeyPassphrase: config.clientKeyPassphrase }) }),
  };
}

const https = (url: string) => url.startsWith('https:');

/** The settings `kind` uses, checked and trimmed (unsealed). */
function checked(kind: AuditDestinationKind, input: AuditDestinationConfig): AuditDestinationConfig {
  const config = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v])) as AuditDestinationConfig;
  switch (kind) {
    case 'syslog': {
      if (!config.host) throw new AuditDestinationError('Enter the syslog host');
      const protocol = config.protocol ?? 'udp';
      return {
        host: config.host,
        port: config.port ?? (protocol === 'tls' ? 6514 : 514),
        protocol,
        facility: config.facility ?? 13,
        appName: (config.appName || 'landflow').replace(/[^\x21-\x7e]/g, '').slice(0, 48) || 'landflow',
        ...(protocol !== 'udp' && { framing: config.framing ?? 'octet-counting' }),
        ...(protocol === 'tls' && { rejectUnauthorized: config.rejectUnauthorized ?? true, ...tlsSettings(config) }),
      };
    }
    case 'http': {
      const preset = config.preset ?? 'generic';
      const url = httpUrl(config.url ?? (preset === 'datadog' ? 'https://http-intake.logs.datadoghq.com/api/v2/logs' : undefined), preset === 'elastic' ? 'Elasticsearch URL' : 'URL');
      if (preset === 'elastic' && !config.index) throw new AuditDestinationError('Enter the Elasticsearch index or data stream');
      return {
        preset,
        url,
        ...(config.secret && preset === 'generic' && { secret: config.secret }),
        ...(config.apiKey && preset !== 'generic' && { apiKey: config.apiKey }),
        ...(config.index && preset === 'elastic' && { index: config.index }),
        ...(config.tags && preset === 'datadog' && { tags: config.tags }),
        ...(https(url) && tlsSettings(config)),
      };
    }
    case 'splunk': {
      const url = httpUrl(config.url, 'Splunk HEC URL');
      return {
        url,
        ...(config.token && { token: config.token }),
        ...(config.index && { index: config.index }),
        source: config.source || 'landflow',
        sourcetype: config.sourcetype || 'landflow:audit',
        ...(https(url) && tlsSettings(config)),
      };
    }
  }
}

const seal = (config: AuditDestinationConfig): AuditDestinationConfig =>
  Object.fromEntries(Object.entries(config).map(([k, v]) => [k, SECRET.has(k) && v ? credentials.sealSecret(String(v)) : v])) as AuditDestinationConfig;

function open(config: AuditDestinationConfig): AuditDestinationConfig {
  return Object.fromEntries(
    Object.entries(config).map(([k, v]) => {
      if (!SECRET.has(k) || !v) return [k, v];
      try {
        return [k, credentials.openSecret(String(v))];
      } catch {
        return [k, undefined];
      }
    }),
  ) as AuditDestinationConfig;
}

interface OutboxStats {
  pending: number;
  oldest?: string;
}

function outboxStats(): Map<string, OutboxStats> {
  return new Map(
    database()
      .all<{ destination_id: string; n: number; oldest: string | null }>('SELECT destination_id, COUNT(*) AS n, MIN(created_at) AS oldest FROM audit_outbox GROUP BY destination_id')
      .map((row) => [row.destination_id, { pending: Number(row.n), ...(row.oldest && { oldest: row.oldest }) }]),
  );
}

/** What Settings shows of the client certificate (none when it can't be read). */
function clientCertificate(cert: string | undefined): AuditDestination['clientCertificate'] {
  if (!cert) return undefined;
  try {
    const { subject, issuer, validTo, fingerprint } = certificateInfo(cert);
    return { subject, issuer, validTo, fingerprint };
  } catch {
    return undefined;
  }
}

function view(row: Row, stats?: OutboxStats): AuditDestination {
  const data = parse<Data>(row.data) ?? { config: {} };
  const cert = clientCertificate(data.config.clientCert);
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    enabled: Boolean(Number(row.enabled)),
    config: Object.fromEntries(Object.entries(data.config).filter(([k]) => !SECRET.has(k))) as AuditDestinationConfig,
    secretsSet: Object.keys(data.config).filter((k) => SECRET.has(k) && (data.config as Record<string, unknown>)[k]),
    ...(data.scope && { scope: data.scope }),
    ...(cert && { clientCertificate: cert }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    pending: stats?.pending ?? 0,
    ...(stats?.oldest && { oldestPendingAt: stats.oldest }),
    ...(data.lastDelivery && { lastDelivery: data.lastDelivery }),
  };
}

export type SendableDestination = Pick<AuditDestination, 'id' | 'name' | 'kind'> & { config: AuditDestinationConfig };

export const auditDestinations = {
  list(): AuditDestination[] {
    const stats = outboxStats();
    return database()
      .all<Row>('SELECT * FROM audit_destinations ORDER BY name, id')
      .map((row) => view(row, stats.get(row.id)));
  },

  get(id: string): AuditDestination | undefined {
    const row = database().get<Row>('SELECT * FROM audit_destinations WHERE id = ?', id);
    return row && view(row, outboxStats().get(id));
  },

  /** With secrets unsealed, for sending. */
  forSending(id: string): (SendableDestination & { enabled: boolean }) | undefined {
    const row = database().get<Row>('SELECT * FROM audit_destinations WHERE id = ?', id);
    if (!row) return undefined;
    const data = parse<Data>(row.data) ?? { config: {} };
    return { id: row.id, name: row.name, kind: row.kind, enabled: Boolean(Number(row.enabled)), config: open(data.config) };
  },

  create(input: z.infer<typeof destinationCreateSchema>): AuditDestination {
    const config = checked(input.kind, input.config);
    if (input.kind === 'splunk' && !config.token) throw new AuditDestinationError('Enter the HEC token');
    const scope = checkedScope(input.scope);
    const now = new Date().toISOString();
    const id = `adst_${nanoid(12)}`;
    database().upsert('audit_destinations', { id, name: input.name, kind: input.kind, enabled: input.enabled, created_at: now, updated_at: now, data: JSON.stringify({ config: seal(config), ...(scope && { scope }) } satisfies Data) });
    return this.get(id)!;
  },

  update(id: string, patch: z.infer<typeof destinationPatchSchema>): AuditDestination {
    const row = database().get<Row>('SELECT * FROM audit_destinations WHERE id = ?', id);
    if (!row) throw new AuditDestinationError('Audit destination not found', 404);
    const data = parse<Data>(row.data) ?? { config: {} };
    const current = open(data.config);
    let config = data.config;
    if (patch.config) {
      // Empty secret fields keep their saved value (the client certificate's only while it stays).
      const merged = { ...patch.config };
      for (const key of SECRET) {
        if ((merged as Record<string, unknown>)[key] || (CLIENT_SECRETS.has(key) && !merged.clientCert?.trim())) continue;
        (merged as Record<string, unknown>)[key] = (current as Record<string, unknown>)[key];
      }
      config = seal(checked(row.kind, merged));
    }
    // A new scope applies to events recorded from now on; what is queued stays queued.
    const scope = patch.scope === undefined ? data.scope : checkedScope(patch.scope);
    const { scope: _old, ...rest } = data;
    database().upsert('audit_destinations', {
      id,
      name: patch.name ?? row.name,
      kind: row.kind,
      enabled: patch.enabled ?? Boolean(Number(row.enabled)),
      created_at: row.created_at,
      updated_at: new Date().toISOString(),
      data: JSON.stringify({ ...rest, config, ...(scope && { scope }) } satisfies Data),
    });
    return this.get(id)!;
  },

  remove(id: string): boolean {
    const db = database();
    return db.transaction(() => {
      db.delete('audit_outbox', { destination_id: id });
      return db.delete('audit_destinations', { id }) > 0;
    });
  },

  /** Remember the last delivery attempt (shown in Settings). */
  noteDelivery(id: string, delivery: AuditDelivery) {
    const row = database().get<Row>('SELECT * FROM audit_destinations WHERE id = ?', id);
    if (!row) return;
    const data = parse<Data>(row.data) ?? { config: {} };
    database().upsert('audit_destinations', { ...row, data: JSON.stringify({ ...data, lastDelivery: { ...delivery, ...(delivery.message && { message: delivery.message.slice(0, 300) }) } }) });
  },
};
