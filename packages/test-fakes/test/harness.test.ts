/** The fake contract (defineFake): start on a free port, auth, scripted failures, reset, a copied state, the request log, stop. */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defineFake, type Fake } from '../src/harness';

interface Counter {
  items: string[];
}

const make = (token = 'tok-1') =>
  defineFake<Counter>({
    name: 'counter',
    token,
    initial: () => ({ items: ['seed'] }),
    routes: (state, request) => {
      if (request.method === 'POST' && request.path === '/items') {
        state.items.push(String((request.body as { name?: string })?.name));
        return { status: 201, body: { count: state.items.length } };
      }
      if (request.path === '/items') return { body: state.items };
      return { status: 404, body: { error: 'not found' } };
    },
  });

const started: Array<Fake<unknown>> = [];
const start = async (fake: Fake<Counter> = make()) => {
  started.push(fake as Fake<unknown>);
  await fake.start();
  return fake;
};
afterEach(async () => {
  await Promise.all(started.splice(0).map((f) => f.stop()));
});

const call = (fake: Fake<Counter>, path: string, init: RequestInit & { token?: string | null } = {}) => {
  const { token = fake.token, ...rest } = init;
  return fetch(`${fake.url}${path}`, { ...rest, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json', ...(rest.headers as Record<string, string>) } });
};
const add = (fake: Fake<Counter>, name: string) => call(fake, '/items', { method: 'POST', body: JSON.stringify({ name }) });

describe('start and stop', () => {
  it('binds a loopback port and two instances get two ports', async () => {
    const a = await start();
    const b = await start();
    expect(a.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(a.url).not.toBe(b.url);
  });

  it('frees the port on stop', async () => {
    const fake = make();
    const url = await fake.start();
    await fake.stop();
    await expect(fetch(`${url}/items`)).rejects.toThrow();
  });

  it('refuses a second start', async () => {
    const fake = await start();
    await expect(fake.start()).rejects.toThrow(/already started/);
  });
});

describe('auth', () => {
  it('answers 401 without the token or with a wrong one, and logs both as refused', async () => {
    const fake = await start();
    expect((await call(fake, '/items', { token: null })).status).toBe(401);
    expect((await call(fake, '/items', { token: 'nope' })).status).toBe(401);
    expect((await call(fake, '/items')).status).toBe(200);
    expect(fake.requests().map((r) => [r.status, r.refused])).toEqual([[401, true], [401, true], [200, false]]);
    expect(fake.state().items).toEqual(['seed']);
  });

  it('lets a fake choose its own refusal and scheme', async () => {
    const fake = defineFake<Counter>({
      name: 'odd',
      token: 'secret',
      auth: (request, token) => request.headers['x-key'] === token,
      refusal: () => ({ status: 200, body: { ok: false, error: 'invalid_auth' } }),
      initial: () => ({ items: [] }),
      routes: () => ({ body: { ok: true } }),
    });
    await start(fake);
    const refused = await fetch(`${fake.url}/x`, { headers: { 'x-key': 'bad' } });
    expect(await refused.json()).toEqual({ ok: false, error: 'invalid_auth' });
    expect(fake.requests()[0]).toMatchObject({ refused: true, status: 200 });
    expect(await (await fetch(`${fake.url}/x`, { headers: { 'x-key': 'secret' } })).json()).toEqual({ ok: true });
  });
});

describe('script', () => {
  it('answers the next call with the failure, then normally', async () => {
    const fake = await start();
    fake.script({ status: 429, retryAfter: 1, times: 1 });
    const first = await call(fake, '/items');
    expect(first.status).toBe(429);
    expect(first.headers.get('retry-after')).toBe('1');
    expect((await call(fake, '/items')).status).toBe(200);
    expect(fake.requests()).toHaveLength(2);
  });

  it('counts times and carries a body', async () => {
    const fake = await start();
    fake.script({ status: 503, body: { error: 'down' }, times: 2 });
    expect(await (await call(fake, '/items')).json()).toEqual({ error: 'down' });
    expect((await call(fake, '/items')).status).toBe(503);
    expect((await call(fake, '/items')).status).toBe(200);
  });

  it('uses the fake\'s own error body for a script without one', async () => {
    const fake = defineFake<Counter>({ name: 'own', token: 't', scriptBody: (s) => ({ ok: false, code: s.status }), initial: () => ({ items: [] }), routes: () => ({ body: {} }) });
    await start(fake);
    fake.script({ status: 503 });
    expect(await (await fetch(`${fake.url}/x`)).json()).toEqual({ ok: false, code: 503 });
  });

  it('delays', async () => {
    const fake = await start();
    fake.script({ status: 200, delayMs: 120 });
    const at = Date.now();
    await call(fake, '/items');
    expect(Date.now() - at).toBeGreaterThanOrEqual(100);
  });

  it('limits a script to matching calls and spends it only on them', async () => {
    const fake = await start();
    fake.script({ status: 500, match: (r) => r.method === 'POST' });
    expect((await call(fake, '/items')).status).toBe(200);
    expect((await add(fake, 'x')).status).toBe(500);
    expect((await add(fake, 'y')).status).toBe(201);
    expect(fake.state().items).toEqual(['seed', 'y']);
  });

  it('applies a scripted failure before auth, like a rate limiter in front of the service', async () => {
    const fake = await start();
    fake.script({ status: 429 });
    expect((await call(fake, '/items', { token: null })).status).toBe(429);
  });
});

describe('reset and state', () => {
  it('restores the seed and clears the log and the scripts', async () => {
    const fake = await start();
    await add(fake, 'a');
    fake.script({ status: 500, times: 5 });
    fake.reset();
    expect(fake.state().items).toEqual(['seed']);
    expect(fake.requests()).toEqual([]);
    expect((await call(fake, '/items')).status).toBe(200);
  });

  it('hands out a copy of the state', async () => {
    const fake = await start();
    fake.state().items.push('tampered');
    expect(fake.state().items).toEqual(['seed']);
  });

  it('logs method, path, query, parsed body and status', async () => {
    const fake = await start();
    await add(fake, 'z');
    await call(fake, '/items?page=2');
    const [post, get] = fake.requests();
    expect(post).toMatchObject({ method: 'POST', path: '/items', body: { name: 'z' }, status: 201 });
    expect(get.query.get('page')).toBe('2');
  });
});

describe('the module', () => {
  it('imports only node built-ins', () => {
    const src = join(import.meta.dirname, '..', 'src');
    for (const file of readdirSync(src).filter((f) => f.endsWith('.ts'))) {
      const imports = [...readFileSync(join(src, file), 'utf8').matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
      for (const spec of imports) expect(spec.startsWith('node:') || spec.startsWith('./'), `${file} imports ${spec}`).toBe(true);
    }
  });
});
