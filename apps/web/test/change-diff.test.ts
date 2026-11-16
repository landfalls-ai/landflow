/**
 * SB08: the diff a card shows before Apply: per step, each value old → new, long text whole, and how many steps stay.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NodeDescriptor, Workflow } from '@landflow/engine';
import { diffOps, type DescriptorLookup } from '@/lib/shared/assistant-ops';
import { corePlugin } from '@/lib/server/nodes';
import { registry } from '@/lib/server/plugins/registry';
import { registryLookup } from '@/lib/server/assistant/ops';
import type { NodeTypeInfo } from '@/lib/shared/types';

let core: DescriptorLookup;
let types: NodeTypeInfo[];
const slack = {
  type: 'messaging.slack',
  displayName: 'Slack',
  properties: [
    { name: 'channel', displayName: 'Channel', type: 'string', default: '' },
    { name: 'text', displayName: 'Message text', type: 'string', default: '' },
  ],
} as unknown as NodeDescriptor;
const lookup: DescriptorLookup = (type) => (type === 'messaging.slack' ? slack : core(type));

beforeAll(() => {
  registry.registerBuiltin(corePlugin);
  types = registry.nodeTypes().filter((t) => t.pluginId === 'core');
  core = registryLookup(types);
});

const triage = JSON.parse(readFileSync(join(import.meta.dirname, 'spotlight-scenarios', 'fixtures', 'bug-triage.json'), 'utf8')) as Workflow;
const urlOf = () => String(triage.nodes.find((n) => n.name === 'Open status incident')!.parameters.url);

describe('diffOps', () => {
  it('the httpbin swap: one step, one field, the local URL and httpbin', () => {
    const diff = diffOps(triage, [{ op: 'setParameters', node: 'Open status incident', parameters: { url: 'https://httpbin.org/post' } }], lookup);
    expect(diff.steps).toHaveLength(1);
    expect(diff.steps[0]).toMatchObject({ node: 'Open status incident', kind: 'changed' });
    expect(diff.steps[0].fields).toHaveLength(1);
    expect(diff.steps[0].fields[0]).toMatchObject({ before: urlOf(), after: 'https://httpbin.org/post', long: false });
    expect(diff.untouched).toBe(8);
  });

  it('a 300-character text changed in one word is long, and both sides are whole', () => {
    const text = (word: string) => `${'The build is red and the on-call is paused. '.repeat(6)}${word}`.padEnd(300, '.');
    const wf: Workflow = { ...triage, nodes: triage.nodes.map((n) => (n.name === 'Post to #oncall' ? { ...n, parameters: { ...n.parameters, text: text('old') } } : n)) };
    const diff = diffOps(wf, [{ op: 'setParameters', node: 'Post to #oncall', parameters: { text: text('new') } }], lookup);
    const f = diff.steps[0].fields[0];
    expect(f).toMatchObject({ label: 'Message text', long: true, before: text('old'), after: text('new') });
    expect(f.before!.length).toBe(300);
  });

  it('settings read old → new: off → on, default → 3', () => {
    const diff = diffOps(triage, [{ op: 'setNodeSettings', node: 'Open status incident', settings: { retryOnFail: true, maxTries: 3 } }], lookup);
    expect(diff.steps[0].fields.map((f) => [f.label, f.before, f.after])).toEqual([
      ['Retry on fail', 'off', 'on'],
      ['Max tries', 'default', '3'],
    ]);
  });

  it('an added step with the rewired connection, a removed step, a rename', () => {
    const added = diffOps(triage, [{ op: 'addNode', ref: 'n', type: 'core.noOp', name: 'Pause', before: 'Save to backlog' }], lookup);
    const step = added.steps.find((s) => s.node === 'Pause')!;
    expect(step.kind).toBe('added');
    expect(step.wires.some((w) => w.startsWith('→ ') && w.includes('Pause'))).toBe(true);
    expect(step.wires.some((w) => w.startsWith('− '))).toBe(true);
    expect(added.untouched).toBe(9);

    const removed = diffOps(triage, [{ op: 'removeNode', node: 'Save to backlog' }], lookup);
    expect(removed.steps).toMatchObject([{ node: 'Save to backlog', kind: 'removed' }]);
    expect(removed.untouched).toBe(8);

    const renamed = diffOps(triage, [{ op: 'renameNode', node: 'Is P0?', name: 'Urgent?' }], lookup);
    expect(renamed.steps[0]).toMatchObject({ node: 'Urgent?', kind: 'renamed', was: 'Is P0?' });
  });

  it('counts the steps no op touches: 8 of the 9 of Bug triage', () => {
    expect(triage.nodes).toHaveLength(9);
    expect(diffOps(triage, [{ op: 'setNodeSettings', node: 'Open status incident', settings: { maxTries: 2 } }], lookup).untouched).toBe(8);
    expect(diffOps(triage, [], lookup)).toEqual({ steps: [], untouched: 9 });
  });
});

describe('ChangeDiff', () => {
  it('shows the old value, the new one, "Show all" for a long field and the untouched count', async () => {
    const { ChangeDiff } = await import('@/components/editor/change-diff');
    const { useEditor } = await import('@/components/editor/store');
    useEditor.setState({ nodeTypes: Object.fromEntries([...types.map((t) => [t.type, t]), ['messaging.slack', { type: 'messaging.slack', pluginId: 'messaging', descriptor: slack }]]) as never });
    const long = `${'Line one of the message\n'.repeat(8)}done`;
    const wf: Workflow = { ...triage, nodes: triage.nodes.map((n) => (n.name === 'Post to #oncall' ? { ...n, parameters: { ...n.parameters, text: long } } : n)) };
    const ops = [
      { op: 'setParameters' as const, node: 'Post to #oncall', parameters: { text: `${long}\nhttps://example.test/issue/1` } },
      { op: 'setParameters' as const, node: 'Open status incident', parameters: { url: 'https://httpbin.org/post' } },
    ];
    const html = renderToStaticMarkup(createElement(ChangeDiff, { before: wf, ops }));
    expect(html).toContain(urlOf());
    expect(html).toContain('https://httpbin.org/post');
    expect(html).toContain('Show all');
    expect(html).toContain('7 other steps untouched');
    const one = renderToStaticMarkup(createElement(ChangeDiff, { before: triage, ops: [ops[1]] }));
    expect(one).toContain('8 other steps untouched');
  });
});
