/**
 * The Linear node against a fake GraphQL endpoint: changed-since reads (paging, oldest first, cursor, ties, filters),
 * Get, User → Get Many, the three actions' requests, the credential test and the activity item shape.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ACTIVITY_ITEM_SCHEMA, type JsonObject } from '@landflow/sdk';
import { plugin } from '../src/main';
import { Linear } from '../src/nodes/linear';
import { issueKind } from '../src/activity';
import { API_KEY, FakeLinear, issue, OAUTH_TOKEN, startFakeLinear } from './fake-linear';
import { jsonOf, loadOptions, run, testCredentials, type FakeApi } from './helpers';

const fake = new FakeLinear();
let api: FakeApi;
beforeAll(async () => {
  api = await startFakeLinear(fake);
});
afterAll(() => api.close());

const BASE = '2026-11-12T10:00:00.000Z';
const at = (seconds: number) => new Date(Date.parse(BASE) + seconds * 1000).toISOString();

const ITEM_KEYS = ['actorEmail', 'customerHint', 'initiativeHint', 'kind', 'occurredAt', 'raw', 'source', 'sourceId', 'summary', 'teamHint', 'title', 'url'];

/** The item has exactly the schema's fields (plus `extra`), the right types, and a short summary. */
function expectActivity(item: JsonObject, extra: string[] = []) {
  const properties = ACTIVITY_ITEM_SCHEMA.properties as Record<string, { type: string | string[] }>;
  for (const key of ACTIVITY_ITEM_SCHEMA.required as string[]) expect(item, key).toHaveProperty(key);
  for (const [key, value] of Object.entries(item)) {
    if (extra.includes(key)) continue;
    expect(Object.keys(properties), `unexpected field ${key}`).toContain(key);
    const types = ([] as string[]).concat(properties[key].type);
    const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value === 'object' ? 'object' : typeof value;
    expect(types, `${key} is ${actual}`).toContain(actual);
  }
  expect(Object.keys(item).filter((k) => !extra.includes(k)).sort()).toEqual(ITEM_KEYS);
  expect(String(item.summary).length).toBeLessThanOrEqual(600);
  expect(item.occurredAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
}

const creds = () => ({ linearApi: { apiKey: API_KEY, baseUrl: api.url } });
const call = (parameters: JsonObject) => run(Linear, { authentication: 'apiKey', ...parameters }, { credentials: creds() });
const issuesSince = (parameters: JsonObject = {}) => call({ resource: 'issue', operation: 'getManySince', since: BASE, returnAll: true, ...parameters });

beforeEach(() => {
  fake.issues = [];
  fake.comments = [];
  fake.projectUpdates = [];
  fake.users = [];
  fake.webhooks = [];
  fake.created = [];
  fake.rateLimitOnce = undefined;
  api.requests.length = 0;
});

describe('Issue → Get Many Changed Since', () => {
  it('reads every page, oldest first, with a cursor and the activity item shape', async () => {
    fake.issues = [
      ...Array.from({ length: 120 }, (_, i) => issue(1000 + i, 100 + i)),
      issue(1, 30, { description: 'x'.repeat(2000), labels: { nodes: [{ name: 'customer:Acme' }] } }),
      issue(2, 10, { team: { key: 'CS', name: 'Support' }, project: null }),
      issue(3, -60), // before Since
    ];
    const response = await issuesSince();
    expect(response.error).toBeUndefined();
    const items = jsonOf(response);
    expect(items).toHaveLength(122);
    expect(items.slice(0, 2).map((i) => i.title)).toEqual(['ENG-2: Issue 2', 'ENG-1: Issue 1']);
    expect(items.map((i) => i.cursor)).toEqual([...items].map((i) => i.cursor).sort());
    for (const item of items) expectActivity(item, ['cursor']);
    expect(items[1]).toMatchObject({
      source: 'linear',
      sourceId: `linear:issue:iss-1:${at(30)}`,
      url: 'https://linear.app/acme/issue/ENG-1/issue-1',
      actorEmail: 'dana@acme.example',
      occurredAt: at(30),
      cursor: at(30),
      teamHint: 'Engineering',
      initiativeHint: 'Export',
      customerHint: 'Acme',
    });
    expect(String(items[1].summary)).toHaveLength(600);
    expect(items[0]).toMatchObject({ teamHint: 'Support', initiativeHint: null, customerHint: null });
    // 122 issues in pages of 50: three requests, the later ones carrying `after`.
    const reads = api.requests.filter((r) => /issues\(/.test(r.body.query));
    expect(reads).toHaveLength(3);
    expect(reads.map((r) => r.body.variables.after)).toEqual([undefined, 'c50', 'c100']);
    expect(reads[0].body.variables.filter).toEqual({ updatedAt: { gt: BASE } });
    expect(reads[0].headers.authorization).toBe(API_KEY);
  });

  it('continues after a cursor, limits to the oldest and keeps ties together', async () => {
    fake.issues = [issue(1, 10), issue(2, 20), issue(3, 20), issue(4, 30)];
    const limited = jsonOf(await issuesSince({ returnAll: false, limit: 2 }));
    // The second and third share an updatedAt: both are returned so the next read (gt) loses nothing.
    expect(limited.map((i) => i.title)).toEqual(['ENG-1: Issue 1', 'ENG-2: Issue 2', 'ENG-3: Issue 3']);
    const next = jsonOf(await issuesSince({ since: limited[2].cursor, returnAll: false, limit: 5 }));
    expect(next.map((i) => i.title)).toEqual(['ENG-4: Issue 4']);
    // An empty Since reads the last 24 hours.
    await issuesSince({ since: '' });
    const gt = Date.parse(api.requests.at(-1)!.body.variables.filter.updatedAt.gt);
    expect(Math.abs(Date.now() - 86_400_000 - gt)).toBeLessThan(10_000);
  });

  it('filters by team key and rejects a bad Since', async () => {
    fake.issues = [issue(1, 10), issue(2, 20, { team: { key: 'CS', name: 'Support' } })];
    const items = jsonOf(await issuesSince({ activityOptions: { teamKey: 'CS' } }));
    expect(items.map((i) => i.teamHint)).toEqual(['Support']);
    const bad = await issuesSince({ since: 'last tuesday' });
    expect(bad.error?.message).toMatch(/Since must be an ISO 8601 time/);
  });

  it('maps kinds: new issue by label, otherwise ticket_moved; customer needs beat the label prefix', async () => {
    const newIssue = (n: number, sec: number, labels: string[], extra: JsonObject = {}) => issue(n, sec, { createdAt: at(sec), labels: { nodes: labels.map((name) => ({ name })) }, ...extra });
    fake.issues = [
      newIssue(1, 10, ['Bug']),
      newIssue(2, 20, ['Feature Request']),
      newIssue(3, 30, ['Improvement']),
      issue(4, 40, { labels: { nodes: [{ name: 'Bug' }] } }), // updated an hour after it was created
      newIssue(5, 50, ['customer:Globex'], { needs: { nodes: [{ customer: { name: 'Initech' } }] } }),
    ];
    const items = jsonOf(await issuesSince());
    expect(items.map((i) => i.kind)).toEqual(['work.bug_reported', 'work.feature_request', 'work.ticket_moved', 'work.ticket_moved', 'work.ticket_moved']);
    expect(items[4].customerHint).toBe('Initech');
    const noPrefix = jsonOf(await issuesSince({ activityOptions: { customerNeeds: false, customerLabelPrefix: '' } }));
    expect(noPrefix[4].customerHint).toBeNull();
    expect(api.requests.at(-1)!.body.query).not.toContain('needs(');
    expect(issueKind(['bug'], false)).toBe('work.ticket_moved');
  });

  it('waits out a 429 and retries', async () => {
    fake.issues = [issue(1, 10)];
    fake.rateLimitOnce = 0;
    const started = Date.now();
    const items = jsonOf(await issuesSince());
    expect(items).toHaveLength(1);
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    expect(api.requests).toHaveLength(2);
  });

  it('explains a rejected key without echoing it', async () => {
    const response = await run(Linear, { authentication: 'apiKey', resource: 'issue', operation: 'getManySince' }, { credentials: { linearApi: { apiKey: 'lin_api_wrong', baseUrl: api.url } } });
    expect(response.error?.message).toMatch(/Linear API error 401: Authentication required/);
    expect(JSON.stringify(response.error)).not.toContain('lin_api_wrong');
    expect(response.error?.description).toMatch(/API key/);
  });
});

describe('Comment and Project Update → Get Many Changed Since', () => {
  it('reads comments and project updates as work.discussion and work.self_update', async () => {
    fake.comments = [
      { id: 'c2', body: 'Second', url: 'https://linear.app/acme/issue/ENG-1#c2', createdAt: at(5), updatedAt: at(40), user: { email: 'Lee@acme.example' }, issue: { id: 'iss-1', identifier: 'ENG-1', title: 'Issue 1', team: { key: 'ENG', name: 'Engineering' }, project: { name: 'Export' }, labels: { nodes: [{ name: 'customer:Acme' }] } } },
      { id: 'c1', body: 'First\nline', url: 'https://linear.app/acme/issue/ENG-1#c1', createdAt: at(5), updatedAt: at(20), user: null, issue: null, projectUpdate: { id: 'pu-1', project: { name: 'Export' } } },
    ];
    fake.projectUpdates = [{ id: 'pu-1', body: 'On track', url: 'https://linear.app/acme/project/export/updates', updatedAt: at(50), health: 'onTrack', user: { email: 'lee@acme.example' }, project: { name: 'Export', teams: { nodes: [{ name: 'Engineering' }] } } }];
    const comments = jsonOf(await call({ resource: 'comment', operation: 'getManySince', since: BASE, returnAll: true }));
    expect(comments.map((c) => c.sourceId)).toEqual([`linear:comment:c1:${at(20)}`, `linear:comment:c2:${at(40)}`]);
    for (const c of comments) expectActivity(c, ['cursor']);
    expect(comments[0]).toMatchObject({ kind: 'work.discussion', title: 'Export: First', actorEmail: null, initiativeHint: 'Export' });
    expect(comments[1]).toMatchObject({ title: 'ENG-1: Second', actorEmail: 'lee@acme.example', teamHint: 'Engineering', customerHint: 'Acme', cursor: at(40) });
    const updates = jsonOf(await call({ resource: 'projectUpdate', operation: 'getManySince', since: BASE, returnAll: true }));
    expect(updates).toHaveLength(1);
    expectActivity(updates[0], ['cursor']);
    expect(updates[0]).toMatchObject({ kind: 'work.self_update', teamHint: 'Engineering', initiativeHint: 'Export', title: 'Export update (onTrack): On track' });
  });
});

describe('Issue → Get', () => {
  it('returns the activity item with the description and comments as text, by identifier', async () => {
    fake.issues = [issue(7, 10, { comments: { nodes: [{ body: 'Looks good', createdAt: at(5), user: { name: 'Lee', email: 'lee@acme.example' } }] } })];
    const response = await call({ resource: 'issue', operation: 'get', issueId: 'ENG-7' });
    expect(response.error).toBeUndefined();
    const item = jsonOf(response)[0];
    expectActivity(item, ['text']);
    expect(item.text).toBe(`Description of issue 7\n\n---\n\nLee (${at(5)}): Looks good`);
    expect(api.requests.at(-1)!.body.variables).toEqual({ id: 'ENG-7' });
    const missing = await call({ resource: 'issue', operation: 'get', issueId: 'ENG-99' });
    expect(missing.error?.message).toBe('No issue ENG-99');
  });
});

describe('User → Get Many', () => {
  it('pages through users with lowercase email, flags and team names', async () => {
    fake.users = Array.from({ length: 130 }, (_, i) => ({ id: `u${i}`, name: `user${i}`, displayName: `U${i}`, email: i === 0 ? 'Dana@Acme.example' : `u${i}@acme.example`, active: i !== 5, admin: i === 0, guest: false, teams: { nodes: [{ key: 'ENG', name: 'Engineering' }] }, updatedAt: at(1000 - i) }));
    const all = jsonOf(await call({ resource: 'user', operation: 'getAll', returnAll: true }));
    expect(all).toHaveLength(129); // the deactivated one is left out
    expect(all[0]).toEqual({ id: 'u0', name: 'user0', displayName: 'U0', email: 'dana@acme.example', active: true, admin: true, guest: false, teams: ['Engineering'] });
    const limited = jsonOf(await call({ resource: 'user', operation: 'getAll', returnAll: false, limit: 3, includeDisabled: true }));
    expect(limited.map((u) => u.id)).toEqual(['u0', 'u1', 'u2']);
    expect(api.requests.at(-1)!.body.variables).toMatchObject({ first: 3, includeDisabled: true });
  });
});

describe('Actions', () => {
  it('Issue → Create sends the input and returns the issue', async () => {
    const response = await call({
      resource: 'issue', operation: 'create', teamId: 'team-1', title: 'Fix export', description: 'It crashes',
      additionalFields: { priority: 2, assigneeId: 'u-1', labelIds: 'l1, l2', projectId: 'p-1', dueDate: '2026-12-01' },
    });
    expect(response.error).toBeUndefined();
    expect(jsonOf(response)[0]).toMatchObject({ identifier: expect.stringMatching(/^ENG-/), title: 'Fix export' });
    expect(fake.created).toEqual([{ kind: 'issue', input: { teamId: 'team-1', title: 'Fix export', description: 'It crashes', priority: 2, assigneeId: 'u-1', projectId: 'p-1', dueDate: '2026-12-01', labelIds: ['l1', 'l2'] } }]);
    expect(api.requests.at(-1)!.body.query).toContain('issueCreate');
    expect((await call({ resource: 'issue', operation: 'create', teamId: 'team-1', title: ' ' })).error?.message).toBe('Title is required');
  });

  it('Comment → Create sends issueId, body and the thread parent', async () => {
    const response = await call({ resource: 'comment', operation: 'create', issueId: 'ENG-1', body: 'Shipped', parentId: 'c-root' });
    expect(response.error).toBeUndefined();
    expect(jsonOf(response)[0]).toMatchObject({ body: 'Shipped' });
    expect(fake.created).toEqual([{ kind: 'comment', input: { issueId: 'ENG-1', body: 'Shipped', parentId: 'c-root' } }]);
  });

  it('Issue → Add Link attaches a URL, titled with the URL when no title is given', async () => {
    await call({ resource: 'issue', operation: 'addLink', issueId: 'ENG-1', url: 'https://github.com/acme/app/pull/42', linkTitle: 'PR 42', linkSubtitle: 'draft' });
    await call({ resource: 'issue', operation: 'addLink', issueId: 'ENG-1', url: 'https://example.com/x' });
    expect(fake.created).toEqual([
      { kind: 'attachment', input: { issueId: 'ENG-1', url: 'https://github.com/acme/app/pull/42', title: 'PR 42', subtitle: 'draft' } },
      { kind: 'attachment', input: { issueId: 'ENG-1', url: 'https://example.com/x', title: 'https://example.com/x' } },
    ]);
  });

  it('has no delete, archive or close operation, and every action is a tool', () => {
    const values = Linear.description.properties.filter((p) => p.name === 'operation').flatMap((p) => (p.options ?? []).map((o) => (o as unknown as JsonObject).value));
    expect(values.sort()).toEqual(['addLink', 'create', 'create', 'get', 'getAll', 'getManySince', 'getManySince', 'getManySince']);
    expect(Linear.description.usableAsTool).toBe(true);
  });

  it('works with the OAuth2 credential (Bearer) and lists teams for the picker', async () => {
    const response = await run(Linear, { authentication: 'oAuth2', resource: 'comment', operation: 'create', issueId: 'ENG-1', body: 'hi' }, { credentials: { linearOAuth2Api: { accessToken: OAUTH_TOKEN, baseUrl: api.url } } });
    expect(response.error).toBeUndefined();
    expect(api.requests.at(-1)!.headers.authorization).toBe(`Bearer ${OAUTH_TOKEN}`);
    const teams = await loadOptions(Linear, 'getTeams', {}, creds());
    expect(teams).toEqual([{ name: 'Engineering (ENG)', value: 'team-1' }]);
  });
});

describe('Credentials', () => {
  it('tests the API key and the OAuth2 token with a viewer query', async () => {
    expect(await testCredentials('linearApi', creds().linearApi)).toMatchObject({ ok: true, message: 'Authenticated as Dana Fake (dana@acme.example)' });
    expect(api.requests.at(-1)!.headers.authorization).toBe(API_KEY);
    expect(await testCredentials('linearOAuth2Api', { accessToken: OAUTH_TOKEN, baseUrl: api.url })).toMatchObject({ ok: true });
    const bad = await testCredentials('linearApi', { apiKey: 'lin_api_wrong', baseUrl: api.url });
    expect(bad.ok).toBe(false);
    expect(bad.message).toMatch(/401/);
    expect(bad.message).not.toContain('lin_api_wrong');
  });

  it('declares OAuth2 with minimal scopes and the activity schemas on the reads', () => {
    const oauth = plugin.credentialTypes.find((c) => c.name === 'linearOAuth2Api')!;
    expect(oauth.extends).toEqual(['oAuth2Api']);
    expect(oauth.properties.find((p) => p.name === 'scope')!.default).toBe('read,issues:create,comments:create');
    expect(oauth.properties.find((p) => p.name === 'accessTokenUrl')!.default).toBe('https://api.linear.app/oauth/token');
    const ops = Linear.description.properties.filter((p) => p.name === 'operation').flatMap((p) => p.options ?? []) as unknown as JsonObject[];
    for (const o of ops.filter((x) => x.value === 'getManySince')) expect(o.outputSchema).toBe(ACTIVITY_ITEM_SCHEMA);
    expect((ops.find((o) => o.value === 'get')!.outputSchema as JsonObject).required).toContain('text');
  });
});
