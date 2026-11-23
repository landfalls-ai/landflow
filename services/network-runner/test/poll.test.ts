/** The loop: poll → call → answer against a stub host; a 401 stops it; errors back off; calls run in parallel. */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { parseAllow } from '../src/allow';
import { runLoop } from '../src/poll';

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
});
const listen = async (handler: Parameters<typeof createServer>[1]) => {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};
const body = (req: NodeJS.ReadableStream) =>
  new Promise<string>((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
  });

describe('runLoop', () => {
  it('claims a call, makes it and answers it, with the token and its own name', async () => {
    const inside = await listen((_req, res) => res.writeHead(200).end('inside'));
    const answers: unknown[] = [];
    const auth: Array<string | undefined> = [];
    let handed = false;
    const host = await listen(async (req, res) => {
      auth.push(req.headers.authorization);
      const payload = await body(req);
      if (req.url === '/api/runner/v1/poll') {
        if (!handed) {
          handed = true;
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'call_a', request: { method: 'GET', url: `${inside}/x`, headers: [], timeoutMs: 5000 } }));
        } else res.writeHead(204).end();
      } else if (req.url === '/api/runner/v1/calls/call_a') {
        answers.push(JSON.parse(payload));
        res.writeHead(204).end();
        controller.abort();
      } else res.writeHead(404).end();
    });
    const controller = new AbortController();
    const result = await runLoop({ url: new URL(host), token: 'lf_run_test', name: 'office-1', allow: parseAllow('127.0.0.0/8'), concurrency: 2, retryMs: [10, 20] }, controller.signal, () => {});
    expect(result).toBe('stopped');
    expect(answers).toEqual([{ status: 200, headers: expect.any(Array), body: Buffer.from('inside').toString('base64') }]);
    expect(auth.every((value) => value === 'Bearer lf_run_test')).toBe(true);
  });

  it('stops on 401 and says the token was revoked', async () => {
    const host = await listen((_req, res) => res.writeHead(401).end());
    const lines: string[] = [];
    const result = await runLoop({ url: new URL(host), token: 'lf_run_test', name: 'n', allow: [], concurrency: 1, retryMs: [10] }, new AbortController().signal, (line) => lines.push(line));
    expect(result).toBe('revoked');
    expect(lines.join('\n')).toMatch(/token was revoked/);
  });

  it('backs off after an error and tries again', async () => {
    let hits = 0;
    const times: number[] = [];
    const controller = new AbortController();
    const host = await listen((_req, res) => {
      times.push(Date.now());
      if (++hits < 3) res.writeHead(500).end();
      else {
        res.writeHead(204).end();
        controller.abort();
      }
    });
    await runLoop({ url: new URL(host), token: 't', name: 'n', allow: [], concurrency: 1, retryMs: [50, 100, 200] }, controller.signal, () => {});
    expect(hits).toBe(3);
    expect(times[1] - times[0]).toBeGreaterThanOrEqual(45);
    expect(times[2] - times[1]).toBeGreaterThanOrEqual(95);
  });

  it('runs calls in parallel up to its concurrency and keeps sending heartbeats while busy', async () => {
    const inside = await listen((_req, res) => setTimeout(() => res.writeHead(200).end('ok'), 300));
    let handed = 0;
    let answered = 0;
    const polls: string[] = [];
    const controller = new AbortController();
    const host = await listen(async (req, res) => {
      const payload = await body(req);
      if (req.url === '/api/runner/v1/poll') {
        polls.push(payload);
        if (handed < 2 && JSON.parse(payload).max > 0) {
          handed++;
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: `c${handed}`, request: { method: 'GET', url: `${inside}/`, headers: [], timeoutMs: 5000 } }));
        } else res.writeHead(204).end();
      } else {
        res.writeHead(204).end();
        if (++answered === 2) controller.abort();
      }
    });
    const started = Date.now();
    await runLoop({ url: new URL(host), token: 't', name: 'n', allow: parseAllow('127.0.0.0/8'), concurrency: 2, retryMs: [10], idleMs: 20 }, controller.signal, () => {});
    expect(Date.now() - started).toBeLessThan(900); // two 300 ms calls overlapped
    expect(polls.some((p) => JSON.parse(p).max === 0)).toBe(true);
  });
});
