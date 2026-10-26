/**
 * Self-announcement: tell the Landflow host "I'm here, at this endpoint" and
 * keep the lease alive with heartbeats. Works against the host's HTTP registry
 * (POST /api/plugins/announce) or its gRPC RegistryService (grpc://host:7070).
 * When the host requires a registry secret, set LANDFLOW_REGISTRY_SECRET here too:
 * it goes out as the `x-landflow-registry-secret` header (or gRPC metadata).
 * Every announce carries this process's `instanceId`, so the host notices a restart.
 */
import { randomBytes } from 'node:crypto';
import {
  DEFAULT_ANNOUNCE_TTL_SECONDS,
  DEFAULT_HEARTBEAT_SECONDS,
  PROTOCOL_VERSION,
  type AnnounceRequest,
  type AnnounceResponse,
} from '@landflow/protocol';
import type { TransportHints } from './binding';

/**
 * AnnounceRequest.instanceId: random, picked once per process. A restarted plugin announces a new one, and the host pulls
 * its manifest again even when the version is the same (new nodes or parameters during development).
 */
export const INSTANCE_ID = randomBytes(16).toString('hex');

export interface AnnouncerOptions {
  registryUrl: string;
  /** The endpoints announced at start; `add()` / `remove()` change the set later (a binding that connects after start). */
  endpoints: string[];
  pluginId: string;
  version: string;
  ttlSeconds?: number;
  /**
   * Manifest hints sent with every announce (docs/transports.md "Protocol changes" §2): `transports`, `maxConcurrency`.
   * Hosts that don't know them ignore them (the announce schema strips unknown fields).
   */
  hints?: TransportHints;
  log?: (message: string) => void;
}

export interface Announcer {
  /** The endpoints currently announced. */
  readonly endpoints: readonly string[];
  /** Announce more endpoints now (and with every heartbeat). */
  add(endpoints: string[]): Promise<void>;
  /** Withdraw endpoints now and stop heartbeating them. */
  remove(endpoints: string[]): Promise<void>;
  stop(): Promise<void>;
}

interface RegistryClient {
  announce(request: AnnounceRequest): Promise<AnnounceResponse>;
  withdraw(endpoint: string, pluginId: string): Promise<void>;
  close(): void;
}

/** The host's registry secret, sent with every announce and withdraw when set. */
const secretHeaders = (): Record<string, string> => {
  const secret = process.env.LANDFLOW_REGISTRY_SECRET;
  return secret ? { 'x-landflow-registry-secret': secret } : {};
};

function httpRegistry(base: string): RegistryClient {
  const url = new URL('/api/plugins/announce', base).toString();
  return {
    async announce(request) {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...secretHeaders() },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) throw new Error(`registry responded ${response.status}: ${await response.text()}`);
      return (await response.json()) as AnnounceResponse;
    },
    async withdraw(endpoint, pluginId) {
      await fetch(url, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json', ...secretHeaders() },
        body: JSON.stringify({ endpoint, pluginId }),
        signal: AbortSignal.timeout(3_000),
      });
    },
    close() {},
  };
}

async function grpcRegistry(address: string): Promise<RegistryClient> {
  const { grpc, loadLandflowProto, unary } = await import('@landflow/protocol/grpc');
  const proto = loadLandflowProto();
  const client = new proto.RegistryService(address, grpc.credentials.createInsecure());
  return {
    async announce(request) {
      const response = await unary<object, AnnounceResponse>(
        client,
        'Announce',
        { ...request, ttlSeconds: request.ttlSeconds ?? 0 },
        5_000,
        secretHeaders(),
      );
      return response;
    },
    async withdraw(endpoint, pluginId) {
      await unary(client, 'Withdraw', { endpoint, pluginId }, 3_000, secretHeaders());
    },
    close: () => client.close(),
  };
}

export async function startAnnouncer(options: AnnouncerOptions): Promise<Announcer> {
  const log = options.log ?? ((message: string) => console.log(`[landflow] ${message}`));
  const registry = options.registryUrl.startsWith('grpc://')
    ? await grpcRegistry(options.registryUrl.slice('grpc://'.length))
    : httpRegistry(options.registryUrl);

  const endpoints = [...new Set(options.endpoints)];
  const hints = options.hints ?? {};
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  let reachable: boolean | undefined;

  const announceOne = async (endpoint: string) => {
    // TODO(stream T1-A): drop the cast once AnnounceRequest carries `transports` and `maxConcurrency`.
    const request: AnnounceRequest & TransportHints = {
      protocol: PROTOCOL_VERSION,
      endpoint,
      pluginId: options.pluginId,
      version: options.version,
      ttlSeconds: options.ttlSeconds ?? DEFAULT_ANNOUNCE_TTL_SECONDS,
      instanceId: INSTANCE_ID,
      ...(hints.transports?.length && { transports: [...hints.transports] }),
      ...(hints.maxConcurrency && hints.maxConcurrency > 0 && { maxConcurrency: hints.maxConcurrency }),
    };
    return registry.announce(request);
  };

  const beat = async () => {
    let interval = DEFAULT_HEARTBEAT_SECONDS;
    try {
      for (const endpoint of [...endpoints]) {
        const response = await announceOne(endpoint);
        if (response.heartbeatIntervalSeconds > 0) interval = response.heartbeatIntervalSeconds;
      }
      if (reachable !== true && endpoints.length) log(`announced ${endpoints.join(', ')} to ${options.registryUrl}`);
      reachable = true;
    } catch (error) {
      // Log the transition once; keep retrying quietly until the host shows up.
      if (reachable !== false) {
        log(`registry ${options.registryUrl} unreachable (${(error as Error).message}); will keep retrying`);
      }
      reachable = false;
    }
    if (!stopped) timer = setTimeout(beat, interval * 1000);
  };

  await beat();

  return {
    get endpoints() {
      return endpoints;
    },
    async add(more) {
      const fresh = more.filter((endpoint) => !endpoints.includes(endpoint));
      if (!fresh.length || stopped) return;
      endpoints.push(...fresh);
      try {
        for (const endpoint of fresh) await announceOne(endpoint);
        log(`announced ${fresh.join(', ')} to ${options.registryUrl}`);
      } catch {
        // The next heartbeat retries.
      }
    },
    async remove(gone) {
      const removed = gone.filter((endpoint) => endpoints.includes(endpoint));
      for (const endpoint of removed) endpoints.splice(endpoints.indexOf(endpoint), 1);
      await Promise.allSettled(removed.map((endpoint) => registry.withdraw(endpoint, options.pluginId)));
    },
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await Promise.allSettled(endpoints.map((e) => registry.withdraw(e, options.pluginId)));
      registry.close();
    },
  };
}
