import { describe, expect, it } from 'vitest';
import type { JournalEvent, RunActor } from '@/lib/shared/run-trace';
import { foldJournal, preview, quietMs, resultOf, textOf } from '@/lib/shared/run-trace-model';

const T0 = Date.parse('2026-10-31T10:00:00.000Z');
const at = (s: number) => new Date(T0 + s * 1000).toISOString();

const flow: RunActor = { id: 'workflow', type: 'system', name: 'Grafana run' };
const lead: RunActor = { id: 'node:lead', type: 'agent', name: 'Tech Lead' };
const planner: RunActor = {
  id: 'remote:planner',
  type: 'agent',
  name: 'planner',
};
const developer: RunActor = {
  id: 'remote:developer',
  type: 'agent',
  name: 'developer',
};
const model: RunActor = { id: 'model:qwen', type: 'model', name: 'qwen' };
const person: RunActor = { id: 'human:ann', type: 'human', name: 'Ann' };

function journal() {
  let seq = 0;
  const events: JournalEvent[] = [];
  const add = (time: number, e: Record<string, unknown>) => {
    events.push({
      seq: ++seq,
      executionId: 'x1',
      at: at(time),
      ...e,
    } as JournalEvent);
  };
  return { events, add };
}

/** A run shaped like "Grafana run 2": a lead who asks a planner, a developer (one failed step inside), the developer is asked again, then a wait and a resume. */
function run2() {
  const { events, add } = journal();
  add(0, {
    type: 'span.started',
    spanId: 'run',
    kind: 'run',
    name: 'Grafana run',
    actor: flow,
  });
  add(1, {
    type: 'span.started',
    spanId: 'node:brief:0',
    parentSpanId: 'run',
    kind: 'step',
    name: 'brief',
    actor: flow,
  });
  add(2, {
    type: 'span.ended',
    spanId: 'node:brief:0',
    status: 'success',
    output: { items: 1 },
  });
  add(3, {
    type: 'span.started',
    spanId: 'node:lead:0',
    parentSpanId: 'run',
    kind: 'agent',
    name: 'Tech Lead',
    actor: lead,
  });
  add(4, {
    type: 'span.started',
    spanId: 'node:model:0',
    parentSpanId: 'node:lead:0',
    kind: 'model',
    name: 'qwen',
    actor: model,
    caller: lead,
  });
  add(6, {
    type: 'span.ended',
    spanId: 'node:model:0',
    status: 'success',
    usage: { inputTokens: 1200, outputTokens: 300 },
  });
  add(7, {
    type: 'span.started',
    spanId: 'node:memory:0',
    parentSpanId: 'node:lead:0',
    kind: 'step',
    name: 'memory',
    actor: lead,
    attrs: { hidden: true },
  });
  add(8, {
    type: 'span.started',
    spanId: 'node:planner:0',
    parentSpanId: 'node:lead:0',
    kind: 'delegate',
    name: 'planner',
    actor: planner,
    caller: lead,
    input: 'Plan the plugin',
  });
  add(9, {
    type: 'span.started',
    spanId: 'node:planner:0/step:1',
    parentSpanId: 'node:planner:0',
    kind: 'tool',
    name: 'Read: docs',
    actor: planner,
  });
  add(10, {
    type: 'span.ended',
    spanId: 'node:planner:0/step:1',
    status: 'success',
    output: 'ok',
  });
  add(20, {
    type: 'span.ended',
    spanId: 'node:planner:0',
    status: 'success',
    output: { reply: 'Plan: three nodes.' },
  });
  add(21, {
    type: 'span.started',
    spanId: 'node:developer:0',
    parentSpanId: 'node:lead:0',
    kind: 'delegate',
    name: 'developer',
    actor: developer,
    caller: lead,
    input: 'Build it',
  });
  add(22, {
    type: 'span.started',
    spanId: 'node:developer:0/step:a',
    parentSpanId: 'node:developer:0',
    kind: 'tool',
    name: 'Bash: git push',
    actor: developer,
  });
  add(25, {
    type: 'span.ended',
    spanId: 'node:developer:0/step:a',
    status: 'error',
    error: 'Exit code 128',
  });
  add(26, {
    type: 'artifact',
    spanId: 'node:developer:0',
    artifact: {
      name: 'PR #4: grafana plugin',
      kind: 'pull_request',
      url: 'https://example.test/pr/4',
    },
  });
  add(27, {
    type: 'check',
    spanId: 'node:developer:0',
    check: {
      name: 'tests',
      status: 'fail',
      message: '2 failing',
      source: 'node',
    },
  });
  add(30, {
    type: 'span.ended',
    spanId: 'node:developer:0',
    status: 'success',
    output: { reply: 'Done, but push failed' },
  });
  // the developer is asked again, and fails to answer
  add(31, {
    type: 'span.started',
    spanId: 'node:developer:1',
    parentSpanId: 'node:lead:0',
    kind: 'delegate',
    name: 'developer',
    actor: developer,
    caller: lead,
  });
  add(33, {
    type: 'span.ended',
    spanId: 'node:developer:1',
    status: 'error',
    error: 'timeout',
  });
  // developer asks the lead back (back and forth)
  add(34, {
    type: 'span.started',
    spanId: 'node:lead:ask',
    parentSpanId: 'node:lead:0',
    kind: 'delegate',
    name: 'lead',
    actor: lead,
    caller: developer,
  });
  add(35, {
    type: 'span.ended',
    spanId: 'node:lead:ask',
    status: 'success',
    output: { reply: 'ok' },
  });
  add(36, {
    type: 'span.ended',
    spanId: 'node:lead:0',
    status: 'success',
    output: { text: 'PR opened.' },
    usage: { inputTokens: 1, outputTokens: 1 },
  });
  add(37, {
    type: 'span.started',
    spanId: 'run/wait:0',
    parentSpanId: 'run',
    kind: 'wait',
    name: 'Approve the PR',
    actor: person,
    caller: flow,
    input: { question: 'Merge?' },
  });
  return { events, add };
}

