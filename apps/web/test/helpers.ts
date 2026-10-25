/**
 * Test helpers: run a core node in-process through the SDK's runNode, or a
 * small workflow through the engine (expressions per item, sub-node wiring).
 */
import { runNode, type ConnectionType, type ExecuteRequest, type INodeType, type JsonObject, type NodeItem } from '@landflow/sdk';
import { executeWorkflow, inProcessNodeType, type ExecutionResult, type NodeTypeResolver, type WorkflowConnection, type WorkflowNode } from '@landflow/engine';
import { corePlugin } from '@/lib/server/nodes';

/** Test input: plain objects (fixtures may leave keys out, which JsonObject's index signature rejects). */
export type Input = Array<Record<string, unknown>>;

export const items = (...list: Input): NodeItem[] => list.map((json) => ({ json: json as JsonObject }));

/** One node, the same parameters for every item (no expressions), main input 0 = `input`. */
export async function run(node: INodeType, parameters: Record<string, unknown>, input: Input = [{}], credentials?: Record<string, JsonObject>) {
  const request: ExecuteRequest = {
    protocol: 'landflow.plugin/v1',
    executionId: 'ex_test',
    workflowId: 'wf_test',
    mode: 'manual',
    node: { id: 'n1', name: node.description.displayName, type: `core.${node.description.name}`, typeVersion: 1 },
    parameters: parameters as JsonObject,
    itemParameters: input.map(() => parameters as JsonObject),
    inputs: [items(...input)],
    ...(credentials && { credentials }),
  };
  const response = await runNode(node, request);
  return { ...response, json: (output = 0) => (response.outputs[output] ?? []).map((item) => item.json) };
}

/** Same, but fails the test with the node's error message. */
export async function runOk(node: INodeType, parameters: Record<string, unknown>, input: Input = [{}], credentials?: Record<string, JsonObject>) {
  const result = await run(node, parameters, input, credentials);
  if (result.error) throw new Error(`${result.error.message}${result.error.description ? ` (${result.error.description})` : ''}`);
  return result;
}

export interface FlowNode {
  name: string;
  /** "core.x" or "test.x" (from `extra`). */
  type: string;
  parameters?: Record<string, unknown>;
  credentials?: Record<string, JsonObject>;
}

/** [source, target, type = main, sourceIndex = 0, targetIndex = 0] */
export type FlowEdge = [string, string, ConnectionType?, number?, number?];

/** A workflow with a manual trigger named "Start" that receives `input`. */
export async function runFlow(
  nodes: FlowNode[],
  edges: FlowEdge[],
  options: { input?: Input; extra?: Record<string, INodeType>; variables?: Record<string, string> } = {},
): Promise<ExecutionResult> {
  const all: FlowNode[] = [{ name: 'Start', type: 'core.manualTrigger' }, ...nodes];
  const resolver: NodeTypeResolver = {
    resolve(type) {
      const [pluginId, name] = type.split('.');
      const node = pluginId === 'core' ? corePlugin.nodes.find((n) => n.description.name === name) : options.extra?.[name];
      return node ? inProcessNodeType(pluginId, node) : { error: `Unknown node type ${type}` };
    },
  };
  const workflowNodes: WorkflowNode[] = all.map((node, index) => ({
    id: node.name,
    name: node.name,
    type: node.type,
    typeVersion: 1,
    position: [index * 220, index * 10],
    parameters: node.parameters ?? {},
  }));
  const connections: WorkflowConnection[] = edges.map(([source, target, type = 'main', sourceIndex = 0, targetIndex = 0], index) => ({
    id: `e${index}`,
    type,
    source,
    target,
    sourceIndex,
    targetIndex,
  }));
  return executeWorkflow({
    workflow: { id: 'wf_test', name: 'Test', nodes: workflowNodes, connections },
    resolver,
    executionId: `ex_${Math.random().toString(36).slice(2)}`,
    mode: 'manual',
    triggerItems: items(...(options.input ?? [{}])),
    resolveCredentials: (node) => all.find((n) => n.name === node.name)?.credentials,
    ...(options.variables && { variables: options.variables }),
  });
}

/** JSON of every output of a node's last main run. */
export function outputsOf(result: ExecutionResult, name: string): JsonObject[][] {
  const runs = (result.runData[name] ?? []).filter((r) => r.source === 'main');
  const last = runs[runs.length - 1];
  if (!last) throw new Error(`"${name}" did not run${result.error ? `: ${result.error.message}` : ''}`);
  if (last.error) throw new Error(`"${name}" failed: ${last.error.message} ${last.error.description ?? ''}`);
  return last.outputs.map((branch) => branch.map((item) => item.json));
}
