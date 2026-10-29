import { runNode, type ExecuteResponse, type INodeType, type JsonObject } from '@landflow/sdk';
import type { BinaryRef, ExecuteRequest } from '@landflow/protocol';
import { plugin } from '../src/main';

export interface RunOptions {
  continueOnFail?: boolean;
  binary?: Array<Record<string, BinaryRef> | undefined>;
}

export function request(type: string, parameters: JsonObject, items: JsonObject[], options: RunOptions = {}): ExecuteRequest {
  return {
    protocol: 'landflow.plugin/v1',
    executionId: 'ex_test',
    workflowId: 'wf_test',
    mode: 'manual',
    node: { id: 'n1', name: 'Node', type: `triage.${type}`, typeVersion: 1 },
    parameters,
    itemParameters: items.map(() => parameters),
    inputs: [items.map((json, i) => ({ json, ...(options.binary?.[i] && { binary: options.binary[i] }) }))],
    ...(options.continueOnFail && { continueOnFail: true }),
  };
}

export const run = (node: INodeType, parameters: JsonObject, items: JsonObject[], options: RunOptions = {}): Promise<ExecuteResponse> =>
  runNode(node, request(node.description.name, parameters, items, options), { credentialTypes: plugin.credentialTypes, pluginId: 'triage' });

export const jsonOf = (response: ExecuteResponse, output = 0) => response.outputs[output].map((item) => item.json as any);