describe('foldJournal', () => {
  it('folds a run into spans, actors, edges and a result per request', () => {
    const { events } = run2();
    const m = foldJournal(events, { now: T0 + 40_000 });
    expect(m.status).toBe('running');
    expect(m.live).toBe(true);
    expect(m.spans['node:planner:0'].depth).toBe(2);
    expect(m.spans['node:planner:0'].steps).toBe(1);
    expect(resultOf(m.spans['node:planner:0'])).toEqual(['Answered', '']);
    expect(resultOf(m.spans['node:developer:0'])).toEqual(['Delivered', 'ok']);
    expect(resultOf(m.spans['node:developer:1'])).toEqual(['Left undelivered', 'bad']);
    const dev = m.actors.find((a) => a.actor.id === 'remote:developer')!;
    expect(dev.asked).toBe(2);
    expect(dev.results).toEqual(['Delivered', 'Left undelivered']);
    expect(dev.failedSteps).toBe(1);
    expect(dev.artifacts).toHaveLength(1);
    expect(dev.failedChecks).toHaveLength(1);
    const leadStats = m.actors.find((a) => a.actor.id === 'node:lead')!;
    expect(leadStats.tokensIn).toBe(1200);
    expect(leadStats.tokensOut).toBe(300);
    expect(leadStats.modelCalls).toBe(1);
    expect(leadStats.calls).toBe(3);
    // model actors are not part of the team
    expect(m.edges.some((e) => e.to === 'model:qwen')).toBe(false);
    const toDev = m.edges.find((e) => e.from === 'node:lead' && e.to === 'remote:developer')!;
    expect(toDev.delegate).toBe(2);
    expect(m.edges.find((e) => e.from === 'workflow' && e.to === 'node:lead')?.started).toBe(1);
  });

  it('finds back-and-forth cycles', () => {
    const m = foldJournal(run2().events);
    const cycle = m.cycles.find((c) => [c.a, c.b].includes('remote:developer') && [c.a, c.b].includes('node:lead'))!;
    expect(cycle.ab + cycle.ba).toBe(3);
    expect(cycle.rounds).toBe(1);
  });

  it('lists hidden failures, what needs a person and who is working', () => {
    const m = foldJournal(run2().events);
    const failed = m.failedSteps.find((f) => f.name === 'Bash: git push')!;
    expect(failed.hidden).toBe(true);
    expect(failed.error).toBe('Exit code 128');
    expect(m.needsYou.map((n) => n.kind)).toEqual(['wait', 'check']);
    expect(m.needsYou[0]).toMatchObject({
      kind: 'wait',
      title: 'Approve the PR',
      detail: 'Merge?',
    });
    // the wait is a person's, so nobody "works"; the lead finished
    expect(m.working).toEqual([]);
    expect(m.spans['node:memory:0'].hidden).toBe(true);
  });

  it('names who is working now: the deepest open spans', () => {
    const { events, add } = journal();
    add(0, {
      type: 'span.started',
      spanId: 'run',
      kind: 'run',
      name: 'r',
      actor: flow,
    });
    add(1, {
      type: 'span.started',
      spanId: 'node:lead:0',
      parentSpanId: 'run',
      kind: 'agent',
      name: 'Tech Lead',
      actor: lead,
    });
    add(2, {
      type: 'span.started',
      spanId: 'node:dev:0',
      parentSpanId: 'node:lead:0',
      kind: 'delegate',
      name: 'developer',
      actor: developer,
      caller: lead,
    });
    add(3, {
      type: 'span.started',
      spanId: 'node:dev:0/step:1',
      parentSpanId: 'node:dev:0',
      kind: 'tool',
      name: 'Bash: pnpm test',
      actor: developer,
    });
    const m = foldJournal(events, { now: T0 + 90_000 });
    expect(m.working.map((w) => w.name)).toEqual(['Bash: pnpm test']);
    expect(m.working[0].actor.name).toBe('developer');
    expect(quietMs(m, T0 + 6 * 60_000)).toBe(6 * 60_000 - 3000);
    expect(resultOf(m.spans['node:dev:0'])).toEqual(['Working', 'warn']);
  });

  it('replays: until folds only the events up to that time', () => {
    const { events } = run2();
    const early = foldJournal(events, { until: at(21.5) });
    expect(early.order.map((s) => s.id)).not.toContain('node:developer:1');
    expect(early.spans['node:planner:0'].status).toBe('success');
    expect(early.spans['node:developer:0'].status).toBe('running');
    expect(early.spans['node:developer:0'].ms).toBe(500);
    expect(early.working.map((w) => w.name)).toEqual(['developer']);
    expect(foldJournal(events, { until: at(23) }).working.map((w) => w.name)).toEqual(['Bash: git push']);
    expect(early.artifacts).toHaveLength(0);
    expect(foldJournal(events, { until: at(27.5) }).artifacts).toHaveLength(1);
  });

  it('a person settling a failed check settles it instead of adding another', () => {
    const { events, add } = run2();
    add(50, {
      type: 'check',
      spanId: 'node:developer:0',
      check: {
        name: 'tests',
        status: 'fail',
        resolution: { decision: 'accepted', by: 'ann' },
      },
    });
    const m = foldJournal(events);
    expect(m.checks).toHaveLength(1);
    expect(m.checks[0].check.message).toBe('2 failing');
    expect(m.needsYou.some((n) => n.kind === 'check')).toBe(false);
    expect(m.outcome.checked.tone).toBe('warn');
  });

  it('reports against checks once the run ends', () => {
    const { events, add } = run2();
    add(60, { type: 'span.ended', spanId: 'run/wait:0', status: 'success' });
    add(61, { type: 'span.ended', spanId: 'run', status: 'success' });
    const m = foldJournal(events);
    expect(m.status).toBe('success');
    expect(m.live).toBe(false);
    expect(m.t1 - m.t0).toBe(61_000);
    expect(m.outcome.reported).toMatchObject({
      text: 'PR opened.',
      by: 'Tech Lead',
    });
    expect(m.outcome.checked).toMatchObject({ fail: 1, total: 1, tone: 'bad' });
    expect(m.working).toEqual([]);
  });

  it('renames a remote agent from its card and tells the story with steps folded', () => {
    const { events, add } = run2();
    add(38, {
      type: 'span.updated',
      spanId: 'node:planner:0',
      attrs: { agent: 'Planner Agent' },
    });
    add(39, { type: 'message', spanId: 'run', from: person, text: 'go' });
    const m = foldJournal(events);
    expect(m.spans['node:planner:0'].actor.name).toBe('Planner Agent');
    expect(m.actors.find((a) => a.actor.id === 'remote:planner')?.actor.name).toBe('Planner Agent');
    const types = m.story.map((e) => e.type);
    // the brief step folds into a "steps" row; the failed push is inside a request so it shows with it
    expect(types).toContain('msg');
    expect(types).toContain('steps');
    expect(types.filter((t) => t === 'ask')).toHaveLength(4);
    expect(m.story.some((e) => e.type === 'artifact')).toBe(true);
    expect(m.story.some((e) => e.type === 'check')).toBe(true);
  });

  it('handles an empty journal and cut text', () => {
    const m = foldJournal([]);
    expect(m.empty).toBe(true);
    expect(m.story).toEqual([]);
    expect(textOf({ reply: 'hi' })).toBe('hi');
    expect(textOf('x'.repeat(500), 10)).toHaveLength(10);
  });

  it('previews what an agent wrote without its Markdown marks', () => {
    expect(preview('## Outcome\nThe plugin is **built** in `plugins/grafana`.\n- [PR #2](https://x/pull/2)', 200)).toBe('Outcome: The plugin is built in plugins/grafana. PR #2');
    expect(preview('# Plan:\nship it', 200)).toBe('Plan: ship it');
    expect(preview('## Outcome The plugin is built. ## Plan Ship it', 200)).toBe('Outcome The plugin is built. Plan Ship it');
  });
});
