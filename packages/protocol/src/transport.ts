/**
 * Transport kinds and endpoint schemes (docs/protocol.md §14, docs/transports.md "Concepts").
 *
 * A plugin is reached either *directly* (the host connects to it: `http://`, `https://`, `grpc://` URLs) or through a
 * *broker* both sides connect out to. Brokered endpoints are logical, `<kind>://<connectionId>/<pluginId>`
 * (`kafka://kafka-main/twilio`): the connection id names a broker connection configured on the host, so an endpoint
 * never carries hosts or passwords. The kind is an open string: the known kinds are constants here, but a host and a
 * plugin that both know a kind this file doesn't can still use it (spans and metrics carry whatever kind it is).
 */

/** Direct transports: the host opens a connection to the plugin. */
export const DIRECT_TRANSPORT_KINDS = ['http', 'grpc'] as const;

/** Tier 1 brokers land first; tier 2 follows driver by driver (docs/transports.md "Brokers"). */
export const BROKER_TRANSPORT_KINDS = ['kafka', 'amqp', 'nats', 'valkey', 'mqtt', 'sqs', 'pubsub', 'servicebus', 'amqp1', 'pulsar'] as const;

/** Every kind this version of the protocol knows, direct first. */
export const TRANSPORT_KINDS = [...DIRECT_TRANSPORT_KINDS, ...BROKER_TRANSPORT_KINDS] as const;

export type DirectTransportKind = (typeof DIRECT_TRANSPORT_KINDS)[number];
export type BrokerTransportKind = (typeof BROKER_TRANSPORT_KINDS)[number];
export type KnownTransportKind = (typeof TRANSPORT_KINDS)[number];

/**
 * The kind of transport a call travels over. Open: the known kinds autocomplete, any other string is accepted
 * (`string & {}` keeps the literal members visible in editors instead of collapsing the union to `string`).
 */
export type TransportKind = KnownTransportKind | (string & {});

/** The MCP face of a plugin (docs/protocol.md §15); not a transport the host routes node calls over. */
export const MCP_FACE_KIND = 'mcp' as const;

export function isDirectTransport(kind: string): kind is DirectTransportKind {
  return (DIRECT_TRANSPORT_KINDS as readonly string[]).includes(kind);
}

/** True for a known broker kind and for any kind that is neither direct nor `in-process`/`mcp` (an unknown kind is assumed brokered). */
export function isBrokerTransport(kind: string): boolean {
  return kind !== 'in-process' && kind !== MCP_FACE_KIND && !isDirectTransport(kind);
}

/** A kind, a connection id and a plugin id are each `[a-z0-9][a-z0-9._-]*` (no slashes, no `@`, no spaces). */
export const ENDPOINT_SEGMENT = /^[a-z0-9][a-z0-9._-]*$/;

export interface DirectEndpoint {
  kind: DirectTransportKind;
  /** The URL as given, e.g. `grpc://10.0.0.5:7204` or `https://plugins.example.com`. */
  url: string;
  /** `http` endpoints: whether TLS is used (`https://`). */
  secure: boolean;
  host: string;
  /** Absent when the URL has none (an `https://` endpoint on 443). */
  port?: number;
}

export interface BrokeredEndpoint {
  kind: TransportKind;
  /** The broker connection on the host (Settings → Transports), e.g. `kafka-main`. */
  connectionId: string;
  /** The plugin reached through it; its request channel is derived from this id (§14.4). */
  pluginId: string;
}

export type ParsedEndpoint = ({ brokered: false } & DirectEndpoint) | ({ brokered: true } & BrokeredEndpoint);

const SCHEME = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/is;

/**
 * Parse an endpoint of either family. Direct URLs (`http://`, `https://`, `grpc://`) keep their form; anything else
 * must be `<kind>://<connectionId>/<pluginId>` with nothing after the plugin id. Throws on malformed input, so callers
 * that read endpoints from the network use {@link tryParseEndpoint}.
 */
export function parseEndpoint(endpoint: string): ParsedEndpoint {
  const parsed = tryParseEndpoint(endpoint);
  if (!parsed) throw new Error(`Invalid endpoint "${endpoint}" (expected http(s)://host[:port], grpc://host:port or <kind>://<connectionId>/<pluginId>)`);
  return parsed;
}

/** {@link parseEndpoint} without the throw: `undefined` for anything malformed. */
export function tryParseEndpoint(endpoint: string): ParsedEndpoint | undefined {
  const match = SCHEME.exec(endpoint.trim());
  if (!match) return undefined;
  const scheme = match[1].toLowerCase();
  const rest = match[2];
  if (scheme === 'http' || scheme === 'https' || scheme === 'grpc') {
    let url: URL;
    try {
      url = new URL(endpoint.trim());
    } catch {
      return undefined;
    }
    if (!url.hostname) return undefined;
    const port = url.port ? Number(url.port) : scheme === 'https' ? 443 : scheme === 'http' ? 80 : undefined;
    if (scheme === 'grpc' && port === undefined) return undefined;
    return { brokered: false, kind: scheme === 'grpc' ? 'grpc' : 'http', url: endpoint.trim(), secure: scheme === 'https', host: url.hostname, port };
  }
  const parts = rest.split('/');
  if (parts.length !== 2) return undefined;
  const [connectionId, pluginId] = parts;
  if (!ENDPOINT_SEGMENT.test(scheme) || !ENDPOINT_SEGMENT.test(connectionId) || !ENDPOINT_SEGMENT.test(pluginId)) return undefined;
  return { brokered: true, kind: scheme, connectionId, pluginId };
}

/** `kafka` + `kafka-main` + `twilio` → `kafka://kafka-main/twilio`. Validates each segment. */
export function formatEndpoint(endpoint: BrokeredEndpoint): string {
  for (const [field, value] of Object.entries({ kind: endpoint.kind, connectionId: endpoint.connectionId, pluginId: endpoint.pluginId })) {
    if (!ENDPOINT_SEGMENT.test(value)) throw new Error(`Invalid endpoint ${field} "${value}" (expected ${ENDPOINT_SEGMENT})`);
  }
  if (isDirectTransport(endpoint.kind)) throw new Error(`"${endpoint.kind}" is a direct transport: its endpoints are URLs, not <kind>://<connectionId>/<pluginId>`);
  return `${endpoint.kind}://${endpoint.connectionId}/${endpoint.pluginId}`;
}

/** The transport kind of an endpoint string (`grpc`, `http`, `kafka`, …); throws on malformed endpoints. */
export function transportKindOf(endpoint: string): TransportKind {
  return parseEndpoint(endpoint).kind;
}

export function isBrokeredEndpoint(endpoint: string): boolean {
  return tryParseEndpoint(endpoint)?.brokered === true;
}
