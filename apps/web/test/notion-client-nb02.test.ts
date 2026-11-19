/**
 * The host's Notion client (NB02) against the local Notion fake only: headers and Markdown v2, the limiter (a fake clock), the
 * retry rules, pagination, `request_status`, unknown blocks, the database create, the scoped writer, text limits, ids, the write
 * log, no key anywhere, and the byte-identical contract copies.
 */
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { defineCredentialType, definePlugin } from '@landflow/sdk';
import { FAKE_NOTION_TOKEN, startFakeNotion, type FakeNotion } from './fake-notion';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-notion-nb02-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { registry } = await import('@/lib/server/plugins/registry');
const { credentials, CredentialError } = await import('@/lib/server/credentials/vault');
const { notionClient } = await import('@/lib/server/notion/client');
const { notionClientFor, notionId, isNotionError, NOTION_VERSION } = await import('@/lib/server/notion/port');
const { resetLimiters, currentRate } = await import('@/lib/server/notion/limiter');
const { scopedWriter } = await import('@/lib/server/notion/scope');
const { richText, fitMarkdown, plainText, CUT_LINE } = await import('@/lib/server/notion/text');
const { logger } = await import('@/lib/server/telemetry');
await import('@/lib/server/runtime');

registry.registerBuiltin(
  definePlugin({
    info: { id: 'productivity', name: 'Productivity (stand-in)', version: '0.0.0', language: 'typescript' },
    credentialTypes: [
      defineCredentialType({
        name: 'notionApi',
        displayName: 'Notion API',
        properties: [
          { name: 'apiKey', displayName: 'Internal Integration Secret', type: 'string', required: true, typeOptions: { password: true } },
          { name: 'baseUrl', displayName: 'API Base URL', type: 'string', default: 'https://api.notion.com' },
        ],
      }),
    ],
    nodes: [],
  }),
);

let fake: FakeNotion;
let cred: string;
let other: string;
let seq = 0;
const output: string[] = [];

beforeAll(async () => {
  fake = await startFakeNotion();
  cred = credentials.create({ name: 'Notion', type: 'productivity.notionApi', data: { apiKey: FAKE_NOTION_TOKEN, baseUrl: fake.url } }).id;
  other = credentials.create({ name: 'Notion 2', type: 'productivity.notionApi', data: { apiKey: FAKE_NOTION_TOKEN, baseUrl: fake.url } }).id;
  for (const level of ['warn', 'info', 'error', 'debug'] as const) {
    const real = logger[level].bind(logger);
    vi.spyOn(logger, level).mockImplementation(((...args: unknown[]) => {
      output.push(JSON.stringify(args));
      return (real as (...a: unknown[]) => unknown)(...args);
    }) as never);
  }
});
afterAll(async () => {
  await fake.close();
  vi.restoreAllMocks();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});
afterEach(() => {
  resetLimiters();
  fake.setRateLimit(0);
});

/** A virtual clock: `sleep` advances it and records the wait. */
function clock() {
  let t = 1_000_000;
  const waits: number[] = [];
  return { waits, now: () => t, sleep: async (ms: number) => { waits.push(ms); t += ms; }, advance: (ms: number) => { t += ms; } };
}
const make = (options: { credentialId?: string; rps?: number } = {}) => {
  const c = clock();
  const client = notionClient({ credentialId: options.credentialId ?? cred, rps: options.rps, now: c.now, sleep: c.sleep });
  return { client, c };
};
const root = () => fake.addPage({ title: `Root ${++seq}`, shared: true });

