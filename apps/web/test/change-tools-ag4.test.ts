/**
 * Re-check 3-6 (live shots 75, 85, 86; Opus's probes): a designed change adds a tool as its own unless a plain three-part rule lets it
 * fill a kept tool that has no credential. Pure: `tidyChangedTools` is what the design route runs. Real shapes: the architect's new
 * tool is named like SQLite_2 and carries a credential only when the ask named one.
 */
import { describe, expect, it } from 'vitest';
import { tidyChangedTools } from '@/lib/server/agents/change-tools';

const sqlite = (id: string, name: string, extra: Record<string, unknown> = {}) => ({ id, type: 'node', nodeType: 'databases.sqlite', name, parameters: {}, ...extra });
const http = (id: string, name: string, extra: Record<string, unknown> = {}) => ({ id, type: 'node', nodeType: 'core.httpRequest', name, parameters: {}, ...extra });
const cred = (id: string, name: string, slot = 'sqlite') => ({ [slot]: { id, name } });
const tidy = (base: unknown[], designed: unknown[]) => tidyChangedTools({ tools: base }, { tools: designed });
const names = (r: { config: { tools?: unknown } }) => (r.config.tools as Array<{ name: string }>).map((t) => t.name);

describe('a new tool fills a kept tool that has no credential (the “SQLite 2” case)', () => {
  it('the old tool has none and the new one brings Sales DB: merged, nothing lost', () => {
    const old = sqlite('t1', 'Main', { parameters: { query: 'SELECT 1' } });
    const r = tidy([old], [old, sqlite('n2', 'SQLite_2', { credentials: cred('c1', 'Sales DB') })]);
    expect(names(r)).toEqual(['Main']);
    expect(r.config.tools![0]).toMatchObject({ id: 't1', credentials: { sqlite: { id: 'c1', name: 'Sales DB' } }, parameters: { query: 'SELECT 1' } });
    expect(r.removed).toEqual(['SQLite_2']);
  });
  it('the old tool has none and the new one brings none either: merged', () => {
    const old = sqlite('t1', 'Main');
    expect(names(tidy([old], [old, sqlite('n2', 'SQLite_2')]))).toEqual(['Main']);
  });
  it('two new tools into one empty one: only the first merges, the second stays separate', () => {
    const old = sqlite('t1', 'Main');
    const r = tidy([old], [old, sqlite('n2', 'SQLite_2', { credentials: cred('c1', 'Sales DB') }), sqlite('n3', 'SQLite_3', { credentials: cred('c2', 'Archive DB') })]);
    expect(names(r)).toEqual(['Main', 'SQLite_3']);
    expect(r.config.tools![0]).toMatchObject({ credentials: { sqlite: { id: 'c1' } } });
  });
  it('a re-id’d kept tool (same type and name, a new id) counts as the kept tool', () => {
    const r = tidy([sqlite('t1', 'Main')], [sqlite('tl_new', 'Main'), sqlite('n2', 'SQLite_2', { credentials: cred('c1', 'Sales DB') })]);
    expect(names(r)).toEqual(['Main']);
    expect(r.config.tools![0]).toMatchObject({ id: 'tl_new', credentials: { sqlite: { id: 'c1' } } });
  });
});

describe('every other new tool is its own tool', () => {
  it('“Add a SQLite tool for the archive DB”: a complete Main, and SQLite_2 with no credential, stay two', () => {
    const main = sqlite('t1', 'Main', { credentials: cred('old', 'Old') });
    const r = tidy([main], [main, sqlite('n2', 'SQLite_2')]);
    expect(names(r)).toEqual(['Main', 'SQLite_2']);
    expect(r.config.tools![0]).toMatchObject({ credentials: { sqlite: { id: 'old' } } });
  });
  it('the Archive credential and a query on a kept tool that has Main and no query stay separate (the params differ)', () => {
    const main = sqlite('t1', 'Main', { parameters: { table: 'main' } });
    const r = tidy([main], [main, sqlite('n2', 'SQLite_2', { credentials: cred('arch', 'Archive DB'), parameters: { table: 'archive', query: 'SELECT 1' } })]);
    expect(names(r)).toEqual(['Main', 'SQLite_2']);
    expect(r.config.tools![0]).toMatchObject({ parameters: { table: 'main' } });
    expect(r.config.tools![0]).not.toHaveProperty('credentials');
  });
  it('an HTTP tool with no params next to a rates tool that has its bearer credential stays separate', () => {
    const rates = http('t1', 'rates', { parameters: { url: 'https://rates.test' }, credentials: cred('b1', 'Rates token', 'httpBearerAuth') });
    expect(names(tidy([rates], [rates, http('n2', 'http_2')]))).toEqual(['rates', 'http_2']);
  });
  it('an HTTP tool with a bearer credential next to rates (no credential) stays separate when the URL or the params differ', () => {
    const rates = http('t1', 'rates', { parameters: { url: 'https://rates.test', method: 'GET' } });
    const bearer = (parameters: Record<string, unknown>) => http('n2', 'http_2', { parameters, credentials: cred('b2', 'Weather token', 'httpBearerAuth') });
    expect(names(tidy([rates], [rates, bearer({ url: 'https://weather.test' })]))).toEqual(['rates', 'http_2']);
    expect(names(tidy([rates], [rates, bearer({ method: 'POST' })]))).toEqual(['rates', 'http_2']);
  });
  it('a complete tool never receives params from a new one, and a new tool with two credentials stays its own', () => {
    const old = sqlite('t1', 'Main', { credentials: cred('old', 'Old'), parameters: { query: 'A' } });
    const r = tidy([old], [old, sqlite('n2', 'SQLite_2', { parameters: { query: 'B' } })]);
    expect(r.config.tools![0]).toMatchObject({ parameters: { query: 'A' } });
    const bare = sqlite('t3', 'Bare');
    expect(names(tidy([bare], [bare, sqlite('n4', 'two', { credentials: { a: { id: '1', name: 'a' }, b: { id: '2', name: 'b' } } })]))).toEqual(['Bare', 'two']);
  });
});

describe('a change never undoes itself', () => {
  it('“Switch the SQLite tool to the Sales DB credential”: the dropped tool does not come back', () => {
    const old = sqlite('t1', 'Main', { credentials: cred('old', 'Old') });
    const r = tidy([old], [sqlite('n2', 'Main_new', { credentials: cred('sales', 'Sales DB') })]);
    expect(r.config.tools).toHaveLength(1);
    expect(r.config.tools![0]).toMatchObject({ id: 'n2', credentials: { sqlite: { id: 'sales' } } });
  });
  it('a changed parameter stays: query B is not given back as A', () => {
    const a = sqlite('t1', 'Main', { credentials: cred('c', 'C'), parameters: { query: 'A' } });
    expect(tidy([a], [{ ...a, parameters: { query: 'B' } }]).config.tools![0]).toMatchObject({ parameters: { query: 'B' } });
  });
});
