/**
 * Goal progress (docs/projects-and-goals.md#progress): runs, spend and work updates per goal and its sub-goals, counted
 * only from what each person may see (a private work event counts for its owner alone, admins included), the two routes,
 * one query per source however many goals, and the nightly sync's "Goals that moved". Made-up people and rows.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-goal-progress-'));
const ENV: Record<string, string> = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_BRAIN_MODEL: 'off', LANDFLOW_BRAIN_EMBEDDINGS: 'off' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const auth = await import('@/lib/server/auth');
const projects = await import('@/lib/server/projects');
const { database } = await import('@/lib/server/db');
const { upsertEntity } = await import('@/lib/server/brain/entities');
const { createGoal, setProjectGoals, setInitiatives } = await import('@/lib/server/goals/store');
const { progressFor, becauseText, goalsMovedFor } = await import('@/lib/server/goals/progress');
const { gatherFor, deterministicBriefing, briefingPrompt, writeBriefingText } = await import('@/lib/server/brain/briefing');
const { createDraft, getDraft } = await import('@/lib/server/brain/briefings-store');
const { dayOf } = await import('@/lib/server/usage/ledger');
const goalsRoute = await import('@/app/api/goals/route');
const progressRoute = await import('@/app/api/goals/[id]/progress/route');

type Route = (request: Request, ctx?: { params: Promise<Record<string, string>> }) => Promise<Response>;
interface Caller {
  id: string;
  session: string;
  role: 'owner' | 'admin' | 'member';
}

async function call(route: unknown, path: string, caller: Caller, params?: Record<string, string>) {
  const response = await (route as Route)(new Request(`http://localhost:3000${path}`, { headers: { cookie: `landflow_session=${caller.session}` } }), params && { params: Promise.resolve(params) });
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

async function makeUser(email: string, name: string, role: Caller['role']): Promise<Caller> {
  const record = role === 'owner' ? await auth.createOwner({ email, name, password: 'password-123' }) : await auth.createUser({ email, name, role, password: 'password-123' });
  return { id: record.id, role, session: auth.createSession(record, 'password').token };
}
const actorOf = (c: Caller) => ({ id: c.id, role: c.role });

const now = Date.now();
const ago = (ms: number) => new Date(now - ms).toISOString();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

let owner: Caller, admin: Caller, ann: Caller, ben: Caller, cat: Caller, dan: Caller;
let alpha = '', beta = '', gamma = '', delta = '';
let company = '', sub = '', alphaGoal = '', quiet = '', betaGoal = '', secretGoal = '';
let initiative = '';
let hiddenInitiative = '';
let seq = 0;

function run(workflowId: string, status: string, at: string, evaluationRunId?: string) {
  database().upsert('executions', { id: `ex_${++seq}`, workflow_id: workflowId, status, mode: 'manual', started_at: at, finished_at: status === 'running' ? null : at, duration_ms: 10, summary: '{}', data: '{}', ...(evaluationRunId && { evaluation_run_id: evaluationRunId }) });
}
function spend(goalId: string | null, projectId: string | null, cost: number, at: string) {
  database().upsert('ai_usage', { id: `ai_${++seq}`, at, day: at.slice(0, 10), provider: 'test', model: 'm', operation: 'chat', input_tokens: 1, output_tokens: 1, cost, goal_id: goalId, project_id: projectId });
}
function event(owner_id: string, visibility: 'private' | 'team' | 'org', link: { goal?: string; project?: string; initiative?: string }, at = ago(HOUR), kind = 'work.session') {
  database().upsert('usage_events', {
    id: `ev_${++seq}`, at, day: dayOf(Date.parse(at)), kind, project_id: link.project ?? null, goal_id: link.goal ?? null,
    message: 'SECRET TITLE', attrs: JSON.stringify({ ...(link.initiative && { initiative: link.initiative }), title: 'SECRET TITLE' }),
    owner_id, visibility, source: 'test', source_id: `src_${seq}`,
  });
}
const flat = (nodes: Array<{ id: string; children: any[] }>): string[] => nodes.flatMap((n) => [n.id, ...flat(n.children)]);
const only = (actor: Caller, id: string, window: 1 | 7 | 30 = 7) => progressFor(actorOf(actor), [id], window, now)[0];

beforeAll(async () => {
  auth.disableTestAuth();
  owner = await makeUser('owner@example.com', 'Olive Owner', 'owner');
  admin = await makeUser('admin@example.com', 'Adam Admin', 'admin');
  ann = await makeUser('ann@example.com', 'Ann', 'member');
  ben = await makeUser('ben@example.com', 'Ben', 'member');
  cat = await makeUser('cat@example.com', 'Cat', 'member');
  dan = await makeUser('dan@example.com', 'Dan', 'member');
  alpha = projects.createTeamProject({ name: 'Alpha' }).id;
  beta = projects.createTeamProject({ name: 'Beta' }).id;
  projects.setMember(alpha, ann.id, 'editor');
  projects.setMember(alpha, ben.id, 'editor');
  projects.setMember(beta, cat.id, 'editor');
  gamma = projects.createTeamProject({ name: 'Gamma' }).id;
  delta = projects.createTeamProject({ name: 'Delta' }).id;
  for (const project of [gamma, delta]) for (const person of [ann, ben]) projects.setMember(project, person.id, 'editor');
  company = createGoal({ title: 'Close invoices in two days', level: 'company' }).id;
  sub = createGoal({ title: 'Automate matching', level: 'company', parentId: company }).id;
  setProjectGoals(alpha, [sub]);
  setProjectGoals(beta, [company]);
  alphaGoal = createGoal({ title: 'Alpha launch', level: 'project', projectId: alpha }).id;
  setProjectGoals(alpha, [sub, alphaGoal]);
  quiet = createGoal({ title: 'Quiet goal', level: 'project', projectId: gamma }).id;
  secretGoal = createGoal({ title: 'Ann only', level: 'project', projectId: delta }).id;
  betaGoal = createGoal({ title: 'Beta launch', level: 'project', projectId: beta }).id;
  initiative = upsertEntity({ type: 'initiative', name: 'Month End Push', projectId: alpha }).entity.id;
  hiddenInitiative = upsertEntity({ type: 'initiative', name: 'Board Secret', projectId: beta }).entity.id;
  const { setHomeProject } = projects as unknown as { setHomeProject: (kind: string, id: string, project: string) => void };
  setHomeProject('workflow', 'wf_alpha', alpha);
  setHomeProject('workflow', 'wf_beta', beta);
  // Runs: alpha's serve the sub-goal, beta's the company goal.
  run('wf_alpha', 'success', ago(HOUR));
  run('wf_alpha', 'success', ago(2 * HOUR));
  run('wf_alpha', 'error', ago(3 * HOUR));
  run('wf_alpha', 'running', ago(HOUR));
  run('wf_alpha', 'cancelled', ago(HOUR));
  run('wf_alpha', 'success', ago(10 * DAY));
  run('wf_beta', 'success', ago(HOUR));
  run('wf_beta', 'success', ago(2 * HOUR));
  spend(sub, alpha, 0.25, ago(HOUR));
  spend(company, beta, 0.5, ago(HOUR));
  spend(sub, null, 1, ago(HOUR));
  spend(alphaGoal, alpha, 0.07, ago(HOUR));
});

afterAll(() => {
  auth.enableTestAuth();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

describe('goal progress', () => {
  it('counts finished runs of a serving project, with sub-goals, and not running or cancelled ones', () => {
    const forSub = only(admin, sub);
    expect(forSub.runs).toEqual({ ok: 2, failed: 1 });
    expect(forSub.moved).toBe(true);
    expect(forSub.lastActivityAt).toBeDefined();
    // The company goal counts its sub-goal's project and its own.
    expect(only(admin, company).runs).toEqual({ ok: 4, failed: 1 });
    expect(only(admin, sub, 30).runs).toEqual({ ok: 3, failed: 1 });
    expect(only(admin, quiet)).toMatchObject({ runs: { ok: 0, failed: 0 }, costUsd: 0, updates: 0, moved: false });
    expect(only(admin, quiet).lastActivityAt).toBeUndefined();
  });

  it('does not count evaluation cases as runs', () => {
    const before = only(admin, sub).runs;
    run('wf_alpha', 'success', ago(HOUR), 'evr_1');
    run('wf_alpha', 'error', ago(HOUR), 'evr_1');
    expect(only(admin, sub).runs).toEqual(before);
  });

  it('counts runs of a workflow with no home row in the owner’s personal project, for the owner only', () => {
    const mine = createGoal({ title: 'Personal serve', level: 'company' }).id;
    setProjectGoals(projects.defaultProjectId() as string, [mine]);
    run('wf_unhomed', 'success', ago(HOUR));
    run('wf_unhomed', 'error', ago(2 * HOUR));
    expect(only(owner, mine).runs).toEqual({ ok: 1, failed: 1 });
    expect(only(owner, mine).moved).toBe(true);
    expect(only(ann, mine)).toMatchObject({ runs: { ok: 0, failed: 0 }, moved: false });
    expect(goalsMovedFor(actorOf(owner), dayOf(now), now).map((g) => g.goalId)).toContain(mine);
  });

  it('sums spend per goal and its sub-goals, and gives a person only spend of projects they see', () => {
    expect(only(admin, sub).costUsd).toBeCloseTo(1.25);
    expect(only(admin, company).costUsd).toBeCloseTo(1.75);
    // Ann: no beta spend, no spend without a project.
    expect(only(ann, sub).costUsd).toBeCloseTo(0.25);
    expect(only(ann, company).costUsd).toBeCloseTo(0.25);
    expect(only(ann, company).runs).toEqual({ ok: 2, failed: 1 });
    expect(only(cat, company).runs).toEqual({ ok: 2, failed: 0 });
    expect(only(dan, company)).toMatchObject({ runs: { ok: 0, failed: 0 }, costUsd: 0, moved: false });
  });

  it('keeps one person’s private work from everyone else, owners and admins included', () => {
    event(ann.id, 'private', { goal: secretGoal });
    expect(only(ann, secretGoal).updates).toBe(1);
    for (const other of [ben, owner, admin, cat, dan]) expect(only(other, secretGoal).updates).toBe(0);
    expect(only(admin, secretGoal)).toMatchObject({ moved: false, runs: { ok: 0, failed: 0 } });
  });

  it('shows team work to teammates only, and org work to everyone who sees the goal', () => {
    event(ann.id, 'team', { goal: quiet });
    event(ann.id, 'org', { goal: company });
    expect(only(ann, quiet).updates).toBe(1);
    expect(only(ben, quiet).updates).toBe(1);
    // Cat is in another team project, not a teammate; the owner and admin share no team project with Ann either.
    expect(only(cat, quiet).updates).toBe(0);
    expect(only(owner, quiet).updates).toBe(0);
    for (const person of [ann, ben, cat, dan, owner, admin]) expect(only(person, company).updates).toBe(1);
    expect(JSON.stringify(progressFor(actorOf(ben), [quiet, company], 7, now))).not.toContain('SECRET TITLE');
  });

  it('links work through a serving project and counts a row linked to two goals for each', () => {
    event(ben.id, 'org', { project: alpha });
    expect(only(ann, sub).updates).toBe(1);
    expect(only(ann, alphaGoal).updates).toBe(1);
    // Cat sees the company goals but not alpha, so alpha's project link gives nothing.
    expect(only(cat, sub).updates).toBe(0);
    // sub and company are both reached by the same row.
    expect(only(admin, company).updates).toBe(2);
  });

  it('links work by initiative id or name, case-insensitively, and only an initiative the person can read', () => {
    setInitiatives(quiet, [initiative, hiddenInitiative]);
    event(ben.id, 'org', { initiative: 'MONTH END PUSH' }, ago(2 * HOUR));
    event(ben.id, 'org', { initiative: initiative }, ago(2 * HOUR));
    event(ben.id, 'org', { initiative: 'board secret' }, ago(2 * HOUR));
    event(ben.id, 'org', { initiative: hiddenInitiative }, ago(2 * HOUR));
    // Ann reads the alpha initiative only: the two Alpha rows count (plus her earlier team row), the Beta ones do not.
    expect(only(ann, quiet).updates).toBe(3);
    expect(only(dan, quiet).updates).toBe(0);
    // Cat cannot see the goal, so it answers an empty progress whatever the events.
    expect(only(cat, quiet)).toMatchObject({ updates: 0, moved: false });
  });

  it('answers nothing for no goals and ignores a window it is not asked about', () => {
    expect(progressFor(actorOf(ann), [], 7, now)).toEqual([]);
    expect(only(admin, sub, 1).runs).toEqual({ ok: 2, failed: 1 });
  });

  it('writes count-only reasons', () => {
    const base = { goalId: 'g', window: 7 as const, moved: true };
    expect(becauseText({ ...base, runs: { ok: 4, failed: 0 }, costUsd: 0, updates: 2 })).toBe('4 runs ok, 2 updates');
    expect(becauseText({ ...base, runs: { ok: 0, failed: 1 }, costUsd: 0, updates: 0 })).toBe('1 failed run');
    expect(becauseText({ ...base, runs: { ok: 0, failed: 0 }, costUsd: 0.123, updates: 0 })).toBe('$0.12 spent');
    expect(becauseText({ ...base, runs: { ok: 1, failed: 0 }, costUsd: 0.001, updates: 1 })).toBe('1 run ok, 1 update, < $0.01 spent');
  });

  it('uses a constant number of queries however many goals it is asked about', () => {
    const more = Array.from({ length: 19 }, (_, i) => createGoal({ title: `Extra ${i}`, level: 'project', projectId: alpha }).id);
    const count = (ids: string[]) => {
      const db = database();
      const all = vi.spyOn(db, 'all');
      const get = vi.spyOn(db, 'get');
      progressFor(actorOf(ann), ids, 7, now);
      const n = all.mock.calls.length + get.mock.calls.length;
      all.mockRestore();
      get.mockRestore();
      return n;
    };
    const one = count([alphaGoal]);
    expect(count([alphaGoal, ...more])).toBe(one);
  });
});

describe('goal progress routes', () => {
  it('answers 404 for a goal the caller cannot see and 400 for another window', async () => {
    expect((await call(progressRoute.GET, `/api/goals/${betaGoal}/progress`, ann, { id: betaGoal })).status).toBe(404);
    expect((await call(progressRoute.GET, `/api/goals/${company}/progress?window=14`, ann, { id: company })).status).toBe(400);
    const ok = await call(progressRoute.GET, `/api/goals/${company}/progress`, ann, { id: company });
    expect(ok.status).toBe(200);
    expect(ok.body.progress).toHaveLength(1);
    expect(ok.body.progress[0]).toMatchObject({ goalId: company, window: 7 });
    expect((await call(progressRoute.GET, `/api/goals/${company}/progress?window=30`, admin, { id: company })).body.progress[0].window).toBe(30);
  });

  it('adds one entry per goal of the tree with progress=1, and nothing without it', async () => {
    const plain = await call(goalsRoute.GET, '/api/goals?window=30', ann);
    expect('progress' in plain.body).toBe(false);
    const withProgress = await call(goalsRoute.GET, '/api/goals?progress=1&window=30', ann);
    expect(withProgress.status).toBe(200);
    expect(withProgress.body.goals).toEqual(plain.body.goals);
    const ids = flat(withProgress.body.goals).sort();
    expect(withProgress.body.progress.map((p: { goalId: string }) => p.goalId).sort()).toEqual(ids);
    expect(withProgress.body.progress.every((p: { window: number }) => p.window === 30)).toBe(true);
  });
});

describe('goals that moved in the nightly sync', () => {
  const day = dayOf(now);
  // Enough of Ann's private work that the goal ranks within the five.
  beforeAll(() => {
    for (let i = 0; i < 8; i++) event(ann.id, 'private', { goal: secretGoal });
  });

  it('gives each person only goals of their projects, counted by what they may see', () => {
    // Ann's private event moves a goal of hers that nobody else's numbers show.
    const annMoved = goalsMovedFor(actorOf(ann), day, now);
    const benMoved = goalsMovedFor(actorOf(ben), day, now);
    expect(annMoved.find((g) => g.goalId === secretGoal)?.because).toBe('9 updates');
    expect(benMoved.map((g) => g.goalId)).not.toContain(secretGoal);
    expect(annMoved.length).toBeLessThanOrEqual(5);
    expect(goalsMovedFor(actorOf(cat), day, now).map((g) => g.goalId)).not.toContain(alphaGoal);
    expect(goalsMovedFor(actorOf(dan), day, now)).toEqual([]);
    expect(JSON.stringify(annMoved)).not.toContain('SECRET TITLE');
  });

  it('is gathered for the person, stored with the draft, counted, and written into the text', async () => {
    const gathered = gatherFor(actorOf(ann), day, now);
    expect(gathered.goalsMoved?.find((g) => g.goalId === secretGoal)?.because).toBe('9 updates');
    expect(gatherFor(actorOf(ben), day, now).goalsMoved?.map((g) => g.goalId) ?? []).not.toContain(secretGoal);
    const draft = createDraft({ userId: ann.id, day, gathered });
    expect(getDraft(draft.id, ann.id)?.gathered.goalsMoved).toEqual(gathered.goalsMoved);
    const text = deterministicBriefing({ own: [], related: [], finished: [], goalsMoved: [{ goalId: 'a', title: 'A', because: '4 runs ok' }, { goalId: 'b', title: 'B', because: '2 updates' }, { goalId: 'c', title: 'C', because: '1 update' }, { goalId: 'd', title: 'D', because: '1 update' }] });
    expect(text).toContain('Goals that moved: A (4 runs ok), B (2 updates), C (1 update), and 1 more.');
    const prompt = briefingPrompt({ own: [], related: [], finished: [], goalsMoved: [{ goalId: 'a', title: 'A', because: '4 runs ok' }] }, 500).prompt;
    expect(prompt).toMatch(/<work>\n- goal moved: A \(4 runs ok\)\n<\/work>/);
    const written = await writeBriefingText({ own: [], related: [], finished: [], goalsMoved: [{ goalId: 'a', title: 'A', because: '4 runs ok' }] }, undefined);
    expect(written.text).toContain('Goals that moved');
  });

  it('reads from the day before `day` up to the end of `day`, no further', () => {
    const edge = createGoal({ title: 'Edge goal', level: 'project', projectId: gamma }).id;
    const target = '2020-03-10';
    const at = (iso: string) => iso;
    event(ann.id, 'org', { goal: edge }, at('2020-03-07T12:00:00.000Z')); // two days before: left out
    event(ann.id, 'org', { goal: edge }, at('2020-03-09T06:00:00.000Z')); // early the day before: kept
    event(ann.id, 'org', { goal: edge }, at('2020-03-10T12:00:00.000Z')); // on the day: kept
    event(ann.id, 'org', { goal: edge }, at('2020-03-13T12:00:00.000Z')); // after the day: left out
    const moved = goalsMovedFor(actorOf(ann), target, Date.parse('2020-03-20T00:00:00.000Z'));
    expect(moved.find((g) => g.goalId === edge)?.because).toBe('2 updates');
  });

  it('answers an empty progress for a root the person cannot see', () => {
    expect(progressFor(actorOf(cat), [quiet], 7, now)[0]).toMatchObject({ goalId: quiet, updates: 0, moved: false });
  });

  it('reads old stored rows without goalsMoved as before', () => {
    const draft = createDraft({ userId: dan.id, day, gathered: { own: [], related: [], finished: [] } });
    expect(getDraft(draft.id, dan.id)?.gathered).toEqual({ own: [], related: [], finished: [] });
    database().upsert('brain_briefings', { id: 'old', user_id: dan.id, day: '2020-01-01', status: 'draft', gathered: JSON.stringify({ own: [], related: [], finished: [], goalsMoved: 'nope' }), text: null, model: null, workflow_id: null, execution_id: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
    expect(getDraft('old', dan.id)?.gathered.goalsMoved).toBeUndefined();
  });
});
