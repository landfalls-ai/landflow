/** Code changes folded from a run-2-shaped journal: three agents, one clone root, pushes that carry only some files. */
import { describe, expect, it } from 'vitest';
import type { JournalEvent, RunActor } from '../src/lib/shared/run-trace';
import { compareWithBranch, diffHunks, foldChanges, parsePatchHunks, unifiedPatch, type BranchChanges } from '../src/lib/shared/run-changes';
import { branchOf, linkRefs, repoOf } from '../src/lib/shared/run-repo';

const planner: RunActor = { id: 'remote:Planner', name: 'Planner', type: 'agent' };
const developer: RunActor = { id: 'remote:Developer', name: 'Developer', type: 'agent' };
const reviewer: RunActor = { id: 'remote:Reviewer', name: 'Reviewer', type: 'agent' };

/** A journal built one tool step at a time: seq counts up, every step starts and ends. */
function journal() {
  const events: JournalEvent[] = [];
  let seq = 0;
  const tool = (actor: RunActor, name: string, input: unknown, status: 'success' | 'error' = 'success', output: unknown = { result: 'ok' }) => {
    const n = Math.ceil(seq / 2) + 1;
    const spanId = `node:${actor.name}:0/step:${n}`;
    const at = new Date(Date.UTC(2026, 9, 31, 15, 0, seq)).toISOString();
    events.push({ seq: ++seq, executionId: 'ex_t', at, spanId, type: 'span.started', parentSpanId: `node:${actor.name}:0`, kind: 'tool', name, actor, input });
    events.push({ seq: ++seq, executionId: 'ex_t', at, spanId, type: 'span.ended', status, output });
    return spanId;
  };
  return { events, tool };
}

const NODE = (extra = '') => `import type { A } from '@landflow/sdk';\nimport { fetch } from 'undici';\n\nexport async function execute(ctx: A) {\n  const alerts = await response.json();\n  return alerts;\n}\n${extra}`;
const clone = (actor: RunActor, t: ReturnType<typeof journal>['tool']) =>
  t(actor, 'Bash', { command: 'rm -rf /tmp/work && git clone -q --filter=blob:none https://github.com/acme/widgets /tmp/work && cd /tmp/work && git checkout -q agents/x-1' });

function run2() {
  const { events, tool } = journal();
  // Planner: five source files and the plan; commits only the plan (the first attempt fails: no identity).
  clone(planner, tool);
  for (const f of ['package.json', 'src/main.ts', 'src/nodes/get-alerts.ts']) tool(planner, 'Write', { file_path: `/tmp/work/plugins/grafana/${f}`, content: f === 'src/nodes/get-alerts.ts' ? NODE() : `// ${f}\n` });
  tool(planner, 'Write', { file_path: '/tmp/work/plugins/grafana/PLAN.md', content: '# Plan\n\n- build it\n' });
  tool(planner, 'Bash', { command: 'cd /tmp/work && git add plugins/grafana/PLAN.md && git commit -qm "plan" && git push -q origin HEAD:agents/x-1' }, 'error', { result: 'Author identity unknown' });
  tool(planner, 'Bash', { command: 'cd /tmp/work && git config user.name P && git add plugins/grafana/PLAN.md && git commit -qm "plan" && git push -q origin HEAD:agents/x-1' });
  // Agent notes are not code changes.
  tool(planner, 'Write', { file_path: '/tmp/work/MEMORY.md', content: '- notes\n' });
  tool(planner, 'Write', { file_path: '/tmp/work/memory/plan.md', content: 'notes\n' });
  // Developer: rewrites two files, edits one, commits everything under plugins/grafana and pushes.
  clone(developer, tool);
  tool(developer, 'Write', { file_path: '/tmp/work/plugins/grafana/package.json', content: '{ "name": "grafana" }\n' });
  tool(developer, 'Write', { file_path: '/tmp/work/plugins/grafana/src/nodes/get-alerts.ts', content: NODE() });
  tool(developer, 'Write', { file_path: '/tmp/work/plugins/grafana/test/get-alerts.test.ts', content: "import { it } from 'vitest';\nit('works', () => {});\n" });
  tool(developer, 'Edit', { file_path: '/tmp/work/plugins/grafana/test/get-alerts.test.ts', old_string: "it('works', () => {});", new_string: "it('works', () => { expect(1).toBe(1); });" });
  tool(developer, 'Bash', { command: 'cd /tmp/work && git add plugins/grafana pnpm-lock.yaml && git commit -qm "grafana plugin" && git push -q origin HEAD:agents/x-1' }, 'success', { result: '[agents/x-1 0039ded] grafana plugin' });
  // Reviewer: edits the node file twice with the WHOLE file as old_string, never commits.
  clone(reviewer, tool);
  const fixed = NODE().replace('async function execute(ctx: A)', 'async function execute(ctx: A): Promise<A[]>');
  tool(reviewer, 'Edit', { file_path: '/tmp/work/plugins/grafana/src/nodes/get-alerts.ts', old_string: NODE(), new_string: fixed });
  tool(reviewer, 'Edit', { file_path: '/tmp/work/plugins/grafana/src/nodes/get-alerts.ts', old_string: fixed, new_string: fixed.replace('await response.json();', 'await response.json() as unknown;') });
  tool(reviewer, 'Write', { file_path: '/data/claude/projects/-data-workspace/memory/review.md', content: 'notes\n' });
  return events;
}

