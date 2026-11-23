import { runNode, runWebhook, runWebhookMethod, runLoadOptions, type INodeType, type JsonObject } from '@landflow/sdk';
import type { ExecuteRequest, WebhookMethodName } from '@landflow/protocol';
import { plugin } from '../src/main';
import { clearMetadataCache } from '../src/odata/metadata';
import { resetWriteCounts } from '../src/session';
import { FakeS4 } from './fake-s4';

export const extras = { credentialTypes: plugin.credentialTypes, pluginId: 'sap' };

export const nodeNamed = (name: string): INodeType => {
  const node = plugin.nodes.find((n) => n.description.name === name);
  if (!node) throw new Error(`no node ${name}`);
  return node;
};

export const basicCredential = (fake: FakeS4, more: JsonObject = {}) => ({ sapS4hanaBasicApi: { baseUrl: fake.url, user: fake.user, password: fake.password, environment: 'test', ...more } });

export interface RunOptions {
  credentials?: Record<string, JsonObject>;
  mode?: ExecuteRequest['mode'];
  executionId?: string;
  continueOnFail?: boolean;
  pollState?: JsonObject;
  input?: JsonObject[];
}

export function request(node: INodeType, parameters: JsonObject, options: RunOptions = {}): ExecuteRequest {
  const input = options.input ?? [{}];
  const tool = options.mode === 'tool';
  const poll = options.mode === 'poll' || options.mode === 'manual';
  return {
    protocol: 'landflow.plugin/v1',
    executionId: options.executionId ?? 'ex_test',
    workflowId: 'wf_test',
    mode: options.mode ?? 'manual',
    node: { id: 'n1', name: node.description.displayName, type: `sap.${node.description.name}`, typeVersion: 1 },
    parameters,
    itemParameters: input.map((entry) => ({ ...parameters, ...(tool ? entry : {}) })),
    inputs: node.description.kind === 'trigger' ? [] : [input.map((json) => ({ json }))],
    ...(options.credentials && { credentials: options.credentials }),
    ...(options.continueOnFail && { continueOnFail: true }),
    ...(options.pollState && { pollState: options.pollState }),
    ...(poll && {}),
  } as ExecuteRequest;
}

export async function run(name: string, parameters: JsonObject, options: RunOptions = {}) {
  const node = nodeNamed(name);
  const response = await runNode(node, request(node, parameters, options), extras);
  return {
    response,
    items: ((response.outputs?.[0] ?? []) as Array<{ json: JsonObject }>).map((i) => i.json),
    error: response.error,
    pollState: response.pollState as JsonObject | undefined,
    logs: response.logs ?? [],
  };
}

/** The agent-tool call of the engine: arguments become the item and override same-named parameters. */
export async function runAsTool(name: string, parameters: JsonObject, args: JsonObject, options: RunOptions = {}) {
  const node = nodeNamed(name);
  const names = new Set(node.description.properties.map((p) => p.name));
  const overrides = Object.fromEntries(Object.entries(args).filter(([key]) => names.has(key)));
  const req = request(node, { ...parameters, ...overrides }, { ...options, mode: 'tool', input: [args] });
  req.itemParameters = [{ ...parameters, ...overrides }];
  const response = await runNode(node, req, extras);
  return { response, items: ((response.outputs?.[0] ?? []) as Array<{ json: JsonObject }>).map((i) => i.json), error: response.error };
}

export async function webhookMethod(name: string, method: WebhookMethodName, parameters: JsonObject, credentials: Record<string, JsonObject>, staticData: JsonObject = {}) {
  const node = nodeNamed(name);
  return runWebhookMethod(
    node,
    { protocol: 'landflow.plugin/v1', method, workflowId: 'wf_test', node: { id: 'n1', name: 'SAP Event', type: `sap.${name}`, typeVersion: 1 }, parameters, credentials, webhookUrl: 'http://host.test/api/webhook/app/wf_test/n1', staticData },
    extras,
  );
}

export async function deliver(name: string, parameters: JsonObject, credentials: Record<string, JsonObject>, headers: Record<string, string>, body: string, method = 'POST') {
  const node = nodeNamed(name);
  return runWebhook(
    node,
    {
      protocol: 'landflow.plugin/v1',
      workflowId: 'wf_test',
      node: { id: 'n1', name: 'SAP Event', type: `sap.${name}`, typeVersion: 1 },
      parameters,
      credentials,
      webhookUrl: 'http://host.test/api/webhook/app/wf_test/n1',
      staticData: {},
      request: { method, path: '/api/webhook/app/wf_test/n1', headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])), query: {}, body: Buffer.from(body).toString('base64') },
    },
    extras,
  );
}

export const loadOptions = (name: string, method: string, parameters: JsonObject, credentials?: Record<string, JsonObject>) => runLoadOptions(nodeNamed(name), method, parameters, credentials, extras);

export function freshState() {
  clearMetadataCache();
  resetWriteCounts();
}

export const SALES = { authentication: 'basic', service: 'API_SALES_ORDER_SRV', entitySet: 'A_SalesOrder' };
