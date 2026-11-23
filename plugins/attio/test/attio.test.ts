/** The Attio node: changed-since operations (filters, paging, order, cursors), Record → Get, members and the actions' requests. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ACTIVITY_SUMMARY_MAX } from '@landflow/sdk';
import { Attio } from '../src/nodes/attio';
import { FakeAttio, LIST_ID, LIST_SLUG, text, TOKEN } from './fake-attio';
import { jsonOf, run, startFakeApi, type FakeApi } from './helpers';

const fake = new FakeAttio();
let api: FakeApi;
beforeAll(async () => {
  api = await startFakeApi(fake.handle);
});
afterAll(() => api.close());
beforeEach(() => {
  fake.seed();
  api.requests.length = 0;
});
const creds = () => ({ attioApi: { accessToken: TOKEN, baseUrl: api.url } });
const go = (parameters: Record<string, unknown>) => run(Attio, parameters as never, { credentials: creds() });
const queries = () => api.requests.filter((r) => r.path.endsWith('/query'));

describe('Record → Get Many Changed Since', () => {
  const op = { resource: 'record', operation: 'getManyChangedSince', object: 'deals', returnAll: true };

  it('any: reads every row, keeps those with a value set after Since, oldest first, each with a cursor', async () => {
    const items = jsonOf(await go({ ...op, since: '2026-10-01T00:00:00Z' }));
    expect(items.map((i) => i.sourceId)).toEqual(['attio:deals:r-renewal:2026-11-10T12:00:00.000Z', 'attio:deals:r-pilot:2026-11-11T09:00:00.000Z']);
    expect(items.map((i) => i.cursor)).toEqual(['2026-11-10T12:00:00.000Z', '2026-11-11T09:00:00.000Z']);
    expect(items[0]).toMatchObject({ kind: 'work.deal_won', customerHint: 'Acme Inc', actorEmail: 'ana@acme.example', source: 'attio' });
    expect(items[1]).toMatchObject({ kind: 'work.deal_moved', title: 'Globex pilot moved to In Progress' });
    expect(queries()[0].body.filter).toBeUndefined();
    expect(queries()[0].path).toBe(`/v2/objects/deals/records/query`);
  });

  it('feeding the last cursor back as Since returns only newer rows', async () => {
    const items = jsonOf(await go({ ...op, since: '2026-11-10T12:00:00.000Z' }));
    expect(items.map((i) => i.sourceId)).toEqual(['attio:deals:r-pilot:2026-11-11T09:00:00.000Z']);
    expect(jsonOf(await go({ ...op, since: '2026-11-11T09:00:00.000Z' }))).toEqual([]);
  });

  it('stage: sends the stage.active_from filter; created: sends the created_at filter', async () => {
    await go({ ...op, since: '2026-11-11T00:00:00Z', detect: 'stage' });
    expect(queries()[0].body.filter).toEqual({ stage: { active_from: { $gte: '2026-11-11T00:00:00.000Z' } } });
    const created = jsonOf(await go({ ...op, since: '2026-11-01T00:00:00Z', detect: 'created' }));
    expect(queries()[1].body.filter).toEqual({ created_at: { $gte: '2026-11-01T00:00:00.000Z' } });
    expect(created.map((i) => i.sourceId)).toEqual(['attio:deals:r-pilot:2026-11-11T09:00:00.000Z']);
  });

  it('the Stage Attribute option names another status attribute', async () => {
    await go({ ...op, since: '2026-11-11T00:00:00Z', detect: 'stage', activityOptions: { stageAttribute: 'phase' } });
    expect(queries()[0].body.filter).toEqual({ phase: { active_from: { $gte: '2026-11-11T00:00:00.000Z' } } });
  });

  it('pages 200 rows at a time with limit/offset until a short page, in order', async () => {
    for (let n = 0; n < 450; n++) {
      const at = new Date(Date.parse('2026-11-12T00:00:00Z') + n * 1000).toISOString();
      fake.records.push({ object: 'people', id: `bulk-${String(n).padStart(3, '0')}`, created_at: at, values: { name: [text(`Person ${n}`, at)] } });
    }
    const items = jsonOf(await go({ resource: 'record', operation: 'getManyChangedSince', object: 'people', returnAll: true, since: '2026-11-11T00:00:00Z' }));
    expect(items).toHaveLength(450);
    expect(items[0].sourceId).toBe('attio:people:bulk-000:2026-11-12T00:00:00.000Z');
    expect(items[449].sourceId).toBe('attio:people:bulk-449:2026-11-12T00:07:29.000Z');
    expect(queries().map((q) => [q.body.limit, q.body.offset])).toEqual([[200, 0], [200, 200], [200, 400]]);
  });

  it('limit keeps the oldest rows', async () => {
    const items = jsonOf(await go({ ...op, returnAll: false, limit: 1, since: '2026-10-01T00:00:00Z' }));
    expect(items.map((i) => i.cursor)).toEqual(['2026-11-10T12:00:00.000Z']);
  });

  it('items have exactly the activity keys plus cursor, and a summary within 600 characters', async () => {
    fake.records.push({ object: 'deals', id: 'r-long', created_at: '2026-11-12T01:00:00.000000000Z', values: { name: [text('x'.repeat(50), '2026-11-12T01:00:00.000000000Z')], description: [text('long '.repeat(400), '2026-11-12T01:00:00.000000000Z')] } });
    const items = jsonOf(await go({ ...op, since: '2026-11-12T00:00:00Z' }));
    expect(Object.keys(items[0]).sort()).toEqual(['actorEmail', 'cursor', 'customerHint', 'initiativeHint', 'kind', 'occurredAt', 'raw', 'source', 'sourceId', 'summary', 'teamHint', 'title', 'url']);
    expect(String(items[0].summary).length).toBeLessThanOrEqual(ACTIVITY_SUMMARY_MAX);
    expect(JSON.stringify(items[0].raw).length).toBeLessThan(4000);
  });

  it('a bad Since is a clear error', async () => {
    const response = await go({ ...op, since: 'yesterday-ish' });
    expect(response.error?.message).toMatch(/Since is not a time/);
  });
});

describe('List Entry → Get Many Changed Since', () => {
  const op = { resource: 'listEntry', operation: 'getManyChangedSince', list: LIST_SLUG, returnAll: true };

  it('maps pipeline entries: list slug in the id, parent deal URL, won by stage name, oldest first', async () => {
    const items = jsonOf(await go({ ...op, since: '2026-10-01T00:00:00Z' }));
    expect(items.map((i) => [i.sourceId, i.kind, i.cursor])).toEqual([
      [`attio:${LIST_SLUG}:e-renewal:2026-11-10T12:00:00.000Z`, 'work.deal_won', '2026-11-10T12:00:00.000Z'],
      [`attio:${LIST_SLUG}:e-pilot:2026-11-11T09:30:00.000Z`, 'work.deal_moved', '2026-11-11T09:30:00.000Z'],
    ]);
    expect(items[0]).toMatchObject({ url: 'https://app.attio.com/acme/deals/r-renewal', customerHint: 'Acme Inc', actorEmail: 'ana@acme.example', title: 'Acme renewal won in Sales pipeline' });
    expect(items[1].title).toBe('Globex pilot in Sales pipeline: Proposal');
  });

  it('stage detection sends the filter to the entries query; created reads all and filters here', async () => {
    await go({ ...op, since: '2026-11-11T00:00:00Z', detect: 'stage' });
    expect(queries()[0].path).toBe(`/v2/lists/${LIST_SLUG}/entries/query`);
    expect(queries()[0].body.filter).toEqual({ stage: { active_from: { $gte: '2026-11-11T00:00:00.000Z' } } });
    const created = jsonOf(await go({ ...op, since: '2026-11-01T00:00:00Z', detect: 'created' }));
    expect(queries()[1].body.filter).toBeUndefined();
    expect(created.map((i) => String(i.sourceId).split(':')[2])).toEqual(['e-pilot']);
  });
});

describe('Record → Get', () => {
  it('returns the activity item plus text with values and recent notes', async () => {
    const [item] = jsonOf(await go({ resource: 'record', operation: 'get', object: 'deals', recordId: 'r-renewal' }));
    expect(item).toMatchObject({ source: 'attio', kind: 'work.deal_won', customerHint: 'Acme Inc' });
    expect(String(item.text)).toContain('Acme renewal (deals)');
    expect(String(item.text)).toContain('stage: Won 🎉');
    expect(String(item.text)).toContain('Recent notes:\n- Call recap (2026-11-10T13:00:00.000Z): Signed for two years; wants SSO.');
    expect(api.requests.some((r) => r.path === '/v2/notes' && r.query.get('parent_record_id') === 'r-renewal')).toBe(true);
  });

  it('says so when the record is missing; maps 401 and 403 to hints', async () => {
    expect((await go({ resource: 'record', operation: 'get', object: 'deals', recordId: 'nope' })).error?.message).toMatch(/No deals record nope/);
    const bad = await run(Attio, { resource: 'record', operation: 'get', object: 'deals', recordId: 'r-pilot' }, { credentials: { attioApi: { accessToken: 'wrong', baseUrl: api.url } } });
    expect(bad.error?.message).toMatch(/401/);
    fake.fail.set('GET /v2/objects/deals/records/r-pilot', { status: 403, body: { status_code: 403, type: 'auth_error', code: 'missing_scope', message: 'Missing record_permission:read' } });
    const denied = await go({ resource: 'record', operation: 'get', object: 'deals', recordId: 'r-pilot' });
    expect(denied.error?.message).toMatch(/403.*Missing record_permission:read/);
  });
});

describe('Workspace Member → Get Many', () => {
  it('lists members with their email', async () => {
    expect(jsonOf(await go({ resource: 'workspaceMember', operation: 'getAll' }))).toEqual([
      { id: 'member-ana-0001', email: 'Ana@Acme.example', firstName: 'Ana', lastName: 'Silva', accessLevel: 'admin', createdAt: '2026-01-01T00:00:00.000000000Z' },
      { id: 'member-ben-0001', email: 'ben@acme.example', firstName: 'Ben', lastName: 'Lee', accessLevel: 'member', createdAt: '2026-02-01T00:00:00.000000000Z' },
    ]);
  });
});

describe('actions', () => {
  it('Note → Create posts the parent, title, format and content', async () => {
    const [out] = jsonOf(await go({ resource: 'note', operation: 'create', object: 'deals', recordId: 'r-pilot', title: 'Kickoff', content: 'Agreed next steps', format: 'markdown' }));
    const post = api.requests.find((r) => r.method === 'POST' && r.path === '/v2/notes')!;
    expect(post.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(post.body).toEqual({ data: { parent_object: 'deals', parent_record_id: 'r-pilot', title: 'Kickoff', format: 'markdown', content: 'Agreed next steps' } });
    expect(out).toMatchObject({ id: 'n-2', title: 'Kickoff', parentRecordId: 'r-pilot' });
  });

  it('Task → Create sends every required field: linked record, assignee emails, deadline', async () => {
    const [out] = jsonOf(await go({ resource: 'task', operation: 'create', taskContent: 'Call Pat', deadline: '2026-11-20T09:00:00Z', linkedObject: 'people', linkedRecordId: 'r-pat', assignees: 'ana@acme.example, ben@acme.example' }));
    const post = api.requests.find((r) => r.method === 'POST' && r.path === '/v2/tasks')!;
    expect(post.body).toEqual({
      data: {
        content: 'Call Pat',
        format: 'plaintext',
        deadline_at: '2026-11-20T09:00:00.000Z',
        is_completed: false,
        linked_records: [{ target_object: 'people', target_record_id: 'r-pat' }],
        assignees: [{ workspace_member_email_address: 'ana@acme.example' }, { workspace_member_email_address: 'ben@acme.example' }],
      },
    });
    expect(out).toMatchObject({ id: 't-2', content: 'Call Pat' });
    await go({ resource: 'task', operation: 'create', taskContent: 'Bare' });
    expect(api.requests.filter((r) => r.path === '/v2/tasks').at(-1)!.body.data).toMatchObject({ deadline_at: null, linked_records: [], assignees: [] });
    expect((await go({ resource: 'task', operation: 'create', taskContent: 'x', linkedObject: 'people' })).error?.message).toMatch(/both Linked Object and Linked Record ID/);
  });

  it('Record → Add to List posts the parent and entry values', async () => {
    const [out] = jsonOf(await go({ resource: 'record', operation: 'addToList', object: 'deals', recordId: 'r-pilot', list: LIST_SLUG, entryValues: '{"stage":"Lead"}' }));
    const post = api.requests.find((r) => r.method === 'POST' && r.path === `/v2/lists/${LIST_SLUG}/entries`)!;
    expect(post.body).toEqual({ data: { parent_record_id: 'r-pilot', parent_object: 'deals', entry_values: { stage: 'Lead' } } });
    expect(out).toMatchObject({ entryId: 'e-new-2', listId: LIST_ID });
    expect((await go({ resource: 'record', operation: 'addToList', object: 'deals', recordId: 'r', list: 'l', entryValues: '[1]' })).error?.message).toMatch(/not a JSON object/);
  });

  it('offers no delete or merge operation', () => {
    const operations = Attio.description.properties.filter((p) => p.name === 'operation').flatMap((p) => (p.options ?? []).map((o) => (o as { value: string }).value));
    expect(operations.filter((o) => /delete|merge|remove/i.test(o))).toEqual([]);
  });
});
