/** The Clickland node and credential against the fake API: request shapes per operation, errors with hints, time ranges. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { JsonObject } from '@landflow/sdk';
import { ClicklandNode } from '../src/nodes/clickland';
import { timeRange } from '../src/shared';
import { KEY, startFakeClickland, type FakeClickland } from './fake-clickland';
import { credentials, jsonOf, run, testCredentials } from './helpers';

let fake: FakeClickland;
beforeAll(async () => {
  fake = await startFakeClickland();
});
afterAll(() => fake.close());
beforeEach(() => fake.reset());

const call = (parameters: JsonObject, extra: { continueOnFail?: boolean } = {}) => run(ClicklandNode, parameters, { credentials: credentials(fake), ...extra });
const last = () => fake.requests.at(-1)!;
const FROM = '2026-11-14T14:00:00.000Z';
const TO = '2026-11-14T15:00:00.000Z';

describe('credential', () => {
  it('checks health without the key, then lists alerts with it', async () => {
    const result = await testCredentials({ baseUrl: fake.url, apiKey: KEY });
    expect(result).toMatchObject({ ok: true, message: 'Connected to Clickland 0.1.0: 0 alerts' });
    expect(fake.requests.map((r) => [r.method, r.path, r.headers.authorization])).toEqual([
      ['GET', '/api/health', undefined],
      ['GET', '/api/alerts', `Bearer ${KEY}`],
    ]);
  });

  it('fails with the 401 hint on a wrong key', async () => {
    const result = await testCredentials({ baseUrl: `${fake.url}/`, apiKey: 'ck_wrong' });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/401: Invalid API key/);
  });
});

describe('time range', () => {
  const now = Date.parse(TO);
  it('defaults to the last N minutes before now', () => {
    expect(timeRange({ lastMinutes: 15 }, undefined, now)).toEqual({ from: '2026-11-14T14:45:00.000Z', to: TO });
    expect(timeRange({}, undefined, now)).toEqual({ from: FROM, to: TO });
  });
  it('takes From and To, and Last Minutes before To', () => {
    expect(timeRange({ from: '2026-11-14T10:00:00Z', to: '2026-11-14T11:00:00Z', lastMinutes: 5 }, undefined, now)).toEqual({ from: '2026-11-14T10:00:00.000Z', to: '2026-11-14T11:00:00.000Z' });
    expect(timeRange({ to: '2026-11-14T11:00:00Z', lastMinutes: 30 }, undefined, now)).toEqual({ from: '2026-11-14T10:30:00.000Z', to: '2026-11-14T11:00:00.000Z' });
  });
  it('refuses a reversed window and a bad date', () => {
    expect(() => timeRange({ from: TO, to: FROM })).toThrow(/before To/);
    expect(() => timeRange({ from: 'yesterday-ish' })).toThrow(/not a date/);
    expect(() => timeRange({ lastMinutes: 0 })).toThrow(/positive/);
  });
});

describe('logs and traces', () => {
  it('searches logs: one item per row, the body as the contract says', async () => {
    const out = await call({ resource: 'logs', operation: 'search', query: 'level:error', from: FROM, to: TO, limit: 50, before: '', output: 'rows' });
    expect(jsonOf(out).map((j) => j.body)).toEqual(['second', 'first']);
    expect(last()).toMatchObject({ method: 'POST', path: '/api/search', body: { signal: 'logs', query: 'level:error', from: FROM, to: TO, limit: 50 } });
    expect(last().body).not.toHaveProperty('before');
  });

  it('searches spans as one response item, paging with Before', async () => {
    const out = await call({ resource: 'traces', operation: 'search', query: 'duration:>500', from: FROM, to: TO, limit: 999, before: 'c9', output: 'response' });
    expect(jsonOf(out)).toEqual([expect.objectContaining({ nextCursor: 'c1', rows: expect.any(Array), stats: expect.any(Object) })]);
    expect(last().body).toMatchObject({ signal: 'traces', limit: 500, before: 'c9' });
  });

  it('asks for a histogram with a group and patterns with a sample', async () => {
    await call({ resource: 'logs', operation: 'getHistogram', query: '', lastMinutes: 30, to: TO, groupBy: 'service' });
    expect(last()).toMatchObject({ path: '/api/search/histogram', body: { signal: 'logs', query: '', from: '2026-11-14T14:30:00.000Z', to: TO, groupBy: 'service' } });
    expect(last().body).not.toHaveProperty('limit');
    const patterns = await call({ resource: 'logs', operation: 'getPatterns', query: 'level:error', from: FROM, to: TO, sample: 2000 });
    expect(last()).toMatchObject({ path: '/api/patterns', body: { signal: 'logs', query: 'level:error', sample: 2000 } });
    expect(jsonOf(patterns)[0]).toMatchObject({ total: 9120 });
  });

  it('gets a trace by id, and says so when it is missing', async () => {
    expect(jsonOf(await call({ resource: 'traces', operation: 'get', traceId: 'abc123' }))[0]).toMatchObject({ traceId: 'abc123' });
    expect(last()).toMatchObject({ method: 'GET', path: '/api/traces/abc123' });
    const missing = await call({ resource: 'traces', operation: 'get', traceId: 'missing' });
    expect(missing.error?.message).toMatch(/404/);
  });

  it('passes a query syntax error on with its position', async () => {
    const out = await call({ resource: 'logs', operation: 'search', query: 'bad(', from: FROM, to: TO });
    expect(out.error?.message).toBe('Clickland API error 400: Unexpected end of query (at position 4)');
    expect(out.error?.description).toMatch(/query syntax/);
  });
});

describe('services and metrics', () => {
  it('lists services in a window, one item each', async () => {
    const out = await call({ resource: 'services', operation: 'list', from: FROM, to: TO });
    expect(jsonOf(out).map((j) => j.name)).toEqual(['api', 'checkout']);
    expect(last()).toMatchObject({ method: 'GET', path: '/api/services', query: { from: FROM, to: TO } });
  });

  it('lists metric names and queries one', async () => {
    expect(jsonOf(await call({ resource: 'metrics', operation: 'list', from: FROM, to: TO }))[0]).toMatchObject({ name: 'http.server.duration' });
    expect(last()).toMatchObject({ path: '/api/metrics/names', query: { from: FROM, to: TO } });
    await call({ resource: 'metrics', operation: 'getSeries', metric: 'http.server.duration', metricType: 'histogram', aggregation: 'p95', service: 'checkout', groupBy: '', from: FROM, to: TO });
    expect(last()).toMatchObject({ method: 'POST', path: '/api/metrics/query', body: { metric: 'http.server.duration', type: 'histogram', aggregation: 'p95', service: 'checkout', from: FROM, to: TO } });
    expect(last().body).not.toHaveProperty('groupBy');
  });
});

describe('alerts', () => {
  const create = () =>
    call({ resource: 'alerts', operation: 'create', name: 'API errors', signal: 'logs', query: 'service:api level:error', groupBy: '', thresholdType: 'above', threshold: 10, windowMinutes: 5, intervalMinutes: 1, enabled: true });

  it('creates an alert with the contract body', async () => {
    const out = await create();
    expect(last()).toMatchObject({ method: 'POST', path: '/api/alerts' });
    expect(last().body).toEqual({ name: 'API errors', signal: 'logs', query: 'service:api level:error', groupBy: null, thresholdType: 'above', threshold: 10, windowMinutes: 5, intervalMinutes: 1, enabled: true });
    expect(jsonOf(out)[0]).toMatchObject({ id: 'al_1' });
  });

  it('updates only the fields asked, keeping the rest (GET then PUT)', async () => {
    await create();
    await call({ resource: 'alerts', operation: 'update', alertId: 'al_1', updateFields: { threshold: 25, enabled: false } });
    const put = last();
    expect(put).toMatchObject({ method: 'PUT', path: '/api/alerts/al_1' });
    expect(put.body).toEqual({ name: 'API errors', signal: 'logs', query: 'service:api level:error', groupBy: null, thresholdType: 'above', threshold: 25, windowMinutes: 5, intervalMinutes: 1, enabled: false });
    const nothing = await call({ resource: 'alerts', operation: 'update', alertId: 'al_1', updateFields: {} });
    expect(nothing.error?.message).toMatch(/at least one field/);
  });

  it('lists, gets, reads events and deletes', async () => {
    await create();
    fake.state.events.al_1 = [{ id: 'ev_2', state: 'ok' }, { id: 'ev_1', state: 'firing' }];
    expect(jsonOf(await call({ resource: 'alerts', operation: 'list' }))).toHaveLength(1);
    expect(jsonOf(await call({ resource: 'alerts', operation: 'get', alertId: 'al_1' }))[0]).toMatchObject({ name: 'API errors' });
    expect(jsonOf(await call({ resource: 'alerts', operation: 'getEvents', alertId: 'al_1', limit: 1 })).map((j) => j.id)).toEqual(['ev_2']);
    expect(last().query).toEqual({ limit: '1' });
    expect(jsonOf(await call({ resource: 'alerts', operation: 'delete', alertId: 'al_1' }))).toEqual([{ deleted: true, id: 'al_1' }]);
    expect(fake.state.alerts).toEqual([]);
  });

  it('names the missing scope on a 403, and continues on fail', async () => {
    fake.failNext(403, { error: { code: 'forbidden', message: 'Missing scope' } });
    const out = await create();
    expect(out.error?.description).toMatch(/alerts:write/);
    fake.failNext(403, { error: { code: 'forbidden', message: 'Missing scope' } });
    const kept = await call({ resource: 'alerts', operation: 'list' }, { continueOnFail: true });
    expect(jsonOf(kept)[0]).toMatchObject({ error: 'Clickland API error 403: Missing scope' });
  });
});

describe('notes and knowledge', () => {
  it('creates a note with lists split and empty fields left out', async () => {
    await call({ resource: 'notes', operation: 'create', title: 'Checkout timeouts', body: 'Payments pool exhausted', noteFields: { service: 'checkout', tags: 'incident, payments', traceIds: 'abc, def', author: '' } });
    expect(last()).toMatchObject({ method: 'POST', path: '/api/notes' });
    expect(last().body).toEqual({ title: 'Checkout timeouts', body: 'Payments pool exhausted', service: 'checkout', tags: ['incident', 'payments'], traceIds: ['abc', 'def'] });
  });

  it('lists notes with filters', async () => {
    await call({ resource: 'notes', operation: 'list', service: 'checkout', q: '', limit: 5 });
    expect(last()).toMatchObject({ method: 'GET', path: '/api/notes', query: { service: 'checkout', limit: '5' } });
  });

  it('searches knowledge with the question and returns { results }', async () => {
    const out = await call({ resource: 'knowledge', operation: 'search', query: 'why does checkout time out?', limit: 99, from: '', to: '' });
    expect(last()).toMatchObject({ method: 'POST', path: '/api/knowledge/search' });
    expect(last().body).toEqual({ query: 'why does checkout time out?', limit: 25 });
    expect(jsonOf(out)).toEqual([{ results: [expect.objectContaining({ pageContent: 'About: why does checkout time out?', score: 0.83 })] }]);
  });
});

describe('views and dashboards', () => {
  const spec = { title: 'Checkout latency', range: { lastMinutes: 60 }, panels: [{ type: 'services', title: 'Services' }] };

  it('renders a view from a spec (JSON text or object) and returns its marker', async () => {
    const out = await call({ resource: 'views', operation: 'render', spec: JSON.stringify(spec), pinned: false });
    expect(last()).toMatchObject({ method: 'POST', path: '/api/views', body: { spec, pinned: false } });
    expect(jsonOf(out)[0]).toEqual({ id: 'vw_1', url: 'http://127.0.0.1:4711/views/vw_1', resourceUri: 'ui://clickland/view', marker: '[[clickland:view:vw_1]]' });
    await call({ resource: 'views', operation: 'render', spec, pinned: true });
    expect(last().body.pinned).toBe(true);
    const empty = await call({ resource: 'views', operation: 'render', spec: { title: 'x', panels: [] } });
    expect(empty.error?.message).toMatch(/at least one panel/);
  });

  it('saves a view as a named dashboard, lists dashboards and gets one', async () => {
    await call({ resource: 'views', operation: 'render', spec });
    await call({ resource: 'views', operation: 'pin', viewId: 'vw_1', pinned: true, title: 'Checkout' });
    expect(last()).toMatchObject({ method: 'PUT', path: '/api/views/vw_1', body: { pinned: true, title: 'Checkout' } });
    expect(jsonOf(await call({ resource: 'views', operation: 'list', pinnedOnly: true }))).toEqual([expect.objectContaining({ id: 'vw_1', title: 'Checkout', pinned: true })]);
    expect(last().query).toEqual({ pinned: 'true' });
    expect(jsonOf(await call({ resource: 'views', operation: 'get', viewId: 'vw_1' }))[0]).toMatchObject({ spec, version: 2 });
  });

  it('edits a dashboard: add a panel at a position, remove one, update with a version check', async () => {
    await call({ resource: 'views', operation: 'render', spec, pinned: true });
    const p95 = { type: 'metric', title: 'p95 latency', metric: 'http.server.duration', metricType: 'histogram', aggregation: 'p95', service: 'checkout' };
    await call({ resource: 'views', operation: 'addPanel', viewId: 'vw_1', panel: JSON.stringify(p95), position: -1 });
    expect(last()).toMatchObject({ method: 'POST', path: '/api/views/vw_1/panels', body: { panel: p95 } });
    expect(last().body).not.toHaveProperty('position');
    await call({ resource: 'views', operation: 'addPanel', viewId: 'vw_1', panel: { type: 'markdown', title: 'Note', text: 'hi' }, position: 0 });
    expect(last().body.position).toBe(0);
    expect(fake.state.views.get('vw_1').spec.panels.map((p: JsonObject) => p.type)).toEqual(['markdown', 'services', 'metric']);
    await call({ resource: 'views', operation: 'removePanel', viewId: 'vw_1', index: 0 });
    expect(last()).toMatchObject({ method: 'DELETE', path: '/api/views/vw_1/panels/0' });
    const stale = await call({ resource: 'views', operation: 'update', viewId: 'vw_1', viewFields: { title: 'Checkout v2', version: 1 } });
    expect(stale.error?.message).toMatch(/409/);
    await call({ resource: 'views', operation: 'update', viewId: 'vw_1', viewFields: { spec: JSON.stringify(spec), version: 4 } });
    expect(last().body).toEqual({ spec, version: 4 });
    const nothing = await call({ resource: 'views', operation: 'update', viewId: 'vw_1', viewFields: {} });
    expect(nothing.error?.message).toMatch(/at least one/);
  });
});
