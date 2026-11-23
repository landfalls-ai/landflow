/**
 * Spotlight's stream (components/editor/assistant.ts, docs/assistant.md#chat-surfaces): one chat event at a time applied
 * to a turn, over a recorded C3 sequence, and the build steps as trace rows.
 */
import { describe, expect, it } from 'vitest';
import { applyStreamEvent, toolKind, type AssistantTurn, type StreamEvent } from '@/components/editor/assistant';
import { toActivitySteps, type BuildStep, type StepKind } from '@/lib/shared/build-steps';

const fresh = (): AssistantTurn => ({ id: 'r1', role: 'assistant', parts: [], steps: [], text: '', thinking: [] });

/** A recorded reply: the model thinks aloud and reads the flow, then proposes and says its answer. */
const recorded: Array<[StreamEvent, number]> = [
  [{ type: 'step.start', step: 1, label: 'Thinking…' }, 0],
  [{ type: 'text.delta', step: 1, text: 'Let me look ' }, 100],
  [{ type: 'text.delta', step: 1, text: 'at the flow.' }, 200],
  [{ type: 'thinking', step: 1, text: 'Let me look at the flow.' }, 300],
  [{ type: 'tool', name: 'get_workflow', label: 'Read the workflow', ok: true, id: 'a', step: 1, durationMs: 40, detail: '4 nodes' }, 340],
  [{ type: 'step.start', step: 2, label: 'Writing the change…' }, 400],
  [{ type: 'text.delta', step: 2, text: 'I add a Slack ' }, 900],
  [{ type: 'text.delta', step: 2, text: 'message after HTTP. Say go.' }, 950],
  [{ type: 'text', text: 'I add a Slack message after HTTP. Say go.', step: 2 }, 1000],
  [{ type: 'done', model: 'ollama/qwen3-coder:30b', durationMs: 1400, steps: 2, usage: { inputTokens: 900, outputTokens: 200 }, local: true }, 1400],
];

const play = (events: Array<[StreamEvent, number]>, turn = fresh()) => events.reduce((t, [e, at]) => applyStreamEvent(t, e, at), turn);

