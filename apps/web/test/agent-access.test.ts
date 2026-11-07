import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanAccess, decideByRules, mostRestrictive, type AgentAccess, type Caller } from '@/lib/shared/agent-access';
import { applyToolPolicy, configuredEngine, openFgaEngine, opaEngine } from '@/lib/server/agents/policy';
import type { BuiltTool } from '@/lib/server/agents/tools';

const tool = (name: string, requireApproval = false): BuiltTool => ({ name, label: name, kind: 'node', description: name, inputSchema: { type: 'object' }, requireApproval, invoke: async () => ({ output: 'ok' }) });
const tools = [tool('read_orders'), tool('refund_order'), tool('send_email', true)];
const viewer: Caller = { id: 'u_viewer', role: 'viewer', source: 'api' };
const admin: Caller = { id: 'u_admin', role: 'admin', source: 'api' };
const names = (list: BuiltTool[]) => list.map((t) => t.name);

const access: AgentAccess = {
  rules: [
    { id: 'a', tool: 'refund_order', who: { role: 'admin' }, effect: 'allow' },
    { id: 'b', tool: 'refund_order', who: {}, effect: 'deny' },
    { id: 'c', tool: 'send_email', who: { source: 'schedule' }, effect: 'deny' },
    { id: 'd', tool: 'read_orders', who: { role: 'viewer' }, effect: 'ask' },
  ],
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('access rules', () => {
  it('lets the first matching rule decide, and allows when nothing matches', () => {
    expect(decideByRules(access, admin, 'refund_order').effect).toBe('allow');
    expect(decideByRules(access, viewer, 'refund_order').effect).toBe('deny');
    expect(decideByRules(access, viewer, 'read_orders').effect).toBe('ask');
    expect(decideByRules(access, admin, 'read_orders').effect).toBe('allow');
    expect(decideByRules(undefined, viewer, 'anything').effect).toBe('allow');
    expect(decideByRules({ rules: [{ id: 'x', tool: '*', who: { user: 'u_viewer' }, effect: 'deny' }] }, viewer, 'read_orders').effect).toBe('deny');
  });

  it('cleans rules and picks the most restrictive answer', () => {
    expect(cleanAccess({ rules: [] })).toBeUndefined();
    expect(cleanAccess({ rules: [{ id: '', tool: ' ', who: {}, effect: 'deny' }] })).toBeUndefined();
    expect(cleanAccess({ rules: [{ id: '', tool: 'a', who: { role: ' admin ' }, effect: 'ask' }] })?.rules[0]).toMatchObject({ tool: 'a', who: { role: 'admin' }, effect: 'ask' });
    expect(mostRestrictive([{ effect: 'allow' }, { effect: 'ask' }]).effect).toBe('ask');
    expect(mostRestrictive([{ effect: 'ask' }, { effect: 'deny' }, { effect: 'allow' }]).effect).toBe('deny');
  });
});

describe('applyToolPolicy', () => {
  it('changes nothing without rules or an engine', async () => {
    const result = await applyToolPolicy(tools, { agentId: 'ag_1', caller: viewer, access: undefined, engine: undefined });
    expect(result.tools).toBe(tools);
    expect(result.notes).toEqual([]);
  });

  it('withholds denied tools and puts approval in front of "ask" ones, per caller', async () => {
    const forViewer = await applyToolPolicy(tools, { agentId: 'ag_1', caller: viewer, access, engine: undefined });
    expect(names(forViewer.tools)).toEqual(['read_orders', 'send_email']);
    expect(forViewer.tools.find((t) => t.name === 'read_orders')?.requireApproval).toBe(true);
    expect(forViewer.notes.some((n) => /refund_order is not available/.test(n))).toBe(true);

    expect(forViewer.decisions.map((d) => [d.tool, d.effect])).toEqual([['read_orders', 'ask'], ['refund_order', 'deny'], ['send_email', 'allow']]);

    const forAdmin = await applyToolPolicy(tools, { agentId: 'ag_1', caller: admin, access, engine: undefined });
    expect(names(forAdmin.tools)).toEqual(['read_orders', 'refund_order', 'send_email']);
    expect(forAdmin.tools.find((t) => t.name === 'read_orders')?.requireApproval).toBe(false);

    const schedule = await applyToolPolicy(tools, { agentId: 'ag_1', caller: { id: 'schedule', source: 'schedule' }, access, engine: undefined });
    expect(names(schedule.tools)).not.toContain('send_email');
  });

  it('lets an external engine restrict further, never loosen what a rule denied', async () => {
    const engine = vi.fn(async (request: { tool: string }) => (request.tool === 'read_orders' ? { effect: 'deny' as const, reason: 'policy: deny' } : { effect: 'allow' as const }));
    const result = await applyToolPolicy(tools, { agentId: 'ag_1', caller: admin, access, engine });
    expect(names(result.tools)).toEqual(['refund_order', 'send_email']);
    const denied = await applyToolPolicy(tools, { agentId: 'ag_1', caller: viewer, access, engine });
    expect(names(denied.tools)).toEqual(['send_email']);
  });

  it('denies when the engine cannot be reached, unless told to fail open', async () => {
    const broken = async () => {
      throw new Error('connection refused');
    };
    const closed = await applyToolPolicy([tool('a')], { agentId: 'ag_1', caller: admin, access: undefined, engine: broken });
    expect(closed.tools).toEqual([]);
    expect(closed.notes[0]).toMatch(/could not be reached/);
    vi.stubEnv('LANDFLOW_TOOL_POLICY_FAIL', 'open');
    const open = await applyToolPolicy([tool('a')], { agentId: 'ag_1', caller: admin, access: undefined, engine: broken });
    expect(names(open.tools)).toEqual(['a']);
  });
});

describe('the OPA and OpenFGA adapters', () => {
  it('asks OPA with the request as input and reads allow, ask, deny or a boolean', async () => {
    vi.stubEnv('LANDFLOW_TOOL_POLICY_URL', 'http://opa.test/v1/data/landflow/tools');
    const answers: unknown[] = ['allow', 'ask', 'deny', true, false];
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ result: answers.shift() })));
    vi.stubGlobal('fetch', fetchMock);
    const request = { caller: viewer, agentId: 'ag_1', tool: 'refund_order', kind: 'node' };
    const effects = [];
    for (let i = 0; i < 5; i++) effects.push((await opaEngine(request)).effect);
    expect(effects).toEqual(['allow', 'ask', 'deny', 'allow', 'deny']);
    // A package path answers with the rule nested inside, as a real OPA does.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ result: { result: 'deny' } }))));
    expect((await opaEngine(request)).effect).toBe('deny');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ result: { result: 'ask' } }))));
    expect((await opaEngine(request)).effect).toBe('ask');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://opa.test/v1/data/landflow/tools');
    expect(JSON.parse(String(init.body))).toEqual({ input: request });
  });

  it('checks OpenFGA for user:<id> can_use tool:<agent>/<tool>', async () => {
    vi.stubEnv('LANDFLOW_TOOL_POLICY_URL', 'http://fga.test:8080/');
    vi.stubEnv('LANDFLOW_OPENFGA_STORE_ID', 'store1');
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ allowed: true })));
    vi.stubGlobal('fetch', fetchMock);
    expect((await openFgaEngine({ caller: viewer, agentId: 'ag_1', tool: 'read_orders', kind: 'node' })).effect).toBe('allow');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://fga.test:8080/stores/store1/check');
    expect(JSON.parse(String(init.body))).toEqual({ tuple_key: { user: 'user:u_viewer', relation: 'can_use', object: 'tool:ag_1/read_orders' } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ allowed: false }))));
    expect((await openFgaEngine({ caller: viewer, agentId: 'ag_1', tool: 'read_orders', kind: 'node' })).effect).toBe('deny');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    await expect(openFgaEngine({ caller: viewer, agentId: 'ag_1', tool: 'x', kind: 'node' })).rejects.toThrow(/500/);
  });

  it('picks the engine from the environment', () => {
    expect(configuredEngine()).toBeUndefined();
    vi.stubEnv('LANDFLOW_TOOL_POLICY', 'opa');
    expect(() => configuredEngine()).toThrow(/needs LANDFLOW_TOOL_POLICY_URL/);
    vi.stubEnv('LANDFLOW_TOOL_POLICY_URL', 'http://opa.test/x');
    expect(configuredEngine()).toBe(opaEngine);
    vi.stubEnv('LANDFLOW_TOOL_POLICY', 'openfga');
    expect(configuredEngine()).toBe(openFgaEngine);
    vi.stubEnv('LANDFLOW_TOOL_POLICY', 'cedar');
    expect(() => configuredEngine()).toThrow(/Unknown/);
  });
});
