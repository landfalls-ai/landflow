/**
 * Re-check 3/4/5 (live shots 75, 85, 86; Opus's probes): a designed change adds a tool as its own unless it completes an incomplete
 * tool of the same type. Pure: `tidyChangedTools` is what the design route runs; the architect's real shape is a NEW tool with a
 * name like sqlite_2 and, when the ask names none, no credential.
 */
import { describe, expect, it } from 'vitest';
import { tidyChangedTools } from '@/lib/server/agents/change-tools';

const sqlite = (id: string, extra: Record<string, unknown> = {}) => ({ id, type: 'node', nodeType: 'databases.sqlite', name: 'sqlite', parameters: {}, ...extra });
const http = (id: string, url: string, extra: Record<string, unknown> = {}) => ({ id, type: 'node', nodeType: 'core.httpRequest', name: 'http_request', parameters: { url }, ...extra });
const cred = (id: string, name: string) => ({ sqlite: { id, name } });
const required = (t: string) => (t === 'databases.sqlite' ? { credentials: ['sqlite'], parameters: [] } : t === 'core.httpRequest' ? { credentials: [], parameters: ['url'] } : undefined);
const tidy = (base: unknown[], designed: unknown[]) => tidyChangedTools({ tools: base }, { tools: designed }, required);
const names = (r: { config: { tools?: unknown } }) => (r.config.tools as Array<{ name: string }>).map((t) => t.name);

describe('a new tool joins an incomplete tool of its type', () => {
  it('the original “SQLite 2” case: the old tool lacks its credential, so the new one fills it in and no second tool stays', () => {
    const base = sqlite('t1');
    const r = tidy([base], [base, sqlite('n2', { name: 'SQLite_2', credentials: cred('c1', 'Sales DB'), parameters: { query: 'SELECT 1' } })]);
    expect(r.config.tools).toHaveLength(1);
    expect(r.config.tools![0]).toMatchObject({ id: 't1', credentials: { sqlite: { id: 'c1', name: 'Sales DB' } }, parameters: { query: 'SELECT 1' } });
    expect(r.removed).toEqual(['SQLite_2']);
  });
  it('the real shape: the new tool has no credential either, and the incomplete old one still absorbs it', () => {
    const base = sqlite('t1');
    const r = tidy([base], [base, sqlite('n2', { name: 'SQLite_2' })]);
    expect(r.config.tools).toHaveLength(1);
  });
  it('an incomplete tool is filled only where it is empty: its own value is never replaced', () => {
    const base = http('t1', '', { parameters: { url: '', method: 'GET' } });
    const r = tidy([base], [base, http('n2', 'https://rates.test', { name: 'http_2', parameters: { url: 'https://rates.test', timeout: 5 } })]);
    expect(r.config.tools).toHaveLength(1);
    expect(r.config.tools![0]).toMatchObject({ parameters: { url: 'https://rates.test', method: 'GET', timeout: 5 } });
    // A differing non-empty value (POST against GET) keeps the new tool apart.
    expect(tidy([base], [base, http('n3', '', { name: 'http_3', parameters: { url: '', method: 'POST' } })]).config.tools).toHaveLength(2);
  });
});

describe('every other new tool is its own tool', () => {
  it('“Add a SQLite tool for the archive DB”: the old tool is complete and the architect gave the new one no credential', () => {
    const old = sqlite('t1', { credentials: cred('old', 'Old') });
    const r = tidy([old], [old, sqlite('n2', { name: 'SQLite_2' })]);
    expect(names(r)).toEqual(['sqlite', 'SQLite_2']);
    expect(r.config.tools![0]).toMatchObject({ credentials: { sqlite: { id: 'old' } } });
    expect(r.removed).toEqual([]);
  });
  it('“also let it call the weather API”: the params differ, so the HTTP tools stay two even if the first is incomplete otherwise', () => {
    const rates = http('t1', 'https://rates.test', { credentials: undefined });
    const r = tidyChangedTools({ tools: [rates] }, { tools: [rates, http('n2', 'https://weather.test', { name: 'http_2' })] }, (t) => (t === 'core.httpRequest' ? { credentials: [], parameters: ['url', 'method'] } : undefined));
    expect(r.config.tools).toHaveLength(2);
  });
  it('a complete tool never receives params from a new one', () => {
    const old = sqlite('t1', { credentials: cred('old', 'Old'), parameters: { query: 'A' } });
    const r = tidy([old], [old, sqlite('n2', { name: 's2', parameters: { query: 'B' } })]);
    expect(r.config.tools![0]).toMatchObject({ parameters: { query: 'A' } });
    expect(r.config.tools).toHaveLength(2);
  });
});

describe('a change never undoes itself', () => {
  it('“Switch the SQLite tool to the Sales DB credential”: the dropped tool does not come back', () => {
    const old = sqlite('t1', { credentials: cred('old', 'Old') });
    const r = tidy([old], [sqlite('n2', { credentials: cred('sales', 'Sales DB') })]);
    expect(r.config.tools).toHaveLength(1);
    expect(r.config.tools![0]).toMatchObject({ id: 'n2', credentials: { sqlite: { id: 'sales' } } });
  });
  it('a changed parameter stays: query B is not given back as A', () => {
    const a = sqlite('t1', { credentials: cred('c', 'C'), parameters: { query: 'A' } });
    expect(tidy([a], [{ ...a, parameters: { query: 'B' } }]).config.tools![0]).toMatchObject({ parameters: { query: 'B' } });
  });
  it('a re-id’d kept tool (same type and name, a new id) is the kept tool', () => {
    const r = tidy([sqlite('t1')], [sqlite('tl_new'), sqlite('n2', { name: 'SQLite_2', credentials: cred('sales', 'Sales DB') })]);
    expect(r.config.tools).toHaveLength(1);
    expect(r.config.tools![0]).toMatchObject({ id: 'tl_new', credentials: { sqlite: { id: 'sales' } } });
  });
});