describe('the reply while it streams', () => {
  it('grows the provisional text with deltas and replaces it with the checked text', () => {
    let turn = fresh();
    turn = applyStreamEvent(turn, { type: 'step.start', step: 1, label: 'Writing…' }, 0);
    turn = applyStreamEvent(turn, { type: 'text.delta', step: 1, text: 'Hel' }, 1);
    turn = applyStreamEvent(turn, { type: 'text.delta', step: 1, text: 'lo wrld' }, 2);
    expect(turn.text).toBe('Hello wrld');
    expect(turn.parts).toEqual([]);
    turn = applyStreamEvent(turn, { type: 'text', text: 'Hello world.' }, 3);
    expect(turn.text).toBe('Hello world.');
    expect(turn.parts).toEqual([{ kind: 'text', text: 'Hello world.' }]);
  });

  it('keeps thinking out of the reply and puts it in the trace', () => {
    const turn = play(recorded.slice(0, 4));
    expect(turn.text).toBe('');
    expect(turn.parts.some((p) => p.kind === 'text')).toBe(false);
    expect(turn.thinking).toEqual(['Let me look at the flow.']);
    expect(turn.steps?.find((s) => s.kind === 'think')?.detail).toBe('Let me look at the flow.');
  });

  it('opens a running model step, which the next step closes with its time', () => {
    const turn = play(recorded.slice(0, 6));
    const model = turn.steps?.filter((s) => s.kind === 'model');
    expect(model?.[0]).toMatchObject({ status: 'ok', durationMs: 400 });
    expect(model?.[1]).toMatchObject({ status: 'running', label: 'Writing the change…' });
  });

  it('gives tool steps their time, kind and detail', () => {
    const turn = play(recorded.slice(0, 5));
    expect(turn.steps?.find((s) => s.kind === 'read')).toMatchObject({ label: 'Read the workflow', status: 'ok', durationMs: 40, detail: '4 nodes' });
    expect(toolKind('search_nodes')).toBe('search');
    expect(toolKind('propose_changes')).toBe('write');
    expect(toolKind('anything_else')).toBe('tool');
  });

  it('marks a failed tool', () => {
    const turn = applyStreamEvent(fresh(), { type: 'tool', name: 'get_run_data', label: 'Read a run', ok: false, id: 'x', step: 1, durationMs: 5 });
    expect(turn.steps?.[0]).toMatchObject({ status: 'failed', kind: 'read' });
  });

  it('fills meta with model, time, steps, tokens and local on done, and settles every step', () => {
    const turn = play(recorded);
    expect(turn.meta).toEqual({ model: 'ollama/qwen3-coder:30b', durationMs: 1400, steps: 2, inputTokens: 900, outputTokens: 200, local: true });
    expect(turn.steps?.some((s) => s.status === 'running')).toBe(false);
    expect(turn.text).toBe('I add a Slack message after HTTP. Say go.');
  });

  it('keeps the cost of a paid model', () => {
    const turn = applyStreamEvent(fresh(), { type: 'done', model: 'anthropic/claude', durationMs: 900, steps: 1, usage: { inputTokens: 10, outputTokens: 5 }, costUsd: 0.004, local: false });
    expect(turn.meta?.costUsd).toBe(0.004);
    expect(turn.meta?.local).toBeUndefined();
  });

  it('keeps the checkpoint of an error and stops the running step', () => {
    const turn = play([...recorded.slice(0, 2), [{ type: 'error', message: 'The model stopped answering.', checkpoint: 'cp1', step: 1 }, 700]]);
    expect(turn.error).toBe('The model stopped answering.');
    expect(turn.checkpoint).toBe('cp1');
    expect(turn.steps?.find((s) => s.kind === 'model')?.status).toBe('failed');
  });

  it('adds proposals as parts', () => {
    const turn = applyStreamEvent(fresh(), { type: 'proposal', id: 'p1', summary: 'Add Slack', ops: [], dropped: [], warnings: [] });
    expect(turn.parts).toEqual([{ kind: 'proposal', proposal: { id: 'p1', summary: 'Add Slack', ops: [], dropped: [], warnings: [] } }]);
  });
});

describe('build steps as trace rows', () => {
  const kinds: StepKind[] = ['read', 'add', 'wire', 'set', 'remove', 'rename', 'team', 'settings', 'think'];
  const step = (kind: StepKind, state: BuildStep['state'], extra: Partial<BuildStep> = {}): BuildStep => ({ id: kind, kind, title: `Did ${kind}`, doing: `Doing ${kind}`, parts: [], adds: [], links: [], state, ...extra });

  it('maps every kind', () => {
    const rows = toActivitySteps(kinds.map((k) => step(k, 'done')));
    expect(rows).toHaveLength(kinds.length);
    expect(rows.map((r) => r.kind)).toEqual(['read', 'write', 'write', 'write', 'write', 'write', 'write', 'write', 'think']);
    expect(rows.every((r) => r.status === 'ok')).toBe(true);
  });

  it('runs the active step, fails a failed one and leaves out the ones still to do', () => {
    const rows = toActivitySteps([step('read', 'done', { failed: true }), step('add', 'active', { parts: ['Slack', 'HTTP'] }), step('wire', 'todo')]);
    expect(rows).toEqual([
      { id: 'read', label: 'Did read', kind: 'read', status: 'failed' },
      { id: 'add', label: 'Doing add', kind: 'write', status: 'running', detail: 'Slack · HTTP' },
    ]);
  });
});

describe('trace row ids', () => {
  it('keeps two thinking events of one step apart', () => {
    const t = play([
      [{ type: 'step.start', step: 1, label: 'Writing…' }, 0],
      [{ type: 'thinking', step: 1, text: 'Click Apply.' }, 1],
      [{ type: 'thinking', step: 1, text: '(No change card was created.)' }, 2],
    ]);
    const ids = (t.steps ?? []).filter((s) => s.kind === 'think').map((s) => s.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });
});
