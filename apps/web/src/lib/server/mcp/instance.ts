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
import { sameSecret } from './server';

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
