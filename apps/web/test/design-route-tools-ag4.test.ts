/** Re-check 3: the design route tidies a change's tools before the card: only what the fix needs, never a second tool of the same type. */
import { describe, expect, it, vi } from 'vitest';

const sqlite = (id: string, name = 'sqlite', extra: Record<string, unknown> = {}) => ({ id, type: 'node', nodeType: 'databases.sqlite', name, description: 'x', parameters: {}, ...extra });
const http = { id: 'h1', type: 'node', nodeType: 'core.httpRequest', name: 'http_request', description: 'x', parameters: {} };
let designedTools: unknown[] = [];
let designedNeeds: Array<{ tool: string; kind: string; text: string }> = [];
vi.mock('@/lib/server/assistant/architect', () => ({
  designAgent: vi.fn(async (spec: Record<string, unknown>) => ({
    config: { name: String(spec.name), description: '', instructions: '', skills: [], tools: designedTools, schedules: [], channels: [], memory: { crossSession: false }, settings: {} },
    needs: designedNeeds, missing: [], dropped: [], designed: true, cases: [], notAdded: [],
  })),
}));
vi.mock('@/lib/server/assistant/scope', async (original) => ({ ...(await original<typeof import('@/lib/server/assistant/scope')>()), allowedTypes: () => [{ type: 'databases.sqlite', descriptor: { displayName: 'SQLite', credentials: [{ name: 'sqlite', required: true }], properties: [] } }] }));
const { POST } = await import('@/app/api/agents/design/route');
const post = (body: unknown) => POST(new Request('http://localhost/api/agents/design', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
const baseOf = (tools: unknown[]) => ({ config: { name: 'Sales digest', description: '', instructions: '', skills: [], tools, schedules: [], channels: [], memory: { crossSession: false }, settings: {} } });
const toolNames = async (res: Response) => ((await res.json()).config.tools as Array<{ name: string }>).map((t) => t.name);

describe('POST /api/agents/design with a change', () => {
  it('drops a bare duplicate and its Left rows; a twin that brings a credential stays its own tool', async () => {
    designedTools = [sqlite('t1'), sqlite('n2', 'SQLite_2')];
    designedNeeds = [{ tool: 'SQLite_2', kind: 'parameter', text: 'SQLite_2: fill in query' }, { tool: 'sqlite', kind: 'credential', text: 'sqlite: pick a sqlite credential' }];
    const body = await (await post({ name: 'Sales digest', preview: true, base: baseOf([sqlite('t1')]), change: 'Connect Sales DB' })).json();
    designedNeeds = [];
    expect(body.needs.map((n: { tool: string }) => n.tool)).toEqual(['sqlite']);
    expect(body.config.tools).toHaveLength(1);
    designedTools = [sqlite('t1'), sqlite('n2', 'sqlite_2', { credentials: { sqlite: { id: 'c1', name: 'Sales DB' } } })];
    const second = await (await post({ name: 'Sales digest', preview: true, base: baseOf([sqlite('t1')]), change: 'Connect Sales DB' })).json();
    expect(second.config.tools).toHaveLength(2);
    expect(second.config.tools[0]).not.toHaveProperty('credentials');
  });
});

describe('design route output, applied, then read back', () => {
  it('the stored tool equals the card’s: operation, query and asks-first', async () => {
    const { agentStore } = await import('@/lib/server/agents/store');
    const agentRoute = await import('@/app/api/agents/[id]/route');
    const agent = agentStore.create({ name: 'Sales digest', description: '' });
    designedTools = [sqlite('n1', 'sqlite', { parameters: { operation: 'executeQuery', query: 'SELECT total FROM sales' }, credentials: { sqlite: { id: 'c1', name: 'Sales DB' } } })];
    const card = (await (await post({ name: 'Sales digest', preview: true, base: baseOf([]), change: 'Give the digest access to the sales database' })).json()).config;
    const ctx = { params: Promise.resolve({ id: agent.id }) };
    await agentRoute.PUT(new Request('http://localhost/x', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(card) }), ctx);
    const stored = (await (await agentRoute.GET(new Request('http://localhost/x'), ctx)).json()).agent.tools[0];
    expect(stored.parameters).toEqual(card.tools[0].parameters);
    expect(Boolean(stored.requireApproval)).toBe(Boolean(card.tools[0].requireApproval));
    expect(stored.parameters.operation).toBe('executeQuery');
  });
});
