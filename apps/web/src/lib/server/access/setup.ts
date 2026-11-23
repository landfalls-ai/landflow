/**
 * Setting access requests up (docs/access-requests.md#setting-up): one admin click installs the two templates into a project,
 * publishes them and writes the settings key that names them. Only the installed request flow handles requests. Idempotent.
 */
import { recordAudit } from '../audit';
import { mailConfigured } from '../auth/mail';
import { database } from '../db';
import { creationProject, isInstanceAdmin, type Actor } from '../projects/access';
import { createIn } from '../projects/http';
import { publishDraft } from '../publish';
import { store } from '../store';
import { useTemplate } from '../templates';
import type { Workflow } from '../../shared/types';
import type { AccessSetup } from '../../shared/access';
import { AccessError } from './errors';
import { auditActorOf } from './rules';
import { lockedAccessFlows } from './guard';
import { accessSettings, saveAccessSettings } from './store';
import { accessFlow, resetAccessTrigger } from './trigger';

export const ACCESS_TEMPLATE = 'access-requests';
export const ACCESS_CHAT_TEMPLATE = 'access-requests-chat';

export function accessSetup(): AccessSetup {
  const settings = accessSettings();
  const workflow = settings.workflowId ? store.getWorkflow(settings.workflowId) : undefined;
  const installed = Boolean(workflow);
  return {
    installed,
    active: Boolean(installed && accessFlow(settings.workflowId)),
    ...(installed && settings.workflowId && { workflowId: settings.workflowId }),
    ...(settings.chatWorkflowId && store.getWorkflow(settings.chatWorkflowId) && { chatWorkflowId: settings.chatWorkflowId }),
    ...(settings.projectId && { projectId: settings.projectId }),
    mail: mailConfigured(),
    // Said on the setup screen: the flows are what decides who gets access.
    flowsAdminOnly: true,
    lockedWorkflowIds: lockedAccessFlows(),
  };
}

export interface InstallInput {
  projectId?: string;
  /** The chat template's model credential (optional: without it the chat flow is installed without a model). */
  modelCredentialId?: string;
}

async function install(actor: Actor, template: string, projectId: string | undefined, credentials?: Record<string, string | null>): Promise<string> {
  const result = await useTemplate(template, { ...(credentials && { credentials }) }, {
    ...(projectId && { projectId }),
    createWorkflow: (save, workflowId) => createIn(projectId, 'workflow', save, (w: Workflow) => w.id, workflowId),
    createTable: (create) => create(),
  });
  const id = result.workflow?.id;
  if (!id) throw new AccessError('The access template made no workflow', 500);
  // With the host's SMTP the approvers get signed links by email; without it the question waits in Needs you.
  if (template === ACCESS_TEMPLATE && mailConfigured() && result.workflow) {
    const saved = store.getWorkflow(id) ?? result.workflow;
    store.saveWorkflow({ ...saved, nodes: saved.nodes.map((n) => (n.type === 'core.confirmDraft' ? { ...n, parameters: { ...n.parameters, channel: 'email' } } : n)) }, { actor: actor.id });
  }
  await publishDraft(id, actor.id);
  return id;
}

export async function installAccessRequests(actor: Actor, input: InstallInput = {}): Promise<AccessSetup> {
  if (!isInstanceAdmin(actor)) throw new AccessError('Only an admin sets up access requests', 403);
  const settings = accessSettings();
  const projectId = settings.projectId ?? creationProject(actor, input.projectId);
  let { workflowId, chatWorkflowId } = settings;
  if (workflowId && store.getWorkflow(workflowId)) {
    if (!accessFlow(workflowId)) await publishDraft(workflowId, actor.id);
  } else workflowId = await install(actor, ACCESS_TEMPLATE, projectId);
  if (!chatWorkflowId || !store.getWorkflow(chatWorkflowId)) {
    try {
      chatWorkflowId = await install(actor, ACCESS_CHAT_TEMPLATE, projectId, input.modelCredentialId ? { anthropic: input.modelCredentialId } : undefined);
    } catch {
      // The chat is optional (it needs a model credential); the form works without it.
      chatWorkflowId = undefined;
    }
  }
  saveAccessSettings({ workflowId, ...(chatWorkflowId && { chatWorkflowId }), ...(projectId && { projectId }) });
  resetAccessTrigger();
  recordAudit({ action: 'access.setup', actor: auditActorOf(actor), target: { type: 'access_setup', id: 'access_requests' }, project: null, summary: 'Set up access requests', details: { from: null, to: JSON.stringify({ workflowId, chatWorkflowId: chatWorkflowId ?? null }) } });
  return accessSetup();
}
