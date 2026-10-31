/**
 * The Run report's built-in checks and report (lib/shared/run-report.ts) over a journal shaped like the Grafana build
 * (run 2): the Developer says typecheck passes while its last typecheck failed, the Reviewer edits files, pushes nothing
 * and approves with a failing typecheck.
 */
import { describe, expect, it } from 'vitest';
import type { JournalEvent, RunActor } from '@/lib/shared/run-trace';
import { RUN_PROFILES, resolveRunProfile } from '@/lib/shared/run-profiles';
import { buildRunReport, gitAdded, replyParts, runChecks } from '@/lib/shared/run-report';
import { foldJournal } from '@/lib/shared/run-trace-model';

const T0 = Date.parse('2026-10-31T15:52:10.000Z');
const at = (s: number) => new Date(T0 + s * 1000).toISOString();

const flow: RunActor = { id: 'workflow', type: 'system', name: 'Build a plugin' };
const lead: RunActor = { id: 'node:lead', type: 'agent', name: 'Tech Lead' };
const developer: RunActor = { id: 'remote:developer', type: 'agent', name: 'Developer' };
const reviewer: RunActor = { id: 'remote:reviewer', type: 'agent', name: 'Reviewer', role: 'Reviews the change' };

function run2(): JournalEvent[] {
  let seq = 0;
  let clock = 0;
  const events: JournalEvent[] = [];
  const add = (e: Record<string, unknown>, step = 1) => {
    clock += step;
    events.push({ seq: ++seq, executionId: 'ex_run2', at: at(clock), ...e } as JournalEvent);
  };
  let n = 0;
  /** A remote agent's tool call that ends with `status`. */
  const tool = (parent: string, actor: RunActor, name: string, command: string | undefined, status: 'success' | 'error') => {
    const spanId = `${parent}/step:${++n}`;
    add({ type: 'span.started', spanId, parentSpanId: parent, kind: 'tool', name, actor, ...(command && { input: { command } }) });
    add({ type: 'span.ended', spanId, status, ...(status === 'error' ? { error: 'Exit code 2' } : { output: 'ok' }) }, 5);
  };
  add({ type: 'span.started', spanId: 'run', kind: 'run', name: 'Build a plugin', actor: flow }, 0);
  add({ type: 'span.started', spanId: 'node:lead:0', parentSpanId: 'run', kind: 'agent', name: 'Tech Lead', actor: lead });

  const dev = 'node:developer:0';
  add({ type: 'span.started', spanId: dev, parentSpanId: 'node:lead:0', kind: 'delegate', name: 'Developer', actor: developer, caller: lead, input: { message: 'Build the plugin' } });
  tool(dev, developer, 'Write', undefined, 'success');
  tool(dev, developer, 'Bash', 'cd /tmp/work && pnpm typecheck', 'error');
  tool(dev, developer, 'Bash', 'cd /tmp/work && pnpm typecheck', 'error');
  tool(dev, developer, 'Bash', 'pnpm --filter @landflow/plugin-grafana test', 'error');
  tool(dev, developer, 'Edit', undefined, 'success');
  tool(dev, developer, 'Bash', 'pnpm --filter @landflow/plugin-grafana test', 'success');
  tool(dev, developer, 'Bash', 'git push origin HEAD', 'success');
  add({ type: 'span.ended', spanId: dev, status: 'success', output: 'Implemented the Grafana plugin. Typecheck passes and all tests pass. Pushed 0039ded.' });

  const rev = 'node:reviewer:0';
  add({ type: 'span.started', spanId: rev, parentSpanId: 'node:lead:0', kind: 'delegate', name: 'Reviewer', actor: reviewer, caller: lead, input: { message: 'Review the branch' } });
  tool(rev, reviewer, 'Bash', 'pnpm typecheck', 'error');
  tool(rev, reviewer, 'Edit', undefined, 'success');
  tool(rev, reviewer, 'Edit', undefined, 'success');
  tool(rev, reviewer, 'Bash', 'pnpm typecheck', 'error');
  add({ type: 'span.ended', spanId: rev, status: 'success', output: 'Looks good to me, approved.' });

  add({ type: 'span.ended', spanId: 'node:lead:0', status: 'success', output: 'The plugin is built and reviewed.' });
  add({ type: 'span.started', spanId: 'node:pr:0', parentSpanId: 'run', kind: 'step', name: 'Open draft PR', actor: flow });
  add({ type: 'artifact', spanId: 'node:pr:0', artifact: { name: 'PR #2: Grafana plugin', kind: 'pull_request', url: 'https://github.com/o/r/pull/2' } });
  add({ type: 'span.ended', spanId: 'node:pr:0', status: 'success', output: { number: 2 } });
  add({ type: 'span.ended', spanId: 'run', status: 'success' });
  return events;
}

