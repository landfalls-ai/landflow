/**
 * What a Run a Team node reports while it runs (lib/shared/team-progress.ts): the lead's stream folded into who works
 * now and on what, in plain words, with each member's turns and the moments that matter, the activity kept on the output,
 * and the canvas caption it makes (lib/client/node-progress.ts `progressLine`).
 */
import { describe, expect, it } from 'vitest';
import type { AgentStreamEvent, TimelineEntry } from '@/lib/shared/agents';
import { activityOfRuns, joinActivity, narrate, teamProgressFolder } from '@/lib/shared/team-progress';
import { progressDetail, progressLine } from '@/lib/client/node-progress';

const at = '2026-10-31T21:00:00.000Z';
type Step = { name: string; status: 'running' | 'success' | 'error'; args?: unknown; output?: unknown; error?: string; startedAt?: string; endedAt?: string };
const tool = (callId: string, label: string, status: 'running' | 'success' | 'error', remote?: Step[], output?: unknown): AgentStreamEvent => ({
  type: 'entry',
  sessionId: 's1',
  entry: {
    id: `e_${callId}_${status}`,
    type: 'tool',
    callId,
    tool: `ask_${label.toLowerCase()}`,
    label,
    kind: 'a2a',
    input: { message: 'build it', reason: 'the plan is ready' },
    status,
    at,
    ...(output !== undefined && { output }),
    ...(remote && { remote: { agent: label, state: 'working', steps: remote.map((s, i) => ({ id: String(i), ...s })) } }),
  } as TimelineEntry,
});
const bash = (command: string, status: Step['status'], extra: Partial<Step> = {}): Step => ({ name: 'Bash', status, args: JSON.stringify({ command }), ...extra });
const finished = { type: 'run.finished', sessionId: 's1', status: 'completed', reason: 'completed', usage: { inputTokens: 1, outputTokens: 1 } } as AgentStreamEvent;

