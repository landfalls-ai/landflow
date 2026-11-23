/** C14 (P14): Settings → MCP → Policy hooks, rendered from fixtures: the empty state, the list, escaping and no zod in the client module. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PolicyHooksView, testLine } from '@/components/settings/mcp-policy-hooks';
import { blockedText, matchLine, type McpPolicyHookView } from '@/lib/shared/mcp-policy';

const hook = (over: Partial<McpPolicyHookView> = {}): McpPolicyHookView => ({
  id: 'ph_1', name: 'Finance policy', enabled: true, url: 'https://policy.example.com:8443/decide?key=nope', auth: 'hmac', credential: { id: 'c1', name: 'Policy key' }, timeoutMs: 2000, failureMode: 'closed',
  match: { hosts: ['mcp.example.com'], tools: ['delete_*'], methods: ['tools/call'], projects: [] }, createdAt: '', updatedAt: '', ...over,
});
const html = (hooks: McpPolicyHookView[], extra: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(PolicyHooksView, { hooks, ...extra }));

describe('Policy hooks section', () => {
  it('says what no hooks means and offers the one action', () => {
    const markup = html([]);
    expect(markup).toContain('No policy hooks: MCP calls go out as the agent wrote them');
    expect(markup).toContain('New policy hook');
  });

  it('lists each hook with its host, what it matches, its failure mode and Test', () => {
    const markup = html([hook(), hook({ id: 'ph_2', name: 'Open one', failureMode: 'open', enabled: false, url: 'http://127.0.0.1:9000/x', match: { hosts: [], tools: [], methods: ['resources/read', 'prompts/get'], projects: ['p1', 'p2'] } })]);
    expect(markup).toContain('Finance policy');
    expect(markup).toContain('policy.example.com:8443');
    expect(markup).not.toContain('key=nope');
    expect(markup).toContain('Asked before tool calls to mcp.example.com for delete_*');
    expect(markup).toContain('Blocks if silent');
    expect(markup).toContain('Lets through if silent');
    expect(markup).toContain('resource reads, prompts in 2 projects');
    expect(markup).toContain('Off');
    expect((markup.match(/>Test</g) ?? []).length).toBe(2);
    expect(markup).toContain('aria-label="Edit Finance policy"');
  });

  it('renders a name with markup as text', () => {
    const markup = html([hook({ name: '<b>bold</b>' })]);
    expect(markup).not.toContain('<b>bold</b>');
    expect(markup).toContain('&lt;b&gt;bold&lt;/b&gt;');
  });

  it('shows a test result in words', () => {
    expect(testLine({ ok: true, decision: 'deny', reason: 'no deletes', ruleId: 'r1', ms: 12 })).toBe('Deny: no deletes (r1) in 12 ms');
    expect(testLine({ ok: true, decision: 'allow', ms: 3 })).toBe('Allow in 3 ms');
    expect(testLine({ ok: false, error: 'no answer within 2000 ms', ms: 2000 })).toBe('No answer: no answer within 2000 ms');
    expect(html([hook()], { results: { ph_1: { ok: false, error: 'boom', ms: 1 } } })).toContain('No answer: boom');
  });

  it('has plain words for a block and keeps the client module free of zod', () => {
    expect(blockedText('Finance policy', 'no deletes')).toBe('Blocked by policy Finance policy: no deletes');
    expect(matchLine(hook())).toBe('tool calls to mcp.example.com for delete_*');
    for (const file of ['src/components/settings/mcp-policy-hooks.tsx', 'src/lib/shared/mcp-policy.ts']) {
      expect(readFileSync(join(__dirname, '..', file), 'utf8')).not.toMatch(/from 'zod'|from "zod"/);
    }
  });
});
