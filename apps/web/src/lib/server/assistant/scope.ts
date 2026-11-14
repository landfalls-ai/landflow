/**
 * The node types the assistant may use for a workflow: those online, minus what the governance policy blocks for the
 * instance, the workflow's project and the workflow itself. The same filter the node creator gets from
 * `/api/node-types?workflowId=`, so the assistant never proposes a node the user couldn't add by hand.
 */
import type { NodeTypeInfo } from '@/lib/shared/types';
import { getGovernancePolicy, scopeFor, scopedNodeBlocked } from '../governance/policy';
import { canResource, type Actor } from '../projects';
import { routeActor } from '../projects/http';
import { availableTypes } from './research';

/** The workflow id to meter Spotlight's usage under: only one the caller can read, so nobody books use on another's workflow. */
export function meteredWorkflowId(workflowId: string | undefined, actor: Actor = routeActor()): string | undefined {
  return workflowId && canResource(actor, 'workflow', workflowId, 'read') ? workflowId : undefined;
}

export function allowedTypes(workflowId?: string, actor: Actor = routeActor()): NodeTypeInfo[] {
  const scope = scopeFor(workflowId && canResource(actor, 'workflow', workflowId, 'read') ? { workflowId } : undefined);
  const policy = getGovernancePolicy();
  return availableTypes().filter((t) => !scopedNodeBlocked(t.type, policy, scope));
}
