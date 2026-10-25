/**
 * Saved credentials, encrypted at rest with AES-256-GCM. The key comes from
 * LANDFLOW_ENCRYPTION_KEY (64 hex chars, or any passphrase, which is hashed) or
 * is generated once into <data dir>/encryption.key. Workflows only reference a
 * credential by id; decrypted values leave this module on their way to a node
 * (ExecuteRequest.credentials) or a TestCredentials call, never through the API.
 *
 * OAuth2 credentials (core.oAuth2Api and types extending it) also hold their token, in the same sealed data
 * (`oauthTokenData`, see ./oauth2). The API reports a status instead of it; nodes get `accessToken` and are never
 * sent the refresh token. `refreshOAuth2` renews a token that is about to expire and saves it, and ./oauth2-runtime
 * calls it before a node runs (and once more when the node's API answered 401).
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { nanoid } from 'nanoid';
import { isPropertyVisible, splitType, withPropertyDefaults, type CredentialTypeDescriptor, type JsonObject, type NodeDescriptor } from '@landflow/protocol';
import type { WorkflowNode } from '@landflow/engine';
import { OAUTH2_CREDENTIAL } from '../../shared/oauth2';
import type { CredentialDetail, CredentialSummary } from '../../shared/types';
import { registry } from '../plugins/registry';
import { singleton } from '../singleton';
import { store } from '../store';
import { logger } from '../telemetry/logger';
import {
  ACCOUNT_FIELD,
  clientCredentialsToken,
  ERROR_FIELD,
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

interface Sealed {
  iv: string;
  tag: string;
  value: string;
}

interface StoredCredential {
  id: string;
  name: string;
  type: string;
  /** Names of the fields that were secret when saved, so they stay masked while the plugin is offline. */
  secretFields: string[];
  data: Sealed;
  createdAt: string;
  updatedAt: string;
}

export class CredentialError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

