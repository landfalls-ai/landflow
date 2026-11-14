/**
 * Settings → MCP: the host's own MCP server at /api/mcp, for coding agents (Claude Code, Cursor…).
 * It is off by default. Turning it on creates an access token, shown once; only its SHA-256 hash
 * and last four characters are kept, in <data dir>/mcp.json (in queue mode the `config_files` row, ../config-store.ts),
 * read on every call like settings.json.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { McpAccessResponse, McpAccessView } from '../../shared/mcp';
import { ConfigFile } from '../config-store';
import { singleton } from '../singleton';
import { sameSecret, unauthorized, jsonRpcError, bearerToken } from './server';
import { authenticateMcpRequest, GATEWAY_SECRET_HEADER, McpAuthError, mcpAuthErrorResponse, type McpCaller } from './identity';
import type { McpScope } from './project-servers';
import { getUser, type UserRecord } from '../auth/users';
import { looksLikeDebugToken, verifyDebugToken, type DebugTokenRecord } from '../auth/debug-tokens';
import { recordAudit } from '../audit';
import type { Actor } from '../projects/access';
import type { ApiKeyScope, Role } from '../../shared/auth';

interface McpAccessFile {
  enabled: boolean;
  tokenHash?: string;
  tokenHint?: string;
  tokenCreatedAt?: string;
}

const accessFile = () => singleton('config-file:mcp.json', () => new ConfigFile<Partial<McpAccessFile>>('mcp.json'));
const hash = (token: string) => createHash('sha256').update(token).digest('hex');

function read(): McpAccessFile {
  const saved = accessFile().read();
  if (!saved || typeof saved !== 'object') return { enabled: false };
  return { enabled: saved.enabled === true, ...(typeof saved.tokenHash === 'string' && { tokenHash: saved.tokenHash, tokenHint: saved.tokenHint, tokenCreatedAt: saved.tokenCreatedAt }) };
}

function view(file: McpAccessFile): McpAccessView {
  return {
    enabled: file.enabled,
    hasToken: Boolean(file.tokenHash),
    ...(file.tokenHint && { tokenHint: file.tokenHint }),
    ...(file.tokenCreatedAt && { tokenCreatedAt: file.tokenCreatedAt }),
    path: '/api/mcp',
  };
}

/** A new token: `lf_mcp_` and 32 random bytes, base64url. */
function newToken(file: McpAccessFile): { file: McpAccessFile; token: string } {
  const token = `lf_mcp_${randomBytes(32).toString('base64url')}`;
  return { token, file: { ...file, tokenHash: hash(token), tokenHint: token.slice(-4), tokenCreatedAt: new Date().toISOString() } };
}

export function mcpAccess(): McpAccessView {
  return view(read());
}

/** Turn the server on or off. Turning it on without a token creates one (returned once). */
export function setMcpEnabled(enabled: boolean): McpAccessResponse {
  let file: McpAccessFile = { ...read(), enabled };
  let token: string | undefined;
  if (enabled && !file.tokenHash) ({ file, token } = newToken(file));
  accessFile().write(file);
  return { access: view(file), ...(token && { token }) };
}

/** Replace the token (the old one stops working at once). */
export function regenerateMcpToken(): McpAccessResponse {
  const { file, token } = newToken(read());
  accessFile().write(file);
  return { access: view(file), token };
}

/** Whether the server is on and `token` is its access token. */
export function verifyMcpToken(token: string | undefined): boolean {
  const file = read();
  return Boolean(file.enabled && file.tokenHash && token && sameSecret(hash(token), file.tokenHash));
}

/** Who is calling the instance server: the instance (its access token: no per-user checks) or a Landflow user (their permissions apply). */
export type InstanceCaller =
  | { kind: 'instance'; scope?: McpScope }
  | { kind: 'user'; actor: Actor; user: UserRecord; via: string; scope?: McpScope; /** An API key's scopes: only the tools they cover (lib/shared/mcp.ts TOOL_SCOPES). */ keyScopes?: ApiKeyScope[] }
  /** A debug token: no user, no project scope; the server is the three-tool one of ./debug-token-server.ts. */
  | { kind: 'debug'; token: string; record: DebugTokenRecord };

