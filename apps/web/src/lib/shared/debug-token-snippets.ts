/** What to hand an agent once a debug token is minted (docs/specs/19-debug-token.md): the MCP endpoint, as commands and config. */

export const DEBUG_TTL_CHOICES = [
  { seconds: 900, label: '15 minutes' },
  { seconds: 3600, label: '1 hour' },
  { seconds: 14_400, label: '4 hours' },
  { seconds: 86_400, label: '24 hours' },
] as const;

const endpoint = (origin: string, path: string) => `${origin.replace(/\/+$/, '')}${path}`;

/** `claude mcp add` for Claude Code. */
export function claudeAddCommand(origin: string, path: string, token: string): string {
  return `claude mcp add --transport http landflow-debug ${endpoint(origin, path)} --header "Authorization: Bearer ${token}"`;
}

/** The same server as a `.mcp.json` entry. */
export function mcpConfigJson(origin: string, path: string, token: string): string {
  return JSON.stringify({ mcpServers: { 'landflow-debug': { type: 'http', url: endpoint(origin, path), headers: { Authorization: `Bearer ${token}` } } } }, null, 2);
}

/** A raw call, to check the token works: lists the three tools it opens. */
export function curlCheck(origin: string, path: string, token: string): string {
  return `curl -s ${endpoint(origin, path)} -H "Authorization: Bearer ${token}" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`;
}

/** The short form shown in the list: the token is never kept, only its last four characters. */
export const tokenPrefix = (hint: string) => `lf_dbg_…${hint}`;

export type DebugTokenState = 'live' | 'revoked' | 'expired' | 'used up';

export function tokenState(t: { revokedAt?: string; expiresAt: string; uses: number }, maxUses: number, now = Date.now()): DebugTokenState {
  if (t.revokedAt) return 'revoked';
  if (Date.parse(t.expiresAt) <= now) return 'expired';
  return t.uses >= maxUses ? 'used up' : 'live';
}

/** "in 42 min", "3 h ago": coarse, for a list. */
export function relativeTime(iso: string, now = Date.now()): string {
  const diff = Date.parse(iso) - now;
  const abs = Math.abs(diff);
  if (abs < 60_000) return diff >= 0 ? 'in a moment' : 'just now';
  const unit = abs < 3_600_000 ? `${Math.round(abs / 60_000)} min` : abs < 86_400_000 ? `${Math.round(abs / 3_600_000)} h` : `${Math.round(abs / 86_400_000)} d`;
  return diff >= 0 ? `in ${unit}` : `${unit} ago`;
}
