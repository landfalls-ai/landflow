/**
 * The standard descriptions of Landflow's plugins as MCP servers (docs/transports.md "Standard descriptions",
 * docs/protocol.md §15.4): a `server.json` per exposed plugin (the MCP Registry schema 2025-12-11: name
 * `<LANDFLOW_MCP_NAMESPACE, default local.landflow>/<pluginId>`, version = the plugin's, `remotes[]` = its URL on the
 * bundled gateway and its direct endpoint on this host, Landflow hints under `_meta["dev.landflow/plugin"]`), the
 * read-only registry API at /api/mcp/registry/v0.1/servers (the official API's v0.1 shapes: cursor pagination,
 * `/{name}/versions`, `/{name}/versions/{version|latest}`), and Server Cards (SEP-2127).
 *
 * The catalog is kept in `mcp_catalog_servers` (migration 1725), one row per plugin version ever exposed, refreshed
 * from the plugin registry on each read: a plugin that is online and exposed is `active`, offline or hidden
 * `deprecated`, gone from the registry `deleted`, and an older version of a plugin that moved on `deprecated`.
 * Whether a plugin is exposed to agents is stream T2-E's flag; until it lands every plugin with tools is exposed.
 */
import type { PluginSummary } from '../../shared/types';
import { mcpDb } from './db';
import { parse } from '../db/rows';
import { registry } from '../plugins/registry';
import { mcpExposure } from './exposure';
import { pluginTools } from './grants';
import { mcpResourceUrl, protectedResourceMetadataUrl, type McpCaller, listableTools } from './identity';
import { gatewayPublicUrl, instanceUrl } from './tokens';

export const SERVER_JSON_SCHEMA = 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json';
export const REGISTRY_META_KEY = 'io.modelcontextprotocol.registry/official';
export const LANDFLOW_META_KEY = 'dev.landflow/plugin';
export const DEFAULT_NAMESPACE = 'local.landflow';
/** The MCP revision the host's endpoints speak natively (stream T2-E's endpoints also answer 2025-11-25 clients). */
export const SERVER_CARD_PROTOCOL_VERSION = '2026-07-28';

export type CatalogStatus = 'active' | 'deprecated' | 'deleted';

/** LANDFLOW_MCP_NAMESPACE: reverse-DNS, `[a-z0-9.-]`, default `local.landflow`. */
export function mcpNamespace(): string {
  const configured = process.env.LANDFLOW_MCP_NAMESPACE?.trim().toLowerCase();
  return configured && /^[a-z0-9][a-z0-9.-]{0,199}$/.test(configured) ? configured : DEFAULT_NAMESPACE;
}

export const serverName = (pluginId: string) => `${mcpNamespace()}/${pluginId}`;

/** The plugin id of a registry name in this namespace, or undefined for another namespace. */
export function pluginIdOf(name: string): string | undefined {
  const prefix = `${mcpNamespace()}/`;
  return name.startsWith(prefix) && name.length > prefix.length ? name.slice(prefix.length) : undefined;
}

/** A plugin's URL on the bundled gateway (`/mcp/plugins/<id>`), when the gateway's public URL is configured. */
export function gatewayPluginUrl(pluginId: string): string | undefined {
  const gateway = gatewayPublicUrl();
  return gateway ? `${gateway}/mcp/plugins/${encodeURIComponent(pluginId)}` : undefined;
}

/** Whether the plugin's tools are offered to agents ("Expose to agents", stream T2-E's `mcpExposure`; on by default). */
export function pluginExposedToAgents(pluginId: string): boolean {
  return mcpExposure.isExposed(pluginId);
}

/** server.json, the MCP Registry schema 2025-12-11 (https://registry.modelcontextprotocol.io). */
export interface ServerJson {
  $schema: string;
  name: string;
  description: string;
  title?: string;
  version: string;
  websiteUrl?: string;
  remotes: Array<{ type: 'streamable-http' | 'sse'; url: string; headers?: Array<{ name: string; description?: string; isRequired?: boolean; isSecret?: boolean }> }>;
  _meta?: Record<string, unknown>;
}

