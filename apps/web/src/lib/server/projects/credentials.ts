/**
 * Credentials in runs: a workflow may only use the credentials its project can use (owned by the project or shared
 * with it, see `credentialUsableBy`). The runner, poll triggers, app webhook triggers and the MCP Server Trigger
 * resolve a node's credentials through `resolveWorkflowCredentials`, which fails the node otherwise. The secret
 * values only ever go to the node; a shared credential is never readable through the API.
 */
import type { NodeDescriptor } from '@landflow/protocol';
import type { WorkflowNode } from '@landflow/engine';
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
