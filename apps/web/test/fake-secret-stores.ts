/**
 * Fake secret stores for the external secrets tests: small node:http servers on 127.0.0.1 that speak just enough
 * of each API — Vault/OpenBao KV v2 (token lookup, AppRole and Kubernetes login, renew-self, namespaces, LIST),
 * 1Password Connect, AWS Secrets Manager (checking the SigV4 signature), Google Secret Manager (checking the
 * service account JWT) and Azure Key Vault (client credentials). Nothing leaves the machine; no cloud SDK or CLI.
 */
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { signV4 } from '@/lib/server/secrets/providers/aws';

export interface Fake {
  url: string;
  /** Requests seen: method, path (with query) and headers. */
  requests: Array<{ method: string; path: string; headers: Record<string, string | string[] | undefined>; body: string }>;
  close(): Promise<void>;
}

type Handler = (req: IncomingMessage & { body: string; url: string }, res: ServerResponse) => void | Promise<void>;

async function serve(handler: Handler): Promise<Fake & { server: Server }> {
  const requests: Fake['requests'] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString('utf8');
    requests.push({ method: req.method ?? 'GET', path: req.url ?? '/', headers: req.headers, body });
    try {
      await handler(Object.assign(req, { body, url: req.url ?? '/' }), res);
    } catch (error) {
      res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: (error as Error).message }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, requests, server, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

/** Counters as live properties (Object.assign would copy their values once). */
function live<T extends object>(target: T, values: Record<string, () => unknown>, setters: Record<string, (value: never) => void> = {}): T {
  for (const [key, get] of Object.entries(values)) Object.defineProperty(target, key, { get, ...(setters[key] && { set: setters[key] }), enumerable: true, configurable: true });
  return target;
}

const send = (res: ServerResponse, status: number, body: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));

// ---------------------------------------------------------------------------
// Vault / OpenBao
// ---------------------------------------------------------------------------

export interface FakeVault extends Fake {
  /** `mount → path → data` (KV v2 entries). */
  kv: Record<string, Record<string, Record<string, unknown>>>;
  /** Valid tokens and their lease. */
  tokens: Map<string, { ttl: number; renewable: boolean; namespace?: string }>;
  approle: { roleId: string; secretId: string; lease: number };
  kubernetes: { role: string; jwt: string };
  renewals: number;
  logins: number;
  /** Only this namespace answers (when set). */
  namespace?: string;
}

