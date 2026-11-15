/**
 * The workflow node a model call runs under (wave 11, SP01). The engine's `aroundNode` hook opens it around a node's
 * work and a sub-node's, so a call made by a sub-node, a tool or a sub-workflow's own node names the innermost node.
 * It does not depend on OpenTelemetry's context manager (off under OTEL_SDK_DISABLED and in tests).
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { singleton } from '../singleton';

export interface ActiveNode {
  id: string;
  name: string;
  type: string;
}

const storage = singleton('ai-active-node', () => new AsyncLocalStorage<ActiveNode>());

/** Run `fn` with `node` as the innermost active node. */
export function runInNode<T>(node: ActiveNode, fn: () => Promise<T>): Promise<T> {
  return storage.run(node, fn);
}

/** The innermost node running now, if any. */
export const activeNode = (): ActiveNode | undefined => storage.getStore();
