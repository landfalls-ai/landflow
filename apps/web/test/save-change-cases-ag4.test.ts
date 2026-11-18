// @vitest-environment happy-dom
/** Final live run 2, item 1: Apply replaces the agent's cases with the card's when the change brings some. */
import { describe, expect, it, vi } from 'vitest';

const { saveChange } = await import('@/lib/client/agent-change');

describe('saveChange with cases', () => {
  const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  const stub = (calls: string[], failPut = false, failPatch = false) => vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url).replace(/^.*\/api/, '');
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${u} ${init?.body ? String(init.body) : ''}`.trim());
    if (method === 'GET' && /eval-gate$/.test(u)) return ok({ cases: [{ id: 'ec_1', input: 'old text-only', expected: 'only text' }, { id: 'ec_2', input: 'tone' }] });
    if (method === 'PATCH') return failPatch ? new Response(JSON.stringify({ error: 'no' }), { status: 409, headers: { 'content-type': 'application/json' } }) : ok({ cases: [{ id: 'ec_2' }, { id: 'ec_9' }] });
    if (method === 'PUT') return failPut ? new Response(JSON.stringify({ error: 'bad draft' }), { status: 400, headers: { 'content-type': 'application/json' } }) : ok({ ok: true });
    return ok(/smoke-test/.test(u) ? { smoke: { state: 'passed' } } : { ok: true });
  }));
  it('swaps only the named cases in one PATCH, then saves the draft and smoke-tests', async () => {
    const calls: string[] = [];
    stub(calls);
    try {
      expect(await saveChange('ag_1', { name: 'A' }, 'hi', [{ input: 'Q1', expected: 'E1' }], ['ec_1'])).toMatchObject({ state: 'passed' });
    } finally { vi.unstubAllGlobals(); }
    const patches = calls.filter((c) => c.startsWith('PATCH'));
    expect(patches).toHaveLength(1);
    expect(patches[0]).toContain('"remove":["ec_1"]');
    expect(calls.some((c) => c.startsWith('DELETE') || c.startsWith('POST /agents/ag_1/eval-gate'))).toBe(false);
    expect(calls.findIndex((c) => c.startsWith('PUT'))).toBeGreaterThan(calls.findIndex((c) => c.startsWith('PATCH')));
    expect(calls.at(-1)).toMatch(/smoke-test/);
  });
  it('a failed swap changes nothing: no draft saved, the error reaches the card', async () => {
    const calls: string[] = [];
    stub(calls, false, true);
    try {
      await expect(saveChange('ag_1', { name: 'A' }, 'hi', [{ input: 'Q1' }], ['ec_1'])).rejects.toThrow();
    } finally { vi.unstubAllGlobals(); }
    expect(calls.some((c) => c.startsWith('PUT'))).toBe(false);
  });
  it('a draft that fails to save puts the old cases back', async () => {
    const calls: string[] = [];
    stub(calls, true);
    try {
      await expect(saveChange('ag_1', { name: 'A' }, 'hi', [{ input: 'Q1' }], ['ec_1'])).rejects.toThrow();
    } finally { vi.unstubAllGlobals(); }
    const patches = calls.filter((c) => c.startsWith('PATCH'));
    expect(patches).toHaveLength(2);
    expect(patches[1]).toContain('"remove":["ec_9"]');
    expect(patches[1]).toContain('old text-only');
  });
  it('touches no cases when the change brings none', async () => {
    const calls: string[] = [];
    stub(calls);
    try { await saveChange('ag_1', { name: 'A' }, 'hi'); } finally { vi.unstubAllGlobals(); }
    expect(calls.some((c) => /eval-gate/.test(c))).toBe(false);
  });
});
