/**
 * The phone's Steps view (docs/mobile.md#the-steps-view) lists a flow in the order it runs: from the trigger along the
 * main connections, branches indented under their output, a merge listed once, sub-nodes on the step they serve.
 */
import { describe, expect, it } from 'vitest';
import { stepOrder, type StepEdge, type StepNode } from '@/components/editor/step-order';

const at = (id: string, x: number, y = 0): StepNode => ({ id, position: { x, y } });
const main = (source: string, target: string, output = 0): StepEdge => ({ source, target, sourceHandle: `main:${output}`, connectionType: 'main' });
const IFS = new Set(['if', 'if2', 'loop']);
const view = (nodes: StepNode[], edges: StepEdge[]) =>
  stepOrder(nodes, edges, { output: (_id, i) => (i === 0 ? 'true' : 'false'), outputs: (id) => (IFS.has(id) ? 2 : 1) }).map((s) => [s.id, s.depth, s.branch ?? '', s.then.join(','), s.attached.join(',')].join('|'));

describe('the Steps view order', () => {
  it('follows a straight line from the trigger, whatever order the nodes are stored in', () => {
    expect(view([at('c', 600), at('a', 0), at('b', 300)], [main('a', 'b'), main('b', 'c')])).toEqual(['a|0|||', 'b|0|||', 'c|0|||']);
  });

  it('indents each branch under its output and goes on with the main line after they merge', () => {
    const nodes = [at('trigger', 0), at('if', 300), at('yes', 600, -100), at('no', 600, 100), at('merge', 900), at('send', 1200)];
    const edges = [main('trigger', 'if'), main('if', 'yes', 0), main('if', 'no', 1), main('yes', 'merge'), main('no', 'merge'), main('merge', 'send')];
    expect(view(nodes, edges)).toEqual(['trigger|0|||', 'if|0|||', 'yes|1|true||', 'no|1|false||', 'merge|0|||', 'send|0|||']);
  });

  it('keeps two Ifs in a row on the main line', () => {
    const nodes = [at('t', 0), at('if', 300), at('a', 600, -100), at('b', 600, 100), at('m', 900), at('if2', 1200), at('c', 1500, -100), at('d', 1500, 100)];
    const edges = [main('t', 'if'), main('if', 'a', 0), main('if', 'b', 1), main('a', 'm'), main('b', 'm'), main('m', 'if2'), main('if2', 'c', 0), main('if2', 'd', 1)];
    expect(view(nodes, edges)).toEqual(['t|0|||', 'if|0|||', 'a|1|true||', 'b|1|false||', 'm|0|||', 'if2|0|||', 'c|1|true||', 'd|1|false||']);
  });

  it('names the one output wired on a step that has several', () => {
    expect(view([at('t', 0), at('if', 300), at('no', 600)], [main('t', 'if'), main('if', 'no', 1)])).toEqual(['t|0|||', 'if|0|||', 'no|0|false||']);
  });

  it('follows a loop without holding its step back, and names the step it loops to', () => {
    // Loop Over Items: "done" (0) goes on, "loop" (1) runs a step that comes back.
    const nodes = [at('t', 0), at('loop', 300), at('end', 600, -100), at('work', 600, 100)];
    const edges = [main('t', 'loop'), main('loop', 'end', 0), main('loop', 'work', 1), main('work', 'loop')];
    expect(view(nodes, edges)).toEqual(['t|0|||', 'loop|0|||', 'end|1|true||', 'work|1|false|loop|']);
  });

  it('puts sub-nodes, and theirs, on the step they serve, once each', () => {
    const nodes = [at('chat', 0), at('agent', 300), at('model', 300, 200), at('tool', 400, 200), at('toolModel', 500, 300)];
    const edges = [
      main('chat', 'agent'),
      { source: 'model', target: 'agent', connectionType: 'ai_languageModel' },
      { source: 'tool', target: 'agent', connectionType: 'ai_tool' },
      { source: 'tool', target: 'agent', connectionType: 'ai_memory' },
      { source: 'toolModel', target: 'tool', connectionType: 'ai_languageModel' },
    ];
    expect(view(nodes, edges)).toEqual(['chat|0|||', 'agent|0|||model,tool,toolModel']);
  });

  it('lists unconnected steps and loops without repeating a step', () => {
    const nodes = [at('t', 0), at('a', 300), at('b', 600), at('lonely', 0, 400)];
    const edges = [main('t', 'a'), main('a', 'b'), main('b', 'a')];
    expect(view(nodes, edges)).toEqual(['t|0|||', 'a|0|||', 'b|0||a|', 'lonely|0|||']);
  });

  it('starts at a trigger that loops to itself like any other', () => {
    expect(view([at('t', 0, 0), at('u', 0, 100)], [main('t', 't'), main('u', 't')])).toEqual(['u|0|||', 't|0|||']);
  });

  it('starts a flow with two triggers at each, top first', () => {
    const nodes = [at('cron', 0, 200), at('hook', 0, 0), at('work', 300, 100)];
    expect(view(nodes, [main('hook', 'work'), main('cron', 'work')])).toEqual(['hook|0|||', 'cron|0|||', 'work|0|||']);
  });
});
