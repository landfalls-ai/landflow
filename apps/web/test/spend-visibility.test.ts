/**
 * The rules of backbone contracts s11/spend-visibility.md (the user's decision D1, 2026-11-15) that exist so far, as a
 * checklist later waves extend. Wave 11: rule 1 (everyone sees every person by name), rule 2 (other groupings keep
 * their visibility), rule 4 (no prompt text), rule 5 (other people's caps stay private).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Workflow } from '@landflow/engine';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-spend-visibility-'));
const previousEnv = { ...process.env };
Object.assign(process.env, { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_AUDIT_OUTBOX: 'off' });

const { store } = await import('@/lib/server/store');
const { createUser } = await import('@/lib/server/auth/users');
const { enableTestAuth } = await import('@/lib/server/auth/test-bypass');
const projects = await import('@/lib/server/projects');
const { database } = await import('@/lib/server/db');
const { aiUsageMeter, saveAiCaps } = await import('@/lib/server/ai-usage');
const route = await import('@/app/api/insights/ai/route');

type User = Awaited<ReturnType<typeof createUser>>;
let alpha: User;
let beta: User;
let admin: User;
let counter = 0;

function row(fields: Record<string, unknown>) {
  const now = new Date();
  database().insertNew('ai_usage', {
    id: `sv-${++counter}`,
    call_id: `sv-call-${counter}`,
    at: now.toISOString(),
    day: aiUsageMeter().today(now.getTime()),
    provider: 'anthropic',
    model: 'claude-sonnet-5-5',
    operation: 'chat',
    input_tokens: 100,
    output_tokens: 50,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    ...fields,
  });
}

const get = async (user: User) => {
  enableTestAuth(user);
  try {
    const response = await (route.GET as (r: Request) => Promise<Response>)(new Request('http://x.test/api/insights/ai?period=7d'));
    expect(response.status).toBe(200);
    return { text: await response.clone().text(), body: await response.json() };
  } finally {
    enableTestAuth();
  }
};

beforeAll(async () => {
  admin = await createUser({ email: 'ada@visibility.test', name: 'Ada Admin', role: 'owner', password: 'ada-password-1' });
  alpha = await createUser({ email: 'alma@visibility.test', name: 'Alma Alpha', role: 'member', password: 'alma-password-1' });
  beta = await createUser({ email: 'ben@visibility.test', name: 'Ben Beta', role: 'member', password: 'ben-password-1' });
  const open = projects.createTeamProject({ name: 'Open Project' }).id;
  const closed = projects.createTeamProject({ name: 'Closed Project' }).id;
  projects.setMember(open, alpha.id, 'editor');
  projects.setMember(closed, beta.id, 'editor');
  store.saveWorkflow({ id: 'wf_sv_closed', name: 'Closed flow', nodes: [], connections: [] } as unknown as Workflow);
  projects.setHomeProject('workflow', 'wf_sv_closed', closed);
  row({ workflow_id: 'wf_sv_closed', user_id: beta.id, project_id: closed, cost: 4 });
  row({ user_id: alpha.id, cost: 1 });
  saveAiCaps({ credentials: {}, users: { [beta.id]: { name: 'Ben Beta', dayCost: 77 } } });
  aiUsageMeter().invalidateCaps();
});

afterAll(() => {
  for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key];
  Object.assign(process.env, previousEnv);
});

describe('spend visibility (D1)', () => {
  it('rule 1: a member sees every person by name, with the amounts of every row', async () => {
    const { body } = await get(alpha);
    const people = Object.fromEntries(body.groups.person.map((r: { label: string; cost: number }) => [r.label, r.cost]));
    expect(people).toMatchObject({ 'Alma Alpha': 1, 'Ben Beta': 4 });
    expect(body.peopleTotals.cost).toBeCloseTo(5);
    expect(body.totals.cost).toBeCloseTo(1);
  });

  it("rule 2: another person's project, workflow and agent keep their visibility", async () => {
    const { text } = await get(alpha);
    expect(text).not.toContain('Closed Project');
    expect(text).not.toContain('wf_sv_closed');
    expect(text).not.toContain('Closed flow');
  });

  it('rule 4: no prompt text in the JSON', async () => {
    const { text } = await get(alpha);
    expect(text).not.toMatch(/prompt|messages|content/i);
  });

  it("rule 5: other people's caps stay private to a member, visible to the owner", async () => {
    const mine = (await get(alpha)).body.caps.map((c: { id: string }) => c.id);
    expect(mine.some((id: string) => id.includes(beta.id))).toBe(false);
    const all = (await get(admin)).body.caps.map((c: { id: string }) => c.id);
    expect(all).toContain(`user:${beta.id}:day:cost`);
  });
});
