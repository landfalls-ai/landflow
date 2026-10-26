/**
 * Channel names (docs/transports.md "One core, small drivers"): `<prefix>.v1.<role>…`. The prefix (default `landflow`)
 * lets two Landflow instances share a broker; the protocol version keeps a future `v2` apart.
 *
 * | Role       | Name                                        | Delivery  | Who consumes                                  |
 * |------------|---------------------------------------------|-----------|-----------------------------------------------|
 * | request    | `landflow.v1.plugin.<pluginId>`             | shared    | every replica of the plugin, work-shared      |
 * | instance   | `landflow.v1.instance.<pluginId>.<instance>` | shared   | one plugin process (calls that must reach it) |
 * | reply      | `landflow.v1.reply.<hostInstanceId>`        | broadcast | one host process                              |
 * | registry   | `landflow.v1.registry`                      | broadcast | every host (announce, withdraw)               |
 * | control    | `landflow.v1.control.<pluginId>`            | broadcast | every replica of the plugin (cancel)          |
 */
import type { ChannelSpec } from './driver';

export const DEFAULT_PREFIX = 'landflow';
export const CHANNEL_VERSION = 'v1';
const NAME_RE = /^[A-Za-z0-9._-]{1,128}$/;

export interface ChannelNames {
  request(pluginId: string): string;
  instance(pluginId: string, instanceId: string): string;
  reply(hostInstanceId: string): string;
  registry(): string;
  control(pluginId: string): string;
}

function checkName(what: string, value: string): string {
  if (!NAME_RE.test(value)) throw new Error(`${what} "${value}" must be 1–128 characters of letters, digits, ".", "_" or "-"`);
  return value;
}

export function channelNames(prefix = DEFAULT_PREFIX): ChannelNames {
  const base = `${checkName('channel prefix', prefix)}.${CHANNEL_VERSION}`;
  return {
    request: (pluginId) => `${base}.plugin.${checkName('plugin id', pluginId)}`,
    instance: (pluginId, instanceId) => `${base}.instance.${checkName('plugin id', pluginId)}.${checkName('instance id', instanceId)}`,
    reply: (hostInstanceId) => `${base}.reply.${checkName('host instance id', hostInstanceId)}`,
    registry: () => `${base}.registry`,
    control: (pluginId) => `${base}.control.${checkName('plugin id', pluginId)}`,
  };
}

/** The `ChannelSpec` for each role, with the durability and TTL the core wants. */
export const channelSpecs = {
  request: (name: string, ttlMs?: number): ChannelSpec => ({ name, role: 'request', delivery: 'shared', durable: true, ...(ttlMs !== undefined && { ttlMs }) }),
  instance: (name: string): ChannelSpec => ({ name, role: 'instance', delivery: 'shared', durable: false }),
  reply: (name: string): ChannelSpec => ({ name, role: 'reply', delivery: 'broadcast', durable: false, ttlMs: 5 * 60_000 }),
  registry: (name: string): ChannelSpec => ({ name, role: 'registry', delivery: 'broadcast', durable: false, ttlMs: 60_000 }),
  control: (name: string): ChannelSpec => ({ name, role: 'control', delivery: 'broadcast', durable: false, ttlMs: 60_000 }),
};

/** A brokered endpoint, `<kind>://<connectionId>/<pluginId>`, never with hosts or passwords. */
export const brokerEndpoint = (kind: string, connectionId: string, pluginId: string) => `${kind}://${connectionId}/${pluginId}`;

export function parseBrokerEndpoint(endpoint: string): { kind: string; connectionId: string; pluginId: string } | undefined {
  const match = /^([a-z][a-z0-9]*):\/\/([A-Za-z0-9._-]{1,64})\/([A-Za-z0-9._-]{1,128})$/.exec(endpoint);
  if (!match || match[1] === 'http' || match[1] === 'https' || match[1] === 'grpc' || match[1] === 'grpcs') return undefined;
  return { kind: match[1], connectionId: match[2], pluginId: match[3] };
}