function loadKey(dir: string): Buffer {
  const configured = process.env.LANDFLOW_ENCRYPTION_KEY?.trim();
  if (configured) return /^[0-9a-f]{64}$/i.test(configured) ? Buffer.from(configured, 'hex') : createHash('sha256').update(configured).digest();
  const path = join(dir, 'encryption.key');
  if (!existsSync(path)) writeFileSync(path, randomBytes(32).toString('hex'), { mode: 0o600 });
  return Buffer.from(readFileSync(path, 'utf8').trim(), 'hex');
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

class CredentialVault {
  private readonly path = join(store.dir, 'credentials.json');
  private readonly key = loadKey(store.dir);
  private credentials = new Map<string, StoredCredential>();
  /** OAuth2 refreshes in flight, by credential id: concurrent nodes wait for the same one. */
  private readonly refreshing = new Map<string, Promise<boolean>>();

  /** When the file was last read or written here (queue mode: other processes write it too). */
  private loadedAt = 0;

  constructor() {
    try {
      this.loadedAt = statSync(this.path).mtimeMs;
      const saved = JSON.parse(readFileSync(this.path, 'utf8')) as { credentials: StoredCredential[] };
      for (const credential of saved.credentials) this.credentials.set(credential.id, credential);
    } catch {
      // No credentials yet.
    }
  }

  private persist() {
    const tmp = `${this.path}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, credentials: [...this.credentials.values()] }, null, 2), { mode: 0o600 });
    renameSync(tmp, this.path);
    this.loadedAt = statSync(this.path).mtimeMs;
  }

  /** Queue mode (a data directory shared by the processes): read the file again when another process wrote it. */
  reloadIfChanged(): boolean {
    try {
      const mtime = statSync(this.path).mtimeMs;
      if (mtime === this.loadedAt) return false;
      const saved = JSON.parse(readFileSync(this.path, 'utf8')) as { credentials: StoredCredential[] };
      this.credentials = new Map(saved.credentials.map((credential) => [credential.id, credential]));
      this.loadedAt = mtime;
      return true;
    } catch {
      return false;
    }
  }

  private seal(data: JsonObject): Sealed {
    return this.sealText(JSON.stringify(data));
  }

  private sealText(text: string): Sealed {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const value = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), value: value.toString('base64') };
  }

  private openText(sealed: Sealed): string {
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(sealed.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(sealed.value, 'base64')), decipher.final()]).toString('utf8');
  }

  /** A key for another purpose (signing OAuth2 state, deriving PKCE verifiers), derived from the encryption key. */
  deriveKey(label: string): Buffer {
    return createHmac('sha256', this.key).update(`landflow:${label}`).digest();
  }

  /** Encrypt one secret for storage elsewhere (alert channel secrets): `v1.<iv>.<tag>.<ciphertext>`. */
  sealSecret(value: string): string {
    const { iv, tag, value: ciphertext } = this.sealText(value);
    return `v1.${iv}.${tag}.${ciphertext}`;
  }

  /** The secret `sealSecret` returned; throws a CredentialError when it can't be decrypted (another key). */
  openSecret(sealed: string): string {
    const [version, iv, tag, value] = sealed.split('.');
    if (version !== 'v1' || !iv || !tag || value === undefined) throw new CredentialError('Not a sealed secret', 500);
    try {
      return this.openText({ iv, tag, value });
    } catch {
      throw new CredentialError('A stored secret can’t be decrypted — was LANDFLOW_ENCRYPTION_KEY changed?', 500);
    }
  }

  private open(credential: StoredCredential): JsonObject {
    try {
      return JSON.parse(this.openText(credential.data)) as JsonObject;
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
    const { id, name, type, createdAt, updatedAt } = credential;
    return { id, name, type, createdAt, updatedAt, usedBy: usedBy.get(id) ?? [], ...this.oauth2StatusOf(credential) };
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
    if (!this.isOAuth2(credential, data)) return data;
    const result = { ...withoutReserved(data), ...nodeTokenFields(storedToken(data[TOKEN_FIELD])) };
    oauthOrigins.set(result, credential.id);
    return result;
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

  create(input: { name: string; type: string; data: JsonObject }): CredentialDetail {
    const info = registry.credentialType(input.type);
    if (!info) throw new CredentialError(`Unknown credential type "${input.type}" — is its plugin running?`);
    const data = withoutReserved(Object.fromEntries(Object.entries(input.data).filter(([, value]) => value !== null && value !== undefined)) as JsonObject);
    this.validate(info.descriptor, data);
    const now = new Date().toISOString();
    const credential: StoredCredential = {
      id: `cred_${nanoid(12)}`,
      name: input.name.trim() || info.descriptor.displayName,
      type: input.type,
      secretFields: secretNames(info.descriptor),
      data: this.seal(data),
      createdAt: now,
      updatedAt: now,
    };
    this.credentials.set(credential.id, credential);
    this.persist();
    return this.get(credential.id)!;
  }

  /**
   * Fields in `data` replace the saved ones. A secret left empty keeps its saved
   * value (the form never receives it); `null` clears a field.
   */
  update(id: string, input: { name?: string; data?: Record<string, unknown> }): CredentialDetail {
    const credential = this.credentials.get(id);
    if (!credential) throw new CredentialError('Credential not found', 404);
    const descriptor = registry.credentialType(credential.type)?.descriptor;
    if (input.data) {
      const merged = this.merge(credential, input.data);
      if (descriptor) this.validate(descriptor, merged);
      credential.data = this.seal(merged);
      credential.secretFields = [...new Set([...credential.secretFields, ...secretNames(descriptor)])];
    }
    if (input.name?.trim()) credential.name = input.name.trim();
    credential.updatedAt = new Date().toISOString();
    this.persist();
    return this.get(id)!;
  }

  delete(id: string): boolean {
    if (!this.credentials.delete(id)) return false;
    this.persist();
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

  /** The data of the credential the host handed to a node, when it is an OAuth2 credential's. */
  oauth2Origin(data: object): string | undefined {
    return oauthOrigins.get(data);
  }

  private writeOAuth2(credential: StoredCredential, change: (data: JsonObject) => void) {
    const data = this.open(credential);
    change(data);
    credential.data = this.seal(data);
    credential.updatedAt = new Date().toISOString();
    this.persist();
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
      if (message) data[ERROR_FIELD] = message.slice(0, 500);
      else delete data[ERROR_FIELD];
    });
  }

  /** Forget the token (Disconnect). The client settings stay. */
  disconnectOAuth2(id: string): CredentialDetail {
    const { credential } = this.oauth2Credential(id);
    this.writeOAuth2(credential, (data) => {
      for (const field of RESERVED_FIELDS) delete data[field];
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
    const config = oauth2Config(data);
    const token = storedToken(data[TOKEN_FIELD]);
    if (token && !options.force && !isExpiring(token)) return false;
    const clientCredentials = config.grantType === 'clientCredentials';
    const refreshToken = tokenField(token, 'refresh_token');
    if (!clientCredentials && !refreshToken) return false;
    try {
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

export const credentials = singleton('credentials', () => new CredentialVault());
