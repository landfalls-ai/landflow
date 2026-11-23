/**
 * C22 (W4b P21): the connectors against the stateful fakes of @landflow/test-fakes (S3, a small website, Google Drive): what each
 * lists, the version marker it gives, what it never touches (keys outside the prefix, another host, a page robots.txt forbids),
 * and the limits. Nothing leaves this machine.
 */
import http from 'node:http';
import zlib from 'node:zlib';
import { ListObjectsV2Command } from '@aws-sdk/client-s3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fakeS3, putObject, deleteObject, S3_SECRET_KEY } from '@landflow/test-fakes/s3';
import { fakeSite, removePage, setPage, setRobots } from '@landflow/test-fakes/site';
import { acceptOnly, DOC, fakeDrive, putFile, removeFile } from '@landflow/test-fakes/drive';
import { defineCredentialType, definePlugin } from '@landflow/sdk';
import { startFakeOAuth2 } from './fake-oauth2';
import type { ItemRow } from '@/lib/server/knowledge-sources/store';

Object.assign(process.env, { LANDFLOW_PUBLIC_URL: 'http://landflow.test', LANDFLOW_DATA_DIR: mkdtempSync(join(tmpdir(), 'landflow-ks-conn-')), LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' });

const { s3Connector } = await import('@/lib/server/knowledge-sources/connectors/s3');
const { SourceError } = await import('@/lib/server/knowledge-sources/connectors/types');
const { crawlConnector, CRAWL_SPACING_MS } = await import('@/lib/server/knowledge-sources/connectors/crawl');
const { parseRobots, robotsAllow, patternMatches } = await import('@/lib/server/knowledge-sources/connectors/robots');
const bounded = await import('@/lib/server/knowledge-sources/connectors/bounded');
const { assertOutboundTarget, s3ClientOf } = await import('@/lib/server/nodes/credentials');
const { driveConnector, driveBase, vaultTokens } = await import('@/lib/server/knowledge-sources/connectors/drive');
const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { credentials } = await import('@/lib/server/credentials/vault');
const authorizeRoute = await import('@/app/api/credentials/[id]/oauth2/authorize/route');
const callbackRoute = await import('@/app/api/oauth2/callback/route');
const signal = new AbortController().signal;
const asPrevious = (items: Array<{ key: string; version: string; name: string; extra?: string }>): Map<string, ItemRow> => new Map(items.map((i) => [i.key, { source_id: 's', item_key: i.key, version: i.version, name: i.name, size: null, extra: i.extra ?? null, synced_at: '' }]));

describe('S3', () => {
  const s3 = fakeS3();
  const data = () => ({ endpoint: s3.url, region: 'us-east-1', accessKeyId: s3.token, secretAccessKey: S3_SECRET_KEY, forcePathStyle: true });
  beforeAll(() => s3.start());
  afterAll(() => s3.stop());
  beforeEach(() => s3.reset());

  it('lists only the objects under the prefix, with the ETag as the version (AS-3)', async () => {
    const listing = await s3Connector({ bucket: 'docs', prefix: 'guides/' }, data()).list(signal, new Map());
    expect(listing.complete).toBe(true);
    expect(listing.items.map((i) => i.key)).toEqual(['guides/faq.md', 'guides/install.md', 'guides/upgrade.md']);
    expect(listing.items[0].name).toBe('faq.md');
    expect(listing.items[0].version).toMatch(/^[0-9a-f]{32}$/);
    // the fake saw only the prefix: nothing under other/ was read
    expect(s3.requests().every((r) => !r.path.includes('other/'))).toBe(true);
  });

  it('the version moves when the object does, and the bytes are the object’s', async () => {
    const connector = s3Connector({ bucket: 'docs', prefix: 'guides/' }, data());
    const before = (await connector.list(signal, new Map())).items.find((i) => i.key === 'guides/faq.md')!;
    await putObject(s3, 'docs', 'guides/faq.md', '# FAQ\n\nChanged.');
    const after = (await connector.list(signal, new Map())).items.find((i) => i.key === 'guides/faq.md')!;
    expect(after.version).not.toBe(before.version);
    expect(new TextDecoder().decode((await connector.fetch(after, signal)).bytes)).toContain('Changed.');
    await deleteObject(s3, 'docs', 'guides/faq.md');
    expect((await connector.list(signal, new Map())).items.map((i) => i.key)).not.toContain('guides/faq.md');
  });

  it('follows continuation pages, skips folder keys and files no loader reads', async () => {
    const files = Object.fromEntries(Array.from({ length: 1200 }, (_, i) => [`bulk/f${String(i).padStart(4, '0')}.md`, `# ${i}`]));
    for (const [key, body] of Object.entries({ ...files, 'bulk/image.png': 'png', 'bulk/dir/': '' })) await putObject(s3, 'docs', key, body);
    const listing = await s3Connector({ bucket: 'docs', prefix: 'bulk/' }, data()).list(signal, new Map());
    expect(listing.items).toHaveLength(1200);
    expect(s3.requests().filter((r) => r.query.get('list-type') === '2')).toHaveLength(2);
  });

  it('an object over 25 MB is an item error when it is read, not a failure of the listing', async () => {
    await putObject(s3, 'docs', 'big/huge.txt', 'x'.repeat(26 * 1024 * 1024));
    const connector = s3Connector({ bucket: 'docs', prefix: 'big/' }, data());
    const listing = await connector.list(signal, new Map());
    expect(listing.items[0].size).toBeGreaterThan(25 * 1024 * 1024);
    await expect(connector.fetch(listing.items[0], signal)).rejects.toThrow(SourceError);
    await expect(connector.fetch(listing.items[0], signal)).rejects.toThrow(/Too large/);
  });

  it('uses the credential’s keys and never the default chain', async () => {
    const before = { id: process.env.AWS_ACCESS_KEY_ID, secret: process.env.AWS_SECRET_ACCESS_KEY };
    process.env.AWS_ACCESS_KEY_ID = 'AKIAFROMENVIRONMENT0';
    process.env.AWS_SECRET_ACCESS_KEY = 'from-the-environment';
    try {
      await s3Connector({ bucket: 'docs', prefix: 'guides/' }, data()).list(signal, new Map());
      expect(s3.requests().every((r) => !r.refused)).toBe(true);
      expect(s3.requests().every((r) => String(r.headers.authorization).includes(`Credential=${s3.token}/`))).toBe(true);
      // no keys in the credential: refused before any request, never a fallback to the environment
      const requests = s3.requests().length;
      await expect(s3Connector({ bucket: 'docs', prefix: '' }, { ...data(), accessKeyId: '' }).list(signal, new Map())).rejects.toThrow(/access key id/);
      expect(s3.requests()).toHaveLength(requests);
    } finally {
      if (before.id === undefined) delete process.env.AWS_ACCESS_KEY_ID;
      else process.env.AWS_ACCESS_KEY_ID = before.id;
      if (before.secret === undefined) delete process.env.AWS_SECRET_ACCESS_KEY;
      else process.env.AWS_SECRET_ACCESS_KEY = before.secret;
    }
  });

  it('a bad key or a missing bucket is a failure with S3’s own name, and no key in it', async () => {
    await expect(s3Connector({ bucket: 'docs', prefix: '' }, { ...data(), accessKeyId: 'AKIAWRONGKEY00000000' }).list(signal, new Map())).rejects.toThrow(/InvalidAccessKeyId/);
    await expect(s3Connector({ bucket: 'nothere', prefix: '' }, data()).list(signal, new Map())).rejects.toThrow(/NoSuchBucket/);
    const message = await s3Connector({ bucket: 'docs', prefix: '' }, { ...data(), accessKeyId: 'AKIAWRONGKEY00000000' }).list(signal, new Map()).catch((e: Error) => e.message);
    expect(message).not.toContain(S3_SECRET_KEY);
  });
});

describe('robots.txt rules', () => {
  const rules = (text: string) => parseRobots(text);
  it('Disallow blocks by prefix; an empty Disallow and no file allow everything', () => {
    expect(robotsAllow(rules('User-agent: *\nDisallow: /private/'), '/private/notes')).toBe(false);
    expect(robotsAllow(rules('User-agent: *\nDisallow: /private/'), '/docs/a')).toBe(true);
    expect(robotsAllow(rules('User-agent: *\nDisallow:'), '/anything')).toBe(true);
    expect(robotsAllow(parseRobots(''), '/anything')).toBe(true);
  });
  it('the longest matching rule wins, and Allow beats Disallow at equal length', () => {
    const text = 'User-agent: *\nDisallow: /docs/\nAllow: /docs/public/\nDisallow: /same\nAllow: /same';
    expect(robotsAllow(rules(text), '/docs/secret')).toBe(false);
    expect(robotsAllow(rules(text), '/docs/public/page')).toBe(true);
    expect(robotsAllow(rules(text), '/same')).toBe(true);
  });
  it('* matches any run of characters and $ anchors the end', () => {
    const text = 'User-agent: *\nDisallow: /*.pdf$\nDisallow: /tmp*/draft';
    expect(robotsAllow(rules(text), '/a/b.pdf')).toBe(false);
    expect(robotsAllow(rules(text), '/a/b.pdf?x=1')).toBe(true);
    expect(robotsAllow(rules(text), '/tmp42/draft')).toBe(false);
  });
  it('our own group beats *, groups of several agents share rules, comments and case are ignored', () => {
    const text = '# comment\nUser-agent: Googlebot\nUser-agent: landflow-knowledgesync\nDisallow: /ours # trailing\n\nUser-agent: *\nDisallow: /all';
    expect(robotsAllow(rules(text), '/ours/x')).toBe(false);
    expect(robotsAllow(rules(text), '/all/x')).toBe(true); // the * group does not apply once ours matched
  });
});

describe('crawl', () => {
  const other = fakeSite();
  const site = fakeSite();
  const start = () => `${site.url}/`;
  const crawl = (over: Record<string, unknown> = {}, spacingMs = 0) => crawlConnector({ startUrl: start(), maxDepth: 3, maxPages: 500, ...over } as never, { spacingMs });
  beforeAll(async () => {
    await other.start();
    await site.start();
  });
  afterAll(async () => {
    await site.stop();
    await other.stop();
  });
  beforeEach(async () => {
    site.reset();
    other.reset();
    await setPage(site, '/', { ...site.state().pages['/'], links: [...site.state().pages['/'].links!.filter((l) => !l.startsWith('http://127')), other.url + '/elsewhere', `http://localhost:${new URL(site.url).port}/docs/a`] });
  });

  it('indexes the ten pages of the site, never fetches the off-host link or the page robots.txt forbids, and counts the skipped one (AS-4)', async () => {
    const listing = await crawl().list(signal, new Map());
    expect(listing.items.map((i) => new URL(i.key).pathname).sort()).toEqual(['/', '/about', ...'abcdefgh'.split('').map((d) => `/docs/${d}`)].sort());
    expect(listing.items).toHaveLength(10);
    expect(listing.complete).toBe(true);
    expect(listing.skipped).toBe(1);
    expect(other.requests()).toEqual([]);
    expect(site.requests().map((r) => r.path)).not.toContain('/private/notes');
    expect(site.requests().filter((r) => r.path === '/robots.txt')).toHaveLength(1);
    // the redirect /old → /about is followed (once, same origin) and the page is not listed twice
    expect(site.requests().filter((r) => r.path === '/about')).toHaveLength(1);
    expect(listing.items.find((i) => i.name === 'Acme docs')).toBeTruthy();
    expect(listing.items.every((i) => /^etag:/.test(i.version))).toBe(true);
  });

  it('reads a page as HTML bytes with its title as the name', async () => {
    const connector = crawl();
    const item = (await connector.list(signal, new Map())).items.find((i) => i.name === 'Guide A')!;
    const file = await connector.fetch(item, signal);
    expect(file.mimeType).toBe('text/html');
    expect(new TextDecoder().decode(file.bytes)).toContain('Guide A explains');
  });

  it('honours the depth and the page limits; a cut crawl is not a complete listing', async () => {
    expect((await crawl({ maxDepth: 0 }).list(signal, new Map())).items).toHaveLength(1);
    expect((await crawl({ maxDepth: 1 }).list(signal, new Map())).items).toHaveLength(10);
    const capped = await crawl({ maxPages: 3 }).list(signal, new Map());
    expect(capped.items).toHaveLength(3);
    expect(capped.complete).toBe(false);
    expect(capped.note).toMatch(/3 pages/);
  });

  it('a second crawl sends If-None-Match, takes each 304 as unchanged and still follows the page’s links', async () => {
    const first = await crawl().list(signal, new Map());
    const home = site.state().pages['/'];
    site.reset(); // an empty log, the same pages
    await setPage(site, '/', home); // the home page as the first crawl saw it: the same ETag
    const second = await crawl().list(signal, asPrevious(first.items));
    expect(second.items).toHaveLength(10);
    expect(second.items.map((i) => i.version).sort()).toEqual(first.items.map((i) => i.version).sort());
    const pageRequests = site.requests().filter((r) => !['/robots.txt', '/old', '/__fake/page'].includes(r.path)); // /old is a redirect: it holds no version of its own
    expect(pageRequests.filter((r) => r.status === 304).length).toBeGreaterThanOrEqual(9);
    expect(pageRequests.every((r) => r.headers['if-none-match'])).toBe(true);
  });

  it('a changed page has a new version; a page with no validators is versioned by a hash of its content', async () => {
    await setPage(site, '/docs/a', { title: 'Guide A', body: 'Plain.', links: ['/'], etag: null });
    const first = await crawl().list(signal, new Map());
    const a1 = first.items.find((i) => i.name === 'Guide A')!;
    expect(a1.version).toMatch(/^sha:[0-9a-f]{64}$/);
    expect((await crawl().list(signal, asPrevious(first.items))).items.find((i) => i.name === 'Guide A')!.version).toBe(a1.version);
    await setPage(site, '/docs/a', { title: 'Guide A', body: 'Changed.', links: ['/'], etag: null });
    expect((await crawl().list(signal, asPrevious(first.items))).items.find((i) => i.name === 'Guide A')!.version).not.toBe(a1.version);
    await setPage(site, '/docs/b', { title: 'Guide B', body: 'Dated.', links: ['/'], etag: null, lastModified: 'Wed, 01 Jan 2026 00:00:00 GMT' });
    expect((await crawl().list(signal, new Map())).items.find((i) => i.name === 'Guide B')!.version).toBe('lm:Wed, 01 Jan 2026 00:00:00 GMT');
  });

  it('a page that disappeared is not listed (so the sync can take it for gone), and the listing stays complete', async () => {
    await removePage(site, '/docs/h');
    const listing = await crawl().list(signal, new Map());
    expect(listing.items).toHaveLength(9);
    expect(listing.complete).toBe(true);
  });

  it('a page that errors is a problem of the listing, which is then not complete', async () => {
    await setPage(site, '/docs/c', { title: 'Guide C', body: 'x', status: 500 });
    const listing = await crawl().list(signal, new Map());
    expect(listing.problems).toEqual([{ item: `${site.url}/docs/c`, reason: expect.stringContaining('500') }]);
    expect(listing.complete).toBe(false);
  });

  it('robots.txt: a 404 allows everything, a 500 stops the crawl', async () => {
    await setRobots(site, null);
    expect((await crawl().list(signal, new Map())).items).toHaveLength(11);
    site.reset();
    site.script({ status: 500, times: 1, match: (r) => r.path === '/robots.txt' });
    await expect(crawl().list(signal, new Map())).rejects.toThrow(/robots\.txt/);
  });

  it('waits between requests', async () => {
    expect(CRAWL_SPACING_MS).toBe(500);
    const started = Date.now();
    await crawl({ maxPages: 5 }, 60).list(signal, new Map());
    expect(Date.now() - started).toBeGreaterThanOrEqual(4 * 60 - 20);
  });

  it('a redirect to another host is not followed', async () => {
    await setPage(site, '/docs/d', { title: 'Guide D', body: 'x', redirect: `${other.url}/stolen` });
    const listing = await crawl().list(signal, new Map());
    expect(other.requests()).toEqual([]);
    expect(listing.items.map((i) => i.name)).not.toContain('Guide D');
    expect(listing.problems?.[0]?.reason).toMatch(/another site/);
  });

  it('skips what is not a page (images, scripts)', async () => {
    await setPage(site, '/docs/e', { title: 'Image', body: 'x', contentType: 'image/png' });
    expect((await crawl().list(signal, new Map())).items.map((i) => i.name)).not.toContain('Image');
  });

  it('goes through the outbound policy: with private addresses blocked the site is refused', async () => {
    process.env.LANDFLOW_OUTBOUND_BLOCK_PRIVATE = 'true';
    try {
      await expect(crawl().list(signal, new Map())).rejects.toThrow(/Blocked|private/i);
    } finally {
      delete process.env.LANDFLOW_OUTBOUND_BLOCK_PRIVATE;
    }
  });
});

describe('Google Drive', () => {
  const drive = fakeDrive();
  const folder = (includeSubfolders = false, folderId = 'folder-top') => ({ folderId, includeSubfolders });
  const tokens = (initial: string, renewed = initial) => {
    const calls = { token: 0, renew: 0 };
    return { calls, source: { token: async () => (calls.token++, initial), renew: async () => (calls.renew++, renewed) } };
  };
  beforeAll(async () => {
    await drive.start();
    process.env.LANDFLOW_KNOWLEDGE_DRIVE_URL = drive.url;
  });
  afterAll(async () => {
    delete process.env.LANDFLOW_KNOWLEDGE_DRIVE_URL;
    await drive.stop();
  });
  beforeEach(() => drive.reset());

  it('lists the three files of the folder, leaving the shortcut and the subfolder (AS-1)', async () => {
    const connector = driveConnector(folder(), tokens(drive.token).source);
    const listing = await connector.list(signal, new Map());
    expect(listing.complete).toBe(true);
    expect(listing.items.map((i) => i.name).sort()).toEqual(['Expenses.md', 'Onboarding.md', 'holidays.txt']);
    expect(listing.skipped).toBe(1); // the shortcut
    expect(listing.items.find((i) => i.key === 'doc-expenses')!.url).toMatch(/\/doc-expenses\/view$/);
  });

  it('walks subfolders only when asked; a Sheet is a CSV item', async () => {
    const listing = await driveConnector(folder(true), tokens(drive.token).source).list(signal, new Map());
    expect(listing.items.map((i) => i.name).sort()).toEqual(['Expenses.md', 'On call.md', 'Onboarding.md', 'Rota.csv', 'holidays.txt']);
    const query = (r: { query: URLSearchParams }) => r.query.get('q');
    expect(drive.requests().map(query).filter(Boolean)).toEqual(["'folder-top' in parents and trashed = false", "'folder-sub' in parents and trashed = false"]);
  });

  it('versions: modifiedTime for a Doc, md5 for a file; an edit moves only its own version (AS-1)', async () => {
    const connector = driveConnector(folder(), tokens(drive.token).source);
    const first = await connector.list(signal, new Map());
    expect(first.items.find((i) => i.key === 'txt-holidays')!.version).toMatch(/^[0-9a-f]{32}$/);
    expect(first.items.find((i) => i.key === 'doc-expenses')!.version).toMatch(/^2026-01-01T/);
    await putFile(drive, { id: 'doc-expenses', name: 'Expenses', mimeType: DOC, parents: ['folder-top'], content: '# Expenses\n\nNew rules.\n' });
    const second = await connector.list(signal, new Map());
    const moved = second.items.filter((i) => i.version !== first.items.find((j) => j.key === i.key)!.version).map((i) => i.key);
    expect(moved).toEqual(['doc-expenses']);
    expect(new TextDecoder().decode((await connector.fetch(second.items.find((i) => i.key === 'doc-expenses')!, signal)).bytes)).toContain('New rules.');
  });

  it('exports Docs as Markdown, Sheets as CSV, and downloads other files as they are', async () => {
    const connector = driveConnector(folder(true), tokens(drive.token).source);
    const items = (await connector.list(signal, new Map())).items;
    const text = async (key: string) => new TextDecoder().decode((await connector.fetch(items.find((i) => i.key === key)!, signal)).bytes);
    expect(await text('doc-onboarding')).toContain('# Onboarding');
    expect(await text('sheet-rota')).toContain('1,Ana');
    expect(await text('txt-holidays')).toContain('first Monday');
    const exports = drive.requests().filter((r) => r.path.endsWith('/export')).map((r) => r.query.get('mimeType'));
    expect(exports).toEqual(['text/markdown', 'text/csv']);
    expect(drive.requests().some((r) => r.query.get('alt') === 'media')).toBe(true);
  });

  it('falls back to a text export when Google will not give Markdown', async () => {
    const strict = fakeDrive({ markdownExport: false });
    await strict.start();
    process.env.LANDFLOW_KNOWLEDGE_DRIVE_URL = strict.url;
    try {
      const connector = driveConnector(folder(), tokens(strict.token).source);
      const item = (await connector.list(signal, new Map())).items.find((i) => i.key === 'doc-expenses')!;
      expect(new TextDecoder().decode((await connector.fetch(item, signal)).bytes)).toContain('# Expenses');
      expect(strict.requests().filter((r) => r.path.endsWith('/export')).map((r) => r.query.get('mimeType'))).toEqual(['text/markdown', 'text/plain']);
    } finally {
      process.env.LANDFLOW_KNOWLEDGE_DRIVE_URL = drive.url;
      await strict.stop();
    }
  });

  it('a file removed from Drive is no longer listed', async () => {
    await removeFile(drive, 'doc-onboarding');
    expect((await driveConnector(folder(), tokens(drive.token).source).list(signal, new Map())).items.map((i) => i.key)).not.toContain('doc-onboarding');
  });

  it('a 401 renews the token once and asks again; the error of a refused folder keeps Google’s words and no token', async () => {
    await acceptOnly(drive, 'ya29.renewed');
    const t = tokens('ya29.stale', 'ya29.renewed');
    const listing = await driveConnector(folder(), t.source).list(signal, new Map());
    expect(listing.items).toHaveLength(3);
    expect(t.calls).toEqual({ token: 1, renew: 1 });
    expect(drive.requests().filter((r) => r.status === 401)).toHaveLength(1);
    const refused = tokens('ya29.stale', 'ya29.still-wrong');
    const message = await driveConnector(folder(), refused.source).list(signal, new Map()).catch((e: Error) => e.message);
    expect(message).toBe('Google Drive answered 401: Invalid Credentials');
    expect(refused.calls.renew).toBe(1); // not in a loop
  });

  it('a folder Google does not know is a failure of the listing', async () => {
    await expect(driveConnector(folder(false, 'nope-nope'), tokens(drive.token).source).list(signal, new Map())).resolves.toMatchObject({ items: [] }); // an empty folder lists empty, like Google
    drive.script({ status: 404, times: 1 });
    await expect(driveConnector(folder(), tokens(drive.token).source).list(signal, new Map())).rejects.toThrow(/Google Drive answered 404/);
  });

  it('LANDFLOW_KNOWLEDGE_DRIVE_URL points the API at the fake; the production profile ignores it', () => {
    expect(driveBase()).toBe(drive.url);
    process.env.LANDFLOW_PROFILE = 'production';
    try {
      expect(driveBase()).toBe('https://www.googleapis.com');
    } finally {
      delete process.env.LANDFLOW_PROFILE;
    }
  });

  describe('with the vault’s OAuth2 credential', () => {
    let oauth: Awaited<ReturnType<typeof startFakeOAuth2>>;
    beforeAll(async () => {
      oauth = await startFakeOAuth2({ expiresIn: 3600 });
      const google = definePlugin({
        info: { id: 'google', name: 'Google', version: '1.0.0', language: 'typescript' },
        credentialTypes: [
          defineCredentialType({
            name: 'googleOAuth2Api',
            displayName: 'Google OAuth2',
            extends: ['oAuth2Api'],
            properties: [
              { name: 'authUrl', displayName: 'Authorization URL', type: 'hidden', default: `${oauth.url}/authorize` },
              { name: 'accessTokenUrl', displayName: 'Access Token URL', type: 'hidden', default: `${oauth.url}/token` },
              { name: 'scope', displayName: 'Scope', type: 'hidden', default: 'drive.readonly' },
            ],
          }),
        ],
        nodes: [],
      });
      registry.registerBuiltin(corePlugin);
      registry.registerBuiltin(google);
    });
    afterAll(() => oauth.close());

    /** Connect through the routes the way a browser would. */
    async function connected(): Promise<string> {
      const created = credentials.create({ name: 'Drive', type: 'google.googleOAuth2Api', data: { clientId: 'client-1', clientSecret: 'secret-1' } as never });
      const params = { params: Promise.resolve({ id: created.id }) };
      const start = await authorizeRoute.GET(new Request(`http://landflow.test/api/credentials/${created.id}/oauth2/authorize`), params);
      const consent = await fetch(new URL(start.headers.get('location')!), { redirect: 'manual' });
      const page = await callbackRoute.GET(new Request(new URL(consent.headers.get('location')!), { headers: { cookie: start.headers.get('set-cookie')!.split(';')[0] } }));
      expect(page.status).toBe(200);
      return created.id;
    }

    it('renews a token that is about to expire once, before the first request, and sends the new one', async () => {
      const id = await connected();
      const old = credentials.dataFor({ id, name: 'Drive' }, 'google.googleOAuth2Api').accessToken;
      const stored = credentials.oauth2(id).token!;
      credentials.saveOAuth2Token(id, { ...stored, expires_at: new Date(Date.now() - 5_000).toISOString() });
      await acceptOnly(drive, '*');
      const refreshes = () => oauth.tokenRequests.filter((r) => r.params.grant_type === 'refresh_token').length;
      const before = refreshes();
      const listing = await driveConnector(folder(), vaultTokens(id)).list(signal, new Map());
      expect(listing.items).toHaveLength(3);
      expect(refreshes()).toBe(before + 1);
      const sent = drive.requests().at(-1)!.headers.authorization;
      expect(sent).toBe(`Bearer ${credentials.dataFor({ id, name: 'Drive' }, 'google.googleOAuth2Api').accessToken}`);
      expect(sent).not.toBe(`Bearer ${old}`);
    });

    it('a credential that was never connected says so in words', async () => {
      const created = credentials.create({ name: 'Unconnected', type: 'google.googleOAuth2Api', data: { clientId: 'client-1', clientSecret: 'secret-1' } as never });
      await expect(driveConnector(folder(), vaultTokens(created.id)).list(signal, new Map())).rejects.toThrow(/not connected/);
      await expect(driveConnector(folder(), vaultTokens('cred-gone')).list(signal, new Map())).rejects.toThrow(/deleted/);
    });
  });
});

describe('limits on what a source can make the host hold (review: bounded reads)', () => {
  const { readCapped, TooLargeError } = bounded;
  const { gzipSync } = zlib;

  it('readCapped counts what arrives, stops past the cap and can truncate', async () => {
    const chunks = async function* () {
      for (let i = 0; i < 10; i++) yield new Uint8Array(100);
    };
    await expect(readCapped(chunks(), 500)).rejects.toBeInstanceOf(TooLargeError);
    expect((await readCapped(chunks(), 500, { truncate: true })).length).toBe(500);
    expect((await readCapped(chunks(), 5000)).length).toBe(1000);
    expect((await readCapped(new Response('hello').body, 100)).length).toBe(5);
    expect((await readCapped(null, 10)).length).toBe(0);
  });

  /** A site whose home page is 60 MB of zeros after gzip (a few dozen KB on the wire), and whose robots.txt is as big. */
  function bombSite() {
    const bomb = gzipSync(Buffer.alloc(60 * 1024 * 1024));
    const server = http.createServer((request, response) => {
      response.writeHead(200, { 'content-type': request.url === '/robots.txt' ? 'text/plain' : 'text/html', 'content-encoding': 'gzip' });
      response.end(bomb);
    });
    return new Promise<{ url: string; close: () => Promise<void> }>((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, close: () => new Promise((done) => server.close(() => done())) })));
  }

  it('a gzip bomb as a page is cut at 2 MB after decompression and left out; as robots.txt it is read to 512 KB only', async () => {
    const site = await bombSite();
    try {
      const started = Date.now();
      const listing = await crawlConnector({ startUrl: `${site.url}/`, maxDepth: 1, maxPages: 5 }, { spacingMs: 0 }).list(signal, new Map());
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(listing.items).toEqual([]);
      expect(listing.complete).toBe(false);
      expect(listing.problems?.[0].reason).toMatch(/Too large \(the limit for a page is 2 MB\)/);
    } finally {
      await site.close();
    }
  }, 30_000);

  it('the pages one crawl keeps for fetch have a budget: past it the page waits for the next sync and the listing is not whole', async () => {
    const site = fakeSite();
    await site.start();
    try {
      const listing = await crawlConnector({ startUrl: `${site.url}/`, maxDepth: 2, maxPages: 50 }, { spacingMs: 0, keptBudgetBytes: 1200 }).list(signal, new Map());
      expect(listing.complete).toBe(false);
      expect(listing.note).toMatch(/memory/);
      expect(listing.items.length).toBeGreaterThan(0);
      expect(listing.items.length).toBeLessThan(10);
      expect(listing.problems?.some((p) => /next sync/.test(p.reason))).toBe(true);
      const all = await crawlConnector({ startUrl: `${site.url}/`, maxDepth: 2, maxPages: 50 }, { spacingMs: 0 }).list(signal, new Map());
      expect(all.items.length).toBeGreaterThanOrEqual(10);
    } finally {
      await site.stop();
    }
  });

  it('an S3 object over the limit is refused by its size, before its body is read', async () => {
    const s3 = fakeS3();
    await s3.start();
    try {
      await putObject(s3, 'docs', 'guides/huge.md', 'x'.repeat(26 * 1024 * 1024));
      const connector = s3Connector({ bucket: 'docs', prefix: 'guides/huge' }, { endpoint: s3.url, region: 'us-east-1', accessKeyId: s3.token, secretAccessKey: S3_SECRET_KEY, forcePathStyle: true });
      const listing = await connector.list(signal, new Map());
      await expect(connector.fetch({ ...listing.items[0], size: 10 }, signal)).rejects.toThrow(/Too large/); // the listing's size was a lie: the object's own length is checked
    } finally {
      await s3.stop();
    }
  }, 30_000);

  it('a Drive download over the limit is cut at the limit', async () => {
    const drive = fakeDrive();
    await drive.start();
    process.env.LANDFLOW_KNOWLEDGE_DRIVE_URL = drive.url;
    try {
      await putFile(drive, { id: 'big', name: 'big.txt', mimeType: 'text/plain', parents: ['folder-top'], content: 'x'.repeat(26 * 1024 * 1024) } as never);
      const connector = driveConnector({ folderId: 'folder-top', includeSubfolders: false }, { token: async () => drive.token, renew: async () => drive.token });
      await expect(connector.fetch({ key: 'big', name: 'big.txt', version: 'v', mimeType: 'text/plain' }, signal)).rejects.toThrow(/Too large/);
    } finally {
      delete process.env.LANDFLOW_KNOWLEDGE_DRIVE_URL;
      await drive.stop();
    }
  }, 30_000);
});