describe('run report checks', () => {
  const model = foldJournal(run2());

  it('sets claims against the latest matching step', () => {
    const { claims } = runChecks(model, RUN_PROFILES.software);
    const dev = claims.filter((c) => c.actor.id === developer.id);
    expect(dev.map((c) => [c.rule?.id, c.verdict])).toEqual([
      ['typecheck', 'contradicted'],
      ['pushed', 'proven'],
    ]);
    // "Typecheck passes and all tests pass." is one sentence: it matches the typecheck rule first.
    expect(dev.every((c) => c.extracted)).toBe(true);
  });

  it('finds the role breach, the undelivered edits, the problem signed off and the hidden failures', () => {
    const { checks } = runChecks(model, RUN_PROFILES.software);
    const failed = checks.filter((c) => c.status === 'fail');
    const by = (check: string) => failed.filter((c) => c.check === check).map((c) => c.subject);
    expect(by('claims')).toEqual(['Developer']);
    expect(by('roles')).toEqual(['Reviewer']);
    expect(by('unfinished')).toEqual(['Reviewer']);
    expect(by('sent_back')).toEqual(['Reviewer']);
    expect(by('hidden').sort()).toEqual(['Developer', 'Reviewer']);
    // The Developer's failing tests were redone and passed: not a hidden failure; its push delivered its edits.
    expect(checks.find((c) => c.check === 'unfinished' && c.subject === 'Developer')?.status).toBe('pass');
    expect(failed.find((c) => c.check === 'sent_back')?.message).toContain('still signed the work off');
  });

  it('builds the report with the profile’s words, who called whom and what should happen next', () => {
    const report = buildRunReport(model, RUN_PROFILES.software, { title: 'Grafana plugin build' });
    expect(report.verdict).toBe('fail');
    expect(report.label).toBe('Not ready to merge');
    expect(report.calls).toEqual([
      { from: 'Tech Lead', to: 'Developer', count: 1 },
      { from: 'Tech Lead', to: 'Reviewer', count: 1 },
    ]);
    expect(report.artifacts[0]).toMatchObject({ name: 'PR #2: Grafana plugin', kind: 'pull_request' });
    expect(report.problems[0]).toMatchObject({ text: 'Failing: Bash: pnpm typecheck', foundBy: reviewer });
    expect(report.next.length).toBeGreaterThan(3);
    expect(report.markdown).toContain('## Grafana plugin build');
    expect(report.markdown).toContain('✗ **Role rules: Reviewers only read (Reviewer)**');
    expect(report.markdown).toContain('[PR #2: Grafana plugin](https://github.com/o/r/pull/2)');
  });

  it('needs no profile for the generic checks', () => {
    const report = buildRunReport(model, resolveRunProfile(undefined));
    expect(report.profile.id).toBe('generic');
    expect(report.claims).toEqual([]);
    expect(report.checks.filter((c) => c.status === 'fail').map((c) => `${c.check}:${c.subject}`)).toEqual(['hidden:Developer', 'hidden:Reviewer']);
    expect(report.label).toBe('Needs attention');
  });

  it('accepts a failed check a person settled as accepted', () => {
    const events = run2();
    const last = events.at(-1)!;
    events.push({ seq: last.seq + 1, executionId: 'ex_run2', at: last.at, type: 'check', spanId: 'node:pr:0', check: { name: 'Tests on CI', status: 'fail', source: 'node' } } as JournalEvent);
    events.push({ seq: last.seq + 2, executionId: 'ex_run2', at: last.at, type: 'check', spanId: 'node:pr:0', check: { name: 'Tests on CI', status: 'fail', source: 'person', resolution: { decision: 'accepted', by: 'Ann' } } } as JournalEvent);
    const report = buildRunReport(foldJournal(events), { ...RUN_PROFILES.generic, mute: ['hidden'] });
    expect(report.checks).toHaveLength(1);
    expect(report.checks[0]).toMatchObject({ check: 'node', name: 'Tests on CI', resolution: { decision: 'accepted' } });
    expect(report.verdict).toBe('pass');
  });
});