describe('foldChanges', () => {
  const changes = foldChanges(run2());
  const file = (path: string) => changes.files.find((f) => f.path === path)!;

  it('lists one entry per file under the clone root and leaves agent notes out', () => {
    expect(changes.files.map((f) => f.path)).toEqual([
      'plugins/grafana/PLAN.md',
      'plugins/grafana/package.json',
      'plugins/grafana/src/main.ts',
      'plugins/grafana/src/nodes/get-alerts.ts',
      'plugins/grafana/test/get-alerts.test.ts',
    ]);
    expect(changes.agents.map((a) => a.name)).toEqual(['Planner', 'Developer', 'Reviewer']);
  });

  it('keeps each agent’s changes in order, with the file’s combined before and after', () => {
    const node = file('plugins/grafana/src/nodes/get-alerts.ts');
    expect(node.changes.map((c) => `${c.actor.name} ${c.kind}`)).toEqual(['Planner write', 'Developer write', 'Reviewer edit', 'Reviewer edit']);
    expect(node.partial).toBe(false);
    expect(node.before).toBe('');
    expect(node.created).toBe(true);
    expect(node.after).toContain('Promise<A[]>');
    expect(node.after).toContain('as unknown');
    expect(node.actors.map((a) => [a.actor.name, a.writes, a.edits])).toEqual([['Planner', 1, 0], ['Developer', 1, 0], ['Reviewer', 0, 2]]);
  });

  it('diffs a write against the last known content of the path: the same text is no change', () => {
    const [planned, written] = file('plugins/grafana/src/nodes/get-alerts.ts').changes;
    expect(planned).toMatchObject({ created: true, deletions: 0, additions: 7 });
    expect(written).toMatchObject({ created: false, additions: 0, deletions: 0 });
  });

  it('diffs a whole-file Edit line by line', () => {
    const [, , first, second] = file('plugins/grafana/src/nodes/get-alerts.ts').changes;
    expect(first).toMatchObject({ partial: false, additions: 1, deletions: 1 });
    expect(second).toMatchObject({ additions: 1, deletions: 1 });
    expect(diffHunks(first.before, first.after)[0].lines.filter((l) => l.type !== 'ctx').map((l) => `${l.type}:${l.text}`)).toEqual([
      'del:export async function execute(ctx: A) {',
      'add:export async function execute(ctx: A): Promise<A[]> {',
    ]);
  });

  it('counts the plus and minus lines of a file and builds a unified patch', () => {
    const test = file('plugins/grafana/test/get-alerts.test.ts');
    expect(test).toMatchObject({ additions: 2, deletions: 0, created: true });
    expect(test.patch).toContain('--- /dev/null\n+++ b/plugins/grafana/test/get-alerts.test.ts');
    expect(test.patch).toContain("+it('works', () => { expect(1).toBe(1); });");
    expect(file('plugins/grafana/src/nodes/get-alerts.ts')).toMatchObject({ additions: 7, deletions: 0 });
  });

  it('marks a change pushed only when the same agent committed the file and a push followed', () => {
    const state = (path: string) => file(path).changes.map((c) => `${c.actor.name}:${c.pushed ? 'pushed' : 'never'}`);
    expect(state('plugins/grafana/PLAN.md')).toEqual(['Planner:pushed']);
    // The Planner's other files were never committed; the Developer's commit named the whole folder.
    expect(state('plugins/grafana/src/main.ts')).toEqual(['Planner:never']);
    expect(state('plugins/grafana/package.json')).toEqual(['Planner:never', 'Developer:pushed']);
    expect(state('plugins/grafana/src/nodes/get-alerts.ts')).toEqual(['Planner:never', 'Developer:pushed', 'Reviewer:never', 'Reviewer:never']);
    expect(file('plugins/grafana/test/get-alerts.test.ts').changes.map((c) => c.commit)).toEqual(['0039ded', '0039ded']);
    expect(file('plugins/grafana/src/nodes/get-alerts.ts')).toMatchObject({ delivery: 'some', pushed: 1, notPushed: 3 });
    expect(file('plugins/grafana/test/get-alerts.test.ts').delivery).toBe('all');
    expect(file('plugins/grafana/src/main.ts').delivery).toBe('none');
    expect(changes).toMatchObject({ changes: 10, notPushed: 5 });
  });

  it('treats a failed push, a push before the change and a commit -a differently', () => {
    const { events, tool } = journal();
    tool(planner, 'Write', { file_path: '/tmp/work/a.ts', content: 'a\n' });
    tool(planner, 'Bash', { command: 'cd /tmp/work && git add a.ts && git commit -qm a && git push -q origin HEAD' }, 'error');
    tool(planner, 'Write', { file_path: '/tmp/work/b.ts', content: 'b\n' });
    tool(planner, 'Bash', { command: 'git push -q origin HEAD' });
    tool(planner, 'Write', { file_path: '/tmp/work/c.ts', content: 'c\n' });
    tool(planner, 'Bash', { command: 'cd /tmp/work && git commit -am c && git push' });
    tool(developer, 'Write', { file_path: '/tmp/work/d.ts', content: 'd\n' });
    tool(planner, 'Bash', { command: 'cd /tmp/work && git add -A && git commit -qm all && git push' });
    const delivery = Object.fromEntries(foldChanges(events).files.map((f) => [f.path, f.delivery]));
    // a: its push failed. b: pushed with nothing committed. c: carried by commit -a. d: another agent's push does not count.
    expect(delivery).toEqual({ 'a.ts': 'all', 'b.ts': 'all', 'c.ts': 'all', 'd.ts': 'none' });
  });

  it('places an Edit in the file the run showed; otherwise the fragments stand for it', () => {
    const { events, tool } = journal();
    tool(developer, 'Edit', { file_path: '/tmp/work/src/x.ts', old_string: 'const a = 1;', new_string: 'const a = 2;' });
    tool(developer, 'Write', { file_path: '/tmp/work/src/y.ts', content: 'one\ntwo\nthree\n' });
    tool(developer, 'Edit', { file_path: '/tmp/work/src/y.ts', old_string: 'two', new_string: 'TWO' });
    tool(developer, 'Edit', { file_path: '/tmp/work/src/y.ts', old_string: 'absent', new_string: 'x' });
    tool(developer, 'Edit', { file_path: '/tmp/work/src/z.ts', old_string: 'a', new_string: 'b' }, 'error');
    const out = foldChanges(events);
    const x = out.files.find((f) => f.path === 'src/x.ts')!;
    expect(x).toMatchObject({ partial: true, additions: 1, deletions: 1 });
    expect(x.before).toBeUndefined();
    expect(x.patch).toContain('-const a = 1;');
    const y = out.files.find((f) => f.path === 'src/y.ts')!;
    expect(y.changes.map((c) => c.partial)).toEqual([false, false, true]);
    expect(out.files.some((f) => f.path === 'src/z.ts')).toBe(false);
  });

  it('applies the edits of a MultiEdit in order', () => {
    const { events, tool } = journal();
    tool(developer, 'Write', { file_path: '/tmp/work/m.ts', content: 'a\nb\nc\n' });
    tool(developer, 'MultiEdit', { file_path: '/tmp/work/m.ts', edits: [{ old_string: 'a', new_string: 'A' }, { old_string: 'c', new_string: 'C' }] });
    const m = foldChanges(events).files[0];
    expect(m.after).toBe('A\nb\nC\n');
    expect(m.changes).toHaveLength(3);
  });

  it('gives a path outside every clone root as it is, and an empty run no files', () => {
    const { events, tool } = journal();
    tool(developer, 'Write', { file_path: '/srv/other/readme.md', content: '# hi\n' });
    expect(foldChanges(events).files[0].path).toBe('/srv/other/readme.md');
    expect(foldChanges([])).toEqual({ git: false, files: [], agents: [], changes: 0, notPushed: 0 });
    // Without git in the run there is nothing to push to.
    expect(foldChanges(events).git).toBe(false);
    expect(foldChanges(run2()).git).toBe(true);
  });

  it('flags tool input the journal cut', () => {
    const { events, tool } = journal();
    tool(developer, 'Write', { file_path: '/tmp/work/big.ts', content: `${'x\n'.repeat(10)}…[cut]` });
    expect(foldChanges(events).files[0].changes[0].truncated).toBe(true);
  });

  it('reads tool input a remote agent sent as JSON text', () => {
    const asText = run2().map((e) => (e.type === 'span.started' ? { ...e, input: JSON.stringify(e.input) } : e));
    expect(foldChanges(asText)).toEqual(changes);
  });
});

