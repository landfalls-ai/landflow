/**
 * `@landflow/transports/jetstream`: the **NATS JetStream** driver module (kind `jetstream`; docs/protocol.md §14.9
 * "NATS JetStream").
 *
 * Request channels are work-queue streams with one durable pull consumer per plugin: calls are buffered while no replica
 * is up, redelivered when one dies (`numDelivered` is the attempt), kept on disk for `maxAgeMs`, and answered through NATS
 * inboxes like core NATS. The other channels (instance, reply, registry, control) are plain subjects. It is a separate
 * kind from `nats` because its capabilities differ (buffering, disk persistence, inferred undeliverability) and a
 * `DriverModule` has one static capability set; both kinds run on the same server and connection URL. Every subject this
 * kind uses is the channel name behind a fixed `js.` token (`js.landflow.v1.plugin.<id>`; stream `js_landflow_v1_plugin_<id>`),
 * so a work-queue stream never captures what core `nats` publishes, and the two kinds' registry/control channels stay apart.
 *
 * The SDK helper: `serve(plugin, { brokers: [jetstream({ servers: 'nats://127.0.0.1:54222' })] })`.
 */
import type { BrokerDriver } from '../../driver';
import type { BrokerTarget, DriverModule } from '../index';
import { JETSTREAM_CAPABILITIES, NatsDriver, jetstreamConfigFrom, type JetStreamConfig } from './driver';

export { DEFAULT_ACK_WAIT_MS, DEFAULT_MAX_AGE_MS, JETSTREAM_CAPABILITIES, NatsDriver, jetstreamConfigFrom, streamNameOf, type JetStreamConfig } from './driver';

/** A new, unconnected JetStream driver. */
export const jetstreamDriver = (): BrokerDriver<JetStreamConfig> => new NatsDriver<JetStreamConfig>('jetstream', 'jetstream', JETSTREAM_CAPABILITIES);

const jetstreamModule: DriverModule<JetStreamConfig> = {
  kind: 'jetstream',
  label: 'NATS JetStream',
  capabilities: JETSTREAM_CAPABILITIES,
  exampleUrl: 'nats://127.0.0.1:54222',
  fields: [
    { name: 'streamPrefix', label: 'Stream name prefix', type: 'string', placeholder: 'landflow-', hint: 'Prepended to the names of the streams and consumers this connection creates.' },
    { name: 'ackWaitMs', label: 'Ack wait (ms)', type: 'number', placeholder: '30000', hint: 'A delivery left unacknowledged this long is redelivered; running calls send progress acks.' },
  ],
  create: jetstreamDriver,
  configFrom: jetstreamConfigFrom,
};

export default jetstreamModule;

export interface JetStreamTargetOptions extends Omit<JetStreamConfig, 'connectionId'> {
  /** Default `env-jetstream`: the connection the host reads from `LANDFLOW_TRANSPORT_JETSTREAM_URL`. */
  connectionId?: string;
}

/** The SDK's broker target for JetStream: `jetstream({ servers: 'nats://127.0.0.1:54222' })`. */
export function jetstream(options: JetStreamTargetOptions): BrokerTarget<JetStreamConfig> {
  const { connectionId = 'env-jetstream', ...rest } = options;
  if (!rest.servers || (Array.isArray(rest.servers) && rest.servers.length === 0)) throw new Error('jetstream(): "servers" is required');
  return { kind: 'jetstream', config: { connectionId, ...rest }, driver: jetstreamDriver };
}
