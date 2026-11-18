/**
 * Re-check 3 (live shots 75, 85, 86): a designed change to an agent adds only what it needs and never a second tool of a node
 * type the agent already has ("SQLite 2"). Pure: `tidyChangedTools` is what the design route runs before the card.
 */
import { describe, expect, it } from 'vitest';
import { tidyChangedTools } from '@/lib/server/agents/change-tools';

const sqlite = (id: string, extra: Record<string, unknown> = {}) => ({ id, type: 'node', nodeType: 'databases.sqlite', name: 'sqlite', parameters: {}, ...extra });
const http = { id: 'h', type: 'node', nodeType: 'core.httpRequest', name: 'http_request', parameters: {} };
const names = (c: { tools?: unknown }) => (c.tools as Array<{ name: string }>).map((t) => t.name);

describe('an agent fix adds only what the cause needs', () => {
  it('drops the HTTP Request tool the cause never names, keeps the SQLite one it does', () => {
    const base = { tools: [] };
    const designed = { tools: [sqlite('n1', { credentials: { sqlite: { id: 'c1', name: 'Sales DB' } } }), http] };
    const out = tidyChangedTools(base, designed, { text: 'Connect the SQLite tool (Sales DB) so it reads real sales. the agent has no database tool', fix: true });
    expect(names(out)).toEqual(['sqlite']);
  });
  it('without a fix, a new tool the ask never names stays (a plain change may add several)', () => {
    expect(names(tidyChangedTools({ tools: [] }, { tools: [sqlite('n1'), http] }, { text: 'give it tools' }))).toEqual(['sqlite', 'http_request']);
  });
});

describe('a change that adds a tool the agent already has reuses it', () => {
  it('does not add “SQLite 2”: the existing tool is filled in with the credential it lacked', () => {
    const base = { tools: [sqlite('t1')] };
    const designed = { tools: [sqlite('t1'), { ...sqlite('n2', { name: 'sqlite_2' }), credentials: { sqlite: { id: 'c1', name: 'Sales DB' } }, parameters: { query: 'SELECT 1' } }] };
    const out = tidyChangedTools(base, designed, { text: 'Connect Sales DB to the agent' });
    expect(out.tools).toHaveLength(1);
    expect(out.tools[0]).toMatchObject({ id: 't1', credentials: { sqlite: { id: 'c1', name: 'Sales DB' } }, parameters: { query: 'SELECT 1' } });
  });
  it('fills only what is missing: a credential or a parameter the tool already has stays', () => {
    const mine = sqlite('t1', { credentials: { sqlite: { id: 'mine', name: 'Mine' } }, parameters: { query: 'SELECT 2' } });
    const base = { tools: [mine] };
    const designed = { tools: [mine, sqlite('n2', { credentials: { sqlite: { id: 'c1', name: 'Sales DB' } }, parameters: { query: 'SELECT 1', table: 'sales' } })] };
    const out = tidyChangedTools(base, designed, { text: 'Connect Sales DB' });
    expect(out.tools[0]).toMatchObject({ credentials: { sqlite: { id: 'mine' } }, parameters: { query: 'SELECT 2', table: 'sales' } });
  });
  it('adds a second one when the ask explicitly wants another', () => {
    const base = { tools: [sqlite('t1')] };
    const out = tidyChangedTools(base, { tools: [sqlite('t1'), sqlite('n2', { name: 'sqlite_2' })] }, { text: 'Add a second SQLite tool for the archive' });
    expect(out.tools).toHaveLength(2);
  });
});
