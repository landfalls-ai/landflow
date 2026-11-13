/**
 * Broker connections (docs/transports.md, "Broker connection"): one installed broker on the host side, e.g.
 * `kafka-main`, in the `transport_connections` table (migration 1701). Secret fields are sealed with the credential
 * vault's key (`credentials.sealSecret`, AES-256-GCM, like credentials) and only opened for the provider; the API sees
 * which of them are set, never their values. `LANDFLOW_TRANSPORT_<KIND>_URL` adds a read-only connection per kind
 * (`env-<kind>`) without a row.
 *
 * `test(id)` asks the kind's provider for a round trip; a kind without a driver answers "No driver for <kind> yet", so
 * an admin can save connections for brokers whose driver lands in a later wave. Every change is audited like other
 * settings (`settings.update` on the `transports` settings target).
 */
import { randomBytes } from 'node:crypto';
import { BROKER_TRANSPORT_KINDS } from '@landflow/protocol';
import { transportLabel, type TransportConnectionCheck, type TransportConnectionView, type TransportKind } from '../../shared/transports';
import { recordAudit } from '../audit';
import { credentials } from '../credentials/vault';
import { database, type Database } from '../db';
import { parse } from '../db/rows';
import { singleton } from '../singleton';
import { logger } from '../telemetry/logger';
import { transportProviders, type TransportConnectionConfig, type TransportProviderRegistry } from './provider';
import { HttpError } from '../errors';

export class TransportError extends HttpError {
  constructor(
    message: string,
    status = 400,
  ) {
    super(message, status, { expose: true });
    this.name = 'TransportError';
  }
}

/** A connection as stored, secrets opened. */
export interface StoredConnection {
  id: string;
  name: string;
  kind: TransportKind;
  enabled: boolean;
  config: Record<string, string | boolean>;
  secrets: Record<string, string>;
  lastCheck?: TransportConnectionCheck;
  source: 'database' | 'env';
  createdAt: string;
  updatedAt: string;
}

export interface ConnectionInput {
  name: string;
  kind: TransportKind;
  enabled?: boolean;
  config?: Record<string, string | boolean>;
  /** Secret fields; an empty string keeps the saved value on update, null clears it. */
  secrets?: Record<string, string | null>;
}

interface Row {
  id: string;
  name: string;
  kind: string;
  enabled: number;
  config: string;
  secrets: string | null;
  last_check: string | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
}

const COLUMNS = 'id, name, kind, enabled, config, secrets, last_check, created_at, updated_at, created_by';
const NAME = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,63}$/;
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const KIND = /^[a-z][a-z0-9+.-]{0,31}$/;
const ENV_PREFIX = 'env-';