describe('patches', () => {
  it('parses GitHub’s patch text into numbered lines', () => {
    const [hunk] = parsePatchHunks('@@ -3,2 +3,3 @@ function x\n keep\n-old\n+new\n+more');
    expect(hunk.lines).toEqual([
      { type: 'ctx', text: 'keep', oldNo: 3, newNo: 3 },
      { type: 'del', text: 'old', oldNo: 4 },
      { type: 'add', text: 'new', newNo: 4 },
      { type: 'add', text: 'more', newNo: 5 },
    ]);
  });

  it('writes no patch for identical text', () => {
    expect(unifiedPatch('a.ts', 'same\n', 'same\n')).toBe('');
  });
});

describe('branch', () => {
  const branch: BranchChanges = {
    base: 'main',
    head: 'agents/x-1',
    status: 'ahead',
    aheadBy: 2,
    behindBy: 0,
    totalCommits: 2,
    url: null,
    truncated: false,
    files: [
      { path: 'plugins/grafana/PLAN.md', status: 'added', additions: 3, deletions: 0 },
      { path: 'plugins/grafana/package.json', status: 'added', additions: 1, deletions: 0 },
      { path: 'pnpm-lock.yaml', status: 'modified', additions: 5, deletions: 0 },
    ],
  };

  it('says which of the run’s files are on the branch, which are not and what the branch holds besides', () => {
    const out = compareWithBranch(foldChanges(run2()), branch);
    expect(out.byPath.get('plugins/grafana/PLAN.md')?.onBranch).toBe(true);
    expect(out.byPath.get('plugins/grafana/src/main.ts')?.onBranch).toBe(false);
    expect(out.missing).toEqual(['plugins/grafana/src/main.ts', 'plugins/grafana/src/nodes/get-alerts.ts', 'plugins/grafana/test/get-alerts.test.ts']);
    expect(out.others.map((f) => f.path)).toEqual(['pnpm-lock.yaml']);
  });
});

