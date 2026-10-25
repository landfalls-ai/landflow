import { runNode, runWebhook, runWebhookMethod, type INodeType, createExecuteContext } from '@landflow/sdk';
import { qualifyType } from '@landflow/protocol';
import type { ResolvedNodeType } from './types';

/** Adapt an INodeType living in this process to the engine's ResolvedNodeType. */
export function inProcessNodeType(pluginId: string, node: INodeType): ResolvedNodeType {
  const resolved: ResolvedNodeType = {
    type: qualifyType(pluginId, node.description.name),
    pluginId,
    transport: 'in-process',
    descriptor: node.description,
    execute: (request, extras) => runNode(node, request, extras),
  };
  if (node.supplyData) {
    resolved.supplyData = async (request, extras) => node.supplyData!(createExecuteContext(node, request, [], extras));
  }
  if (node.webhookMethods) resolved.webhookMethod = (request) => runWebhookMethod(node, request, { pluginId });
  if (node.webhook) resolved.webhook = (request) => runWebhook(node, request, { pluginId });
  return resolved;
}
