/**
 * Waiting nodes on the canvas and run summaries of collapsed groups (lib/client/run-data.ts, the editor store): what
 * a waiting node waits for in a few words (the same `wait` data the Executions view's banner reads), the node marked
 * `waiting` when a live run ends waiting or a waiting execution is opened, and the status a collapsed group's box
 * shows on the read-only canvases (red when a node inside failed).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Workflow } from '@landflow/engine';
import type { ExecutionRecord } from '@/lib/shared/types';
import { summarizeGroupRun, waitedChildren, waitSummary, waitTime, withWaiting, type NodeStatus, type WaitInfo } from '@/lib/client/run-data';

vi.mock('@/components/canvas/sticky-note', () => ({ STICKY_DEFAULT_CONTENT: '## Note', STICKY_DEFAULT_SIZE: { width: 260, height: 180 } }));

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-waiting-canvas-'));
Object.assign(process.env, { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' });

const { useEditor } = await import('@/components/editor/store');

// Local times, so the expected labels don't depend on the machine's time zone.
const now = new Date(2026, 9, 26, 9, 30).getTime();
const today = new Date(2026, 9, 26, 14, 5).toISOString();
const tomorrow = new Date(2026, 9, 27, 14, 5).toISOString();
const wait = (patch: Partial<WaitInfo>): WaitInfo => ({ nodeId: 'w', nodeName: 'Wait', since: new Date(now).toISOString(), resume: 'time', ...patch });
const children = (...statuses: Array<'success' | 'error' | undefined>) => statuses.map((status, item) => ({ item, executionId: `ex_child_${item}`, ...(status ? { status } : {}) }));

describe('waitTime', () => {
  it('shows the time for today and the date with it otherwise', () => {
    expect(waitTime(today, now)).toBe('14:05');
    expect(waitTime(tomorrow, now)).toBe('Oct 27, 14:05');
    expect(waitTime('not a date', now)).toBe('not a date');
  });
});

describe('waitSummary', () => {
  it('a Wait node', () => {
    expect(waitSummary(wait({ resume: 'time', until: today }), now)).toBe('Waiting until 14:05');
    expect(waitSummary(wait({ resume: 'time', until: tomorrow }), now)).toBe('Waiting until Oct 27, 14:05');
    expect(waitSummary(wait({ resume: 'time' }), now)).toBe('Waiting for a while');
  });

  it('a webhook call, a form, a tool approval', () => {
    expect(waitSummary(wait({ resume: 'webhook' }), now)).toBe('Waiting for a webhook call');
    expect(waitSummary(wait({ resume: 'webhook', until: today }), now)).toBe('Waiting for a webhook call (until 14:05)');
    expect(waitSummary(wait({ resume: 'form' }), now)).toBe('Waiting for a form submission');
    expect(waitSummary(wait({ resume: 'webhook', data: { approval: { tool: 'send_email' } } }), now)).toBe('Waiting for a tool approval');
  });

  it('sub-workflows: how many are still running', () => {
    expect(waitSummary(wait({ resume: 'subworkflow', data: { executionId: 'ex_child' } }), now)).toBe('Waiting on a sub-workflow');
    expect(waitSummary(wait({ resume: 'subworkflow', data: { mode: 'each', children: children('success', undefined, undefined) } }), now)).toBe('Waiting on 2 of 3 sub-workflows');
    expect(waitSummary(wait({ resume: 'subworkflow', data: { mode: 'each', children: children('success', 'error', undefined) } }), now)).toBe('Waiting on 1 of 3 sub-workflows');
  });
});

describe('waitedChildren', () => {
  it('reads the children of a waiting parent', () => {
    expect(waitedChildren({ status: 'waiting', wait: wait({ resume: 'subworkflow', data: { executionId: 'ex_one' } }) })).toEqual([{ item: 0, executionId: 'ex_one' }]);
    expect(waitedChildren({ status: 'waiting', wait: wait({ resume: 'subworkflow', data: { mode: 'each', children: children(undefined, 'success') } }) })).toHaveLength(2);
    expect(waitedChildren({ status: 'success', wait: wait({ resume: 'subworkflow', data: { executionId: 'ex_one' } }) })).toBeUndefined();
    expect(waitedChildren({ status: 'waiting', wait: wait({ resume: 'time' }) })).toBeUndefined();
    expect(waitedChildren(undefined)).toBeUndefined();
  });
});

describe('withWaiting', () => {
  const statuses: Record<string, NodeStatus> = { a: { state: 'success', itemCounts: [1] } };
  it('marks the node the execution waits at', () => {
    const marked = withWaiting(statuses, { status: 'waiting', wait: wait({ resume: 'time', until: today }) }, now);
    expect(marked.w).toEqual({ state: 'waiting', wait: 'Waiting until 14:05' });
    expect(marked.a).toBe(statuses.a);
  });
  it('keeps what the node already showed (its first runs)', () => {
    const marked = withWaiting({ w: { state: 'success', itemCounts: [3] } }, { status: 'waiting', wait: wait({ resume: 'webhook' }) }, now);
    expect(marked.w).toEqual({ state: 'waiting', itemCounts: [3], wait: 'Waiting for a webhook call' });
  });
  it('leaves other executions alone', () => {
    expect(withWaiting(statuses, { status: 'success', wait: wait({}) }, now)).toBe(statuses);
    expect(withWaiting(statuses, { status: 'waiting' }, now)).toBe(statuses);
  });
});

describe('summarizeGroupRun', () => {
  const ids = ['a', 'b', 'c'];
  it('a failed node inside wins', () => {
    const summary = summarizeGroupRun(ids, { a: { state: 'success' }, b: { state: 'error', error: 'boom' }, c: { state: 'running' } });
    expect(summary).toMatchObject({ state: 'error', failed: 1, ran: 2, total: 3, label: '1 failed' });
  });
  it('paused, running, waiting', () => {
    expect(summarizeGroupRun(ids, { a: { state: 'paused' }, b: { state: 'running' } }).label).toBe('Paused inside');
    expect(summarizeGroupRun(ids, { a: { state: 'success' }, b: { state: 'running' } }).label).toBe('Running');
    expect(summarizeGroupRun(ids, { a: { state: 'success' }, b: { state: 'waiting', wait: 'Waiting until 14:05' } })).toMatchObject({ state: 'waiting', label: 'Waiting until 14:05' });
    expect(summarizeGroupRun(ids, { b: { state: 'waiting' } }).label).toBe('Waiting');
  });
  it('how many ran', () => {
    expect(summarizeGroupRun(ids, { a: { state: 'success' }, b: { state: 'success' } }).label).toBe('2 of 3 ran');
    expect(summarizeGroupRun(ids, { a: { state: 'success' }, b: { state: 'success' }, c: { state: 'success' } }).label).toBe('All 3 ran');
    expect(summarizeGroupRun(['a'], { a: { state: 'success' } }).label).toBe('Ran');
    expect(summarizeGroupRun(ids, {})).toMatchObject({ state: 'idle', ran: 0, label: 'Did not run' });
  });
});

// ---------------------------------------------------------------------------
// The editor store
// ---------------------------------------------------------------------------

const node = (id: string, name: string, type: string, x: number) => ({ id, name, type, typeVersion: 1, position: [x, 0] as [number, number], parameters: {} });
const workflow = (): Workflow => ({
  id: 'wf_waiting',
  name: 'Waits',
  nodes: [node('t', 'Start', 'core.manualTrigger', 0), node('w', 'Wait', 'core.wait', 300), node('d', 'Done', 'core.set', 600)],
  connections: [
    { id: 'e1', type: 'main', source: 't', sourceIndex: 0, target: 'w', targetIndex: 0 },
    { id: 'e2', type: 'main', source: 'w', sourceIndex: 0, target: 'd', targetIndex: 0 },
  ],
});
const run = (at: string) => ({ startedAt: at, executionTime: 5, status: 'success' as const, data: { main: [[{ json: { ok: true } }]] } });
const editor = () => useEditor.getState();

describe('the editor marks the waiting node', () => {
  beforeEach(() => {
    editor().load(workflow(), []);
  });

  it('a live run that ends waiting', () => {
    const at = new Date().toISOString();
    const until = new Date(Date.now() + 5 * 60_000).toISOString();
    editor().startRun();
    editor().applyEvent({ type: 'execution.started', executionId: 'ex_live', workflowId: 'wf_waiting', mode: 'manual', at } as never);
    editor().applyEvent({ type: 'execution.finished', executionId: 'ex_live', status: 'waiting', durationMs: 12, wait: wait({ resume: 'time', until }), at } as never);
    editor().finishRun();
    const s = editor();
    expect(s.runStatus).toBe('waiting');
    expect(s.wait?.nodeId).toBe('w');
    expect(s.statuses.w).toMatchObject({ state: 'waiting', wait: `Waiting until ${waitTime(until)}` });
    expect(s.log.at(-1)?.message).toContain('Waiting at Wait');
  });

  it('a new run clears it', () => {
    const at = new Date().toISOString();
    editor().startRun();
    editor().applyEvent({ type: 'execution.finished', executionId: 'ex_live', status: 'waiting', durationMs: 12, wait: wait({ resume: 'webhook' }), at } as never);
    expect(editor().statuses.w?.state).toBe('waiting');
    editor().startRun();
    expect(editor().wait).toBeUndefined();
    expect(editor().statuses.w).toBeUndefined();
  });

  it('a run that finishes has no waiting node', () => {
    const at = new Date().toISOString();
    editor().startRun();
    editor().applyEvent({ type: 'execution.finished', executionId: 'ex_done', status: 'success', durationMs: 12, at } as never);
    expect(editor().wait).toBeUndefined();
  });

  it('an opened waiting execution, with its sub-workflows', () => {
    const at = new Date(now).toISOString();
    const record = {
      executionId: 'ex_open',
      workflowId: 'wf_waiting',
      status: 'waiting',
      mode: 'manual',
      startedAt: at,
      durationMs: 40,
      runData: { t: [run(at)] },
      wait: wait({ resume: 'subworkflow', data: { mode: 'each', children: children('success', undefined, undefined) } }),
    } as unknown as ExecutionRecord;
    editor().loadExecution(record, true);
    const s = editor();
    expect(s.viewing?.id).toBe('ex_open');
    expect(s.statuses.t?.state).toBe('success');
    expect(s.statuses.w).toMatchObject({ state: 'waiting', wait: 'Waiting on 2 of 3 sub-workflows' });
    expect(s.wait?.resume).toBe('subworkflow');
    // Opening it again once a child finished updates the count.
    editor().loadExecution({ ...record, wait: wait({ resume: 'subworkflow', data: { mode: 'each', children: children('success', 'success', undefined) } }) } as ExecutionRecord, true);
    expect(editor().statuses.w?.wait).toBe('Waiting on 1 of 3 sub-workflows');
    // And once it finished, nothing waits.
    editor().loadExecution({ ...record, status: 'success', wait: undefined } as unknown as ExecutionRecord, true);
    expect(editor().statuses.w).toBeUndefined();
    expect(editor().wait).toBeUndefined();
  });
});
