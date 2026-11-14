/** Request builders for the landledger plugin. Fake keys only; nothing here talks to a real service. */
import { runNode, runTestCredentials, type ExecuteRequest, type ExecuteResponse, type INodeType, type JsonObject } from '@landflow/sdk';
import { plugin } from '../src/main';
import { KEY, type FakeLandledger } from './fake-landledger';

export interface RequestOptions {
  credentials?: Record<string, JsonObject>;
  items?: JsonObject[];
  mode?: ExecuteRequest['mode'];
  continueOnFail?: boolean;
  idempotencyKey?: string;
}

export function executeRequest(type: string, parameters: JsonObject, options: RequestOptions = {}): ExecuteRequest {
  const items = options.items ?? [{}];
  return {
    protocol: 'landflow.plugin/v1',
    executionId: 'ex_test',
    workflowId: 'wf_test',
    mode: options.mode ?? 'manual',
    node: { id: 'n1', name: 'Node', type: `landledger.${type}`, typeVersion: 1 },
    parameters,
    itemParameters: items.map(() => ({ ...parameters })),
    inputs: [items.map((json) => ({ json }))],
    ...(options.credentials && { credentials: options.credentials }),
    ...(options.continueOnFail && { continueOnFail: true }),
    ...(options.idempotencyKey && { idempotencyKey: options.idempotencyKey }),
  };
}

export const extras = { credentialTypes: plugin.credentialTypes, pluginId: 'landledger' };

export function run(node: INodeType, parameters: JsonObject, options: RequestOptions = {}): Promise<ExecuteResponse> {
  return runNode(node, executeRequest(node.description.name, parameters, options), extras);
}

export function testCredentials(data: JsonObject) {
  return runTestCredentials(plugin, { credentialType: 'landledgerApi', data });
}

export const jsonOf = (response: ExecuteResponse) => response.outputs[0].map((item) => item.json);

export const credentials = (fake: FakeLandledger, overrides: JsonObject = {}): Record<string, JsonObject> => ({ landledgerApi: { baseUrl: fake.url, apiKey: KEY, webhookSecret: '', ...overrides } });
