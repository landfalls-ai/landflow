/**
 * The join of goal progress (contracts/w10/goal-progress-api.md): PC17's real routes (`GET /api/goals?progress=1&window=` and
 * `GET /api/goals/:id/progress`) answer, and PC18's client reads the answer: the same `api` call `useGoalProgress` makes, the
 * real `indexProgress` and the real `progressText` / `GoalProgressLine`. Two people see different numbers for the same goal
 * because a private work event counts for its owner alone (constitution lesson 3: owners and admins are no exception).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { api } from '../src/lib/client/api';
import { GoalProgressLine, indexProgress, progressText } from '../src/components/goals/goal-progress';
import type { GoalProgress, GoalProgressResponse } from '../src/lib/shared/goal-progress';
import { routeFetch } from './join-fetch';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-goal-progress-join-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_BRAIN_MODEL: 'off', LANDFLOW_BRAIN_EMBEDDINGS: 'off' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { createUser } = await import('@/lib/server/auth/users');
const { enableTestAuth } = await import('@/lib/server/auth/test-bypass');
const { database } = await import('@/lib/server/db');
const projects = await import('@/lib/server/projects');
const { createGoal, setProjectGoals } = await import('@/lib/server/goals/store');
const { dayOf } = await import('@/lib/server/usage/ledger');
const goalsRoute = await import('@/app/api/goals/route');
const progressRoute = await import('@/app/api/goals/[id]/progress/route');

vi.stubGlobal('fetch', routeFetch([['/api/goals', goalsRoute], ['/api/goals/:id/progress', progressRoute]]));

afterAll(() => {
  vi.unstubAllGlobals();
  enableTestAuth();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

type User = Awaited<ReturnType<typeof createUser>>;
const as = async <T>(user: User, fn: () => Promise<T>): Promise<T> => {
  enableTestAuth(user);
  try {
    return await fn();
  } finally {
    enableTestAuth();
  }
};

const ann = await createUser({ email: 'ann@progress-join.test', name: 'Ann', role: 'member', password: 'password-123' });
const cara = await createUser({ email: 'cara@progress-join.test', name: 'Cara', role: 'member', password: 'password-123' });
const ben = await createUser({ email: 'ben@progress-join.test', name: 'Ben', role: 'member', password: 'password-123' });
const admin = await createUser({ email: 'admin@progress-join.test', name: 'Adam', role: 'admin', password: 'password-123' });

const projectA = projects.createTeamProject({ name: 'Join A' }).id;
const projectB = projects.createTeamProject({ name: 'Join B' }).id;
projects.setMember(projectA, ann.id, 'editor');
projects.setMember(projectA, cara.id, 'editor');
projects.setMember(projectB, ben.id, 'editor');
const company = createGoal({ title: 'Close invoices in two days', level: 'company' }).id;
setProjectGoals(projectA, [company]);
setProjectGoals(projectB, [company]);
const a1 = createGoal({ title: 'Automate matching', level: 'project', projectId: projectA, parentId: company }).id;

const now = Date.now();
const at = new Date(now - 3_600_000).toISOString();
let seq = 0;
const run = (workflowId: string, status: string) => database().upsert('executions', { id: `ex_join_${++seq}`, workflow_id: workflowId, status, mode: 'manual', started_at: at, finished_at: at, duration_ms: 10, summary: '{}', data: '{}' });
const event = (ownerId: string, visibility: 'private' | 'team' | 'org', link: { goal?: string; project?: string }) =>
  database().upsert('usage_events', { id: `ev_join_${++seq}`, at, day: dayOf(Date.parse(at)), kind: 'work.session', project_id: link.project ?? null, goal_id: link.goal ?? null, message: 'SECRET TITLE', attrs: JSON.stringify({ title: 'SECRET TITLE' }), owner_id: ownerId, visibility, source: 'test', source_id: `src_join_${seq}` });
(projects as unknown as { setHomeProject: (kind: string, id: string, project: string) => void }).setHomeProject('workflow', 'wf_join_a', projectA);
run('wf_join_a', 'success');
run('wf_join_a', 'success');
run('wf_join_a', 'error');
database().upsert('ai_usage', { id: 'ai_join_1', at, day: at.slice(0, 10), provider: 'test', model: 'm', operation: 'chat', input_tokens: 1, output_tokens: 1, cost: 0.42, goal_id: a1, project_id: projectA });
event(ann.id, 'private', { project: projectA });
event(ann.id, 'team', { goal: a1 });
event(ben.id, 'org', { goal: company });

const listAnswer = (user: User, query = 'progress=1&window=7') => as(user, () => api<Partial<GoalProgressResponse>>(`/api/goals?${query}`));
const lineOf = async (user: User, goalId: string, query?: string) => progressText(indexProgress(await listAnswer(user, query)).get(goalId)!);

describe('the Goals page line from the real route', () => {
  it('reads the host answer for every goal the viewer sees, and the line words it', async () => {
    const answer = await listAnswer(ann);
    const map = indexProgress(answer);
    expect([...map.keys()].sort()).toEqual([a1, company].sort());
    // Ann: 3 runs (one failed), her private update and her team one, $0.42.
    expect(progressText(map.get(a1)!)).toBe('3 runs · 1 failed · 2 updates · $0.42 this week');
    const html = renderToStaticMarkup(createElement(GoalProgressLine, { progress: map.get(a1)! }));
    expect(html).toContain('3 runs · 1 failed · 2 updates · $0.42 this week');
    expect(html).toContain('aria-label="Moved"');
  });

  it('shows two people different numbers: a private event counts for its owner alone, admins included', async () => {
    // Cara is Ann's teammate: she sees the team event, not the private one. Ben and the admin see neither.
    expect(await lineOf(ann, a1)).toBe('3 runs · 1 failed · 2 updates · $0.42 this week');
    expect(await lineOf(cara, a1)).toBe('3 runs · 1 failed · 1 update · $0.42 this week');
    const ownerOf = (user: User) => listAnswer(user).then((answer) => answer.progress!.find((p) => p.goalId === company)!.updates);
    expect(await ownerOf(ann)).toBe(3);
    expect(await ownerOf(cara)).toBe(2);
    expect(await ownerOf(admin)).toBe(1);
    // Ben cannot see project A: its runs and spend are not his.
    expect(await lineOf(ben, company)).toBe('1 update this week');
    expect(JSON.stringify(await listAnswer(ben))).not.toContain('SECRET TITLE');
  });

  it('the project brief card asks with its projectId and gets a line per goal of that project', async () => {
    const map = indexProgress(await listAnswer(ann, `projectId=${projectA}&progress=1&window=7`));
    expect(map.has(a1)).toBe(true);
    expect(map.get(a1)!.window).toBe(7);
  });

  it('an answer without progress=1 is an empty map, never an error', async () => {
    expect(indexProgress(await listAnswer(ann, '')).size).toBe(0);
  });
});

describe('the goal sheet from the real route', () => {
  it('parses as GoalProgressResponse and words 30 days', async () => {
    const answer = await as(ann, () => api<GoalProgressResponse>(`/api/goals/${a1}/progress?window=30`));
    expect(answer.progress).toHaveLength(1);
    const progress: GoalProgress = answer.progress[0];
    expect(progress).toMatchObject({ goalId: a1, window: 30, runs: { ok: 2, failed: 1 }, moved: true });
    expect(progressText(progress)).toMatch(/ in 30 days$/);
  });

  it('refuses a window it does not serve with a 400 the client turns into an error', async () => {
    await expect(as(ann, () => api(`/api/goals/${a1}/progress?window=5`))).rejects.toMatchObject({ status: 400 });
  });
});
