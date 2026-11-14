/** Request builders for the clickland plugin. Fake keys only; nothing here talks to a real service. */
import { runNode, runTestCredentials, type ExecuteRequest, type ExecuteResponse, type INodeType, type JsonObject } from '@landflow/sdk';
import { plugin } from '../src/main';
import { KEY, type FakeClickland } from './fake-clickland';

export interface RequestOptions {
  credentials?: Record<string, JsonObject>;
  items?: JsonObject[];
  mode?: ExecuteRequest['mode'];
  pollState?: JsonObject;
  continueOnFail?: boolean;
}

export function executeRequest(type: string, parameters: JsonObject, options: RequestOptions = {}): ExecuteRequest {
  const items = options.items ?? [{}];
  return {
    protocol: 'landflow.plugin/v1',
    executionId: 'ex_test',
    workflowId: 'wf_test',
    mode: options.mode ?? 'manual',
    node: { id: 'n1', name: 'Node', type: `clickland.${type}`, typeVersion: 1 },
    parameters,
    itemParameters: items.map(() => ({ ...parameters })),
    inputs: [items.map((json) => ({ json }))],
    ...(options.credentials && { credentials: options.credentials }),
    ...(options.pollState && { pollState: options.pollState }),
    ...(options.continueOnFail && { continueOnFail: true }),
  };
}

export const extras = { credentialTypes: plugin.credentialTypes, pluginId: 'clickland' };

export function run(node: INodeType, parameters: JsonObject, options: RequestOptions = {}): Promise<ExecuteResponse> {
  return runNode(node, executeRequest(node.description.name, parameters, options), extras);
}

export function testCredentials(data: JsonObject) {
  return runTestCredentials(plugin, { credentialType: 'clicklandApi', data });
}

export const jsonOf = (response: ExecuteResponse) => response.outputs[0].map((item) => item.json);

export const credentials = (fake: FakeClickland, overrides: JsonObject = {}): Record<string, JsonObject> => ({ clicklandApi: { baseUrl: fake.url, apiKey: KEY, ...overrides } });
