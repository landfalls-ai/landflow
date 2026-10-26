/**
 * `@landflow/transports/nats`: the **core NATS** driver module (kind `nats`; docs/protocol.md §14.9 "NATS core").
 *
 * A channel is a subject, replicas share it through a queue group, requests travel as NATS requests with inbox replies
 * and "no responders" becomes `unroutable`. Nothing is buffered or persisted: the lowest-latency broker, for calls that
 * must be answered now. For buffering, redelivery and disk persistence use the `jetstream` kind
 * (`@landflow/transports/jetstream`), which shares this driver's code (`./driver`).
 *
 * The SDK helper: `serve(plugin, { brokers: [nats({ servers: 'nats://127.0.0.1:54222' })] })`.
 */
import type { BrokerDriver } from '../../driver';
import type { BrokerTarget, DriverModule } from '../index';
import { NATS_CORE_CAPABILITIES, NatsDriver, natsConfigFrom, type NatsConfig } from './driver';

export { NATS_CORE_CAPABILITIES, NATS_HEADER_PREFIX, NatsDriver, natsConfigFrom, type NatsConfig } from './driver';

/** A new, unconnected core NATS driver. */
export const natsDriver = (): BrokerDriver<NatsConfig> => new NatsDriver<NatsConfig>('nats', 'core', NATS_CORE_CAPABILITIES);

const natsModule: DriverModule<NatsConfig> = {
  kind: 'nats',
  label: 'NATS (core)',
  capabilities: NATS_CORE_CAPABILITIES,
  exampleUrl: 'nats://127.0.0.1:54222',
  create: natsDriver,
  configFrom: natsConfigFrom,
};

export default natsModule;

export interface NatsTargetOptions extends Omit<NatsConfig, 'connectionId'> {
  /** Default `env-nats`: the connection the host reads from `LANDFLOW_TRANSPORT_NATS_URL`. */
  connectionId?: string;
}

/** The SDK's broker target for core NATS: `nats({ servers: 'nats://127.0.0.1:54222' })`. */
export function nats(options: NatsTargetOptions): BrokerTarget<NatsConfig> {
  const { connectionId = 'env-nats', ...rest } = options;
  if (!rest.servers || (Array.isArray(rest.servers) && rest.servers.length === 0)) throw new Error('nats(): "servers" is required');
  return { kind: 'nats', config: { connectionId, ...rest }, driver: natsDriver };
}
