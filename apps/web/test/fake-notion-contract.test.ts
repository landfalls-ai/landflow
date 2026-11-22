/**
 * The Notion fake on the @landflow/test-fakes contract: start, 401 without the token, a scripted 429, reset, state, the
 * request log and stop, through `startFakeNotion().asFake()`. The fake's own methods (addPage, setRateLimit, failNext…)
 * and the Notion brain tests that use them are unchanged.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Fake } from '@landflow/test-fakes';
import { FAKE_NOTION_VERSION, startFakeNotion, type FakeNotion } from './fake-notion';

let notion: FakeNotion | undefined;
afterEach(async () => {
  await notion?.close().catch(() => undefined);
  notion = undefined;
});

async function begin(): Promise<{ raw: FakeNotion; fake: Fake<unknown> }> {
  notion = await startFakeNotion();
  const fake = notion.asFake() as Fake<unknown>;
  await fake.start();
  return { raw: notion, fake };
}
const get = (fake: Fake<unknown>, path: string, token: string | null = fake.token) =>
  fetch(`${fake.url}${path}`, { headers: { 'notion-version': FAKE_NOTION_VERSION, ...(token ? { authorization: `Bearer ${token}` } : {}) } });

describe('the Notion fake as a contract fake', () => {
  it('starts on a loopback URL and answers with its token', async () => {
    const { fake } = await begin();
    expect(fake.name).toBe('notion');
    expect(fake.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect((await get(fake, '/v1/users/me')).status).toBe(200);
  });

  it('answers 401 without the token and logs the call as refused', async () => {
    const { fake } = await begin();
    expect((await get(fake, '/v1/users/me', null)).status).toBe(401);
    expect(fake.requests()).toMatchObject([{ method: 'GET', path: '/v1/users/me', status: 401, refused: true }]);
  });

  it('scripts a 429 with Retry-After for the next call only', async () => {
    const { fake } = await begin();
    fake.script({ status: 429, retryAfter: 1, times: 1 });
    const first = await get(fake, '/v1/users/me');
    expect(first.status).toBe(429);
    expect(first.headers.get('retry-after')).toBe('1');
    expect((await get(fake, '/v1/users/me')).status).toBe(200);
    expect(fake.requests().map((r) => r.status)).toEqual([429, 200]);
  });

  it('limits a script to matching calls', async () => {
    const { fake } = await begin();
    fake.script({ status: 500, match: (r) => r.method === 'POST' });
    expect((await get(fake, '/v1/users/me')).status).toBe(200);
  });

  it('rejects a delay it cannot honour rather than ignoring it', async () => {
    const { fake } = await begin();
    expect(() => fake.script({ status: 200, delayMs: 10 })).toThrow(/delayMs/);
  });

  it('holds state as a JSON copy, and reset empties it with the log and the scripts', async () => {
    const { raw, fake } = await begin();
    const page = raw.addPage({ title: 'Brain', shared: true });
    const snapshot = fake.state() as { pages: Array<{ id: string; title: string }> };
    expect(snapshot.pages.map((p) => p.title)).toEqual(['Brain']);
    snapshot.pages.length = 0;
    expect((fake.state() as typeof snapshot).pages).toHaveLength(1);
    expect((await get(fake, `/v1/pages/${page}`)).status).toBe(200);
    fake.script({ status: 503, times: 5 });
    fake.reset();
    expect((fake.state() as typeof snapshot).pages).toEqual([]);
    expect(fake.requests()).toEqual([]);
    expect((await get(fake, '/v1/users/me')).status).toBe(200);
  });

  it('stops: the port is freed and a second stop is harmless', async () => {
    const { fake } = await begin();
    const url = fake.url;
    await fake.stop();
    await fake.stop();
    await expect(fetch(`${url}/v1/users/me`)).rejects.toThrow();
  });
});
