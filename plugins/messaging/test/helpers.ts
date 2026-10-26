/** Fake external APIs and request builders. Fake tokens only; nothing here talks to a real service. */
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { runLoadOptions, runNode, runTestCredentials, type ExecuteRequest, type ExecuteResponse, type INodeType, type JsonObject } from '@landflow/sdk';
import { plugin } from '../src/main';

export interface FakeRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingHttpHeaders;
  /** Parsed JSON body (undefined when empty or not JSON). */
  body: any;
  /** The body as sent (multipart uploads). */
  raw: Buffer;
}

export interface FakeReply {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export type Handler = (request: FakeRequest) => FakeReply | Promise<FakeReply>;

export interface FakeApi {
  url: string;
  requests: FakeRequest[];
  /** Swap the route handler between tests. */
  handle(handler: Handler): void;
  close(): Promise<void>;
}

/** An in-process HTTP server that records every request and answers through the current handler. */
export async function startFakeApi(initial: Handler = () => ({ status: 404, body: { error: 'no handler' } })): Promise<FakeApi> {
  let handler = initial;
  const requests: FakeRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', async () => {
      const url = new URL(req.url ?? '/', 'http://fake');
      const raw = Buffer.concat(chunks);
      const text = raw.toString('utf8');
      let body: unknown;
      try {
        body = text ? JSON.parse(text) : undefined;
      } catch {
        body = undefined;
      }
      const request: FakeRequest = { method: req.method ?? 'GET', path: url.pathname, query: url.searchParams, headers: req.headers, body, raw };
      requests.push(request);
      try {
        const reply = await handler(request);
        const status = reply.status ?? 200;
        res.writeHead(status, { 'content-type': 'application/json', ...reply.headers });
        res.end(reply.body === undefined ? '' : typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body));
      } catch (error) {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end(String(error));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    handle: (next) => (handler = next),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

export interface RequestOptions {
  credentials?: Record<string, JsonObject>;
  /** Input items (default: one empty item). */
  items?: JsonObject[];
  /** Per-item parameter overrides, merged over `parameters`. */
  perItem?: JsonObject[];
  mode?: ExecuteRequest['mode'];
  pollState?: JsonObject;
  continueOnFail?: boolean;
  /** The call's abort signal and deadline (epoch ms), as a binding would pass them. */
  signal?: AbortSignal;
  deadline?: number;
}

export function executeRequest(type: string, parameters: JsonObject, options: RequestOptions = {}): ExecuteRequest {
  const items = options.items ?? [{}];
  return {
    protocol: 'landflow.plugin/v1',
    executionId: 'ex_test',
    workflowId: 'wf_test',
    mode: options.mode ?? 'manual',
    node: { id: 'n1', name: 'Node', type: `messaging.${type}`, typeVersion: 1 },
    parameters,
    itemParameters: items.map((_, i) => ({ ...parameters, ...(options.perItem?.[i] ?? {}) })),
    inputs: [items.map((json) => ({ json }))],
    ...(options.credentials && { credentials: options.credentials }),
    ...(options.pollState && { pollState: options.pollState }),
    ...(options.continueOnFail && { continueOnFail: true }),
  };
}

const extras = { credentialTypes: plugin.credentialTypes, pluginId: 'messaging' };

export function run(node: INodeType, parameters: JsonObject, options: RequestOptions = {}): Promise<ExecuteResponse> {
  return runNode(node, executeRequest(node.description.name, parameters, options), { ...extras, ...(options.signal && { signal: options.signal }), ...(options.deadline && { deadline: options.deadline }) });
}

export function loadOptions(node: INodeType, method: string, parameters: JsonObject, credentials: Record<string, JsonObject>) {
  return runLoadOptions(node, method, parameters, credentials, extras);
}

export function testCredentials(credentialType: string, data: JsonObject) {
  return runTestCredentials(plugin, { credentialType, data });
}

/** The JSON of every item on output 0. */
export const jsonOf = (response: ExecuteResponse) => response.outputs[0].map((item) => item.json);
