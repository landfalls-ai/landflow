/**
 * Workflow saves under governance, for the routes and tools that save workflows (POST/PUT /api/workflows, import,
 * MCP tools): `governedSave()` holds an `active` switch that four-eyes publishing or the node policy doesn't let
 * through (./approvals `holdActivation`), saves, asks for approval when it held one, records the audit event
 * (`workflow.create` / `workflow.update`), and returns what the response adds: `policyWarnings` (nodes the policy
 * doesn't allow: the save stands, publishing is refused), `triggerAuthWarnings` (an update whose Webhook, Form or MCP
 * Server trigger checks callers with a credential the workflow's project can't use: its calls get 403,
 * lib/server/projects/credentials.ts), `publishRequest` and `activationRefused`.
 * Policies off: the save is exactly the plain one, plus the audit event.
 */
import type { Workflow } from '@landflow/engine';
import type { PolicyViolation, PublishRequestView } from '../../shared/governance';
import { recordAudit } from '../audit';
import { triggerAuthWarnings, type TriggerAuthWarning } from '../projects/credentials';
import { holdActivation, requestHeld } from './approvals';
import { workflowViolations } from './policy';

export interface SaveExtras {
  policyWarnings?: PolicyViolation[];
  /** Triggers whose authentication credential the workflow's project can't use (their calls are refused). */
  triggerAuthWarnings?: TriggerAuthWarning[];
  /** Four-eyes: the publish or unpublish the save asked for. */
  publishRequest?: PublishRequestView;
  /** Why `active` was not switched (the policy, or a request that couldn't be made). */
  activationRefused?: string;
}

export function governedSave<T extends Workflow>(next: T, existing: Workflow | undefined, save: (workflow: T) => T, options: { by?: string; source?: string; action?: string } = {}): { workflow: T; extras: SaveExtras } {
  const governed = holdActivation(next, existing);
  const workflow = save(governed.workflow);
  const extras: SaveExtras = {};
  if (governed.blocked) extras.activationRefused = governed.blocked;
  if (governed.held) {
    const asked = requestHeld(governed.held, workflow.id, options.by, governed.held === 'publish' ? 'Activated (approval needed)' : 'Deactivated (approval needed)');
    if (asked.request) extras.publishRequest = asked.request;
    if (asked.error) extras.activationRefused = asked.error;
  }
  const violations = workflowViolations(workflow);
  if (violations.length) extras.policyWarnings = violations;
  // Updates only: a new workflow gets its project after this save.
  const unusable = existing ? triggerAuthWarnings(workflow) : [];
  if (unusable.length) extras.triggerAuthWarnings = unusable;
  recordAudit({
    action: options.action ?? (existing ? 'workflow.update' : 'workflow.create'),
    target: { type: 'workflow', id: workflow.id, name: workflow.name },
    details: {
      nodes: workflow.nodes?.length ?? 0,
      ...(options.source && { source: options.source }),
      ...(Boolean(existing?.active) !== Boolean(workflow.active) && { active: Boolean(workflow.active) }),
      ...(extras.publishRequest && { publishRequestId: extras.publishRequest.id }),
      ...(violations.length && { policyWarnings: violations.length }),
    },
  });
  return { workflow, extras };
}
