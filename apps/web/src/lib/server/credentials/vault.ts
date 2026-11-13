/**
 * Saved credentials, encrypted at rest with AES-256-GCM. Keys form a ring (./key-ring): LANDFLOW_ENCRYPTION_KEYS
 * (`kid:key,…`, the first seals) and the legacy key, LANDFLOW_ENCRYPTION_KEY (64 hex chars, or a passphrase) or one
 * generated once into <data dir>/encryption.key, as kid `k0`. Every blob names its key and is bound to its credential
 * id; `rotateCredentials` re-seals them with the primary key. Workflows only reference a
 * credential by id; decrypted values leave this module on their way to a node
 * (ExecuteRequest.credentials) or a TestCredentials call, never through the API.
 *
 * Where they are kept (../config-store.ts): `<data dir>/credentials.json` by default, or one row per credential in the
 * `credentials` table in queue mode (LANDFLOW_CONFIG_STORE=database), imported once from the file, which stays.
 *
 * OAuth2 credentials (core.oAuth2Api and types extending it) also hold their token, in the same sealed data
 * (`oauthTokenData`, see ./oauth2). The API reports a status instead of it; nodes get `accessToken` and are never
 * sent the refresh token. `refreshOAuth2` renews a token that is about to expire and saves it, and ./oauth2-runtime
 * calls it before a node runs (and once more when the node's API answered 401).
 */
