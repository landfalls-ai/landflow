import { beforeAll, describe, expect, it } from 'vitest';
import type { Workflow } from '@landflow/engine';
import type { NodeDescriptor, NodeTypeInfo } from '@/lib/shared/types';
import { collectionShape } from '@/lib/shared/assistant-ops';
import { corePlugin } from '@/lib/server/nodes';
import { registry } from '@/lib/server/plugins/registry';
import { registryLookup, validateOps } from '@/lib/server/assistant/ops';
import { nodeDocs } from '@/lib/server/assistant/research';
import { cleanTestItems, type DraftNode } from '@/lib/server/flow-builder';

// Regression fixtures from showcasing the Browser node with Spotlight (builder qwen3-coder:30b): a flat Steps list with a
// `value` field and an invented `extract` action, junk pinned on the manual trigger, sub-nodes not wired to the agent,
// and a Web Search node left without its credential.

const browser: NodeDescriptor = {
  name: 'browser',
  displayName: 'Browser',
  description: 'Drive a web page',
  version: 1,
  kind: 'action',
  inputs: [{ type: 'main' }],
  outputs: [{ type: 'main' }],
  usableAsTool: true,
  properties: [
    { name: 'url', displayName: 'URL', type: 'string', default: '' },
    {
      name: 'stepList',
      displayName: 'Steps',
      type: 'fixedCollection',
      typeOptions: { multipleValues: true },
      default: {},
      groups: [
        {
          name: 'step',
          displayName: 'Step',
          values: [
            {
              name: 'action',
              displayName: 'Action',
              type: 'options',
              default: 'click',
              options: [
                { name: 'Click', value: 'click' },
                { name: 'Fill', value: 'fill' },
                { name: 'Extract Text', value: 'getText' },
              ],
            },
            { name: 'target', displayName: 'Target', type: 'string', default: '' },
            { name: 'text', displayName: 'Text', type: 'string', default: '' },
          ],
        },
      ],
    },
    { name: 'options', displayName: 'Options', type: 'collection', default: {}, values: [{ name: 'headed', displayName: 'Headed', type: 'boolean', default: false }] },
  ],
};

const search: NodeDescriptor = {
  name: 'webSearch',
  displayName: 'Web Search',
  description: 'Search the web',
  version: 1,
  kind: 'action',
  inputs: [{ type: 'main' }],
  outputs: [{ type: 'main' }],
  properties: [
    { name: 'provider', displayName: 'Provider', type: 'options', default: 'searxng', options: [{ name: 'SearXNG', value: 'searxng' }, { name: 'Brave', value: 'brave' }] },
    { name: 'query', displayName: 'Query', type: 'string', default: '' },
  ],
  credentials: [
    { name: 'searxngApi', required: false, displayOptions: { show: { provider: ['searxng'] } } },
    { name: 'braveSearchApi', required: true, displayOptions: { show: { provider: ['brave'] } } },
  ],
};

const shell: NodeDescriptor = { ...search, name: 'agentShell', displayName: 'Agent Shell', usableAsTool: true, credentials: undefined, properties: [] };

const extra = new Map<string, NodeDescriptor>([
  ['browser.browser', browser],
  ['web-search.webSearch', search],
  ['agent-shell.agentShell', shell],
]);

let types: NodeTypeInfo[];
const lookup = () => {
  const core = registryLookup(types);
  return (type: string) => extra.get(type) ?? core(type);
};

beforeAll(() => {
  registry.registerBuiltin(corePlugin);
  types = registry.nodeTypes().filter((t) => t.pluginId === 'core');
});

