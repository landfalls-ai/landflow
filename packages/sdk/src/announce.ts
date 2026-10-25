/**
 * Self-announcement: tell the Landflow host "I'm here, at this endpoint" and
 * keep the lease alive with heartbeats. Works against the host's HTTP registry
 * (POST /api/plugins/announce) or its gRPC RegistryService (grpc://host:7070).
 */
import {
  DEFAULT_ANNOUNCE_TTL_SECONDS,
  DEFAULT_HEARTBEAT_SECONDS,
  PROTOCOL_VERSION,
  type AnnounceRequest,
  type AnnounceResponse,
} from '@landflow/protocol';

export interface AnnouncerOptions {
  registryUrl: string;
  endpoints: string[];
  pluginId: string;
  version: string;
  ttlSeconds?: number;
  log?: (message: string) => void;
}

export interface Announcer {
  stop(): Promise<void>;
}

interface RegistryClient {
  announce(request: AnnounceRequest): Promise<AnnounceResponse>;
  withdraw(endpoint: string, pluginId: string): Promise<void>;
  close(): void;
}

function httpRegistry(base: string): RegistryClient {
  const url = new URL('/api/plugins/announce', base).toString();
  return {
    async announce(request) {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) throw new Error(`registry responded ${response.status}: ${await response.text()}`);
      return (await response.json()) as AnnounceResponse;
    },
    async withdraw(endpoint, pluginId) {
      await fetch(url, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
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
      );
      return response;
    },
    async withdraw(endpoint, pluginId) {
      await unary(client, 'Withdraw', { endpoint, pluginId }, 3_000);
    },
    close: () => client.close(),
  };
}

export async function startAnnouncer(options: AnnouncerOptions): Promise<Announcer> {
  const log = options.log ?? ((message: string) => console.log(`[landflow] ${message}`));
  const registry = options.registryUrl.startsWith('grpc://')
    ? await grpcRegistry(options.registryUrl.slice('grpc://'.length))
    : httpRegistry(options.registryUrl);

  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  let reachable: boolean | undefined;

  const beat = async () => {
    let interval = DEFAULT_HEARTBEAT_SECONDS;
    try {
      for (const endpoint of options.endpoints) {
        const response = await registry.announce({
          protocol: PROTOCOL_VERSION,
          endpoint,
          pluginId: options.pluginId,
          version: options.version,
          ttlSeconds: options.ttlSeconds ?? DEFAULT_ANNOUNCE_TTL_SECONDS,
        });
        if (response.heartbeatIntervalSeconds > 0) interval = response.heartbeatIntervalSeconds;
      }
      if (reachable !== true) log(`announced ${options.endpoints.join(', ')} to ${options.registryUrl}`);
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
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await Promise.allSettled(options.endpoints.map((e) => registry.withdraw(e, options.pluginId)));
      registry.close();
    },
  };
}