export async function fakeVault(options: { rootToken?: string; namespace?: string } = {}): Promise<FakeVault> {
  const state = {
    kv: { secret: {} } as FakeVault['kv'],
    tokens: new Map<string, { ttl: number; renewable: boolean }>([[options.rootToken ?? 'root-token', { ttl: 0, renewable: false }]]),
    approle: { roleId: 'role-123', secretId: 'secret-456', lease: 3600 },
    kubernetes: { role: 'landflow', jwt: 'header.payload.signature' },
    renewals: 0,
    logins: 0,
    namespace: options.namespace,
  };
  let issued = 0;
  const fake = await serve((req, res) => {
    const url = new URL(req.url, 'http://vault');
    const path = url.pathname.replace(/^\/v1\//, '');
    if (state.namespace && req.headers['x-vault-namespace'] !== state.namespace) return send(res, 403, { errors: ['permission denied (namespace)'] });
    const login = (lease: number) => {
      const token = `login-token-${++issued}`;
      state.logins++;
      state.tokens.set(token, { ttl: lease, renewable: true });
      return send(res, 200, { auth: { client_token: token, lease_duration: lease, renewable: true } });
    };
    if (req.method === 'POST' && path === 'auth/approle/login') {
      const body = JSON.parse(req.body) as { role_id?: string; secret_id?: string };
      if (body.role_id !== state.approle.roleId || body.secret_id !== state.approle.secretId) return send(res, 400, { errors: ['invalid role or secret ID'] });
      return login(state.approle.lease);
    }
    if (req.method === 'POST' && path === 'auth/kubernetes/login') {
      const body = JSON.parse(req.body) as { role?: string; jwt?: string };
      if (body.role !== state.kubernetes.role || body.jwt !== state.kubernetes.jwt) return send(res, 403, { errors: ['permission denied'] });
      return login(600);
    }
    const token = String(req.headers['x-vault-token'] ?? '');
    const session = state.tokens.get(token);
    if (!session) return send(res, 403, { errors: ['permission denied'] });
    if (path === 'auth/token/lookup-self') return send(res, 200, { data: { ttl: session.ttl, renewable: session.renewable } });
    if (req.method === 'POST' && path === 'auth/token/renew-self') {
      state.renewals++;
      return send(res, 200, { auth: { client_token: token, lease_duration: session.ttl || 3600, renewable: true } });
    }
    const [mount, kind, ...rest] = path.split('/');
    const entries = state.kv[mount];
    if (!entries) return send(res, 404, { errors: [] });
    const key = rest.map(decodeURIComponent).join('/');
    if (kind === 'metadata' && url.searchParams.get('list') === 'true') {
      const prefix = key ? `${key}/` : '';
      const keys = new Set<string>();
      for (const name of Object.keys(entries)) {
        if (!name.startsWith(prefix)) continue;
        const remainder = name.slice(prefix.length);
        keys.add(remainder.includes('/') ? `${remainder.slice(0, remainder.indexOf('/'))}/` : remainder);
      }
      return keys.size ? send(res, 200, { data: { keys: [...keys].sort() } }) : send(res, 404, { errors: [] });
    }
    if (kind === 'data') {
      const data = entries[key];
      return data ? send(res, 200, { data: { data, metadata: { version: 1 } } }) : send(res, 404, { errors: [] });
    }
    return send(res, 404, { errors: ['unsupported path'] });
  });
  Object.assign(fake, { kv: state.kv, tokens: state.tokens, approle: state.approle, kubernetes: state.kubernetes });
  return live(fake, { renewals: () => state.renewals, logins: () => state.logins, namespace: () => state.namespace }, { namespace: (value: string | undefined) => (state.namespace = value) }) as unknown as FakeVault;
}

// ---------------------------------------------------------------------------
// 1Password Connect
// ---------------------------------------------------------------------------

export interface OnePasswordItem {
  id: string;
  title: string;
  fields: Array<{ id?: string; label?: string; value?: string; purpose?: string }>;
}

export async function fakeOnePassword(token: string, vaults: Array<{ id: string; name: string; items: OnePasswordItem[] }>): Promise<Fake> {
  return serve((req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) return send(res, 401, { status: 401, message: 'Invalid token' });
    const parts = new URL(req.url, 'http://op').pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (parts[0] !== 'v1' || parts[1] !== 'vaults') return send(res, 404, { message: 'not found' });
    if (parts.length === 2) return send(res, 200, vaults.map(({ id, name }) => ({ id, name })));
    const vault = vaults.find((v) => v.id === parts[2]);
    if (!vault) return send(res, 404, { message: 'vault not found' });
    if (parts.length === 4) return send(res, 200, vault.items.map(({ id, title }) => ({ id, title, vault: { id: vault.id } })));
    const item = vault.items.find((i) => i.id === parts[4]);
    return item ? send(res, 200, item) : send(res, 404, { message: 'item not found' });
  });
}

// ---------------------------------------------------------------------------
// AWS Secrets Manager
// ---------------------------------------------------------------------------

export const AWS_TEST_KEYS = { accessKeyId: 'AKIDLANDFLOWTEST', secretAccessKey: 'landflow-test-secret-access-key' };

export interface FakeAws extends Fake {
  secrets: Record<string, string>;
  /** Signatures that didn't match. */
  badSignatures: number;
}

