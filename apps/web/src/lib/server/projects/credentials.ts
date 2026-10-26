/**
 * Credentials in runs: a workflow may only use the credentials its project can use (owned by the project or shared
 * with it, see `credentialUsableBy`). The runner, poll triggers, app webhook triggers and the MCP Server Trigger
 * resolve a node's credentials through `resolveWorkflowCredentials`, which fails the node otherwise. The secret
 * values only ever go to the node; a shared credential is never readable through the API.
 *
 * The same rule covers the credential a trigger checks its callers with (Webhook and Form trigger Basic, Header and JWT
 * Auth, the MCP Server Trigger's Bearer and Header Auth): a call is refused when the workflow's project can't use it
 * (lib/server/webhook-auth.ts, lib/server/mcp/trigger.ts), and saving such a workflow warns (`triggerAuthWarnings`).
 */
import type { NodeDescriptor } from '@landflow/protocol';
import type { Workflow, WorkflowNode } from '@landflow/engine';
import { CredentialError, credentials } from '../credentials/vault';
import { credentialUsableBy } from './access';
import { homeProjectId } from './store';

type CredentialNode = Pick<WorkflowNode, 'type' | 'credentials'> & { parameters?: Record<string, unknown> };

/** Throws a CredentialError when one of `names` (the node's credential slots) holds a credential the workflow's project can't use. */
export function assertCredentialsUsable(workflowId: string, node: Pick<WorkflowNode, 'credentials'>, names: Iterable<string> = Object.keys(node.credentials ?? {})) {
  const project = homeProjectId('workflow', workflowId);
  for (const name of names) {
    const ref = node.credentials?.[name];
    if (ref?.id && !credentialUsableBy(ref.id, project)) {
      throw new CredentialError(`Credential "${ref.name}" isn’t available to this workflow’s project — share it with the project or choose another one`, 403);
    }
  }
}

/** `credentials.resolveFor` for a node of `workflowId`: only the credentials its project may use. */
export function resolveWorkflowCredentials(workflowId: string, node: CredentialNode, descriptor: NodeDescriptor, lenient = false) {
  const resolved = credentials.resolveFor(node, descriptor, lenient);
  assertCredentialsUsable(workflowId, node, Object.keys(resolved));
  return resolved;
}

/** The credential slot each trigger authentication reads (Webhook, Form and MCP Server Trigger; n8n's names). */
const TRIGGER_AUTH_SLOTS: Record<string, Record<string, string>> = {
  'core.webhook': { basicAuth: 'httpBasicAuth', headerAuth: 'httpHeaderAuth', jwtAuth: 'jwtAuth' },
  'core.formTrigger': { basicAuth: 'httpBasicAuth', headerAuth: 'httpHeaderAuth', jwtAuth: 'jwtAuth' },
  'core.mcpTrigger': { bearerAuth: 'httpBearerAuth', headerAuth: 'httpHeaderAuth' },
};

/** The credential a trigger node checks its callers with, when its authentication uses one. */
export function triggerAuthCredential(node: CredentialNode): { slot: string; id: string } | undefined {
  const slot = TRIGGER_AUTH_SLOTS[node.type]?.[String(node.parameters?.authentication ?? 'none')];
  const id = slot ? node.credentials?.[slot]?.id : undefined;
  return slot && id ? { slot, id } : undefined;
}

/** Whether the workflow's project may use the credential a trigger checks its callers with (true without one). */
export function triggerAuthUsable(workflowId: string, node: CredentialNode): boolean {
  const used = triggerAuthCredential(node);
  return !used || credentialUsableBy(used.id, homeProjectId('workflow', workflowId));
}

export interface TriggerAuthWarning {
  nodeId: string;
  nodeName: string;
  message: string;
}

/** Saving: the (enabled) triggers whose authentication credential the workflow's project can't use, so their calls would be refused. */
export function triggerAuthWarnings(workflow: Pick<Workflow, 'id' | 'nodes'>): TriggerAuthWarning[] {
  return (workflow.nodes ?? [])
    .filter((node) => !node.disabled && !triggerAuthUsable(workflow.id, node))
    .map((node) => ({
      nodeId: node.id,
      nodeName: node.name,
      message: 'Its authentication credential isn’t available to this workflow’s project: calls will be refused (403) until it is shared with the project or another one is chosen',
    }));
}
