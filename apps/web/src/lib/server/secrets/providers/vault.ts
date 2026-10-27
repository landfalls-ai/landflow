/**
 * OpenBao and HashiCorp Vault: the KV version 2 secrets engine over the HTTP API (the two speak the same API).
 * Secret names are paths under the mount and an optional path prefix (`dev/hello`); a value is the entry's keys.
 *
 * Auth methods are pluggable (`registerVaultAuthMethod`): a token, AppRole and Kubernetes are built in. A login's
 * token is renewed in the background at two thirds of its lease while it stays renewable; when renewal fails or the
 * lease runs out, the next request logs in again (a pasted token can't log in again: it is renewed while it can be).
 * Vault Enterprise and OpenBao namespaces go in `X-Vault-Namespace`.
 */
import { readFileSync } from 'node:fs';
import { singleton } from '../../singleton';
import { checkUrl, requestJson } from './http';
import { SecretProviderError, str, withEnvironment, type ProviderConfig, type ProviderContext, type ProviderDefinition, type SecretsProvider, type SecretValue } from './types';
import type { SecretProviderField } from '../../../shared/secrets';

export interface VaultLogin {
  token: string;
  /** Seconds the token lives (0 = no expiry, e.g. a root token). */
  leaseSeconds: number;
  renewable: boolean;
}

/** What an auth method may call: the Vault API without a token (logins) or with one (lookups). */
export interface VaultApi {
  call<T>(method: string, path: string, options?: { body?: unknown; token?: string }): Promise<T>;
}

export interface VaultAuthMethod {
  label: string;
  /** The method's settings in the provider form (shown when it is chosen). */
  fields: SecretProviderField[];
  /** Settings among `fields` that are secrets. */
  secretFields?: string[];
  /** Get a token. */
  login(api: VaultApi, config: ProviderConfig): Promise<VaultLogin>;
  /** Whether `login` can be repeated for a fresh token (false for a pasted token). Default true. */
  canLoginAgain?: boolean;
}

interface AuthResponse {
  auth?: { client_token?: string; lease_duration?: number; renewable?: boolean };
}

const fromAuth = (response: AuthResponse, what: string): VaultLogin => {
  const token = response.auth?.client_token;
  if (!token) throw new SecretProviderError(`${what} login answered without a token`);
  return { token, leaseSeconds: Number(response.auth?.lease_duration) || 0, renewable: Boolean(response.auth?.renewable) };
};

const mountOf = (config: ProviderConfig, fallback: string) => (str(config, 'authMount') || fallback).replace(/^\/+|\/+$/g, '');

/** The built-in methods; plugins (Kubernetes discovery, others) may add or replace methods. */
const methods = singleton('vault-auth-methods', () => {
  const map = new Map<string, VaultAuthMethod>();
  map.set('token', {
    label: 'Token',
    fields: [{ name: 'token', label: 'Token', type: 'password', required: true, showWhen: { field: 'auth', values: ['token'] } }],
    secretFields: ['token'],
    canLoginAgain: false,
    async login(api, config) {
      const token = str(config, 'token');
      if (!token) throw new SecretProviderError('Enter a token');
      const lookup = await api.call<{ data?: { ttl?: number; renewable?: boolean } }>('GET', 'auth/token/lookup-self', { token });
      return { token, leaseSeconds: Number(lookup.data?.ttl) || 0, renewable: Boolean(lookup.data?.renewable) };
    },
  });
  map.set('appRole', {
    label: 'AppRole',
    fields: [
      { name: 'roleId', label: 'Role ID', type: 'string', required: true, showWhen: { field: 'auth', values: ['appRole'] } },
      { name: 'secretId', label: 'Secret ID', type: 'password', required: true, showWhen: { field: 'auth', values: ['appRole'] } },
      { name: 'authMount', label: 'Auth mount', type: 'string', placeholder: 'approle', showWhen: { field: 'auth', values: ['appRole', 'kubernetes'] } },
    ],
    secretFields: ['secretId'],
    async login(api, config) {
      const body = { role_id: str(config, 'roleId'), secret_id: str(config, 'secretId') };
      if (!body.role_id || !body.secret_id) throw new SecretProviderError('Enter the role ID and the secret ID');
      return fromAuth(await api.call<AuthResponse>('POST', `auth/${mountOf(config, 'approle')}/login`, { body }), 'AppRole');
    },
  });
  map.set('kubernetes', {
    label: 'Kubernetes',
    fields: [
      { name: 'role', label: 'Role', type: 'string', required: true, showWhen: { field: 'auth', values: ['kubernetes'] } },
      {
        name: 'jwtPath',
        label: 'Service account token file',
        type: 'string',
        placeholder: '/var/run/secrets/kubernetes.io/serviceaccount/token',
        showWhen: { field: 'auth', values: ['kubernetes'] },
      },
      { name: 'jwt', label: 'Service account token', type: 'password', hint: 'Instead of the file (outside a pod)', showWhen: { field: 'auth', values: ['kubernetes'] } },
    ],
    secretFields: ['jwt'],
    async login(api, config) {
      const role = str(config, 'role');
      if (!role) throw new SecretProviderError('Enter the Kubernetes auth role');
      let jwt = str(config, 'jwt');
      if (!jwt) {
        const path = str(config, 'jwtPath') || '/var/run/secrets/kubernetes.io/serviceaccount/token';
        try {
          jwt = readFileSync(/*turbopackIgnore: true*/ path, 'utf8').trim();
        } catch {
          throw new SecretProviderError(`No service account token at ${path} (is the host running in a pod?)`);
        }
      }
      return fromAuth(await api.call<AuthResponse>('POST', `auth/${mountOf(config, 'kubernetes')}/login`, { body: { role, jwt } }), 'Kubernetes');
    },
  });
  return map;
});

