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
  it('the Left rows are worked out after the merge: none names the merged-away tool', async () => {
    designedTools = [sqlite('t1'), sqlite('n2', 'SQLite_2', { credentials: { sqlite: { id: 'c1', name: 'Sales DB' } } })];
    designedNeeds = [{ tool: 'SQLite_2', kind: 'parameter', text: 'SQLite_2: fill in query' }, { tool: 'sqlite', kind: 'credential', text: 'sqlite: pick a sqlite credential' }];
    const res = await post({ name: 'Sales digest', preview: true, base: baseOf([sqlite('t1')]), change: 'Connect Sales DB' });
    const body = await res.json();
    designedNeeds = [];
    expect(body.needs.map((n: { tool: string }) => n.tool)).toEqual(['sqlite']);
  });
  it('a change that adds SQLite to an agent that has it fills the existing tool, never “sqlite_2”', async () => {
    designedTools = [sqlite('t1'), sqlite('n2', 'sqlite_2', { credentials: { sqlite: { id: 'c1', name: 'Sales DB' } } })];
    const res = await post({ name: 'Sales digest', preview: true, base: baseOf([sqlite('t1')]), change: 'Connect Sales DB' });
    const body = await res.json();
    expect(body.config.tools).toHaveLength(1);
    expect(body.config.tools[0]).toMatchObject({ id: 't1', credentials: { sqlite: { id: 'c1' } } });
  });
});