describe('the client against the fake', () => {
  it('is registered and sends the version on every request and v2 on every Markdown call', async () => {
    const before = fake.state.requests.length;
    const factory = notionClientFor({ credentialId: cred });
    expect((await factory.me()).type).toBe('bot');
    const { client } = make();
    const id = root();
    const page = await client.createPage({ parent: { page_id: id }, properties: { title: { title: richText('A') } }, markdown: 'hello' });
    await client.pageMarkdown(page.id);
    await client.updateMarkdown(page.id, { type: 'replace_content', replace_content: { new_str: 'bye' } });
    const mine = fake.state.requests.slice(before);
    expect(mine.length).toBeGreaterThan(3);
    expect(mine.every((r) => r.status !== 400)).toBe(true);
    for (const r of mine.filter((r) => r.template.endsWith('/markdown'))) {
      if (r.method === 'GET') expect(r.query.markdown_version).toBe('v2');
      else expect(r.body?.markdown_version).toBe('v2');
    }
    expect(mine.find((r) => r.method === 'POST' && r.template === '/v1/pages')?.body?.markdown_version).toBe('v2');
    expect(NOTION_VERSION).toBe('2026-03-11');
  });

  it('starts 20 queued calls no faster than the bucket allows, shares it per credential', async () => {
    const c = clock();
    const a = notionClient({ credentialId: cred, rps: 2, now: c.now, sleep: c.sleep });
    const b = notionClient({ credentialId: cred, now: c.now, sleep: c.sleep });
    const x = notionClient({ credentialId: other, rps: 2, now: c.now, sleep: c.sleep });
    const start = c.now();
    await Promise.all(Array.from({ length: 10 }, (_, i) => (i % 2 ? a : b).me()));
    await Promise.all(Array.from({ length: 10 }, () => a.me()));
    // 20 calls, burst 3, 2 a second: the clock was pushed to (20 - 3) / 2 = 8.5 s.
    expect(c.now() - start).toBeGreaterThanOrEqual(8400);
    // A second credential starts with its own full burst.
    const before = c.now();
    await x.me();
    await x.me();
    await x.me();
    expect(c.now()).toBe(before);
  });

  it('waits Retry-After on 429, halves the rate after 5 in a row, treats 529 alike', async () => {
    const { client, c } = make();
    fake.setRateLimit(1, 3);
    await client.me();
    expect(c.waits.filter((w) => w === 3000)).toHaveLength(1);
    fake.setRateLimit(5, 1);
    await client.me();
    expect(currentRate(cred, c.now())).toBe(1);
    expect(currentRate(cred, c.now() + 11 * 60_000)).toBe(2);
    resetLimiters();
    const d = make();
    fake.failNext({ status: 529, retryAfter: 2 });
    await d.client.me();
    expect(d.c.waits).toContain(2000);
    const e = make();
    fake.failNext({ status: 429, additionalRetryAfter: 7 });
    await e.client.me();
    expect(e.c.waits).toContain(7000);
  });

  it('never retries a blocked 429 and flags a 503 on a write', async () => {
    const { client, c } = make();
    const before = fake.state.requests.length;
    fake.failNext({ status: 429, code: 'public_api_request_blocked' });
    const blocked = await client.me().catch((e) => e);
    expect(isNotionError(blocked) && blocked.kind).toBe('blocked');
    expect(fake.state.requests.length - before).toBe(1);
    const id = root();
    const before2 = fake.state.requests.length;
    fake.failNext({ status: 503 });
    const lost = await client.createPage({ parent: { page_id: id }, markdown: '# T' }).catch((e) => e);
    expect(isNotionError(lost) && lost.mayHaveLanded).toBe(true);
    expect(fake.state.requests.length - before2).toBe(1);
    expect(c.waits).toEqual([]);
  });

  it('backs off on 500 for a read, gives up after 6 tries, maps the other statuses', async () => {
    const { client, c } = make();
    fake.failNext({ status: 500 }, 2);
    await client.me();
    expect(c.waits.length).toBe(2);
    fake.failNext({ status: 500 }, 6);
    const err = await client.me().catch((e) => e);
    expect(err.kind).toBe('unavailable');
    fake.failNext({ status: 409 });
    expect((await client.me().catch((e) => e)).kind).toBe('conflict');
    for (const [status, kind] of [[400, 'invalid'], [401, 'unauthorized'], [403, 'forbidden'], [404, 'notFound']] as const) {
      const before = fake.state.requests.length;
      fake.failNext({ status });
      expect((await client.me().catch((e) => e)).kind).toBe(kind);
      expect(fake.state.requests.length - before).toBe(1);
    }
  });

  it('paginates by next_cursor while has_more, and surfaces incomplete queries', async () => {
    const capped = await startFakeNotion({ queryCap: 5 });
    const cid = credentials.create({ name: 'Capped', type: 'productivity.notionApi', data: { apiKey: FAKE_NOTION_TOKEN, baseUrl: capped.url } }).id;
    const { client } = make({ credentialId: cid });
    const parent = capped.addPage({ title: 'R', shared: true });
    const db = await client.createDatabase({ parent: { page_id: parent }, title: 'Rows', properties: { Name: { title: {} } } });
    for (let i = 0; i < 8; i++) await client.createPage({ parent: { data_source_id: db.dataSourceId }, properties: { Name: { title: richText(`r${i}`) } } });
    const first = await client.queryDataSource(db.dataSourceId, { page_size: 2 });
    expect(first.request_status).toEqual({ type: 'incomplete', incomplete_reason: 'query_result_limit_reached' });
    const seen: string[] = [];
    for await (const page of client.paginate((cursor) => client.queryDataSource(db.dataSourceId, { page_size: 2, start_cursor: cursor }))) seen.push(page.id);
    expect(seen).toHaveLength(5);
    await capped.close();
  });

  it('follows unknown blocks and keeps truncated past the cap', async () => {
    const { client } = make();
    const id = root();
    fake.setUnknownBlocks(id, { '11111111-1111-1111-1111-111111111111': 'piece one', '22222222-2222-2222-2222-222222222222': 'piece two' });
    const read = await client.pageMarkdown(id);
    expect(read.markdown).toContain('piece one');
    expect(read.markdown).toContain('piece two');
    expect(read.unknown_block_ids).toEqual([]);
    const many = root();
    fake.setUnknownBlocks(many, Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`${String(i).padStart(8, '0')}-0000-0000-0000-000000000000`, `p${i}`])));
    const capped = await client.pageMarkdown(many);
    expect(capped.truncated).toBe(true);
    expect(capped.unknown_block_ids.length).toBe(5);
  });

  it('createDatabase returns the property ids read from the data source', async () => {
    const { client } = make();
    const db = await client.createDatabase({ parent: { page_id: root() }, title: 'Facts', properties: { Name: { title: {} }, Note: { rich_text: {} } } });
    expect(Object.keys(db.propertyIds).sort()).toEqual(['Name', 'Note']);
    expect(Object.values(db.propertyIds).every((v) => v.length > 0)).toBe(true);
    expect(fake.state.requests.some((r) => r.method === 'GET' && r.path === `/v1/data_sources/${db.dataSourceId}`)).toBe(true);
  });
});

