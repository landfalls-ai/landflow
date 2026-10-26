/**
 * How `McpGatewaySync` (./gateway-sync.ts) writes into the bundled MCP gateway (docs/transports.md "Swapping the
 * gateway", docs/mcp-gateway.md for the verified payloads). Two adapters:
 *
 * - **`agentgateway`**: the config API on the admin port (`LANDFLOW_MCP_GATEWAY_ADMIN_URL`, default
 *   http://127.0.0.1:55000, loopback only; storage mode `hybrid`). Targets are `mcp.target` resources
 *   (`PUT /api/config/resources/mcp.target` with `{ resources: [{ value }] }` is an upsert, the id is the name;
 *   `DELETE …/mcp.target/<name>`), per-plugin routes are `traffic.route` resources (an HTTP route whose backend is an
 *   inline MCP server with one target, or a plain reverse proxy for a Server Card). A change is on the traffic path
 *   within milliseconds.
 * - **`file`**: a gateway Landflow doesn't run reads its whole config from one YAML file it watches
 *   (`LANDFLOW_MCP_GATEWAY_FILE`, storage mode `file`). The file is write-only for the sync (`GET` lists nothing in
 *   that mode), so `replaceAll()` re-renders Landflow's targets and routes into it on every change, keeping everything
 *   else in the file (the listener, sign-in, targets an operator added by hand, comments).
 *
 * Both only ever touch resources whose names the sync owns (./gateway-sync.ts keeps them in `mcp_gateway_resources`).
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { isMap, isSeq, parseDocument, YAMLMap, YAMLSeq, type Document } from 'yaml';

/** One `mcp.target` as agentgateway stores it (docs/mcp-gateway.md "The config API"). */
export interface GatewayTargetValue {
  name: string;
  mcp: { host: string };
  policies?: Record<string, unknown>;
  [key: string]: unknown;
}

/** One `traffic.route` (agentgateway's `LocalAttachedRoute`): a path on the gateway's listener and what answers it. */
export interface GatewayRouteValue {
  name: string;
  gateways?: string | string[];
  matches: Array<{ path: { exact: string } | { pathPrefix: string } | { regex: string }; method?: string }>;
  policies?: Record<string, unknown>;
  backends: Array<Record<string, unknown>>;
}

/** A target the sync wants in the gateway, with the plugin it stands for. */
export interface GatewayTarget {
  name: string;
  pluginId: string;
  value: GatewayTargetValue;
}

export interface GatewayRoute {
  name: string;
  pluginId: string;
  value: GatewayRouteValue;
}

export interface GatewayHealth {
  ok: boolean;
  version?: string;
  message?: string;
}

/**
 * What a gateway must offer to be kept in step (docs/transports.md "Swapping the gateway"). `list()` returns every
 * target the gateway has (the sync picks its own by name); a write-only gateway returns `undefined` and gets
 * `replaceAll()` instead. Routes are optional: a gateway without per-plugin paths serves everything on `/mcp`.
 */
export interface McpGatewayAdapter {
  readonly kind: string;
  /** Where the adapter writes, for the status view (an admin URL, a file path). */
  readonly location: string;
  health(): Promise<GatewayHealth>;
  /** The targets in the gateway now, or `undefined` when it cannot be read back (file mode). */
  list(): Promise<GatewayTargetValue[] | undefined>;
  upsert(target: GatewayTarget): Promise<void>;
  remove(name: string): Promise<void>;
  listRoutes?(): Promise<GatewayRouteValue[] | undefined>;
  upsertRoute?(route: GatewayRoute): Promise<void>;
  removeRoute?(name: string): Promise<void>;
  /**
   * Write-only gateways: render this whole set (Landflow's part of the config) in one go. `ownedTargetNames` are the
   * targets the sync wrote before (persisted across restarts), so a stale one in the file is replaced, not kept.
   */
  replaceAll?(targets: GatewayTarget[], routes: GatewayRoute[], ownedTargetNames?: Iterable<string>): Promise<void>;
}

export class GatewayAdapterError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// agentgateway's config API
// ---------------------------------------------------------------------------

export const DEFAULT_ADMIN_URL = 'http://127.0.0.1:55000';
const TARGET_KIND = 'mcp.target';
const ROUTE_KIND = 'traffic.route';
const REQUEST_TIMEOUT_MS = 5_000;

interface ResourceRecord<T> {
  kind: string;
  id: string;
  value: T;
  revision?: number;
}