function fromRow(row: Row): StoredConnection {
  let secrets: Record<string, string> = {};
  if (row.secrets) {
    try {
      secrets = JSON.parse(credentials.openSecret(row.secrets)) as Record<string, string>;
    } catch {
      // Sealed with another key: the connection can't open until its secrets are entered again.
      secrets = {};
    }
  }
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    enabled: Boolean(row.enabled),
    config: parse<Record<string, string | boolean>>(row.config) ?? {},
    secrets,
    ...(row.last_check && { lastCheck: parse<TransportConnectionCheck>(row.last_check) }),
    source: 'database',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** `LANDFLOW_TRANSPORT_KAFKA_URL=…` → a read-only `env-kafka` connection; the URL's user info becomes the secrets. */
export function envConnections(env: NodeJS.ProcessEnv = process.env): StoredConnection[] {
  const out: StoredConnection[] = [];
  for (const [key, raw] of Object.entries(env)) {
    const match = /^LANDFLOW_TRANSPORT_([A-Z0-9]+)_URL$/.exec(key);
    const value = raw?.trim();
    if (!match || !value) continue;
    const kind = match[1]!.toLowerCase();
    if (kind === 'http' || kind === 'grpc') continue;
    const { url, secrets } = splitUserInfo(value);
    out.push({
      id: `${ENV_PREFIX}${kind}`,
      name: `${transportLabel(kind)} (environment)`,
      kind,
      enabled: true,
      config: { url },
      secrets,
      source: 'env',
      createdAt: '',
      updatedAt: '',
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** A URL without its user info, plus the username and password it carried (never shown, never stored in `config`). */
function splitUserInfo(value: string): { url: string; secrets: Record<string, string> } {
  const match = /^([a-z][a-z0-9+.-]*:\/\/)([^@/]+)@(.*)$/i.exec(value);
  if (!match) return { url: value, secrets: {} };
  const [user, ...rest] = match[2]!.split(':');
  const password = rest.join(':');
  return { url: `${match[1]}${match[3]}`, secrets: { ...(user && { username: decodeURIComponent(user) }), ...(password && { password: decodeURIComponent(password) }) } };
}

/** A URL in `config` shown without user info, should one have been pasted there. */
const maskUrl = (value: string | boolean) => (typeof value === 'string' && /:\/\/[^@/]+@/.test(value) ? value.replace(/(:\/\/)[^@/]+@/, '$1•••@') : value);

export function viewOf(connection: StoredConnection, plugins: string[] = []): TransportConnectionView {
  return {
    id: connection.id,
    name: connection.name,
    kind: connection.kind,
    enabled: connection.enabled,
    config: Object.fromEntries(Object.entries(connection.config).map(([k, v]) => [k, maskUrl(v)])),
    secretsSet: Object.keys(connection.secrets).filter((key) => connection.secrets[key] !== ''),
    source: connection.source,
    ...(connection.lastCheck && { lastCheck: connection.lastCheck }),
    plugins,
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt,
  };
}

/** The connection as a provider receives it. */
export const configOf = (connection: StoredConnection): TransportConnectionConfig => ({ id: connection.id, kind: connection.kind, config: connection.config, secrets: connection.secrets });

export interface ConnectionStoreOptions {
  db?: () => Database;
  providers?: TransportProviderRegistry;
  env?: NodeJS.ProcessEnv;
}

/** What changed, for listeners in this process (other processes hear it through the replication broadcast). */
export type ConnectionChange = { type: 'created' | 'updated' | 'deleted'; id: string };

export class TransportConnections {
  private readonly db: () => Database;
  private readonly providers: TransportProviderRegistry;
  private readonly env: NodeJS.ProcessEnv;
  private readonly listeners = new Set<(change: ConnectionChange) => void>();

  constructor(options: ConnectionStoreOptions = {}) {
    this.db = options.db ?? database;
    this.providers = options.providers ?? transportProviders;
    this.env = options.env ?? process.env;
  }

  /** Hear about connections created, changed or deleted through this store (the broker manager reopens them). */
  subscribe(listener: (change: ConnectionChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(change: ConnectionChange) {
    for (const listener of this.listeners) {
      try {
        listener(change);
      } catch (error) {
        logger.warn('transport connection listener failed', { error });
      }
    }
  }

  /** Saved connections (by name), then the environment's. */
  list(): StoredConnection[] {
    const rows = this.db().all<Row>(`SELECT ${COLUMNS} FROM transport_connections ORDER BY name, id`).map(fromRow);
    return [...rows, ...envConnections(this.env)];
  }

  get(id: string): StoredConnection | undefined {
    if (id.startsWith(ENV_PREFIX)) return envConnections(this.env).find((c) => c.id === id);
    const row = this.db().get<Row>(`SELECT ${COLUMNS} FROM transport_connections WHERE id = ?`, id);
    return row ? fromRow(row) : undefined;
  }

  /** Enabled connections of one kind (what a provider opens). */
  ofKind(kind: TransportKind): StoredConnection[] {
    return this.list().filter((c) => c.kind === kind && c.enabled);
  }

  create(input: ConnectionInput & { id?: string }, createdBy?: string): StoredConnection {
    const name = input.name.trim();
    if (!NAME.test(name)) throw new TransportError('A connection name has 1–64 letters, digits, spaces, “_”, “.” or “-”');
    if (!KIND.test(input.kind)) throw new TransportError('Choose a transport kind');
    const provider = this.providers.get(input.kind);
    if (provider?.direct) throw new TransportError(`${provider.label} is a direct transport: plugins are reached at their own address, no connection needed`);
    if (!provider && !(BROKER_TRANSPORT_KINDS as readonly string[]).includes(input.kind)) throw new TransportError(`Unknown transport kind “${input.kind}”`);
    const id = input.id ?? newId(name);
    if (!ID.test(id) || id.startsWith(ENV_PREFIX)) throw new TransportError('A connection id has lower-case letters, digits and “-”, and doesn’t start with “env-”');
    if (this.get(id)) throw new TransportError(`A connection with id “${id}” already exists`, 409);
    if (this.list().some((c) => c.name.toLowerCase() === name.toLowerCase())) throw new TransportError(`A connection named “${name}” already exists`, 409);
    const now = new Date().toISOString();
    const connection: StoredConnection = {
      id,
      name,
      kind: input.kind,
      enabled: input.enabled ?? true,
      config: cleanConfig(input.config),
      secrets: cleanSecrets(input.secrets, {}),
      source: 'database',
      createdAt: now,
      updatedAt: now,
    };
    this.save(connection, createdBy);
    recordAudit({
      action: 'settings.update',
      target: { type: 'settings', id: 'transports', name: 'Transports' },
      summary: `Added transport connection ${name} (${transportLabel(connection.kind)})`,
      details: { connectionId: id, kind: connection.kind, enabled: connection.enabled, fields: Object.keys(connection.config), secrets: Object.keys(connection.secrets) },
    });
    this.notify({ type: 'created', id });
    return connection;
  }

  update(id: string, input: Partial<ConnectionInput>): StoredConnection {
    const previous = this.get(id);
    if (!previous) throw new TransportError('Connection not found', 404);
    if (previous.source === 'env') throw new TransportError(`${previous.name} comes from the environment (LANDFLOW_TRANSPORT_${previous.kind.toUpperCase()}_URL): change it there`, 409);
    if (input.kind && input.kind !== previous.kind) throw new TransportError('A connection’s kind can’t change: add another connection');
    const name = input.name?.trim() ?? previous.name;
    if (!NAME.test(name)) throw new TransportError('A connection name has 1–64 letters, digits, spaces, “_”, “.” or “-”');
    if (name !== previous.name && this.list().some((c) => c.id !== id && c.name.toLowerCase() === name.toLowerCase())) throw new TransportError(`A connection named “${name}” already exists`, 409);
    const connection: StoredConnection = {
      ...previous,
      name,
      enabled: input.enabled ?? previous.enabled,
      config: input.config ? cleanConfig(input.config) : previous.config,
      secrets: input.secrets ? cleanSecrets(input.secrets, previous.secrets) : previous.secrets,
      updatedAt: new Date().toISOString(),
    };
    this.save(connection);
    const changed = (['name', 'enabled', 'config', 'secrets'] as const).filter((key) => input[key] !== undefined);
    recordAudit({
      action: 'settings.update',
      target: { type: 'settings', id: 'transports', name: 'Transports' },
      summary: `Changed transport connection ${name}`,
      details: { connectionId: id, kind: connection.kind, enabled: connection.enabled, fields: changed },
    });
    this.notify({ type: 'updated', id });
    return connection;
  }

  delete(id: string): boolean {
    const previous = this.get(id);
    if (!previous) return false;
    if (previous.source === 'env') throw new TransportError(`${previous.name} comes from the environment: unset LANDFLOW_TRANSPORT_${previous.kind.toUpperCase()}_URL to remove it`, 409);
    const removed = this.db().delete('transport_connections', { id }) > 0;
    if (removed) {
      recordAudit({
        action: 'settings.update',
        target: { type: 'settings', id: 'transports', name: 'Transports' },
        summary: `Removed transport connection ${previous.name}`,
        details: { connectionId: id, kind: previous.kind },
      });
      this.notify({ type: 'deleted', id });
    }
    return removed;
  }

  /**
   * Test a saved connection (or, with `input`, an unsaved one: the form's Test before Save; secret fields left empty
   * fall back to the saved values). Without a driver for the kind the result says so and nothing is tried.
   */
  async test(id: string, input?: Partial<ConnectionInput>): Promise<TransportConnectionCheck> {
    const previous = this.get(id);
    const kind = input?.kind ?? previous?.kind;
    if (!kind) throw new TransportError('Connection not found', 404);
    const candidate: StoredConnection = {
      ...(previous ?? { id, name: input?.name ?? id, kind, enabled: true, config: {}, secrets: {}, source: 'database' as const, createdAt: '', updatedAt: '' }),
      ...(input?.config && { config: cleanConfig(input.config) }),
      ...(input?.secrets && { secrets: cleanSecrets(input.secrets, previous?.secrets ?? {}) }),
    };
    const at = new Date().toISOString();
    const provider = this.providers.get(kind);
    let check: TransportConnectionCheck;
    if (!provider?.test) {
      check = { ok: false, at, message: `No driver for ${transportLabel(kind)} yet — the connection is saved and will be tested once the driver is installed` };
    } else {
      const started = performance.now();
      try {
        const result = await provider.test(configOf(candidate));
        check = { ...result, at, latencyMs: result.latencyMs ?? Math.round(performance.now() - started) };
      } catch (error) {
        check = { ok: false, at, message: (error as Error).message };
        logger.warn('transport connection test failed', { 'landflow.transport.kind': kind, 'landflow.transport.connection': id, error });
      }
    }
    if (previous?.source === 'database') this.saveCheck(id, check);
    return check;
  }

  private save(connection: StoredConnection, createdBy?: string) {
    const hasSecrets = Object.values(connection.secrets).some((v) => v !== '' && v !== undefined);
    const row = this.db().get<Row>(`SELECT created_by FROM transport_connections WHERE id = ?`, connection.id);
    this.db().upsert('transport_connections', {
      id: connection.id,
      name: connection.name,
      kind: connection.kind,
      enabled: connection.enabled,
      config: JSON.stringify(connection.config),
      secrets: hasSecrets ? credentials.sealSecret(JSON.stringify(connection.secrets)) : null,
      last_check: connection.lastCheck ? JSON.stringify(connection.lastCheck) : null,
      created_at: connection.createdAt,
      updated_at: connection.updatedAt,
      created_by: row?.created_by ?? createdBy ?? null,
    });
  }

  /** Record a test without touching the settings (or `updated_at`). */
  private saveCheck(id: string, check: TransportConnectionCheck) {
    const row = this.db().get<Row>(`SELECT ${COLUMNS} FROM transport_connections WHERE id = ?`, id);
    if (!row) return;
    // Whole rows only: an upsert's insert half must satisfy NOT NULL on SQLite and Postgres.
    this.db().upsert('transport_connections', { ...row, last_check: JSON.stringify(check) });
  }
}

/** `Kafka main` → `kafka-main`, with a short random suffix when the name yields nothing usable. */
function newId(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug && !slug.startsWith('env-') ? slug : `conn-${randomBytes(4).toString('hex')}`;
}

function cleanConfig(config: Record<string, string | boolean> | undefined): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const [key, value] of Object.entries(config ?? {})) {
    if (typeof value === 'boolean') out[key] = value;
    else if (typeof value === 'string' && value.trim() !== '') out[key] = value.trim();
  }
  return out;
}

/** Secrets after an update: a value replaces, an empty string keeps the saved one, null clears it. */
function cleanSecrets(input: Record<string, string | null> | undefined, saved: Record<string, string>): Record<string, string> {
  const out = { ...saved };
  for (const [key, value] of Object.entries(input ?? {})) {
    if (value === null) delete out[key];
    else if (value !== '') out[key] = value;
  }
  return out;
}

/** One per process (route handlers and the bootstrap share it, so the broker manager hears every change). */
export const transportConnections = singleton('transport-connections', () => new TransportConnections());
