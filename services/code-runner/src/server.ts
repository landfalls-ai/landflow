/**
 * The code runner's HTTP server (node:http, no framework): see protocol.ts for the routes.
 *
 * Every route but /health needs the shared secret. Runs are limited to `concurrency` at once with a short queue;
 * a client that hangs up cancels its run (the snippet's process group is killed).
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { loadConfig, type RunnerConfig, type RunnerOverrides } from './config';
import { describeIsolation, probeIsolation, type Isolation } from './isolation';
import { SECRET_HEADER, type RunnerInfo, type RunRequest } from './protocol';
import { runSnippet } from './sandbox';

export const VERSION = '0.1.0';

export interface CodeRunner {
  server: Server;
  config: RunnerConfig;
  isolation: Isolation;
  /** `http://host:port` once listening. */
  url: string;
  close(): Promise<void>;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function send(res: ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text), 'cache-control': 'no-store' });
  res.end(text);
}

const digest = (value: string) => createHash('sha256').update(value).digest();

function authorized(req: IncomingMessage, secret: string): boolean {
  const given = req.headers[SECRET_HEADER];
  return typeof given === 'string' && timingSafeEqual(digest(given), digest(secret));
}

async function readJson(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const declared = Number(req.headers['content-length']);
  if (declared > maxBytes) throw new HttpError(413, `Request body over ${maxBytes} bytes`);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) throw new HttpError(413, `Request body over ${maxBytes} bytes`);
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'The body is not JSON');
  }
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function parseRequest(body: unknown): RunRequest {
  if (!isObject(body)) throw new HttpError(400, 'The body must be a JSON object');
  const { language, mode, code, items, nodeOutputs, variables, execution, workflow, node, timezone, timeoutMs, binary, binarySkipped, maxBinaryBytes } = body;
  if (language !== 'javascript' && language !== 'python') throw new HttpError(400, '"language" must be "javascript" or "python"');
  if (mode !== 'all' && mode !== 'each') throw new HttpError(400, '"mode" must be "all" or "each"');
  if (typeof code !== 'string') throw new HttpError(400, '"code" must be a string');
  const itemList = (value: unknown, name: string) => {
    if (!Array.isArray(value) || !value.every((item) => isObject(item) && isObject(item.json))) throw new HttpError(400, `"${name}" must be a list of items ({ json: {…} })`);
    return value as RunRequest['items'];
  };
  if (nodeOutputs !== undefined && !isObject(nodeOutputs)) throw new HttpError(400, '"nodeOutputs" must be an object of item lists');
  if (variables !== undefined && !isObject(variables)) throw new HttpError(400, '"variables" must be an object');
  if (timeoutMs !== undefined && (typeof timeoutMs !== 'number' || timeoutMs <= 0)) throw new HttpError(400, '"timeoutMs" must be a positive number');
  const strings = (value: unknown, name: string) => {
    if (!isObject(value) || !Object.values(value).every((entry) => typeof entry === 'string')) throw new HttpError(400, `"${name}" must be an object of strings`);
    return value as Record<string, string>;
  };
  if (maxBinaryBytes !== undefined && (typeof maxBinaryBytes !== 'number' || maxBinaryBytes <= 0)) throw new HttpError(400, '"maxBinaryBytes" must be a positive number');
  return {
    language,
    mode,
    code,
    items: itemList(items, 'items'),
    ...(nodeOutputs !== undefined && { nodeOutputs: Object.fromEntries(Object.entries(nodeOutputs).map(([name, list]) => [name, itemList(list, `nodeOutputs.${name}`)])) }),
    ...(variables !== undefined && { variables: Object.fromEntries(Object.entries(variables).map(([key, value]) => [key, String(value)])) }),
    ...(isObject(execution) && { execution: { id: String(execution.id ?? ''), mode: String(execution.mode ?? '') } }),
    ...(isObject(workflow) && { workflow: { ...(workflow.id !== undefined && { id: String(workflow.id) }), ...(workflow.name !== undefined && { name: String(workflow.name) }) } }),
    ...(isObject(node) && typeof node.name === 'string' && { node: { name: node.name } }),
    ...(typeof timezone === 'string' && timezone && { timezone }),
    ...(typeof timeoutMs === 'number' && { timeoutMs }),
    ...(binary !== undefined && { binary: strings(binary, 'binary') }),
    ...(binarySkipped !== undefined && { binarySkipped: strings(binarySkipped, 'binarySkipped') }),
    ...(typeof maxBinaryBytes === 'number' && { maxBinaryBytes }),
  };
}

/** A counting semaphore with a bounded queue. */
function gate(concurrency: number, maxQueue: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  return {
    async enter(): Promise<() => void> {
      if (active >= concurrency) {
        if (queue.length >= maxQueue) throw new HttpError(503, 'The code runner is busy; try again shortly');
        await new Promise<void>((resolve) => queue.push(resolve));
      } else {
        active++;
      }
      let left = false;
      return () => {
        if (left) return;
        left = true;
        const next = queue.shift();
        if (next) next();
        else active--;
      };
    },
  };
}

/** Starts a runner. `overrides` replace settings from the environment (tests pass a secret, a port of 0, limits). */
export async function startCodeRunner(overrides: RunnerOverrides = {}, env: NodeJS.ProcessEnv = process.env): Promise<CodeRunner> {
  const config = loadConfig(env, overrides);
  const isolation = await probeIsolation(config);
  const slots = gate(config.concurrency, config.maxQueue);
  const info = (): RunnerInfo => ({
    version: VERSION,
    languages: { javascript: { version: isolation.node.version }, python: isolation.python ? { version: isolation.python.version } : null },
    limits: config.limits,
    isolation: describeIsolation(isolation, config),
  });

  const server = createServer(async (req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    try {
      if (req.method === 'GET' && path === '/health') return send(res, 200, { status: 'ok' });
      if (path !== '/v1/info' && path !== '/v1/run') throw new HttpError(404, 'Not found');
      if (!authorized(req, config.secret)) throw new HttpError(401, `Missing or wrong ${SECRET_HEADER} header`);
      if (path === '/v1/info') {
        if (req.method !== 'GET') throw new HttpError(405, 'Use GET');
        return send(res, 200, info());
      }
      if (req.method !== 'POST') throw new HttpError(405, 'Use POST');
      const request = parseRequest(await readJson(req, config.maxRequestBytes));
      const leave = await slots.enter();
      const abort = new AbortController();
      // The host gave up (its own timeout, a canceled execution): stop the snippet.
      const onClose = () => {
        if (!res.writableFinished) abort.abort();
      };
      res.once('close', onClose);
      try {
        send(res, 200, await runSnippet(request, { config, isolation }, abort.signal));
      } finally {
        res.off('close', onClose);
        leave();
      }
    } catch (error) {
      if (res.headersSent) return;
      if (error instanceof HttpError) return send(res, error.status, { error: error.message });
      console.error('[code-runner] request failed:', error);
      send(res, 500, { error: (error as Error).message });
    }
  });
  server.requestTimeout = config.limits.timeoutMs + 60_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  const host = config.host.includes(':') ? `[${config.host}]` : config.host === '0.0.0.0' ? '127.0.0.1' : config.host;
  return {
    server,
    config,
    isolation,
    url: `http://${host}:${port}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
