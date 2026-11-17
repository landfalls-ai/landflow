/** The line under a node's name, and the actions a node offers: option display names, the subtitle override, missing parameters. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { NodeDescriptor } from '../src/lib/shared/types';
import { nodeActions, nodeSubtitle } from '../src/lib/shared/node-subtitle';

const manifest = (name: string) => JSON.parse(readFileSync(join(__dirname, 'fixtures', 'plugin-manifests', `${name}.json`), 'utf8')) as { nodes: NodeDescriptor[] };
const node = (file: string, name: string) => manifest(file).nodes.find((n) => n.name === name)!;

const plain = (extra: Partial<NodeDescriptor> = {}): NodeDescriptor => ({
  name: 'demo',
  displayName: 'Demo',
  description: '',
  version: 1,
  kind: 'action',
  inputs: [{ type: 'main' }],
  outputs: [{ type: 'main' }],
  properties: [
    { name: 'resource', displayName: 'Resource', type: 'options', default: 'issue', options: [{ name: 'Issue', value: 'issue' }, { name: 'Comment', value: 'comment' }] },
    {
      name: 'operation',
      displayName: 'Operation',
      type: 'options',
      default: 'getAll',
      displayOptions: { show: { resource: ['issue'] } },
      options: [{ name: 'Get Many', value: 'getAll' }, { name: 'Create', value: 'create', action: 'Create an issue' }],
    },
    { name: 'operation', displayName: 'Operation', type: 'options', default: 'add', displayOptions: { show: { resource: ['comment'] } }, options: [{ name: 'Add', value: 'add' }] },
    { name: 'url', displayName: 'URL', type: 'string', default: '' },
  ],
  ...extra,
});

describe('node subtitle', () => {
  it("says an operation's action label when it has one", () => {
    expect(nodeSubtitle(plain(), { resource: 'issue', operation: 'create' })).toBe('Create an issue');
  });

  it('else joins the resource and operation display names, not their raw values', () => {
    expect(nodeSubtitle(plain(), { resource: 'issue', operation: 'getAll' })).toBe('Issue · Get Many');
    expect(nodeSubtitle(plain(), { resource: 'comment', operation: 'add' })).toBe('Comment · Add');
  });

  it('reads the variant of `operation` the resource shows, and the defaults of what is unset', () => {
    expect(nodeSubtitle(plain(), {})).toBe('Issue · Get Many');
    expect(nodeSubtitle(plain(), { resource: 'comment' })).toBe('Comment · Add');
  });

  it('puts a descriptor subtitle first, with option names for its placeholders', () => {
    const d = plain({ subtitle: '{{operation}} on {{resource}} {{url}}' });
    expect(nodeSubtitle(d, { resource: 'issue', operation: 'create', url: 'x.dev' })).toBe('Create on Issue x.dev');
    expect(nodeSubtitle(plain({ subtitle: '={{ $parameter["operation"] }}' }), { resource: 'issue', operation: 'getAll' })).toBe('Get Many');
    expect(nodeSubtitle(plain({ subtitle: '{{ $parameter.url }}' }), { url: 'a.b' })).toBe('a.b');
  });

  it('lets the derived line stand in for a bare operation-and-resource subtitle', () => {
    expect(nodeSubtitle(plain({ subtitle: '{{operation}}: {{resource}}' }), { resource: 'issue', operation: 'create' })).toBe('Create an issue');
  });

  it('drops the separator an empty value leaves, and ignores an expression it cannot evaluate', () => {
    expect(nodeSubtitle(plain({ subtitle: '{{operation}} · {{url}}' }), { resource: 'issue', operation: 'getAll', url: '' })).toBe('Get Many');
    expect(nodeSubtitle(plain({ subtitle: '{{ $json.name + "!" }}' }), { resource: 'issue', operation: 'create' })).toBe('Create an issue');
  });

  it('is nothing for a node with no operation and no subtitle, or no node at all', () => {
    expect(nodeSubtitle(plain({ properties: [] }), {})).toBeUndefined();
    expect(nodeSubtitle(undefined, {})).toBeUndefined();
  });

  it('describes the real plugin nodes by what they do', () => {
    const linear = node('linear', 'linear');
    expect(nodeSubtitle(linear, { resource: 'issue', operation: 'create' })).toBe('Create an issue');
    expect(nodeSubtitle(linear, { resource: 'user', operation: 'getAll' })).toBe('Get many users');
    expect(nodeSubtitle(node('messaging', 'slack'), {})).toMatch(/\S/);
    expect(nodeSubtitle(node('google', 'gmail'), { resource: 'message', operation: 'send' })).toBe('Send a message');
    // A trigger keeps its own subtitle.
    expect(nodeSubtitle(node('messaging', 'telegramTrigger'), { pollInterval: 30 })).toBe('every 30s');
  });
});

describe('node actions', () => {
  it('lists each resource and operation once, labelled as the node creator shows them', () => {
    expect(nodeActions(plain())).toEqual([
      { label: 'Issue · Get Many', group: 'Issue', parameters: { resource: 'issue', operation: 'getAll' } },
      { label: 'Create an issue', group: 'Issue', parameters: { resource: 'issue', operation: 'create' } },
      { label: 'Comment · Add', group: 'Comment', parameters: { resource: 'comment', operation: 'add' } },
    ]);
  });

  it('lists nothing for a node with no operation, or only one with no resource', () => {
    expect(nodeActions(plain({ properties: [] }))).toEqual([]);
    expect(nodeActions({ properties: [{ name: 'operation', displayName: 'Operation', type: 'options', options: [{ name: 'Hash', value: 'hash' }] }] })).toEqual([]);
  });

  it('shows an expression parameter as an ellipsis, not its text', () => {
    const d = plain({ subtitle: '{{url}}' });
    expect(nodeSubtitle(d, { url: '={{ $json.url }}' })).toBe('…');
    expect(nodeSubtitle(d, { url: 'https://x/{{ id }}' })).toBe('…');
    expect(nodeSubtitle(d, { url: 'https://x.test' })).toBe('https://x.test');
  });

  it('reads only own properties: {{constructor}} names no parameter', () => {
    expect(nodeSubtitle(plain({ subtitle: '{{constructor}}' }), {})).not.toMatch(/function|native code/);
    expect(nodeSubtitle(plain({ subtitle: '{{toString}} {{url}}' }), { url: 'a' })).toBe('a');
  });

  it('lists the real Linear node: every operation of every resource', () => {
    const actions = nodeActions(node('linear', 'linear'));
    expect(actions.length).toBeGreaterThanOrEqual(8);
    expect(actions.map((a) => a.label)).toContain('Create an issue');
    expect(new Set(actions.map((a) => `${a.parameters.resource}/${a.parameters.operation}`)).size).toBe(actions.length);
  });
});