import { createHmac, randomBytes } from 'node:crypto';
import { existsSync, linkSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { nanoid } from 'nanoid';
import { isPropertyVisible, splitType, withPropertyDefaults, type CredentialTypeDescriptor, type JsonObject, type NodeDescriptor } from '@landflow/protocol';
import type { CredentialRateLimit, WorkflowNode } from '@landflow/engine';
import { MCP_OAUTH2_CREDENTIAL, OAUTH2_CREDENTIAL } from '../../shared/oauth2';
import type { CredentialDetail, CredentialRateLimitSetting, CredentialSummary } from '../../shared/types';
import { configStoreKind, importOnce, onConfigChanged, writeJsonFile } from '../config-store';
import { database, type Database } from '../db';
import { registry } from '../plugins/registry';
import { installRedaction } from '../secrets/install';
import { redactText, rememberSecretValues } from '../secrets/redact';
import { resolveSecretFields, resolveSecretsIn } from '../secrets/resolve';
import { singleton } from '../singleton';
import { store } from '../store';
import { SECRET_KEY } from '../telemetry/config';
import { logger } from '../telemetry/logger';
import { buildKeyRing, hkdfKey, kidOf, LEGACY_KID, LEGACY_SHA_KID, openWith, sealWith, type KeyRing, type SealedValue } from './key-ring';
import {
  ACCOUNT_FIELD,
  clientCredentialsToken,
  ERROR_FIELD,
  META_FIELD,
  isExpiring,
  nodeTokenFields,
  oauth2Config,
  oauth2Status,
  refreshAccessToken,
  RESERVED_FIELDS,
  storedToken,
  tokenField,
  toStoredToken,
  TOKEN_FIELD,
  type OAuth2Config,
  type StoredToken,
} from './oauth2';

/** Credential values shorter than this are not remembered: `postgres` or `changeme` would otherwise rewrite every node output that says so. */
const CREDENTIAL_MIN_LENGTH = 12;

/** A sealed credential blob: v2 names its key and is bound to the credential id (./key-ring); v1 has neither. */
export type Sealed = SealedValue;

/** AAD of a credential's data: a blob copied to another row no longer opens. */
const credentialAad = (id: string) => `landflow:credential:${id}`;
/** AAD of a sealed string (`sealSecret`) that names no purpose. */
const DEFAULT_PURPOSE = 'secret';
const secretAad = (purpose: string) => `landflow:${purpose}`;

export interface StoredCredential {
  id: string;
  name: string;
  type: string;
  /** Names of the fields that were secret when saved, so they stay masked while the plugin is offline. */
  secretFields: string[];
  data: Sealed;
  /** At most `limit` calls per `intervalSeconds` across every node and run using it (kept in the clear: it is not secret). */
  rateLimit?: CredentialRateLimitSetting;
  createdAt: string;
  updatedAt: string;
}

/** A rate limit as saved: a whole number of calls, an interval of 0.1 s to a day; anything else is no limit. */
export function cleanRateLimit(value: unknown): CredentialRateLimitSetting | undefined {
  const v = value as Partial<CredentialRateLimitSetting> | null | undefined;
  const limit = Math.floor(Number(v?.limit));
  const intervalSeconds = Number(v?.intervalSeconds);
  if (!(limit >= 1) || !(intervalSeconds >= 0.1)) return undefined;
  return { limit: Math.min(limit, 100_000), intervalSeconds: Math.min(intervalSeconds, 86_400) };
}

/** `v2.<kid>.<iv>.<tag>.<ciphertext>` or the older `v1.<iv>.<tag>.<ciphertext>` as a sealed value; undefined for anything else. */
export function parseSealedString(text: string): SealedValue | undefined {
  const parts = text.split('.');
  if (parts[0] === 'v1' && parts.length === 4 && parts[1] && parts[2]) return { iv: parts[1], tag: parts[2], value: parts[3]! };
  if (parts[0] === 'v2' && parts.length === 5 && parts[1] && parts[2] && parts[3]) return { v: 2, kid: parts[1], iv: parts[2], tag: parts[3], value: parts[4]! };
  return undefined;
}

export class CredentialError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

/** The legacy key text (kid `k0`): the environment, else the key file. Generated only when no ring is configured. */
function loadLegacyKey(dir: string, ringConfigured: boolean): string | undefined {
  const configured = process.env.LANDFLOW_ENCRYPTION_KEY?.trim();
  if (configured) return configured;
  const path = join(dir, 'encryption.key');
  if (!existsSync(path)) {
    if (ringConfigured) return undefined;
    writeKeyOnce(path);
  }
  return readFileSync(path, 'utf8').trim();
}

/**
 * Create the key file atomically: write a temporary file, then hard-link it into place. The link fails when the key
 * already exists, so processes that start together (or test files sharing a data directory) agree on the first key,
 * and a reader never sees an empty or half-written file. A filesystem without hard links falls back to a rename.
 */
function writeKeyOnce(path: string): void {
  const temp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(temp, randomBytes(32).toString('hex'), { mode: 0o600 });
  try {
    linkSync(temp, path);
  } catch (error) {
    // EEXIST: another process won, keep its key. Anything else (no hard links here): rename, unless a key appeared.
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST' && !existsSync(path)) renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}

/** A value that is exactly one `{{ … }}` expression reading `$secrets` (lib/server/secrets resolves it when the credential is used). */
const isSecretReference = (value: unknown) => typeof value === 'string' && /^\s*=?\{\{[^{}]*\$secrets[^{}]*\}\}\s*$/.test(value);

const secretNames = (descriptor?: CredentialTypeDescriptor) => (descriptor?.properties ?? []).filter((p) => p.typeOptions?.password).map((p) => p.name);

/** Defaults first, then the saved values: a field added to the type later still gets its default. */
function withDefaults(descriptor: CredentialTypeDescriptor | undefined, data: JsonObject): JsonObject {
  const defaults = Object.fromEntries((descriptor?.properties ?? []).filter((p) => p.default !== undefined).map((p) => [p.name, p.default])) as JsonObject;
  return { ...defaults, ...data };
}

const reserved = new Set(RESERVED_FIELDS);
/** Data without the fields the host owns (an OAuth2 token, its account and error): what the API may write. */
const withoutReserved = <T extends Record<string, unknown>>(data: T): T => Object.fromEntries(Object.entries(data).filter(([key]) => !reserved.has(key))) as T;

/** Credential data handed to nodes, by the OAuth2 credential it came from: ./oauth2-runtime refreshes those before a call. */
const oauthOrigins = singleton('oauth2-origins', () => new WeakMap<object, string>());

/** Where the sealed credentials are kept: credentials.json, or the `credentials` table (../config-store.ts). */
export interface CredentialBackend {
  readonly kind: 'files' | 'database';
  /** Every stored credential. */
  load(): StoredCredential[];
  /** Save one change; `all` is every credential after it (the file holds them all). */
  save(change: { saved: StoredCredential } | { removed: string }, all: Iterable<StoredCredential>): void;
  /** Whether another process changed the credentials since the last load or save. */
  stale(): boolean;
}

/** credentials.json in the data directory (files mode). */
export class CredentialFile implements CredentialBackend {
  readonly kind = 'files' as const;
  /** When the file was last read or written here (queue mode with a shared data directory: other processes write it too). */
  private loadedAt = 0;

  constructor(readonly path: string) {}

  load(): StoredCredential[] {
    try {
      const mtime = statSync(this.path).mtimeMs;
      const saved = JSON.parse(readFileSync(this.path, 'utf8')) as { credentials: StoredCredential[] };
      this.loadedAt = mtime;
      return saved.credentials;
    } catch {
      // No credentials yet.
      return [];
    }
  }

  save(_change: { saved: StoredCredential } | { removed: string }, all: Iterable<StoredCredential>) {
    writeJsonFile(this.path, { version: 1, credentials: [...all] }, 0o600);
    this.loadedAt = statSync(this.path).mtimeMs;
  }

  stale(): boolean {
    try {
      return statSync(this.path).mtimeMs !== this.loadedAt;
    } catch {
      return false;
    }
  }
}

type CredentialRow = {
  id: string;
  name: string;
  type: string;
  secret_fields: string;
  data: string;
  rate_limit?: string | null;
  created_at: string;
  updated_at: string;
};

const credentialRow = (credential: StoredCredential): CredentialRow => ({
  id: credential.id,
  name: credential.name,
  type: credential.type,
  secret_fields: JSON.stringify(credential.secretFields ?? []),
  data: JSON.stringify(credential.data),
  rate_limit: credential.rateLimit ? JSON.stringify(credential.rateLimit) : null,
  created_at: credential.createdAt,
  updated_at: credential.updatedAt,
});

/** The `credentials` table (database mode, migration 1300): one row per credential; `file` is imported once. */
export class CredentialTable implements CredentialBackend {
  readonly kind = 'database' as const;
  private dirty = true;
  private stop?: () => void;

  constructor(
    private readonly file: string,
    private readonly db: () => Database = database,
  ) {}

  load(): StoredCredential[] {
    // Another process's writes (Postgres replication, or the SQLite broadcast in queue mode) mark the copy stale.
    this.stop ??= onConfigChanged(['credentials'], () => (this.dirty = true));
    const db = this.db();
    importOnce(db, 'credentials.json', () => {
      if (!existsSync(this.file)) return;
      const saved = new CredentialFile(this.file).load();
      for (const credential of saved) db.insertNew('credentials', credentialRow(credential));
    });
    this.dirty = false;
    return db.all<CredentialRow>('SELECT * FROM credentials').flatMap((row) => {
      try {
        return [{ id: row.id, name: row.name, type: row.type, secretFields: JSON.parse(row.secret_fields) as string[], data: JSON.parse(row.data) as Sealed, ...(cleanRateLimit(row.rate_limit && JSON.parse(row.rate_limit)) && { rateLimit: cleanRateLimit(JSON.parse(row.rate_limit!)) }), createdAt: row.created_at, updatedAt: row.updated_at }];
      } catch {
        return [];
      }
    });
  }

  save(change: { saved: StoredCredential } | { removed: string }) {
    if ('saved' in change) this.db().upsert('credentials', { ...credentialRow(change.saved) });
    else this.db().delete('credentials', { id: change.removed });
  }

  stale(): boolean {
    return this.dirty;
  }

  close() {
    this.stop?.();
    this.stop = undefined;
  }
}

export interface CredentialVaultOptions {
  /** The data directory (credentials.json, encryption.key); default LANDFLOW_DATA_DIR. */
  dir?: string;
  backend?: CredentialBackend;
}

export class CredentialVault {
  private readonly ring: KeyRing;
  private readonly backend: CredentialBackend;
  /** Loaded on first use: in Postgres mode the database opens after this module is imported. */
  private loaded?: Map<string, StoredCredential>;
  /** OAuth2 refreshes in flight, by credential id: concurrent nodes wait for the same one. */
  private readonly refreshing = new Map<string, Promise<boolean>>();

  constructor(options: CredentialVaultOptions = {}) {
    const dir = options.dir ?? store.dir;
    const listed = process.env.LANDFLOW_ENCRYPTION_KEYS;
    this.ring = buildKeyRing(listed, loadLegacyKey(dir, Boolean(listed?.trim())));
    const file = join(dir, 'credentials.json');
    this.backend = options.backend ?? (configStoreKind() === 'database' ? new CredentialTable(file) : new CredentialFile(file));
  }

  /** Where the credentials are kept: `files` (credentials.json) or `database`. */
  get storeKind(): 'files' | 'database' {
    return this.backend.kind;
  }

  private get credentials(): Map<string, StoredCredential> {
    // Database mode: another process's change (replicated) is read at once; the flag costs nothing to check.
    if (this.loaded && this.backend.kind === 'database') this.reloadIfChanged();
    this.loaded ??= new Map(this.backend.load().map((credential) => [credential.id, credential]));
    return this.loaded;
  }

  private persist(change: { saved: StoredCredential } | { removed: string }) {
    this.backend.save(change, this.credentials.values());
  }

  /** Queue mode: read the credentials again when another process changed them (the file's mtime, or the table). */
  reloadIfChanged(): boolean {
    if (!this.loaded || !this.backend.stale()) return false;
    try {
      this.loaded = new Map(this.backend.load().map((credential) => [credential.id, credential]));
      return true;
    } catch {
      return false;
    }
  }

  private seal(data: JsonObject, id: string): Sealed {
    return sealWith(this.ring, JSON.stringify(data), credentialAad(id));
  }

  /** The key id new values are sealed with. */
  get primaryKid(): string {
    return this.ring.primary;
  }

  /** Whether a LANDFLOW_ENCRYPTION_KEYS ring is configured (rotation needs one). */
  get ringConfigured(): boolean {
    return Boolean(process.env.LANDFLOW_ENCRYPTION_KEYS?.trim());
  }

  /** A key for another purpose (resume URLs, OAuth2 state), HKDF-SHA256 from the primary key: one per label. */
  deriveKey(label: string): Buffer {
    return hkdfKey(this.ring, label);
  }

  /**
   * Every key a derived value may have been signed with, newest first: the primary key's, the other ring keys' (so a
   * rotation doesn't void links in flight) and the old HMAC derivation of the legacy key (values signed before HKDF).
   */
  deriveKeys(label: string): Buffer[] {
    const legacy = this.ring.keys.get(LEGACY_SHA_KID) ?? this.ring.keys.get(LEGACY_KID);
    const ring = [this.ring.primary, ...[...this.ring.keys.keys()].filter((kid) => kid !== this.ring.primary)].map((kid) => hkdfKey({ ...this.ring, primary: kid }, label));
    // TODO(2027-02): remove this HMAC fallback once links signed before HKDF (2026-11) have expired.
    return legacy ? [...ring, createHmac('sha256', legacy).update(`landflow:${label}`).digest()] : ring;
  }

  /**
   * Encrypt one secret for storage elsewhere (alert channel secrets): `v2.<kid>.<iv>.<tag>.<ciphertext>`, bound to
   * `purpose` (open it with the same one).
   */
  sealSecret(value: string, purpose = DEFAULT_PURPOSE): string {
    const { kid, iv, tag, value: ciphertext } = sealWith(this.ring, value, secretAad(purpose));
    return `v2.${kid}.${iv}.${tag}.${ciphertext}`;
  }

  /** The secret `sealSecret` returned (or a v1 string from before key ids); throws a CredentialError when it can't be decrypted (another key). */
  openSecret(sealed: string, purpose = DEFAULT_PURPOSE): string {
    const parsed = parseSealedString(sealed);
    if (!parsed) throw new CredentialError('Not a sealed secret', 500);
    try {
      return openWith(this.ring, parsed, secretAad(purpose));
    } catch {
      throw new CredentialError('A stored secret can’t be decrypted — was LANDFLOW_ENCRYPTION_KEY changed?', 500);
    }
  }

  /** The same secret sealed with the primary key, or undefined when it is on it already (rotation). Throws a CredentialError when it can't be opened. */
  resealSecret(sealed: string, purpose = DEFAULT_PURPOSE): string | undefined {
    const parsed = parseSealedString(sealed);
    if (parsed && parsed.v === 2 && parsed.kid === this.ring.primary) return undefined;
    return this.sealSecret(this.openSecret(sealed, purpose), purpose);
  }

  /**
   * Re-seal every credential that is not v2 under the primary key, writing each one on its own (so an interruption
   * leaves every credential readable). Returns how many were re-sealed, were already current, and could not be opened.
   */
  rotateCredentials(): { resealed: number; current: number; failed: string[] } {
    const result = { resealed: 0, current: 0, failed: [] as string[] };
    for (const credential of [...this.credentials.values()]) {
      if (credential.data.v === 2 && kidOf(credential.data) === this.ring.primary) {
        result.current += 1;
        continue;
      }
      try {
        // A new object, put back only if the write fails: the copy in memory never runs ahead of what is stored.
        const resealed: StoredCredential = { ...credential, data: this.seal(this.open(credential), credential.id) };
        this.credentials.set(credential.id, resealed);
        try {
          this.persist({ saved: resealed });
        } catch (error) {
          this.credentials.set(credential.id, credential);
          throw error;
        }
        result.resealed += 1;
      } catch {
        result.failed.push(credential.id);
      }
    }
    return result;
  }

  private open(credential: StoredCredential): JsonObject {
    try {
      return JSON.parse(openWith(this.ring, credential.data, credentialAad(credential.id))) as JsonObject;
    } catch {
      throw new CredentialError(`Credential "${credential.name}" can't be decrypted — was LANDFLOW_ENCRYPTION_KEY changed?`, 500);
    }
  }

  private usage() {
    const usedBy = new Map<string, CredentialSummary['usedBy']>();
    for (const workflow of store.listWorkflows()) {
      const ids = new Set(workflow.nodes.flatMap((node) => Object.values(node.credentials ?? {}).map((ref) => ref.id)));
      for (const id of ids) {
        const list = usedBy.get(id) ?? [];
        list.push({ workflowId: workflow.id, workflowName: workflow.name });
        usedBy.set(id, list);
      }
    }
    return usedBy;
  }

  private summary(credential: StoredCredential, usedBy: Map<string, CredentialSummary['usedBy']>): CredentialSummary {
    const { id, name, type, createdAt, updatedAt, rateLimit } = credential;
    return { id, name, type, createdAt, updatedAt, usedBy: usedBy.get(id) ?? [], ...(rateLimit && { rateLimit }), ...this.oauth2StatusOf(credential) };
  }

  /** core.oAuth2Api, a type extending it, or (its plugin offline) a credential that holds a token. */
  private isOAuth2(credential: StoredCredential, data?: JsonObject): boolean {
    return credential.type === OAUTH2_CREDENTIAL || Boolean(registry.credentialType(credential.type)?.oauth2) || Boolean(data && storedToken(data[TOKEN_FIELD]));
  }

  private oauth2StatusOf(credential: StoredCredential): Pick<CredentialSummary, 'oauth2'> {
    try {
      const data = this.open(credential);
      if (!this.isOAuth2(credential, data)) return {};
      return { oauth2: oauth2Status(withDefaults(registry.credentialType(credential.type)?.descriptor, data)) };
    } catch {
      return {};
    }
  }

  /** What nodes get: the type's defaults and the saved values; for OAuth2, the access token instead of the stored token. */
  private nodeData(credential: StoredCredential, descriptor: CredentialTypeDescriptor | undefined): JsonObject {
    const data = withDefaults(descriptor, this.open(credential));
    if (!this.isOAuth2(credential, data)) return this.remember(credential, descriptor, data);
    const result = { ...withoutReserved(data), ...nodeTokenFields(storedToken(data[TOKEN_FIELD])) };
    oauthOrigins.set(result, credential.id);
    return this.remember(credential, descriptor, result);
  }

  /**
   * Handing secrets to a node: their values are remembered so redaction (secrets/redact) scrubs them from logs, run
   * results and stored runs, the way `$secrets` values are. Password-typed fields, the credential's own secret fields
   * and fields whose name says secret; a `$secrets` reference holds nothing. The remembered set is bounded and
   * evicts the least recently resolved value (secrets/redact MAX_VALUES).
   */
  private remember(credential: StoredCredential, descriptor: CredentialTypeDescriptor | undefined, data: JsonObject): JsonObject {
    installRedaction();
    const names = new Set([...credential.secretFields, ...secretNames(descriptor)]);
    for (const [key, value] of Object.entries(data)) {
      if (typeof value !== 'string' || isSecretReference(value)) continue;
      if (names.has(key) || SECRET_KEY.test(key)) rememberSecretValues(value, { min: CREDENTIAL_MIN_LENGTH, lines: value.includes('-----BEGIN') });
    }
    return data;
  }

  list(): CredentialSummary[] {
    const usedBy = this.usage();
    return [...this.credentials.values()].sort((a, b) => a.name.localeCompare(b.name)).map((c) => this.summary(c, usedBy));
  }

  /** A credential for editing: secret fields are left out, `secrets` says which ones are set. */
  get(id: string): CredentialDetail | undefined {
    const credential = this.credentials.get(id);
    if (!credential) return undefined;
    const secret = new Set([...credential.secretFields, ...secretNames(registry.credentialType(credential.type)?.descriptor)]);
    const data = this.open(credential);
    // A secret field that only references an external secret (`{{ $secrets.vault.db.password }}`) holds no secret: it is shown.
    const hidden = (key: string) => secret.has(key) && !isSecretReference(data[key]);
    return {
      ...this.summary(credential, this.usage()),
      data: Object.fromEntries(Object.entries(data).filter(([key]) => !hidden(key) && !reserved.has(key))),
      secrets: Object.keys(data).filter((key) => hidden(key) && !reserved.has(key) && data[key] !== '' && data[key] !== null),
    };
  }

  /**
   * `options.id` keeps a given id (a promoted definition, planned before it is created); `options.partial` skips the
   * required-field check (a promoted definition comes without its secrets, which are filled in on this instance).
   */
  create(input: { name: string; type: string; data: JsonObject; rateLimit?: CredentialRateLimitSetting | null }, options: { id?: string; partial?: boolean } = {}): CredentialDetail {
    const info = registry.credentialType(input.type);
    if (!info) throw new CredentialError(`Unknown credential type "${input.type}" — is its plugin running?`);
    if (options.id && this.credentials.has(options.id)) throw new CredentialError(`A credential with id ${options.id} exists already`, 409);
    const data = withoutReserved(Object.fromEntries(Object.entries(input.data).filter(([, value]) => value !== null && value !== undefined)) as JsonObject);
    if (!options.partial) this.validate(info.descriptor, data);
    const now = new Date().toISOString();
    const id = options.id ?? `cred_${nanoid(12)}`;
    const credential: StoredCredential = {
      id,
      name: input.name.trim() || info.descriptor.displayName,
      type: input.type,
      secretFields: secretNames(info.descriptor),
      data: this.seal(data, id),
      ...(cleanRateLimit(input.rateLimit) && { rateLimit: cleanRateLimit(input.rateLimit) }),
      createdAt: now,
      updatedAt: now,
    };
    this.credentials.set(credential.id, credential);
    this.persist({ saved: credential });
    return this.get(credential.id)!;
  }

  /**
   * What promotion copies of a credential (lib/server/environments/promote.ts): name, type, the non-secret fields and
   * the secret fields that only reference an external secret; `secretFields` names every secret field (whose values
   * never leave). Undefined when the credential doesn't exist.
   */
  definition(id: string): { name: string; type: string; data: JsonObject; secretFields: string[] } | undefined {
    const credential = this.credentials.get(id);
    if (!credential) return undefined;
    const secret = new Set([...credential.secretFields, ...secretNames(registry.credentialType(credential.type)?.descriptor)]);
    const data = withoutReserved(this.open(credential));
    return {
      name: credential.name,
      type: credential.type,
      data: Object.fromEntries(Object.entries(data).filter(([key, value]) => !secret.has(key) || isSecretReference(value))) as JsonObject,
      secretFields: [...secret].sort(),
    };
  }

  /** The secret (password) fields of a credential type, by its descriptor (empty when its plugin isn't running). */
  secretFieldsOf(type: string): string[] {
    return secretNames(registry.credentialType(type)?.descriptor);
  }

  /**
   * Fields in `data` replace the saved ones. A secret left empty keeps its saved
   * value (the form never receives it); `null` clears a field.
   */
  update(id: string, input: { name?: string; data?: Record<string, unknown>; rateLimit?: CredentialRateLimitSetting | null }): CredentialDetail {
    const credential = this.credentials.get(id);
    if (!credential) throw new CredentialError('Credential not found', 404);
    const descriptor = registry.credentialType(credential.type)?.descriptor;
    if (input.data) {
      const merged = this.merge(credential, input.data);
      if (descriptor) this.validate(descriptor, merged);
      credential.data = this.seal(merged, credential.id);
      credential.secretFields = [...new Set([...credential.secretFields, ...secretNames(descriptor)])];
    }
    if (input.name?.trim()) credential.name = input.name.trim();
    // null (or a limit of 0) takes the rate limit off.
    if (input.rateLimit !== undefined) {
      const limit = cleanRateLimit(input.rateLimit);
      if (limit) credential.rateLimit = limit;
      else delete credential.rateLimit;
    }
    credential.updatedAt = new Date().toISOString();
    this.persist({ saved: credential });
    return this.get(id)!;
  }

  /**
   * The rate limits of the credentials a node uses, for the engine (`credentialRateLimits`): the limiter key is the credential's id, so
   * every node and run using it shares one window (across processes in queue mode).
   */
  rateLimitsFor(node: Pick<WorkflowNode, 'credentials'>): CredentialRateLimit[] {
    const refs = Object.values(node.credentials ?? {});
    if (!refs.length) return [];
    const seen = new Set<string>();
    return refs.flatMap((ref) => {
      const credential = seen.has(ref.id) ? undefined : this.credentials.get(ref.id);
      seen.add(ref.id);
      return credential?.rateLimit ? [{ key: `credential:${credential.id}`, name: credential.name, limit: credential.rateLimit }] : [];
    });
  }

  delete(id: string): boolean {
    if (!this.credentials.delete(id)) return false;
    this.persist({ removed: id });
    return true;
  }

  private merge(credential: StoredCredential, incoming: Record<string, unknown>): JsonObject {
    const secret = new Set([...credential.secretFields, ...secretNames(registry.credentialType(credential.type)?.descriptor)]);
    const merged: JsonObject = { ...this.open(credential) };
    for (const [key, value] of Object.entries(incoming)) {
      if (reserved.has(key)) continue;
      if (value === null) delete merged[key];
      else if (secret.has(key) && (value === '' || value === undefined)) continue;
      else if (value !== undefined) merged[key] = value as JsonObject[string];
    }
    return merged;
  }

  private validate(descriptor: CredentialTypeDescriptor, data: JsonObject) {
    // Only fields the form shows count (an OAuth2 client credentials grant has no authorization URL).
    const values = withDefaults(descriptor, data);
    const missing = descriptor.properties.filter(
      (p) => p.required && (data[p.name] === undefined || data[p.name] === '') && p.default === undefined && isPropertyVisible(p, values),
    );
    if (missing.length) throw new CredentialError(`Missing ${missing.map((p) => p.displayName).join(', ')}`);
  }

  /**
   * The data a "Test connection" sends: the form's values over the saved ones
   * (when editing, the form doesn't hold the secrets), with type defaults.
   */
  testData(type: string, data: Record<string, unknown>, id?: string): JsonObject {
    const credential = id ? this.credentials.get(id) : undefined;
    if (id && !credential) throw new CredentialError('Credential not found', 404);
    const base = credential ? this.merge(credential, data) : withoutReserved(Object.fromEntries(Object.entries(data).filter(([, v]) => v !== null && v !== undefined)) as JsonObject);
    const full = withDefaults(registry.credentialType(type)?.descriptor, base);
    // An OAuth2 credential is tested with its access token, like a node would get it.
    return credential && this.isOAuth2(credential, full) ? { ...withoutReserved(full), ...nodeTokenFields(storedToken(full[TOKEN_FIELD])) } : full;
  }

  /** One credential's decrypted data with type defaults, for callers that aren't nodes (agent models, agent channels). */
  dataFor(ref: { id: string; name: string }, type: string): JsonObject {
    const credential = this.credentials.get(ref.id);
    if (!credential) throw new CredentialError(`Credential "${ref.name}" was deleted — choose another one`);
    if (credential.type !== type) throw new CredentialError(`Credential "${credential.name}" is a ${credential.type}, not a ${type}`);
    return this.nodeData(credential, registry.credentialType(type)?.descriptor);
  }

  /**
   * `dataFor` with `$secrets` resolved, for the credentials Landflow uses itself, outside nodes (agents' models and
   * channels, alert channels, the source control token): read right before the use, with the same cache and
   * redaction as credential fields in nodes. A secret that can't be read throws, naming the field and the reference.
   */
  dataWithSecrets(ref: { id: string; name: string }, type: string): Promise<JsonObject> {
    return resolveSecretsIn(this.dataFor(ref, type), `Credential “${this.credentials.get(ref.id)?.name ?? ref.name}”`);
  }

  /**
   * Decrypted credentials for one node call, keyed by the names the node declared.
   * Throws (failing the node) when a required credential is missing or gone;
   * `lenient` skips those instead (option lists load what they can).
   */
  resolveFor(node: Pick<WorkflowNode, 'type' | 'credentials'> & { parameters?: Record<string, unknown> }, descriptor: NodeDescriptor, lenient = false): Record<string, JsonObject> {
    // A requirement can depend on parameters (one credential per auth method).
    const parameters = withPropertyDefaults(descriptor.properties, node.parameters);
    const requirements = (descriptor.credentials ?? []).filter((requirement) => isPropertyVisible(requirement, parameters));
    if (!requirements.length) return {};
    const { pluginId } = splitType(node.type);
    const resolved: Record<string, JsonObject> = {};
    for (const requirement of requirements) {
      const type = requirement.name.includes('.') ? requirement.name : `${pluginId}.${requirement.name}`;
      const info = registry.credentialType(type);
      const label = info?.descriptor.displayName ?? requirement.name;
      const ref = node.credentials?.[requirement.name];
      if (!ref || (lenient && !this.credentials.has(ref.id))) {
        if (requirement.required && !lenient) throw new CredentialError(`No ${label} credential selected — choose one in the node's parameters`);
        continue;
      }
      const credential = this.credentials.get(ref.id);
      if (!credential) throw new CredentialError(`Credential "${ref.name}" was deleted — choose another ${label} credential`);
      if (credential.type !== type) throw new CredentialError(`Credential "${credential.name}" is a ${credential.type}, this node needs ${type}`);
      resolved[requirement.name] = this.nodeData(credential, info?.descriptor);
    }
    return resolved;
  }

  // -------------------------------------------------------------------------
  // OAuth2
  // -------------------------------------------------------------------------

  private oauth2Credential(id: string): { credential: StoredCredential; data: JsonObject } {
    const credential = this.credentials.get(id);
    if (!credential) throw new CredentialError('Credential not found', 404);
    const data = withDefaults(registry.credentialType(credential.type)?.descriptor, this.open(credential));
    if (!this.isOAuth2(credential, data)) throw new CredentialError(`Credential "${credential.name}" is not an OAuth2 credential`);
    return { credential, data };
  }

  /** An OAuth2 credential's flow settings and current token, for the Connect routes. */
  oauth2(id: string): { name: string; type: string; config: OAuth2Config; token?: StoredToken } {
    const { credential, data } = this.oauth2Credential(id);
    const token = storedToken(data[TOKEN_FIELD]);
    return { name: credential.name, type: credential.type, config: oauth2Config(data), ...(token && { token }) };
  }

  /**
   * An MCP server's OAuth credential (core.mcpOAuth2Api): the server URL, the flow settings the form holds (without what
   * discovery found) and what discovery found, for the Connect route. Undefined for any other credential.
   */
  mcpOAuth(id: string): { serverUrl: string; form: OAuth2Config; meta?: JsonObject } | undefined {
    const { credential, data } = this.oauth2Credential(id);
    if (credential.type !== MCP_OAUTH2_CREDENTIAL) return undefined;
    const meta = data[META_FIELD];
    const { [META_FIELD]: _meta, ...form } = data;
    return { serverUrl: typeof data.serverUrl === 'string' ? data.serverUrl.trim() : '', form: oauth2Config(form), ...(meta && typeof meta === 'object' && !Array.isArray(meta) && { meta }) };
  }

  /** Keep what discovery and client registration found (it survives Disconnect: the registered client is reused). */
  saveMcpOAuthMeta(id: string, meta: JsonObject) {
    const { credential } = this.oauth2Credential(id);
    this.writeOAuth2(credential, (data) => {
      data[META_FIELD] = meta;
    });
  }

  /** The data of the credential the host handed to a node, when it is an OAuth2 credential's. */
  oauth2Origin(data: object): string | undefined {
    return oauthOrigins.get(data);
  }

  private writeOAuth2(credential: StoredCredential, change: (data: JsonObject) => void) {
    const data = this.open(credential);
    change(data);
    credential.data = this.seal(data, credential.id);
    credential.updatedAt = new Date().toISOString();
    this.persist({ saved: credential });
  }

  /** Store a token (after Connect, a refresh or a client credentials grant); `account` replaces the shown account when given. */
  saveOAuth2Token(id: string, token: StoredToken, account?: string): CredentialDetail {
    const { credential } = this.oauth2Credential(id);
    this.writeOAuth2(credential, (data) => {
      data[TOKEN_FIELD] = token;
      if (account) data[ACCOUNT_FIELD] = account;
      delete data[ERROR_FIELD];
    });
    return this.get(id)!;
  }

  /** Remember why the last token request failed (shown with the status), or clear it. */
  setOAuth2Error(id: string, message: string | undefined) {
    const credential = this.credentials.get(id);
    if (!credential) return;
    this.writeOAuth2(credential, (data) => {
      // A provider's answer may quote a client field that came from an external secret.
      if (message) data[ERROR_FIELD] = redactText(message).slice(0, 500);
      else delete data[ERROR_FIELD];
    });
  }

  /** Forget the token (Disconnect). The client settings stay. */
  disconnectOAuth2(id: string): CredentialDetail {
    const { credential } = this.oauth2Credential(id);
    this.writeOAuth2(credential, (data) => {
      for (const field of RESERVED_FIELDS) if (field !== META_FIELD) delete data[field];
    });
    return this.get(id)!;
  }

  /**
   * Renew an OAuth2 credential's access token when it expires within a minute (or always, with `force`: the API
   * refused it), and save the new one. Uses the refresh token, or the client credentials grant (which also gets the
   * first token). Returns whether a new token was stored. When renewing fails and the old token is unusable, throws
   * a CredentialError that tells the user to reconnect; a token that still works is kept.
   */
  refreshOAuth2(id: string, options: { force?: boolean; fetch?: typeof fetch } = {}): Promise<boolean> {
    const running = this.refreshing.get(id);
    if (running) return running;
    const work = this.renew(id, options).finally(() => this.refreshing.delete(id));
    this.refreshing.set(id, work);
    return work;
  }

  private async renew(id: string, options: { force?: boolean; fetch?: typeof fetch }): Promise<boolean> {
    const credential = this.credentials.get(id);
    if (!credential) return false;
    const data = withDefaults(registry.credentialType(credential.type)?.descriptor, this.open(credential));
    if (!this.isOAuth2(credential, data)) return false;
    const saved = oauth2Config(data);
    const token = storedToken(data[TOKEN_FIELD]);
    if (token && !options.force && !isExpiring(token)) return false;
    const clientCredentials = saved.grantType === 'clientCredentials';
    const refreshToken = tokenField(token, 'refresh_token');
    if (!clientCredentials && !refreshToken) return false;
    try {
      const config = await resolveOAuth2Secrets(saved);
      const response = clientCredentials ? await clientCredentialsToken(config, options.fetch) : await refreshAccessToken(config, refreshToken, options.fetch);
      const fresh = this.credentials.get(id);
      if (!fresh) return false;
      this.writeOAuth2(fresh, (current) => {
        current[TOKEN_FIELD] = toStoredToken(response, storedToken(current[TOKEN_FIELD]) ?? token);
        delete current[ERROR_FIELD];
      });
      logger.info('OAuth2 token refreshed', { 'landflow.credential.id': id, 'landflow.credential.type': credential.type, 'oauth2.grant': clientCredentials ? 'client_credentials' : 'refresh_token' });
      return true;
    } catch (error) {
      const message = (error as Error).message;
      this.setOAuth2Error(id, message);
      logger.warn('OAuth2 token refresh failed', { 'landflow.credential.id': id, 'landflow.credential.type': credential.type, error: message });
      // A token that hasn't expired yet still goes out; an expired or missing one would only fail at the API.
      if (!token || isExpiring(token, Date.now(), 0) || options.force) {
        throw new CredentialError(`The OAuth2 token of "${credential.name}" could not be renewed (${message}) — reconnect it in Credentials`);
      }
      return false;
    }
  }

  /**
   * The same credentials with OAuth2 tokens renewed where needed (see refreshOAuth2), or undefined when none was:
   * the data objects come from resolveFor/dataFor, which remember the credential they belong to.
   */
  async freshen(record: Record<string, JsonObject> | undefined, force = false): Promise<Record<string, JsonObject> | undefined> {
    if (!record) return undefined;
    let changed: Record<string, JsonObject> | undefined;
    for (const [name, data] of Object.entries(record)) {
      const id = oauthOrigins.get(data);
      if (!id || !(await this.refreshOAuth2(id, { force }))) continue;
      const credential = this.credentials.get(id);
      if (!credential) continue;
      (changed ??= { ...record })[name] = this.nodeData(credential, registry.credentialType(credential.type)?.descriptor);
    }
    return changed;
  }
}

/** The OAuth2 settings the host sends to the provider itself: `$secrets` may stand in the client fields and URLs. */
const OAUTH2_SECRET_FIELDS = ['clientId', 'clientSecret', 'authUrl', 'accessTokenUrl', 'userInfoUrl'] as const;

/**
 * An OAuth2 credential's flow settings with `$secrets` resolved (`{{ $secrets.vault.app.clientSecret }}` in the client
 * secret), right before the host builds the authorization URL, exchanges a code, refreshes or asks for a client
 * credentials token. The saved credential keeps the expression; the values are cached and redacted like any secret.
 */
export function resolveOAuth2Secrets(config: OAuth2Config): Promise<OAuth2Config> {
  return resolveSecretFields(config, 'OAuth2 credential', OAUTH2_SECRET_FIELDS);
}

export const credentials = singleton('credentials', () => new CredentialVault());
