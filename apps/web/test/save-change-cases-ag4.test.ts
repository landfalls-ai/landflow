// @vitest-environment happy-dom
/** Final live run 2, item 1: Apply replaces the agent's cases with the card's when the change brings some. */
import { describe, expect, it, vi } from 'vitest';

const { saveChange } = await import('@/lib/client/agent-change');

describe('saveChange with cases', () => {
  it('saves the draft, deletes the old cases, adds the new ones, then smoke-tests', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      calls.push(`${init?.method ?? 'GET'} ${u.replace(/^.*\/api/, '')} ${init?.body ? String(init.body).slice(0, 60) : ''}`.trim());
      const body = /eval-gate$/.test(u) && !init?.method ? { cases: [{ id: 'ec_1' }, { id: 'ec_2' }] } : /smoke-test/.test(u) ? { smoke: { state: 'passed' } } : { ok: true };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    try {
      const smoke = await saveChange('ag_1', { name: 'A' }, 'hi', [{ input: 'Q1', expected: 'E1' }, { input: 'Q2' }]);
      expect(smoke).toMatchObject({ state: 'passed' });
    } finally { vi.unstubAllGlobals(); }
    expect(calls.filter((c) => c.startsWith('DELETE'))).toHaveLength(2);
    expect(calls.filter((c) => c.startsWith('POST /agents/ag_1/eval-gate'))).toHaveLength(2);
    expect(calls[0]).toMatch(/^PUT \/agents\/ag_1/);
    expect(calls.at(-1)).toMatch(/smoke-test/);
  });
  it('touches no cases when the change brings none', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => { calls.push(`${init?.method ?? 'GET'} ${String(url)}`); return new Response(JSON.stringify({ smoke: { state: 'passed' } }), { status: 200, headers: { 'content-type': 'application/json' } }); }));
    try { await saveChange('ag_1', { name: 'A' }, 'hi'); } finally { vi.unstubAllGlobals(); }
    expect(calls.some((c) => /eval-gate/.test(c))).toBe(false);
  });
});
