import { describe, expect, it } from 'vitest';
import { claudeAddCommand, curlCheck, DEBUG_TTL_CHOICES, mcpConfigJson, relativeTime, tokenPrefix, tokenState } from '../src/lib/shared/debug-token-snippets';

describe('debug token snippets', () => {
  const token = 'lf_dbg_abc123';
  it('builds the Claude Code command, the .mcp.json entry and the curl check', () => {
    expect(claudeAddCommand('http://h:1/', '/api/mcp', token)).toBe('claude mcp add --transport http landflow-debug http://h:1/api/mcp --header "Authorization: Bearer lf_dbg_abc123"');
    expect(JSON.parse(mcpConfigJson('http://h:1', '/api/mcp', token))).toEqual({
      mcpServers: { 'landflow-debug': { type: 'http', url: 'http://h:1/api/mcp', headers: { Authorization: 'Bearer lf_dbg_abc123' } } },
    });
    expect(curlCheck('http://h:1', '/api/mcp', token)).toContain('http://h:1/api/mcp -H "Authorization: Bearer lf_dbg_abc123"');
  });
  it('offers only lifetimes the route accepts', () => {
    for (const c of DEBUG_TTL_CHOICES) expect(c.seconds >= 60 && c.seconds <= 86_400).toBe(true);
  });
  it('names a token state and a coarse time', () => {
    const now = Date.parse('2026-01-01T12:00:00Z');
    const iso = (ms: number) => new Date(now + ms).toISOString();
    expect(tokenPrefix('wxyz')).toBe('lf_dbg_…wxyz');
    expect(tokenState({ expiresAt: iso(1000), uses: 0 }, 1000, now)).toBe('live');
    expect(tokenState({ expiresAt: iso(-1000), uses: 0 }, 1000, now)).toBe('expired');
    expect(tokenState({ expiresAt: iso(1000), uses: 1000 }, 1000, now)).toBe('used up');
    expect(tokenState({ expiresAt: iso(1000), uses: 0, revokedAt: iso(0) }, 1000, now)).toBe('revoked');
    expect(relativeTime(iso(42 * 60_000), now)).toBe('in 42 min');
    expect(relativeTime(iso(-3 * 3_600_000), now)).toBe('3 h ago');
    expect(relativeTime(iso(-5000), now)).toBe('just now');
  });
});