describe('team progress', () => {
  it('follows the lead and the member it asked, with what each does', () => {
    const fold = teamProgressFolder(['Tech Lead', 'Planner', 'Developer', 'Reviewer']);
    expect(fold({ type: 'run.started', sessionId: 's1' })).toMatchObject({ member: 'Tech Lead', doing: 'thinking', plain: 'Planning the work' });

    const asked = fold(tool('c1', 'Developer', 'running'))!;
    expect(asked).toMatchObject({ member: 'Developer', doing: 'asked: the plan is ready', plain: 'Starting: the plan is ready' });
    expect(asked.team.members.find((m) => m.title === 'Tech Lead')).toMatchObject({ state: 'working', doing: 'waiting on Developer' });

    const step = fold(tool('c1', 'Developer', 'running', [bash('cd /tmp/work && pnpm test', 'running')]))!;
    expect(step).toMatchObject({ member: 'Developer', doing: 'Bash: cd /tmp/work && pnpm test', plain: 'Running the tests', command: 'cd /tmp/work && pnpm test', stepCount: 1 });
    expect(step.steps).toEqual([{ name: 'Bash', status: 'running', plain: 'Running the tests', args: 'cd /tmp/work && pnpm test' }]);
    expect(progressLine({ nodeName: 'Tech Lead', data: step as never })).toBe('Developer · Running the tests');
    expect(progressDetail({ nodeName: 'Tech Lead', data: step as never })).toBe('cd /tmp/work && pnpm test');
    // Asked once, however many reports the call sends.
    expect(step.team.members.find((m) => m.title === 'Developer')).toMatchObject({ state: 'working', asked: 1 });
    expect(step.team.members.find((m) => m.title === 'Planner')).toMatchObject({ state: 'idle', asked: 0 });
    // The lead's words while the Developer works don't take the node back.
    expect(fold({ type: 'entry', sessionId: 's1', entry: { id: 'a1', type: 'assistant', text: 'Waiting.', at } as TimelineEntry })).toBeUndefined();

    const back = fold(tool('c1', 'Developer', 'success', [bash('pnpm test', 'success')]))!;
    expect(back).toMatchObject({ member: 'Tech Lead', doing: "reading Developer's answer", plain: "Reading the Developer's answer" });
    expect(back.team.members.find((m) => m.title === 'Developer')).toMatchObject({ state: 'done' });
    // The lead's ticker: whom it asked, with how many steps.
    expect(back.steps.at(-1)).toMatchObject({ status: 'success', plain: 'Asked the Developer · 1 step' });

    expect(fold(tool('c2', 'Reviewer', 'error'))!.team.members.find((m) => m.title === 'Reviewer')).toMatchObject({ state: 'failed', asked: 1 });
    // The lead's own tool keeps the lead busy.
    expect(fold(tool('c3', 'Check branch', 'running'))).toMatchObject({ member: 'Tech Lead', doing: 'Check branch', plain: 'Check branch' });

    const end = fold(finished)!;
    expect(end.team.members.filter((m) => m.state === 'working')).toEqual([]);
    expect(end.plain).toBe('Done');
  });

  it('marks each turn and keeps the activity for the output', () => {
    let clock = 1_000;
    const fold = teamProgressFolder(['Lead', 'Reviewer'], () => clock);
    fold({ type: 'run.started', sessionId: 's1' });
    clock = 3_000;
    fold(tool('c1', 'Reviewer', 'running', [{ name: 'Read', status: 'running', args: { file_path: '/w/PLAN.md' } }]));
    clock = 9_000;
    const working = fold(tool('c1', 'Reviewer', 'running', [{ name: 'Read', status: 'success', args: { file_path: '/w/PLAN.md' } }, bash('pnpm typecheck', 'running')]))!;
    expect(working.turns).toEqual([
      { member: 'Lead', start: 0, end: 2_000 },
      { member: 'Reviewer', start: 2_000 },
    ]);
    expect(working).toMatchObject({ at: 8_000, stepCount: 2, plain: 'Type-checking' });
    clock = 12_000;
    fold(tool('c1', 'Reviewer', 'success', [{ name: 'Read', status: 'success' }, bash('pnpm typecheck', 'success')], 'All good. VERDICT: APPROVE'));
    clock = 15_000;
    fold(finished);
    const activity = fold.activity();
    expect(activity).toMatchObject({ durationMs: 14_000, steps: { Reviewer: 2 } });
    expect(activity.turns).toEqual([
      { member: 'Lead', start: 0, end: 2_000 },
      { member: 'Reviewer', start: 2_000, end: 11_000 },
      { member: 'Lead', start: 11_000, end: 14_000 },
    ]);
    expect(activity.moments.map((m) => [m.member, m.tone, m.text])).toEqual([
      ['Lead', 'info', 'Asked the Reviewer'],
      ['Reviewer', 'ok', 'Typecheck passed'],
      ['Reviewer', 'ok', 'Reviewer: approve'],
    ]);
    // A finished node reads it back from its output, Done or Needs a person.
    expect(activityOfRuns([{ outputs: [[], [{ json: { reply: 'x', activity } }]] }])).toEqual(activity);
    expect(activityOfRuns([{ outputs: [[{ json: { reply: 'older run' } }]] }])).toBeUndefined();
    expect(activityOfRuns(undefined)).toBeUndefined();
  });

  it('makes a moment once per finished step that matters', () => {
    const fold = teamProgressFolder(['Lead', 'Developer']);
    fold({ type: 'run.started', sessionId: 's1' });
    const failing = bash('cd /tmp/work && pnpm --filter x test', 'error', { error: 'Exit code 1' });
    fold(tool('c1', 'Developer', 'running', [failing]));
    // Reported again with more steps: the failure is not repeated.
    fold(tool('c1', 'Developer', 'running', [failing, bash('pnpm test', 'success', { output: 'Tests  14 passed (14)' })]));
    const report = fold(tool('c1', 'Developer', 'running', [failing, bash('pnpm test', 'success', { output: 'Tests  14 passed (14)' }), bash('gh pr create --fill', 'success', { output: 'https://github.com/o/r/pull/4' })]))!;
    expect(report.moments.map((m) => m.text)).toEqual(['Asked the Developer', 'Tests failed · exit 1', '14 tests pass', 'Pull request #4 opened']);
    expect(report.moments.find((m) => m.text.startsWith('Tests failed'))).toMatchObject({ member: 'Developer', tone: 'bad' });
    const back = fold(tool('c1', 'Developer', 'success', undefined, 'VERDICT: REQUEST_CHANGES: the README is missing'))!;
    expect(back.moments.at(-1)).toMatchObject({ member: 'Developer', tone: 'bad', text: 'Developer asks for changes' });
    const failed = fold(tool('c2', 'Developer', 'error'))!;
    expect(failed.moments.at(-1)).toMatchObject({ tone: 'bad', text: 'Developer failed' });
  });

  it('follows a member that asks its own reports, from its own stream', () => {
    const fold = teamProgressFolder(['Tech Lead', 'Developer', 'Tester']);
    fold({ type: 'run.started', sessionId: 's1' });
    fold(tool('c1', 'Developer', 'running'));
    // The Developer's own loop: its run starts inside the lead's call, then a tool of its own.
    expect(fold({ type: 'run.started', sessionId: 's2' }, 'Developer')).toBeUndefined();
    const own = fold({ type: 'entry', sessionId: 's2', entry: { id: 'e_r', type: 'tool', callId: 'r1', tool: 'read_file', label: 'Read', kind: 'node', input: { path: 'src/main.ts' }, status: 'running', at } as TimelineEntry }, 'Developer')!;
    expect(own).toMatchObject({ member: 'Developer', doing: 'Read', command: 'src/main.ts' });
    // It asks the Tester: the Tester works, the Developer waits on it.
    const nested = fold(tool('t1', 'Tester', 'running', [bash('pnpm test', 'running')]), 'Developer')!;
    expect(nested).toMatchObject({ member: 'Tester', plain: 'Running the tests' });
    expect(nested.team.members.find((m) => m.title === 'Developer')).toMatchObject({ state: 'working', doing: 'waiting on Tester' });
    expect(nested.moments.at(-1)).toMatchObject({ member: 'Developer', text: 'Developer asked the Tester' });
    // The lead's call to the Developer, reported again, doesn't take the view from the Tester.
    expect(fold(tool('c1', 'Developer', 'running'))).toBeUndefined();
    const back = fold(tool('t1', 'Tester', 'success', [bash('pnpm test', 'success', { output: 'Tests  3 passed (3)' })]), 'Developer')!;
    expect(back).toMatchObject({ member: 'Developer', plain: "Reading the Tester's answer" });
    expect(fold({ type: 'run.finished', sessionId: 's2', status: 'completed', reason: 'completed', usage: { inputTokens: 1, outputTokens: 1 } } as AgentStreamEvent, 'Developer')).toBeUndefined();
    const done = fold(tool('c1', 'Developer', 'success', undefined, 'Built it; the Tester says 3 tests pass.'))!;
    expect(done).toMatchObject({ member: 'Tech Lead', plain: "Reading the Developer's answer" });
    expect(fold.activity().turns.map((t) => t.member)).toEqual(['Tech Lead', 'Developer', 'Tester', 'Developer', 'Tech Lead']);
    expect(fold.activity().steps).toMatchObject({ Developer: 1, Tester: 1 });
  });

  it('keeps each member’s tokens against its budget, with a moment at 80% and once used up', () => {
    const fold = teamProgressFolder(['Lead', 'Developer', 'Reviewer'], Date.now, { budgets: { Developer: 10_000, Nobody: 5 } });
    fold({ type: 'run.started', sessionId: 's1' });
    // The lead has no budget: its tokens show, without a bar.
    expect(fold.usage('Lead', 1_200)!.usage).toEqual([{ member: 'Lead', tokens: 1_200 }, { member: 'Developer', tokens: 0, budget: 10_000 }]);
    // The same again changes nothing.
    expect(fold.usage('Lead', 1_200)).toBeUndefined();
    expect(fold.usage('Developer', 5_000)!.moments.filter((m) => m.tone !== 'info')).toEqual([]);
    const near = fold.usage('Developer', 8_100)!;
    expect(near.moments.at(-1)).toMatchObject({ member: 'Developer', tone: 'warn', text: 'Developer used 80% of its budget' });
    expect(near.usage?.find((u) => u.member === 'Developer')).toEqual({ member: 'Developer', tokens: 8_100, budget: 10_000 });
    // Once per level: more tokens under the budget make no second moment.
    expect(fold.usage('Developer', 9_000)!.moments.filter((m) => m.tone === 'warn')).toHaveLength(1);
    expect(fold.usage('Developer', 10_400)!.moments.at(-1)).toMatchObject({ tone: 'bad', text: 'Developer used up its budget' });
    // A remote member that reports nothing is estimated.
    expect(fold.usage('Reviewer', 300, true)!.usage?.find((u) => u.member === 'Reviewer')).toEqual({ member: 'Reviewer', tokens: 300, estimated: true });
    expect(fold.activity().usage).toEqual([
      { member: 'Lead', tokens: 1_200 },
      { member: 'Developer', tokens: 10_400, budget: 10_000 },
      { member: 'Reviewer', tokens: 300, estimated: true },
    ]);
  });

  it('marks the question the run waits on, and carries the usage on after the answer', () => {
    let clock = 0;
    const fold = teamProgressFolder(['Lead', 'Developer'], () => clock, { budgets: { Developer: 1_000 } });
    fold({ type: 'run.started', sessionId: 's1' });
    fold.usage('Developer', 850);
    clock = 4_000;
    const waiting = fold.waiting('developer', 'Developer asks:\n- Which branch should I use?');
    expect(waiting).toMatchObject({ member: 'Developer', plain: 'Waiting for a person’s answer', waiting: { member: 'Developer', question: 'Developer asks:\n- Which branch should I use?' } });
    expect(waiting.moments.at(-1)).toMatchObject({ member: 'Developer', tone: 'warn', text: 'Developer asks a person', question: 'Developer asks:\n- Which branch should I use?', at: 4_000 });
    const before = fold.activity();
    // The run goes on after the answer: a new fold that starts from what was used, so 80% isn't told twice.
    const after = teamProgressFolder(['Lead', 'Developer'], () => clock, { budgets: { Developer: 1_000 }, usage: before.usage });
    after({ type: 'run.started', sessionId: 's1' });
    expect(after.usage('Developer', 900)!.moments.filter((m) => m.tone === 'warn')).toEqual([]);
    expect(after.usage('Developer', 1_000)!.moments.at(-1)).toMatchObject({ tone: 'bad' });
    const joined = joinActivity(before, after.activity());
    expect(joined.usage).toEqual([{ member: 'Developer', tokens: 1_000, budget: 1_000 }]);
    expect(joined.moments.map((m) => m.text)).toContain('Developer asks a person');
  });

  it('ignores what says nothing about who works', () => {
    const fold = teamProgressFolder(['Lead', 'Helper']);
    expect(fold({ type: 'entry', sessionId: 's1', entry: { id: 'u', type: 'user', text: 'hi', at } })).toBeUndefined();
  });
});

