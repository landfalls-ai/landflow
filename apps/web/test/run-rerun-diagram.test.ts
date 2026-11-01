/**
 * The small diagram in the "Re-run from here" sheet (rerunDiagram in lib/shared/run-rerun.ts): which nodes are kept, which
 * one starts, which run again, who failed, and the line in plain words.
 */
import { describe, expect, it } from 'vitest';
import type { JournalEvent, RunActor } from '@/lib/shared/run-trace';
import { foldJournal } from '@/lib/shared/run-trace-model';
import { joinNames, rerunDiagram } from '@/lib/shared/run-rerun';

const T0 = Date.parse('2026-11-01T10:00:00.000Z');
const flow: RunActor = { id: 'workflow', type: 'system', name: 'Plugin run' };
const dev: RunActor = { id: 'remote:developer', type: 'agent', name: 'Developer' };

interface Node {
  id: string;
  name: string;
  status?: 'success' | 'error';
  runs?: number;
  skip?: boolean;
}

/** A run of the given nodes in order; `runs: 2` runs a node twice (a loop), `skip` leaves it out of the run. */
function run(nodes: Node[]) {
  let seq = 0;
  let t = 0;
  const events: JournalEvent[] = [];
  const add = (e: Record<string, unknown>) => events.push({ seq: ++seq, executionId: 'x1', at: new Date(T0 + t++ * 1000).toISOString(), ...e } as JournalEvent);
  add({ type: 'span.started', spanId: 'run', kind: 'run', name: 'Plugin run', actor: flow });
  for (const n of nodes) {
    if (n.skip) continue;
    for (let i = 0; i < (n.runs ?? 1); i++) {
      const id = `node:${n.id}:${i}`;
      add({ type: 'span.started', spanId: id, parentSpanId: 'run', kind: 'step', name: n.name, actor: flow, nodeId: n.id, attrs: { nodeType: 'core.noOp' } });
      if (n.id === 'dev') {
        add({ type: 'span.started', spanId: `${id}/step:c1`, parentSpanId: id, kind: 'delegate', name: 'Developer', actor: dev, input: { message: 'x' } });
        add({ type: 'span.ended', spanId: `${id}/step:c1`, status: 'success' });
      }
      add({ type: 'span.ended', spanId: id, status: n.status ?? 'success', ...(n.status === 'error' ? { error: 'boom' } : {}) });
    }
  }
  add({ type: 'span.ended', spanId: 'run', status: 'success' });
  return foldJournal(events);
}

const nodes: Node[] = [
  { id: 'plan', name: 'Planner' },
  { id: 'dev', name: 'Developer' },
  { id: 'tc', name: 'Typecheck', status: 'error' },
  { id: 'rev', name: 'Review' },
  { id: 'merge', name: 'Merge' },
];

describe('the re-run diagram', () => {
  it('splits the run into kept, the starting node and what runs again, with the failed one marked', () => {
    const d = rerunDiagram(run(nodes), 'node:tc:0')!;
    expect(d.kept.map((s) => s.name)).toEqual(['Planner', 'Developer']);
    expect(d.from).toEqual({ name: 'Typecheck', nodeId: 'tc', failed: true });
    expect(d.again.map((s) => s.name)).toEqual(['Review', 'Merge']);
    expect(d.again.some((s) => s.failed)).toBe(false);
    expect(d.sentence).toBe("Planner and Developer keep this run's outputs; Typecheck runs again, then Review and Merge.");
  });

  it('maps a span inside a node to its node', () => {
    const d = rerunDiagram(run(nodes), 'node:dev:0/step:c1')!;
    expect(d.from.nodeId).toBe('dev');
    expect(d.kept.map((s) => s.nodeId)).toEqual(['plan']);
    expect(d.sentence).toBe("Planner keeps this run's outputs; Developer runs again, then Typecheck, Review and Merge.");
  });

  it('says everything runs again for the first node, and nothing follows the last', () => {
    expect(rerunDiagram(run(nodes), 'node:plan:0')!.sentence).toBe('Planner runs again, then Developer, Typecheck, Review and Merge.');
    const last = rerunDiagram(run(nodes), 'node:merge:0')!;
    expect(last.again).toEqual([]);
    expect(last.sentence).toBe("Planner, Developer, Typecheck and Review keep this run's outputs; Merge runs again.");
  });

  it('shows a node a loop ran several times once, in the order it first ran, failed if any run failed', () => {
    const looped = run([{ id: 'plan', name: 'Planner' }, { id: 'dev', name: 'Developer', runs: 2 }, { id: 'tc', name: 'Typecheck' }]);
    expect(rerunDiagram(looped, 'node:tc:0')!.kept.map((s) => s.name)).toEqual(['Planner', 'Developer']);
    expect(rerunDiagram(looped, 'node:dev:1')!.again.map((s) => s.name)).toEqual(['Typecheck']);
    const failedOnce = run([{ id: 'a', name: 'A', runs: 2, status: 'error' }, { id: 'b', name: 'B' }]);
    expect(rerunDiagram(failedOnce, 'node:b:0')!.kept[0].failed).toBe(true);
  });

  it('leaves out a node that did not run in this run', () => {
    const d = rerunDiagram(run([nodes[0], { ...nodes[1], skip: true }, nodes[2]]), 'node:tc:0')!;
    expect(d.kept.map((s) => s.name)).toEqual(['Planner']);
  });

  it('has nothing for a span that is in no node', () => {
    expect(rerunDiagram(run(nodes), 'run')).toBeUndefined();
    expect(rerunDiagram(run(nodes), 'nope')).toBeUndefined();
  });

  it('joins names in plain words', () => {
    expect([joinNames([]), joinNames(['A']), joinNames(['A', 'B']), joinNames(['A', 'B', 'C'])]).toEqual(['', 'A', 'A and B', 'A, B and C']);
  });
});
