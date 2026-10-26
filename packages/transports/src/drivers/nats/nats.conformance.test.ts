/**
 * The driver conformance suite against a real NATS server, core mode. Gated on `LANDFLOW_TEST_NATS=nats://127.0.0.1:54222`
 * (the `nats` profile of deploy/compose.infra.yml); skipped with a message when unset or unreachable. Core NATS keeps
 * nothing, and the suite randomises its subject prefixes, so there is nothing to clean up.
 */
import { describe } from 'vitest';
import { runConformance } from '../../conformance';
import natsModule from './index';

const url = process.env.LANDFLOW_TEST_NATS;

async function reachable(): Promise<string | undefined> {
  const driver = natsModule.create();
  try {
    await driver.connect({ ...natsModule.configFrom('nats-test', url!), connectTimeoutMs: 3_000 });
    return undefined;
  } catch (error) {
    return (error as Error).message;
  } finally {
    await driver.close().catch(() => {});
  }
}

if (!url) describe.skip('nats driver (set LANDFLOW_TEST_NATS=nats://127.0.0.1:54222 to run)', () => {});
else {
  const problem = await reachable();
  if (problem) describe.skip(`nats driver (NATS at ${url} is not reachable: ${problem})`, () => {});
  else runConformance({ name: 'nats (core)', driver: () => natsModule.create(), config: natsModule.configFrom('nats-test', url), deliveryTimeoutMs: 3_000 });
}
