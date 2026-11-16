/**
 * SP14 (docs/llm-gateway.md "Who sees what", rule 5; docs/work-and-briefings.md "Over MCP"): the `my_ai_spend` MCP tool
 * and GET /api/brain/my-spend answer the caller's own rows and caps only, an admin included; a `brain:read` key reaches
 * them and an `executions:read` one does not; the route equals GET /api/insights/ai/me.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import type { ApiKeyScope } from '@/lib/shared/auth';

vi.setConfig({ testTimeout: 20_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-my-ai-spend-mcp-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_AUDIT_OUTBOX: 'off', LANDFLOW_BRAIN_MODEL: 'off', LANDFLOW_BRAIN_EMBEDDINGS: 'off' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { createUser } = await import('@/lib/server/auth/users');
const { enableTestAuth, disableTestAuth } = await import('@/lib/server/auth/test-bypass');
const { createApiKey } = await import('@/lib/server/auth/api-keys');
const { instanceServer } = await import('@/lib/server/mcp/instance-tools');
const { database } = await import('@/lib/server/db');
const { aiUsageMeter, saveAiCaps } = await import('@/lib/server/ai-usage');
const myRoute = await import('@/app/api/brain/my-spend/route');
const insightsRoute = await import('@/app/api/insights/ai/me/route');

type User = Awaited<ReturnType<typeof createUser>>;
let alma: User;
let ada: User;
let counter = 0;

function row(fields: Record<string, unknown>) {
  const now = new Date();
  database().insertNew('ai_usage', {
    id: `sp14-${++counter}`,
    call_id: `sp14-call-${counter}`,
    at: now.toISOString(),
    day: aiUsageMeter().today(now.getTime()),
    provider: 'anthropic',
    model: 'claude-sonnet-5-5',
    operation: 'chat',
    input_tokens: 100,
    output_tokens: 50,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    cost: 0,
    ...fields,
  });
}

const actorOf = (user: User) => ({ id: user.id, role: user.role });
async function connect(user: User | undefined, keyScopes?: ApiKeyScope[]) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await instanceServer(user && actorOf(user), undefined, keyScopes).connect(serverSide);
  const client = new Client({ name: 'sp14-test', version: '1.0.0' });
  await client.connect(clientSide);
  return client;
}
const textOf = (result: unknown) => ((result as { content: Array<{ text: string }> }).content[0]?.text ?? '');
const call = async (client: Client, args: Record<string, unknown> = {}) => (await client.callTool({ name: 'my_ai_spend', arguments: args })) as { isError?: boolean; content: Array<{ text: string }> };

beforeAll(async () => {
  alma = await createUser({ email: 'alma@sp14.test', name: 'Alma', role: 'member', password: 'alma-password-1' });
  ada = await createUser({ email: 'ada@sp14.test', name: 'Ada', role: 'admin', password: 'ada-password-1' });
  row({ user_id: alma.id, cost: 1.5, execution_id: 'ex_a', purpose: 'answer' });
  row({ user_id: alma.id, cost: 0, provider: 'ollama', model: 'qwen3-coder:30b', execution_id: 'ex_a' });
  row({ user_id: ada.id, cost: 33, model: 'claude-opus-secret-model', execution_id: 'ex_ada' });
  saveAiCaps({ credentials: {}, users: { [alma.id]: { name: 'Alma', monthCost: 20 }, [ada.id]: { name: 'Ada', monthCost: 9999 } } });
  aiUsageMeter().invalidateCaps();
});

afterAll(() => {
  enableTestAuth();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

describe('the my_ai_spend tool', () => {
  it('is listed for a brain:read key and not for an executions:read-only one', async () => {
    const names = async (scopes: ApiKeyScope[]) => (await (await connect(alma, scopes)).listTools()).tools.map((t) => t.name);
    expect(await names(['brain:read'])).toContain('my_ai_spend');
    expect(await names(['brain:write'])).toContain('my_ai_spend');
    expect(await names(['executions:read'])).not.toContain('my_ai_spend');
    const denied = await (await connect(alma, ['executions:read'])).callTool({ name: 'my_ai_spend', arguments: {} }).then((r) => Boolean((r as { isError?: boolean }).isError), () => true);
    expect(denied).toBe(true);
  });

  it('answers the caller’s own rows and caps as text and JSON', async () => {
    const result = await call(await connect(alma, ['brain:read']));
    expect(result.isError).toBeFalsy();
    const { text, spend } = JSON.parse(textOf(result));
    expect(spend.today).toMatchObject({ cost: 1.5, calls: 2, runs: 1 });
    expect(spend.caps.map((c: { max: number }) => c.max)).toEqual([20]);
    expect(text).toContain('Today: $1.50');
    expect(text).toContain('This month');
    expect(text).toContain('By model:');
    expect(text).toContain('By purpose:');
    expect(text).toContain('monthly');
    expect(text).toContain('forecast');
    expect(text).not.toContain('claude-opus-secret-model');
  });

  it('never answers a colleague’s rows or caps, an admin included', async () => {
    const mine = JSON.parse(textOf(await call(await connect(ada, ['brain:read']), { period: '30d' })));
    expect(mine.spend.today.cost).toBe(33);
    expect(JSON.stringify(mine)).not.toContain('1.5');
    expect(mine.spend.caps.map((c: { max: number }) => c.max)).toEqual([9999]);
    const hers = JSON.parse(textOf(await call(await connect(alma, ['brain:read']), { period: '30d' })));
    expect(JSON.stringify(hers)).not.toContain('claude-opus-secret-model');
    expect(JSON.stringify(hers)).not.toContain('9999');
  });

  it('ignores a user argument: the caller is the key’s person, never a name in the call', async () => {
    const result = await call(await connect(alma, ['brain:read']), { userId: ada.id, user_id: ada.id, period: '30d' });
    expect(result.isError).toBeFalsy();
    const { spend } = JSON.parse(textOf(result));
    expect(spend.today.cost).toBe(1.5);
    expect(JSON.stringify(spend)).not.toContain('9999');
  });

  it('says how many by-model rows it left out of the text, while the JSON holds them all', async () => {
    const many = await createUser({ email: 'many@sp14.test', name: 'Many', role: 'member', password: 'many-password-1' });
    for (let i = 0; i < 12; i++) row({ user_id: many.id, cost: 0.1, model: `claude-many-${i}`, execution_id: `ex_many_${i}` });
    const { text, spend } = JSON.parse(textOf(await call(await connect(many, ['brain:read']))));
    expect(spend.byModel).toHaveLength(12);
    expect(text).toContain('and 2 more');
    expect(text.match(/claude-many-/g)).toHaveLength(10);
  });

  it('takes the wire’s periods and refuses another', async () => {
    const client = await connect(alma, ['brain:read']);
    for (const period of ['24h', '7d', '30d', '90d']) expect(JSON.parse(textOf(await call(client, { period }))).spend.period).toBe(period);
    expect(await call(client, { period: '1y' }).then((r) => Boolean(r.isError), () => true)).toBe(true);
  });

  it('refuses the instance access token (no person)', async () => {
    const result = await call(await connect(undefined));
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('not the instance access token');
  });
});

describe('GET /api/brain/my-spend', () => {
  const request = (path: string, headers: Record<string, string> = {}) => new Request(`http://sp14.test${path}`, { headers });

  it('answers 401 without a key and 401 for a bearer that is no key (the instance access token is no REST credential)', async () => {
    disableTestAuth();
    try {
      const { guardRequest } = await import('@/lib/server/auth/guard');
      const anonymous = guardRequest(request('/api/brain/my-spend'));
      expect(anonymous.ok).toBe(false);
      if (!anonymous.ok) expect(anonymous.response.status).toBe(401);
      const token = guardRequest(request('/api/brain/my-spend', { authorization: 'Bearer instance-access-token' }));
      expect(token.ok).toBe(false);
      if (!token.ok) expect(token.response.status).toBe(401);
    } finally {
      enableTestAuth();
    }
  });

  it('is open to a brain key and closed to an executions:read-only one, and /api/insights/ai/me stays executions:read', async () => {
    const { guardRequest } = await import('@/lib/server/auth/guard');
    disableTestAuth();
    try {
      const status = (path: string, scopes: ApiKeyScope[]) => {
        const key = createApiKey(alma, { label: scopes.join(), scopes });
        const guarded = guardRequest(request(path, { authorization: `Bearer ${(key as { token: string }).token}` }));
        return guarded.ok ? 200 : guarded.response.status;
      };
      expect(status('/api/brain/my-spend', ['brain:read'])).toBe(200);
      expect(status('/api/brain/my-spend', ['brain:write'])).toBe(200);
      expect(status('/api/brain/my-spend', ['executions:read'])).toBe(403);
      expect(status('/api/insights/ai/me', ['brain:read'])).toBe(403);
      expect(status('/api/insights/ai/me', ['executions:read'])).toBe(200);
    } finally {
      enableTestAuth();
    }
  });

  it('equals GET /api/insights/ai/me for the same person and period, and refuses a bad period', async () => {
    enableTestAuth(alma);
    vi.useFakeTimers({ toFake: ['Date'], now: new Date() });
    try {
      for (const period of ['24h', '7d', '90d']) {
        const mine = await (myRoute.GET as (r: Request) => Promise<Response>)(request(`/api/brain/my-spend?period=${period}`));
        const same = await (insightsRoute.GET as (r: Request) => Promise<Response>)(request(`/api/insights/ai/me?period=${period}`));
        expect(mine.status).toBe(200);
        expect(await mine.json()).toEqual(await same.json());
      }
      const dflt = await (await (myRoute.GET as (r: Request) => Promise<Response>)(request('/api/brain/my-spend'))).json();
      expect(dflt.period).toBe('7d');
      expect((await (myRoute.GET as (r: Request) => Promise<Response>)(request('/api/brain/my-spend?period=1y'))).status).toBe(400);
    } finally {
      vi.useRealTimers();
      enableTestAuth();
    }
  });
});