/** Add or replace a Vault auth method (`auth` setting value `name`). */
export function registerVaultAuthMethod(name: string, method: VaultAuthMethod): void {
  methods.set(name, method);
}

export const vaultAuthMethods = (): ReadonlyMap<string, VaultAuthMethod> => methods;

/** Keys of a KV path segment: `a/` is a folder. */
const MAX_NAMES = 5000;
const MAX_DEPTH = 12;

class VaultClient implements SecretsProvider {
  private readonly url: string;
  private readonly namespace: string;
  private readonly mount: string;
  private readonly prefix: string;
  private readonly method: VaultAuthMethod;
  private session?: VaultLogin & { expiresAt: number };
  private logging?: Promise<VaultLogin & { expiresAt: number }>;
  private timer?: NodeJS.Timeout;
  private closed = false;

  constructor(
    private readonly config: ProviderConfig,
    private readonly context: ProviderContext,
  ) {
    this.url = checkUrl(str(config, 'url'), 'The Vault URL');
    this.namespace = str(config, 'namespace').replace(/^\/+|\/+$/g, '');
    this.mount = (str(config, 'mount') || 'secret').replace(/^\/+|\/+$/g, '');
    const prefix = withEnvironment(config.pathPrefix, context.environment).replace(/^\/+|\/+$/g, '');
    this.prefix = prefix ? `${prefix}/` : '';
    const auth = str(config, 'auth') || 'token';
    const method = methods.get(auth);
    if (!method) throw new SecretProviderError(`Unknown Vault auth method "${auth}"`);
    this.method = method;
  }

  private api: VaultApi = {
    call: async <T>(method: string, path: string, options: { body?: unknown; token?: string } = {}) =>
      (await requestJson<T>(this.context.fetch, `${this.url}/v1/${path}`, 'Vault', {
        method,
        headers: { ...(options.token && { 'x-vault-token': options.token }), ...(this.namespace && { 'x-vault-namespace': this.namespace }) },
        ...(options.body !== undefined && { body: options.body }),
      }))!,
  };

  private async login(): Promise<VaultLogin & { expiresAt: number }> {
    this.logging ??= this.method
      .login(this.api, this.config)
      .then((login) => {
        const session = { ...login, expiresAt: login.leaseSeconds > 0 ? Date.now() + login.leaseSeconds * 1000 : Infinity };
        this.session = session;
        this.scheduleRenewal(session);
        return session;
      })
      .finally(() => {
        this.logging = undefined;
      });
    return this.logging;
  }

  /** Renew at two thirds of the lease; a failed renewal leaves the token to expire (the next call logs in again). */
  private scheduleRenewal(session: VaultLogin & { expiresAt: number }) {
    clearTimeout(this.timer);
    if (this.closed || !session.renewable || session.leaseSeconds <= 0) return;
    const delay = Math.max(1_000, Math.min((session.leaseSeconds * 1000 * 2) / 3, 2 ** 31 - 1));
    this.timer = setTimeout(() => void this.renew(session).catch(() => undefined), delay);
    this.timer.unref?.();
  }

  /** Renew the session's token now (`auth/token/renew-self`). */
  async renew(session = this.session): Promise<boolean> {
    if (!session || this.session !== session) return false;
    try {
      const response = await this.api.call<AuthResponse>('POST', 'auth/token/renew-self', { token: session.token, body: {} });
      const leaseSeconds = Number(response.auth?.lease_duration) || 0;
      const renewed = { ...session, leaseSeconds, renewable: Boolean(response.auth?.renewable), expiresAt: leaseSeconds > 0 ? Date.now() + leaseSeconds * 1000 : Infinity };
      if (this.session === session) {
        this.session = renewed;
        this.scheduleRenewal(renewed);
      }
      return true;
    } catch {
      return false;
    }
  }

