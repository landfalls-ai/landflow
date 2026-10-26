/**
 * The driver conformance suite against the local Mosquitto container (`deploy/compose.infra.yml`, profile `mqtt`).
 * Gated on `LANDFLOW_TEST_MQTT=mqtt://127.0.0.1:51883` (anonymous in dev); skipped with a message when unset or
 * unreachable. Topics and clean sessions leave nothing behind on the broker, so there is nothing to delete; every run
 * uses the suite's random channel prefixes anyway. The limit is set explicitly (Mosquitto's `message_size_limit 0` means
 * the broker advertises none).
 */
import { createConnection } from 'node:net';
import { describe } from 'vitest';
import { runConformance } from '../../conformance';
import { MqttDriver, type MqttConfig } from './index';

const url = process.env.LANDFLOW_TEST_MQTT;

async function reachable(target: URL): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: target.hostname, port: Number(target.port) || 1883 }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.setTimeout(1500, () => {
      socket.destroy();
      resolve(false);
    });
    socket.on('error', () => resolve(false));
  });
}

if (!url) {
  describe.skip('mqtt driver (set LANDFLOW_TEST_MQTT=mqtt://127.0.0.1:51883 to run against the local container)', () => {});
} else if (!(await reachable(new URL(url)))) {
  describe.skip(`mqtt driver (${new URL(url).host} is not reachable; start it with docker compose -f deploy/compose.infra.yml --profile mqtt up -d)`, () => {});
} else {
  const config: MqttConfig = { connectionId: 'mqtt-test', url, maxMessageBytes: 1024 * 1024 };
  runConformance({ name: 'mqtt', driver: () => new MqttDriver(), config, deliveryTimeoutMs: 4_000 });
}
