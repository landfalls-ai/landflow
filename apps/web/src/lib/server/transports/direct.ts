/**
 * The direct transports behind the provider interface: today's HTTP and gRPC clients (lib/server/plugins/clients.ts),
 * unchanged in behaviour. The pooled per-pod client (Kubernetes discovery) wraps whichever of them the Service
 * endpoint uses and stays in the registry, since the pods are the registry's knowledge, not the transport's.
 */
import { GrpcPluginClient, HttpPluginClient, PooledPluginClient, type PluginClient } from '../plugins/clients';
import type { TransportProvider } from './provider';

export { PooledPluginClient };

/** No message size limit of their own (the gRPC client allows 64 MiB per message; HTTP bodies are unbounded). */
const DIRECT_MAX_BYTES = 64 * 1024 * 1024;

export const httpProvider: TransportProvider = {
  kind: 'http',
  label: 'HTTP',
  direct: true,
  capabilities: { maxMessageBytes: DIRECT_MAX_BYTES, delivery: ['at-most-once'], latency: 'low', buffering: false },
  createClient: (endpoint): PluginClient => new HttpPluginClient(endpoint),
  health: () => ({ ok: true }),
};

export const grpcProvider: TransportProvider = {
  kind: 'grpc',
  label: 'gRPC',
  direct: true,
  capabilities: { maxMessageBytes: DIRECT_MAX_BYTES, delivery: ['at-most-once'], latency: 'low', buffering: false },
  createClient: (endpoint): PluginClient => new GrpcPluginClient(endpoint),
  health: () => ({ ok: true }),
};

/** Auto's default order while it has no measurements: gRPC (binary, multiplexed), then HTTP, then anything else. */
export const DIRECT_PREFERENCE: readonly string[] = ['grpc', 'http'];
