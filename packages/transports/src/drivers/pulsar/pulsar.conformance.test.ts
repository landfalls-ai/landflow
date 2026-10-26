/**
 * The driver conformance suite against the local Pulsar standalone (`deploy/compose.infra.yml`, profile `pulsar`). Gated on
 * `LANDFLOW_TEST_PULSAR=pulsar://127.0.0.1:56650` (`LANDFLOW_TEST_PULSAR_ADMIN`, default `http://127.0.0.1:58180`, enables
 * stats); skipped with a message when unset or unreachable. Every run uses the suite's random channel prefixes; the
 * topics it created are deleted through the admin API at the end.
 */
import { createConnection } from 'node:net';
import { afterAll, describe } from 'vitest';
import { runConformance } from '../../conformance';
import { PulsarDriver, type PulsarConfig } from './index';

const serviceUrl = process.env.LANDFLOW_TEST_PULSAR;
const adminUrl = process.env.LANDFLOW_TEST_PULSAR_ADMIN ?? 'http://127.0.0.1:58180';

async function reachable(url: string): Promise<boolean> {
  const match = /^pulsar(?:\+ssl)?:\/\/([^:/]+)(?::(\d+))?/.exec(url);
  if (!match) return false;
  return new Promise((resolve) => {
    const socket = createConnection({ host: match[1], port: Number(match[2]) || 6650 }, () => {
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

if (!serviceUrl) {
  describe.skip('pulsar driver (set LANDFLOW_TEST_PULSAR=pulsar://127.0.0.1:56650 to run against the local container)', () => {});
} else if (!(await reachable(serviceUrl))) {
  describe.skip(`pulsar driver (LANDFLOW_TEST_PULSAR=${serviceUrl} is not reachable; start it with docker compose -f deploy/compose.infra.yml --profile pulsar up -d)`, () => {});
} else {
  const config: PulsarConfig = { connectionId: 'pulsar-test', serviceUrl, adminUrl, nackRedeliveryDelayMs: 100 };
  runConformance({ name: 'pulsar', driver: () => new PulsarDriver(), config, deliveryTimeoutMs: 10_000 });

  // Delete the topics the runs created (the suite's prefixes are `lfconf.<run>.` and `lfcore<hex>.v1.`).
  afterAll(async () => {
    const list = await fetch(`${adminUrl}/admin/v2/persistent/public/default`, { signal: AbortSignal.timeout(10_000) }).then((r) => (r.ok ? (r.json() as Promise<string[]>) : []));
    for (const topic of list) {
      const name = topic.replace(/^persistent:\/\/public\/default\//, '');
      if (/^lfconf\.[0-9a-f]{8}\.|^lfcore[0-9a-f]{6}\.v1\./.test(name)) await fetch(`${adminUrl}/admin/v2/persistent/public/default/${encodeURIComponent(name)}?force=true`, { method: 'DELETE', signal: AbortSignal.timeout(10_000) }).catch(() => undefined);
    }
  }, 60_000);
}