describe('robots.txt matching is linear (review)', () => {
  it('a pathological pattern finishes at once and still matches as it should', () => {
    const pattern = `${'*a'.repeat(300)}*b$`;
    const path = `/${'a'.repeat(4000)}`;
    const started = Date.now();
    for (let i = 0; i < 50; i++) expect(patternMatches(pattern, path)).toBe(false);
    expect(Date.now() - started).toBeLessThan(500);
    expect(patternMatches('/a*b*c$', '/a-x-b-y-c')).toBe(true);
    expect(patternMatches('/a*b*c$', '/a-x-b-y-c-d')).toBe(false);
    expect(patternMatches('/private', '/private/notes')).toBe(true);
    expect(patternMatches('/*.pdf$', '/files/x.pdf')).toBe(true);
    expect(patternMatches('/*.pdf$', '/files/x.pdf?y=1')).toBe(false);
    expect(patternMatches('/a$', '/a')).toBe(true);
    expect(patternMatches('/a*$', '/abc')).toBe(true);
  });

  it('caps pattern and path lengths: a huge rule is ignored, a huge path is cut', () => {
    expect(patternMatches(`/${'a'.repeat(2000)}`, `/${'a'.repeat(2000)}`)).toBe(false);
    expect(robotsAllow(parseRobots(`User-agent: *\nDisallow: /${'a'.repeat(5000)}`), `/${'a'.repeat(5000)}`)).toBe(true);
    expect(patternMatches('/x', `/x${'y'.repeat(100_000)}`)).toBe(true);
  });
});