describe('the scoped writer', () => {
  it('passes under the root, refuses elsewhere before any request, logs the id only', async () => {
    const { client } = make();
    const rootId = root();
    const stranger = fake.addPage({ title: 'Stranger', shared: true });
    const own = new Set<string>();
    const writer = scopedWriter(client, { rootId, ownIds: (id) => own.has(id), ownDataSources: new Set() });
    const made = await writer.createPage({ parent: { page_id: rootId }, markdown: '# Mine' });
    own.add(made.id);
    await writer.updateMarkdown(made.id, { type: 'replace_content', replace_content: { new_str: 'x' } });
    const before = fake.state.requests.length;
    output.length = 0;
    await expect(writer.createPage({ parent: { page_id: stranger }, markdown: '# no' })).rejects.toMatchObject({ kind: 'outsideRoot' });
    await expect(writer.updatePage(stranger, { in_trash: true })).rejects.toMatchObject({ kind: 'outsideRoot' });
    await expect(writer.updateMarkdown(stranger, { type: 'replace_content', replace_content: { new_str: 'x' } })).rejects.toMatchObject({ kind: 'outsideRoot' });
    await expect(writer.createDatabase({ parent: { page_id: stranger }, title: 'x', properties: { Name: { title: {} } } })).rejects.toMatchObject({ kind: 'outsideRoot' });
    await expect(writer.updateDataSource('ffffffff-ffff-ffff-ffff-ffffffffffff', { properties: {} })).rejects.toMatchObject({ kind: 'outsideRoot' });
    expect(fake.state.requests.length).toBe(before);
    expect(output.join('\n')).toContain(`[notion-brain] refused write ${stranger}`);
    expect(output.join('\n')).not.toContain('# no');
    await writer.page(stranger);
  });
});

