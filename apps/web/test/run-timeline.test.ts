/**
 * A run as a timeline (lib/shared/run-timeline.ts): a team run's member turns named by their results, a flow's nodes in
 * run order, the member at work and a wait for a person on their own step, and the card's status pill.
 */
import { describe, expect, it } from 'vitest';
import type { JournalEvent, RunActor } from '@/lib/shared/run-trace';
import { foldJournal } from '@/lib/shared/run-trace-model';
import { headlinesOf } from '@/lib/shared/run-headlines';
import { fitSteps, memberVerb, runTimeline, timelineFill, type TimelineStep } from '@/lib/shared/run-timeline';
import type { TeamActivity } from '@/lib/shared/team-progress';

const T0 = Date.parse('2026-11-01T10:00:00.000Z');
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
const flow: RunActor = { id: 'workflow', type: 'system', name: 'Tech Review Workflow' };
const lead: RunActor = { id: 'node:team', type: 'agent', name: 'Tech Lead' };
const planner: RunActor = { id: 'member:planner', type: 'agent', name: 'Planner' };
const dev: RunActor = { id: 'member:dev', type: 'agent', name: 'Developer' };
const person: RunActor = { id: 'human:you', type: 'human', name: 'You' };
const team = {
  id: 'team_1',
  name: 'Tech Lead team',
  members: [
    { id: 'm_lead', title: 'Tech Lead', kind: 'agent' },
    { id: 'm_plan', title: 'Planner', kind: 'agent', reportsTo: 'm_lead' },
    { id: 'm_dev', title: 'Developer', kind: 'agent', reportsTo: 'm_lead', budgetTokens: 1000 },
    { id: 'm_rev', title: 'Reviewer', kind: 'agent', reportsTo: 'm_lead' },
  ],
};

function journal(build: (add: (time: number, e: Record<string, unknown>) => void) => void): JournalEvent[] {
  let seq = 0;
  const list: JournalEvent[] = [];
  const add = (time: number, e: Record<string, unknown>) => list.push({ seq: ++seq, executionId: 'x1', at: at(time), ...e } as JournalEvent);
  build(add);
  return list;
}

const start = (add: (time: number, e: Record<string, unknown>) => void) => {
  add(0, { type: 'span.started', spanId: 'run', kind: 'run', name: 'Tech Review Workflow', actor: flow });
  add(1, { type: 'span.started', spanId: 'node:team:0', parentSpanId: 'run', kind: 'agent', name: 'Team', actor: lead, nodeId: 'team', attrs: { team } });
  add(2, { type: 'span.started', spanId: 'node:team:0/ask:1', parentSpanId: 'node:team:0', kind: 'delegate', name: 'Plan it', actor: planner, caller: lead, input: 'Plan it' });
  add(20, { type: 'span.ended', spanId: 'node:team:0/ask:1', status: 'success', output: 'The plan' });
  add(21, { type: 'span.started', spanId: 'node:team:0/ask:2', parentSpanId: 'node:team:0', kind: 'delegate', name: 'Build it', actor: dev, caller: lead, input: 'Build it' });
};

