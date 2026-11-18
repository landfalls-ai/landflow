/**
 * Re-check 3-6 (live shots 75, 85, 86; Opus's probes): a designed change adds a tool as its own; the only tidy is dropping a duplicate (same type as a kept tool, no
 * credential, no differing parameter). Nothing is moved onto a kept tool. Pure: `tidyChangedTools` is what the design route runs. Real shapes: the architect's new
 * tool is named like SQLite_2 and carries a credential only when the ask named one.
 */
import { describe, expect, it } from 'vitest';
import { tidyChangedTools } from '@/lib/server/agents/change-tools';

const sqlite = (id: string, name: string, extra: Record<string, unknown> = {}) => ({ id, type: 'node', nodeType: 'databases.sqlite', name, parameters: {}, ...extra });
const http = (id: string, name: string, extra: Record<string, unknown> = {}) => ({ id, type: 'node', nodeType: 'core.httpRequest', name, parameters: {}, ...extra });
const cred = (id: string, name: string, slot = 'sqlite') => ({ [slot]: { id, name } });
const tidy = (base: unknown[], designed: unknown[]) => tidyChangedTools({ tools: base }, { tools: designed });
const names = (r: { config: { tools?: unknown } }) => (r.config.tools as Array<{ name: string }>).map((t) => t.name);

describe('a duplicate is dropped, nothing moves', () => {
  it('the original duplicate SQLite (no credential, same params) is dropped', () => {
    const old = sqlite('t1', 'Main', { parameters: { query: 'SELECT 1' } });
    const r = tidy([old], [old, sqlite('n2', 'SQLite_2', { parameters: { query: 'SELECT 1' } })]);
    expect(names(r)).toEqual(['Main']);
    expect(r.removed).toEqual(['SQLite_2']);
    expect(names(tidy([sqlite('t1', 'Main')], [sqlite('t1', 'Main'), sqlite('n2', 'SQLite_2')]))).toEqual(['Main']);
  });
  it('a new tool that brings a credential stays its own, and the kept tool is not given the credential', () => {
    const old = sqlite('t1', 'Main', { parameters: { query: 'SELECT 1' } });
    const r = tidy([old], [old, sqlite('n2', 'SQLite_2', { credentials: cred('c1', 'Sales DB') })]);
    expect(names(r)).toEqual(['Main', 'SQLite_2']);
    expect(r.config.tools![0]).toEqual(old);
  });
  it('a placeholder credential slot (no id) is not a credential', () => {
    const old = sqlite('t1', 'Main');
    expect(names(tidy([old], [old, sqlite('n2', 'SQLite_2', { credentials: { sqlite: {} } })]))).toEqual(['Main']);
  });
  it('a re-id’d kept tool (same type and name, a new id) counts as kept, so a bare twin is dropped', () => {
    expect(names(tidy([sqlite('t1', 'Main')], [sqlite('tl_new', 'Main'), sqlite('n2', 'SQLite_2')]))).toEqual(['Main']);
  });
  it('kept [insert, select] plus a new select: dropped, nothing overwritten', () => {
    const insert = sqlite('t1', 'writer', { parameters: { operation: 'insert', table: 'sales' }, requireApproval: true });
    const select = sqlite('t2', 'reader', { parameters: { operation: 'select', table: 'sales' } });
    const r = tidy([insert, select], [insert, select, sqlite('n3', 'sqlite_3', { parameters: { operation: 'select', table: 'sales' } })]);
    expect(names(r)).toEqual(['writer', 'reader']);
    expect(r.config.tools).toEqual([insert, select]);
  });
});

describe('every other new tool is its own tool', () => {
  it('“Add a SQLite tool for the archive DB”: SQLite_2 with a different table stays beside Main', () => {
    const main = sqlite('t1', 'Main', { credentials: cred('old', 'Old'), parameters: { table: 'main' } });
    const r = tidy([main], [main, sqlite('n2', 'SQLite_2', { parameters: { table: 'archive' } })]);
    expect(names(r)).toEqual(['Main', 'SQLite_2']);
    expect(r.config.tools![0]).toEqual(main);
  });
  it('the HTTP weather tool with an empty url and a bearer credential stays separate, and rates is unchanged', () => {
    const rates = http('t1', 'rates', { parameters: { url: 'https://rates.test' } });
    const weather = http('n2', 'weather', { parameters: { url: '' }, credentials: cred('b1', 'Weather token', 'httpBearerAuth') });
    const r = tidy([rates], [rates, weather]);
    expect(names(r)).toEqual(['rates', 'weather']);
    expect(r.config.tools![0]).toEqual(rates);
  });
  it('a bare HTTP tool whose URL differs from rates stays its own', () => {
    const rates = http('t1', 'rates', { parameters: { url: 'https://rates.test' } });
    expect(names(tidy([rates], [rates, http('n2', 'http_2', { parameters: { url: 'https://weather.test' } })]))).toEqual(['rates', 'http_2']);
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
