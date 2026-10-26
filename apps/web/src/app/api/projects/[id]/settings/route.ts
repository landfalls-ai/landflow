/**
 * A project's settings (lib/server/governance/scopes.ts): the plugins and node types its workflows may use (an
 * optional allow-list under the instance's governance policy) and who approves its publish requests.
 * GET — `{ settings, canEdit, plugins, nodeTypes }` (the project's members).
 * PATCH { nodes?: { mode?, plugins?, types? }, approvers? } — its admins (and instance owners and admins).
 */
import { recordAudit } from '@/lib/server/audit';
import { ensureProjectApprovers } from '@/lib/server/governance/project-approvers';
import { getProjectSettings, projectSettingsPatchSchema, updateProjectSettings } from '@/lib/server/governance/scopes';
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
  };
}

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
  const settings = updateProjectSettings(project.id, body.data, actor.id);
  recordAudit({
    action: 'project.settings.update',
    target: { type: 'project', id: project.id, name: project.name },
    summary: `Changed the settings of “${project.name}”`,
    details: { nodesMode: settings.nodes.mode, plugins: settings.nodes.plugins, nodeTypes: settings.nodes.types, approvers: settings.approvers },
  });
  return json(view(project.id, true));
});
