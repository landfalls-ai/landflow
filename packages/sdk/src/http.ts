/**
 * HTTP binding. `createFetchHandler` is a standard `(Request) => Response`
 * handler, mountable in any fetch-style runtime (Next.js route handlers, Bun,
 * Deno, Hono…); `serveHttp` adapts it to node:http for standalone plugins, and
 * `httpBinding()` wraps that as a `TransportBinding` for `serve()`.
 *
 * Execute, LoadOptions and TestCredentials continue the caller's W3C trace
 * (`traceparent` / `tracestate` / `baggage` headers). A deadline comes in
 * `x-landflow-deadline` (epoch ms); a closed connection cancels the call.
 * `GET /metrics` serves Prometheus text when the telemetry has a Prometheus reader.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  executeRequestSchema,
  webhookMethodRequestSchema,
  webhookRequestSchema,
  HTTP_PATHS,
  PROTOCOL_VERSION,
  type JsonObject,
  type WellKnownDocument,
} from '@landflow/protocol';
import type { BindingContext, BindingInfo, TransportBinding } from './binding';
import { createDispatcher, DispatchError, type DispatchCall, type Dispatcher } from './dispatcher';
import type { IPlugin } from './node';
import { answerRegistryChallenge, REGISTRY_CHALLENGE_HEADER } from './registry-proof';
import { contextFromHeaders, getTelemetry, type Telemetry } from './otel';
import { toErrorPayload } from './runtime';

export const METRICS_PATH = '/metrics';
/** Request header: epoch ms after which the call must not run. Absent: no deadline. */
export const DEADLINE_HEADER = 'x-landflow-deadline';

export interface FetchHandlerOptions {
  basePath?: string;
  /** Default: getTelemetry() at call time (what serve() installed, else passive). */
  telemetry?: Telemetry;
  /** Share one dispatcher (and its concurrency limit) with other bindings; default: a private one over `telemetry`. */
  dispatcher?: Dispatcher;
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', ...headers },
  });

const isObject = (value: unknown): value is JsonObject => typeof value === 'object' && value !== null && !Array.isArray(value);

async function readJson(request: Request): Promise<{ ok: true; body: unknown } | { ok: false; response: Response }> {
  try {
    return { ok: true, body: await request.json() };
  } catch {
    return { ok: false, response: json(400, { error: 'Request body is not valid JSON' }) };
  }
}

/** HTTP status for a refused or stopped call. 499 is nginx's "client closed request"; nothing standard fits better. */
export function dispatchErrorStatus(error: DispatchError): number {
  switch (error.code) {
    case 'unknown_node':
    case 'unknown_credential_type':
      return 404;
    case 'deadline_exceeded':
      return 504;
    case 'canceled':
      return 499;
    case 'capacity':
      return 429;
  }
}

const dispatchErrorResponse = (error: DispatchError) => json(dispatchErrorStatus(error), { error: error.message, code: error.code }, error.code === 'capacity' ? { 'retry-after': '1' } : {});

/** The per-call facts from the request: trace context, deadline header, the request's abort signal. */
function callFrom(request: Request, telemetry: Telemetry): DispatchCall {
  const header = request.headers.get(DEADLINE_HEADER);
  const deadline = header ? Number(header) : NaN;
  return {
    transport: 'http',
    parent: contextFromHeaders(telemetry, request.headers),
    ...(Number.isFinite(deadline) && deadline > 0 && { deadline }),
    ...(request.signal && { signal: request.signal }),
  };
}

