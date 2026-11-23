/**
 * One call (D12): the request the host prepared, made from inside this network with `node:http` / `node:https`. The
 * allow-list is checked on the target as asked for, again on the address the name resolves to (at connect, through the
 * `lookup` option, so nothing can resolve to somewhere else after the check) and on every redirect hop (at most 5; the
 * runner follows them, the host never fetches). Request and response bodies are capped at 10 MiB.
 *
 * What is logged: one line per call with its id, method, origin, status and time. Never a header, a query string or a
 * body: the credential header the host set travels in memory for this call and goes nowhere else (FR-4).
 */
import { lookup as dnsLookup } from 'node:dns';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';
import { addressAllowed, nameAllowed, targetAllowed, type AllowEntry } from './allow';
import type { CallInput, RunnerAnswer } from './types';

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_HOPS = 5;

class Refused extends Error {}
class Failed extends Error {
  constructor(
    message: string,
    readonly code: 'timeout' | 'network' = 'network',
  ) {
    super(message);
  }
}

const refusal = (host: string) => new Refused(`refused: ${host} is not in this runner’s allow-list`);

interface Hop {
  status: number;
  headers: Array<[string, string]>;
  body: Buffer;
}

function once(url: URL, request: { method: string; headers: Array<[string, string]>; body?: Buffer }, allow: readonly AllowEntry[], signal: AbortSignal): Promise<Hop> {
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  // An address literal is decided here; a name is decided by its entry or, at connect, by the addresses it resolves to.
  const bare = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(bare) && !targetAllowed(allow, bare, port)) throw refusal(url.hostname);
  const viaName = nameAllowed(allow, url.hostname, port);
  return new Promise((resolve, reject) => {
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const headers: Record<string, string[]> = {};
    for (const [name, value] of request.headers) (headers[name.toLowerCase()] ??= []).push(value);
    // The body is plain bytes here: decoding is ours, so the encoding is what we say it is.
    headers['accept-encoding'] = ['gzip, deflate, br'];
    if (request.body) headers['content-length'] = [String(request.body.length)];
    const req = send(
      url,
      {
        method: request.method,
        headers,
        signal,
        lookup: (host, options, callback) =>
          dnsLookup(host, { ...options, all: true }, (error, addresses) => {
            if (error) return callback(error, '', 0);
            const list = (Array.isArray(addresses) ? addresses : [{ address: addresses as unknown as string, family: 4 }]) as Array<{ address: string; family: number }>;
            // A listed name allows whatever it resolves to; otherwise every address must be in a listed range.
            const bad = list.find((entry) => !viaName && !addressAllowed(allow, entry.address, port));
            if (bad) return callback(refusal(`${host} (${bad.address})`), '', 0);
            const first = list[0];
            if ((options as { all?: boolean }).all) return (callback as unknown as (e: null, a: unknown) => void)(null, list);
            callback(null, first.address, first.family);
          }),
      },
      (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_BYTES) {
            req.destroy();
            reject(new Failed('The response is larger than 10 MiB'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          try {
            resolve(decode(res, Buffer.concat(chunks)));
          } catch {
            reject(new Failed('The response could not be decoded'));
          }
        });
        res.on('error', (error) => reject(new Failed(error.message)));
      },
    );
    req.on('error', (error: Error & { code?: string }) => {
      if (error instanceof Refused) return reject(error);
      if (error.name === 'AbortError' || error.code === 'ABORT_ERR') return reject(signal.reason instanceof Failed ? signal.reason : new Failed('The request was aborted'));
      reject(new Failed(`${error.code ?? 'error'}: ${error.message}`));
    });
    req.end(request.body);
  });
}

/** The raw response with its body decoded; the encoding and length headers no longer describe it. */
function decode(res: IncomingMessage, raw: Buffer): Hop {
  const encoding = String(res.headers['content-encoding'] ?? '').toLowerCase();
  let body = raw;
  if (encoding === 'gzip' || encoding === 'x-gzip') body = gunzipSync(raw);
  else if (encoding === 'deflate') body = inflateSync(raw);
  else if (encoding === 'br') body = brotliDecompressSync(raw);
  if (body.length > MAX_BYTES) throw new Error('large');
  const headers: Array<[string, string]> = [];
  for (let i = 0; i < res.rawHeaders.length; i += 2) {
    const name = res.rawHeaders[i].toLowerCase();
    if (name === 'content-encoding' || name === 'content-length' || name === 'transfer-encoding') continue;
    headers.push([name, res.rawHeaders[i + 1]]);
  }
  return { status: res.statusCode ?? 0, headers, body };
}

/** Make one call and answer it; never throws (an error is an answer: `refused`, `timeout` or `network`). */
export async function performCall(call: CallInput, config: { allow: readonly AllowEntry[] }, log: (line: string) => void): Promise<RunnerAnswer> {
  const started = Date.now();
  let origin = '(invalid url)';
  const finish = (answer: RunnerAnswer): RunnerAnswer => {
    const outcome = 'status' in answer ? String(answer.status) : answer.error.code;
    log(`call ${call.id} ${call.method} ${origin} ${outcome} ${Date.now() - started}ms`);
    return answer;
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Failed('The request timed out', 'timeout')), Math.max(1, call.timeoutMs));
  try {
    let url = new URL(call.url);
    origin = url.origin;
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Failed('Only http and https URLs can be called');
    let method = call.method.toUpperCase();
    let headers = call.headers;
    let body = call.body ? Buffer.from(call.body, 'base64') : undefined;
    if (body && body.length > MAX_BYTES) throw new Failed('The request body is larger than 10 MiB');
    for (let hop = 0; ; hop++) {
      const result = await once(url, { method, headers, body }, config.allow, controller.signal);
      const location = result.headers.find(([name]) => name === 'location')?.[1];
      if (![301, 302, 303, 307, 308].includes(result.status) || !location) return finish({ status: result.status, headers: result.headers, ...(result.body.length && { body: result.body.toString('base64') }) });
      if (hop >= MAX_HOPS) throw new Failed('Too many redirects (more than 5)');
      const next = new URL(location, url);
      // A credential doesn't follow a redirect to another origin.
      if (next.origin !== url.origin) headers = headers.filter(([name]) => !['authorization', 'cookie', 'proxy-authorization'].includes(name.toLowerCase()));
      if (result.status === 303 || ((result.status === 301 || result.status === 302) && method === 'POST')) {
        method = method === 'HEAD' ? 'HEAD' : 'GET';
        body = undefined;
        headers = headers.filter(([name]) => !name.toLowerCase().startsWith('content-'));
      }
      url = next;
      origin = url.origin;
    }
  } catch (error) {
    if (error instanceof Refused) return finish({ error: { code: 'refused', message: error.message } });
    if (error instanceof Failed) return finish({ error: { code: error.code, message: error.message } });
    const reason = controller.signal.reason;
    if (controller.signal.aborted && reason instanceof Failed) return finish({ error: { code: reason.code, message: reason.message } });
    return finish({ error: { code: 'network', message: error instanceof Error ? error.message : 'The call failed' } });
  } finally {
    clearTimeout(timer);
  }
}