  private async token(): Promise<string> {
    const session = this.session;
    // A token about to expire: a fresh login (or one more renewal, for a pasted token).
    if (session && session.expiresAt - Date.now() > 5_000) return session.token;
    if (session && this.method.canLoginAgain === false && (await this.renew(session)) && this.session) return this.session.token;
    return (await this.login()).token;
  }

  private async read<T>(path: string, allow404 = false): Promise<T | undefined> {
    const attempt = async () =>
      requestJson<T>(this.context.fetch, `${this.url}/v1/${path}`, 'Vault', {
        headers: { 'x-vault-token': await this.token(), ...(this.namespace && { 'x-vault-namespace': this.namespace }) },
        ...(allow404 && { allow: [404] }),
      });
    try {
      return await attempt();
    } catch (error) {
      // A token revoked or expired early: log in once more and retry.
      if (error instanceof SecretProviderError && error.status === 403 && this.method.canLoginAgain !== false && this.session) {
        this.session = undefined;
        return attempt();
      }
      throw error;
    }
  }

  private dataPath(name: string): string {
    if (!name || name.startsWith('/') || name.split('/').some((part) => part === '..' || part === '.')) throw new SecretProviderError(`Not a secret path: ${JSON.stringify(name)}`);
    return `${this.mount}/data/${this.prefix}${name.split('/').map(encodeURIComponent).join('/')}`;
  }

  async listNames(): Promise<string[]> {
    const names: string[] = [];
    const walk = async (folder: string, depth: number) => {
      if (depth > MAX_DEPTH || names.length >= MAX_NAMES) return;
      const path = `${this.mount}/metadata/${this.prefix}${folder}`.replace(/\/+$/, '');
      const listed = await this.read<{ data?: { keys?: string[] } }>(`${path.split('/').map(encodeURIComponent).join('/')}?list=true`, true);
      for (const key of listed?.data?.keys ?? []) {
        if (key.endsWith('/')) await walk(`${folder}${key}`, depth + 1);
        else if (names.length < MAX_NAMES) names.push(`${folder}${key}`);
      }
    };
    await walk('', 0);
    return names.sort();
  }

  async getSecret(name: string): Promise<SecretValue | undefined> {
    const response = await this.read<{ data?: { data?: Record<string, unknown> | null } }>(this.dataPath(name), true);
    const data = response?.data?.data;
    // A deleted (soft-deleted) version reads as null data.
    return data && typeof data === 'object' ? data : undefined;
  }

  async test(): Promise<string> {
    await this.token();
    const names = await this.listNames();
    return `${names.length} secret${names.length === 1 ? '' : 's'} in ${this.mount}/${this.prefix}${this.namespace ? ` (namespace ${this.namespace})` : ''}`;
  }

  close() {
    this.closed = true;
    clearTimeout(this.timer);
  }

  /** For tests: the current session's lease. */
  get lease(): { leaseSeconds: number; renewable: boolean } | undefined {
    return this.session && { leaseSeconds: this.session.leaseSeconds, renewable: this.session.renewable };
  }
}

export const vaultProvider: ProviderDefinition = {
  kind: 'vault',
  label: 'OpenBao / HashiCorp Vault',
  description: 'KV version 2 secrets, with token, AppRole or Kubernetes auth',
  defaultName: 'vault',
  get fields(): SecretProviderField[] {
    const auth = [...methods.entries()];
    return [
      { name: 'url', label: 'Vault URL', type: 'string', required: true, placeholder: 'https://vault.example.com:8200' },
      { name: 'namespace', label: 'Namespace', type: 'string', hint: 'Vault Enterprise or OpenBao namespace (optional)' },
      { name: 'mount', label: 'KV v2 mount', type: 'string', default: 'secret', placeholder: 'secret' },
      { name: 'pathPrefix', label: 'Path prefix', type: 'string', placeholder: 'apps/{environment}', hint: 'Only secrets under this path; {environment} is the instance’s environment' },
      { name: 'auth', label: 'Auth method', type: 'options', default: 'token', options: auth.map(([value, method]) => ({ value, label: method.label })) },
      ...auth.flatMap(([, method]) => method.fields).filter((field, index, all) => all.findIndex((f) => f.name === field.name) === index),
    ];
  },
  get secretFields(): string[] {
    return [...new Set([...methods.values()].flatMap((method) => method.secretFields ?? []))];
  },
  create: (config, context) => new VaultClient(config, context),
};

export type { VaultClient };
