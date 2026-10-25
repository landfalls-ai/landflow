/**
 * External secrets providers against local fakes (test/fake-secret-stores.ts): OpenBao/Vault KV v2 with token,
 * AppRole and Kubernetes auth, namespaces, lease renewal and a fresh login after a revoked token; 1Password Connect;
 * AWS Secrets Manager with a checked SigV4 signature (and AWS's published test vector); Google Secret Manager with a
 * verified service account JWT; Azure Key Vault with client credentials. Names are listed, values read, prefixes
 * and `{environment}` applied, and errors never carry secret values. Nothing reaches a real cloud: every client gets
 * an explicit local endpoint and fake keys, and the AWS shared config files are pointed at /dev/null.
 */
import { devNull } from 'node:os';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Never let anything fall back to this machine's AWS configuration.
Object.assign(process.env, { AWS_SHARED_CREDENTIALS_FILE: devNull, AWS_CONFIG_FILE: devNull, AWS_EC2_METADATA_DISABLED: 'true' });
delete process.env.AWS_PROFILE;
delete process.env.AWS_ACCESS_KEY_ID;
delete process.env.AWS_SECRET_ACCESS_KEY;
delete process.env.AWS_SESSION_TOKEN;

const { PROVIDERS, signV4, registerVaultAuthMethod, providerKinds } = await import('@/lib/server/secrets/providers');
const fakes = await import('./fake-secret-stores');

type Provider = ReturnType<(typeof PROVIDERS)['vault']['create']>;
const opened: Provider[] = [];
const create = (kind: keyof typeof PROVIDERS, config: Record<string, string | number | undefined>, environment?: string) => {
  const provider = PROVIDERS[kind].create(config, { environment });
  opened.push(provider);
  return provider;
};
afterAll(() => opened.forEach((p) => p.close?.()));