export function createFetchHandler(plugin: IPlugin, options: FetchHandlerOptions = {}) {
  const dispatcher = options.dispatcher ?? createDispatcher(plugin, { telemetry: options.telemetry });
  const { manifest } = dispatcher;
  const base = options.basePath ?? '';
  const testable = (plugin.credentialTypes ?? []).some((type) => type.test);
  const appWebhooks = plugin.nodes.some((node) => node.description.triggerSource === 'appWebhook');

  return async function handle(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname.slice(base.length) || '/';
    const telemetry = options.telemetry ?? (options.dispatcher ? dispatcher.telemetry : getTelemetry());

    if (request.method === 'GET' && path === HTTP_PATHS.wellKnown) {
      const doc: WellKnownDocument = {
        protocol: PROTOCOL_VERSION,
        plugin: {
          id: plugin.info.id,
          name: plugin.info.name,
          version: plugin.info.version,
          language: plugin.info.language,
        },
        endpoints: {
          manifest: HTTP_PATHS.manifest,
          execute: HTTP_PATHS.execute,
          loadOptions: HTTP_PATHS.loadOptions,
          health: HTTP_PATHS.health,
          ...(testable && { testCredentials: HTTP_PATHS.testCredentials }),
          ...(appWebhooks && { webhookMethod: HTTP_PATHS.webhookMethod, webhook: HTTP_PATHS.webhook }),
        },
      };
      return json(200, doc);
    }

    if (request.method === 'GET' && path === HTTP_PATHS.manifest) {
      // Kubernetes discovery: prove LANDFLOW_REGISTRY_SECRET when the host sends a challenge (registry-proof.ts).
      const response = json(200, manifest);
      for (const [name, value] of Object.entries(answerRegistryChallenge(plugin.info.id, request.headers.get(REGISTRY_CHALLENGE_HEADER)))) response.headers.set(name, value);
      return response;
    }

    if (request.method === 'GET' && path === HTTP_PATHS.health) return json(200, dispatcher.health());

    if (request.method === 'GET' && path === METRICS_PATH) {
      const text = await telemetry.scrapeMetrics();
      if (text === undefined) return json(404, { error: 'Prometheus metrics are not enabled (LANDFLOW_METRICS_PROMETHEUS, OTEL_SDK_DISABLED)' });
      return new Response(text, { status: 200, headers: { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' } });
    }

    if (request.method === 'POST' && path === HTTP_PATHS.execute) {
      const read = await readJson(request);
      if (!read.ok) return read.response;
      const parsed = executeRequestSchema.safeParse(read.body);
      if (!parsed.success) return json(400, { error: 'Invalid ExecuteRequest', issues: parsed.error.issues });
      try {
        return json(200, await dispatcher.execute(parsed.data as never, callFrom(request, telemetry)));
      } catch (error) {
        if (error instanceof DispatchError) return dispatchErrorResponse(error);
        throw error;
      }
    }

    if (request.method === 'POST' && path === HTTP_PATHS.loadOptions) {
      const read = await readJson(request);
      if (!read.ok) return read.response;
      const body = (isObject(read.body) ? read.body : {}) as { nodeType?: string; method?: string; parameters?: unknown; credentials?: unknown };
      if (typeof body.nodeType !== 'string' || typeof body.method !== 'string') return json(400, { error: 'nodeType and method are required' });
      try {
        const loaded = await dispatcher.loadOptions(
          {
            nodeType: body.nodeType,
            method: body.method,
            parameters: isObject(body.parameters) ? body.parameters : {},
            ...(isObject(body.credentials) && { credentials: body.credentials as Record<string, JsonObject> }),
          },
          callFrom(request, telemetry),
        );
        return json(200, { options: loaded });
      } catch (error) {
        if (error instanceof DispatchError) return dispatchErrorResponse(error);
        return json(400, { error: toErrorPayload(error).message });
      }
    }

    if (request.method === 'POST' && path === HTTP_PATHS.testCredentials) {
      const read = await readJson(request);
      if (!read.ok) return read.response;
      const body = (isObject(read.body) ? read.body : {}) as { credentialType?: unknown; data?: unknown };
      if (typeof body.credentialType !== 'string') return json(400, { error: 'credentialType is required' });
      const data = isObject(body.data) ? body.data : {};
      try {
        return json(200, await dispatcher.testCredentials({ credentialType: body.credentialType, data }, callFrom(request, telemetry)));
      } catch (error) {
        if (error instanceof DispatchError) return dispatchErrorResponse(error);
        throw error;
      }
    }

    if (request.method === 'POST' && (path === HTTP_PATHS.webhookMethod || path === HTTP_PATHS.webhook)) {
      const read = await readJson(request);
      if (!read.ok) return read.response;
      const parsed = (path === HTTP_PATHS.webhook ? webhookRequestSchema : webhookMethodRequestSchema).safeParse(read.body);
      if (!parsed.success) return json(400, { error: path === HTTP_PATHS.webhook ? 'Invalid WebhookRequest' : 'Invalid WebhookMethodRequest', issues: parsed.error.issues });
      try {
        const call = callFrom(request, telemetry);
        if (path === HTTP_PATHS.webhook) return json(200, await dispatcher.webhook(parsed.data as never, call));
        return json(200, await dispatcher.webhookMethod(parsed.data as never, call));
      } catch (error) {
        if (error instanceof DispatchError) return dispatchErrorResponse(error);
        throw error;
      }
    }

    return json(404, { error: `No route for ${request.method} ${path}` });
  };
}

/** A fetch Request for a node:http request; `signal` aborts when the connection closes before the response is sent. */
async function toFetchRequest(req: IncomingMessage, res: ServerResponse, origin: string): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) value.forEach((v) => headers.append(key, v));
    else if (value !== undefined) headers.set(key, value);
  }
  const controller = new AbortController();
  res.once('close', () => {
    if (!res.writableFinished) controller.abort(new DispatchError('canceled', 'The client closed the connection'));
  });
  return new Request(new URL(req.url ?? '/', origin), {
    method: req.method,
    headers,
    body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
    signal: controller.signal,
  });
}

