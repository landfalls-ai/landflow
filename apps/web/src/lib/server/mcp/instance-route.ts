/**
 * What /api/mcp and /api/mcp/projects/<id> do (the routes are thin wrappers): check the server is on, authenticate (./instance.ts),
 * and serve the instance server (./instance-tools.ts) for the caller, limited to a project when the URL or the caller's token
 * names one (./project-servers.ts).
 */
import type { AuthInfo } from '@modelcontextprotocol/server';
import { withAuth } from '../auth/context';
import { getProject } from '../projects/store';
import { authenticateInstanceRequest, mcpAccess, type InstanceCaller } from './instance';
import { debugTokenServer } from './debug-token-server';
import { executionDigest, instanceServer } from './instance-tools';
import { projectServerPath } from './project-servers';
import { jsonRpcError, serveMcpEndpoint } from './server';

const callerOf = (authInfo: AuthInfo | undefined) => (authInfo?.extra as { caller?: InstanceCaller } | undefined)?.caller;

export async function serveInstance(request: Request, projectId?: string): Promise<Response> {
  if (!mcpAccess().enabled) return jsonRpcError(403, -32001, 'The Landflow MCP server is off. Turn it on in Settings → MCP.');
  if (projectId && !getProject(projectId)) return jsonRpcError(404, -32001, `No project “${projectId}”`);
  const caller = await authenticateInstanceRequest(request, projectId);
  if (caller instanceof Response) return caller;
  const authInfo: AuthInfo = { token: '', clientId: caller.kind === 'user' ? caller.user.id : caller.kind === 'debug' ? `debug:${caller.record.id}` : 'instance', scopes: [], extra: { caller } };
  // One factory for the endpoint (the SDK keeps the latest one per key): the caller rides in `authInfo`.
  const key = projectId ? `request:${projectServerPath(projectId)}` : 'request:/api/mcp';
  const serve = () =>
    serveMcpEndpoint(
      key,
      request,
      (info) => {
        const who = callerOf(info.authInfo);
        if (who?.kind === 'debug') return debugTokenServer(who.token, who.record, { digest: executionDigest });
        return instanceServer(who?.kind === 'user' ? who.actor : undefined, who?.scope, who?.kind === 'user' ? who.keyScopes : undefined);
      },
      authInfo,
    );
  return caller.kind === 'user' ? withAuth({ principal: { user: caller.user, via: 'mcp' } }, serve) : serve();
}
