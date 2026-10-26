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
import { authenticateMcpRequest, GATEWAY_SECRET_HEADER, McpAuthError, mcpAuthErrorResponse } from './identity';
import { getUser, type UserRecord } from '../auth/users';
import type { Actor } from '../projects/access';
import type { Role } from '../../shared/auth';

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

/** Who is calling the instance server: the instance (its access token: no per-user checks) or a Landflow user the gateway identified. */
export type InstanceCaller = { kind: 'instance' } | { kind: 'user'; actor: Actor; user: UserRecord; via: string };

/**
 * Authenticate a call to /api/mcp. Two ways in:
 * - the access token from Settings → MCP (`Authorization: Bearer lf_mcp_…`): the instance itself, unchanged;
 * - the bundled gateway: its secret (`x-landflow-gateway`) plus the caller it validated (`x-landflow-caller-*`), mapped to a
 *   Landflow user as for the plugin endpoints. The server then applies that user's permissions (project access, see
 *   ./instance-tools.ts). A call the gateway forwarded without an identity (no sign-in configured there) is refused:
 *   with no user there is no permission to apply, and the access token is for the instance.
 * Returns the refusal response otherwise.
 */
export async function authenticateInstanceRequest(request: Request): Promise<InstanceCaller | Response> {
  if (request.headers.get(GATEWAY_SECRET_HEADER) !== null) {
    try {
      const caller = await authenticateMcpRequest(request, { pluginId: '' });
      const user = caller.userId ? getUser(caller.userId) : undefined;
      if (!user || user.disabledAt) return jsonRpcError(403, -32003, 'The gateway forwarded no known Landflow user for this call: sign in at the gateway with an account that has signed in to Landflow');
      if (!caller.scopes.includes('tools:call')) return jsonRpcError(403, -32003, 'This MCP token has no tools:call scope');
      return { kind: 'user', actor: { id: user.id, role: user.role as Role }, user, via: `${caller.kind}:${caller.subject}` };
    } catch (error) {
      if (error instanceof McpAuthError) return mcpAuthErrorResponse(error);
      throw error;
    }
  }
  if (!verifyMcpToken(bearerToken(request))) return unauthorized('Send the access token from Settings → MCP as “Authorization: Bearer <token>”');
  return { kind: 'instance' };
}