export interface AgentgatewayAdapterOptions {
  adminUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class AgentgatewayAdapter implements McpGatewayAdapter {
  readonly kind = 'agentgateway';
  readonly location: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: AgentgatewayAdapterOptions = {}) {
    this.location = (options.adminUrl ?? process.env.LANDFLOW_MCP_GATEWAY_ADMIN_URL?.trim() ?? DEFAULT_ADMIN_URL).replace(/\/+$/, '') || DEFAULT_ADMIN_URL;
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<{ status: number; json: T | undefined; text: string }> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.location}${path}`, {
        method,
        headers: { accept: 'application/json', ...(body !== undefined && { 'content-type': 'application/json' }) },
        ...(body !== undefined && { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new GatewayAdapterError(`The gateway's admin API at ${this.location} is unreachable: ${(error as Error).message}`);
    }
    const text = await response.text();
    let json: T | undefined;
    try {
      json = text ? (JSON.parse(text) as T) : undefined;
    } catch {
      json = undefined;
    }
    return { status: response.status, json, text };
  }

  private async listKind<T>(kind: string): Promise<T[]> {
    const r = await this.call<{ resources?: ResourceRecord<T>[] }>('GET', `/api/config/resources/${kind}`);
    if (r.status !== 200) throw new GatewayAdapterError(`Listing ${kind} answered ${r.status}: ${r.text.slice(0, 200)}`, r.status);
    return (r.json?.resources ?? []).map((record) => record.value);
  }

  private async putKind(kind: string, value: unknown): Promise<void> {
    const r = await this.call('PUT', `/api/config/resources/${kind}`, { resources: [{ value }] });
    if (r.status !== 200) throw new GatewayAdapterError(`Writing ${kind} answered ${r.status}: ${r.text.slice(0, 300)}`, r.status);
  }

  private async deleteKind(kind: string, name: string): Promise<void> {
    const r = await this.call('DELETE', `/api/config/resources/${kind}/${encodeURIComponent(name)}`);
    // 404: already gone, which is what we wanted.
    if (r.status !== 200 && r.status !== 404) throw new GatewayAdapterError(`Deleting ${kind} ${name} answered ${r.status}: ${r.text.slice(0, 200)}`, r.status);
  }

  /** The admin API answering its own resource listing is the health signal; 1.6.0 has no version endpoint (`/api/version` is empty or 404). */
  async health(): Promise<GatewayHealth> {
    try {
      const r = await this.call<{ resources?: unknown[] }>('GET', `/api/config/resources/${TARGET_KIND}`);
      if (r.status !== 200) return { ok: false, message: `admin API answered ${r.status}` };
      const version = await this.call<{ version?: string } | string>('GET', '/api/version').catch(() => undefined);
      const text = version && version.status === 200 ? (typeof version.json === 'string' ? version.json : version.json?.version) || version.text.trim() : '';
      return { ok: true, ...(text && { version: text.slice(0, 40) }) };
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
  }

  list(): Promise<GatewayTargetValue[]> {
    return this.listKind<GatewayTargetValue>(TARGET_KIND);
  }

  upsert(target: GatewayTarget): Promise<void> {
    return this.putKind(TARGET_KIND, target.value);
  }

  remove(name: string): Promise<void> {
    return this.deleteKind(TARGET_KIND, name);
  }

  listRoutes(): Promise<GatewayRouteValue[]> {
    return this.listKind<GatewayRouteValue>(ROUTE_KIND);
  }

  upsertRoute(route: GatewayRoute): Promise<void> {
    return this.putKind(ROUTE_KIND, route.value);
  }

  removeRoute(name: string): Promise<void> {
    return this.deleteKind(ROUTE_KIND, name);
  }
}

// ---------------------------------------------------------------------------
// The file fallback
// ---------------------------------------------------------------------------

export interface FileGatewayAdapterOptions {
  path: string;
  /** Names of routes the sync owns start with this; other routes in the file are kept (default `landflow-`). */
  ownedRoutePrefix?: string;
}

/**
 * Landflow's targets and routes rendered into the gateway's config file. The file is parsed as a YAML document (comments
 * and the rest of the config survive), `mcp.targets` gets Landflow's targets after any other target in the file, and
 * `routes` gets Landflow's routes after any route whose name doesn't carry the owned prefix. The write is atomic
 * (a temporary file renamed over the original), so the gateway never reads a half-written config. A missing file
 * starts from a minimal config with a `default` gateway on port 4000.
 */
export class FileGatewayAdapter implements McpGatewayAdapter {
  readonly kind = 'file';
  readonly location: string;
  private readonly ownedRoutePrefix: string;
  /** What was last written, so `list()` can describe the file's Landflow part without reading the gateway. */
  private written: { targets: GatewayTarget[]; routes: GatewayRoute[] } = { targets: [], routes: [] };

