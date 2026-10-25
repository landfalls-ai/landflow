/**
 * HTTP binding. `createFetchHandler` is a standard `(Request) => Response`
 * handler, mountable in any fetch-style runtime (Next.js route handlers, Bun,
 * Deno, Hono…); `serveHttp` adapts it to node:http for standalone plugins.
 *
 * Execute, LoadOptions and TestCredentials continue the caller's W3C trace
 * (`traceparent` / `tracestate` / `baggage` headers). `GET /metrics` serves
 * Prometheus text when the telemetry has a Prometheus reader.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import {
  executeRequestSchema,
  webhookMethodRequestSchema,
  webhookRequestSchema,
  HTTP_PATHS,
  PROTOCOL_VERSION,
  type HealthResponse,
  type JsonObject,
  type WellKnownDocument,
} from '@landflow/protocol';
import { findCredentialType, serveExecute, serveLoadOptions, serveTestCredentials, serveWebhook, serveWebhookMethod } from './handlers';
import { buildManifest, type IPlugin } from './node';
import { answerRegistryChallenge, REGISTRY_CHALLENGE_HEADER } from './registry-proof';
import { contextFromHeaders, getTelemetry, type Telemetry } from './otel';
import { findNode, toErrorPayload } from './runtime';

export const METRICS_PATH = '/metrics';

export interface FetchHandlerOptions {
  basePath?: string;
  /** Default: getTelemetry() at call time (what serve() installed, else passive). */
  telemetry?: Telemetry;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' },
  });

const isObject = (value: unknown): value is JsonObject => typeof value === 'object' && value !== null && !Array.isArray(value);

async function readJson(request: Request): Promise<{ ok: true; body: unknown } | { ok: false; response: Response }> {
  try {
    return { ok: true, body: await request.json() };
  } catch {
    return { ok: false, response: json(400, { error: 'Request body is not valid JSON' }) };
  }
}

export function createFetchHandler(plugin: IPlugin, options: FetchHandlerOptions = {}) {
  const startedAt = Date.now();
  const manifest = buildManifest(plugin);
  const base = options.basePath ?? '';
  const testable = (plugin.credentialTypes ?? []).some((type) => type.test);
  const appWebhooks = plugin.nodes.some((node) => node.description.triggerSource === 'appWebhook');

  return async function handle(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname.slice(base.length) || '/';
    const telemetry = options.telemetry ?? getTelemetry();

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

    if (request.method === 'GET' && path === HTTP_PATHS.health) {
      const health: HealthResponse = {
        status: 'ok',
        uptimeMs: Date.now() - startedAt,
        pluginId: plugin.info.id,
        version: plugin.info.version,
      };
      return json(200, health);
    }

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
      const node = findNode(plugin.nodes, plugin.info.id, parsed.data.node.type);
      if (!node) return json(404, { error: `Unknown node type "${parsed.data.node.type}"` });
      const parent = contextFromHeaders(telemetry, request.headers);
      return json(200, await serveExecute(plugin, node, parsed.data as never, telemetry, parent, 'http'));
    }

    if (request.method === 'POST' && path === HTTP_PATHS.loadOptions) {
      const read = await readJson(request);
      if (!read.ok) return read.response;
      const body = (isObject(read.body) ? read.body : {}) as { nodeType?: string; method?: string; parameters?: unknown; credentials?: unknown };
      if (typeof body.nodeType !== 'string' || typeof body.method !== 'string') return json(400, { error: 'nodeType and method are required' });
      const node = findNode(plugin.nodes, plugin.info.id, body.nodeType);
      if (!node) return json(404, { error: `Unknown node type "${body.nodeType}"` });
      const parent = contextFromHeaders(telemetry, request.headers);
      try {
        const loaded = await serveLoadOptions(
          plugin,
          node,
          {
            nodeType: body.nodeType,
            method: body.method,
            parameters: isObject(body.parameters) ? body.parameters : {},
            ...(isObject(body.credentials) && { credentials: body.credentials as Record<string, JsonObject> }),
          },
          telemetry,
          parent,
          'http',
        );
        return json(200, { options: loaded });
      } catch (error) {
        return json(400, { error: toErrorPayload(error).message });
      }
    }

    if (request.method === 'POST' && path === HTTP_PATHS.testCredentials) {
      const read = await readJson(request);
      if (!read.ok) return read.response;
      const body = (isObject(read.body) ? read.body : {}) as { credentialType?: unknown; data?: unknown };
      if (typeof body.credentialType !== 'string') return json(400, { error: 'credentialType is required' });
      if (!findCredentialType(plugin, body.credentialType)) return json(404, { error: `Unknown credential type "${body.credentialType}"` });
      const parent = contextFromHeaders(telemetry, request.headers);
      const data = isObject(body.data) ? body.data : {};
      return json(200, await serveTestCredentials(plugin, { credentialType: body.credentialType, data }, telemetry, parent, 'http'));
    }

    if (request.method === 'POST' && (path === HTTP_PATHS.webhookMethod || path === HTTP_PATHS.webhook)) {
      const read = await readJson(request);
      if (!read.ok) return read.response;
      const parsed = (path === HTTP_PATHS.webhook ? webhookRequestSchema : webhookMethodRequestSchema).safeParse(read.body);
      if (!parsed.success) return json(400, { error: path === HTTP_PATHS.webhook ? 'Invalid WebhookRequest' : 'Invalid WebhookMethodRequest', issues: parsed.error.issues });
      const node = findNode(plugin.nodes, plugin.info.id, parsed.data.node.type);
      if (!node) return json(404, { error: `Unknown node type "${parsed.data.node.type}"` });
      const parent = contextFromHeaders(telemetry, request.headers);
      if (path === HTTP_PATHS.webhook) return json(200, await serveWebhook(plugin, node, parsed.data as never, telemetry, parent, 'http'));
      return json(200, await serveWebhookMethod(plugin, node, parsed.data as never, telemetry, parent, 'http'));
    }

    return json(404, { error: `No route for ${request.method} ${path}` });
  };
}

async function toFetchRequest(req: IncomingMessage, origin: string): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) value.forEach((v) => headers.append(key, v));
    else if (value !== undefined) headers.set(key, value);
  }
  return new Request(new URL(req.url ?? '/', origin), {
    method: req.method,
    headers,
    body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
  });
}

export function serveHttp(plugin: IPlugin, options: { port: number; host?: string; telemetry?: Telemetry }): Promise<Server> {
  const handle = createFetchHandler(plugin, { telemetry: options.telemetry });
  const host = options.host ?? '0.0.0.0';
  const server = createServer(async (req, res) => {
    try {
      const response = await handle(await toFetchRequest(req, `http://${req.headers.host ?? 'localhost'}`));
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      (options.telemetry ?? getTelemetry()).logger.error('HTTP handler failed', { error, 'url.path': req.url?.split('?')[0] });
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: (error as Error).message }));
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, host, () => resolve(server));
  });
}
