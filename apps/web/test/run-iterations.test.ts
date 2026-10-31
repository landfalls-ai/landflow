/**
 * Iterations (docs/run-trace.md): why an agent asked another (the reason), what members said between tool calls,
 * rounds of a flow that loops, an agent's turns, and fix cycles (typecheck 19 → 13, never passed), on journals shaped
 * like the Grafana run: a lead with a model whose calls have no words, a developer whose typecheck never passes.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ExecutionEvent, Workflow, WorkflowNode } from '@landflow/engine';
import type { JournalDraft, JournalEvent, RunActor } from '@/lib/shared/run-trace';
import { foldJournal } from '@/lib/shared/run-trace-model';
import { errorCount, fixCyclesOf } from '@/lib/shared/fix-cycles';
import { RUN_PROFILES } from '@/lib/shared/run-profiles';

vi.mock('@/lib/server/journal/writer', () => ({ liveJournal: () => undefined, journalOf: () => undefined }));
const { createTranslator } = await import('@/lib/server/journal/translator');

const node = (id: string, name: string, type: string): WorkflowNode => ({ id, name, type, typeVersion: 1, position: [0, 0], parameters: {} });
const workflow: Workflow = {
  id: 'wf',
  name: 'Build run',
  nodes: [node('lead', 'Tech Lead', 'core.messageAgent'), node('model', 'qwen', 'core.ollamaChatModel'), node('dev', 'Developer', 'core.a2aAgent'), node('report', 'Run report', 'core.runReport')],
  connections: [],
};
let clock = Date.parse('2026-10-31T10:00:00.000Z');
const at = (ms = 1000) => new Date((clock += ms)).toISOString();
const started = (nodeId: string, extra: Record<string, unknown> = {}) => ({ type: 'node.started', executionId: 'ex', nodeId, nodeName: workflow.nodes.find((n) => n.id === nodeId)!.name, source: 'main', at: at(), ...extra }) as ExecutionEvent;
const finished = (nodeId: string, json: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  ({ type: 'node.finished', executionId: 'ex', nodeId, nodeName: workflow.nodes.find((n) => n.id === nodeId)!.name, source: 'main', status: 'success', durationMs: 10, itemCounts: [1], run: { startedAt: at(0), durationMs: 10, status: 'success', source: 'main', inputs: [[]], outputs: [[{ json }]] }, at: at(), ...extra }) as unknown as ExecutionEvent;
const progress = (data: Record<string, unknown>) => ({ type: 'node.progress', executionId: 'ex', nodeId: 'dev', nodeName: 'Developer', parentNodeId: 'lead', data, at: at() }) as unknown as ExecutionEvent;

function translate(events: ExecutionEvent[]): JournalDraft[] {
  const drafts: JournalDraft[] = [];
  const translator = createTranslator({ workflow, executionId: 'ex', emit: (d) => drafts.push(d) });
  for (const event of events) translator.feed(event);
  return drafts;
}
const numbered = (drafts: JournalDraft[]): JournalEvent[] => drafts.map((d, i) => ({ ...d, seq: i + 1, executionId: 'ex', at: d.at ?? at() }) as JournalEvent);

describe('the translator', () => {
  const steps = [
    { id: 's1', name: 'Bash', status: 'success', args: { command: 'pnpm typecheck' }, output: 'ok' },
    { id: 's2', name: 'Edit', status: 'success', args: { file_path: 'a.ts' }, output: 'ok' },
  ];
  const drafts = translate([
    { type: 'execution.started', executionId: 'ex', workflowId: 'wf', mode: 'manual', at: at() } as ExecutionEvent,
    started('lead'),
    started('dev', { source: 'tool', parentNodeId: 'lead', input: { message: 'Build it', reason: 'The plan is ready; done is a green typecheck' } }),
    progress({ agent: 'developer', state: 'working', steps: [steps[0]], said: [{ id: 'a1:0', text: 'Let me check the types.', afterSteps: 0 }, { id: 'a3:0', text: 'Fixing the imports.', afterSteps: 1 }] }),
    finished('dev', { reply: 'Done', state: 'completed', agent: 'developer', steps, said: [{ id: 'a1:0', text: 'Let me check the types.', afterSteps: 0 }, { id: 'a3:0', text: 'Fixing the imports.', afterSteps: 1 }] }, { source: 'tool', parentNodeId: 'lead' }),
  ]);

  it('records the reason of a request beside it, not in its input', () => {
    const start = drafts.find((d) => d.type === 'span.started' && d.spanId === 'node:dev:0');
    expect(start).toMatchObject({ kind: 'delegate', input: { message: 'Build it' }, attrs: { reason: 'The plan is ready; done is a green typecheck' } });
    expect((start as { input: object }).input).not.toHaveProperty('reason');
  });

  it('journals what a member said between its tool calls once, in order with the steps', () => {
    const order = drafts.filter((d) => (d.type === 'message' && d.spanId === 'node:dev:0') || (d.type === 'span.started' && d.spanId.includes('/step:'))).map((d) => (d.type === 'message' ? `said: ${d.text}` : `step ${d.spanId.split(':').pop()}`));
    expect(order).toEqual(['said: Let me check the types.', 'step s1', 'said: Fixing the imports.', 'step s2']);
    expect(drafts.filter((d) => d.type === 'message')).toHaveLength(2);
    expect(drafts.find((d) => d.type === 'message')).toMatchObject({ inline: true, from: { name: 'developer' } });
  });

  it('does not treat a question for the calling agent as a wait for a person', () => {
    const asked = translate([
      started('lead'),
      started('dev', { source: 'tool', parentNodeId: 'lead', input: { message: 'x', reason: 'y' } }),
      progress({ agent: 'developer', state: 'working', steps: [] }),
      finished('dev', { reply: 'developer asks: which one?', state: 'input-required', asksCaller: true, agent: 'developer' }, { source: 'tool', parentNodeId: 'lead' }),
    ]);
    expect(asked.some((d) => d.type === 'span.started' && d.kind === 'wait')).toBe(false);
    expect(asked.find((d) => d.type === 'span.ended' && d.spanId === 'node:dev:0')).toMatchObject({ status: 'success', attrs: { asked: true } });
  });

  it('marks a node that ran again after a wait, not after a round', () => {
    const waiting = translate([
      started('lead'),
      { type: 'execution.finished', executionId: 'ex', status: 'waiting', durationMs: 1, wait: { nodeId: 'lead', nodeName: 'Tech Lead', resume: 'webhook', since: at(), data: {} }, at: at() } as ExecutionEvent,
      started('lead'),
    ]);
    expect(waiting.find((d) => d.type === 'span.started' && d.spanId === 'node:lead:1')).toMatchObject({ attrs: { resumed: true } });
    const looped = translate([started('lead'), finished('lead', { reply: 'a' }), started('lead')]);
    expect(looped.find((d) => d.type === 'span.started' && d.spanId === 'node:lead:1')?.attrs).not.toHaveProperty('resumed');
  });
});

// ---- the model -------------------------------------------------------------------------------------------------

const flow: RunActor = { id: 'workflow', type: 'system', name: 'Build run' };
const lead: RunActor = { id: 'node:lead', type: 'agent', name: 'Tech Lead' };
const developer: RunActor = { id: 'remote:developer', type: 'agent', name: 'Developer' };
const modelActor: RunActor = { id: 'model:qwen', type: 'model', name: 'qwen' };

/** A journal builder: `add` numbers the events and times them a second apart. */
function builder() {
  const events: JournalEvent[] = [];
  let seq = 0;
  let t = Date.parse('2026-10-31T11:00:00.000Z');
  const add = (e: Record<string, unknown>) => events.push({ seq: ++seq, executionId: 'ex', at: new Date((t += 1000)).toISOString(), ...e } as JournalEvent);
  const span = (id: string, parent: string, kind: string, name: string, actor: RunActor, extra: Record<string, unknown> = {}) => add({ type: 'span.started', spanId: id, parentSpanId: parent, kind, name, actor, ...extra });
  const end = (id: string, status = 'success', extra: Record<string, unknown> = {}) => add({ type: 'span.ended', spanId: id, status, ...extra });
  return { events, add, span, end };
}

