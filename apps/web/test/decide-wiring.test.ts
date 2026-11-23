/**
 * C34 review: a Decide node's outputs follow its options everywhere outputs are counted (Spotlight's ops, the builder's
 * catalog and connections, the editor's store), and editing the options never silently re-routes a connection.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { Workflow } from '@landflow/engine';
import { applyOps, structuralWarnings, wiringWarnings } from '@/lib/shared/assistant-ops';
import type { NodeTypeInfo } from '@/lib/shared/types';
import { corePlugin } from '@/lib/server/nodes';
import { registry } from '@/lib/server/plugins/registry';
import { registryLookup } from '@/lib/server/assistant/ops';
import { nodeDocs } from '@/lib/server/assistant/research';
import { catalogText } from '@/lib/server/flow-builder';

let types: NodeTypeInfo[];
const lookup = () => registryLookup(types);
beforeAll(() => {
  registry.registerBuiltin(corePlugin);
  types = registry.nodeTypes().filter((t) => t.pluginId === 'core');
});

const decideParams = (options = 'billing\ntechnical\nother', routeBy = 'topic') => ({
  source: 'ollama',
  model: 'nimble:9b',
  state: '{{ $json }}',
  questions: { question: [{ name: 'topic', type: 'choice', instructions: 'What is it about?', options }] },
  routeBy,
});

/** Trigger → Decide (billing, technical, other, Unsure) with three Set steps nothing is connected to yet. */
function workflow(options?: string): Workflow {
  const set = (id: string, name: string) => ({ id, name, type: 'core.set', typeVersion: 1, position: [800, 0] as [number, number], parameters: {} });
  return {
    id: 'wf',
    name: 'T',
    nodes: [
      { id: 'a', name: 'Start', type: 'core.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
      { id: 'd', name: 'Route', type: 'core.decide', typeVersion: 1, position: [280, 0], parameters: decideParams(options) },
      set('s1', 'Billing step'),
      set('s2', 'Technical step'),
      set('s3', 'Other step'),
      set('s4', 'Unsure step'),
    ],
    connections: [{ id: 'e0', type: 'main', source: 'a', sourceIndex: 0, target: 'd', targetIndex: 0 }],
  };
}
let n = 0;
const newId = () => `t${++n}`;
const wired = (wf: Workflow) => wf.connections.filter((c) => c.source === 'd').map((c) => `${c.sourceIndex}>${c.target}`).sort();

describe('Spotlight ops count the expanded outputs', () => {
  it('connects output 1 and output 3 (the Unsure output) of a Decide', () => {
    const result = applyOps(
      workflow(),
      [
        { op: 'connect', from: 'Route', to: 'Technical step', output: 1 },
        { op: 'connect', from: 'Route', to: 'Unsure step', output: 3 },
      ],
      lookup(),
      { newId },
    );
    expect(result.dropped).toEqual([]);
    expect(wired(result.workflow)).toEqual(['1>s2', '3>s4']);
  });

  it('says how many outputs there are when one does not exist', () => {
    const result = applyOps(workflow(), [{ op: 'connect', from: 'Route', to: 'Other step', output: 4 }], lookup(), { newId });
    expect(result.dropped.join(' ')).toMatch(/no output 4 \(it has 4\)/);
  });

  it('places a new step on a branch by its output index', () => {
    const result = applyOps(workflow(), [{ op: 'addNode', type: 'core.set', name: 'New', after: 'Route', output: 2 } as never], lookup(), { newId });
    const added = result.workflow.nodes.find((x) => x.name === 'New');
    const first = applyOps(workflow(), [{ op: 'addNode', type: 'core.set', name: 'New', after: 'Route', output: 0 } as never], lookup(), { newId }).workflow.nodes.find((x) => x.name === 'New');
    expect(added && first && added.position[1] > first.position[1]).toBe(true);
  });

  it('knows a Decide branches when it warns about stray wiring', () => {
    const after = applyOps(workflow(), [{ op: 'connect', from: 'Route', to: 'Billing step', output: 0 }, { op: 'connect', from: 'Route', to: 'Technical step', output: 1 }], lookup(), { newId }).workflow;
    const warnings = wiringWarnings(workflow(), after, lookup());
    expect([...warnings.branches, ...warnings.purpose].join(' ')).not.toMatch(/Billing step.*Technical step.*both/);
  });
});

describe('editing the options moves the connections with them', () => {
  const connected = () =>
    applyOps(workflow(), [{ op: 'connect', from: 'Route', to: 'Billing step', output: 0 }, { op: 'connect', from: 'Route', to: 'Technical step', output: 1 }, { op: 'connect', from: 'Route', to: 'Unsure step', output: 3 }], lookup(), { newId }).workflow;

  it('a setParameters that adds an option in front keeps each branch on its option', () => {
    const result = applyOps(connected(), [{ op: 'setParameters', node: 'Route', parameters: decideParams('sales\nbilling\ntechnical\nother') }], lookup(), { newId });
    expect(wired(result.workflow)).toEqual(['1>s1', '2>s2', '4>s4']);
  });

  it('removing an option drops its connection', () => {
    const result = applyOps(connected(), [{ op: 'setParameters', node: 'Route', parameters: decideParams('technical\nother') }], lookup(), { newId });
    expect(wired(result.workflow)).toEqual(['0>s2', '2>s4']);
  });

  it('switching Route By to a Yes/No question drops what has no name', () => {
    const questions = { question: [...decideParams().questions.question, { name: 'urgent', type: 'yesno', instructions: 'Urgent?' }] };
    const result = applyOps(connected(), [{ op: 'setParameters', node: 'Route', parameters: { questions, routeBy: 'urgent' } }], lookup(), { newId });
    expect(wired(result.workflow)).toEqual([]);
  });

  it('a save-time warning names a connection from an output that no longer exists', () => {
    const before = workflow();
    const after = connected();
    after.nodes = after.nodes.map((x) => (x.id === 'd' ? { ...x, parameters: decideParams('billing\ntechnical') } : x));
    const warnings = structuralWarnings(before, after, lookup());
    expect(warnings.join(' ')).toMatch(/“Route”.*output 3/);
  });
});

describe('the catalog and the docs name a Decide\'s outputs', () => {
  it('lists the outputs by what they follow in the builder catalog', () => {
    expect(catalogText(types)).toMatch(/core\.decide[^\n]*Outputs: one per option of the Choice question named in Route By, in order, then Unsure/);
  });

  it('names the outputs of the node as it is set in the research docs', () => {
    const info = types.find((t) => t.type === 'core.decide')!;
    expect(nodeDocs(info, decideParams())).toMatch(/Outputs: 0: main “billing”; 1: main “technical”; 2: main “other”; 3: main “Unsure”/);
  });
});

describe('the editor store moves the edges with the options', () => {
  it('keeps each edge on its option when an option is added in front, and drops the edge of a removed one', async () => {
    const { useEditor } = await import('@/components/editor/store');
    const wf = workflow();
    wf.connections.push(
      { id: 'e1', type: 'main', source: 'd', sourceIndex: 0, target: 's1', targetIndex: 0 },
      { id: 'e2', type: 'main', source: 'd', sourceIndex: 1, target: 's2', targetIndex: 0 },
      { id: 'e3', type: 'main', source: 'd', sourceIndex: 3, target: 's4', targetIndex: 0 },
    );
    useEditor.getState().load(wf, types);
    const handles = () => useEditor.getState().edges.filter((e) => e.source === 'd').map((e) => `${e.sourceHandle}>${e.target}`).sort();
    expect(handles()).toEqual(['main:0>s1', 'main:1>s2', 'main:3>s4']);
    useEditor.getState().updateNode('d', { parameters: decideParams('sales\nbilling\ntechnical\nother') });
    expect(handles()).toEqual(['main:1>s1', 'main:2>s2', 'main:4>s4']);
    useEditor.getState().updateNode('d', { parameters: decideParams('sales\ntechnical\nother') });
    expect(handles()).toEqual(['main:1>s2', 'main:3>s4']);
  });
});
