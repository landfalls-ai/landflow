/**
 * What every SAP node does first: build a client from the credential, resolve the service (a catalog entry or a custom path),
 * fetch `$metadata` through the cache, and count writes per run.
 */
import { NodeOperationError, type GetCredentials, type TracedFetch } from '@landflow/sdk';
import { CATALOG, CUSTOM_SERVICE, serviceById, type CatalogService } from './catalog';
import { resolveCredentials, type Resolved } from './credentials';
import { SapClient } from './odata/client';
import { SapError } from './odata/errors';
import { cachedMetadata, parseMetadata, storeMetadata, type ServiceMetadata } from './odata/metadata';
import { checkCustomPath, type ODataVersion } from './odata/query';

export interface ClientSource {
  http: TracedFetch;
  getCredentials: GetCredentials;
  signal?: AbortSignal;
}

export interface Connection {
  client: SapClient;
  resolved: Resolved;
}

export function connect(source: ClientSource, authentication: unknown, timeoutMs?: number, extra: { hosts?: string[]; sleep?: (ms: number) => Promise<void>; maxRetryAfterMs?: number } = {}): Connection {
  const resolved = resolveCredentials(source.getCredentials, authentication);
  const client = new SapClient({
    baseUrl: resolved.baseUrl,
    auth: resolved.auth,
    fetch: source.http,
    ...(resolved.sapClient && { sapClient: resolved.sapClient }),
    ...(timeoutMs && { timeoutMs }),
    ...(source.signal && { signal: source.signal }),
    ...extra,
  });
  return { client, resolved };
}

export interface ServiceRef {
  /** The id shown in spans and errors: the catalog id, or the last part of a custom path. */
  id: string;
  path: string;
  version: ODataVersion;
  catalog?: CatalogService;
}

/**
 * `service` is a catalog id or `custom` (then `customPath` is used). Any other value is refused, so a model cannot name a path:
 * a custom path only comes from the node's own settings.
 */
export function resolveService(service: unknown, customPath: unknown, version: unknown, allowed: string[] = []): ServiceRef {
  const id = String(service ?? '').trim();
  let ref: ServiceRef;
  if (id === CUSTOM_SERVICE) {
    const path = checkCustomPath(String(customPath ?? ''));
    ref = { id: path.slice(path.lastIndexOf('/') + 1).replace(/;.*$/, ''), path, version: version === 'v4' ? 'v4' : 'v2' };
  } else {
    const catalog = serviceById(id);
    if (!catalog) throw new NodeOperationError(`Unknown service "${id}"`, { description: `Use one of ${CATALOG.map((s) => s.id).join(', ')}, or pick Custom Path and set it on the node.` });
    ref = { id: catalog.id, path: catalog.path, version: catalog.version, catalog };
  }
  if (allowed.length > 0 && !allowed.includes(ref.id)) {
    throw new NodeOperationError(`The credential does not allow the service ${ref.id}`, { description: `Allowed Services on the credential: ${allowed.join(', ')}` });
  }
  return ref;
}

/** `$metadata` for a service, from the cache or one fetch. The key never holds a secret (user, client id, host, service). */
export async function loadMetadata(connection: Connection, service: ServiceRef): Promise<ServiceMetadata> {
  const key = `${connection.client.identity}|${service.path}`;
  const hit = cachedMetadata(key);
  if (hit) return hit;
  const response = await connection.client.get(`${service.path}/$metadata`, { accept: 'application/xml', context: { service: service.id, operation: 'read metadata' } });
  if (typeof response.body !== 'string' || !/<(edmx:)?Edmx|<Schema/i.test(response.body)) {
    throw new SapError(`SAP ${service.id} read metadata: the answer is not EDMX`, response.status, { description: 'The service did not return $metadata. Is the path right?' });
  }
  const meta = parseMetadata(response.body);
  if (meta.entitySets.length === 0) throw new SapError(`SAP ${service.id} read metadata: no entity sets found`, response.status);
  storeMetadata(key, meta);
  return meta;
}

/** The cached `$metadata` without a fetch. */
export const peekMetadata = (connection: Connection, service: ServiceRef) => cachedMetadata(`${connection.client.identity}|${service.path}`);

/** `$metadata` when it can be had; undefined when the tenant refuses it (a 401 is still an error: nothing else would work either). */
export async function tryMetadata(connection: Connection, service: ServiceRef, warn?: (message: string) => void): Promise<ServiceMetadata | undefined> {
  try {
    return await loadMetadata(connection, service);
  } catch (error) {
    if (error instanceof SapError && error.status === 401) throw error;
    warn?.(`$metadata of ${service.id} was not available (${(error as Error).message}); the request is sent without checking it`);
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Writes per run
// ---------------------------------------------------------------------------

export const DEFAULT_MAX_WRITES_PER_RUN = 5;
const writes = new Map<string, { count: number; at: number }>();
const WRITE_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Counts one write for this execution, before the request is sent, so a refused or failed write still uses the budget. `limit` 0
 * means no write at all. The count lives in this process's memory (it resets on a restart and is per replica).
 */
export function countWrite(executionId: string, limit: number): number {
  const now = Date.now();
  for (const [id, entry] of writes) if (now - entry.at > WRITE_TTL_MS) writes.delete(id);
  const entry = writes.get(executionId) ?? { count: 0, at: now };
  if (entry.count >= limit) {
    throw new NodeOperationError(limit === 0 ? 'Writes are switched off (Max Writes per Run is 0)' : `This run already made ${entry.count} write${entry.count === 1 ? '' : 's'}; Max Writes per Run is ${limit}`, {
      description: 'Raise Max Writes per Run on the node if more are intended.',
    });
  }
  entry.count++;
  entry.at = now;
  writes.set(executionId, entry);
  return entry.count;
}
export const resetWriteCounts = () => writes.clear();
