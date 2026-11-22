/**
 * API key hardening (C17): an allow-list of addresses and a use cap per key, the last address, the use count in its own
 * table; the same rules for SCIM tokens and the instance MCP endpoint. Requests carry real keys (the test bypass is
 * off); the address is the one `X-Forwarded-For` gives under LANDFLOW_TRUSTED_PROXIES.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// What the guard counts as landflow.http.denied{reason}.
const countedDenials = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock('@/lib/server/rate-limit/counters', () => ({ countDenied: (reason: string) => countedDenials.calls.push(reason), countRateLimitRefused: () => {} }));

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-keys-'));
const ENV: Record<string, string> = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_TRUSTED_PROXIES: '1' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);
for (const key of ['LANDFLOW_OWNER_EMAIL', 'LANDFLOW_OWNER_PASSWORD']) delete process.env[key];

const auth = await import('@/lib/server/auth');
const keys = await import('@/lib/server/auth/api-keys');
const uses = await import('@/lib/server/auth/api-key-uses');
const { database } = await import('@/lib/server/db');
const { createSession } = await import('@/lib/server/auth/sessions');
const workflowsRoute = await import('@/app/api/workflows/route');
const apiKeysRoute = await import('@/app/api/api-keys/route');
const apiKeyRoute = await import('@/app/api/api-keys/[id]/route');
const usersRoute = await import('@/app/scim/v2/Users/route');
const { authenticateMcpRequest, McpAuthError } = await import('@/lib/server/mcp/identity');
const { setMcpEnabled } = await import('@/lib/server/mcp/instance');
const mcpRoute = await import('@/app/api/mcp/route');
const counterValue = (reason: string) => countedDenials.calls.filter((r) => r === reason).length;

beforeAll(() => auth.disableTestAuth());
afterAll(() => {
  auth.enableTestAuth();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const BASE = 'http://localhost:3000';
type Handler = (request: Request, ctx?: { params: Promise<Record<string, string>> }) => Promise<Response>;

function req(path: string, opts: { key?: string; ip?: string; method?: string; body?: unknown; session?: string; params?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { 'x-forwarded-for': opts.ip ?? '10.1.2.3' };
  if (opts.key) headers.authorization = `Bearer ${opts.key}`;
  if (opts.session) headers.cookie = `landflow_session=${opts.session}`;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  return new Request(`${BASE}${path}`, { method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'), headers, ...(opts.body !== undefined && { body: JSON.stringify(opts.body) }) });
}

async function call(route: unknown, path: string, opts: Parameters<typeof req>[1] = {}) {
  const response = await (route as Handler)(req(path, opts), opts.params && { params: Promise.resolve(opts.params) });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : undefined) as Record<string, any> };
}

const denied = () => database().all<{ summary: string; details: string | null; target_id: string | null }>(`SELECT summary, details, target_id FROM audit_events WHERE action = 'api.denied' ORDER BY at`);
const usesOf = (id: string) => database().get<{ uses: number }>('SELECT uses FROM api_key_uses WHERE key_id = ?', id)?.uses;

let owner: Awaited<ReturnType<typeof auth.createUser>>;
let member: Awaited<ReturnType<typeof auth.createUser>>;

beforeAll(async () => {
  owner = await auth.createUser({ email: 'owner@example.com', name: 'Olive Owner', role: 'owner', password: 'owner-password-1' });
  member = await auth.createUser({ email: 'mo@example.com', name: 'Mo Member', role: 'member', password: 'mo-password-1' });
});

describe('the allow-list', () => {
  it('lets a listed address through and refuses another before any handler runs (AS-1)', async () => {
    const { token } = keys.createApiKey(owner, { label: 'ci', scopes: ['workflows:read'], allowedIps: ['10.0.0.0/8'] });
    expect((await call(workflowsRoute.GET, '/api/workflows', { key: token, ip: '10.1.2.3' })).status).toBe(200);
    const refused = await call(workflowsRoute.GET, '/api/workflows', { key: token, ip: '192.168.1.5' });
    expect(refused.status).toBe(401);
    expect(refused.body.error).toBe('This API key can’t be used from this address');
    expect(JSON.stringify(refused.body)).not.toContain('10.0.0.0');
  });

  it('does not fall back to the session cookie (FR-5)', async () => {
    const { token } = keys.createApiKey(owner, { label: 'ci2', scopes: ['workflows:read'], allowedIps: ['10.0.0.0/8'] });
    const sessionToken = createSession(owner, 'password').token;
    const refused = await call(workflowsRoute.GET, '/api/workflows', { key: token, ip: '192.168.1.5', session: sessionToken });
    expect(refused.status).toBe(401);
  });

  it('takes the address from the trusted proxy hop, not from a forged entry (AS-2)', async () => {
    const { token } = keys.createApiKey(owner, { label: 'ci3', scopes: ['workflows:read'], allowedIps: ['10.0.0.0/8'] });
    // One trusted hop: the last entry is ours; the client's forged first entry says 10.1.2.3.
    const forged = await call(workflowsRoute.GET, '/api/workflows', { key: token, ip: '10.1.2.3, 192.168.1.5' });
    expect(forged.status).toBe(401);
    expect((await call(workflowsRoute.GET, '/api/workflows', { key: token, ip: '192.168.1.5, 10.1.2.3' })).status).toBe(200);
  });

  it('matches an IPv4-mapped IPv6 caller', async () => {
    const { token } = keys.createApiKey(owner, { label: 'v6', scopes: ['workflows:read'], allowedIps: ['10.0.0.0/8'] });
    expect((await call(workflowsRoute.GET, '/api/workflows', { key: token, ip: '::ffff:10.1.2.3' })).status).toBe(200);
  });

  it('records ten refusals from a wrong address as one api.denied without the key (AS-7)', async () => {
    const before = denied().length;
    const { key, token } = keys.createApiKey(owner, { label: 'audited', scopes: ['workflows:read'], allowedIps: ['10.0.0.0/8'] });
    for (let i = 0; i < 10; i++) expect((await call(workflowsRoute.GET, '/api/workflows', { key: token, ip: '192.168.1.5' })).status).toBe(401);
    const rows = denied().slice(before);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].details ?? '{}')).toMatchObject({ reason: 'ip_not_allowed', keyId: key.id });
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(JSON.stringify(rows)).not.toContain('10.0.0.0/8');
  });

  it('leaves a key with no list working from anywhere (FR-10, AS-9)', async () => {
    const { token } = keys.createApiKey(owner, { label: 'old', scopes: ['workflows:read'] });
    expect((await call(workflowsRoute.GET, '/api/workflows', { key: token, ip: '203.0.113.9' })).status).toBe(200);
  });
});

describe('the use cap', () => {
  it('stops the call that would pass the cap and never runs its handler (AS-3)', async () => {
    const { key, token } = keys.createApiKey(owner, { label: 'cap3', scopes: ['workflows:read'], maxUses: 3 });
    for (let i = 0; i < 3; i++) expect((await call(workflowsRoute.GET, '/api/workflows', { key: token })).status).toBe(200);
    const fourth = await call(workflowsRoute.GET, '/api/workflows', { key: token });
    expect(fourth.status).toBe(401);
    expect(fourth.body.error).toBe('This API key has used all its uses');
    expect(usesOf(key.id)).toBe(3);
    expect((await call(workflowsRoute.GET, '/api/workflows', { key: token })).status).toBe(401);
    expect(usesOf(key.id)).toBe(3);
    expect(denied().some((row) => row.details?.includes('uses_exhausted') && row.target_id === key.id)).toBe(true);
  });

  it('counts only requests that reach the handler: a scope or role refusal is free (C17-D4)', async () => {
    const { key, token } = keys.createApiKey(member, { label: 'cap2', scopes: ['workflows:read'], maxUses: 2 });
    // Needs the workflows:write scope: refused by the guard.
    const refused = await call(workflowsRoute.POST, '/api/workflows', { key: token, body: { name: 'x', nodes: [], edges: [] } });
    expect(refused.status).toBe(403);
    expect(usesOf(key.id)).toBeUndefined();
    expect((await call(workflowsRoute.GET, '/api/workflows', { key: token })).status).toBe(200);
    expect(usesOf(key.id)).toBe(1);
  });

  it('makes no write for a key without a cap (FR-10)', async () => {
    const { key, token } = keys.createApiKey(owner, { label: 'free', scopes: ['workflows:read'] });
    expect((await call(workflowsRoute.GET, '/api/workflows', { key: token })).status).toBe(200);
    expect(usesOf(key.id)).toBeUndefined();
    expect(await uses.consumeApiKeyUse({ id: key.id })).toEqual({ ok: true });
    expect(usesOf(key.id)).toBeUndefined();
  });

  it('is not overwritten by the last-used touch (D7) and records the last address (FR-6)', async () => {
    const { key, token } = keys.createApiKey(owner, { label: 'touch', scopes: ['workflows:read'], maxUses: 10 });
    await call(workflowsRoute.GET, '/api/workflows', { key: token, ip: '10.9.8.7' });
    expect(usesOf(key.id)).toBe(1);
    // Force another touch (the first one is once a minute): the row is rewritten, the count stays.
    keys.verifyApiKey(token, { now: Date.now() + 120_000 });
    expect(usesOf(key.id)).toBe(1);
    expect(keys.getApiKey(key.id)?.lastUsedIp).toBe('10.9.8.7');
  });

  it('counts exactly under concurrent calls (one process)', async () => {
    const { key } = keys.createApiKey(owner, { label: 'race', scopes: ['workflows:read'], maxUses: 7 });
    const results = await Promise.all(Array.from({ length: 20 }, () => uses.consumeApiKeyUse({ id: key.id, maxUses: 7 })));
    expect(results.filter((r) => r.ok)).toHaveLength(7);
    expect(usesOf(key.id)).toBe(7);
  });
});

describe('create and list', () => {
  it('validates the list and the cap (AS-5) and records both in the create event (FR-8)', async () => {
    const sessionToken = createSession(owner, 'password').token;
    const bad = await call(apiKeysRoute.POST, '/api/api-keys', { session: sessionToken, body: { label: 'x', scopes: ['workflows:read'], allowedIps: ['300.1.1.1'] } });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).toContain('300.1.1.1');
    const many = await call(apiKeysRoute.POST, '/api/api-keys', { session: sessionToken, body: { label: 'x', scopes: ['workflows:read'], allowedIps: Array.from({ length: 51 }, (_, i) => `10.0.0.${i}`) } });
    expect(many.status).toBe(400);
    for (const maxUses of [0, -1, 1_000_001, 1.5]) {
      expect((await call(apiKeysRoute.POST, '/api/api-keys', { session: sessionToken, body: { label: 'x', scopes: ['workflows:read'], maxUses } })).status).toBe(400);
    }
    const ok = await call(apiKeysRoute.POST, '/api/api-keys', { session: sessionToken, body: { label: 'limited', scopes: ['workflows:read'], allowedIps: ['10.0.0.0/8', ' 2001:db8::/32'], maxUses: 5 } });
    expect(ok.status).toBe(201);
    expect(ok.body.key).toMatchObject({ allowedIps: ['10.0.0.0/8', '2001:db8::/32'], maxUses: 5, uses: 0 });
    const event = database().get<{ details: string }>(`SELECT details FROM audit_events WHERE action = 'api_key.create' AND target_id = ?`, ok.body.key.id);
    expect(JSON.parse(event?.details ?? '{}')).toMatchObject({ allowedIps: ['10.0.0.0/8', '2001:db8::/32'], maxUses: 5 });
  });

  it('shows the owner the last address, the uses and "used up", never the secret (AS-6)', async () => {
    const sessionToken = createSession(member, 'password').token;
    const created = await call(apiKeysRoute.POST, '/api/api-keys', { session: sessionToken, body: { label: 'view', scopes: ['workflows:read'], maxUses: 2 } });
    const token = created.body.token as string;
    for (let i = 0; i < 3; i++) await call(workflowsRoute.GET, '/api/workflows', { key: token, ip: '10.1.2.3' });
    const listed = await call(apiKeysRoute.GET, '/api/api-keys', { session: sessionToken });
    const view = (listed.body.keys as Array<Record<string, unknown>>).find((k) => k.id === created.body.key.id);
    expect(view).toMatchObject({ maxUses: 2, uses: 2, usedUp: true, lastUsedIp: '10.1.2.3' });
    expect(JSON.stringify(listed.body)).not.toContain(token);
    // Another user does not see it: keys are listed per owner.
    const otherToken = createSession(owner, 'password').token;
    const theirs = await call(apiKeysRoute.GET, '/api/api-keys', { session: otherToken });
    expect(JSON.stringify(theirs.body)).not.toContain(created.body.key.id);
  });

  it('removes the count with the key', async () => {
    const { key, token } = keys.createApiKey(owner, { label: 'gone', scopes: ['workflows:read'], maxUses: 2 });
    await call(workflowsRoute.GET, '/api/workflows', { key: token });
    expect(usesOf(key.id)).toBe(1);
    const sessionToken = createSession(owner, 'password').token;
    expect((await call(apiKeyRoute.DELETE, `/api/api-keys/${key.id}`, { method: 'DELETE', session: sessionToken, params: { id: key.id } })).status).toBeLessThan(300);
    expect(usesOf(key.id)).toBeUndefined();
  });
});

describe('SCIM tokens and the MCP endpoint follow the same rules (FR-9)', () => {
  it('answers a SCIM error document from outside the list, and past the cap (AS-8)', async () => {
    const { token } = keys.createApiKey(owner, { label: 'scim', scopes: ['scim'], allowedIps: ['10.0.0.0/8'], maxUses: 1 });
    const outside = await call(usersRoute.GET, '/scim/v2/Users', { key: token, ip: '192.168.1.5' });
    expect(outside.status).toBe(401);
    expect(outside.body.schemas).toContain('urn:ietf:params:scim:api:messages:2.0:Error');
    expect((await call(usersRoute.GET, '/scim/v2/Users', { key: token, ip: '10.1.2.3' })).status).toBe(200);
    const second = await call(usersRoute.GET, '/scim/v2/Users', { key: token, ip: '10.1.2.3' });
    expect(second.status).toBe(401);
    expect(second.body.schemas).toContain('urn:ietf:params:scim:api:messages:2.0:Error');
    expect(JSON.stringify(second.body)).toContain('used all its uses');
  });

  it('refuses an MCP call from outside the list, and past the cap', async () => {
    const { token } = keys.createApiKey(owner, { label: 'mcp', scopes: ['workflows:read'], allowedIps: ['10.0.0.0/8'], maxUses: 1 });
    await expect(authenticateMcpRequest(req('/api/mcp', { key: token, ip: '192.168.1.5' }), { pluginId: '' })).rejects.toBeInstanceOf(McpAuthError);
    await expect(authenticateMcpRequest(req('/api/mcp', { key: token, ip: '10.1.2.3' }), { pluginId: '' })).resolves.toBeTruthy();
    await expect(authenticateMcpRequest(req('/api/mcp', { key: token, ip: '10.1.2.3' }), { pluginId: '' })).rejects.toThrow('used all its uses');
  });
});

describe('review round', () => {
  const sessionFor = (user: typeof owner) => createSession(user, 'password').token;
  const withEnv = async (env: Record<string, string | undefined>, fn: () => Promise<void>) => {
    const before: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(env)) {
      before[k] = process.env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      await fn();
    } finally {
      for (const [k, v] of Object.entries(before)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  };
  const create = (body: Record<string, unknown>) => call(apiKeysRoute.POST, '/api/api-keys', { session: sessionFor(owner), body: { label: 'p', scopes: ['workflows:read'], ...body } });

  it('refuses an allow-list in production when the proxy count was never set, and ignores a forged hop with one proxy', async () => {
    await withEnv({ LANDFLOW_PROFILE: 'production', LANDFLOW_TRUSTED_PROXIES: undefined }, async () => {
      const refused = await create({ allowedIps: ['10.0.0.0/8'] });
      expect(refused.status).toBe(400);
      expect(JSON.stringify(refused.body)).toContain('LANDFLOW_TRUSTED_PROXIES');
      expect((await create({})).status).toBe(201);
      const scim = await call(apiKeysRoute.POST, '/api/api-keys', { session: sessionFor(owner), body: { label: 's', scopes: ['scim'], allowedIps: ['10.0.0.0/8'] } });
      expect(scim.status).toBe(400);
    });
    await withEnv({ LANDFLOW_PROFILE: 'production', LANDFLOW_TRUSTED_PROXIES: '1' }, async () => {
      const made = await create({ allowedIps: ['10.0.0.0/8'] });
      expect(made.status).toBe(201);
      const token = made.body.token as string;
      expect((await call(workflowsRoute.GET, '/api/workflows', { key: token, ip: '10.1.2.3, 192.168.1.5' })).status).toBe(401);
    });
  });

  it('tells the list a flag outside production when the address is unverified', async () => {
    await withEnv({ LANDFLOW_TRUSTED_PROXIES: '0' }, async () => {
      const listed = await call(apiKeysRoute.GET, '/api/api-keys', { session: sessionFor(owner) });
      expect(listed.body.addressUnverified).toBe(true);
    });
    const listed = await call(apiKeysRoute.GET, '/api/api-keys', { session: sessionFor(owner) });
    expect(listed.body.addressUnverified).toBe(false);
  });

  it('refuses a caller with no address when the key has a list', async () => {
    const { token } = keys.createApiKey(owner, { label: 'blank', scopes: ['workflows:read'], allowedIps: ['127.0.0.1'] });
    expect((await call(workflowsRoute.GET, '/api/workflows', { key: token, ip: ' ' })).status).toBe(401);
  });

  it('counts address refusals under their own label even while the audit row is throttled', async () => {
    const { token } = keys.createApiKey(owner, { label: 'metric', scopes: ['workflows:read'], allowedIps: ['10.0.0.0/8'] });
    const before = counterValue('ip_not_allowed');
    for (let i = 0; i < 3; i++) await call(workflowsRoute.GET, '/api/workflows', { key: token, ip: '192.168.1.5' });
    expect(counterValue('ip_not_allowed') - before).toBe(3);
  });

  it('shows the real refusal at the instance MCP endpoint', async () => {
    setMcpEnabled(true);
    const { token } = keys.createApiKey(owner, { label: 'mcpi', scopes: ['workflows:read'], allowedIps: ['10.0.0.0/8'], maxUses: 1 });
    const ask = async (ip: string) => {
      const response = await (mcpRoute.POST as Handler)(new Request(`${BASE}/api/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}`, 'x-forwarded-for': ip }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) }));
      return { status: response.status, raw: await response.text() };
    };
    const outside = await ask('192.168.1.5');
    expect(outside.status).toBe(401);
    expect(outside.raw).toContain('can’t be used from this address');
    await ask('10.1.2.3');
    const used = await ask('10.1.2.3');
    expect(used.status).toBe(401);
    expect(used.raw).toContain('used all its uses');
  });

  it('does not touch last used for a used-up key', async () => {
    const { key, token } = keys.createApiKey(owner, { label: 'quiet', scopes: ['workflows:read'], maxUses: 1 });
    await call(workflowsRoute.GET, '/api/workflows', { key: token, ip: '10.4.4.4' });
    const first = keys.getApiKey(key.id)?.lastUsedAt;
    // Past the once-a-minute touch window, from another address: refused, and the record stays as it was.
    keys.verifyApiKey(token, { now: Date.now() + 120_000, ip: '10.5.5.5' });
    expect(keys.getApiKey(key.id)).toMatchObject({ lastUsedAt: first, lastUsedIp: '10.4.4.4' });
  });

  it('throws, not "used up", when Postgres cannot be reached', async () => {
    const fake = { kind: 'postgres', direct: () => undefined } as unknown as Parameters<typeof uses.consumeApiKeyUse>[1];
    await expect(uses.consumeApiKeyUse({ id: 'key_x', maxUses: 2 }, fake)).rejects.toThrow();
  });

  it('deletes the counts of a user’s keys with the user', async () => {
    const gone = await auth.createUser({ email: 'gone@example.com', name: 'Gone', role: 'member', password: 'gone-password-1' });
    const { key, token } = keys.createApiKey(gone, { label: 'g', scopes: ['workflows:read'], maxUses: 5 });
    await call(workflowsRoute.GET, '/api/workflows', { key: token });
    expect(usesOf(key.id)).toBe(1);
    auth.deleteUser(gone.id);
    expect(usesOf(key.id)).toBeUndefined();
  });

  it('checks the 50-entry limit after removing duplicates', async () => {
    const entries = Array.from({ length: 60 }, (_, i) => `10.0.0.${(i % 40) + 1}`);
    expect((await create({ allowedIps: entries })).status).toBe(201);
  });

  it('shows a used-up SCIM token and takes a list at creation', async () => {
    const { scimSecurityView } = await import('@/lib/server/scim/settings');
    const { token, key } = keys.createApiKey(owner, { label: 'scim2', scopes: ['scim'], maxUses: 1 });
    await call(usersRoute.GET, '/scim/v2/Users', { key: token });
    const view = await scimSecurityView();
    expect(view.tokens.find((t) => t.id === key.id)).toMatchObject({ uses: 1, usedUp: true });
    expect(view.tokens.find((t) => t.id === key.id)?.lastUsedIp).toBeUndefined();
  });
});