/** Two rounds: the lead asks the developer (typecheck 19 → 13, never passes), the report sends it back, round 2 asks again. */
function twoRounds() {
  const b = builder();
  b.add({ type: 'span.started', spanId: 'run', kind: 'run', name: 'Build run', actor: flow, attrs: { profile: 'software' } });
  for (const round of [0, 1]) {
    const lid = `node:lead:${round}`;
    b.span(lid, 'run', 'agent', 'Tech Lead', lead, { nodeId: 'lead', attrs: { nodeType: 'core.messageAgent' } });
    b.span(`node:model:${round * 2}`, lid, 'model', 'qwen', modelActor, { caller: lead });
    b.end(`node:model:${round * 2}`, 'success', { output: { text: '', toolCalls: [{ id: 'c', name: 'Developer', input: {} }] } });
    const did = `node:dev:${round}`;
    b.span(did, lid, 'delegate', 'Developer', developer, { caller: lead, nodeId: 'dev', input: { message: 'Build it' }, attrs: { reason: round ? 'Fix the type errors the report found' : 'The plan is ready' } });
    b.add({ type: 'message', spanId: did, from: developer, text: 'Let me run the typecheck.', inline: true });
    const command = (id: string, cmd: string, output: unknown, status = 'success') => {
      b.span(`${did}/step:${id}`, did, 'tool', 'Bash', developer, { input: { command: cmd } });
      b.end(`${did}/step:${id}`, status, { output });
    };
    const edit = (id: string) => {
      b.span(`${did}/step:${id}`, did, 'tool', 'Edit', developer, { input: { file_path: 'src/a.ts' } });
      b.end(`${did}/step:${id}`, 'success', { output: 'ok' });
    };
    const tsc = (n: number) => ({ isError: true, result: `Exit code 2\n${Array.from({ length: n }, (_, i) => `src/a.ts(${i + 1},1): error TS2307: Cannot find module`).join('\n')}` });
    if (round === 0) {
      command('t1', 'cd /tmp/work/plugins/grafana && pnpm typecheck', tsc(19));
      edit('e1');
      command('t2', 'cd /tmp/work/plugins/grafana && pnpm typecheck', tsc(13));
      command('x1', 'pnpm test', { isError: true, result: 'Exit code 1\n Tests  1 failed | 4 passed' });
      edit('e2');
      command('x2', 'pnpm test', { result: ' Tests  5 passed' });
    }
    b.end(did, 'success', { output: 'Commit: abc' });
    b.end(`node:lead:${round}`, 'success', { output: { reply: 'done' } });
    b.span(`node:report:${round}`, 'run', 'step', 'Run report', flow, { nodeId: 'report', attrs: { nodeType: 'core.runReport' } });
    b.end(`node:report:${round}`, 'success', round === 0 ? { output: { verdict: 'fail', failed: 1, checks: [{ name: 'Claims against evidence: Typecheck passes', status: 'fail', message: 'Developer said typecheck passes; the last run failed' }, { name: 'Role rules', status: 'pass' }], sendBack: 'The run report found 1 failed check:\n- Typecheck passes' } } : { output: { verdict: 'pass' } });
  }
  b.end('run', 'success');
  return b.events;
}

