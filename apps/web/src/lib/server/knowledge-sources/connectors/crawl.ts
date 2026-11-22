/**
 * C22: the crawl connector: one site, from a start address, same origin only (scheme, host and port: a link to another host,
 * another port or a redirect that leaves the origin is never requested), at most `maxDepth` links deep and `maxPages` pages,
 * obeying robots.txt (a page it forbids is skipped and counted), 500 ms between requests, every request through `safeFetch` (the
 * outbound policy at DNS and on every hop; redirects are followed here so that each hop stays on the origin). Plain HTTP: a page is
 * what the server sends, reduced to text by the existing HTML loader; no JavaScript is run.
 *
 * Version marker of a page: its ETag, else its Last-Modified, else the SHA-256 of its bytes. A conditional request
 * (`If-None-Match` / `If-Modified-Since`, from the version stored at the last sync) lets the server answer 304; the page's links are
 * kept in the item's `extra`, so an unchanged page still leads on. The listing fetches while it lists (it has to read a page to know
 * its links) and keeps the bytes of changed pages for `fetch`.
 */
import { createHash } from 'node:crypto';
import type { CrawlSettings } from '../../../shared/knowledge-sources';
import { safeFetch } from '../../net/safe-fetch';
import type { FileInput } from '../../rag/files';
import { readCapped, TooLargeError, megabytes } from './bounded';
import { CRAWL_AGENT, parseRobots, robotsAllow, type RobotsRules } from './robots';
import { SourceError, type Connector, type SourceItem } from './types';

/** Milliseconds between two requests to the site. */
export const CRAWL_SPACING_MS = 500;
const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const MAX_ROBOTS_BYTES = 512 * 1024;
/** What the listing keeps in memory for `fetch` (changed pages); past it a page is left for the next sync and the listing is not whole. */
export const KEPT_BUDGET_BYTES = 100 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const MAX_LINKS_KEPT = 200;
const SKIPPED_EXTENSIONS = /\.(png|jpe?g|gif|svg|webp|ico|css|js|mjs|zip|gz|tgz|mp4|mp3|wav|woff2?|ttf|exe|dmg)$/i;
const PAGE_TYPES = new Set(['text/html', 'application/xhtml+xml', 'text/plain', 'text/markdown']);

const decode = (bytes: Uint8Array) => new TextDecoder('utf-8').decode(bytes);
const titleOf = (html: string): string | undefined => {
  const raw = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  const text = raw?.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, 160) : undefined;
};

