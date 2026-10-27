/**
 * The instance MCP server per project (docs/transports.md "MCP: every plugin is also an MCP server", docs/protocol.md §15.3).
 *
 * `/api/mcp/projects/<projectId>` is the instance server (./instance-tools.ts) scoped to one project: it lists and changes
 * only that project's workflows, and what it creates goes there. A Landflow MCP token issued for a project (Settings → MCP
 * → New MCP token → Project) is scoped the same way wherever it is used, at `/api/mcp` too.
 *
 * `mcp_project_servers` (migration 1871) holds the projects whose server the gateway sync registers a route for
 * (`/mcp/projects/<name>`, ./gateway-sync.ts): a project's admins turn that on under the project's settings. The direct URL
 * needs no flag: it answers whenever the instance server is on.
 */
import { homeProjectId } from '../projects/store';
import { mcpDb } from './db';

/** What the instance server is limited to. */
export interface McpScope {
  projectId: string;
}

interface Row {
  project_id: string;
  enabled: number;
}

/** Whether a project's server is registered on the gateway. */
export function projectGatewayEnabled(projectId: string): boolean {
  return mcpDb().get<Row>('SELECT project_id, enabled FROM mcp_project_servers WHERE project_id = ?', projectId)?.enabled === 1;
}

export function setProjectGatewayEnabled(projectId: string, enabled: boolean) {
  const db = mcpDb();
  const now = new Date().toISOString();
  const existing = db.get<{ created_at: string }>('SELECT created_at FROM mcp_project_servers WHERE project_id = ?', projectId);
  db.upsert('mcp_project_servers', { project_id: projectId, enabled: enabled ? 1 : 0, created_at: existing?.created_at ?? now, updated_at: now });
}

/** The projects with a gateway route. */
export function gatewayProjectIds(): string[] {
  return mcpDb()
    .all<Row>('SELECT project_id, enabled FROM mcp_project_servers WHERE enabled = 1')
    .map((row) => row.project_id);
}

/** Forget a deleted project's flag. */
export function forgetProjectServer(projectId: string) {
  mcpDb().delete('mcp_project_servers', { project_id: projectId });
}

/** Whether a workflow belongs to the scope (its home project; shares into the project don't count). */
export function inScope(scope: McpScope | undefined, workflowId: string): boolean {
  return !scope || homeProjectId('workflow', workflowId) === scope.projectId;
}

/** The URL path of a project's server on this host. */
export const projectServerPath = (projectId: string) => `/api/mcp/projects/${encodeURIComponent(projectId)}`;