describe('rounds', () => {
  const model = foldJournal(twoRounds());

  it('numbers the passes of a flow that loops and says why the work went back', () => {
    expect(model.rounds.map((r) => [r.n, r.spanIds])).toEqual([[1, ['node:lead:0', 'node:report:0']], [2, ['node:lead:1', 'node:report:1']]]);
    expect(model.rounds[0].why).toBeUndefined();
    expect(model.rounds[1].why).toMatchObject({ text: expect.stringContaining('1 failed check'), failed: [{ name: 'Claims against evidence: Typecheck passes', message: expect.stringContaining('last run failed') }] });
  });

  it('puts a divider in the story for each round', () => {
    expect(model.story.filter((e) => e.type === 'round').map((e) => e.type === 'round' && e.round.n)).toEqual([1, 2]);
  });

  it('has no rounds when nothing ran twice, or only after a wait', () => {
    const once = builder();
    once.add({ type: 'span.started', spanId: 'run', kind: 'run', name: 'r', actor: flow });
    once.span('node:lead:0', 'run', 'agent', 'Tech Lead', lead, { nodeId: 'lead' });
    once.span('node:lead:1', 'run', 'agent', 'Tech Lead', lead, { nodeId: 'lead', attrs: { resumed: true } });
    expect(foldJournal(once.events).rounds).toEqual([]);
  });
});