describe('plain words for steps', () => {
  const words = (name: string, args?: unknown) => narrate(name, args);
  it('reads shell commands by what the chain ends with', () => {
    expect(words('Bash', { command: "cd /tmp/work && pnpm --filter '@landflow/plugin-grafana' test" })).toEqual({ plain: 'Running the tests', kind: 'test' });
    expect(words('Bash', { command: 'cd /tmp/work && pnpm install --ignore-scripts --no-frozen-lockfile' })).toEqual({ plain: 'Installing dependencies', kind: 'install' });
    expect(words('Bash', { command: 'pnpm install && pnpm typecheck' })).toEqual({ plain: 'Type-checking', kind: 'typecheck' });
    expect(words('Bash', { command: 'go test ./...' }).plain).toBe('Running the tests');
    expect(words('Bash', { command: 'python -m pytest -q' }).plain).toBe('Running the tests');
    expect(words('Bash', { command: 'git commit -m "x"' })).toEqual({ plain: 'Committing', kind: 'commit' });
    expect(words('Bash', { command: 'git push -u origin feat' })).toEqual({ plain: 'Pushing the branch', kind: 'push' });
    expect(words('Bash', { command: 'gh pr create --fill' })).toEqual({ plain: 'Opening a pull request', kind: 'pr' });
    expect(words('Bash', { command: 'gh pr merge 4 --squash' })).toEqual({ plain: 'Merging the pull request', kind: 'merge' });
    expect(words('Bash', { command: 'git clone https://github.com/o/r /tmp/work' }).plain).toBe('Cloning the repository');
    expect(words('Bash', { command: 'cd /tmp/work && ls -la plugins/grafana' }).plain).toBe('Looking around grafana');
    // A pipeline is read by its first stage, and find by its path.
    expect(words('Bash', { command: "cd /tmp/work && find . -name '*.ts' | head -20" }).plain).toBe('Looking around work');
    expect(words('Bash', { command: 'find plugins/grafana/src -type f' }).plain).toBe('Looking around src');
    expect(words('Bash', { command: 'ls' }).plain).toBe('Looking around the files');
    expect(words('Bash', { command: 'pnpm test 2>&1 | tail -30' }).plain).toBe('Running the tests');
    expect(words('Bash', { command: 'cat /tmp/work/plugins/grafana/PLAN.md' }).plain).toBe('Reading PLAN.md');
    expect(words('Bash', { command: 'node scripts/x.js' }).plain).toBe('Running node');
    // Progress carries arguments as JSON text.
    expect(words('Bash', JSON.stringify({ command: 'pnpm lint' })).plain).toBe('Linting');
  });

  it('reads file, search and web tools, and falls back to the tool name', () => {
    expect(words('Read', { file_path: '/tmp/work/plugins/grafana/src/nodes/get-alerts.ts' }).plain).toBe('Reading get-alerts.ts');
    expect(words('Edit', { file_path: '/w/README.md' }).plain).toBe('Editing README.md');
    expect(words('Write', { file_path: '/w/src/index.ts' }).plain).toBe('Editing index.ts');
    expect(words('Grep', { pattern: 'definePlugin' }).plain).toBe('Searching for definePlugin');
    expect(words('WebFetch', { url: 'https://grafana.com/docs/x' }).plain).toBe('Reading grafana.com');
    expect(words('WebSearch', { query: 'alertmanager api' }).plain).toBe('Searching the web');
    expect(words('TodoWrite', {}).plain).toBe('Updating the to-do list');
    expect(words('check_branch').plain).toBe('Check branch');
    expect(words('mcp__github__createPullRequest').plain).toBe('Create pull request');
  });
});