describe('text, ids and logs', () => {
  it('splits rich text and cuts Markdown at a heading', () => {
    expect(richText('a'.repeat(4500))).toHaveLength(3);
    expect(richText('a'.repeat(250_000))).toHaveLength(100);
    expect(richText('a'.repeat(250_000)).at(-1)!.text.content.endsWith('…')).toBe(true);
    expect(plainText([{ type: 'text', text: { content: 'x' }, plain_text: 'xy' }])).toBe('xy');
    const md = Array.from({ length: 1000 }, (_, i) => `## Section ${i}\n\n${'paragraph\n\n'.repeat(4)}`).join('');
    const fit = fitMarkdown(md);
    expect(fit.endsWith(`${CUT_LINE}\n`)).toBe(true);
    expect(fit.replace(CUT_LINE, '').trim().split('\n').filter((l) => l.trim()).length).toBeLessThan(4500);
    expect(fit.replace(CUT_LINE, '').trimEnd()).toMatch(/paragraph$|## Section \d+$/);
    expect(fitMarkdown('short')).toBe('short');
  });

  it('reads the id forms and refuses another host', () => {
    const hex = '0123456789abcdef0123456789abcdef';
    const dashed = '01234567-89ab-cdef-0123-456789abcdef';
    for (const form of [hex, dashed, hex.toUpperCase(), `https://www.notion.so/Title-${hex}`, `https://www.notion.so/ws/Title-${hex}?v=1#x`, `https://acme.notion.site/Page-${hex}`, `https://www.notion.so/Title-${hex}/`, `https://notion.com/${dashed}`]) expect(notionId(form)).toBe(dashed);
    expect(notionId(`https://evil.example/${hex}`)).toBeUndefined();
    expect(notionId('nope')).toBeUndefined();
    expect(notionId(undefined)).toBeUndefined();
  });

  it('writes one id-only line per write and the key appears nowhere', async () => {
    const file = join(dataDir, 'writes.jsonl');
    process.env.LANDFLOW_NOTION_WRITE_LOG = file;
    try {
      const { client } = make();
      const id = root();
      const page = await client.createPage({ parent: { page_id: id }, markdown: '# secret body text' });
      await client.updatePage(page.id, { in_trash: true });
      await client.me().catch(() => undefined);
      fake.failNext({ status: 401 });
      const err = await client.me().catch((e) => e);
      const lines = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      expect(lines).toHaveLength(2);
      expect(lines[0]).toMatchObject({ method: 'POST', pathTemplate: '/v1/pages', parentId: id });
      expect(lines[1]).toMatchObject({ method: 'PATCH', pathTemplate: '/v1/pages/:id', targetId: page.id });
      const everything = `${readFileSync(file, 'utf8')}${err.message}${output.join('\n')}`;
      expect(everything).not.toContain(FAKE_NOTION_TOKEN);
      expect(everything).not.toContain('secret body text');
    } finally {
      delete process.env.LANDFLOW_NOTION_WRITE_LOG;
    }
  });
});

// NB04: carryover from nb1's reviews (writes that may have landed, 529, a credential the vault refuses).
describe('NB04: writes that may have landed', () => {
  it('a network error on a write may have landed; on a read it did not', async () => {
    const down = notionClient({ credentialId: cred, fetchImpl: (async () => { throw new Error('socket hang up'); }) as unknown as typeof fetch, now: () => 1, sleep: async () => undefined });
    const write = await down.createPage({ parent: { page_id: root() }, markdown: 'x' }).catch((e) => e);
    expect(write).toMatchObject({ kind: 'network', mayHaveLanded: true });
    const read = await down.me().catch((e) => e);
    expect(read.kind).toBe('network');
    expect(read.mayHaveLanded).toBeUndefined();
  });

  it('any 5xx on a write throws at once with mayHaveLanded and is never retried; a read still backs off', async () => {
    const { client } = make();
    const id = root();
    for (const status of [500, 502, 503, 504]) {
      const before = fake.state.requests.length;
      fake.failNext({ status, match: (method, template) => method === 'POST' && template === '/v1/pages' });
      const lost = await client.createPage({ parent: { page_id: id }, markdown: '# T' }).catch((e) => e);
      expect(lost).toMatchObject({ kind: 'unavailable', mayHaveLanded: true });
      expect(fake.state.requests.length - before).toBe(1);
    }
    const page = await client.createPage({ parent: { page_id: id }, markdown: 'a' });
    fake.failNext({ status: 500 });
    expect(await client.updateMarkdown(page.id, { type: 'replace_content', replace_content: { new_str: 'b' } }).catch((e) => e)).toMatchObject({ mayHaveLanded: true });
    const reads = fake.state.requests.length;
    fake.failNext({ status: 500 });
    await client.me();
    expect(fake.state.requests.length - reads).toBe(2);
  });

  it('a createDatabase whose follow-up read keeps failing retries it 3 times, then throws mayHaveLanded naming the database', async () => {
    const { client } = make();
    const parent = root();
    const before = fake.state.requests.length;
    fake.failNext({ status: 404, match: (method, template) => method === 'GET' && template === '/v1/data_sources/:id' }, 3);
    const lost = await client.createDatabase({ parent: { page_id: parent }, title: 'Lost', properties: { Name: { title: {} } } }).catch((e) => e);
    expect(lost).toMatchObject({ mayHaveLanded: true });
    const created = fake.state.requests.slice(before);
    expect(created.filter((r) => r.template === '/v1/data_sources/:id')).toHaveLength(3);
    const database = [...fake.state.databases.values()].find((d) => d.title === 'Lost')!;
    expect(lost.message).toContain(database.id);
    // One failed read is retried and the create succeeds.
    fake.failNext({ status: 404, match: (method, template) => method === 'GET' && template === '/v1/data_sources/:id' });
    const ok = await client.createDatabase({ parent: { page_id: parent }, title: 'Fine', properties: { Name: { title: {} } } });
    expect(Object.keys(ok.propertyIds)).toEqual(['Name']);
  });

  it('a 529 counts toward the 429 streak that halves the rate', async () => {
    const { client, c } = make();
    fake.failNext({ status: 529, retryAfter: 1 }, 3);
    fake.failNext({ status: 429, retryAfter: 1 }, 2);
    await client.me();
    expect(currentRate(cred, c.now())).toBe(1);
  });

  it('a credential the vault refuses to open is `unauthorized` with status 0', async () => {
    const { client } = make();
    const spy = vi.spyOn(credentials, 'dataWithSecrets').mockRejectedValueOnce(new CredentialError('Credential "Notion" was deleted'));
    const err = await client.me().catch((e) => e);
    spy.mockRestore();
    expect(err).toMatchObject({ kind: 'unauthorized', status: 0 });
    expect(await client.me()).toMatchObject({ type: 'bot' });
  });
});

describe('the contracts', () => {
  const dir = process.env.LANDFLOW_BACKBONE_CONTRACTS;
  it.skipIf(!dir)('are byte-identical to the contract copies', () => {
    for (const [mine, theirs] of [['../src/lib/server/notion/port.ts', 'notion-port.ts'], ['./fake-notion.ts', 'fake-notion.ts']] as const) {
      const path = join(dir!, 'nb', theirs);
      expect(existsSync(path)).toBe(true);
      expect(readFileSync(join(__dirname, mine), 'utf8')).toBe(readFileSync(path, 'utf8'));
    }
  });
});