describe('turns', () => {
  const model = foldJournal(twoRounds());

  it('gives the lead a turn per model call, with why it asked when its words are empty', () => {
    const turns = model.turns['node:lead'];
    expect(turns.map((t) => [t.n, t.round])).toEqual([[1, 1], [2, 2]]);
    expect(turns[0]).toMatchObject({ kind: 'think', reason: 'The plan is ready' });
    expect(turns[1].reason).toBe('Fix the type errors the report found');
    expect(turns[0].did[0]).toMatchObject({ type: 'delegate', label: 'Developer', reason: 'The plan is ready', text: 'Commit: abc', steps: 6 });
  });

  it('gives a member a turn per request: why, what it said and did in order, what came back', () => {
    const [first, second] = model.turns['remote:developer'];
    expect(first).toMatchObject({ kind: 'request', reason: 'The plan is ready', caller: { name: 'Tech Lead' }, round: 1 });
    expect(first.did[0]).toMatchObject({ type: 'said', text: 'Let me run the typecheck.' });
    expect(first.did.filter((d) => d.type === 'tool')).toHaveLength(6);
    expect(first.back).toMatchObject({ text: 'Commit: abc', steps: 6, result: 'Answered' });
    expect(second.did.map((d) => d.type)).toEqual(['said']);
    expect(second.round).toBe(2);
  });
});

describe('fix cycles', () => {
  const model = foldJournal(twoRounds());
  const cycles = fixCyclesOf(model, RUN_PROFILES.software);

  it('tells the typecheck that never passed, with errors counted from the output', () => {
    const typecheck = cycles.find((c) => c.check === 'typecheck')!;
    expect(typecheck.actor.name).toBe('Developer');
    expect(typecheck.runs.map((r) => [r.passed, r.errors, r.changes])).toEqual([[false, 19, 0], [false, 13, 1]]);
    expect(typecheck.trend).toBe('typecheck 19 → 13, never passed');
  });

  it('tells the tests that failed and then passed', () => {
    const tests = cycles.find((c) => c.check === 'tests')!;
    expect(tests.trend).toBe('tests 1 → passed');
    expect(tests.passed).toBe(true);
  });

  it('is empty for a profile that names no checks', () => {
    expect(fixCyclesOf(model, RUN_PROFILES.generic)).toEqual([]);
  });

  it('counts errors the way each tool prints them', () => {
    expect(errorCount('a error TS1 b\nerror TS2')).toBe(2);
    expect(errorCount('Found 7 errors in 3 files')).toBe(7);
    expect(errorCount('Tests  3 failed | 9 passed')).toBe(3);
    expect(errorCount('--- FAIL: TestA\n--- FAIL: TestB')).toBe(2);
    expect(errorCount('✖ 5 problems (4 errors, 1 warning)')).toBe(5);
    expect(errorCount('nothing here')).toBeUndefined();
  });
});