/** The addresses a page links to on the origin, absolute, without fragments, in order, once each. */
function linksOf(html: string, base: URL): string[] {
  const out = new Set<string>();
  for (const match of html.matchAll(/<a\s[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
    const href = (match[1] ?? match[2] ?? match[3] ?? '').replace(/&amp;/g, '&').trim();
    if (!href || href.startsWith('#')) continue;
    try {
      const url = new URL(href, base);
      if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.origin !== base.origin || SKIPPED_EXTENSIONS.test(url.pathname)) continue;
      url.hash = '';
      out.add(url.href);
    } catch {
      /* not a link we can read */
    }
  }
  return [...out].slice(0, MAX_LINKS_KEPT);
}

type Hop = { kind: 'page'; url: URL; response: Response } | { kind: 'offsite'; to: string } | { kind: 'seen'; url: URL };

export function crawlConnector(settings: CrawlSettings, options: { spacingMs?: number; keptBudgetBytes?: number } = {}): Connector {
  const spacing = options.spacingMs ?? CRAWL_SPACING_MS;
  const keptBudget = options.keptBudgetBytes ?? KEPT_BUDGET_BYTES;
  const start = new URL(settings.startUrl);
  const kept = new Map<string, { file: FileInput }>();
  let last = 0;
  let keptBytes = 0;

  /** One request, at least `spacing` after the last. */
  async function request(url: URL, headers: Record<string, string>, signal: AbortSignal): Promise<Response> {
    const wait = last + spacing - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    if (signal.aborted) throw new SourceError('Stopped');
    last = Date.now();
    try {
      return await safeFetch(url, { headers: { 'user-agent': `${CRAWL_AGENT}/1.0`, accept: 'text/html,application/xhtml+xml,text/plain,text/markdown;q=0.9,*/*;q=0.1', ...headers }, redirect: 'manual', signal });
    } catch (caught) {
      if (signal.aborted) throw new SourceError('Stopped');
      throw new SourceError((caught as Error).message.slice(0, 300));
    }
  }

  /** The page at `first`, following same-origin redirects by hand (every hop is checked and spaced); the conditional headers belong to each hop's own stored version. */
  async function get(first: URL, previous: Map<string, { version: string }>, visited: Set<string>, signal: AbortSignal): Promise<Hop> {
    let url = first;
    for (let hops = 0; hops <= MAX_REDIRECTS; hops++) {
      const before = previous.get(url.href)?.version;
      const conditional: Record<string, string> = before?.startsWith('etag:') ? { 'if-none-match': before.slice(5) } : before?.startsWith('lm:') ? { 'if-modified-since': before.slice(3) } : {};
      const response = await request(url, conditional, signal);
      const location = response.headers.get('location');
      if (response.status >= 300 && response.status < 400 && response.status !== 304 && location) {
        await response.body?.cancel().catch(() => undefined);
        const next = new URL(location, url);
        next.hash = '';
        if (next.origin !== start.origin) return { kind: 'offsite', to: next.origin };
        if (visited.has(next.href)) return { kind: 'seen', url: next };
        url = next;
        continue;
      }
      return { kind: 'page', url, response };
    }
    throw new SourceError('Too many redirects');
  }

  async function readRobots(signal: AbortSignal): Promise<RobotsRules> {
    const response = await request(new URL('/robots.txt', start.origin), {}, signal);
    if (response.ok) return parseRobots(decode(await readCapped(response.body, MAX_ROBOTS_BYTES, { truncate: true })));
    await response.body?.cancel().catch(() => undefined);
    if ([401, 403, 404, 410].includes(response.status) || (response.status >= 300 && response.status < 400)) return parseRobots(''); // no robots.txt: everything is allowed
    throw new SourceError(`robots.txt could not be read (${response.status}); the crawl does not start without it`);
  }

  return {
    async list(signal, previous) {
      const robots = await readRobots(signal);
      const items: SourceItem[] = [];
      const problems: Array<{ item: string; reason: string }> = [];
      const visited = new Set<string>();
      let skipped = 0;
      let complete = true;
      let note: string | undefined;
      const queue: Array<{ url: string; depth: number }> = [{ url: start.href.replace(/#.*$/, ''), depth: 0 }];
      visited.add(queue[0].url);
      let pages = 0;
      while (queue.length) {
        if (signal.aborted) throw new SourceError('Stopped');
        const { url, depth } = queue.shift()!;
        const target = new URL(url);
        if (!robotsAllow(robots, target.pathname + target.search)) {
          skipped++;
          continue;
        }
        if (pages >= settings.maxPages) {
          complete = false;
          note = `The crawl stopped at ${settings.maxPages} pages`;
          break;
        }
        const hop = await get(target, previous, visited, signal);
        if (hop.kind === 'offsite') {
          problems.push({ item: url, reason: `It redirects to another site (${hop.to}), which is not followed` });
          complete = false;
          continue;
        }
        if (hop.kind === 'seen') continue;
        const { response } = hop;
        const finalUrl = hop.url.href;
        if (finalUrl !== url) {
          if (visited.has(finalUrl)) {
            await response.body?.cancel().catch(() => undefined);
            continue;
          }
          visited.add(finalUrl);
        }
        const status = response.status;
        const before = previous.get(finalUrl);
        let links: string[];
        if (status === 304 && before) {
          await response.body?.cancel().catch(() => undefined);
          pages++;
          items.push({ key: finalUrl, name: before.name ?? finalUrl, version: before.version, url: finalUrl, ...(before.extra && { extra: before.extra }) });
          links = (JSON.parse(before.extra ?? '{"links":[]}') as { links?: string[] }).links ?? [];
        } else if (status === 404 || status === 410) {
          await response.body?.cancel().catch(() => undefined);
          if (depth === 0) throw new SourceError(`The start page answered ${status}`);
          continue; // gone: not an item, so the sync takes it for removed
        } else if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          if (depth === 0) throw new SourceError(`The start page answered ${status}`);
          problems.push({ item: finalUrl, reason: `The page answered ${status}` });
          complete = false;
          continue;
        } else {
          const type = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
          if (!PAGE_TYPES.has(type)) {
            await response.body?.cancel().catch(() => undefined);
            continue; // an image, a download: not a page
          }
          let bytes: Uint8Array;
          try {
            bytes = await readCapped(response.body, MAX_PAGE_BYTES);
          } catch (caught) {
            if (!(caught instanceof TooLargeError)) throw caught;
            problems.push({ item: finalUrl, reason: `Too large (the limit for a page is ${megabytes(MAX_PAGE_BYTES)})` });
            complete = false;
            continue;
          }
          const text = decode(bytes);
          const etag = response.headers.get('etag');
          const modified = response.headers.get('last-modified');
          const version = etag ? `etag:${etag}` : modified ? `lm:${modified}` : `sha:${createHash('sha256').update(bytes).digest('hex')}`;
          links = type === 'text/html' || type === 'application/xhtml+xml' ? linksOf(text, hop.url) : [];
          const name = (type === 'text/plain' || type === 'text/markdown' ? undefined : titleOf(text)) ?? (hop.url.pathname === '/' ? hop.url.host : hop.url.pathname);
          const changed = before?.version !== version;
          if (changed && keptBytes + bytes.length > keptBudget) {
            problems.push({ item: finalUrl, reason: 'Left for the next sync: this sync already holds as much as it may keep in memory' });
            complete = false;
            note = note ?? 'The pages of this sync filled the memory it may use';
            continue;
          }
          pages++;
          items.push({ key: finalUrl, name, version, size: bytes.length, mimeType: type, url: finalUrl, extra: JSON.stringify({ links }) });
          if (changed) {
            kept.set(finalUrl, { file: { bytes, fileName: name, mimeType: type } });
            keptBytes += bytes.length;
          }
        }
        if (depth < settings.maxDepth) {
          for (const link of links) {
            if (visited.has(link)) continue;
            visited.add(link);
            queue.push({ url: link, depth: depth + 1 });
          }
        }
      }
      return { items, complete, ...(note && { note }), ...(skipped && { skipped }), ...(problems.length && { problems }) };
    },
    async fetch(item) {
      const page = kept.get(item.key);
      if (!page) throw new SourceError('The page was not kept from the crawl');
      kept.delete(item.key);
      keptBytes -= page.file.bytes.length;
      return page.file;
    },
  };
}