describe('repository of a run', () => {
  const events = run2();
  const out = (output: unknown, nodeType = 'github.github', spanId = 'node:pr:0'): JournalEvent[] => [
    { seq: 900, executionId: 'ex_t', at: '2026-10-31T16:00:00Z', spanId, type: 'span.started', kind: 'step', name: 'PR', actor: { id: 'workflow', name: 'Flow', type: 'system' }, attrs: { nodeType } },
    { seq: 901, executionId: 'ex_t', at: '2026-10-31T16:00:01Z', spanId, type: 'span.ended', status: 'success', output },
  ];

  it('finds the repository in clone commands and the branch in a pull request’s output', () => {
    expect(repoOf(events)).toEqual({ owner: 'acme', repo: 'widgets', url: 'https://github.com/acme/widgets' });
    expect(branchOf(events)).toEqual({ branch: 'agents/x-1' });
    expect(branchOf([...events, ...out({ number: 2, head: 'agents/x-1', base: 'main', url: 'https://github.com/acme/widgets/pull/2' })])).toEqual({ branch: 'agents/x-1', base: 'main', pullNumber: 2 });
    expect(repoOf(out({ url: 'https://github.com/acme/other/pull/2' }), { owner: 'acme', repo: 'widgets' })?.repo).toBe('widgets');
    expect(repoOf([])).toBeUndefined();
  });

  it('links commits, pull requests and the run’s branch, and nothing else', () => {
    const repo = { owner: 'acme', repo: 'widgets', url: 'https://github.com/acme/widgets', branch: 'agents/x-1', base: 'main' };
    const parts = linkRefs('Pushed 0039ded to agents/x-1 (PR #2); main is fine, so is 1234567 and decade.', repo);
    expect(parts.filter((p) => 'href' in p)).toEqual([
      { text: '0039ded', href: 'https://github.com/acme/widgets/commit/0039ded' },
      { text: 'agents/x-1', href: 'https://github.com/acme/widgets/tree/agents/x-1' },
      { text: '#2', href: 'https://github.com/acme/widgets/pull/2' },
    ]);
    expect(parts.map((p) => p.text).join('')).toBe('Pushed 0039ded to agents/x-1 (PR #2); main is fine, so is 1234567 and decade.');
  });
});
