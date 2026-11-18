/**
 * Re-check 3/4 (live shots 75, 85, 86; Opus's probes): a designed change to an agent adds only what it needs, never a second tool
 * of a node type the agent kept, and never undoes the person's own change. Pure: `tidyChangedTools` is what the design route runs.
 */
import { describe, expect, it } from 'vitest';
import { tidyChangedTools } from '@/lib/server/agents/change-tools';

const sqlite = (id: string, extra: Record<string, unknown> = {}) => ({ id, type: 'node', nodeType: 'databases.sqlite', name: 'sqlite', parameters: {}, ...extra });
const cred = (id: string, name: string) => ({ sqlite: { id, name } });
const http = { id: 'h', type: 'node', nodeType: 'core.httpRequest', name: 'http_request', parameters: {} };
const tidy = (base: unknown[], designed: unknown[], text: string, fix = false) => tidyChangedTools({ tools: base }, { tools: designed }, { text, fix, titleOf: (t) => (t === 'core.httpRequest' ? 'HTTP Request' : undefined) });
const names = (r: { config: { tools?: unknown } }) => (r.config.tools as Array<{ name: string }>).map((t) => t.name);

describe('a change never undoes what the design did', () => {
  it('“Switch the SQLite tool to the Sales DB credential”: the dropped tool does not come back, its credential does not win', () => {
    const old = sqlite('t1', { credentials: cred('old', 'Old') });
    const r = tidy([old], [sqlite('n2', { credentials: cred('sales', 'Sales DB') })], 'Switch the SQLite tool to the Sales DB credential');
    expect(r.config.tools).toHaveLength(1);
    expect(r.config.tools![0]).toMatchObject({ id: 'n2', credentials: { sqlite: { id: 'sales' } } });
  });
  it('a changed parameter stays: the kept tool’s query B is not given back as A', () => {
    const a = sqlite('t1', { parameters: { query: 'A' } });
    const r = tidy([a], [{ ...a, parameters: { query: 'B' } }], 'Change the SQLite query to B');
    expect(r.config.tools![0]).toMatchObject({ parameters: { query: 'B' } });
  });
  it('“Add a SQLite tool for the archive DB” keeps the archive credential as its own tool', () => {
    const old = sqlite('t1', { credentials: cred('old', 'Old') });
    const r = tidy([old], [old, sqlite('n2', { name: 'sqlite_archive', credentials: cred('arch', 'Archive DB') })], 'Add a SQLite tool for the archive DB');
    expect(names(r)).toEqual(['sqlite', 'sqlite_archive']);
    expect(r.config.tools![0]).toMatchObject({ credentials: { sqlite: { id: 'old' } } });
  });
  it('a re-id’d kept tool (same type and name, a new id) is the kept tool, and a new twin of it still reuses it', () => {
    const base = sqlite('t1');
    const r = tidy([base], [sqlite('tl_new'), sqlite('n2', { name: 'sqlite_2', credentials: cred('sales', 'Sales DB') })], 'Connect Sales DB');
    expect(r.config.tools).toHaveLength(1);
    expect(r.config.tools![0]).toMatchObject({ id: 'tl_new', credentials: { sqlite: { id: 'sales' } } });
  });
});

describe('a change that adds a tool the agent kept reuses it', () => {
  it('does not add “SQLite 2”: the kept tool is filled in with the credential it lacked', () => {
    const base = sqlite('t1');
    const r = tidy([base], [base, sqlite('n2', { name: 'sqlite_2', credentials: cred('c1', 'Sales DB'), parameters: { query: 'SELECT 1' } })], 'Connect Sales DB to the agent');
    expect(r.config.tools).toHaveLength(1);
    expect(r.config.tools![0]).toMatchObject({ id: 't1', credentials: { sqlite: { id: 'c1', name: 'Sales DB' } }, parameters: { query: 'SELECT 1' } });
    expect(r.removed).toEqual(['sqlite_2']);
  });
  it('fills only what is missing', () => {
    const mine = sqlite('t1', { credentials: cred('mine', 'Mine'), parameters: { query: 'SELECT 2' } });
    const r = tidy([mine], [mine, sqlite('n2', { credentials: cred('mine', 'Mine'), parameters: { query: 'SELECT 1', table: 'sales' } })], 'Connect Mine');
    expect(r.config.tools![0]).toMatchObject({ credentials: { sqlite: { id: 'mine' } }, parameters: { query: 'SELECT 2', table: 'sales' } });
  });
  it('adds another when the ask says so (“another”, “a second”), but “both” and “two” alone no longer do', () => {
    const base = sqlite('t1');
    expect(tidy([base], [base, sqlite('n2', { name: 's2' })], 'Add a second SQLite tool').config.tools).toHaveLength(2);
    expect(tidy([base], [base, sqlite('n2', { name: 's2' })], 'Give both agents the SQLite tool').config.tools).toHaveLength(1);
    expect(tidy([base], [base, sqlite('n2', { name: 's2' })], 'It reads two tables from SQLite').config.tools).toHaveLength(1);
  });
});

describe('an agent fix adds only what the cause needs, and never ends with nothing', () => {
  it('drops the HTTP Request tool the cause never names, says so, and keeps SQLite', () => {
    const r = tidy([], [sqlite('n1', { credentials: cred('c1', 'Sales DB') }), http], 'Connect the SQLite tool (Sales DB). the agent has no database tool', true);
    expect(names(r)).toEqual(['sqlite']);
    expect(r.dropped).toEqual(['http_request']);
  });
  it.each([
    ['Connect the Sales DB database. the agent has no database tool', [sqlite('n1', { credentials: cred('c1', 'Sales DB') })]],
    ['Give it an HTTP tool to fetch the rates API', [http]],
    ['Connect the Sales knowledge base', [{ id: 'k1', type: 'knowledge', name: 'Sales docs', collection: 'sales-kb' }]],
  ])('keeps the tool “%s” names (never a dead No change card)', (text, tools) => {
    const r = tidy([], tools, text, true);
    expect(r.config.tools).toHaveLength(1);
    expect(r.dropped).toEqual([]);
  });
  it('drops nothing when no new tool is named at all', () => {
    expect(tidy([], [sqlite('n1'), http], 'fix it', true).config.tools).toHaveLength(2);
  });
  it('without a fix, a new tool the ask never names stays', () => {
    expect(names(tidy([], [sqlite('n1'), http], 'give it tools'))).toEqual(['sqlite', 'http_request']);
  });
});
