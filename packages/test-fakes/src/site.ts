/**
 * A small website as a stateful fake: pages (title, body text, links) served as HTML with an ETag and a Last-Modified, `robots.txt`,
 * conditional requests (`If-None-Match`, `If-Modified-Since` answer 304), so a test of a crawler asserts on what it asked for and
 * what it indexed. No token: a public site (the harness's request log shows who asked for what, which is how a test proves a page
 * was never fetched). Start a second instance as "another host" (a different port is a different origin).
 *
 * Default site (`pages`): ten pages (`/`, `/about`, `/docs/a` … `/docs/h`), one forbidden by robots.txt (`/private/notes`, linked from `/`) and, when
 * `offHost` is given, a link from `/` to that address. `/old` redirects to `/about`. Use `setPage` / `removePage` / `setRobots` to change it mid-test.
 */
import { createHash } from 'node:crypto';
import { defineFake, type Fake, type FakeReply, type FakeRequest } from './harness';

export interface SitePage {
  title: string;
  /** Plain text of the page. */
  body: string;
  /** Hrefs as written (relative or absolute). */
  links?: string[];
  /** The ETag to send (default: one made from the content; `null`: none). */
  etag?: string | null;
  /** `Last-Modified` as an HTTP date, when set. */
  lastModified?: string;
  /** Default `text/html; charset=utf-8`. */
  contentType?: string;
  /** A fixed answer instead of the page (404, 500…). */
  status?: number;
  /** A 302 to this address instead of the page. */
  redirect?: string;
}

export interface SiteState {
  pages: Record<string, SitePage>;
  /** The text of /robots.txt; `null`: it is a 404. */
  robots: string | null;
  /** The status /robots.txt answers when set (e.g. 500). */
  robotsStatus?: number;
}

export interface SiteSeed {
  pages: Record<string, SitePage>;
  robots: string | null;
  offHost: string;
}

const hash = (text: string) => createHash('sha1').update(text).digest('hex').slice(0, 12);

function defaultPages(offHost?: string): Record<string, SitePage> {
  const docs = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  const pages: Record<string, SitePage> = {
    '/': { title: 'Acme docs', body: 'Welcome to the Acme documentation. Start with the guides.', links: ['/about', ...docs.map((d) => `/docs/${d}`), '/private/notes', '/old', ...(offHost ? [offHost] : []), 'mailto:docs@example.test', '#top'] },
    '/about': { title: 'About Acme', body: 'Acme builds widgets for people who like widgets.', links: ['/'] },
    '/private/notes': { title: 'Private notes', body: 'Internal notes the site asks crawlers to leave alone.' },
  };
  for (const d of docs) pages[`/docs/${d}`] = { title: `Guide ${d.toUpperCase()}`, body: `Guide ${d.toUpperCase()} explains how to use the ${d} feature of the widget.`, links: ['/', `/docs/${docs[(docs.indexOf(d) + 1) % docs.length]}`] };
  return pages;
}

const html = (page: SitePage) => `<!doctype html><html><head><title>${page.title}</title></head><body><nav><a href="/">Home</a></nav><main><h1>${page.title}</h1><p>${page.body}</p>${(page.links ?? []).map((href) => `<a href="${href}">${href}</a>`).join('')}</main><footer>Footer text on every page</footer></body></html>`;
const etagOf = (page: SitePage) => (page.etag === null ? undefined : (page.etag ?? `"${hash(JSON.stringify([page.title, page.body, page.links]))}"`));

function route(state: SiteState, request: FakeRequest): FakeReply {
  if (request.method === 'PUT' && request.path === '/__fake/page') {
    const { path, page } = request.body as { path: string; page: SitePage };
    state.pages[path] = page;
    return { status: 204, body: '' };
  }
  if (request.method === 'DELETE' && request.path === '/__fake/page') {
    delete state.pages[request.query.get('path') ?? ''];
    return { status: 204, body: '' };
  }
  if (request.method === 'PUT' && request.path === '/__fake/robots') {
    state.robots = (request.body as { robots: string | null }).robots;
    return { status: 204, body: '' };
  }
  if (request.path === '/robots.txt') {
    if (state.robotsStatus) return { status: state.robotsStatus, body: 'robots unavailable' };
    return state.robots === null ? { status: 404, body: 'not found' } : { headers: { 'content-type': 'text/plain' }, body: state.robots };
  }
  if (request.path === '/old') return { status: 301, headers: { location: '/about' }, body: '' };
  const page = state.pages[request.path];
  if (!page) return { status: 404, headers: { 'content-type': 'text/html' }, body: '<html><body>Not found</body></html>' };
  if (page.redirect) return { status: 302, headers: { location: page.redirect }, body: '' };
  if (page.status) return { status: page.status, headers: { 'content-type': 'text/html' }, body: `<html><body>Error ${page.status}</body></html>` };
  const etag = etagOf(page);
  const since = request.headers['if-modified-since'];
  const notModified = (etag && request.headers['if-none-match'] === etag) || (!etag && page.lastModified && since && Date.parse(String(since)) >= Date.parse(page.lastModified));
  const headers = { 'content-type': page.contentType ?? 'text/html; charset=utf-8', ...(etag && { etag }), ...(page.lastModified && { 'last-modified': page.lastModified }) };
  return notModified ? { status: 304, headers, body: '' } : { headers, body: html(page) };
}

export function fakeSite(seed: Partial<SiteSeed> = {}): Fake<SiteState> {
  return defineFake<SiteState>({
    name: 'site',
    token: 'public',
    auth: () => true,
    initial: () => ({ pages: structuredClone(seed.pages ?? defaultPages(seed.offHost)), robots: seed.robots === undefined ? 'User-agent: *\nDisallow: /private/\n' : seed.robots }),
    routes: route,
  });
}

/** Add or replace a page, through the fake's own API. */
export async function setPage(fake: Fake<SiteState>, path: string, page: SitePage): Promise<void> {
  const response = await fetch(`${fake.url}/__fake/page`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path, page }) });
  if (!response.ok) throw new Error(`setPage: ${response.status}`);
}

/** Remove a page (it answers 404 from then on). */
export async function removePage(fake: Fake<SiteState>, path: string): Promise<void> {
  const response = await fetch(`${fake.url}/__fake/page?path=${encodeURIComponent(path)}`, { method: 'DELETE' });
  if (!response.ok) throw new Error(`removePage: ${response.status}`);
}

/** Replace /robots.txt (`null`: it is a 404). */
export async function setRobots(fake: Fake<SiteState>, robots: string | null): Promise<void> {
  const response = await fetch(`${fake.url}/__fake/robots`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ robots }) });
  if (!response.ok) throw new Error(`setRobots: ${response.status}`);
}
