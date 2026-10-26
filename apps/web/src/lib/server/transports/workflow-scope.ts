/**
 * The transport overrides of the workflow a run belongs to (workflow settings `transports`, by plugin id), in scope for
 * the plugin calls the run makes: the runner puts them in scope around each segment (runner.ts), a sub-execution's
 * segment puts its own workflow's, and the registry's selection reads them (plugins/registry.ts). Calls outside a run
 * (the Plugins page, pickers, MCP tool calls of a plugin's endpoint) use the plugin's own policy.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { WorkflowTransportOverride } from '../../shared/transports';
import { singleton } from '../singleton';

export interface WorkflowTransportScope {
  workflowId: string;
  overrides: Record<string, WorkflowTransportOverride>;
}

const storage = () => singleton('workflow-transport-scope', () => new AsyncLocalStorage<WorkflowTransportScope>());

/** Run `fn` with a workflow's overrides in scope (none: an empty scope, so a parent run's overrides don't leak in). */
export function withWorkflowTransports<T>(workflowId: string, overrides: Record<string, WorkflowTransportOverride> | undefined, fn: () => T): T {
  return storage().run({ workflowId, overrides: overrides ?? {} }, fn);
}

/** The running workflow's override of `pluginId`'s policy, if it has one. */
export function workflowTransportOverride(pluginId: string): { workflowId: string; override: WorkflowTransportOverride } | undefined {
  const scope = storage().getStore();
  const override = scope?.overrides[pluginId];
  return scope && override ? { workflowId: scope.workflowId, override } : undefined;
}