  constructor(options: FileGatewayAdapterOptions) {
    this.location = options.path;
    this.ownedRoutePrefix = options.ownedRoutePrefix ?? 'landflow-';
  }

  async health(): Promise<GatewayHealth> {
    try {
      this.document();
      return { ok: true };
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
  }

  /** The file can't be read back from the gateway: `undefined` tells the sync to render everything. */
  async list(): Promise<undefined> {
    return undefined;
  }

  async upsert(target: GatewayTarget): Promise<void> {
    await this.replaceAll([...this.written.targets.filter((t) => t.name !== target.name), target], this.written.routes);
  }

  async remove(name: string): Promise<void> {
    await this.replaceAll(
      this.written.targets.filter((t) => t.name !== name),
      this.written.routes,
    );
  }

  async upsertRoute(route: GatewayRoute): Promise<void> {
    await this.replaceAll(this.written.targets, [...this.written.routes.filter((r) => r.name !== route.name), route]);
  }

  async removeRoute(name: string): Promise<void> {
    await this.replaceAll(
      this.written.targets,
      this.written.routes.filter((r) => r.name !== name),
    );
  }

  private document(): Document {
    let text: string;
    try {
      text = readFileSync(this.location, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      text = ['# agentgateway config written by Landflow (LANDFLOW_MCP_GATEWAY=file): mcp.targets and the landflow-* routes are', '# rewritten on every change; everything else here is kept.', 'config:', '  storage:', '    mode: file', 'gateways:', '  default:', '    port: 4000', 'mcp:', '  gateways: default', '  prefixMode: always', '  failureMode: failOpen', '  statefulMode: stateless', '  targets: []', ''].join('\n');
    }
    const doc = parseDocument(text);
    if (doc.errors.length) throw new Error(`${this.location} is not valid YAML: ${doc.errors[0].message}`);
    return doc;
  }

  /** Render the whole Landflow part: the file is the source of truth for everything else. */
  async replaceAll(targets: GatewayTarget[], routes: GatewayRoute[], ownedTargetNames: Iterable<string> = []): Promise<void> {
    const doc = this.document();
    if (!isMap(doc.contents)) doc.contents = new YAMLMap();
    const ownNames = new Set(targets.map((t) => t.name));
    const previous = new Set([...this.written.targets.map((t) => t.name), ...ownedTargetNames]);
    const mcp = ensureMap(doc, ['mcp']);
    const existingTargets = mcp.get('targets');
    const keptTargets = isSeq(existingTargets) ? existingTargets.items.filter((item) => !isMap(item) || !isOwnedTarget(String(item.get('name') ?? ''), ownNames, previous)) : [];
    const targetSeq = new YAMLSeq();
    targetSeq.items = [...keptTargets, ...targets.map((t) => doc.createNode(t.value))];
    mcp.set('targets', targetSeq);

    const existingRoutes = doc.get('routes');
    const keptRoutes = isSeq(existingRoutes) ? existingRoutes.items.filter((item) => !isMap(item) || !String(item.get('name') ?? '').startsWith(this.ownedRoutePrefix)) : [];
    if (keptRoutes.length || routes.length) {
      const routeSeq = new YAMLSeq();
      routeSeq.items = [...keptRoutes, ...routes.map((r) => doc.createNode(r.value))];
      doc.set('routes', routeSeq);
    } else if (existingRoutes !== undefined) {
      doc.delete('routes');
    }

    mkdirSync(dirname(this.location), { recursive: true });
    const tmp = `${this.location}.${process.pid}.tmp`;
    writeFileSync(tmp, doc.toString({ lineWidth: 0 }), 'utf8');
    renameSync(tmp, this.location);
    this.written = { targets: [...targets], routes: [...routes] };
  }

  /** What this adapter last wrote (the status view). */
  snapshot(): { targets: GatewayTarget[]; routes: GatewayRoute[] } {
    return { targets: [...this.written.targets], routes: [...this.written.routes] };
  }
}

/** A target in the file is Landflow's when the sync writes it now or wrote it before (names the sync owns). */
function isOwnedTarget(name: string, own: Set<string>, previous: Set<string>): boolean {
  return own.has(name) || previous.has(name);
}

function ensureMap(doc: Document, path: string[]): YAMLMap {
  let node = doc.contents as YAMLMap;
  for (const key of path) {
    let next = node.get(key);
    if (!isMap(next)) {
      next = new YAMLMap();
      node.set(key, next);
    }
    node = next as YAMLMap;
  }
  return node;
}
