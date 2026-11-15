/**
 * The budgets sync (lib/server/llm-gateway/sync.ts): projects become LiteLLM teams, people customers, dollar caps
 * backstop budgets; idempotent, never deleting. Talks only to the fake LiteLLM (test/fake-litellm.ts).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startFakeLiteLlm } from './fake-litellm';

vi.setConfig({ testTimeout: 20_000 });

const fake = await startFakeLiteLlm();
const dataDir = mkdtempSync(join(tmpdir(), 'landflow-ll-sync-'));
const previousEnv = { ...process.env };
Object.assign(process.env, {
  LANDFLOW_DATA_DIR: dataDir,
  LANDFLOW_REGISTRY_GRPC_PORT: 'off',
  LANDFLOW_SCAN_ON_START: 'false',
  LANDFLOW_PLUGINS: '',
  LANDFLOW_LLM_GATEWAY_URL: fake.origin,
  LANDFLOW_LLM_GATEWAY_ADMIN_KEY: fake.masterKey,
});

const { syncBudgets, budgetsSync } = await import('@/lib/server/llm-gateway/sync');
const { saveGatewaySettings, lastSyncReport } = await import('@/lib/server/llm-gateway/settings');
const { saveAiCaps } = await import('@/lib/server/ai-usage');
const { createUser, deleteUser } = await import('@/lib/server/auth/users');
const { createTeamProject, removeProjectRows } = await import('@/lib/server/projects/store');
const { agentStore } = await import('@/lib/server/agents/store');
const { credentials } = await import('@/lib/server/credentials/vault');
const { database } = await import('@/lib/server/db');
const { LITELLM_IDS } = await import('@/lib/shared/llm-gateway');
const capsRoute = await import('@/app/api/settings/ai-caps/route');
const settingsRoute = await import('@/app/api/settings/llm-gateway/route');
const { routePolicy } = await import('@/lib/server/auth/policy');
const { can } = await import('@/lib/shared/auth');

const writes = () => fake.requests.filter((r) => r.method !== 'GET').length;
const ana = await createUser({ email: 'ana@example.test', name: 'Ana Example', role: 'member', password: 'password-123' });
const ben = await createUser({ email: 'ben@example.test', name: 'Ben Example', role: 'member', password: 'password-123' });
const cy = await createUser({ email: 'cy@example.test', name: 'Cy Example', role: 'member', password: 'password-123' });
const alpha = createTeamProject({ name: 'Alpha' });
const beta = createTeamProject({ name: 'Beta' });

afterAll(async () => {
  budgetsSync.stop();
  await fake.close();
  for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key];
  Object.assign(process.env, previousEnv);
});

beforeAll(() => {
  // Ana has a cap of her own; Ben falls under allUsers; with allUsers empty Cy would have none.
  saveAiCaps({ credentials: {}, users: { [ana.id]: { dayCost: 2 } }, allUsers: { monthCost: 10 } });
});

describe('budgets sync', () => {
  it('creates teams and customers with budgets above the cap, and a second run writes nothing', async () => {
    const first = await syncBudgets({ trigger: 'manual' });
    expect(first.errors).toEqual([]);
    expect(first.teams.created).toBeGreaterThanOrEqual(2);
    expect(fake.teams.has(LITELLM_IDS.team(alpha.id))).toBe(true);
    expect(fake.teams.get(LITELLM_IDS.team(alpha.id))?.team_alias).toBe('Alpha');
    expect(fake.teams.has(LITELLM_IDS.team(beta.id))).toBe(true);
    // Ana: $2/day + 10%, rounded up to the cent; Ben and Cy: the $10/month cap for everyone.
    expect(fake.customers.get(LITELLM_IDS.customer(ana.id))).toMatchObject({ max_budget: 2.2, budget_duration: '1d' });
    expect(fake.customers.get(LITELLM_IDS.customer(ben.id))).toMatchObject({ max_budget: 11, budget_duration: '30d' });
    expect(first.customers.created).toBe(3);
    // No name or email goes to LiteLLM.
    expect(JSON.stringify([...fake.customers.values(), ...fake.teams.values()])).not.toMatch(/example\.test|Ana|Ben/);
    const before = writes();
    const second = await syncBudgets({ trigger: 'manual' });
    expect(writes()).toBe(before);
    expect(second.teams.created + second.teams.updated).toBe(0);
    expect(second.customers).toMatchObject({ created: 0, updated: 0, unchanged: 3 });
    expect(lastSyncReport()?.trigger).toBe('manual');
  });

  it('writes one link row per object with its state and budget', () => {
    const rows = database().all<{ kind: string; landflow_id: string; litellm_id: string; state: string; budget: string | null }>('SELECT * FROM llm_gateway_links');
    const customer = rows.find((r) => r.kind === 'customer' && r.landflow_id === ana.id);
    expect(customer).toMatchObject({ litellm_id: LITELLM_IDS.customer(ana.id), state: 'synced' });
    expect(JSON.parse(customer!.budget!)).toEqual({ maxBudget: 2.2, duration: '1d' });
    expect(rows.find((r) => r.kind === 'team' && r.landflow_id === alpha.id)).toMatchObject({ litellm_id: LITELLM_IDS.team(alpha.id), state: 'synced', budget: null });
  });

  it('updates a customer a gateway call already created, instead of creating it again', async () => {
    const dan = await createUser({ email: 'dan@example.test', name: 'Dan Example', role: 'member', password: 'password-123' });
    fake.customers.set(LITELLM_IDS.customer(dan.id), { user_id: LITELLM_IDS.customer(dan.id), spend: 0 } as never);
    const report = await syncBudgets({ trigger: 'manual' });
    expect(report.customers.created).toBe(0);
    expect(report.customers.updated).toBe(1);
    expect(fake.customers.get(LITELLM_IDS.customer(dan.id))).toMatchObject({ max_budget: 11 });
  });

  it('syncs one customer when capIds is given', async () => {
    saveAiCaps({ credentials: {}, users: { [ana.id]: { dayCost: 1 } }, allUsers: { monthCost: 10 } });
    const before = fake.requests.length;
    const report = await syncBudgets({ trigger: 'change', capIds: [`user:${ana.id}:day:cost`, 'workflow:wf_x:day:cost'] });
    expect(report.customers).toMatchObject({ updated: 1, unchanged: 0, created: 0 });
    expect(report.teams).toMatchObject({ created: 0, updated: 0, unchanged: 0 });
    expect(fake.customers.get(LITELLM_IDS.customer(ana.id))?.max_budget).toBe(1.1);
    expect(fake.requests.slice(before).every((r) => r.path.includes('customer'))).toBe(true);
  });

  it('follows a cap saved in Settings once, and only when the sync is on', async () => {
    budgetsSync.start();
    saveGatewaySettings({ sync: false });
    let before = fake.requests.length;
    await capsRoute.PUT(new Request('http://x/api/settings/ai-caps', { method: 'PUT', body: JSON.stringify({ credentials: {}, users: { [ana.id]: { dayCost: 5 } }, allUsers: { monthCost: 10 } }) }));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(fake.requests.length).toBe(before);
    saveGatewaySettings({ sync: true });
    before = fake.requests.length;
    await capsRoute.PUT(new Request('http://x/api/settings/ai-caps', { method: 'PUT', body: JSON.stringify({ credentials: {}, users: { [ana.id]: { dayCost: 4 } }, allUsers: { monthCost: 10 } }) }));
    await vi.waitFor(() => expect(fake.customers.get(LITELLM_IDS.customer(ana.id))?.max_budget).toBe(4.4));
    const updates = fake.requests.slice(before).filter((r) => r.path === '/customer/update');
    expect(updates).toHaveLength(1);
    expect(lastSyncReport()?.trigger).toBe('change');
    expect(lastSyncReport()?.customers.updated).toBe(1);
    budgetsSync.stop();
  });

  it('gives a runtime key its agent daily limit with no headroom, and its team', async () => {
    const agent = agentStore.create({ name: 'Desk', settings: { dailyCostLimit: 3 } } as never);
    const key = fake.addKey({ key_alias: LITELLM_IDS.runtimeKeyAlias('kagent', agent.id) });
    const now = new Date().toISOString();
    database().upsert('llm_gateway_keys', { id: 'lgk_test1', runtime: 'kagent', agent_id: agent.id, project_id: alpha.id, key_alias: key.key_alias!, key_hash: key.token, key_sealed: credentials.sealSecret(key.key), team_id: null, max_budget: null, budget_duration: null, blocked: 0, created_at: now, updated_at: now });
    const report = await syncBudgets({ trigger: 'manual' });
    expect(report.keys.updated).toBe(1);
    expect(fake.keys.get(key.key)).toMatchObject({ max_budget: 3, budget_duration: '1d', team_id: LITELLM_IDS.team(alpha.id) });
    expect(database().get<{ max_budget: number; team_id: string }>('SELECT max_budget, team_id FROM llm_gateway_keys WHERE id = ?', 'lgk_test1')).toMatchObject({ max_budget: 3, team_id: LITELLM_IDS.team(alpha.id) });
    expect((await syncBudgets({ trigger: 'manual' })).keys).toMatchObject({ updated: 0, unchanged: 1 });

    // The agent goes: its key is listed, never blocked or changed.
    agentStore.delete(agent.id);
    const later = await syncBudgets({ trigger: 'manual' });
    expect(later.orphans).toContainEqual(expect.objectContaining({ kind: 'key', litellmId: key.key_alias }));
    expect(fake.keys.get(key.key)?.blocked).toBeFalsy();
  });

  it('lists a deleted user and a deleted project as orphans and deletes nothing', async () => {
    deleteUser(cy.id);
    removeProjectRows(beta.id);
    const report = await syncBudgets({ trigger: 'manual' });
    expect(report.orphans).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'customer', litellmId: LITELLM_IDS.customer(cy.id) }), expect.objectContaining({ kind: 'team', litellmId: LITELLM_IDS.team(beta.id) })]));
    expect(report.orphans.every((o) => o.note.includes("LiteLLM's UI"))).toBe(true);
    expect(fake.customers.has(LITELLM_IDS.customer(cy.id))).toBe(true);
    expect(fake.teams.has(LITELLM_IDS.team(beta.id))).toBe(true);
    expect(fake.requests.some((r) => /delete|block/.test(r.path))).toBe(false);
  });

  it('marks a failing call as failed with its error', async () => {
    saveAiCaps({ credentials: {}, users: { [ana.id]: { dayCost: 9 } }, allUsers: { monthCost: 10 } });
    fake.setDown(true);
    const report = await syncBudgets({ trigger: 'manual' });
    fake.setDown(false);
    expect(report.customers.failed).toBeGreaterThan(0);
    expect(report.errors.length).toBeGreaterThan(0);
    const row = database().get<{ state: string; error: string }>('SELECT state, error FROM llm_gateway_links WHERE kind = ? AND landflow_id = ?', 'customer', ana.id);
    expect(row?.state).toBe('failed');
    expect(row?.error).toBeTruthy();
  });

  it('says what is missing when the server has no admin key, and calls nothing', async () => {
    const key = process.env.LANDFLOW_LLM_GATEWAY_ADMIN_KEY;
    delete process.env.LANDFLOW_LLM_GATEWAY_ADMIN_KEY;
    const before = fake.requests.length;
    const report = await syncBudgets({ trigger: 'manual' });
    process.env.LANDFLOW_LLM_GATEWAY_ADMIN_KEY = key;
    expect(report.errors[0]).toMatch(/LANDFLOW_LLM_GATEWAY_ADMIN_KEY/);
    expect(fake.requests.length).toBe(before);
  });
});

describe('settings route and access', () => {
  it('never contains a key, and PUT validates URLs', async () => {
    const view = await settingsRoute.GET(new Request('http://x/api/settings/llm-gateway'));
    const text = await view.text();
    expect(text).not.toContain(fake.masterKey);
    expect(JSON.parse(text).environment).toMatchObject({ url: fake.origin, hasAdminKey: true });
    const bad = await settingsRoute.PUT(new Request('http://x/api/settings/llm-gateway', { method: 'PUT', body: JSON.stringify({ clusterUrl: 'not a url' }) }));
    expect(bad.status).toBe(400);
    const ok = await settingsRoute.PUT(new Request('http://x/api/settings/llm-gateway', { method: 'PUT', body: JSON.stringify({ headroomPercent: 20, uiUrl: 'http://127.0.0.1:54100/ui' }) }));
    expect(ok.status).toBe(200);
    expect((await ok.json()).settings).toMatchObject({ headroomPercent: 20, uiUrl: 'http://127.0.0.1:54100/ui' });
  });

  it('refuses a member to sync, and lets members read the settings', () => {
    const post = routePolicy('POST', '/api/llm-gateway/sync');
    expect(post).toMatchObject({ scope: 'admin', action: 'settings:manage' });
    expect(can({ role: 'member' }, 'settings:manage')).toBe(false);
    expect(routePolicy('GET', '/api/settings/llm-gateway').scope).toBe('workflows:read');
  });
});
