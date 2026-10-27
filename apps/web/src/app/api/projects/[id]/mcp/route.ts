/**
 * A project's MCP server (lib/server/mcp/project-servers.ts): the instance MCP server scoped to this project, at
 * `/api/mcp/projects/<id>`. GET — `{ instanceEnabled, path, gateway, gatewayPath?, canEdit }` (the project's members).
 * PATCH { gateway: boolean } — register (or remove) the server's route on the bundled MCP gateway, `/mcp/projects/<name>`:
 * the project's admins (and instance owners and admins).
 */
import { z } from 'zod';
import { recordAudit } from '@/lib/server/audit';
import { json, parseBody } from '@/lib/server/http';
import { mcpAccess } from '@/lib/server/mcp/instance';
import { entryForServer, mcpGatewaySync } from '@/lib/server/mcp/gateway-sync';
import { projectGatewayEnabled, projectServerPath, setProjectGatewayEnabled } from '@/lib/server/mcp/project-servers';
import { projectRoute, requireProject, routeActor } from '@/lib/server/projects/http';
import { projectRoleCan } from '@/lib/shared/projects';
import type { ProjectMcpView } from '@/lib/shared/mcp';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

function view(projectId: string, canEdit: boolean): ProjectMcpView {
  const gateway = projectGatewayEnabled(projectId);
  return {
    instanceEnabled: mcpAccess().enabled,
    path: projectServerPath(projectId),
    gateway,
    ...(gateway && { gatewayPath: entryForServer({ kind: 'project', projectId, label: '' }).gatewayPath }),
    canEdit,
  };
}

export const GET = projectRoute(async (_request: Request, { params }: Ctx) => {
  const project = requireProject(routeActor(), (await params).id, 'read');
  return json(view(project.id, projectRoleCan.manage(project.role)));
});

export const PATCH = projectRoute(async (request: Request, { params }: Ctx) => {
  const project = requireProject(routeActor(), (await params).id, 'manage');
  const body = await parseBody(request, z.strictObject({ gateway: z.boolean() }));
  if (!body.ok) return body.response;
  setProjectGatewayEnabled(project.id, body.data.gateway);
  mcpGatewaySync.nudge();
  recordAudit({
    action: 'project.settings.update',
    target: { type: 'project', id: project.id, name: project.name },
    summary: `${body.data.gateway ? 'Registered' : 'Removed'} the MCP server of “${project.name}” on the gateway`,
    details: { mcpGateway: body.data.gateway },
  });
  return json(view(project.id, true));
});
