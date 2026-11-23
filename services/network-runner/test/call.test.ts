/**
 * One call on the runner (D12): against local node:http servers. A refused address, a redirect to a refused host, the
 * timeout, the 10 MiB cap, repeated headers and a binary body come through; and no header value, query or body is in
 * the log lines (AS-6 at unit level).
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseAllow } from '../src/allow';
import { performCall } from '../src/call';

let server: Server;
let origin: string;
const seen: Array<{ method: string; url: string; headers: IncomingMessage['headers']; body: string }> = [];
beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString() });
      if (req.url?.startsWith('/redirect-out')) {
        res.writeHead(302, { location: 'http://203.0.113.7:81/secret' }).end();
      } else if (req.url?.startsWith('/redirect-in')) {
        res.writeHead(302, { location: '/ok' }).end();
      } else if (req.url?.startsWith('/loop')) {
        res.writeHead(302, { location: '/loop' }).end();
      } else if (req.url?.startsWith('/slow')) {
        setTimeout(() => res.end('late'), 2_000);
      } else if (req.url?.startsWith('/big')) {
        res.writeHead(200).end(Buffer.alloc(11 * 1024 * 1024));
      } else if (req.url?.startsWith('/gz')) {
        res.writeHead(200, { 'content-encoding': 'gzip', 'content-type': 'text/plain' }).end(gzipSync('zipped words'));
      } else if (req.url?.startsWith('/cookies')) {
        res.writeHead(200, { 'set-cookie': ['a=1', 'b=2'] }).end('ok');
      } else {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ path: req.url }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise((resolve) => server.close(() => resolve(undefined))));

const config = (allow: string) => ({ allow: parseAllow(allow) });
const call = (path: string, extra: Record<string, unknown> = {}, allow = '127.0.0.0/8', logs: string[] = []) =>
  performCall({ id: 'call_1', method: 'GET', url: `${origin}${path}`, headers: [], timeoutMs: 5_000, ...extra }, config(allow), (line) => logs.push(line));
const text = (body: string | undefined) => Buffer.from(body ?? '', 'base64').toString();

describe('performCall', () => {
  it('fetches an allowed target and returns status, headers and body', async () => {
    const answer = await call('/hello');
    expect(answer).toMatchObject({ status: 200 });
    expect('status' in answer && JSON.parse(text(answer.body))).toEqual({ path: '/hello' });
    expect('headers' in answer && answer.headers.find(([name]) => name === 'content-type')).toEqual(['content-type', 'application/json']);
  });

  it('refuses a target outside the allow-list with the reason, and sends nothing', async () => {
    const before = seen.length;
    const answer = await call('/hello', {}, '10.20.0.0/16');
    expect(answer).toMatchObject({ error: { code: 'refused' } });
    expect('error' in answer && answer.error.message).toMatch(/not in this runner’s allow-list/);
    expect(seen.length).toBe(before);
  });

  it('an empty allow-list refuses everything', async () => {
    expect(await call('/hello', {}, '')).toMatchObject({ error: { code: 'refused' } });
  });

  it('refuses a redirect to a host outside the list (each hop is checked)', async () => {
    const answer = await call('/redirect-out');
    expect(answer).toMatchObject({ error: { code: 'refused' } });
    expect('error' in answer && answer.error.message).toContain('203.0.113.7');
  });

  it('follows a redirect inside the list, and gives up after five hops', async () => {
    const ok = await call('/redirect-in');
    expect('status' in ok && JSON.parse(text(ok.body))).toEqual({ path: '/ok' });
    expect(await call('/loop')).toMatchObject({ error: { code: 'network', message: expect.stringContaining('redirect') } });
  });

  it('times out', async () => {
    expect(await call('/slow', { timeoutMs: 200 })).toMatchObject({ error: { code: 'timeout' } });
  });

  it('caps a response at 10 MiB', async () => {
    expect(await call('/big')).toMatchObject({ error: { code: 'network', message: expect.stringContaining('10 MiB') } });
  });

  it('sends the method, headers and body it was given', async () => {
    await call('/echo', { method: 'POST', headers: [['x-one', 'a'], ['content-type', 'text/plain']], body: Buffer.from('payload').toString('base64') });
    const last = seen.at(-1)!;
    expect(last).toMatchObject({ method: 'POST', body: 'payload' });
    expect(last.headers['x-one']).toBe('a');
  });

  it('decodes a compressed response and drops its encoding header', async () => {
    const answer = await call('/gz');
    expect('status' in answer && text(answer.body)).toBe('zipped words');
    expect('headers' in answer && answer.headers.some(([name]) => name === 'content-encoding')).toBe(false);
  });

  it('keeps repeated response headers', async () => {
    const answer = await call('/cookies');
    expect('headers' in answer && answer.headers.filter(([name]) => name === 'set-cookie')).toHaveLength(2);
  });

  it('AS-6: the log has the id, method, origin, status and time, and never a header value, query or body', async () => {
    const logs: string[] = [];
    await call('/hello?token=query-secret-2', { method: 'POST', headers: [['authorization', 'Bearer dummy-runner-header-1']], body: Buffer.from('body-secret-3').toString('base64') }, '127.0.0.0/8', logs);
    await call('/hello', { headers: [['authorization', 'Bearer dummy-runner-header-1']] }, '10.0.0.0/8', logs);
    expect(logs.length).toBe(2);
    const all = logs.join('\n');
    for (const secret of ['dummy-runner-header-1', 'query-secret-2', 'body-secret-3', 'authorization']) expect(all).not.toContain(secret);
    expect(logs[0]).toContain('call_1');
    expect(logs[0]).toContain('POST');
    expect(logs[0]).toContain(origin);
    expect(logs[0]).toMatch(/200/);
  });
});
