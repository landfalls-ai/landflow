import { describe, expect, it } from 'vitest';
import type { StickyNote, WorkflowConnection, WorkflowNode } from '@/lib/shared/types';
import { CLIPBOARD_KIND, parseClipboard, preparePaste, remapReferences, selectionOrigin, serializeSelection, uniqueNodeName, type ClipboardData } from '@/components/editor/clipboard';

const node = (id: string, name: string, position: [number, number], parameters: Record<string, unknown> = {}): WorkflowNode => ({
  id,
  name,
  type: 'core.set',
  typeVersion: 1,
  position,
  parameters,
});
const edge = (id: string, source: string, target: string): WorkflowConnection => ({ id, type: 'main', source, sourceIndex: 0, target, targetIndex: 0 });
const sticky = (id: string, position: [number, number]): StickyNote => ({ id, content: '## Note', position, width: 260, height: 180, color: 2 });

/** Deterministic ids: n1, n2… / e1… / s1… */
function idMaker() {
  const counts = { node: 0, edge: 0, sticky: 0 };
  const prefix = { node: 'n', edge: 'e', sticky: 's' } as const;
  return (kind: 'node' | 'edge' | 'sticky') => `${prefix[kind]}new${++counts[kind]}`;
}

const clip = (nodes: WorkflowNode[], connections: WorkflowConnection[] = [], stickyNotes: StickyNote[] = [], pinData?: ClipboardData['pinData']): ClipboardData => ({
  kind: CLIPBOARD_KIND,
  version: 1,
  nodes,
  connections,
  stickyNotes,
  ...(pinData && { pinData }),
});

describe('uniqueNodeName', () => {
  it('keeps free names and numbers copies like n8n', () => {
    expect(uniqueNodeName('HTTP Request', new Set())).toBe('HTTP Request');
    expect(uniqueNodeName('HTTP Request', new Set(['HTTP Request']))).toBe('HTTP Request1');
    expect(uniqueNodeName('HTTP Request', new Set(['HTTP Request', 'HTTP Request1', 'HTTP Request2']))).toBe('HTTP Request3');
    expect(uniqueNodeName('HTTP Request1', new Set(['HTTP Request', 'HTTP Request1']))).toBe('HTTP Request2');
    expect(uniqueNodeName('Set 2', new Set(['Set 2']))).toBe('Set 3');
  });
});

describe('remapReferences', () => {
  it('rewrites quoted node references inside expressions only', () => {
    const renames = { Set: 'Set1' };
    expect(remapReferences("={{ $('Set').item.json.id }}", renames)).toBe("={{ $('Set1').item.json.id }}");
    expect(remapReferences('{{ $("Set").first().json }}', renames)).toBe('{{ $("Set1").first().json }}');
    expect(remapReferences('{{ $node["Set"].json.x }}', renames)).toBe('{{ $node["Set1"].json.x }}');
    // Outside {{ }} the text is left alone.
    expect(remapReferences("Call $('Set') later", renames)).toBe("Call $('Set') later");
  });

  it('never touches names that only start with the renamed one, or unrelated values', () => {
    const renames = { Set: 'Set1' };
    expect(remapReferences("{{ $('Set 2').item.json.a + $('Setter').item.json.b }}", renames)).toBe("{{ $('Set 2').item.json.a + $('Setter').item.json.b }}");
    expect(remapReferences({ n: 3, ok: true, nested: [{ v: "{{ $('Set').item }}" }] }, renames)).toEqual({ n: 3, ok: true, nested: [{ v: "{{ $('Set1').item }}" }] });
  });

  it('escapes quotes in the new name and handles names with regex characters', () => {
    expect(remapReferences("{{ $('A (copy)').item }}", { 'A (copy)': "Bob's" })).toBe("{{ $('Bob\\'s').item }}");
    expect(remapReferences("{{ $('a.b').item }} {{ $('axb').item }}", { 'a.b': 'c' })).toBe("{{ $('c').item }} {{ $('axb').item }}");
  });
});

describe('serializeSelection', () => {
  it('keeps only selected nodes, inner connections, selected notes and their pinned data', () => {
    const workflow = {
      nodes: [node('a', 'A', [0, 0]), node('b', 'B', [200, 0]), node('c', 'C', [400, 0])],
      connections: [edge('ab', 'a', 'b'), edge('bc', 'b', 'c')],
      stickyNotes: [sticky('s1', [0, -200]), sticky('s2', [500, -200])],
      pinData: { a: [{ json: { x: 1 } }], c: [{ json: { y: 2 } }] },
    };
    const data = serializeSelection(workflow, new Set(['a', 'b']), new Set(['s1']));
    expect(data.kind).toBe(CLIPBOARD_KIND);
    expect(data.nodes.map((n) => n.id)).toEqual(['a', 'b']);
    expect(data.connections.map((c) => c.id)).toEqual(['ab']);
    expect(data.stickyNotes.map((s) => s.id)).toEqual(['s1']);
    expect(data.pinData).toEqual({ a: [{ json: { x: 1 } }] });
    // A deep copy: editing the clipboard doesn't edit the workflow.
    data.nodes[0].position[0] = 99;
    expect(workflow.nodes[0].position[0]).toBe(0);
  });
});

