/**
 * Check Practices (core.practiceCheck, docs/practices.md#the-check-practices-step): a required practice's failed check stops the
 * run at the step until a waiver and a retry; a recommended one only warns; reviewer verdicts block only with the option on; a
 * practice of another project is never checked. A fake port holds the practices; waivers and the retry are the real ones.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { ApprovedPractice, PracticeApplicationInput } from '@/lib/shared/practices';

vi.setConfig({ testTimeout: 30_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-practice-check-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { createUser } = await import('@/lib/server/auth/users');
const { withAuth } = await import('@/lib/server/auth/context');
const { store } = await import('@/lib/server/store');
const { runWorkflow, startRetry } = await import('@/lib/server/runner');
const { corePlugin } = await import('@/lib/server/nodes');
const { registry } = await import('@/lib/server/plugins/registry');
const { createTeamProject, setMember, setHomeProject } = await import('@/lib/server/projects/store');
const { setPracticesPort } = await import('@/lib/server/practices/port');
const { recordApplication } = await import('@/lib/server/practices/store');
const { judge, waiveUrlOf } = await import('@/lib/server/nodes/practice-check');
const templates = await import('@/lib/server/templates');
const { matchesPracticeGlob: webGlob } = await import('@/lib/shared/practices');
const { matchesPracticeGlob: sharedGlob } = await import('@landflow/protocol');
import type { ExecutionEvent } from '@landflow/engine';

registry.registerBuiltin(corePlugin);
const owner = await createUser({ email: 'owner@practice-check.test', name: 'Owner', role: 'owner', password: 'owner-password-1' });
const as = <T,>(fn: () => T): T => withAuth({ principal: { user: owner, via: 'test' } }, fn);
const mine = createTeamProject({ name: 'Billing', createdBy: owner.id });
const other = createTeamProject({ name: 'Search', createdBy: owner.id });
setMember(mine.id, owner.id, 'editor');

const practice = (id: string, handle: string, extra: Partial<ApprovedPractice> = {}): ApprovedPractice => ({
  id,
  handle,
  title: `Title of ${handle}`,
  level: 'project',
  projectId: mine.id,
  strength: 'required',
  topics: [],
  repos: [],
  paths: [],
  version: 2,
  summary: 'Rule',
  body: 'Body',
  checks: [],
  sha256: 'x',
  approvedAt: '2026-01-01T00:00:00.000Z',
  ...extra,
});
const NO_SECRETS = [{ kind: 'pathAbsent' as const, glob: 'secrets/**' }];
const all = [
  practice('prc_required', 'sec/no-secrets', { checks: NO_SECRETS }),
  practice('prc_recommended', 'docs/readme', { strength: 'recommended', checks: [{ kind: 'pathExists', glob: 'README.md' }] }),
  practice('prc_judged', 'review/design', { checks: [] }),
  practice('prc_other', 'search/other', { projectId: other.id, checks: [{ kind: 'pathExists', glob: 'nowhere/**' }] }),
];
const recorded: PracticeApplicationInput[] = [];
setPracticesPort({
  enabled: () => true,
  draft: () => {
    throw new Error('not used');
  },
  approved: ({ projectIds }) => all.filter((p) => p.level === 'org' || (projectIds !== 'all' && projectIds.includes(p.projectId!))),
  record: (row) => recorded.push(row),
});

afterAll(() => {
  setPracticesPort(undefined);
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const BAD = [{ path: 'secrets/key.txt', status: 'A', added: ['x'] }];
const GOOD = [{ path: 'src/a.ts', status: 'A', added: ['x'] }, { path: 'README.md', status: 'M', added: ['y'] }];

function flow(id: string, changed: unknown, check: Record<string, unknown> = {}) {
  const node = (nid: string, name: string, type: string, x: number, parameters: Record<string, unknown>) => ({ id: nid, name, type, typeVersion: 1, position: [x, 0] as [number, number], parameters });
  return {
    id,
    name: id,
    active: false,
    nodes: [
      node('start', 'Start', 'core.manualTrigger', 0, {}),
      node('change', 'Change', 'core.code', 260, { mode: 'all', language: 'javascript', code: `return [{ json: { files: ${JSON.stringify(changed)} } }];` }),
      node('check', 'Check Practices', 'core.practiceCheck', 520, { repository: '', changedFiles: '{{ $json.files }}', ...check }),
      node('after', 'After', 'core.noOp', 780, {}),
    ],
    connections: [
      { id: 'c1', type: 'main' as const, source: 'start', sourceIndex: 0, target: 'change', targetIndex: 0 },
      { id: 'c2', type: 'main' as const, source: 'change', sourceIndex: 0, target: 'check', targetIndex: 0 },
      { id: 'c3', type: 'main' as const, source: 'check', sourceIndex: 0, target: 'after', targetIndex: 0 },
    ],
  };
}

async function runFlow(id: string, changed: unknown, check: Record<string, unknown> = {}) {
  as(() => store.saveWorkflow(flow(id, changed, check)));
  setHomeProject('workflow', id, mine.id);
  const events: ExecutionEvent[] = [];
  const run = await as(() => runWorkflow({ workflow: store.getWorkflow(id)!, mode: 'manual', startNodeId: 'start', onEvent: (e) => events.push(e) }));
  const checks = events.flatMap((e) => (e.type === 'node.record' && e.record.type === 'check' ? [e.record] : []));
  const out = run.runData.check?.at(-1)?.outputs[0]?.[0]?.json as Record<string, any> | undefined;
  return { run, events, checks, out };
}

describe('Check Practices', () => {
  it('a failed required check stops the run at the step: nothing after it runs, rows and checks are recorded', async () => {
    recorded.length = 0;
    const { run, checks, out } = await runFlow('wf_block', BAD);
    expect(run.status).toBe('error');
    expect(run.error?.message).toMatch(/Required practices failed: sec\/no-secrets/);
    expect(run.error?.message).toContain('/practices/waive?practice=prc_required&execution=');
    expect(run.runData.check?.at(-1)?.error?.description).toContain('sec/no-secrets@2: pathAbsent secrets/**: changed files match secrets/** (secrets/key.txt)');
    expect(out).toBeUndefined();
    expect(run.runData.after).toBeUndefined();
    // The recommended README check fails too (no README in the change), and the other project's practice is never checked.
    expect(checks.map((c) => [c.name, c.status]).sort()).toEqual([['practice:docs/readme@2', 'warn'], ['practice:review/design@2', 'skip'], ['practice:sec/no-secrets@2', 'fail']]);
    expect(recorded.map((r) => [r.practiceId, r.kind]).sort()).toEqual([['prc_recommended', 'check-fail'], ['prc_required', 'check-fail']]);
    expect(recorded.every((r) => r.executionId === run.executionId)).toBe(true);
  });

  it('passes a clean change, and a recommended failure only warns', async () => {
    recorded.length = 0;
    const clean = await runFlow('wf_clean', GOOD);
    expect(clean.run.status).toBe('success');
    expect(clean.out).toMatchObject({ ok: true, failed: [], warned: [] });
    expect(clean.checks.map((c) => c.status).sort()).toEqual(['pass', 'pass', 'skip']);
    const warn = await runFlow('wf_warn', [{ path: 'src/a.ts', status: 'A' }]);
    expect(warn.run.status).toBe('success');
    expect(warn.out).toMatchObject({ ok: true, warned: ['docs/readme'] });
    expect(warn.run.runData.after).toBeDefined();
  });

  it('never checks a practice of another project', async () => {
    const { out } = await runFlow('wf_scope', GOOD);
    expect(out?.practices.map((p: { handle: string }) => p.handle).sort()).toEqual(['docs/readme', 'review/design', 'sec/no-secrets']);
  });

  it('after a waiver, a retry of the failed run passes with "waived"', async () => {
    const first = await runFlow('wf_waive', BAD);
    expect(first.run.status).toBe('error');
    recordApplication({ practiceId: 'prc_required', version: 2, kind: 'waived', executionId: first.run.executionId, reason: 'The key file is a fixture' });
    const retried = await startRetry(first.run.executionId, { from: 'start' });
    expect(retried).not.toBe(first.run.executionId);
    let record = store.getExecution(retried);
    for (let i = 0; i < 100 && record?.status === 'running'; i++) {
      await new Promise((r) => setTimeout(r, 50));
      record = store.getExecution(retried);
    }
    expect(record?.status).toBe('success');
    const out = record?.runData.check?.at(-1)?.outputs[0]?.[0]?.json as Record<string, any>;
    expect(out).toMatchObject({ ok: true, failed: [], waived: ['sec/no-secrets'] });
    expect(out.practices.find((p: { handle: string }) => p.handle === 'sec/no-secrets')).toMatchObject({ result: 'waived', waiver: { reason: 'The key file is a fixture' } });
    expect(record?.runData.after).toBeDefined();
  });

  const settle = async (id: string) => {
    let record = store.getExecution(id);
    for (let i = 0; i < 100 && record?.status === 'running'; i++) {
      await new Promise((r) => setTimeout(r, 50));
      record = store.getExecution(id);
    }
    return record;
  };

  it('a retry from the failed step passes with "waived"', async () => {
    const first = await runFlow('wf_waive_failed', BAD);
    recordApplication({ practiceId: 'prc_required', version: 2, kind: 'waived', executionId: first.run.executionId, reason: 'The key file is a fixture' });
    const record = await settle(await startRetry(first.run.executionId, { from: 'failed' }));
    expect(record?.status).toBe('success');
  });

  it('a waiver holds only for the failure the approver saw: a retry from the start with other files fails again', async () => {
    const first = await runFlow('wf_waive_other', BAD);
    recordApplication({ practiceId: 'prc_required', version: 2, kind: 'waived', executionId: first.run.executionId, reason: 'The key file is a fixture' });
    // Someone changes what the flow reads, then retries from the start on the current version: other files break the same practice.
    as(() => store.saveWorkflow(flow('wf_waive_other', [{ path: 'secrets/other.txt', status: 'A', added: ['z'] }])));
    const record = await settle(await startRetry(first.run.executionId, { from: 'start', version: 'current' }));
    expect(record?.status).toBe('error');
    expect(record?.runData.after).toBeUndefined();
    expect(record?.runData.check?.at(-1)?.error?.description).toContain('secrets/other.txt');
  });

  it('a waiver holds for all the files: with 12 failing, a retry that swaps file 11 or 12 fails again', async () => {
    const files = (names: number[]) => names.map((n) => ({ path: `secrets/f${n}.txt`, status: 'A', added: ['z'] }));
    const first = await runFlow('wf_waive_twelve', files([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]));
    expect(first.run.status).toBe('error');
    recordApplication({ practiceId: 'prc_required', version: 2, kind: 'waived', executionId: first.run.executionId, reason: 'The key files are fixtures' });
    as(() => store.saveWorkflow(flow('wf_waive_twelve', files([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13]))));
    const swapped = await settle(await startRetry(first.run.executionId, { from: 'start', version: 'current' }));
    expect(swapped?.status).toBe('error');
    expect(swapped?.runData.after).toBeUndefined();
    as(() => store.saveWorkflow(flow('wf_waive_twelve', files([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]))));
    const same = await settle(await startRetry(first.run.executionId, { from: 'start', version: 'current' }));
    expect(same?.status).toBe('success');
  });

  it('a waiver for another run does not count', async () => {
    recordApplication({ practiceId: 'prc_required', version: 2, kind: 'waived', executionId: 'exec_elsewhere', reason: 'Not this run' });
    const { run } = await runFlow('wf_other_run', BAD);
    expect(run.status).toBe('error');
  });

  it('reviewer verdicts block only with the option on', async () => {
    const verdicts = JSON.stringify([{ handle: 'review/design', pass: false, note: 'The design drifts from the rule' }]);
    const warns = await runFlow('wf_verdict_off', GOOD, { verdicts });
    expect(warns.run.status).toBe('success');
    expect(warns.out?.practices.find((p: { handle: string }) => p.handle === 'review/design')).toMatchObject({ result: 'fail', blocks: false, reviewer: { pass: false } });
    expect(warns.checks.find((c) => c.name === 'practice:review/design@2')?.status).toBe('warn');
    const blocks = await runFlow('wf_verdict_on', GOOD, { verdicts, options: { reviewerFailsBlock: true } });
    expect(blocks.run.status).toBe('error');
    expect(blocks.run.error?.message).toContain('review/design');
  });

  it('options narrow to the handles named, and a bad change fails the step in words', async () => {
    const some = await runFlow('wf_only', BAD, { options: { practices: 'docs/readme' } });
    expect(some.run.status).toBe('success');
    const bad = await runFlow('wf_bad', [{ path: 'a', status: 'Z' }]);
    expect(bad.run.status).toBe('error');
    expect(bad.run.error?.message).toMatch(/status of A, M or D/);
  });
});

describe('the templates', () => {
  const { BUILTIN_TEMPLATES } = templates;
  const codeOf = (id: string, nodeId: string) => (BUILTIN_TEMPLATES.find((t) => t.id === id)!.workflow.nodes.find((n) => n.id === nodeId)!.parameters as { code: string }).code;
  const runCode = async (wid: string, code: string, input: unknown, before = '') => {
    const node = (nid: string, name: string, type: string, x: number, parameters: Record<string, unknown>) => ({ id: nid, name, type, typeVersion: 1, position: [x, 0] as [number, number], parameters });
    as(() =>
      store.saveWorkflow({
        id: wid,
        name: wid,
        active: false,
        nodes: [node('start', 'Start', 'core.manualTrigger', 0, {}), node('seed', 'Seed', 'core.code', 260, { mode: 'all', language: 'javascript', code: `${before}return [{ json: ${JSON.stringify(input)} }];` }), node('under', 'Under test', 'core.code', 520, { mode: 'all', language: 'javascript', code })],
        connections: [
          { id: 'c1', type: 'main' as const, source: 'start', sourceIndex: 0, target: 'seed', targetIndex: 0 },
          { id: 'c2', type: 'main' as const, source: 'seed', sourceIndex: 0, target: 'under', targetIndex: 0 },
        ],
      }),
    );
    const run = await as(() => runWorkflow({ workflow: store.getWorkflow(wid)!, mode: 'manual', startNodeId: 'start' }));
    expect(run.error?.message).toBeUndefined();
    return run.runData.under?.at(-1)?.outputs[0]?.[0]?.json as Record<string, any>;
  };

  it('both import, name the step and validate', () => {
    for (const id of ['practices-check-pr', 'practices-blocked']) {
      const t = BUILTIN_TEMPLATES.find((x) => x.id === id)!;
      expect(t.problems).toEqual([]);
    }
    expect(BUILTIN_TEMPLATES.find((t) => t.id === 'practices-check-pr')!.workflow.nodes.map((n) => n.type)).toContain('core.practiceCheck');
  });

  it('the blocked flow names each failed practice with its three links', async () => {
    const message = 'Required practices failed: sec/no-secrets, helm/charts. Fix the change and run the flow again, or waive them for this run. Change: https://github.com/your-org/your-repo/pull/7 Waive: /practices/waive?practice=prc_a&execution=ex_1 /practices/waive?practice=prc_b&execution=ex_1';
    const out = await runCode('wf_tpl_blocked', codeOf('practices-blocked', 'name'), { execution: { url: '/workflows/w/runs/ex_1', error: { message } }, workflow: { name: 'PR check' } });
    expect(out.title).toBe('PR check: a required practice failed');
    expect(out.text).toContain('**sec/no-secrets**');
    expect(out.text).toContain('Fix: https://github.com/your-org/your-repo/pull/7');
    expect(out.text).toContain('Waive for this run: /practices/waive?practice=prc_a&execution=ex_1');
    expect(out.text).toContain('Change the practice: /brain/practices/prc_b');
  });

  it('the PR flow maps GitHub files to changed files and comments the results', async () => {
    const seed = [{ json: { path: 'a/Chart.yaml', status: 'added', patch: '@@ -0,0 +1,2 @@\n+name: a\n+version: 1' } }, { json: { path: 'new.txt', previousPath: 'old.txt', status: 'renamed', patch: null } }, { json: { path: 'gone.txt', status: 'removed' } }];
    const map = codeOf('practices-check-pr', 'map').replace("$('Pull request').all()[0].json", "{ owner: 'o', repository: 'r', pullNumber: 3 }");
    const out = await runCode('wf_tpl_map2', `items = ${JSON.stringify(seed)};\n${map}`, {});
    expect(out.repo).toBe('o/r');
    expect(out.files).toEqual([{ path: 'a/Chart.yaml', status: 'A', added: ['name: a', 'version: 1'] }, { path: 'old.txt', status: 'D' }, { path: 'new.txt', status: 'A', added: [] }, { path: 'gone.txt', status: 'D' }]);
    const text = await runCode('wf_tpl_comment', codeOf('practices-check-pr', 'write'), { checked: 2, practices: [{ handle: 'a/b', strength: 'required', result: 'pass', messages: [] }, { handle: 'c/d', strength: 'recommended', result: 'fail', messages: ['pathExists README.md: no changed file matches README.md'] }] });
    expect(text.text).toContain('- **a/b** (required): pass');
    expect(text.text).toContain('- **c/d** (recommended): warning - pathExists README.md');
  });
});

describe('judge', () => {
  const p = practice('prc_x', 'a/b', { checks: NO_SECRETS });
  const change = { files: [{ path: 'secrets/k', status: 'A' as const }], added: new Map() };
  const options = { reviewerFailsBlock: false, executionId: 'ex_1', waiverOf: (_id: string, _line: string) => undefined as { reason?: string; at: string } | undefined };
  it('fails and blocks a required failure, names the files and gives the waive link', () => {
    expect(judge(p, change, undefined, options)).toMatchObject({ result: 'fail', blocks: true, files: ['secrets/k'], waiveUrl: waiveUrlOf('prc_x', 'ex_1') });
  });
  it('a waiver turns a block into "waived"', () => {
    expect(judge(p, change, undefined, { ...options, waiverOf: () => ({ at: 'now' }) })).toMatchObject({ result: 'waived', blocks: false });
  });
  it('a practice with no check and no verdict is "no-checks"', () => {
    expect(judge(practice('prc_y', 'a/c'), change, undefined, options)).toMatchObject({ result: 'no-checks', blocks: false });
  });
});

describe('the glob table', () => {
  it('the web selector and the shared checks agree', () => {
    const table: Array<[string, string]> = [['deploy/helm/*/Chart.yaml', 'deploy/helm/web/Chart.yaml'], ['deploy/helm/*/Chart.yaml', 'deploy/helm/web/charts/Chart.yaml'], ['**/Chart.yaml', 'Chart.yaml'], ['*.md', 'docs/README.md'], ['docs/*.md', './docs/README.md'], ['src/?.ts', 'src/ab.ts'], ['charts/[a]', 'charts/[a]'], ['deploy/k8s/**/o.yaml', 'deploy/k8s/o.yaml']];
    for (const [glob, path] of table) expect(webGlob(glob, path), `${glob} ${path}`).toBe(sharedGlob(glob, path));
  });
});
