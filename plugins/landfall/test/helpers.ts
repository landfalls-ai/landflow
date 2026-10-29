/** Request builders for the landfall plugin. Fake tokens only; nothing here talks to a real service. */
import { runTestCredentials, runNode, type ExecuteRequest, type ExecuteResponse, type INodeType, type JsonObject } from '@landflow/sdk';
import { plugin } from '../src/main';
import { SEED, type FakeLandfall } from './fake-landfall';

export interface RequestOptions {
  credentials?: Record<string, JsonObject>;
  items?: JsonObject[];
  perItem?: JsonObject[];
  mode?: ExecuteRequest['mode'];
  pollState?: JsonObject;
  continueOnFail?: boolean;
  signal?: AbortSignal;
}

export function executeRequest(type: string, parameters: JsonObject, options: RequestOptions = {}): ExecuteRequest {
  const items = options.items ?? [{}];
  return {
    protocol: 'landflow.plugin/v1',
    executionId: 'ex_test',
    workflowId: 'wf_test',
    mode: options.mode ?? 'manual',
    node: { id: 'n1', name: 'Node', type: `landfall.${type}`, typeVersion: 1 },
    parameters,
    itemParameters: items.map((_, i) => ({ ...parameters, ...(options.perItem?.[i] ?? {}) })),
    inputs: [items.map((json) => ({ json }))],
    ...(options.credentials && { credentials: options.credentials }),
    ...(options.pollState && { pollState: options.pollState }),
    ...(options.continueOnFail && { continueOnFail: true }),
  };
}

const extras = { credentialTypes: plugin.credentialTypes, pluginId: 'landfall' };

export function run(node: INodeType, parameters: JsonObject, options: RequestOptions = {}): Promise<ExecuteResponse> {
  return runNode(node, executeRequest(node.description.name, parameters, options), { ...extras, ...(options.signal && { signal: options.signal }) });
}

export function testCredentials(credentialType: string, data: JsonObject) {
  return runTestCredentials(plugin, { credentialType, data });
}

/** The JSON of every item on output 0. */
export const jsonOf = (response: ExecuteResponse) => response.outputs[0].map((item) => item.json);

export const landfallCredentials = (fake: FakeLandfall, overrides: JsonObject = {}): Record<string, JsonObject> => ({
  landfallApi: { baseUrl: fake.url, orgSlug: SEED.orgSlug, apiKey: SEED.apiKey, ingestToken: SEED.ingestToken, connectionId: SEED.connectionId, ...overrides },
});

export const heartbeatCredentials = (fake: FakeLandfall, overrides: JsonObject = {}): Record<string, JsonObject> => ({
  landfallHeartbeatApi: { baseUrl: fake.url, orgSlug: SEED.orgSlug, token: SEED.heartbeatToken, ...overrides },
});
