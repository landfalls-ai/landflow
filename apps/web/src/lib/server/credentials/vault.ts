/**
 * Saved credentials, encrypted at rest with AES-256-GCM. The key comes from
 * LANDFLOW_ENCRYPTION_KEY (64 hex chars, or any passphrase, which is hashed) or
 * is generated once into <data dir>/encryption.key. Workflows only reference a
 * credential by id; decrypted values leave this module on their way to a node
 * (ExecuteRequest.credentials) or a TestCredentials call, never through the API.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { nanoid } from 'nanoid';
import { isPropertyVisible, splitType, withPropertyDefaults, type CredentialTypeDescriptor, type JsonObject, type NodeDescriptor } from '@landflow/protocol';
import type { WorkflowNode } from '@landflow/engine';
import type { CredentialDetail, CredentialSummary } from '../../shared/types';
import { registry } from '../plugins/registry';
import { singleton } from '../singleton';
import { store } from '../store';

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

const secretNames = (descriptor?: CredentialTypeDescriptor) => (descriptor?.properties ?? []).filter((p) => p.typeOptions?.password).map((p) => p.name);

/** Defaults first, then the saved values: a field added to the type later still gets its default. */
function withDefaults(descriptor: CredentialTypeDescriptor | undefined, data: JsonObject): JsonObject {
  const defaults = Object.fromEntries((descriptor?.properties ?? []).filter((p) => p.default !== undefined).map((p) => [p.name, p.default])) as JsonObject;
  return { ...defaults, ...data };
}

class CredentialVault {
  private readonly path = join(store.dir, 'credentials.json');
  private readonly key = loadKey(store.dir);
  private credentials = new Map<string, StoredCredential>();

  constructor() {
    try {
      const saved = JSON.parse(readFileSync(this.path, 'utf8')) as { credentials: StoredCredential[] };
      for (const credential of saved.credentials) this.credentials.set(credential.id, credential);
    } catch {
      // No credentials yet.
    }
  }

  private persist() {
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, credentials: [...this.credentials.values()] }, null, 2), { mode: 0o600 });
    renameSync(tmp, this.path);
  }

  private seal(data: JsonObject): Sealed {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const value = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()]);
    return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), value: value.toString('base64') };
  }

  private open(credential: StoredCredential): JsonObject {
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(credential.data.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(credential.data.tag, 'base64'));
      const plain = Buffer.concat([decipher.update(Buffer.from(credential.data.value, 'base64')), decipher.final()]);
      return JSON.parse(plain.toString('utf8')) as JsonObject;
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
    return { id, name, type, createdAt, updatedAt, usedBy: usedBy.get(id) ?? [] };
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
    return {
      ...this.summary(credential, this.usage()),
      data: Object.fromEntries(Object.entries(data).filter(([key]) => !secret.has(key))),
      secrets: Object.keys(data).filter((key) => secret.has(key) && data[key] !== '' && data[key] !== null),
    };
  }

  create(input: { name: string; type: string; data: JsonObject }): CredentialDetail {
    const info = registry.credentialType(input.type);
    if (!info) throw new CredentialError(`Unknown credential type "${input.type}" — is its plugin running?`);
    const data = Object.fromEntries(Object.entries(input.data).filter(([, value]) => value !== null && value !== undefined)) as JsonObject;
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
      if (value === null) delete merged[key];
      else if (secret.has(key) && (value === '' || value === undefined)) continue;
      else if (value !== undefined) merged[key] = value as JsonObject[string];
    }
    return merged;
  }

  private validate(descriptor: CredentialTypeDescriptor, data: JsonObject) {
    const missing = descriptor.properties.filter((p) => p.required && (data[p.name] === undefined || data[p.name] === '') && p.default === undefined);
    if (missing.length) throw new CredentialError(`Missing ${missing.map((p) => p.displayName).join(', ')}`);
  }

  /**
   * The data a "Test connection" sends: the form's values over the saved ones
   * (when editing, the form doesn't hold the secrets), with type defaults.
   */
  testData(type: string, data: Record<string, unknown>, id?: string): JsonObject {
    const credential = id ? this.credentials.get(id) : undefined;
    if (id && !credential) throw new CredentialError('Credential not found', 404);
    const base = credential ? this.merge(credential, data) : (Object.fromEntries(Object.entries(data).filter(([, v]) => v !== null && v !== undefined)) as JsonObject);
    return withDefaults(registry.credentialType(type)?.descriptor, base);
  }

  /** One credential's decrypted data with type defaults, for callers that aren't nodes (agent models, agent channels). */
  dataFor(ref: { id: string; name: string }, type: string): JsonObject {
    const credential = this.credentials.get(ref.id);
    if (!credential) throw new CredentialError(`Credential "${ref.name}" was deleted — choose another one`);
    if (credential.type !== type) throw new CredentialError(`Credential "${credential.name}" is a ${credential.type}, not a ${type}`);
    return withDefaults(registry.credentialType(type)?.descriptor, this.open(credential));
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
      resolved[requirement.name] = withDefaults(info?.descriptor, this.open(credential));
    }
    return resolved;
  }
}

export const credentials = singleton('credentials', () => new CredentialVault());