/** The scope a call runs under: the project of the URL, and of a project-scoped token; a token for another project than the URL's is refused (undefined and a `Response`). */
function scopeOf(projectId: string | undefined, tokenProject: string | undefined): McpScope | undefined | Response {
  if (projectId && tokenProject && projectId !== tokenProject) return jsonRpcError(403, -32003, 'This MCP token is scoped to another project');
  const id = projectId ?? tokenProject;
  return id ? { projectId: id } : undefined;
}

/**
 * Authenticate a call to /api/mcp (or /api/mcp/projects/<id>: `projectId`, which scopes the server to that project). Ways in:
 * - the access token from Settings → MCP (`Authorization: Bearer lf_mcp_…`): the instance itself, unchanged;
 * - the bundled gateway: its secret (`x-landflow-gateway`) plus the caller it validated (`x-landflow-caller-*`), mapped to a
 *   Landflow user as for the plugin endpoints. The server then applies that user's permissions (project access, see
 *   ./instance-tools.ts). A call the gateway forwarded without an identity (no sign-in configured there) is refused:
 *   with no user there is no permission to apply, and the access token is for the instance;
 * - a Landflow MCP token, an identity provider's access token or an API key sent directly: the user they stand for, as
 *   above. A token issued for a project scopes the server to it wherever it is used.
 * Returns the refusal response otherwise.
 */
export async function authenticateInstanceRequest(request: Request, projectId?: string): Promise<InstanceCaller | Response> {
  const asUser = (caller: McpCaller): InstanceCaller | Response => {
    const user = caller.userId ? getUser(caller.userId) : undefined;
    if (!user || user.disabledAt) return jsonRpcError(403, -32003, caller.viaGateway ? 'The gateway forwarded no known Landflow user for this call: sign in at the gateway with an account that has signed in to Landflow' : 'No known Landflow user for this call');
    if (!caller.scopes.includes('tools:call')) return jsonRpcError(403, -32003, 'This MCP token has no tools:call scope');
    const scope = scopeOf(projectId, caller.projectId);
    if (scope instanceof Response) return scope;
    return { kind: 'user', actor: { id: user.id, role: user.role as Role }, user, via: `${caller.kind}:${caller.subject}`, ...(scope && { scope }), ...(caller.keyScopes && { keyScopes: caller.keyScopes }) };
  };
  if (request.headers.get(GATEWAY_SECRET_HEADER) !== null) {
    try {
      return asUser(await authenticateMcpRequest(request, { pluginId: '', projectId }));
    } catch (error) {
      if (error instanceof McpAuthError) return mcpAuthErrorResponse(error);
      throw error;
    }
  }
  const bearer = bearerToken(request);
  if (looksLikeDebugToken(bearer)) {
    if (projectId) return jsonRpcError(403, -32003, 'A debug token works at /api/mcp only');
    const checked = verifyDebugToken(bearer);
    if (checked.ok) return { kind: 'debug', token: bearer as string, record: checked.record };
    if (checked.record) {
      recordAudit({ action: 'mcp.tool.call', outcome: 'denied', target: { type: 'execution', id: checked.record.executionId }, summary: `Debug token refused (${checked.reason}) for execution ${checked.record.executionId}`, details: { via: 'debug-token', debugId: checked.record.id, reason: checked.reason }, actor: 'anonymous' });
    }
    const why = { invalid: 'Invalid debug token', expired: 'This debug token has expired', revoked: 'This debug token was revoked', exhausted: 'This debug token has used up its calls', user: 'This debug token is no longer allowed' }[checked.reason];
    return unauthorized(why);
  }
  if (verifyMcpToken(bearer)) return { kind: 'instance', ...(projectId && { scope: { projectId } }) };
  if (bearer) {
    // Not the access token: a user's Landflow MCP token, identity provider token or API key.
    try {
      const caller = await authenticateMcpRequest(request, { pluginId: '', projectId });
      if (caller.kind === 'token' || caller.kind === 'idp' || caller.kind === 'apiKey') return asUser(caller);
    } catch (error) {
      if (!(error instanceof McpAuthError)) throw error;
      if (error.status === 403) return mcpAuthErrorResponse(error);
    }
  }
  return unauthorized('Send the access token from Settings → MCP, or a Landflow MCP token, as “Authorization: Bearer <token>”');
}
