/**
 * Practice compliance (docs/practices.md#compliance): the counts and rates, the window, who may see a practice's numbers,
 * agents the caller can't read counted but not named, a run's practices, and the markup of the bar and the "What it saw" row.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { citeRate, complianceSegments, emptyCounts, failRate, otherAgentsText, passRate, percent, share } from '@/lib/shared/practice-compliance';
import type { PracticeCompliance } from '@/lib/shared/practice-compliance';
import type { PracticeDraftInput } from '@/lib/shared/practices';
import { ComplianceView } from '@/components/brain/wiki/practice-doc';
import { PracticesRowView, SawPracticesRow } from '@/components/run-trace/saw-practices';

vi.setConfig({ testTimeout: 20_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-practice-compliance-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { database } = await import('@/lib/server/db');
const { createUser } = await import('@/lib/server/auth/users');
const { enableTestAuth } = await import('@/lib/server/auth/test-bypass');
const projects = await import('@/lib/server/projects');
const { setHomeProject } = await import('@/lib/server/projects/store');
const { agentStore } = await import('@/lib/server/agents/store');
const { storePort } = await import('@/lib/server/practices/register');
const { approvePractice } = await import('@/lib/server/practices/approve');
const complianceRoute = await import('@/app/api/practices/[id]/compliance/route');
const runRoute = await import('@/app/api/executions/[id]/practices/route');
const workflowsRoute = await import('@/app/api/workflows/route');

const owner = await createUser({ email: 'owner@pc.test', name: 'Owner', role: 'owner', password: 'owner-password-1' });
const member = await createUser({ email: 'member@pc.test', name: 'Member', role: 'member', password: 'member-password-1' });
const stranger = await createUser({ email: 'stranger@pc.test', name: 'Stranger', role: 'member', password: 'stranger-password-1' });
const alpha = projects.createTeamProject({ name: 'Alpha' }).id;
const beta = projects.createTeamProject({ name: 'Beta' }).id;
projects.setMember(alpha, member.id, 'editor');
projects.setMember(beta, stranger.id, 'editor');

afterAll(() => {
  enableTestAuth();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

let seq = 0;
const input = (over: Partial<PracticeDraftInput> = {}): PracticeDraftInput => ({
  handle: `rules/rule-${++seq}`,
  title: 'A rule',
  level: 'org',
  strength: 'required',
  topics: [`t-${seq}`],
  repos: [],
  paths: [],
  summary: 'A short rule',
  body: 'The full rule.',
  ...over,
});
const approved = (over: Partial<PracticeDraftInput> = {}) => {
  const { practice } = storePort.draft(input(over), { source: 'person', actor: owner });
  approvePractice(owner, practice.id, { version: 1 });
  return practice;
};
const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();
const row = (practiceId: string, kind: 'delivered' | 'cited' | 'check-pass' | 'check-fail', extra: { version?: number; agentId?: string; executionId?: string; days?: number } = {}) =>
  storePort.record({ practiceId, version: extra.version ?? 1, kind, ...(extra.agentId && { agentId: extra.agentId }), ...(extra.executionId && { executionId: extra.executionId }), at: ago(extra.days ?? 1) });

const get = async (user: typeof owner, id: string, days?: number) => {
  enableTestAuth(user);
  const response = await complianceRoute.GET(new Request(`http://pc.test/api/practices/${id}/compliance${days ? `?days=${days}` : ''}`), { params: Promise.resolve({ id }) });
  return { status: response.status, body: (await response.json()) as { compliance: PracticeCompliance } };
};

describe('the pure rates', () => {
  it('never divide by zero', () => {
    expect(share(1, 0)).toBeUndefined();
    expect(citeRate(emptyCounts())).toBeUndefined();
    expect(passRate(emptyCounts())).toBeUndefined();
    expect(failRate(emptyCounts())).toBeUndefined();
    expect(percent(undefined)).toBe('–');
    expect(complianceSegments(emptyCounts())).toEqual([]);
  });

  it('compute the rates and the bar', () => {
    const c = { delivered: 10, cited: 4, checkPass: 6, checkFail: 2, waived: 2 };
    expect(citeRate(c)).toBe(0.4);
    expect(passRate(c)).toBe(0.75);
    expect(failRate(c)).toBe(0.25);
    expect(percent(0.625)).toBe('63%');
    const segments = complianceSegments(c);
    expect(segments.map((s) => [s.kind, s.count])).toEqual([['pass', 6], ['fail', 2], ['waived', 2]]);
    expect(segments.reduce((sum, s) => sum + s.share, 0)).toBeCloseTo(1);
    expect(otherAgentsText(1)).toBe('1 other agent');
    expect(otherAgentsText(2)).toBe('2 other agents');
  });
});

describe('GET /api/practices/:id/compliance', () => {
  it('adds up delivered, cited, passed, failed and waived rows in the window', async () => {
    const practice = approved();
    for (let i = 0; i < 5; i++) row(practice.id, 'delivered');
    row(practice.id, 'cited');
    row(practice.id, 'cited');
    row(practice.id, 'check-pass');
    row(practice.id, 'check-pass');
    row(practice.id, 'check-fail');
    row(practice.id, 'delivered', { days: 40 });
    row(practice.id, 'cited', { days: 40 });
    const workflowId = await workflow();
    await execution('exec_comp_1', workflowId);
    enableTestAuth(owner);
    const { waivePractice } = await import('@/lib/server/practices/approve');
    waivePractice(owner, practice.id, { executionId: 'exec_comp_1', version: 1, reason: 'A one-off hotfix, approved' });

    const { status, body } = await get(owner, practice.id);
    expect(status).toBe(200);
    expect(body.compliance).toMatchObject({ days: 30, delivered: 5, cited: 2, checkPass: 2, checkFail: 1, waived: 1, followedBy: [], otherAgents: 0 });
    expect(body.compliance.lastApplied).toBeDefined();
    expect(body.compliance.byVersion).toHaveLength(1);
    // The 40-day-old rows count in a wider window only.
    const wide = await get(owner, practice.id, 90);
    expect(wide.body.compliance).toMatchObject({ days: 90, delivered: 6, cited: 3 });
    const narrow = await get(owner, practice.id, 1);
    expect(narrow.body.compliance.delivered).toBe(0);
    expect((await get(owner, practice.id, 91)).status).toBe(400);
  });

  it('splits the counts by version', async () => {
    const practice = approved();
    row(practice.id, 'delivered', { version: 1 });
    row(practice.id, 'delivered', { version: 2 });
    row(practice.id, 'delivered', { version: 2 });
    const { body } = await get(owner, practice.id);
    expect(body.compliance.byVersion.map((v) => [v.version, v.delivered])).toEqual([[2, 2], [1, 1]]);
  });

  it('answers 404 for a practice the caller may not see', async () => {
    const mine = approved({ level: 'project', projectId: alpha });
    row(mine.id, 'delivered');
    expect((await get(member, mine.id)).status).toBe(200);
    expect((await get(stranger, mine.id)).status).toBe(404);
    expect((await get(owner, 'prc_missing')).status).toBe(404);
  });

  it('names the agents the caller may read and only counts the others', async () => {
    const practice = approved();
    const inAlpha = agentStore.create({ name: 'Alpha Helper' });
    setHomeProject('agent', inAlpha.id, alpha);
    const inBeta = agentStore.create({ name: 'Beta Helper' });
    setHomeProject('agent', inBeta.id, beta);
    row(practice.id, 'cited', { agentId: inAlpha.id });
    row(practice.id, 'cited', { agentId: inAlpha.id });
    row(practice.id, 'cited', { agentId: inBeta.id });
    row(practice.id, 'cited', { agentId: 'ag_gone' });
    const own = (await get(owner, practice.id)).body.compliance;
    expect(own.followedBy.map((a) => a.name)).toEqual(['Alpha Helper', 'Beta Helper']);
    expect(own.otherAgents).toBe(1);
    const alphaMember = (await get(member, practice.id)).body.compliance;
    expect(alphaMember.followedBy.map((a) => a.name)).toEqual(['Alpha Helper']);
    expect(alphaMember.otherAgents).toBe(2);
    const betaMember = (await get(stranger, practice.id)).body.compliance;
    expect(betaMember.followedBy.map((a) => a.name)).toEqual(['Beta Helper']);
    expect(betaMember.otherAgents).toBe(2);
    expect(JSON.stringify(betaMember)).not.toContain('Alpha Helper');
  });

  it('lists at most ten agents by their citations', async () => {
    const practice = approved();
    for (let i = 0; i < 12; i++) {
      const agent = agentStore.create({ name: `Agent ${String(i).padStart(2, '0')}` });
      for (let n = 0; n <= i; n++) row(practice.id, 'cited', { agentId: agent.id });
    }
    const { followedBy, otherAgents } = (await get(owner, practice.id)).body.compliance;
    expect(followedBy).toHaveLength(10);
    expect(followedBy[0].name).toBe('Agent 11');
    expect(otherAgents).toBe(2);
  });
});

const workflow = async () => {
  enableTestAuth(owner);
  const created = await workflowsRoute.POST(new Request('http://pc.test/api/workflows', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: `Flow ${++seq}`, nodes: [], connections: [] }) }));
  return ((await created.json()) as { workflow: { id: string } }).workflow.id;
};
const execution = async (id: string, workflowId: string) => {
  const now = new Date().toISOString();
  database().upsert('executions', { id, workflow_id: workflowId, status: 'success', mode: 'manual', started_at: now, finished_at: now, duration_ms: 1, summary: '{}', data: '{}' });
};
const runOf = async (user: typeof owner, id: string) => {
  enableTestAuth(user);
  const response = await runRoute.GET(new Request(`http://pc.test/api/executions/${id}/practices`), { params: Promise.resolve({ id }) });
  return { status: response.status, body: (await response.json()) as { practices: Array<{ handle: string; version: number; delivered: boolean; cited: boolean; check?: string }> } };
};

describe('GET /api/executions/:id/practices', () => {
  it('lists what the run was given, cited and checked', async () => {
    const first = approved();
    const second = approved();
    const workflowId = await workflow();
    await execution('exec_run_1', workflowId);
    row(first.id, 'delivered', { executionId: 'exec_run_1' });
    row(first.id, 'cited', { executionId: 'exec_run_1' });
    row(first.id, 'check-pass', { executionId: 'exec_run_1' });
    row(second.id, 'delivered', { executionId: 'exec_run_1' });
    row(second.id, 'check-fail', { executionId: 'exec_run_1' });
    const { status, body } = await runOf(owner, 'exec_run_1');
    expect(status).toBe(200);
    expect(body.practices).toEqual(
      [
        { handle: first.handle, version: 1, delivered: true, cited: true, check: 'pass' },
        { handle: second.handle, version: 1, delivered: true, cited: false, check: 'fail' },
      ].sort((a, b) => a.handle.localeCompare(b.handle)),
    );
  });

  it('leaves out practices the caller may not see, and answers 404 for a run they may not read', async () => {
    const hidden = approved({ level: 'project', projectId: alpha });
    const open = approved();
    const workflowId = await workflow();
    await execution('exec_run_2', workflowId);
    row(hidden.id, 'delivered', { executionId: 'exec_run_2' });
    row(open.id, 'delivered', { executionId: 'exec_run_2' });
    // The workflow is the owner's personal one: a member can't read it.
    expect((await runOf(member, 'exec_run_2')).status).toBe(404);
    expect((await runOf(owner, 'exec_missing')).status).toBe(404);
    const seen = await runOf(owner, 'exec_run_2');
    expect(seen.body.practices.map((p) => p.handle).sort()).toEqual([hidden.handle, open.handle].sort());
  });
});

describe('the markup', () => {
  const compliance = (over: Partial<PracticeCompliance> = {}): PracticeCompliance => ({
    days: 30,
    delivered: 8,
    cited: 6,
    checkPass: 5,
    checkFail: 1,
    waived: 1,
    followedBy: [{ agentId: 'ag_1', name: 'Release Helper' }],
    otherAgents: 2,
    lastApplied: new Date().toISOString(),
    byVersion: [],
    ...over,
  });

  it('draws the bar, the counts, who follows it and the other agents', () => {
    const html = renderToStaticMarkup(createElement(ComplianceView, { compliance: compliance(), lastRun: 'exec_1' }));
    expect(html).toContain('5 passed');
    expect(html).toContain('1 failed');
    expect(html).toContain('1 waived');
    expect(html).toContain('75%');
    expect(html).toContain('Followed by');
    expect(html).toContain('Release Helper');
    expect(html).toContain('and 2 other agents');
    expect(html).toContain('/executions/exec_1');
  });

  it('says so when nothing used the practice', () => {
    const html = renderToStaticMarkup(createElement(ComplianceView, { compliance: compliance({ delivered: 0, cited: 0, checkPass: 0, checkFail: 0, waived: 0, followedBy: [], otherAgents: 0, lastApplied: undefined }) }));
    expect(html).toContain('Nothing used it in the last 30 days');
    expect(html).not.toContain('Followed by');
  });

  it('draws the practices row with Cited and Not cited, and nothing when it is empty', () => {
    const practices = [{ handle: 'helm/chart-location', version: 3 }, { handle: 'ci/lint', version: 1 }];
    const loaded = renderToStaticMarkup(
      createElement(PracticesRowView, {
        practices,
        rows: [
          { handle: 'helm/chart-location', version: 3, delivered: true, cited: true, check: 'pass' },
          { handle: 'ci/lint', version: 1, delivered: true, cited: false, check: 'fail' },
        ],
      }),
    );
    expect(loaded).toContain('helm/chart-location@3');
    expect(loaded).toContain('Cited');
    expect(loaded).toContain('Not cited');
    expect(loaded).toContain('Check passed');
    expect(loaded).toContain('Check failed');
    // Before the run's answer (or without a run) only the practices are listed.
    const plain = renderToStaticMarkup(createElement(SawPracticesRow, { practices, executionId: 'exec_1' }));
    expect(plain).toContain('ci/lint@1');
    expect(plain).not.toContain('Not cited');
    expect(renderToStaticMarkup(createElement(SawPracticesRow, { practices: [] }))).toBe('');
    expect(renderToStaticMarkup(createElement(PracticesRowView, { practices: [], rows: [] }))).toBe('');
  });
});
