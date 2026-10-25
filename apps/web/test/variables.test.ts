/**
 * Variables: CRUD and validation, and `$vars` through the engine (expressions),
 * the runner (read fresh per run), the Code node and agent node tools.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ExpressionResolver } from '@landflow/engine';
import type { Agent } from '@/lib/shared/agents';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-variables-'));
const previousDir = process.env.LANDFLOW_DATA_DIR;
process.env.LANDFLOW_DATA_DIR = dataDir;

const { VariableFile, variables, VariableError } = await import('@/lib/server/variables');
const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { codeNode } = await import('@/lib/server/nodes/data');
const { runWorkflow } = await import('@/lib/server/runner');
const { buildTools } = await import('@/lib/server/agents/tools');
const { normalizeConfig } = await import('@/lib/server/agents/store');
const { outputsOf, runFlow, runOk } = await import('./helpers');

registry.registerBuiltin(corePlugin);

afterAll(() => {
  process.env.LANDFLOW_DATA_DIR = previousDir;
});

const fresh = () => new VariableFile(join(mkdtempSync(join(tmpdir(), 'landflow-vars-file-')), 'variables.json'));

function clearInstance() {
  for (const { key } of variables.list()) variables.delete(key);
}

describe('variable store', () => {
  it('creates, lists sorted by key, updates, renames and deletes', () => {
    const file = fresh();
    file.create({ key: 'region', value: 'eu-west-1' });
    file.create({ key: 'API_BASE', value: 'https://api.example.com' });
    file.create({ key: '_secretish', value: '' });
    expect(file.list()).toEqual([
      { key: 'API_BASE', value: 'https://api.example.com' },
      { key: '_secretish', value: '' },
      { key: 'region', value: 'eu-west-1' },
    ]);
    expect(file.update('region', { value: 'us-east-1' })).toEqual({ key: 'region', value: 'us-east-1' });
    expect(file.update('region', { key: 'REGION' })).toEqual({ key: 'REGION', value: 'us-east-1' });
    expect(file.get('region')).toBeUndefined();
    expect(file.record()).toEqual({ API_BASE: 'https://api.example.com', REGION: 'us-east-1', _secretish: '' });
    expect(file.delete('REGION')).toBe(true);
    expect(file.delete('REGION')).toBe(false);
    expect(new VariableFile(file.path).list().map((v) => v.key)).toEqual(['API_BASE', '_secretish']);
  });

  it('validates keys and values', () => {
    const file = fresh();
    for (const key of ['', '1abc', 'with-dash', 'with space', 'émoji', 'a'.repeat(65)]) {
      expect(() => file.create({ key, value: 'x' }), key).toThrow(VariableError);
    }
    expect(() => file.create({ key: 'ok', value: 42 })).toThrow(/strings/);
    expect(() => file.create({ key: 'big', value: 'x'.repeat(10_001) })).toThrow(/at most/);
    file.create({ key: 'ok', value: '1' });
    expect(() => file.create({ key: 'ok', value: '2' })).toThrow(expect.objectContaining({ status: 409 }));
    file.create({ key: 'other', value: '3' });
    expect(() => file.update('other', { key: 'ok' })).toThrow(expect.objectContaining({ status: 409 }));
    expect(() => file.update('missing', { value: 'x' })).toThrow(expect.objectContaining({ status: 404 }));
  });
});

describe('$vars in expressions', () => {
  const resolver = (vars?: Record<string, string>) =>
    new ExpressionResolver({ items: [{ json: { id: 7 } }], nodeOutputs: {}, workflow: { id: 'w', name: 'w' }, execution: { id: 'e', mode: 'manual' }, parameters: {}, variables: vars });

  it('reads variables as strings; an unknown name is undefined (as in n8n)', () => {
    const r = resolver({ API_BASE: 'https://api.example.com', LIMIT: '25' });
    expect(r.resolveValue('{{ $vars.API_BASE }}/items/{{ $json.id }}', 0)).toBe('https://api.example.com/items/7');
    expect(r.resolveValue('{{ $vars.LIMIT }}', 0)).toBe('25');
    expect(r.resolveValue('{{ Number($vars.LIMIT) * 2 }}', 0)).toBe(50);
    expect(r.resolveValue('{{ $vars.MISSING }}', 0)).toBeUndefined();
    expect(r.resolveValue('[{{ $vars.MISSING }}]', 0)).toBe('[]');
    expect(resolver().resolveValue('{{ typeof $vars }}', 0)).toBe('object');
  });

  it('is read-only', () => {
    const r = resolver({ MODE: 'live' });
    expect(r.resolveValue('{{ ($vars.MODE = "test", $vars.MODE) }}', 0)).toBe('live');
    expect(r.resolveValue('{{ ($vars.NEW = "x", $vars.NEW) }}', 0)).toBeUndefined();
  });

  it('resolves node parameters through the engine', async () => {
    const result = await runFlow(
      [{ name: 'Set', type: 'core.set', parameters: { mode: 'manual', includeOtherFields: false, fields: { values: [{ name: 'url', type: 'string', value: '{{ $vars.API_BASE }}/users' }] } } }],
      [['Start', 'Set']],
      { variables: { API_BASE: 'https://api.example.com' } },
    );
    expect(outputsOf(result, 'Set')[0]).toEqual([{ url: 'https://api.example.com/users' }]);
  });
});

describe('$vars across the host', () => {
  beforeEach(clearInstance);

  const setWorkflow = {
    id: 'wf_vars',
    name: 'Vars',
    nodes: [
      { id: 'start', name: 'Start', type: 'core.manualTrigger', typeVersion: 1, position: [0, 0] as [number, number], parameters: {} },
      {
        id: 'set',
        name: 'Set',
        type: 'core.set',
        typeVersion: 1,
        position: [200, 0] as [number, number],
        parameters: { mode: 'manual', includeOtherFields: false, fields: { values: [{ name: 'greeting', type: 'string', value: '{{ $vars.GREETING }}, {{ $vars.NAME ?? "nobody" }}' }] } },
      },
    ],
    connections: [{ id: 'c1', type: 'main' as const, source: 'start', sourceIndex: 0, target: 'set', targetIndex: 0 }],
  };

  it('the runner reads variables fresh for every run', async () => {
    variables.create({ key: 'GREETING', value: 'Hello' });
    const first = await runWorkflow({ workflow: setWorkflow, mode: 'manual' });
    expect(first.runData.set.at(-1)?.outputs[0][0].json).toEqual({ greeting: 'Hello, nobody' });
    variables.update('GREETING', { value: 'Hej' });
    variables.create({ key: 'NAME', value: 'Ada' });
    const second = await runWorkflow({ workflow: setWorkflow, mode: 'manual' });
    expect(second.runData.set.at(-1)?.outputs[0][0].json).toEqual({ greeting: 'Hej, Ada' });
  });

  it('the Code node sees $vars, read-only', async () => {
    variables.create({ key: 'TOKEN_PREFIX', value: 'lf_' });
    const result = await runOk(codeNode, {
      mode: 'all',
      code: '$vars.TOKEN_PREFIX = "changed";\nreturn [{ prefix: $vars.TOKEN_PREFIX, missing: $vars.NOPE === undefined, keys: Object.keys($vars) }];',
    });
    expect(result.json()).toEqual([{ prefix: 'lf_', missing: true, keys: ['TOKEN_PREFIX'] }]);
    const each = await runOk(codeNode, { mode: 'each', codeEach: 'return { tagged: $vars.TOKEN_PREFIX + $json.id };' }, [{ id: 1 }, { id: 2 }]);
    expect(each.json()).toEqual([{ tagged: 'lf_1' }, { tagged: 'lf_2' }]);
  });

  it('agent node tools resolve $vars', async () => {
    variables.create({ key: 'GREETING', value: 'Hi' });
    const config = normalizeConfig({
      name: 'Tester',
      tools: [
        {
          type: 'node',
          id: 'tool_set',
          name: 'Greet',
          description: 'Greets',
          nodeType: 'core.set',
          parameters: { mode: 'manual', includeOtherFields: false, fields: { values: [{ name: 'text', type: 'string', value: '{{ $vars.GREETING }} {{ $fromAI("who") }}' }] } },
        },
      ],
    });
    const agent = { ...config, id: 'ag_vars', createdAt: '', updatedAt: '', history: [] } as Agent;
    const [tool] = buildTools(agent, config).tools;
    const outcome = await tool.invoke({ who: 'Grace' }, { agent, runId: 'run_vars', depth: 0, maxDepth: 1 } as never);
    expect(outcome.output).toEqual({ text: 'Hi Grace' });
  });
});