describe('OpenBao / Vault (KV v2)', () => {
  let vault: Awaited<ReturnType<typeof fakes.fakeVault>>;
  beforeAll(async () => {
    vault = await fakes.fakeVault({ rootToken: 'root-token' });
    vault.kv.secret = {
      'dev/hello': { message: 'hello from vault' },
      'dev/db': { username: 'app', password: 'S3cret-Passw0rd' },
      'dev/nested/deep': { token: 'deep-token-value' },
      'prod/db': { password: 'prod-password-value' },
      top: { value: 'top-level-value' },
    };
  });
  afterAll(() => vault.close());

  it('lists names recursively and reads values with a token', async () => {
    const provider = create('vault', { url: vault.url, auth: 'token', token: 'root-token', mount: 'secret' });
    expect(await provider.listNames()).toEqual(['dev/db', 'dev/hello', 'dev/nested/deep', 'prod/db', 'top']);
    expect(await provider.getSecret('dev/db')).toEqual({ username: 'app', password: 'S3cret-Passw0rd' });
    expect(await provider.getSecret('dev/missing')).toBeUndefined();
    expect(await provider.test()).toBe('5 secrets in secret/');
    await expect(provider.getSecret('../sys/seal')).rejects.toThrow(/Not a secret path/);
  });

  it('scopes names to a path prefix with {environment}', async () => {
    const provider = create('vault', { url: vault.url, auth: 'token', token: 'root-token', pathPrefix: '{environment}' }, 'dev');
    expect(await provider.listNames()).toEqual(['db', 'hello', 'nested/deep']);
    expect(await provider.getSecret('hello')).toEqual({ message: 'hello from vault' });
  });

  it('refuses a bad token without echoing it', async () => {
    const provider = create('vault', { url: vault.url, auth: 'token', token: 'wrong-token-123456' });
    const error = await provider.test().catch((e: Error) => e);
    expect((error as Error).message).toMatch(/Vault answered HTTP 403: permission denied/);
    expect((error as Error).message).not.toContain('wrong-token-123456');
  });

  it('logs in with AppRole, renews the lease and logs in again after a revoked token', async () => {
    const provider = create('vault', { url: vault.url, auth: 'appRole', roleId: 'role-123', secretId: 'secret-456' }) as Provider & { renew(): Promise<boolean>; lease?: { leaseSeconds: number } };
    const logins = vault.logins;
    expect(await provider.getSecret('dev/hello')).toEqual({ message: 'hello from vault' });
    expect(vault.logins).toBe(logins + 1);
    expect(provider.lease).toEqual({ leaseSeconds: 3600, renewable: true });
    const renewals = vault.renewals;
    expect(await provider.renew()).toBe(true);
    expect(vault.renewals).toBe(renewals + 1);
    // The token is revoked behind our back: the next read logs in again and succeeds.
    for (const token of [...vault.tokens.keys()]) if (token.startsWith('login-token-')) vault.tokens.delete(token);
    expect(await provider.getSecret('dev/db')).toMatchObject({ username: 'app' });
    expect(vault.logins).toBe(logins + 2);
    const bad = create('vault', { url: vault.url, auth: 'appRole', roleId: 'role-123', secretId: 'nope-nope' });
    await expect(bad.test()).rejects.toThrow(/invalid role or secret ID/);
  });

  it('renews a short lease in the background at two thirds of it', async () => {
    vault.approle.lease = 1;
    try {
      const provider = create('vault', { url: vault.url, auth: 'appRole', roleId: 'role-123', secretId: 'secret-456' });
      const renewals = vault.renewals;
      await provider.listNames();
      await vi.waitFor(() => expect(vault.renewals).toBeGreaterThan(renewals), { timeout: 3_000, interval: 100 });
      provider.close?.();
    } finally {
      vault.approle.lease = 3600;
    }
  });

  it('logs in with Kubernetes (a token or the token file)', async () => {
    const provider = create('vault', { url: vault.url, auth: 'kubernetes', role: 'landflow', jwt: 'header.payload.signature' });
    expect(await provider.getSecret('top')).toEqual({ value: 'top-level-value' });
    const missing = create('vault', { url: vault.url, auth: 'kubernetes', role: 'landflow', jwtPath: '/nonexistent/landflow/token' });
    await expect(missing.test()).rejects.toThrow(/No service account token at \/nonexistent\/landflow\/token/);
  });

  it('sends the namespace header', async () => {
    const scoped = await fakes.fakeVault({ rootToken: 'ns-root', namespace: 'team-a' });
    scoped.kv.secret = { app: { key: 'namespaced-value' } };
    try {
      expect(await create('vault', { url: scoped.url, auth: 'token', token: 'ns-root', namespace: 'team-a' }).getSecret('app')).toEqual({ key: 'namespaced-value' });
      await expect(create('vault', { url: scoped.url, auth: 'token', token: 'ns-root' }).test()).rejects.toThrow(/403/);
      expect(scoped.requests.filter((r) => r.headers['x-vault-namespace'] === 'team-a').length).toBeGreaterThan(0);
    } finally {
      await scoped.close();
    }
  });

  it('takes pluggable auth methods', async () => {
    registerVaultAuthMethod('fixedToken', {
      label: 'Fixed token (test)',
      fields: [],
      canLoginAgain: false,
      login: async () => ({ token: 'root-token', leaseSeconds: 0, renewable: false }),
    });
    expect(providerKinds().find((k) => k.kind === 'vault')!.fields.find((f) => f.name === 'auth')!.options!.map((o) => o.value)).toContain('fixedToken');
    expect(await create('vault', { url: vault.url, auth: 'fixedToken' }).getSecret('top')).toEqual({ value: 'top-level-value' });
  });

  it('checks the URL', () => {
    expect(() => create('vault', { url: 'ftp://vault', auth: 'token', token: 'x' })).toThrow(/http:\/\/ or https:\/\//);
    expect(() => create('vault', { url: 'https://user:pw@vault', auth: 'token', token: 'x' })).toThrow(/Keep credentials out/);
  });
});

describe('1Password Connect', () => {
  let op: fakes.Fake;
  beforeAll(async () => {
    op = await fakes.fakeOnePassword('connect-token-abc', [
      {
        id: 'v1',
        name: 'Dev',
        items: [
          { id: 'i1', title: 'Stripe', fields: [{ id: 'credential', label: 'credential', value: 'sk_test_onepassword' }] },
          { id: 'i2', title: 'Database', fields: [{ id: 'username', label: 'username', value: 'dbuser', purpose: 'USERNAME' }, { id: 'password', label: 'Passwort', value: 'op-db-password', purpose: 'PASSWORD' }] },
        ],
      },
      { id: 'v2', name: 'Prod', items: [{ id: 'i3', title: 'Stripe', fields: [{ id: 'credential', label: 'credential', value: 'sk_live_other' }] }, { id: 'i4', title: 'Only prod', fields: [] }] },
    ]);
  });
  afterAll(() => op.close());

  it('lists item titles and reads fields by label and purpose', async () => {
    const provider = create('onePassword', { url: op.url, token: 'connect-token-abc' });
    expect(await provider.listNames()).toEqual(['Database', 'Only prod', 'Stripe']);
    // Two items with one title: the first vault wins.
    expect(await provider.getSecret('Stripe')).toEqual({ credential: 'sk_test_onepassword' });
    expect(await provider.getSecret('Database')).toEqual({ username: 'dbuser', Passwort: 'op-db-password', password: 'op-db-password' });
    expect(await provider.getSecret('Nope')).toBeUndefined();
    expect(await provider.test()).toBe('3 items in 2 vaults');
  });

  it('limits to vaults by name ({environment} too) and refuses a bad token', async () => {
    const provider = create('onePassword', { url: op.url, token: 'connect-token-abc', vaults: '{environment}' }, 'Prod');
    expect(await provider.listNames()).toEqual(['Only prod', 'Stripe']);
    expect(await provider.getSecret('Stripe')).toEqual({ credential: 'sk_live_other' });
    await expect(create('onePassword', { url: op.url, token: 'connect-token-abc', vaults: 'Missing' }).test()).rejects.toThrow(/can’t read vault Missing/);
    await expect(create('onePassword', { url: op.url, token: 'bad' }).test()).rejects.toThrow(/401: Invalid token/);
  });
});

describe('AWS Secrets Manager', () => {
  let aws: Awaited<ReturnType<typeof fakes.fakeAwsSecretsManager>>;
  beforeAll(async () => {
    aws = await fakes.fakeAwsSecretsManager({ 'dev/db': JSON.stringify({ password: 'aws-db-password', port: 5432 }), 'dev/api-key': 'plain-api-key-value', 'prod/db': '{"password":"prod"}', other: 'x' });
  });
  afterAll(() => aws.close());

  it('matches AWS’s SigV4 test vector (get-vanilla)', () => {
    const headers = signV4({
      method: 'GET',
      url: 'https://example.amazonaws.com/',
      headers: {},
      body: '',
      region: 'us-east-1',
      service: 'service',
      accessKeyId: 'AKIDEXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
      now: new Date('2015-08-30T12:36:00Z'),
    });
    expect(headers.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
    );
    expect(headers['x-amz-date']).toBe('20150830T123600Z');
  });

  it('lists across pages with a prefix and reads JSON and text secrets, signed', async () => {
    const provider = create('awsSecretsManager', { region: 'eu-west-1', auth: 'accessKey', ...fakes.AWS_TEST_KEYS, endpoint: aws.url, namePrefix: '{environment}/' }, 'dev');
    expect(await provider.listNames()).toEqual(['api-key', 'db']);
    expect(await provider.getSecret('db')).toEqual({ password: 'aws-db-password', port: 5432 });
    expect(await provider.getSecret('api-key')).toBe('plain-api-key-value');
    expect(await provider.getSecret('missing')).toBeUndefined();
    expect(aws.badSignatures).toBe(0);
    const all = create('awsSecretsManager', { region: 'eu-west-1', ...fakes.AWS_TEST_KEYS, endpoint: aws.url });
    expect(await all.listNames()).toEqual(['dev/api-key', 'dev/db', 'other', 'prod/db']);
  });

  it('refuses wrong keys, never reads ~/.aws, and wants a region', async () => {
    const wrong = create('awsSecretsManager', { region: 'eu-west-1', accessKeyId: fakes.AWS_TEST_KEYS.accessKeyId, secretAccessKey: 'not-the-right-secret', endpoint: aws.url });
    const error = (await wrong.test().catch((e: Error) => e)) as Error;
    expect(error.message).toMatch(/AWS Secrets Manager answered HTTP 403: The request signature/);
    expect(error.message).not.toContain('not-the-right-secret');
    // Host environment auth: only the AWS_* variables, which aren't set here.
    expect(() => create('awsSecretsManager', { region: 'eu-west-1', auth: 'environment', endpoint: aws.url })).toThrow(/AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are not set/);
    expect(() => create('awsSecretsManager', { region: 'mars', ...fakes.AWS_TEST_KEYS, endpoint: aws.url })).toThrow(/AWS region/);
    Object.assign(process.env, { AWS_ACCESS_KEY_ID: fakes.AWS_TEST_KEYS.accessKeyId, AWS_SECRET_ACCESS_KEY: fakes.AWS_TEST_KEYS.secretAccessKey });
    try {
      expect(await create('awsSecretsManager', { region: 'eu-west-1', auth: 'environment', endpoint: aws.url }).getSecret('other')).toBe('x');
    } finally {
      delete process.env.AWS_ACCESS_KEY_ID;
      delete process.env.AWS_SECRET_ACCESS_KEY;
    }
  });
});

describe('Google Cloud Secret Manager', () => {
  let gcp: Awaited<ReturnType<typeof fakes.fakeGcpSecretManager>>;
  beforeAll(async () => {
    gcp = await fakes.fakeGcpSecretManager('test-project', { dev_db: '{"password":"gcp-db-password"}', dev_token: 'gcp-plain-token', prod_db: 'p' });
  });
  afterAll(() => gcp.close());

  it('signs a service account JWT, lists names across pages and reads the latest version', async () => {
    const provider = create('gcpSecretManager', { serviceAccountKey: gcp.key, endpoint: gcp.url, namePrefix: '{environment}_' }, 'dev');
    expect(await provider.listNames()).toEqual(['db', 'token']);
    expect(await provider.getSecret('db')).toEqual({ password: 'gcp-db-password' });
    expect(await provider.getSecret('token')).toBe('gcp-plain-token');
    expect(await provider.getSecret('missing')).toBeUndefined();
    expect(await provider.getSecret('bad/name')).toBeUndefined();
    // One access token for all of that.
    expect(gcp.tokens).toBe(1);
  });

  it('checks the key', async () => {
    expect(() => create('gcpSecretManager', { serviceAccountKey: 'not json', endpoint: gcp.url })).toThrow(/not JSON/);
    expect(() => create('gcpSecretManager', { serviceAccountKey: '{"client_email":"x"}', endpoint: gcp.url })).toThrow(/no client_email or private_key/);
    const other = await fakes.fakeGcpSecretManager('test-project', {});
    try {
      // A key the token endpoint doesn't know (signed by another key pair).
      const forged = JSON.stringify({ ...JSON.parse(other.key), token_uri: `${gcp.url}/token` });
      await expect(create('gcpSecretManager', { serviceAccountKey: forged, endpoint: gcp.url }).test()).rejects.toThrow(/invalid_grant|Invalid JWT/);
    } finally {
      await other.close();
    }
  });
});

describe('Azure Key Vault', () => {
  let azure: Awaited<ReturnType<typeof fakes.fakeAzureKeyVault>>;
  beforeAll(async () => {
    azure = await fakes.fakeAzureKeyVault('tenant-1', { id: 'client-1', secret: 'client-secret-xyz' }, {
      'dev-db-password': { value: 'azure-db-password' },
      'dev-config': { value: '{"url":"https://api.example","key":"azure-config-key"}' },
      'dev-old': { value: 'disabled', enabled: false },
      'prod-db-password': { value: 'prod' },
    });
  });
  afterAll(() => azure.close());

  it('gets a token with client credentials, follows next links and reads secrets', async () => {
    const provider = create('azureKeyVault', { vaultUrl: azure.url, tenantId: 'tenant-1', clientId: 'client-1', clientSecret: 'client-secret-xyz', authorityHost: azure.url, namePrefix: '{environment}-' }, 'dev');
    expect(await provider.listNames()).toEqual(['config', 'db-password']);
    expect(await provider.getSecret('db-password')).toBe('azure-db-password');
    expect(await provider.getSecret('config')).toEqual({ url: 'https://api.example', key: 'azure-config-key' });
    expect(await provider.getSecret('old')).toBeUndefined();
    expect(await provider.getSecret('no_underscores')).toBeUndefined();
    expect(azure.tokens).toBe(1);
  });

  it('refuses a wrong client secret without echoing it', async () => {
    const provider = create('azureKeyVault', { vaultUrl: azure.url, tenantId: 'tenant-1', clientId: 'client-1', clientSecret: 'wrong-client-secret', authorityHost: azure.url });
    const error = (await provider.test().catch((e: Error) => e)) as Error;
    expect(error.message).toMatch(/Microsoft Entra sign-in answered HTTP 401: AADSTS7000215/);
    expect(error.message).not.toContain('wrong-client-secret');
  });
});