describe('parseClipboard', () => {
  it('recognises Landflow clipboard data and workflow exports', () => {
    const data = clip([node('a', 'A', [0, 0])]);
    expect(parseClipboard(JSON.stringify(data))).toMatchObject({ kind: 'landflow', data: { nodes: [{ id: 'a' }] } });
    const exported = { name: 'Flow', nodes: [node('a', 'A', [0, 0])], connections: [], stickyNotes: [sticky('s', [0, 0])] };
    expect(parseClipboard(JSON.stringify(exported))).toMatchObject({ kind: 'landflow', data: { stickyNotes: [{ id: 's' }] } });
  });

  it('recognises n8n clipboard JSON', () => {
    const n8n = {
      nodes: [{ parameters: {}, name: 'Edit Fields', type: 'n8n-nodes-base.set', typeVersion: 3.4, position: [0, 0] }],
      connections: { 'Edit Fields': { main: [[]] } },
    };
    expect(parseClipboard(JSON.stringify(n8n))).toEqual({ kind: 'n8n', data: n8n });
  });

  it('ignores text that is not a workflow', () => {
    expect(parseClipboard('hello')).toBeUndefined();
    expect(parseClipboard('{ not json')).toBeUndefined();
    expect(parseClipboard('{"a":1}')).toBeUndefined();
    expect(parseClipboard('[1,2]')).toBeUndefined();
  });
});

describe('preparePaste', () => {
  it('gives everything new ids and moves the selection by the offset', () => {
    const data = clip([node('a', 'A', [100, 100]), node('b', 'B', [300, 120])], [edge('ab', 'a', 'b')], [sticky('s', [80, -40])], { a: [{ json: { x: 1 } }] });
    const plan = preparePaste(data, { existingNames: [], offset: { x: 40, y: 60 }, newId: idMaker() });
    expect(plan.nodes.map((n) => [n.id, n.name, n.position])).toEqual([
      ['nnew1', 'A', [140, 160]],
      ['nnew2', 'B', [340, 180]],
    ]);
    expect(plan.connections).toEqual([{ ...edge('enew1', 'nnew1', 'nnew2') }]);
    expect(plan.stickyNotes).toEqual([{ ...sticky('snew1', [120, 20]) }]);
    expect(plan.pinData).toEqual({ nnew1: [{ json: { x: 1 } }] });
    expect(plan.renamed).toEqual({});
  });

  it('places the top-left corner at a point when given one', () => {
    const data = clip([node('a', 'A', [100, 100]), node('b', 'B', [300, 220])], [], [sticky('s', [60, 40])]);
    expect(selectionOrigin(data)).toEqual({ x: 60, y: 40 });
    const plan = preparePaste(data, { existingNames: [], at: { x: 0, y: 0 }, newId: idMaker() });
    expect(plan.nodes.map((n) => n.position)).toEqual([
      [40, 60],
      [240, 180],
    ]);
    expect(plan.stickyNotes[0].position).toEqual([0, 0]);
  });

  it('renames taken names and points references between pasted nodes at the copies', () => {
    const data = clip(
      [
        node('a', 'HTTP Request', [0, 0]),
        node('b', 'Set', [200, 0], { value: "={{ $('HTTP Request').item.json.id }}", other: "={{ $('Webhook').item.json.body }}" }),
      ],
      [edge('ab', 'a', 'b')],
    );
    const plan = preparePaste(data, { existingNames: ['HTTP Request', 'Set', 'Webhook'], newId: idMaker() });
    expect(plan.nodes.map((n) => n.name)).toEqual(['HTTP Request1', 'Set1']);
    expect(plan.renamed).toEqual({ 'HTTP Request': 'HTTP Request1', Set: 'Set1' });
    // The copy reads from the copied HTTP Request; the Webhook wasn't copied, so it keeps pointing at the original.
    expect(plan.nodes[1].parameters).toEqual({ value: "={{ $('HTTP Request1').item.json.id }}", other: "={{ $('Webhook').item.json.body }}" });
  });

  it('keeps references to nodes that were not renamed or not pasted', () => {
    const data = clip([node('b', 'Set', [0, 0], { value: "={{ $('HTTP Request').item.json.id }}" })]);
    const plan = preparePaste(data, { existingNames: ['HTTP Request', 'Set'], newId: idMaker() });
    expect(plan.nodes[0].name).toBe('Set1');
    expect(plan.nodes[0].parameters).toEqual({ value: "={{ $('HTTP Request').item.json.id }}" });
  });

  it('makes names unique among the pasted nodes too, and drops connections to nodes that were not copied', () => {
    const data = clip([node('a', 'Code', [0, 0]), node('b', 'Code', [200, 0])], [edge('ab', 'a', 'b'), edge('ax', 'a', 'missing')]);
    const plan = preparePaste(data, { existingNames: ['Code'], newId: idMaker() });
    expect(plan.nodes.map((n) => n.name)).toEqual(['Code1', 'Code2']);
    expect(plan.connections).toHaveLength(1);
    expect(plan.connections[0]).toMatchObject({ source: 'nnew1', target: 'nnew2' });
  });

  it('does not change the clipboard data', () => {
    const data = clip([node('a', 'A', [0, 0], { v: "={{ $('A').item }}" })]);
    const before = structuredClone(data);
    preparePaste(data, { existingNames: ['A'], newId: idMaker() });
    expect(data).toEqual(before);
  });
});