describe('what the real run 2 showed', () => {
  // A Developer whose description names the Reviewer, a test run through a pnpm filter, the same claim said twice, and
  // Claude Code's memory notes written after the push.
  const dev: RunActor = { id: 'remote:developer', type: 'agent', name: 'Developer', role: 'Builds the plugin, or fixes the Reviewer’s issues' };
  const events: JournalEvent[] = [];
  const add = (e: Record<string, unknown>) => events.push({ seq: events.length + 1, executionId: 'ex_live', at: at(events.length), ...e } as JournalEvent);
  const tool = (name: string, input: Record<string, unknown>) => {
    const spanId = `node:developer:0/step:${events.length}`;
    add({ type: 'span.started', spanId, parentSpanId: 'node:developer:0', kind: 'tool', name, actor: dev, input });
    add({ type: 'span.ended', spanId, status: 'success', output: 'ok' });
  };
  add({ type: 'span.started', spanId: 'run', kind: 'run', name: 'Build', actor: flow });
  add({ type: 'span.started', spanId: 'node:developer:0', parentSpanId: 'run', kind: 'delegate', name: 'Developer', actor: dev, caller: lead });
  tool('Edit', { file_path: '/tmp/work/plugins/grafana/src/a.ts', old_string: 'a', new_string: 'b' });
  tool('Bash', { command: 'cd /tmp/work && pnpm --filter @landflow/plugin-grafana test' });
  tool('Bash', { command: 'cd /tmp/work && git commit -qm "grafana" && git push -q origin HEAD' });
  tool('Write', { content: '- [Notes](notes.md)', file_path: '/tmp/work/MEMORY.md' });
  tool('Write', { content: '---\nname: notes\n---', file_path: '/data/claude/projects/-data-workspace/memory/notes.md' });
  add({ type: 'span.ended', spanId: 'node:developer:0', status: 'success', output: 'All tests pass. Tests: ✓ all 3 tests pass.' });
  add({ type: 'span.ended', spanId: 'run', status: 'success' });
  const { checks, claims } = runChecks(foldJournal(events), RUN_PROFILES.software);

  it('holds an actor to a role rule by its name, not by its description', () => {
    expect(checks.filter((c) => c.check === 'roles')).toEqual([]);
  });

  it('counts a memory note as no change to deliver, and a filtered pnpm test as a test run', () => {
    expect(checks.find((c) => c.check === 'unfinished')).toMatchObject({ status: 'pass', subject: 'Developer' });
    expect(claims.map((c) => c.verdict)).toEqual(['proven', 'proven']);
    // Two sentences make the same claim: one check.
    expect(checks.filter((c) => c.check === 'claims').map((c) => c.name)).toEqual(['Claims against evidence: Tests pass']);
  });

  it('writing notes is fine; notes on the branch fail, a project’s own memory/ folder and a removal don’t', () => {
    expect(checks.filter((c) => c.check === 'notes')).toEqual([]);
    const model = foldJournal(events);
    const onBranch = runChecks(model, RUN_PROFILES.software, { branchFiles: ['plugins/grafana/src/main.ts', 'MEMORY.md', 'packages/transports/src/memory/index.ts'] }).checks.filter((c) => c.check === 'notes');
    expect(onBranch).toEqual([expect.objectContaining({ status: 'fail', name: 'Agent notes committed: MEMORY.md', subject: 'The branch' })]);
    expect(onBranch[0].message).toContain('git rm --cached');
    expect(runChecks(model, RUN_PROFILES.software, { branchFiles: ['plugins/grafana/src/main.ts'] }).checks.filter((c) => c.check === 'notes')).toEqual([]);
  });

  it('without the branch, fails a `git add` that names notes', () => {
    const more = [...events.slice(0, -2)];
    const spanId = 'node:developer:0/step:add';
    more.push({ seq: 100, executionId: 'ex_live', at: at(100), type: 'span.started', spanId, parentSpanId: 'node:developer:0', kind: 'tool', name: 'Bash', actor: dev, input: { command: 'cd /tmp/work && git add plugins/grafana MEMORY.md && git commit -qm notes' } } as JournalEvent);
    more.push({ seq: 101, executionId: 'ex_live', at: at(101), type: 'span.ended', spanId, status: 'success', output: 'ok' } as JournalEvent);
    more.push(...events.slice(-2).map((e, i) => ({ ...e, seq: 102 + i, at: at(102 + i) })));
    const notes = runChecks(foldJournal(more), RUN_PROFILES.software).checks.filter((c) => c.check === 'notes');
    expect(notes).toEqual([expect.objectContaining({ status: 'fail', name: 'Agent notes committed: MEMORY.md (Developer)', spanId })]);
    expect(gitAdded('git add -A && git commit -m x; git -C /tmp/work add "src/a.ts" .claude/settings.local.json')).toEqual(['src/a.ts', '.claude/settings.local.json']);
  });
});

