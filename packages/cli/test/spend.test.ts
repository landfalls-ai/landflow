/**
 * `landflow spend` against a real host (test/host.ts): a brain:read key, the table and --json, a bad period, a key
 * without the scope. Made-up data only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cliFor, startHost, web, type Host } from './host';

let host: Host;
let cli: ReturnType<typeof cliFor>;
let brainKey: string;
let buildKey: string;

beforeAll(async () => {
  host = await startHost();
  cli = cliFor(host);
  const { createOwner } = await web('lib/server/auth/users');
  const { createApiKey } = await web('lib/server/auth/api-keys');
  const { database } = await web('lib/server/db');
  const { aiUsageMeter, saveAiCaps } = await web('lib/server/ai-usage');
  const owner = await createOwner({ email: 'spend-owner@landflow.test', name: 'Spend Owner', password: 'correct horse battery staple' });
  const other = await web('lib/server/auth/users').then((m) => m.createUser({ email: 'spend-other@landflow.test', name: 'Other', role: 'member', password: 'other-password-1' }));
  const now = new Date();
  const row = (n: number, fields: Record<string, unknown>) =>
    database().insertNew('ai_usage', { id: `cli-sp-${n}`, call_id: `cli-sp-call-${n}`, at: now.toISOString(), day: aiUsageMeter().today(now.getTime()), provider: 'anthropic', model: 'claude-sonnet-5-5', operation: 'chat', input_tokens: 1200, output_tokens: 300, cache_read_tokens: 0, cache_write_tokens: 0, cost: 0, ...fields });
  row(1, { user_id: owner.id, cost: 2.5, execution_id: 'ex_1' });
  row(2, { user_id: owner.id, cost: 0, provider: 'ollama', model: 'qwen3-coder:30b', execution_id: 'ex_1' });
  row(3, { user_id: other.id, cost: 77, model: 'someone-elses-model', execution_id: 'ex_2' });
  saveAiCaps({ credentials: {}, users: { [owner.id]: { name: 'Owner', monthCost: 30 } } });
  aiUsageMeter().invalidateCaps();
  brainKey = (createApiKey(owner, { label: 'cli brain', scopes: ['brain:read'] }) as { token: string }).token;
  buildKey = (createApiKey(owner, { label: 'cli build', scopes: ['executions:read'] }) as { token: string }).token;
  (await web('lib/server/auth/test-bypass')).disableTestAuth();
});

afterAll(async () => {
  (await web('lib/server/auth/test-bypass')).enableTestAuth();
  await host.close();
});

describe('landflow spend', () => {
  it('prints today, this month, the by-model table and the caps', async () => {
    const out = await cli(['spend'], { env: { LANDFLOW_API_KEY: brainKey } });
    expect(out.code).toBe(0);
    expect(out.stdout).toContain('Today:');
    expect(out.stdout).toContain('$2.50');
    expect(out.stdout).toContain('This month:');
    expect(out.stdout).toMatch(/MODEL\s+CALLS/);
    expect(out.stdout).toContain('qwen3-coder:30b');
    expect(out.stdout).toContain('not priced');
    expect(out.stdout).toContain('Your caps:');
    expect(out.stdout).toContain('monthly');
    expect(out.stdout).toContain('forecast');
    expect(out.stdout).not.toContain('someone-elses-model');
  });

  it('--json prints the answer as one document', async () => {
    const out = await cli(['spend', '--period', '30d', '--json'], { env: { LANDFLOW_API_KEY: brainKey } });
    expect(out.code).toBe(0);
    expect(out.json).toMatchObject({ ok: true, period: '30d', today: { cost: 2.5, calls: 2 } });
    expect(out.json.byModel.length).toBe(2);
    expect(out.json.caps).toHaveLength(1);
    expect(JSON.stringify(out.json)).not.toContain('someone-elses-model');
  });

  it('refuses a period it does not take (exit 2)', async () => {
    const out = await cli(['spend', '--period', '1y', '--json'], { env: { LANDFLOW_API_KEY: brainKey } });
    expect(out.code).toBe(2);
    expect(out.json.error.message).toContain('--period is 24h, 7d, 30d, 90d');
  });

  it('a key without brain:read is refused (exit 4)', async () => {
    const out = await cli(['spend', '--json'], { env: { LANDFLOW_API_KEY: buildKey } });
    expect(out.code).toBe(4);
    expect(out.json.error).toMatchObject({ status: 403 });
  });
});