export interface ServeHttpOptions {
  port: number;
  /** Default 0.0.0.0. */
  host?: string;
  telemetry?: Telemetry;
  dispatcher?: Dispatcher;
  basePath?: string;
}

export function serveHttp(plugin: IPlugin, options: ServeHttpOptions): Promise<Server> {
  const handle = createFetchHandler(plugin, { telemetry: options.telemetry, dispatcher: options.dispatcher, basePath: options.basePath });
  const host = options.host ?? '0.0.0.0';
  const server = createServer(async (req, res) => {
    try {
      const response = await handle(await toFetchRequest(req, res, `http://${req.headers.host ?? 'localhost'}`));
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      (options.telemetry ?? options.dispatcher?.telemetry ?? getTelemetry()).logger.error('HTTP handler failed', { error, 'url.path': req.url?.split('?')[0] });
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: (error as Error).message }));
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, host, () => resolve(server));
  });
}

export interface HttpBindingOptions {
  port: number;
  /** Default 0.0.0.0. */
  host?: string;
  basePath?: string;
}

/** The HTTP face as a `TransportBinding`: `serve()` builds one from `{ http: port }`. Announces `http://<advertiseHost>:<port>`. */
export function httpBinding(options: HttpBindingOptions): TransportBinding {
  let server: Server | undefined;
  let dispatcher: Dispatcher | undefined;
  return {
    kind: 'http',
    async start(context: BindingContext): Promise<BindingInfo> {
      dispatcher = context.dispatcher;
      server = await serveHttp(context.plugin, { port: options.port, host: options.host, basePath: options.basePath, dispatcher, telemetry: context.telemetry });
      return { endpoints: [`http://${context.advertiseHost}:${options.port}`], description: `HTTP listening on :${options.port}` };
    },
    async stop() {
      const running = server;
      server = undefined;
      if (!running) return;
      // Stop accepting, let the calls in flight finish (server.close waits for open connections), then close.
      await new Promise<void>((resolve) => running.close(() => resolve()));
      await dispatcher?.drain();
    },
  };
}
