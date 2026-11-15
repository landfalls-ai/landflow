/**
 * The AI page (docs/llm-gateway.md): the report's groups, totals, visibility ("Teammates"), caps and requests, the
 * gateway status against the fake LiteLLM, the pure helpers and the caps card's markup.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Workflow } from '@landflow/engine';
import { startFakeLiteLlm, type FakeLiteLlm } from './fake-litellm';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-ai-console-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_AUDIT_OUTBOX: 'off' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { store } = await import('@/lib/server/store');
const { createUser } = await import('@/lib/server/auth/users');
const { enableTestAuth } = await import('@/lib/server/auth/test-bypass');
const projects = await import('@/lib/server/projects');
const { database } = await import('@/lib/server/db');
const { aiUsageMeter, saveAiCaps } = await import('@/lib/server/ai-usage');
const { aiConsoleReport, sourceKey } = await import('@/lib/server/llm-gateway/console');
const { gatewayStatus, resetGatewayStatus } = await import('@/lib/server/llm-gateway/status');
const helpersStatus = await import('@/lib/server/llm-gateway/status');
const { saveGatewaySettings } = await import('@/lib/server/llm-gateway/settings');
const reportRoute = await import('@/app/api/insights/ai/route');
const statusRoute = await import('@/app/api/llm-gateway/status/route');
const helpers = await import('@/lib/client/ai-console');
const { CapsCard } = await import('@/components/insights/ai-console-caps');

type User = Awaited<ReturnType<typeof createUser>>;
let owner: User;
let member: User;
let other: User;
let wfMine = '';
let wfTheirs = '';
let fake: FakeLiteLlm;
let virtualKey = '';

const as = async <T>(user: User | undefined, fn: () => Promise<T>): Promise<T> => {
  enableTestAuth(user);
  try {
    return await fn();
  } finally {
    enableTestAuth();
  }
};

let counter = 0;
function row(fields: Record<string, unknown>) {
  const now = new Date();
  const inputTokens = Number(fields.input_tokens ?? 100);
  database().insertNew('ai_usage', {
    id: `au_test_${counter++}`,
    at: now.toISOString(),
    day: aiUsageMeter().today(now.getTime()),
    provider: 'anthropic',
    model: 'claude-sonnet-5-5',
    operation: 'chat',
    output_tokens: 50,
    cost: 1,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    ...fields,
    input_tokens: inputTokens,
  });
}

function workflow(id: string, project: string, extra: Partial<Workflow> = {}) {
  store.saveWorkflow({ id, name: id, nodes: [], connections: [], ...extra } as unknown as Workflow);
  projects.setHomeProject('workflow', id, project);
  return id;
}

beforeAll(async () => {
  owner = await createUser({ email: 'olga@console.test', name: 'Olga', role: 'owner', password: 'olga-password-1' });
  member = await createUser({ email: 'mia@console.test', name: 'Mia', role: 'member', password: 'mia-password-1' });
  other = await createUser({ email: 'omar@console.test', name: 'Omar', role: 'member', password: 'omar-password-1' });
  const mine = projects.createTeamProject({ name: 'Alpha' }).id;
  const theirs = projects.createTeamProject({ name: 'Beta' }).id;
  projects.setMember(mine, member.id, 'editor');
  projects.setMember(mine, other.id, 'editor');
  wfMine = workflow('wf_console_mine', mine, { settings: { aiMaxCostPerDay: 10 } });
  wfTheirs = workflow('wf_console_theirs', theirs, { settings: { aiMaxCostPerDay: 10 } });

  row({ workflow_id: wfMine, user_id: member.id, project_id: mine, cost: 1 });
  row({ workflow_id: wfMine, user_id: other.id, project_id: mine, cost: 2, model: 'qwen3-coder:30b', provider: 'litellm' });
  row({ workflow_id: wfTheirs, user_id: other.id, project_id: theirs, cost: 4 });
  // No project on the row: the workflow's home project is the fallback.
  row({ workflow_id: wfMine, user_id: owner.id, cost: 0.5 });
  // Imported from the gateway's spend log.
  row({ source: 'litellm', runtime: 'claude', user_id: null, project_id: theirs, cost: 8, call_id: 'call-1' });
  // The member's own call outside any workflow.
  row({ user_id: member.id, cost: 0.25 });

  fake = await startFakeLiteLlm();
});

afterAll(async () => {
  enableTestAuth();
  await fake.close();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const byKey = (rows: Array<{ key: string; label: string }>) => Object.fromEntries(rows.map((r) => [r.key, r]));

describe("the owner's report", () => {
  it('adds up the seeded rows and groups them', () => {
    const report = aiConsoleReport(owner, '7d');
    expect(report.totals.cost).toBeCloseTo(15.75);
    expect(report.totals.calls).toBe(6);
    expect(report.totals.inputTokens).toBe(600);
    expect(report.viewer.admin).toBe(true);
    const projectLabels = report.groups.project.map((r) => r.label);
    expect(projectLabels).toContain('Alpha');
    expect(projectLabels).toContain('Beta');
    const alpha = report.groups.project.find((r) => r.label === 'Alpha')!;
    // 1 + 2 from project_id, plus 0.5 through the home project fallback.
    expect(alpha.cost).toBeCloseTo(3.5);
    expect(report.groups.project.reduce((sum, r) => sum + r.share, 0)).toBeCloseTo(1);
    expect(report.groups.person.find((r) => r.label === 'Mia')?.cost).toBeCloseTo(1.25);
    expect(report.groups.person.find((r) => r.label === 'Omar')?.cost).toBeCloseTo(6);
    expect(report.groups.model.map((r) => r.label)).toContain('qwen3-coder:30b');
    expect(report.groups.agent.map((r) => r.label)).toEqual(['No agent']);
  });

  it('shows imported rows under their runtime and the rest as Landflow', () => {
    const sources = byKey(aiConsoleReport(owner, '7d').groups.source);
    expect(sources['litellm:claude']?.label).toBe('Claude Code on kagent');
    expect(sources['litellm:claude']?.cost).toBeCloseTo(8);
    expect(sources['landflow:landflow']?.label).toBe('Landflow');
    expect(sources['landflow:landflow']?.cost).toBeCloseTo(7.75);
  });

  it('sorts by cost and counts a 24 hour period', () => {
    const report = aiConsoleReport(owner, '24h');
    const costs = report.groups.project.map((r) => r.cost);
    expect(costs).toEqual([...costs].sort((a, b) => b - a));
    expect(report.totals.calls).toBe(6);
    expect(aiConsoleReport(owner, '30d').totals.calls).toBe(6);
  });

  it('is empty for a time with no calls', () => {
    const report = aiConsoleReport(owner, '24h', Date.now() - 10 * 86_400_000);
    expect(report.totals.calls).toBe(0);
    expect(report.groups.project).toEqual([]);
  });
});

describe("a member's report", () => {
  it('holds only their workflow and their own rows, and other people only as Teammates', () => {
    const report = aiConsoleReport(member, '7d');
    // wfMine: 1 + 2 + 0.5; their own call: 0.25. Beta's 4 and the import's 8 are in no total.
    expect(report.totals.cost).toBeCloseTo(3.75);
    expect(report.totals.calls).toBe(4);
    expect(report.viewer.admin).toBe(false);
    const people = report.groups.person.map((r) => r.label).sort();
    expect(people).toEqual(['Mia', 'Teammates']);
    const json = JSON.stringify(report);
    expect(json).not.toContain('Omar');
    expect(json).not.toContain('Olga');
    expect(json).not.toContain(other.id);
    expect(json).not.toContain(owner.id);
    expect(report.groups.project.map((r) => r.label)).not.toContain('Beta');
    expect(report.groups.source.map((r) => r.key)).toEqual(['landflow:landflow']);
  });

  it("does not show another project's rows to a member of neither", () => {
    const stranger = { id: 'u_stranger', role: 'member' as const };
    const report = aiConsoleReport(stranger, '7d');
    expect(report.totals.calls).toBe(0);
  });
});

describe('caps', () => {
  beforeAll(() => {
    saveAiCaps({ credentials: { cred_x: { name: 'Shared key', dayCost: 5 } }, users: { [member.id]: { name: 'Mia', dayCost: 2 }, [other.id]: { name: 'Omar', dayCost: 100 } } });
    aiUsageMeter().invalidateCaps();
  });

  it("gives a member their own cap and their workflow's, not the other workflow's or a credential's", () => {
    const caps = aiConsoleReport(member, '7d').caps;
    const ids = caps.map((c) => c.id);
    expect(ids).toContain(`user:${member.id}:day:cost`);
    expect(ids).toContain(`workflow:${wfMine}:day:cost`);
    expect(ids).not.toContain(`workflow:${wfTheirs}:day:cost`);
    expect(ids).not.toContain(`user:${other.id}:day:cost`);
    expect(ids.some((id) => id.startsWith('credential:'))).toBe(false);
    const own = caps.find((c) => c.id === `user:${member.id}:day:cost`)!;
    expect(own.canRequest).toBe(true);
    expect(own.ratio).toBeCloseTo(1.25 / 2);
    expect(own.used).toBeCloseTo(1.25);
    expect(caps.map((c) => c.ratio)).toEqual(caps.map((c) => c.ratio).sort((a, b) => b - a));
  });

  it('gives the owner every cap, none of them requestable, and a backstop only with sync on', () => {
    let caps = aiConsoleReport(owner, '7d').caps;
    expect(caps.map((c) => c.id)).toContain('credential:cred_x:day:cost');
    expect(caps.every((c) => !c.canRequest)).toBe(true);
    expect(caps.every((c) => !c.backstop)).toBe(true);
    saveGatewaySettings({ sync: true, headroomPercent: 10 });
    caps = aiConsoleReport(owner, '7d').caps;
    expect(caps.find((c) => c.id === `user:${member.id}:day:cost`)?.backstop).toMatchObject({ duration: '1d', maxBudget: expect.closeTo(2.2, 1) });
    expect(aiConsoleReport(member, '7d').caps.every((c) => !c.backstop)).toBe(true);
    saveGatewaySettings({ sync: false });
  });

  it("marks a cap with the member's open request and lists the requests", () => {
    const now = new Date().toISOString();
    const request = { cap_id: `user:${member.id}:day:cost`, subject: 'user “Mia”', metric: 'cost', period: 'day', current_max: 2, requested_max: 5, reason: 'A big batch', status: 'pending', created_at: now, updated_at: now };
    database().insertNew('ai_cap_requests', { id: 'acr_mine', requested_by: member.id, ...request });
    database().insertNew('ai_cap_requests', { id: 'acr_other', requested_by: other.id, ...request, cap_id: `user:${other.id}:day:cost` });
    const mine = aiConsoleReport(member, '7d');
    expect(mine.caps.find((c) => c.id === `user:${member.id}:day:cost`)?.pendingRequestId).toBe('acr_mine');
    expect(mine.requests.map((r) => r.id)).toEqual(['acr_mine']);
    expect(JSON.stringify(mine)).not.toContain('Omar');
    const all = aiConsoleReport(owner, '7d');
    expect(all.requests.map((r) => r.id).sort()).toEqual(['acr_mine', 'acr_other']);
    expect(all.requests.find((r) => r.id === 'acr_other')?.requestedByName).toBe('Omar');
  });
});

describe('capRaise', () => {
  it('is active when the saved flow is published and switched on', () => {
    expect(aiConsoleReport(owner, '7d').capRaise).toEqual({ active: false });
    workflow('wf_cap_raise', projects.createTeamProject({ name: 'Flows' }).id, { active: true });
    database().upsert('settings', { key: 'ai_cap_raise', value: JSON.stringify({ workflowId: 'wf_cap_raise' }) });
    expect(aiConsoleReport(owner, '7d').capRaise).toEqual({ workflowId: 'wf_cap_raise', active: true });
    store.saveWorkflow({ ...(store.getWorkflow('wf_cap_raise') as Workflow), active: false });
    expect(aiConsoleReport(owner, '7d').capRaise).toEqual({ workflowId: 'wf_cap_raise', active: false });
    database().upsert('settings', { key: 'ai_cap_raise', value: JSON.stringify({ workflowId: 'wf_gone' }) });
    expect(aiConsoleReport(owner, '7d').capRaise.active).toBe(false);
  });
});

describe('the gateway status', () => {
  it('is not configured without a gateway', async () => {
    resetGatewayStatus();
    delete process.env.LANDFLOW_LLM_GATEWAY_URL;
    expect(await gatewayStatus(owner)).toMatchObject({ configured: false, health: 'unknown', models: [] });
  });

  it('is ok with the fake up, with its models, and shows admin detail to the owner only', async () => {
    resetGatewayStatus();
    process.env.LANDFLOW_LLM_GATEWAY_URL = fake.origin;
    virtualKey = fake.addKey().key;
    process.env.LANDFLOW_LLM_GATEWAY_KEY = virtualKey;
    process.env.LANDFLOW_LLM_GATEWAY_ADMIN_KEY = fake.masterKey;
    const asOwner = await gatewayStatus(owner);
    expect(asOwner).toMatchObject({ configured: true, source: 'environment', health: 'ok' });
    expect(asOwner.models.map((m) => m.id)).toEqual(['qwen3-coder:30b', 'qwen3.8']);
    expect(asOwner.admin?.baseUrl).toBe(fake.origin);
    expect(asOwner.admin?.uiUrl).toBe(`${fake.origin}/ui`);
    const asMember = await gatewayStatus(member);
    expect(asMember.health).toBe('ok');
    expect(asMember.admin).toBeUndefined();
    for (const json of [JSON.stringify(asOwner), JSON.stringify(asMember)]) {
      expect(json).not.toContain(virtualKey);
      expect(json).not.toContain(fake.masterKey);
    }
  });

  it('is down, with the error, when the gateway fails', async () => {
    resetGatewayStatus();
    fake.setDown(true);
    const status = await gatewayStatus(owner);
    expect(status.health).toBe('down');
    expect(status.error).toBeTruthy();
    const asMember = await gatewayStatus(member);
    expect(asMember.error).toBe('The gateway is not answering');
    expect(asMember.error).not.toBe(status.error);
    fake.setDown(false);
    resetGatewayStatus();
    expect((await gatewayStatus(owner)).health).toBe('ok');
  });

  it('answers through the routes, for a member without the admin part', async () => {
    resetGatewayStatus();
    const status = await as(member, async () => (await (statusRoute.GET as (r: Request) => Promise<Response>)(new Request('http://x.test/api/llm-gateway/status'))).json());
    expect(status.configured).toBe(true);
    expect(status.admin).toBeUndefined();
    const response = await as(member, () => (reportRoute.GET as (r: Request) => Promise<Response>)(new Request('http://x.test/api/insights/ai?period=24h')));
    expect(response.status).toBe(200);
    expect((await response.json()).period).toBe('24h');
    const bad = await as(member, () => (reportRoute.GET as (r: Request) => Promise<Response>)(new Request('http://x.test/api/insights/ai?period=year')));
    expect(bad.status).toBe(400);
  });
});

describe('the admin UI link', () => {
  const base = { baseUrl: 'http://evil.example', uiUrl: 'http://evil.example/ui' };
  it('never comes from a credential URL', () => {
    expect(helpersStatus.adminUiUrl({ ...base, source: 'credential' }, undefined, '')).toBeUndefined();
    expect(helpersStatus.adminUiUrl({ ...base, source: 'credential' }, 'http://ui.test', undefined)).toBe('http://ui.test');
    expect(helpersStatus.adminUiUrl({ ...base, source: 'credential' }, undefined, 'http://env.test')).toBe('http://env.test');
    expect(helpersStatus.adminUiUrl({ ...base, source: 'credential', adminBaseUrl: 'http://real.test' }, undefined, '')).toBe('http://real.test/ui');
    expect(helpersStatus.adminUiUrl({ ...base, source: 'environment' }, undefined, '')).toBe('http://evil.example/ui');
  });
});

describe('client helpers', () => {
  it('colours a cap amber at 80% and red at 100%', () => {
    expect(helpers.capTone(0.79)).toBe('ok');
    expect(helpers.capTone(0.8)).toBe('near');
    expect(helpers.capTone(0.999)).toBe('near');
    expect(helpers.capTone(1)).toBe('full');
    expect(helpers.capTone(1.4)).toBe('full');
    expect(helpers.capTone(0)).toBe('ok');
  });

  it('formats numbers and the row model', () => {
    expect(helpers.formatCapAmount({ metric: 'cost' }, 1.5)).toBe('$1.50');
    expect(helpers.formatCapAmount({ metric: 'tokens' }, 12_345)).toBe('12.3k tokens');
    expect(helpers.formatPercent(0.004)).toBe('<1%');
    expect(helpers.formatPercent(0.376)).toBe('38%');
    expect(helpers.barPercent(0.004)).toBe(1);
    expect(helpers.barPercent(2)).toBe(100);
    const model = helpers.rowModel({ key: 'k', label: 'Alpha', inputTokens: 1000, outputTokens: 500, cost: 1.234, calls: 1, share: 0.5, href: '/x' });
    expect(model).toMatchObject({ label: 'Alpha', cost: '$1.23', tokens: '1,500 tokens', calls: '1 call', share: '50%', bar: 50, href: '/x' });
    expect(helpers.sortRows([{ key: 'a', label: 'a', inputTokens: 1, outputTokens: 0, cost: 1, calls: 1, share: 0 }, { key: 'b', label: 'b', inputTokens: 1, outputTokens: 0, cost: 2, calls: 1, share: 0 }]).map((r) => r.key)).toEqual(['b', 'a']);
  });

  it('checks a requested maximum', () => {
    expect(helpers.checkRaise('', 5).error).toBeTruthy();
    expect(helpers.checkRaise('5', 5).error).toBeTruthy();
    expect(helpers.checkRaise('7.5', 5)).toEqual({ value: 7.5 });
  });
});

describe('the caps card markup', () => {
  const cap = { id: 'user:u1:day:cost', subject: 'user “Mia”', period: 'day' as const, metric: 'cost' as const, max: 2, used: 1.8, ratio: 0.9, setIn: 'Settings → AI caps', link: 'http://x.test/settings#ai-caps', canRequest: true };
  const report = (admin: boolean, over: Partial<typeof cap> = {}) => ({
    period: '7d' as const,
    from: '',
    to: '',
    totals: { inputTokens: 0, outputTokens: 0, cost: 0, calls: 0 },
    groups: { project: [], agent: [], person: [], model: [], source: [] },
    caps: [{ ...cap, canRequest: !admin, ...over }],
    requests: [],
    viewer: { admin, userId: 'u1' },
    capRaise: { active: true },
  });

  it('offers Ask for more to a member and not to an admin', () => {
    const member = renderToStaticMarkup(createElement(CapsCard, { report: report(false), onChanged: () => {} }));
    expect(member).toContain('Ask for more');
    expect(member).toContain('bg-warn');
    const admin = renderToStaticMarkup(createElement(CapsCard, { report: report(true), onChanged: () => {} }));
    expect(admin).not.toContain('Ask for more');
  });

  it('says Asked when a request is open, and explains the off state', () => {
    const asked = renderToStaticMarkup(createElement(CapsCard, { report: report(false, { pendingRequestId: 'acr_1' }), onChanged: () => {} }));
    expect(asked).toContain('Asked');
    expect(asked).not.toContain('Ask for more');
    const off = { ...report(false), capRaise: { active: false } };
    expect(renderToStaticMarkup(createElement(CapsCard, { report: off, onChanged: () => {} }))).toContain('Asking for more is off');
    const adminOff = { ...report(true), capRaise: { active: false } };
    expect(renderToStaticMarkup(createElement(CapsCard, { report: adminOff, onChanged: () => {} }))).toContain('Turn on cap requests');
  });
});

describe('sourceKey', () => {
  it('files a call Landflow made outside a usage scope (imported, runtime landflow) under Landflow, not other clients', () => {
    expect(sourceKey('litellm', 'landflow')).toBe('landflow:landflow');
    expect(sourceKey('landflow', 'landflow')).toBe('landflow:landflow');
    expect(sourceKey(null, null)).toBe('landflow:landflow');
    expect(sourceKey('litellm', 'kagent')).toBe('litellm:kagent');
    expect(sourceKey('litellm', 'other')).toBe('litellm:other');
  });
});