const flow = (): Workflow => ({
  id: 'wf',
  name: 'Form',
  nodes: [{ id: 'a', name: 'Start', type: 'core.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} }],
  connections: [],
});

const agentFlow = (): Workflow => ({
  ...flow(),
  nodes: [...flow().nodes, { id: 'g', name: 'Agent', type: 'core.aiAgent', typeVersion: 1, position: [280, 0], parameters: {} }],
  connections: [{ id: 'e1', type: 'main', source: 'a', sourceIndex: 0, target: 'g', targetIndex: 0 }],
});

const info = (descriptor: NodeDescriptor, type: string): NodeTypeInfo => ({ type, pluginId: type.split('.')[0], pluginName: 'Plugin', language: 'typescript', available: true, descriptor }) as NodeTypeInfo;

describe('collection shapes in the docs', () => {
  it('spells out the stored shape of a fixed collection with its group, fields, option values and an example', () => {
    const shape = collectionShape(browser.properties[1]);
    expect(shape).toContain('"step": [{ action: "click"|"fill"|"getText", target: string, text: string }, …]');
    expect(shape).toContain('e.g. {"step":[{"action":"click","target":"…","text":"…"}]}');
    const docs = nodeDocs(info(browser, 'browser.browser'));
    expect(docs).toContain('stepList (fixedCollection');
    expect(docs).toContain('field options: action ∈ "click"|"fill"|"getText"');
    expect(docs).toContain('stored as an object keyed by group');
  });

  it('describes a plain collection as one object', () => {
    expect(collectionShape(browser.properties[2])).toBe('stored as one object { headed: boolean }, e.g. {"headed":false}');
    expect(collectionShape(browser.properties[0])).toBe('');
  });
});

describe('collection values a node cannot read', () => {
  const add = (parameters: Record<string, unknown>) => validateOps(flow(), [{ op: 'addNode', type: 'browser.browser', name: 'Fill form', after: 'Start', parameters }], lookup());

  it('warns on the flat list with a value field and the invented action', () => {
    const flat = add({ stepList: [{ action: 'extract', target: '#title', value: 'title' }] });
    expect(flat.warnings.some((w) => w.includes('stepList must be an object keyed by group'))).toBe(true);
    const keyed = add({ stepList: { step: [{ action: 'extract', target: '#title', value: 'title' }] } });
    expect(keyed.warnings).toEqual(expect.arrayContaining([
      '“Fill form” stepList.step[0].action: "extract" is not one of "click"|"fill"|"getText"',
      '“Fill form” stepList.step[0] has no field “value” (fields: action, target, text)',
    ]));
  });

  it('warns on an unknown group, a group that is not a list and a key a collection lacks', () => {
    expect(add({ stepList: { steps: [] } }).warnings.join()).toContain('has no group “steps” (groups: step)');
    expect(add({ stepList: { step: { action: 'click' } } }).warnings.join()).toContain('stepList.step must be a list of rows');
    expect(add({ options: { visible: true } }).warnings.join()).toContain('options has no field “visible” (fields: headed)');
  });

  it('accepts the right shape, expressions and untouched nodes', () => {
    expect(add({ stepList: { step: [{ action: 'fill', target: 'input[name=email]', text: 'a@b.c' }, { action: '{{ $json.action }}', target: '#x' }] } }).warnings).toEqual([]);
    expect(add({ options: { headed: true } }).warnings).toEqual([]);
  });

  it('checks an option value of a plain parameter too, on a change', () => {
    const wf = validateOps(flow(), [{ op: 'addNode', type: 'web-search.webSearch', name: 'Search', after: 'Start' }], lookup()).workflow;
    const bad = validateOps(wf, [{ op: 'setParameters', node: 'Search', parameters: { provider: 'bing' } }], lookup());
    expect(bad.warnings).toEqual(['“Search” provider: "bing" is not one of "searxng"|"brave"']);
  });
});

describe('test data pinned on a trigger', () => {
  const trigger: DraftNode = { key: 't', type: 'core.manualTrigger', name: 'Run', x: 0, y: 0, parameters: {} };
  const reader = (code: string): DraftNode => ({ key: 'b', type: 'core.set', name: 'Read', x: 0, y: 0, parameters: { value: code } });

  it('drops the keys a chat trigger would carry and the trigger’s own parameters', () => {
    const items = [{ json: { chatInput: 'hello', sessionId: 's', url: 'https://example.com', parameters: {} } }];
    expect(cleanTestItems(items, trigger, [trigger, reader('{{ $json.url }}')])).toEqual([{ json: { url: 'https://example.com' } }]);
    const own = { ...trigger, parameters: { path: 'x' } };
    expect(cleanTestItems([{ json: { path: 'x', url: 'u' } }], own, [own, reader('{{ $json.url }}')])).toEqual([{ json: { url: 'u' } }]);
  });

  it('pins nothing when only junk is left or when no node reads a pinned field', () => {
    expect(cleanTestItems([{ json: { chatInput: 'hello' } }], trigger, [trigger, reader('{{ $json.url }}')])).toBeUndefined();
    expect(cleanTestItems([{ json: { note: 'unused' } }], trigger, [trigger, reader('{{ $json.url }}')])).toBeUndefined();
  });

  it('keeps items for a flow that names no fields (a node that passes items on)', () => {
    const items = [{ json: { q: 'one' } }];
    expect(cleanTestItems(items, trigger, [trigger, reader('fixed')])).toEqual(items);
  });

  it('keeps useful data a later node reads', () => {
    const items = [{ json: { email: 'a@b.c' } }];
    expect(cleanTestItems(items, trigger, [trigger, reader('{{ $json.email }}')])).toEqual(items);
  });
});

describe('sub-nodes that serve an agent', () => {
  it('flags an Agent Shell wired after the agent as a normal step', () => {
    const result = validateOps(agentFlow(), [{ op: 'addNode', type: 'agent-shell.agentShell', name: 'Shell', after: 'Agent' }], lookup());
    expect(result.warnings).toEqual(['“Shell” is wired after “Agent” as a normal step; if the agent should call it as a tool, attach it with an ai_tool connection (connect type ai_tool) instead']);
  });

  it('is quiet once the tool is attached with ai_tool, and for a model attached to its input', () => {
    const tool = validateOps(agentFlow(), [{ op: 'addNode', ref: 's', type: 'agent-shell.agentShell', name: 'Shell' }, { op: 'connect', from: 's', to: 'Agent', type: 'ai_tool' }], lookup());
    expect(tool.warnings).toEqual([]);
    const model = validateOps(agentFlow(), [{ op: 'addNode', type: 'core.ollamaChatModel', name: 'Model', after: 'Agent' }], lookup());
    expect(model.warnings).toEqual([]);
  });

  it('flags a model node and a tool node added with no connection', () => {
    const model = validateOps(agentFlow(), [{ op: 'addNode', type: 'core.ollamaChatModel', name: 'Model' }], lookup());
    expect(model.warnings).toContain('new node “Model” isn’t attached to anything');
    const tool = validateOps(agentFlow(), [{ op: 'addNode', type: 'agent-shell.agentShell', name: 'Shell' }], lookup());
    expect(tool.warnings).toContain('new node “Shell” has no input');
  });

  it('does not flag an ordinary step after the agent', () => {
    expect(validateOps(agentFlow(), [{ op: 'addNode', type: 'core.set', name: 'Format', after: 'Agent' }], lookup()).warnings).toEqual([]);
  });
});

describe('a node that needs a credential', () => {
  it('shows a chip when the visible slot is required and none is set', () => {
    const brave = validateOps(flow(), [{ op: 'addNode', type: 'web-search.webSearch', name: 'Search', after: 'Start', parameters: { provider: 'brave', query: 'x' } }], lookup());
    expect(brave.cautions).toEqual(['“Search” needs the credential braveSearchApi and none is set: pick one in the node\'s panel']);
    expect(brave.warnings).toEqual([]);
  });

  it('stays quiet when the required slot is hidden by the parameters', () => {
    const searx = validateOps(flow(), [{ op: 'addNode', type: 'web-search.webSearch', name: 'Search', after: 'Start' }], lookup());
    expect(searx.cautions).toEqual([]);
  });
});