export async function fakeAwsSecretsManager(secrets: Record<string, string>, region = 'eu-west-1'): Promise<FakeAws> {
  let badSignatures = 0;
  const fake = await serve((req, res) => {
    const authorization = String(req.headers.authorization ?? '');
    const amzDate = String(req.headers['x-amz-date'] ?? '');
    const at = new Date(`${amzDate.slice(0, 4)}-${amzDate.slice(4, 6)}-${amzDate.slice(6, 8)}T${amzDate.slice(9, 11)}:${amzDate.slice(11, 13)}:${amzDate.slice(13, 15)}Z`);
    const expected = signV4({
      method: 'POST',
      url: `http://${req.headers.host}${req.url}`,
      headers: { 'content-type': String(req.headers['content-type']), 'x-amz-target': String(req.headers['x-amz-target']) },
      body: req.body,
      region,
      service: 'secretsmanager',
      ...AWS_TEST_KEYS,
      now: at,
    }).authorization;
    if (!authorization.startsWith(`AWS4-HMAC-SHA256 Credential=${AWS_TEST_KEYS.accessKeyId}/`) || authorization !== expected) {
      badSignatures++;
      return send(res, 403, { __type: 'InvalidSignatureException', message: 'The request signature we calculated does not match the signature you provided.' });
    }
    const target = String(req.headers['x-amz-target']);
    const body = JSON.parse(req.body || '{}') as { SecretId?: string; NextToken?: string; MaxResults?: number; Filters?: Array<{ Key: string; Values: string[] }> };
    if (target === 'secretsmanager.ListSecrets') {
      const prefix = body.Filters?.find((f) => f.Key === 'name')?.Values[0] ?? '';
      const names = Object.keys(secrets)
        .filter((n) => n.startsWith(prefix))
        .sort();
      // Two per page, to exercise NextToken.
      const start = body.NextToken ? Number(body.NextToken) : 0;
      const page = names.slice(start, start + 2);
      return send(res, 200, { SecretList: page.map((Name) => ({ Name, ARN: `arn:aws:secretsmanager:${region}:000000000000:secret:${Name}` })), ...(start + 2 < names.length && { NextToken: String(start + 2) }) });
    }
    if (target === 'secretsmanager.GetSecretValue') {
      const value = secrets[body.SecretId ?? ''];
      if (value === undefined) return send(res, 400, { __type: 'ResourceNotFoundException', message: "Secrets Manager can't find the specified secret." });
      return send(res, 200, { Name: body.SecretId, SecretString: value, VersionId: 'v1' });
    }
    return send(res, 400, { __type: 'UnknownOperationException', message: target });
  });
  return live(Object.assign(fake, { secrets }), { badSignatures: () => badSignatures }) as FakeAws;
}

// ---------------------------------------------------------------------------
// Google Secret Manager
// ---------------------------------------------------------------------------

export interface FakeGcp extends Fake {
  /** The service account key file to configure. */
  key: string;
  tokens: number;
}

export async function fakeGcpSecretManager(project: string, secrets: Record<string, string>): Promise<FakeGcp> {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  let tokens = 0;
  let fakeUrl = '';
  const fake = await serve((req, res) => {
    const url = new URL(req.url, 'http://gcp');
    if (req.method === 'POST' && url.pathname === '/token') {
      const form = new URLSearchParams(req.body);
      const assertion = form.get('assertion') ?? '';
      const [header, claims, signature] = assertion.split('.');
      const ok = form.get('grant_type') === 'urn:ietf:params:oauth:grant-type:jwt-bearer' && createVerify('RSA-SHA256').update(`${header}.${claims}`).verify(publicKey, Buffer.from(signature ?? '', 'base64url'));
      const body = ok ? (JSON.parse(Buffer.from(claims, 'base64url').toString()) as { iss?: string; aud?: string; scope?: string; exp?: number }) : undefined;
      if (!body || body.iss !== 'landflow@test-project.iam.gserviceaccount.com' || body.aud !== `${fakeUrl}/token` || !body.scope?.includes('cloud-platform')) return send(res, 400, { error: 'invalid_grant', error_description: 'Invalid JWT signature.' });
      tokens++;
      return send(res, 200, { access_token: `ya29.fake-${tokens}`, expires_in: 3599, token_type: 'Bearer' });
    }
    if (!String(req.headers.authorization ?? '').startsWith('Bearer ya29.fake-')) return send(res, 401, { error: { code: 401, message: 'Request had invalid authentication credentials.' } });
    const base = `/v1/projects/${project}/secrets`;
    if (url.pathname === base) {
      const names = Object.keys(secrets).sort();
      const start = Number(url.searchParams.get('pageToken') ?? 0);
      const page = names.slice(start, start + 2);
      return send(res, 200, { secrets: page.map((n) => ({ name: `projects/${project}/secrets/${n}` })), ...(start + 2 < names.length && { nextPageToken: String(start + 2) }) });
    }
    const access = new RegExp(`^${base}/([^/]+)/versions/latest:access$`).exec(url.pathname);
    if (access) {
      const value = secrets[decodeURIComponent(access[1])];
      return value === undefined ? send(res, 404, { error: { code: 404, message: 'Secret not found', status: 'NOT_FOUND' } }) : send(res, 200, { name: `${access[1]}/versions/1`, payload: { data: Buffer.from(value).toString('base64') } });
    }
    return send(res, 404, { error: { code: 404, message: 'not found' } });
  });
  fakeUrl = fake.url;
  const key = JSON.stringify({ type: 'service_account', project_id: project, private_key_id: 'kid-1', private_key: pem, client_email: 'landflow@test-project.iam.gserviceaccount.com', token_uri: `${fake.url}/token` });
  return live(Object.assign(fake, { key }), { tokens: () => tokens }) as FakeGcp;
}

