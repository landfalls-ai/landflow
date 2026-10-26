/**
 * Approvers per project role: a project's settings (./scopes.ts `approvers`) say who approves the publish requests of
 * its workflows: its admins, its admins and editors, or instance owners and admins only (`default`: the instance's
 * rule alone). It plugs into four-eyes publishing through `registerApproverCheck` (./approvals.ts), so it only ever
 * narrows the instance's approver role, and nobody approves their own request. Registered once per process, the
 * first time anyone asks who may approve.
 */
import { database } from '../db';
import { isInstanceAdmin, projectRole } from '../projects/access';
import { getProject, homeProjectId } from '../projects/store';
import { singleton } from '../singleton';
import { registerApproverCheck, type ApproverCheck } from './approvals';
import { getProjectSettings } from './scopes';

/** The check: false when the project's setting leaves `user` out, undefined when the project has no say. */
export const projectApproverCheck: ApproverCheck = (user, workflowId) => {
  // Only workflows (other kinds of requests, such as promotions, follow the instance's rule).
  if (!database().get('SELECT id FROM workflows WHERE id = ?', workflowId)) return undefined;
  const projectId = homeProjectId('workflow', workflowId);
  const { approvers } = getProjectSettings(projectId);
  if (approvers === 'default') return undefined;
  if (approvers === 'instance') return isInstanceAdmin(user);
  const role = projectRole(user, projectId);
  return approvers === 'admins' ? role === 'admin' : role === 'admin' || role === 'editor';
};

/** Register the check (idempotent). */
export function ensureProjectApprovers() {
  const state = singleton('project-approver-check', () => ({ registered: false }));
  if (state.registered) return;
  state.registered = true;
  registerApproverCheck(projectApproverCheck);
}

/** Who approves `workflowId`'s requests by its project's setting, for refusals ("an admin of “Data”"); undefined: the instance's rule. */
export function projectApproverLabel(workflowId: string): string | undefined {
  if (!database().get('SELECT id FROM workflows WHERE id = ?', workflowId)) return undefined;
  const projectId = homeProjectId('workflow', workflowId);
  const { approvers } = getProjectSettings(projectId);
  const name = getProject(projectId ?? '')?.name ?? 'its project';
  if (approvers === 'admins') return `an admin of “${name}”`;
  if (approvers === 'editors') return `an admin or editor of “${name}”`;
  if (approvers === 'instance') return 'an owner or admin of the instance';
  return undefined;
}
