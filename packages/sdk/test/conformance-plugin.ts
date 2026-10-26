/**
 * The conformance plugin every runner embeds (packages/protocol/conformance/README.md "The conformance plugin"): fixed
 * behaviour so the fixtures can predict replies, plus hooks the runners read (`executions`, the abort flags, counters).
 */
import { loadConformancePluginManifest } from '@landflow/protocol/conformance';
import { defineCredentialType, defineNode, definePlugin, NodeOperationError, type IExecuteContext } from '../src';

export const CONFORMANCE_PLUGIN_ID = 'landflow-conformance';

/** What the runners observe about node runs. */
export const hooks = {
  /** Node executions so far (every node), and per node name. */
  executions: 0,
  byNode: new Map<string, number>(),
  ran(node: string) {
    this.executions++;
    this.byNode.set(node, (this.byNode.get(node) ?? 0) + 1);
  },
  /** Per `sleep` run: did its abort signal fire? */
  sleeps: [] as { aborted: boolean }[],
  counters: new Map<string, number>(),
  reset() {
    this.executions = 0;
    this.byNode.clear();
    this.sleeps = [];
    this.counters.clear();
  },
};

const wait = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(timer), reject(signal.reason)), { once: true });
  });

const manifest = loadConformancePluginManifest();
const descriptor = (name: string) => {
  const node = manifest.nodes.find((n) => n.name === name);
  if (!node) throw new Error(`conformance manifest has no node "${name}"`);
  return node;
};

const echo = defineNode({
  description: descriptor('echo'),
  execute(ctx: IExecuteContext) {
    hooks.ran('echo');
    const message = ctx.getNodeParameter<string>('message', 0, '');
    const items = ctx.getInputData();
    return items.length ? items.map((item) => ({ json: { ...item.json, echo: message } })) : [{ json: { echo: message } }];
  },
});

const sleep = defineNode({
  description: descriptor('sleep'),
  async execute(ctx: IExecuteContext) {
    hooks.ran('sleep');
    const record = { aborted: false };
    hooks.sleeps.push(record);
    ctx.signal?.addEventListener('abort', () => (record.aborted = true), { once: true });
    const ms = ctx.getNodeParameter<number>('ms', 0, 100);
    try {
      await wait(ms, ctx.signal);
    } catch {
      throw new NodeOperationError('canceled');
    }
    return [{ json: { sleptMs: ms } }];
  },
});

const fail = defineNode({
  description: descriptor('fail'),
  execute(ctx: IExecuteContext) {
    hooks.ran('fail');
    const itemIndex = ctx.getNodeParameter<number>('itemIndex', 0, -1);
    throw new NodeOperationError(ctx.getNodeParameter<string>('message', 0, 'boom'), itemIndex >= 0 ? { itemIndex } : {});
  },
});

const payload = defineNode({
  description: descriptor('payload'),
  execute(ctx: IExecuteContext) {
    hooks.ran('payload');
    return [{ json: { data: 'x'.repeat(ctx.getNodeParameter<number>('bytes', 0, 1024)) } }];
  },
});

const counter = defineNode({
  description: descriptor('counter'),
  execute(ctx: IExecuteContext) {
    hooks.ran('counter');
    const key = ctx.getNodeParameter<string>('key', 0, 'default');
    const count = (hooks.counters.get(key) ?? 0) + 1;
    hooks.counters.set(key, count);
    return [{ json: { key, count } }];
  },
});

const tick = defineNode({ description: descriptor('tick'), execute: () => [] });
const hidden = defineNode({
  description: descriptor('hidden'),
  execute(ctx: IExecuteContext) {
    hooks.ran('hidden');
    return [{ json: { field: ctx.getNodeParameter<string>('field', 0, '') } }];
  },
});

const conformanceApi = defineCredentialType({
  name: 'conformanceApi',
  displayName: 'Conformance API',
  properties: [{ name: 'token', displayName: 'Token', type: 'string', required: true, typeOptions: { password: true } }],
  test: (data) => ({ ok: data.token === 't', message: data.token === 't' ? 'ok' : 'bad token' }),
});

export const conformancePlugin = definePlugin({
  info: { id: CONFORMANCE_PLUGIN_ID, name: manifest.plugin.name, version: manifest.plugin.version, description: manifest.plugin.description },
  nodes: [echo, sleep, fail, payload, counter, tick, hidden],
  credentialTypes: [conformanceApi],
});