describe('S3 and the outbound policy (review)', () => {
  const policy = async (flags: Record<string, string | undefined>, work: () => Promise<void>) => {
    const before = { ...process.env };
    for (const [key, value] of Object.entries(flags)) value === undefined ? delete process.env[key] : (process.env[key] = value);
    try {
      await work();
    } finally {
      for (const key of Object.keys(flags)) before[key] === undefined ? delete process.env[key] : (process.env[key] = before[key]);
    }
  };
  const keys = { accessKeyId: 'AKIADUMMYKEYFORTESTS', secretAccessKey: 'dummy-secret-for-tests-only', region: 'us-east-1' };

  it('an endpoint that is private, or whose name resolves to a private address, is refused; a name that does not resolve is refused too', async () => {
    await policy({ LANDFLOW_OUTBOUND_BLOCK_PRIVATE: 'true' }, async () => {
      await expect(assertOutboundTarget(new URL('http://127.0.0.1:9000'))).rejects.toThrow(/Blocked/);
      await expect(assertOutboundTarget(new URL('http://localhost:9000'))).rejects.toThrow(/Blocked/);
      await expect(assertOutboundTarget(new URL('http://no-such-host.invalid'))).rejects.toThrow(/could not be resolved/);
      await expect(s3Connector({ bucket: 'docs', prefix: '' }, { ...keys, endpoint: 'http://localhost:9000' }).list(signal, new Map())).rejects.toThrow(/Blocked/);
    });
    await policy({ LANDFLOW_OUTBOUND_BLOCK_PRIVATE: 'false' }, async () => {
      await expect(assertOutboundTarget(new URL('http://no-such-host.invalid'))).resolves.toBeUndefined();
    });
  });

  it('every connection the SDK makes is checked at the socket: a bucket host the SDK derives that resolves to loopback never connects (path and virtual-hosted)', async () => {
    const s3 = fakeS3();
    await s3.start();
    try {
      const port = new URL(s3.url).port;
      await policy({ LANDFLOW_OUTBOUND_BLOCK_PRIVATE: 'true' }, async () => {
        // s3ClientOf is used directly, past the up-front check: only the socket's guarded lookup is left to refuse the name `localhost`.
        for (const forcePathStyle of [true, false]) {
          const client = await s3ClientOf({ ...keys, endpoint: `http://localhost:${port}`, forcePathStyle });
          try {
            await expect(client.send(new ListObjectsV2Command({ Bucket: 'docs' }))).rejects.toThrow();
            expect(s3.requests()).toEqual([]); // nothing reached the fake
          } finally {
            client.destroy();
          }
        }
      });
    } finally {
      await s3.stop();
    }
  });
});
