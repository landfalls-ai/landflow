/** The site fake: pages with ETags, 304 for a conditional request, robots.txt, a redirect, pages changed through its own API, and a log of who asked for what. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fakeSite, removePage, setPage, setRobots } from '../src/site';

const site = fakeSite({ offHost: 'http://127.0.0.1:9/elsewhere' });
beforeAll(() => site.start());
afterAll(() => site.stop());
beforeEach(() => site.reset());

describe('pages', () => {
  it('serves HTML with an ETag, and 304 for the same ETag', async () => {
    const first = await fetch(`${site.url}/docs/a`);
    const etag = first.headers.get('etag')!;
    expect(await first.text()).toContain('<h1>Guide A</h1>');
    expect((await fetch(`${site.url}/docs/a`, { headers: { 'if-none-match': etag } })).status).toBe(304);
    await setPage(site, '/docs/a', { title: 'Guide A', body: 'Changed text.' });
    const changed = await fetch(`${site.url}/docs/a`, { headers: { 'if-none-match': etag } });
    expect(changed.status).toBe(200);
    expect(changed.headers.get('etag')).not.toBe(etag);
  });

  it('answers 304 to If-Modified-Since for a page with a Last-Modified and no ETag', async () => {
    await setPage(site, '/dated', { title: 'Dated', body: 'x', etag: null, lastModified: 'Wed, 01 Jan 2026 00:00:00 GMT' });
    expect((await fetch(`${site.url}/dated`, { headers: { 'if-modified-since': 'Thu, 02 Jan 2026 00:00:00 GMT' } })).status).toBe(304);
    expect((await fetch(`${site.url}/dated`, { headers: { 'if-modified-since': 'Tue, 31 Dec 2025 00:00:00 GMT' } })).status).toBe(200);
  });

  it('has ten pages that are not behind robots.txt plus one that is, an off-host link and a redirect', async () => {
    const pages = Object.keys(site.state().pages);
    expect(pages.filter((p) => !p.startsWith('/private'))).toHaveLength(10);
    expect(await (await fetch(`${site.url}/`)).text()).toContain('http://127.0.0.1:9/elsewhere');
    const old = await fetch(`${site.url}/old`, { redirect: 'manual' });
    expect([old.status, old.headers.get('location')]).toEqual([301, '/about']);
    await removePage(site, '/about');
    expect((await fetch(`${site.url}/about`)).status).toBe(404);
  });
});

describe('robots.txt', () => {
  it('forbids /private/ by default, can be replaced, a 404 and a 500', async () => {
    expect(await (await fetch(`${site.url}/robots.txt`)).text()).toContain('Disallow: /private/');
    await setRobots(site, null);
    expect((await fetch(`${site.url}/robots.txt`)).status).toBe(404);
    site.script({ status: 500, times: 1, match: (r) => r.path === '/robots.txt' });
    expect((await fetch(`${site.url}/robots.txt`)).status).toBe(500);
  });
  it('logs every request', async () => {
    await fetch(`${site.url}/about`);
    expect(site.requests().map((r) => r.path)).toEqual(['/about']);
  });
});