describe('rounds', () => {
  // Round 1: the Reviewer edits a file; the Run report's gate sends the work back. Round 2: the Reviewer only reads.
  function rounds(second: boolean): JournalEvent[] {
    const events: JournalEvent[] = [];
    const add = (e: Record<string, unknown>) => events.push({ seq: events.length + 1, executionId: 'ex_rounds', at: at(events.length * 10), ...e } as JournalEvent);
    const review = (n: number, tools: Array<[string, Record<string, unknown>]>) => {
      const id = `node:reviewer:${n}`;
      add({ type: 'span.started', spanId: id, parentSpanId: 'run', kind: 'delegate', name: 'Reviewer', actor: reviewer, caller: lead });
      tools.forEach(([name, input], k) => {
        add({ type: 'span.started', spanId: `${id}/step:${k}`, parentSpanId: id, kind: 'tool', name, actor: reviewer, input });
        add({ type: 'span.ended', spanId: `${id}/step:${k}`, status: 'success', output: 'ok' });
      });
      add({ type: 'span.ended', spanId: id, status: 'success', output: 'VERDICT: APPROVE' });
    };
    add({ type: 'span.started', spanId: 'run', kind: 'run', name: 'Build', actor: flow });
    review(0, [['Edit', { file_path: 'plugins/x/src/a.ts' }]]);
    add({ type: 'check', spanId: 'node:reviewer:0/step:0', check: { name: 'Role rules: Reviewers only read (Reviewer)', status: 'fail', source: 'builtin' } });
    add({ type: 'check', spanId: 'node:reviewer:0/step:0', check: { name: 'Role rules: Reviewers only read (Reviewer)', status: 'fail', resolution: { decision: 'sent_back', by: 'Run report' } } });
    add({ type: 'check', spanId: 'node:ci:0', check: { name: 'CI', status: 'fail', source: 'node' } });
    add({ type: 'check', spanId: 'node:ci:0', check: { name: 'CI', status: 'fail', resolution: { decision: 'sent_back', by: 'Run report' } } });
    if (second) review(1, [['Bash', { command: 'pnpm --filter @landflow/plugin-x test' }]]);
    return events;
  }
  const failed = (events: JournalEvent[]) =>
    runChecks(foldJournal(events), RUN_PROFILES.software)
      .checks.filter((c) => c.status === 'fail')
      .map((c) => c.name);

  it('judges the round after a send-back on its own steps', () => {
    expect(failed(rounds(true))).toEqual([]);
  });

  it('keeps a round’s failures until someone works on them again', () => {
    expect(failed(rounds(false))).toEqual(['Role rules: Reviewers only read (Reviewer)', 'Unfinished work: Every change pushed (Reviewer)', 'CI']);
  });
});

describe('structured replies', () => {
  it('reads claims, findings and fixes from a fenced block', () => {
    const parts = replyParts('Done.\n```landflow\n{"claims": ["tests pass"], "findings": ["typecheck fails in api.ts"], "fixes": []}\n```', RUN_PROFILES.software);
    expect(parts).toEqual({ claims: ['tests pass'], findings: ['typecheck fails in api.ts'], fixes: [], structured: true });
  });

  it('extracts claims from sentences that match the profile when there is no block', () => {
    const parts = replyParts('I added the nodes. All tests pass now!\nI’ve emailed you the summary.', RUN_PROFILES.support);
    expect(parts.claims).toEqual(['I’ve emailed you the summary.']);
    expect(parts.structured).toBe(false);
  });
});
