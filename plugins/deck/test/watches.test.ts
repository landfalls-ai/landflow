/** Watches: a completion for the unit becomes one POST to Report To; retries, timeouts, other origins and the cap. */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_WATCHES, Watches, completionOf, type DeckMessage } from '../src/watches';
import { completion } from './helpers';

let server: Server;
let origin: string;
let posts: { url: string; body: unknown }[];
let statuses: number[];

beforeEach(async () => {
  posts = [];
  statuses = [];
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      posts.push({ url: req.url ?? '', body: JSON.parse(raw) });
      res.statusCode = statuses.shift() ?? 200;
      res.end('{}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(() => new Promise<void>((r) => server.close(() => r())));

function harness(inbox: DeckMessage[][] = []) {
  const clock = { t: 1_000_000 };
  const watches = new Watches({
    fetchInbox: async () => inbox.shift() ?? [],
    hostOrigin: () => origin,
    now: () => clock.t,
  });
  const tick = async (ms = 0) => {
    clock.t += ms;
    await watches.tick();
  };
  return { watches, tick, clock };
}

describe('completionOf', () => {
  it('finds the unit\'s completion and its fenced report', () => {
    expect(completionOf([completion('u1', 'all done')], 'u1')).toEqual({ report: 'all done', status: 'completed' });
  });
  it('ignores another unit, a spawn reply and an update', () => {
    const spawn = { id: 's', subject: 'dispatch', from: 'the dispatch of "u1"', text: 'dispatch: spawned isolated agent for u1' };
    const update = { ...completion('u1', 'more'), text: 'dispatch: a unit you dispatched sent an update to its report\n[UNTRUSTED-WORKER-REPORT:\nmore\n:END-UNTRUSTED-WORKER-REPORT]' };
    expect(completionOf([completion('u2', 'x'), spawn, update], 'u1')).toBeUndefined();
  });
  it('reads a completion with no report text as an empty report', () => {
    const none = { ...completion('u1', ''), text: 'dispatch: a unit you dispatched has completed (dot-agent-deck daemon report). The unit sent no report text with its completion.' };
    expect(completionOf([none], 'u1')).toEqual({ report: '', status: 'completed' });
  });
  it('reads a refusal for the unit as a failure carrying the deck\'s text', () => {
    const refused = { id: 'r', subject: 'dispatch', from: 'the dispatch of "u1"', text: 'dispatch: refused: the worktree is busy' };
    expect(completionOf([refused], 'u1')).toEqual({ report: 'dispatch: refused: the worktree is busy', status: 'failed' });
  });
});

describe('Watches', () => {
  it('posts { unit, report, status } once when the completion arrives', async () => {
    const { watches, tick } = harness([[], [completion('u1', 'built it'), completion('u2', 'other')]]);
    watches.add('u1', `${origin}/api/waiting/ex1?sig=abc`, 3_600_000);
    await tick();
    expect(posts).toEqual([]);
    await tick(10_000);
    expect(posts).toEqual([{ url: '/api/waiting/ex1?sig=abc', body: { unit: 'u1', report: 'built it', status: 'completed' } }]);
    expect(watches.size).toBe(0);
    await tick(10_000);
    expect(posts).toHaveLength(1);
  });

  it('keeps a completion that arrives before another watch asks for it', async () => {
    const { watches, tick } = harness([[completion('u2', 'early')]]);
    watches.add('u1', `${origin}/api/waiting/a`, 3_600_000);
    await tick();
    watches.add('u2', `${origin}/api/waiting/b`, 3_600_000);
    await tick();
    expect(posts.map((p) => p.url)).toEqual(['/api/waiting/b']);
  });

  it('retries a failed post with backoff until it gets 200', async () => {
    statuses.push(503, 503);
    const { watches, tick } = harness([[completion('u1', 'r')]]);
    watches.add('u1', `${origin}/api/waiting/ex1`, 3_600_000);
    await tick();
    expect(posts).toHaveLength(1);
    expect(watches.size).toBe(1);
    await tick(500); // before the first 1 s backoff
    expect(posts).toHaveLength(1);
    await tick(1_000);
    expect(posts).toHaveLength(2);
    await tick(1_000); // 2 s backoff not yet over
    expect(posts).toHaveLength(2);
    await tick(2_000);
    expect(posts).toHaveLength(3);
    expect(watches.size).toBe(0);
  });

  it('stops on a 404 (the run is gone) instead of retrying forever', async () => {
    statuses.push(404);
    const { watches, tick } = harness([[completion('u1', 'r')]]);
    watches.add('u1', `${origin}/api/waiting/gone`, 3_600_000);
    await tick();
    expect(watches.size).toBe(0);
    await tick(120_000);
    expect(posts).toHaveLength(1);
  });

  it('drops the watch at its timeout with no post', async () => {
    const { watches, tick } = harness([[], [], [completion('u1', 'too late')]]);
    watches.add('u1', `${origin}/api/waiting/ex1`, 60_000);
    await tick(30_000);
    expect(watches.size).toBe(1);
    await tick(31_000);
    expect(watches.size).toBe(0);
    await tick(10_000);
    expect(posts).toEqual([]);
  });

  it('refuses a Report To on another origin, and a malformed one', () => {
    const { watches } = harness();
    expect(() => watches.add('u1', 'http://evil.example/api/waiting/x', 1000)).toThrow(/Report To/);
    expect(() => watches.add('u1', 'not a url', 1000)).toThrow(/Report To/);
    expect(() => watches.add('u1', 'file:///etc/passwd', 1000)).toThrow(/Report To/);
    expect(watches.size).toBe(0);
  });

  it('allows localhost for a host announced on 127.0.0.1', () => {
    const { watches } = harness();
    const port = new URL(origin).port;
    watches.add('u1', `http://localhost:${port}/api/waiting/x`, 1000);
    expect(watches.size).toBe(1);
  });

  it('refuses the 51st open watch and a repeated unit name', () => {
    const { watches } = harness();
    for (let i = 0; i < MAX_WATCHES; i++) watches.add(`u${i}`, `${origin}/w/${i}`, 1000);
    expect(() => watches.add('extra', `${origin}/w/x`, 1000)).toThrow(/50/);
    expect(() => watches.add('u0', `${origin}/w/x`, 1000)).toThrow(/already/);
  });

  it('survives an unreadable inbox and tries again', async () => {
    let calls = 0;
    const clock = { t: 0 };
    const watches = new Watches({
      fetchInbox: async () => {
        if (calls++ === 0) throw new Error('daemon down');
        return [completion('u1', 'r')];
      },
      hostOrigin: () => origin,
      now: () => clock.t,
    });
    watches.add('u1', `${origin}/api/waiting/ex1`, 3_600_000);
    await watches.tick();
    expect(posts).toEqual([]);
    clock.t += 10_000;
    await watches.tick();
    expect(posts).toHaveLength(1);
  });
});
