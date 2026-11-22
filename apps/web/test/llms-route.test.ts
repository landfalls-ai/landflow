/**
 * /llms.txt and /llms-full.txt: public, cacheable text from the bundle built into the host (C25). The routes take no
 * path from the request; they serve two fixed names out of one folder (LANDFLOW_LLMS_DIR, else the image's `llms/`,
 * else the repository's docs/).
 */
import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

const previousEnv = { ...process.env };
const dir = mkdtempSync(join(tmpdir(), 'landflow-llms-'));
const secretDir = mkdtempSync(join(tmpdir(), 'landflow-llms-secret-'));
writeFileSync(join(dir, 'llms.txt'), '# Landflow\n\n- [Guide](/llms-full.txt#platform-readme-md): the guide\n');
writeFileSync(join(dir, 'llms-full.txt'), '# Landflow\n\n<!-- page: platform/README.md -->\n');
writeFileSync(join(dir, 'other.txt'), 'not served');
writeFileSync(join(secretDir, 'credentials.json'), '{"secret":true}');

const { disableTestAuth, enableTestAuth } = await import('@/lib/server/auth/test-bypass');
const { isPublicPath } = await import('@/lib/shared/auth-paths');
const short = await import('@/app/llms.txt/route');
const full = await import('@/app/llms-full.txt/route');
const { llmsFile } = await import('@/lib/server/llms');
const { limitRequest } = await import('@/lib/server/rate-limit/api-limiter');
const { resetSingleton } = await import('@/lib/server/singleton');

afterEach(() => {
  process.env.LANDFLOW_LLMS_DIR = dir;
});
afterAll(() => {
  process.env = previousEnv;
});

const call = (route: { GET: unknown }, url = 'http://localhost/llms.txt') => (route.GET as (r: Request) => Promise<Response>)(new Request(url));

describe('the routes', () => {
  it('serve both files as cacheable plain text without a session', async () => {
    process.env.LANDFLOW_LLMS_DIR = dir;
    for (const [route, body] of [
      [short, '# Landflow\n\n- [Guide](/llms-full.txt#platform-readme-md): the guide\n'],
      [full, '# Landflow\n\n<!-- page: platform/README.md -->\n'],
    ] as const) {
      const res = await call(route);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
      expect(res.headers.get('cache-control')).toBe('public, max-age=3600');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(await res.text()).toBe(body);
    }
  });

  it('answer 404 with the command that builds the file when it is missing', async () => {
    process.env.LANDFLOW_LLMS_DIR = mkdtempSync(join(tmpdir(), 'landflow-llms-empty-'));
    const res = await call(full);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toMatch(/pnpm docs:llms/);
  });

  it('read nothing from the request: a query or a path changes nothing', async () => {
    process.env.LANDFLOW_LLMS_DIR = dir;
    const res = await call(short, 'http://localhost/llms.txt?file=../credentials.json&name=other.txt');
    expect(await res.text()).toContain('# Landflow');
  });
});

describe('llmsFile', () => {
  it('only knows its two names; the folder comes from configuration, never the caller', async () => {
    process.env.LANDFLOW_LLMS_DIR = dir;
    expect(await llmsFile('llms.txt')).toContain('Guide');
    // A caller bypassing the types still gets nothing outside the two names.
    expect(await llmsFile('other.txt' as 'llms.txt')).toBeUndefined();
    expect(await llmsFile('../credentials.json' as 'llms.txt')).toBeUndefined();
    process.env.LANDFLOW_LLMS_DIR = join(secretDir, 'nope');
    expect(await llmsFile('llms.txt')).toBeUndefined();
  });

  it('falls back to the repository docs/ in development', async () => {
    delete process.env.LANDFLOW_LLMS_DIR;
    // vitest runs from apps/web: <cwd>/../../docs holds the committed llms.txt.
    expect(await llmsFile('llms.txt')).toMatch(/^# Landflow\n/);
  });
});

describe('without a principal', () => {
  it('answers a caller with no session or key, and sets no cookie', async () => {
    // test/setup.ts signs guarded calls in as a synthetic owner; here nobody is signed in.
    disableTestAuth();
    try {
      const res = await call(short);
      expect(res.status).toBe(200);
      expect(res.headers.get('set-cookie')).toBeNull();
    } finally {
      enableTestAuth();
    }
  });

  // The two PUBLIC_ROUTES entries in lib/shared/auth-paths.ts are documentation: any `.txt` outside /api already counts
  // as a static asset there. This pins that the paths stay public and the neighbours stay as they were.
  it('keeps the paths public and a neighbour private', () => {
    expect(isPublicPath('/llms.txt')).toBe(true);
    expect(isPublicPath('/llms-full.txt')).toBe(true);
    expect(isPublicPath('/llms')).toBe(false);
  });
});

describe('caching', () => {
  it('reads a file once and again only when its modification time changes', async () => {
    const own = mkdtempSync(join(tmpdir(), 'landflow-llms-cache-'));
    const file = join(own, 'llms.txt');
    writeFileSync(file, 'one\n');
    // Whole seconds, so restoring the time gives back the same value to the millisecond.
    utimesSync(file, 1_700_000_000, 1_700_000_000);
    process.env.LANDFLOW_LLMS_DIR = own;
    resetSingleton('llms-files');
    expect(await llmsFile('llms.txt')).toBe('one\n');
    // Same size, same mtime: the cached text answers, whatever is on disk now.
    writeFileSync(file, 'two\n');
    utimesSync(file, 1_700_000_000, 1_700_000_000);
    expect(await llmsFile('llms.txt')).toBe('one\n');
    utimesSync(file, 1_700_000_000, 1_700_000_005);
    expect(await llmsFile('llms.txt')).toBe('two\n');
  });

  it('sends an ETag and answers If-None-Match with 304', async () => {
    process.env.LANDFLOW_LLMS_DIR = dir;
    resetSingleton('llms-files');
    const first = await call(short);
    const etag = first.headers.get('etag');
    expect(etag).toMatch(/^"[0-9a-f]{16,}"$/);
    const get = (value: string) =>
      (short.GET as (r: Request) => Promise<Response>)(new Request('http://localhost/llms.txt', { headers: { 'if-none-match': value } }));
    for (const value of [etag!, `W/${etag}`, `"x", ${etag}`, '*']) {
      const res = await get(value);
      expect(res.status).toBe(304);
      expect(await res.text()).toBe('');
      expect(res.headers.get('etag')).toBe(etag);
      expect(res.headers.get('cache-control')).toBe('public, max-age=3600');
    }
    expect((await get('"other"')).status).toBe(200);
    // The two files have their own tags.
    expect((await call(full)).headers.get('etag')).not.toBe(etag);
  });
});

describe('rate limit', () => {
  it('counts both files in one public group per address', async () => {
    process.env.LANDFLOW_RATE_LIMIT_PUBLIC = '2';
    try {
      const req = (path: string) => new Request(`http://localhost${path}`, { headers: { 'x-forwarded-for': '10.9.9.9' } });
      expect(await limitRequest(req('/llms.txt'), undefined)).toBeUndefined();
      expect(await limitRequest(req('/llms-full.txt'), undefined)).toBeUndefined();
      const refused = await limitRequest(req('/llms.txt'), undefined);
      expect(refused?.status).toBe(429);
    } finally {
      delete process.env.LANDFLOW_RATE_LIMIT_PUBLIC;
    }
  });
});