/** One entry of the registry API: the server.json and the registry's own metadata. */
export interface ServerResponse {
  server: ServerJson;
  _meta: { [REGISTRY_META_KEY]: { status: CatalogStatus; publishedAt: string; updatedAt: string; isLatest: boolean } };
}

/** The registry schema caps `description` at 100 characters and wants at least one. */
function describe(plugin: PluginSummary): string {
  const text = (plugin.info.description ?? `The ${plugin.info.name} plugin of this Landflow instance, as MCP tools.`).replace(/\s+/g, ' ').trim();
  return text.length > 100 ? `${text.slice(0, 99).trimEnd()}…` : text || plugin.info.name;
}

/** The server.json of a plugin as it is right now. */
export function serverJsonFor(plugin: PluginSummary): ServerJson {
  const tools = pluginTools(plugin.id);
  const gateway = gatewayPluginUrl(plugin.id);
  const direct = mcpResourceUrl({ pluginId: plugin.id });
  const headers = [{ name: 'Authorization', description: 'Bearer: a Landflow MCP token, the identity provider’s access token, or a Landflow API key', isRequired: true, isSecret: true }];
  return {
    $schema: SERVER_JSON_SCHEMA,
    name: serverName(plugin.id),
    description: describe(plugin),
    title: plugin.info.name,
    version: plugin.info.version || '0.0.0',
    ...(plugin.info.homepage && /^https?:\/\//.test(plugin.info.homepage) && { websiteUrl: plugin.info.homepage }),
    remotes: [...(gateway ? [{ type: 'streamable-http' as const, url: gateway, headers }] : []), { type: 'streamable-http' as const, url: direct, headers }],
    _meta: {
      [LANDFLOW_META_KEY]: {
        pluginId: plugin.id,
        instance: instanceUrl(),
        language: plugin.info.language,
        transports: plugin.transports?.map((t) => t.kind) ?? [plugin.transport],
        health: plugin.status,
        exposed: pluginExposedToAgents(plugin.id),
        tools: tools.length,
        toolNames: tools.map((t) => t.name),
        serverCard: `${direct}/server-card`,
        protectedResourceMetadata: protectedResourceMetadataUrl({ pluginId: plugin.id }),
      },
    },
  };
}

// ---- the catalog table ---------------------------------------------------------------

interface CatalogRow {
  name: string;
  version: string;
  plugin_id: string;
  status: string;
  server_json: string;
  published_at: string;
  updated_at: string;
}

/** Plugins the catalog describes: registered, with at least one tool. */
function describedPlugins(): PluginSummary[] {
  return registry.list().filter((p) => pluginTools(p.id).length > 0);
}

/**
 * Bring the catalog in step with the plugin registry: upsert the current version of every described plugin, mark
 * older versions and the versions of plugins that are gone. Cheap enough to run on every registry read.
 */
export function syncCatalog(now = new Date()): void {
  const db = mcpDb();
  const stamp = now.toISOString();
  const rows = db.all<CatalogRow>('SELECT * FROM mcp_catalog_servers');
  const current = new Map<string, { plugin: PluginSummary; json: ServerJson }>();
  for (const plugin of describedPlugins()) {
    const json = serverJsonFor(plugin);
    current.set(`${json.name}@${json.version}`, { plugin, json });
  }
  db.transaction(() => {
    for (const { plugin, json } of current.values()) {
      const existing = rows.find((r) => r.name === json.name && r.version === json.version);
      const status: CatalogStatus = plugin.status === 'online' && pluginExposedToAgents(plugin.id) ? 'active' : 'deprecated';
      const unchanged = existing && existing.status === status && existing.server_json === JSON.stringify(json);
      if (unchanged) continue;
      db.upsert('mcp_catalog_servers', {
        name: json.name,
        version: json.version,
        plugin_id: plugin.id,
        status,
        server_json: JSON.stringify(json),
        published_at: existing?.published_at ?? stamp,
        updated_at: stamp,
      });
    }
    const livePlugins = new Set([...current.values()].map((c) => c.plugin.id));
    for (const row of rows) {
      if (current.has(`${row.name}@${row.version}`)) continue;
      const next: CatalogStatus = livePlugins.has(row.plugin_id) ? 'deprecated' : 'deleted';
      if (row.status !== next) db.upsert('mcp_catalog_servers', { ...row, status: next, updated_at: stamp });
    }
  });
}

function toResponse(row: CatalogRow, latest: Map<string, string>): ServerResponse {
  const server = parse<ServerJson>(row.server_json) ?? ({ $schema: SERVER_JSON_SCHEMA, name: row.name, description: row.plugin_id, version: row.version, remotes: [] } satisfies ServerJson);
  return {
    server,
    _meta: { [REGISTRY_META_KEY]: { status: row.status as CatalogStatus, publishedAt: row.published_at, updatedAt: row.updated_at, isLatest: latest.get(row.name) === row.version } },
  };
}

/** The newest non-deleted version per name (by publication time), else the newest of any status. */
function latestVersions(rows: CatalogRow[]): Map<string, string> {
  const latest = new Map<string, CatalogRow>();
  for (const row of rows) {
    const seen = latest.get(row.name);
    const better = !seen || (seen.status === 'deleted' && row.status !== 'deleted') || (seen.status === 'deleted') === (row.status === 'deleted') && row.published_at > seen.published_at;
    if (better) latest.set(row.name, row);
  }
  return new Map([...latest].map(([name, row]) => [name, row.version]));
}

export interface ListServersQuery {
  limit?: number;
  cursor?: string;
  /** Substring of the name (case-insensitive), as the official API's `search`. */
  search?: string;
  /** `latest`: only the latest version of each server (the official API's `version=latest`). */
  version?: string;
  /** ISO time: only entries updated after it. */
  updatedSince?: string;
}

export interface ListServersResult {
  servers: ServerResponse[];
  metadata: { count: number; nextCursor?: string };
}

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;

/** `GET /v0.1/servers`: every version of every server, cursor-paginated by name then version. */
export function listServers(query: ListServersQuery = {}): ListServersResult {
  syncCatalog();
  const rows = mcpDb().all<CatalogRow>('SELECT * FROM mcp_catalog_servers ORDER BY name, published_at, version');
  const latest = latestVersions(rows);
  const limit = Math.min(Math.max(1, Math.trunc(query.limit ?? DEFAULT_LIMIT) || DEFAULT_LIMIT), MAX_LIMIT);
  let filtered = rows;
  if (query.search) filtered = filtered.filter((r) => r.name.toLowerCase().includes(query.search!.toLowerCase()));
  if (query.version === 'latest') filtered = filtered.filter((r) => latest.get(r.name) === r.version);
  if (query.updatedSince) filtered = filtered.filter((r) => r.updated_at > query.updatedSince!);
  const keyOf = (r: CatalogRow) => `${r.name}@${r.version}`;
  const cursorKey = query.cursor ? decodeCursor(query.cursor) : undefined;
  if (cursorKey) {
    const at = filtered.findIndex((r) => keyOf(r) === cursorKey);
    filtered = at >= 0 ? filtered.slice(at + 1) : [];
  }
  const page = filtered.slice(0, limit);
  const next = filtered.length > limit ? encodeCursor(keyOf(page[page.length - 1])) : undefined;
  return { servers: page.map((r) => toResponse(r, latest)), metadata: { count: page.length, ...(next && { nextCursor: next }) } };
}

const encodeCursor = (key: string) => Buffer.from(key, 'utf8').toString('base64url');
const decodeCursor = (cursor: string) => {
  try {
    return Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    return undefined;
  }
};

/** `GET /v0.1/servers/{name}/versions`: every version of one server, newest first. */
export function listServerVersions(name: string): ListServersResult | undefined {
  syncCatalog();
  const rows = mcpDb().all<CatalogRow>('SELECT * FROM mcp_catalog_servers WHERE name = ? ORDER BY published_at DESC, version DESC', name);
  if (!rows.length) return undefined;
  const latest = latestVersions(rows);
  return { servers: rows.map((r) => toResponse(r, latest)), metadata: { count: rows.length } };
}

/** `GET /v0.1/servers/{name}/versions/{version}` (`latest` for the newest). */
export function getServerVersion(name: string, version: string): ServerResponse | undefined {
  syncCatalog();
  const rows = mcpDb().all<CatalogRow>('SELECT * FROM mcp_catalog_servers WHERE name = ?', name);
  if (!rows.length) return undefined;
  const latest = latestVersions(rows);
  const wanted = version === 'latest' ? latest.get(name) : version;
  const row = rows.find((r) => r.version === wanted);
  return row && toResponse(row, latest);
}

/** The server.json of a plugin right now (not from the catalog), for the Settings page and the Server Card. */
export function currentServerJson(pluginId: string): ServerJson | undefined {
  const plugin = registry.list().find((p) => p.id === pluginId);
  return plugin && pluginTools(pluginId).length ? serverJsonFor(plugin) : undefined;
}

// ---- Server Cards (SEP-2127) -----------------------------------------------------------

export const SERVER_CARD_SCHEMA = 'https://static.modelcontextprotocol.io/schemas/2026-07-28/server-card.schema.json';

/**
 * A plugin's Server Card, for clients that look before connecting: who it is, the transport, how to sign in, and the
 * tools `caller` would see (the card is served to the same callers as `tools/list`).
 */
export function serverCardFor(pluginId: string, caller: McpCaller): Record<string, unknown> | undefined {
  const json = currentServerJson(pluginId);
  if (!json) return undefined;
  const endpoint = gatewayPluginUrl(pluginId) ?? mcpResourceUrl({ pluginId });
  return {
    $schema: SERVER_CARD_SCHEMA,
    serverInfo: { name: json.name, title: json.title, version: json.version, description: json.description, ...(json.websiteUrl && { websiteUrl: json.websiteUrl }) },
    protocolVersion: SERVER_CARD_PROTOCOL_VERSION,
    capabilities: { tools: { listChanged: true } },
    transport: { type: 'streamable-http', endpoint, alternatives: json.remotes.map((r) => r.url).filter((url) => url !== endpoint) },
    authentication: { required: true, schemes: ['oauth2', 'bearer'], resourceMetadataUrl: protectedResourceMetadataUrl({ pluginId }) },
    tools: listableTools(caller, pluginId).map(({ tool }) => ({ name: tool.name, title: tool.title, description: tool.description, inputSchema: tool.inputSchema, ...(tool.outputSchema && { outputSchema: tool.outputSchema }), annotations: tool.annotations })),
    _meta: json._meta,
  };
}

/** The instance's Server Card (`/.well-known/mcp/server-card.json`): the gateway's `/mcp` when configured, else this host's MCP root. */
export function instanceServerCard(caller: McpCaller): Record<string, unknown> {
  const gateway = gatewayPublicUrl();
  const servers = describedPlugins().map((p) => ({ name: serverName(p.id), title: p.info.name, version: p.info.version, endpoint: gatewayPluginUrl(p.id) ?? mcpResourceUrl({ pluginId: p.id }), tools: listableTools(caller, p.id).length }));
  return {
    $schema: SERVER_CARD_SCHEMA,
    serverInfo: { name: `${mcpNamespace()}/landflow`, title: 'Landflow', version: process.env.LANDFLOW_VERSION ?? 'dev', description: 'Every plugin of this Landflow instance as MCP tools, through its MCP gateway.' },
    protocolVersion: SERVER_CARD_PROTOCOL_VERSION,
    capabilities: { tools: { listChanged: true } },
    transport: { type: 'streamable-http', endpoint: gateway ? `${gateway}/mcp` : mcpResourceUrl({}) },
    authentication: { required: true, schemes: ['oauth2', 'bearer'], resourceMetadataUrl: protectedResourceMetadataUrl({}) },
    registry: `${instanceUrl()}/api/mcp/registry/v0.1/servers`,
    servers,
  };
}
