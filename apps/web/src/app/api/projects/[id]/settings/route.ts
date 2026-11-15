/**
 * A project's settings (lib/server/governance/scopes.ts): the plugins and node types its workflows may use (an
 * optional allow-list under the instance's governance policy) and who approves its publish requests.
 * GET — `{ settings, canEdit, plugins, nodeTypes }` (the project's members).
 * PATCH { nodes?: { mode?, plugins?, types? }, approvers? } — its admins (and instance owners and admins).
 */
import { recordAudit } from '@/lib/server/audit';
import { ensureProjectApprovers } from '@/lib/server/governance/project-approvers';
import { getProjectSettings, projectSettingsPatchSchema, updateProjectSettings } from '@/lib/server/governance/scopes';
import { agentStore } from '@/lib/server/agents/store';
import { assertAgentSettingsPatch, availableAgentsView } from '@/lib/server/project-context/project-settings';
import { json, parseBody } from '@/lib/server/http';
import { registry } from '@/lib/server/plugins/registry';
import { projectRoute, requireProject, routeActor } from '@/lib/server/projects/http';
import { projectRoleCan } from '@/lib/shared/projects';
import type { ProjectSettingsView } from '@/lib/shared/project-policy';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

function view(projectId: string, canEdit: boolean): ProjectSettingsView {
  const types = registry.nodeTypes();
  return {
    settings: getProjectSettings(projectId),
    canEdit,
    plugins: [...new Map(types.map((t) => [t.pluginId, { id: t.pluginId, name: t.pluginName }])).values()],
    nodeTypes: types.map((t) => ({ type: t.type, displayName: t.descriptor.displayName, pluginId: t.pluginId })),
    // PC13: the agents available in the project, for the allow-list.
    availableAgents: availableAgentsView(projectId, agentStore.list()),
  };
}

const knowledgeTarget = (tool: NonNullable<ProjectSettingsView['settings']['knowledge']>['tool']) => (tool.source === 'node' ? tool.nodeType : tool.collection);

export const GET = projectRoute(async (_request: Request, { params }: Ctx) => {
  ensureProjectApprovers();
  const project = requireProject(routeActor(), (await params).id, 'read');
  return json(view(project.id, projectRoleCan.manage(project.role)));
});

export const PATCH = projectRoute(async (request: Request, { params }: Ctx) => {
  ensureProjectApprovers();
  const actor = routeActor();
  const project = requireProject(actor, (await params).id, 'manage');
  const body = await parseBody(request, projectSettingsPatchSchema);
  if (!body.ok) return body.response;
  assertAgentSettingsPatch(project.id, body.data);
  const settings = updateProjectSettings(project.id, body.data, actor.id);
  recordAudit({
    action: 'project.settings.update',
    target: { type: 'project', id: project.id, name: project.name },
    summary: `Changed the settings of “${project.name}”`,
    details: { nodesMode: settings.nodes.mode, plugins: settings.nodes.plugins, nodeTypes: settings.nodes.types, approvers: settings.approvers,
      // PC13: the agent settings (the model's provider and name only; a knowledge base by its collection or node type).
      defaultModel: settings.defaultModel ? `${settings.defaultModel.provider}/${settings.defaultModel.model}` : null,
      knowledge: settings.knowledge?.enabled ? 'on' : 'off',
      ...(settings.knowledge && { knowledgeTarget: knowledgeTarget(settings.knowledge.tool) }),
      agentsMode: settings.agents?.mode ?? 'off',
      agentIds: settings.agents?.ids ?? [],
      toolsMode: settings.agentTools?.mode ?? 'off',
      toolKinds: settings.agentTools?.kinds ?? [],
    },
  });
  return json(view(project.id, true));
});
