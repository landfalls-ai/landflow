// @vitest-environment happy-dom
/** Final live run 2, item 4: Apply saves the draft first, then swaps the cases; a stale swap is tried again once from the cases now; a swap that fails is on the card. */
import { describe, expect, it, vi } from 'vitest';

const { saveChange, saveChangeWithCases, CASES_CHANGED } = await import('@/lib/client/agent-change');

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A fake agent API: `patches` are the answers to successive PATCHes, `now` the agent's cases when read. */
function stub(calls: string[], patches: Array<number | 'ok'>, now = [{ id: 'ec_7', input: 'old text-only', expected: 'only text' }, { id: 'ec_2', input: 'tone' }]) {
  let patch = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url).replace(/^.*\/api/, '');
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${u} ${init?.body ? String(init.body) : ''}`.trim());
    if (method === 'GET' && /eval-gate$/.test(u)) return json(200, { cases: now });
    if (method === 'PATCH') {
      const answer = patches[patch++] ?? 'ok';
      return answer === 'ok' ? json(200, { cases: [] }) : json(answer, { error: answer === 409 ? 'A test case to replace is no longer there' : 'nope' });
    }
    return json(200, /smoke-test/.test(u) ? { smoke: { state: 'passed' } } : { ok: true });
  }));
}
const run = (replace = [{ id: 'ec_1', input: 'old text-only' }]) => saveChangeWithCases('ag_1', { name: 'A' }, 'hi', [{ input: 'Q1', expected: 'E1' }], replace);
const order = (calls: string[]) => calls.map((c) => c.split(' ').slice(0, 2).join(' '));

describe('Apply: the draft first, then the cases', () => {
  it('saves the draft, swaps the named cases in one PATCH, then smoke-tests', async () => {
    const calls: string[] = [];
    stub(calls, ['ok']);
    try { expect(await run()).toEqual({ smoke: { state: 'passed' } }); } finally { vi.unstubAllGlobals(); }
    expect(order(calls)).toEqual(['PUT /agents/ag_1', 'PATCH /agents/ag_1/eval-gate', 'POST /agents/ag_1/smoke-test']);
    expect(calls[1]).toContain('"remove":["ec_1"]');
  });
  it('a stale id (409) is worked out again from the cases now, by input text, and tried once more', async () => {
    const calls: string[] = [];
    stub(calls, [409, 'ok']); // ec_1 is gone; the same case has another id now
    try { expect(await run()).toEqual({ smoke: { state: 'passed' } }); } finally { vi.unstubAllGlobals(); }
    const patches = calls.filter((c) => c.startsWith('PATCH'));
    expect(patches).toHaveLength(2);
    expect(patches[1]).toContain('"remove":["ec_7"]');
    expect(patches[1]).toContain('Q1');
  });
  it('still stale on the second try: the card says the tests changed, the draft stays saved, nothing is undone', async () => {
    const calls: string[] = [];
    stub(calls, [409, 409]);
    let result;
    try { result = await run(); } finally { vi.unstubAllGlobals(); }
    expect(result).toEqual({ smoke: { state: 'passed' }, casesNote: CASES_CHANGED });
    expect(CASES_CHANGED).toBe('The tests changed since this was designed; ask again.');
    expect(calls.filter((c) => c.startsWith('PATCH'))).toHaveLength(2);
    expect(calls.some((c) => c.startsWith('PUT'))).toBe(true);
  });
  it('any other failed swap is reported, not swallowed, and not retried', async () => {
    const calls: string[] = [];
    stub(calls, [500]);
    let result;
    try { result = await run(); } finally { vi.unstubAllGlobals(); }
    expect(result?.casesNote).toMatch(/^The tests could not be replaced: /);
    expect(calls.filter((c) => c.startsWith('PATCH'))).toHaveLength(1);
  });
  it('a draft that fails to save throws and touches no case', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => { calls.push(`${init?.method ?? 'GET'} ${url}`); return json(400, { error: 'bad draft' }); }));
    try { await expect(run()).rejects.toThrow(); } finally { vi.unstubAllGlobals(); }
    expect(calls.some((c) => /eval-gate/.test(c))).toBe(false);
  });
  it('touches no cases when the change replaces none', async () => {
    const calls: string[] = [];
    stub(calls, []);
    try { await saveChange('ag_1', { name: 'A' }, 'hi'); } finally { vi.unstubAllGlobals(); }
    expect(calls.some((c) => /eval-gate/.test(c))).toBe(false);
  });
});
