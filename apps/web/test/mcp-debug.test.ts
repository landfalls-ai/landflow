/**
 * The debugging side of the instance MCP server: `get_node_type` returns `outputSchema`; `validate_workflow` warns when
 * an expression names a field the node before it does not write (from its outputSchema, else the last run's data, and
 * never for a node whose fields are unknown); `explain_failure`, `get_run_trace`, `get_plugin_logs`, `retry_execution`
 * and `run_node`, all redacted (credentials, `$vars`). Called through the MCP client over an in-memory transport.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { Client, InMemoryTransport, type CallToolResult } from '@modelcontextprotocol/client';
import type { Workflow, WorkflowNode } from '@landflow/engine';

vi.setConfig({ testTimeout: 30_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-mcp-debug-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_PUBLIC_URL: 'http://mcp.test' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { store } = await import('@/lib/server/store');
const { variables } = await import('@/lib/server/variables');
const { instanceServer } = await import('@/lib/server/mcp/instance-tools');
const { checkExpressionFields, outputSchemaOf, referencesIn } = await import('@/lib/server/mcp/expression-fields');
const { defineNode, definePlugin } = await import('@landflow/sdk');

afterAll(() => {
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const SECRET = 'supersecretvalue-42';
registry.registerBuiltin(corePlugin);
registry.registerBuiltin(
  definePlugin({
    info: { id: 'dbgtest', name: 'Debug test', version: '1.0.0', language: 'typescript' },
    nodes: [
      // Writes `snapshot` and `url`, and says so.
      defineNode({
        description: {
          name: 'writer',
          displayName: 'Writer',
          version: 1,
          kind: 'action',
          inputs: ['main'],
          outputs: ['main'],
          outputSchema: { type: 'object', properties: { url: { type: 'string' }, snapshot: { type: 'string', description: 'the page as text' } } },
          properties: [],
        },
        async execute() {
          return [[{ json: { url: 'http://page.test', snapshot: 'page text' } }]];
        },
      }),
      // Writes `count`, declares nothing.
      defineNode({
        description: { name: 'plain', displayName: 'Plain', version: 1, kind: 'action', inputs: ['main'], outputs: ['main'], properties: [] },
        async execute() {
          return [[{ json: { count: 3 } }]];
        },
      }),
      // Always fails, quoting a $vars value in its message.
      defineNode({
        description: { name: 'boom', displayName: 'Boom', version: 1, kind: 'action', inputs: ['main'], outputs: ['main'], properties: [{ name: 'target', displayName: 'Target', type: 'string', default: '' }] },
        async execute() {
          throw new Error(`401 unauthorized for token ${SECRET}`);
        },
      }),
    ],
  }),
);

const text = (result: CallToolResult) => ((result.content ?? []) as Array<{ type: string; text?: string }>).filter((p) => p.type === 'text').map((p) => p.text).join('');

const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
await instanceServer().connect(serverSide);
const client = new Client({ name: 'debug-test', version: '1.0.0' });
await client.connect(clientSide);
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
  return { result, raw: text(result), data: result.isError ? undefined : JSON.parse(text(result)) };
};

const node = (id: string, type: string, parameters: Record<string, unknown> = {}): WorkflowNode => ({ id, name: id, type, typeVersion: 1, position: [0, 0], parameters });
const link = (source: string, target: string) => ({ id: `${source}-${target}`, type: 'main' as const, source, target, sourceIndex: 0, targetIndex: 0 });
const save = (id: string, nodes: WorkflowNode[], connections: ReturnType<typeof link>[]): Workflow => store.saveWorkflow({ id, name: id, nodes, connections } as Workflow);

describe('expression field checks (pure)', () => {
  it('finds the field reads of an expression or code', () => {
    const texts = [
      '$json.a',
      "$json['b c']",
      '$input.first().json.d',
      "$('Browser').item.json.snapshot",
      '$node["Browser"].json.url',
      '$json.hasOwnProperty',
    ];
    expect(texts.flatMap(referencesIn).map((r) => `${r.node ?? ''}:${r.field}`)).toEqual([':a', ':b c', ':d', 'Browser:snapshot', 'Browser:url']);
  });

  it('only checks nodes whose fields are known', () => {
    const wf = { nodes: [{ id: 'a', name: 'A', type: 't', parameters: {} }, { id: 'b', name: 'B', type: 't', parameters: { v: '{{ $json.nope }}' } }], connections: [{ source: 'a', target: 'b', type: 'main' }] };
    expect(checkExpressionFields(wf, () => undefined, () => undefined)).toEqual([]);
    expect(checkExpressionFields(wf, () => undefined, (n) => (n.id === 'a' ? { fields: ['x'], from: 'outputSchema' } : undefined))).toHaveLength(1);
  });
  it('reads the output schema of the operation shown for the chosen resource', () => {
    const schema = (field: string) => ({ type: 'object', properties: { [field]: { type: 'string' } } });
    const descriptor = {
      name: 'multi', displayName: 'Multi', version: 1, kind: 'action', outputSchema: schema('node'),
      properties: [
        { name: 'resource', displayName: 'Resource', type: 'options', default: 'page', options: [{ name: 'Block', value: 'block' }, { name: 'Page', value: 'page' }] },
        { name: 'operation', displayName: 'Operation', type: 'options', default: 'append', displayOptions: { show: { resource: ['block'] } },
          options: [{ name: 'Append', value: 'append', outputSchema: schema('appended') }] },
        { name: 'operation', displayName: 'Operation', type: 'options', default: 'get', displayOptions: { show: { resource: ['page'] } },
          options: [{ name: 'Get', value: 'get' }, { name: 'Changed Since', value: 'changedSince', outputSchema: schema('sourceId') }] },
      ],
    } as unknown as Parameters<typeof outputSchemaOf>[0];
    expect(outputSchemaOf(descriptor, { resource: 'page', operation: 'changedSince' })).toEqual(schema('sourceId'));
    expect(outputSchemaOf(descriptor, { operation: 'changedSince' })).toEqual(schema('sourceId')); // the default resource
    expect(outputSchemaOf(descriptor, { resource: 'block' })).toEqual(schema('appended'));
    expect(outputSchemaOf(descriptor, { resource: 'page', operation: 'get' })).toEqual(schema('node'));
  });
});

describe('validate_workflow and get_node_type', () => {
  it('returns outputSchema from get_node_type', async () => {
    expect((await call('get_node_type', { type: 'dbgtest.writer' })).data.outputSchema.properties).toHaveProperty('snapshot');
    expect((await call('get_node_type', { type: 'dbgtest.plain' })).data).not.toHaveProperty('outputSchema');
  });

  it('catches a Code node reading $json.browserSnapshot after a node that writes snapshot', async () => {
    const draft = (code: string) => ({
      name: 'Fixture',
      nodes: [
        { name: 'Start', type: 'core.manualTrigger' },
        { name: 'Browser', type: 'dbgtest.writer' },
        { name: 'Parse', type: 'core.code', parameters: { code } },
      ],
      connections: [{ source: 'Start', target: 'Browser' }, { source: 'Browser', target: 'Parse' }],
    });
    const bad = (await call('validate_workflow', { workflow: draft('const s = $json.browserSnapshot;\nreturn [{ json: { s } }];') })).data;
    expect(bad.warnings.join('\n')).toMatch(/"Parse": \$json\.browserSnapshot reads the field "browserSnapshot", but "Browser" writes "url", "snapshot".*Did you mean "snapshot"/);
    const good = (await call('validate_workflow', { workflow: draft('// $json.browserSnapshot was the old name\nreturn [{ json: { s: $json.snapshot } }];') })).data;
    expect(good.warnings.filter((w: string) => /reads the field/.test(w))).toEqual([]);
  });

  it('checks {{ }} expressions, and stays quiet for a node with no schema and no run', async () => {
    const flow = (upstream: string) => ({
      name: 'Expr',
      nodes: [
        { name: 'Start', type: 'core.manualTrigger' },
        { name: 'Up', type: upstream },
        { name: 'Use', type: 'core.set', parameters: { mode: 'manual', fields: { values: [{ name: 'x', type: 'string', value: "{{ $('Up').item.json.nope }} {{ $json.nope2 }}" }] } } },
      ],
      connections: [{ source: 'Start', target: 'Up' }, { source: 'Up', target: 'Use' }],
    });
    const known = (await call('validate_workflow', { workflow: flow('dbgtest.writer') })).data;
    expect(known.warnings.filter((w: string) => /reads the field/.test(w))).toHaveLength(2);
    const unknown = (await call('validate_workflow', { workflow: flow('dbgtest.plain') })).data;
    expect(unknown.warnings.filter((w: string) => /reads the field/.test(w))).toEqual([]);
  });

  it('falls back to the last run of a saved workflow', async () => {
    save('wf_lastrun', [node('Start', 'core.manualTrigger'), node('Plain', 'dbgtest.plain'), node('Use', 'core.code', { code: 'return [{ json: { n: $json.cnt } }];' })], [link('Start', 'Plain'), link('Plain', 'Use')]);
    expect((await call('validate_workflow', { id: 'wf_lastrun' })).data.warnings.filter((w: string) => /reads the field/.test(w))).toEqual([]);
    expect((await call('execute_workflow', { id: 'wf_lastrun' })).data.nodes.map((n: { node: string }) => n.node)).toContain('Plain');
    const after = (await call('validate_workflow', { id: 'wf_lastrun' })).data;
    expect(after.warnings.join('\n')).toMatch(/\$json\.cnt reads the field "cnt", but "Plain" writes "count" \(from its last run\)\. Did you mean "count"/);
  });
});

describe('debug tools', () => {
  let failed = '';
  const flow = () =>
    save(
      'wf_boom',
      [node('Start', 'core.manualTrigger'), node('Writer', 'dbgtest.writer'), node('Boom', 'dbgtest.boom', { target: '{{ $json.snapshot }} {{ $vars.API_TOKEN }} {{ $json.url }}' })],
      [link('Start', 'Writer'), link('Writer', 'Boom')],
    );

  it('explains a failed execution in one call, redacted', async () => {
    variables.create({ key: 'API_TOKEN', value: SECRET });
    flow();
    const ran = (await call('execute_workflow', { id: 'wf_boom' })).data;
    expect(ran.status).toBe('error');
    failed = ran.id;

    const { data, raw } = await call('explain_failure', { id: failed });
    expect(data.failedNode).toMatchObject({ name: 'Boom', type: 'dbgtest.boom' });
    expect(data.error.message).toMatch(/401 unauthorized/);
    expect(data.sampleInput).toMatchObject({ snapshot: 'page text', url: 'http://page.test' });
    expect(data.inputItemCount).toBe(1);
    expect(data.upstream).toEqual([expect.objectContaining({ node: 'Writer', fields: ['url', 'snapshot'], declaredFields: ['url', 'snapshot'], outputItems: 1 })]);
    expect(data.resolvedParameters.target).toBe('page text [redacted] http://page.test');
    expect(data.whatToCheck.join('\n')).toMatch(/refused|credential/i);
    expect(raw).not.toContain(SECRET);
  });

  it('reads the trace, redacted', async () => {
    const { data, raw } = await call('get_run_trace', { id: failed });
    expect(data.events.length).toBeGreaterThan(0);
    expect(data.events.some((e: { type: string }) => e.type === 'span.started')).toBe(true);
    expect(raw).not.toContain(SECRET);
    const page = (await call('get_run_trace', { id: failed, limit: 1 })).data;
    expect(page.events).toHaveLength(1);
    expect(page.more).toBe(true);
    expect((await call('get_run_trace', { id: 'ex_nope' })).result.isError).toBe(true);
  });

  it('runs one node on a pinned input, and from an earlier execution', async () => {
    const pinned = (await call('run_node', { workflowId: 'wf_boom', node: 'Writer', input: { anything: 1 } })).data;
    expect(pinned).toMatchObject({ node: 'Writer', status: 'success', input: [{ anything: 1 }], output: [{ url: 'http://page.test', snapshot: 'page text' }] });
    const boom = await call('run_node', { workflowId: 'wf_boom', node: 'Boom', input: [{ snapshot: 'x', url: 'u' }] });
    expect(boom.data).toMatchObject({ node: 'Boom', status: 'error' });
    expect(boom.raw).not.toContain(SECRET);
    const replay = (await call('run_node', { workflowId: 'wf_boom', node: 'Boom', fromExecution: failed })).data;
    expect(replay).toMatchObject({ status: 'error', input: [{ snapshot: 'page text' }] });
    expect((await call('run_node', { workflowId: 'wf_boom', node: 'Nope' })).result.isError).toBe(true);
  });

  it('retries a failed execution as a linked new one', async () => {
    const retry = (await call('retry_execution', { id: failed })).data;
    expect(retry).toMatchObject({ retryOf: failed, status: 'error' });
    expect(retry.id).not.toBe(failed);
    expect(store.getExecution(failed)?.retriedBy).toBe(retry.id);
    const ok = (await call('execute_workflow', { id: 'wf_lastrun' })).data;
    expect((await call('retry_execution', { id: ok.id })).result.isError).toBe(true);
  });

  it('reports what it cannot give logs for', async () => {
    expect((await call('get_plugin_logs', { plugin: 'core.set' })).result.isError).toBe(true);
    const missing = await call('get_plugin_logs', { plugin: 'dbgtest.writer' });
    expect(missing.result.isError).toBe(true);
    expect(missing.raw).toMatch(/No installed node plugin/);
  });
});
