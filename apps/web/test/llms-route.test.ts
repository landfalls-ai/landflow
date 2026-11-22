/**
 * /llms.txt and /llms-full.txt: public, cacheable text from the bundle built into the host (C25). The routes take no
 * path from the request; they serve two fixed names out of one folder (LANDFLOW_LLMS_DIR, else the image's `llms/`,
 * else the repository's docs/).
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
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

const { isPublicPath } = await import('@/lib/shared/auth-paths');
const short = await import('@/app/llms.txt/route');
const full = await import('@/app/llms-full.txt/route');
const { llmsFile } = await import('@/lib/server/llms');

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

describe('public paths', () => {
  it('lists exactly the two files', () => {
    expect(isPublicPath('/llms.txt')).toBe(true);
    expect(isPublicPath('/llms-full.txt')).toBe(true);
    expect(isPublicPath('/llms')).toBe(false);
    expect(isPublicPath('/llms.txt.bak')).toBe(false);
  });
});