describe('a run as a timeline', () => {
  it('names a finished team run’s steps by their results, led by the team’s lead', () => {
    const activity: TeamActivity = { durationMs: 60_000, turns: [], steps: {}, moments: [{ at: 35_000, member: 'Developer', tone: 'ok', text: '14 tests pass' }] };
    const model = foldJournal(
      journal((add) => {
        start(add);
        add(40, { type: 'span.ended', spanId: 'node:team:0/ask:2', status: 'success', output: 'Built' });
        add(60, { type: 'span.ended', spanId: 'node:team:0', status: 'success', output: { reply: 'Merged', activity } });
        add(61, { type: 'span.ended', spanId: 'run', status: 'success' });
      }),
    );
    const t = runTimeline(model, headlinesOf(model));
    expect(t.lead?.name).toBe('Tech Lead');
    expect(t.team).toBe('Tech Lead team');
    expect(t.status).toBe('done');
    expect(t.steps.map((s) => [s.label, s.who, s.state])).toEqual([
      ['Planned', 'Planner', 'done'],
      ['14 tests pass', 'Developer', 'done'],
      ['Delivered', 'the flow', 'done'],
    ]);
    expect(timelineFill(t.steps)).toBe(1);
  });

  it('puts the member at work on its step with what it does, and the members to come after it', () => {
    const model = foldJournal(
      journal((add) => {
        start(add);
        add(22, { type: 'span.started', spanId: 'node:team:0/ask:2/tool:1', parentSpanId: 'node:team:0/ask:2', kind: 'tool', name: 'Bash: pnpm test', actor: dev });
      }),
      { now: T0 + 30_000 },
    );
    const t = runTimeline(model);
    expect(t.status).toBe('on-track');
    const now = t.steps.find((s) => s.state === 'now')!;
    expect([now.label, now.who]).toEqual(['Building', 'Developer']);
    expect(now.doing).toMatch(/pnpm test/);
    expect(t.steps.filter((s) => s.state === 'next').map((s) => s.label)).toEqual(['Review', 'Finish']);
    expect(timelineFill(t.steps)).toBeCloseTo(1 / 3);
  });

  it('turns a member’s step amber with what a wait for a person asks', () => {
    const model = foldJournal(
      journal((add) => {
        start(add);
        add(25, { type: 'span.started', spanId: 'node:team:0/ask:2/approval', parentSpanId: 'node:team:0/ask:2', kind: 'wait', name: 'Developer wants to use publish', actor: person, caller: dev });
      }),
      { now: T0 + 30_000 },
    );
    const t = runTimeline(model);
    expect(t.status).toBe('needs-you');
    expect(t.waiting?.spanId).toBe('node:team:0/ask:2/approval');
    const step = t.steps.find((s) => s.state === 'waiting')!;
    expect(step.who).toBe('Developer');
    expect(step.doing).toBe('Developer wants to use publish');
  });

  it('puts a wait asked of a person on the member whose turn waits, not on a step of its own', () => {
    const model = foldJournal(
      journal((add) => {
        start(add);
        add(22, { type: 'span.updated', spanId: 'node:team:0/ask:2', status: 'waiting' });
        add(25, { type: 'span.started', spanId: 'node:team:0/approval', parentSpanId: 'node:team:0', kind: 'wait', name: 'Developer wants to use publish', actor: { id: 'human:a', type: 'human', name: 'A person' } });
      }),
      { now: T0 + 30_000 },
    );
    const t = runTimeline(model);
    expect(t.steps.filter((s) => s.state === 'waiting').map((s) => [s.who, s.doing])).toEqual([['Developer', 'Developer wants to use publish']]);
    expect(t.steps.some((s) => s.who === 'A person')).toBe(false);
  });

  it('marks the step a run failed on, and a failing result as a failure', () => {
    const activity: TeamActivity = { durationMs: 60_000, turns: [], steps: {}, moments: [{ at: 35_000, member: 'Developer', tone: 'bad', text: 'Typecheck failed' }] };
    const model = foldJournal(
      journal((add) => {
        start(add);
        add(40, { type: 'span.ended', spanId: 'node:team:0/ask:2', status: 'success', output: 'Built' });
        add(60, { type: 'span.ended', spanId: 'node:team:0', status: 'error', error: 'The team gave up', output: { activity } });
        add(61, { type: 'span.ended', spanId: 'run', status: 'error', error: 'The team gave up' });
      }),
    );
    const t = runTimeline(model, headlinesOf(model));
    expect(t.status).toBe('failed');
    expect(t.steps.find((s) => s.state === 'failed')?.label).toBe('Typecheck failed');
    expect(t.steps.at(-1)).toMatchObject({ label: 'Stopped', state: 'next' });
  });

  it('says a member went over its budget', () => {
    const model = foldJournal(
      journal((add) => {
        start(add);
        add(22, { type: 'span.started', spanId: 'node:team:0/ask:2/model:1', parentSpanId: 'node:team:0/ask:2', kind: 'model', name: 'qwen3-coder', actor: { id: 'model:qwen', type: 'model', name: 'qwen3-coder' } });
        add(23, { type: 'span.ended', spanId: 'node:team:0/ask:2/model:1', status: 'success', usage: { inputTokens: 1500, outputTokens: 200 } });
      }),
      { now: T0 + 30_000 },
    );
    const t = runTimeline(model);
    expect(t.overBudget).toBe('Developer');
    expect(t.status).toBe('over-budget');
  });

  it('shows any other run’s nodes once each, in the order they first ran', () => {
    const fetcher: RunActor = { id: 'node:fetch', type: 'system', name: 'Fetch' };
    const writer: RunActor = { id: 'node:write', type: 'agent', name: 'Writer', role: 'Writes the notes' };
    const model = foldJournal(
      journal((add) => {
        add(0, { type: 'span.started', spanId: 'run', kind: 'run', name: 'Release notes', actor: flow });
        add(1, { type: 'span.started', spanId: 'node:fetch:0', parentSpanId: 'run', kind: 'step', name: 'Fetch commits', actor: fetcher, nodeId: 'fetch' });
        add(2, { type: 'span.ended', spanId: 'node:fetch:0', status: 'success' });
        add(3, { type: 'span.started', spanId: 'node:write:0', parentSpanId: 'run', kind: 'agent', name: 'Write notes', actor: writer, nodeId: 'write' });
        add(9, { type: 'span.ended', spanId: 'node:write:0', status: 'success' });
        add(10, { type: 'span.started', spanId: 'node:fetch:1', parentSpanId: 'run', kind: 'step', name: 'Fetch commits', actor: fetcher, nodeId: 'fetch' });
        add(11, { type: 'span.ended', spanId: 'node:fetch:1', status: 'success' });
        add(12, { type: 'span.ended', spanId: 'run', status: 'success' });
      }),
    );
    const t = runTimeline(model);
    expect(t.team).toBeUndefined();
    expect(t.lead?.name).toBe('Writer');
    expect(t.steps.map((s) => [s.label, s.who])).toEqual([
      ['Fetch commits', ''],
      ['Write notes', 'Writer'],
      ['Done', 'the flow'],
    ]);
  });

  it('keeps the first step and the latest ones of a long run', () => {
    const steps: TimelineStep[] = Array.from({ length: 10 }, (_, i) => ({ key: String(i), label: `S${i}`, who: '', state: i < 7 ? 'done' : i === 7 ? 'now' : 'next' }));
    // The step at work (S7) with the one after it, and the first.
    expect(fitSteps(steps, 5).map((s) => s.label)).toEqual(['S0', 'S5', 'S6', 'S7', 'S8']);
  });

  it('reads what a member does from its title or role', () => {
    expect(memberVerb('Planner')).toEqual({ done: 'Planned', now: 'Planning', next: 'Plan' });
    expect(memberVerb('Nina', 'Order intake').done).toBe('Done');
    expect(memberVerb('Sam', 'Code reviewer').now).toBe('Reviewing');
  });
});