// ---------------------------------------------------------------------------
// Azure Key Vault
// ---------------------------------------------------------------------------

export interface FakeAzure extends Fake {
  tokens: number;
}

export async function fakeAzureKeyVault(tenant: string, client: { id: string; secret: string }, secrets: Record<string, { value: string; enabled?: boolean }>): Promise<FakeAzure> {
  let tokens = 0;
  let base = '';
  const fake = await serve((req, res) => {
    const url = new URL(req.url, 'http://azure');
    if (req.method === 'POST' && url.pathname === `/${tenant}/oauth2/v2.0/token`) {
      const form = new URLSearchParams(req.body);
      if (form.get('grant_type') !== 'client_credentials' || form.get('client_id') !== client.id || form.get('client_secret') !== client.secret || form.get('scope') !== 'https://vault.azure.net/.default') {
        return send(res, 401, { error: 'invalid_client', error_description: 'AADSTS7000215: Invalid client secret provided.' });
      }
      tokens++;
      return send(res, 200, { token_type: 'Bearer', expires_in: 3599, access_token: `eyFake.azure.${tokens}` });
    }
    if (!String(req.headers.authorization ?? '').startsWith('Bearer eyFake.azure.')) return send(res, 401, { error: { code: 'Unauthorized', message: 'AKV10000: Request is missing a Bearer or PoP token.' } });
    if (url.searchParams.get('api-version') !== '7.4') return send(res, 400, { error: { code: 'BadParameter', message: 'api-version' } });
    if (url.pathname === '/secrets') {
      const names = Object.keys(secrets).sort();
      const start = Number(url.searchParams.get('$skiptoken') ?? 0);
      const page = names.slice(start, start + 2);
      return send(res, 200, {
        value: page.map((n) => ({ id: `${base}/secrets/${n}`, attributes: { enabled: secrets[n].enabled !== false } })),
        nextLink: start + 2 < names.length ? `${base}/secrets?api-version=7.4&$skiptoken=${start + 2}&maxresults=25` : null,
      });
    }
    const one = /^\/secrets\/([^/]+)$/.exec(url.pathname);
    if (one) {
      const secret = secrets[decodeURIComponent(one[1])];
      return secret && secret.enabled !== false ? send(res, 200, { value: secret.value, id: `${base}/secrets/${one[1]}/v1` }) : send(res, 404, { error: { code: 'SecretNotFound', message: 'A secret with this name was not found.' } });
    }
    return send(res, 404, { error: { code: 'NotFound', message: 'not found' } });
  });
  base = fake.url;
  return live(fake, { tokens: () => tokens }) as FakeAzure;
}

/** An HTTP server that answers every request with the headers it got (to see what a node sent). */
export async function echoServer(): Promise<Fake> {
  return serve((req, res) => {
    const url = new URL(req.url, 'http://echo');
    if (url.pathname === '/fail') return send(res, 500, { message: `rejected ${String(req.headers['x-api-key'] ?? '')}` });
    return send(res, 200, { headers: req.headers, path: url.pathname });
  });
}
