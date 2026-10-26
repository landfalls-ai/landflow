/**
 * Live check against real brokers, gated per kind on `LANDFLOW_TEST_<KIND>` (a connection URL for the kind's driver
 * module, e.g. `LANDFLOW_TEST_KAFKA=kafka://127.0.0.1:59092`, `LANDFLOW_TEST_AMQP=amqp://landflow:landflow@127.0.0.1:55672`,
 * `LANDFLOW_TEST_NATS=nats://127.0.0.1:54222`, `LANDFLOW_TEST_VALKEY=redis://127.0.0.1:56379`). Skips with a message when
 * the variable is unset or this build has no driver module for the kind (`@landflow/transports/<kind>`, streams T2-A/B).
 *
 * Serves a tiny plugin over the broker (through serve()'s environment path: LANDFLOW_TRANSPORTS + LANDFLOW_<KIND>_URL),
 * then calls it with MessagingClient the way the host does.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { ExecuteRequest } from '@landflow/protocol';
import { Keyring, MessagingClient, silentLogger } from '@landflow/transports';
import { loadDriverModule } from '@landflow/transports/drivers';
import { defineNode, definePlugin, type IExecuteContext } from '../src';
import { serve, type ServeResult } from '../src/serve';
import { createTelemetry } from '../src/telemetry';

const KINDS = ['kafka', 'amqp', 'nats', 'valkey'] as const;
const SECRET = 'live-broker-test-secret';
// A unique plugin id per run, so a shared broker (Valkey is the app's) never mixes runs; channels are under this prefix.
const RUN = Math.random().toString(36).slice(2, 8);
const PREFIX = `landflow-test-${RUN}`;

const echo = defineNode({
  description: { name: 'echo', displayName: 'Echo', description: '', version: 1, kind: 'action', idempotent: true, inputs: [{ type: 'main' }], outputs: [{ type: 'main' }], properties: [] },
  execute: (ctx: IExecuteContext) => ctx.getInputData().map((item) => ({ json: { ...item.json, echoed: true } })),
});

const running: ServeResult[] = [];
const clients: MessagingClient[] = [];
const savedEnv = { ...process.env };
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(running.splice(0).map((result) => result.stop()));
  for (const key of Object.keys(process.env)) if (key.startsWith('LANDFLOW_')) delete process.env[key];
  for (const [key, value] of Object.entries(savedEnv)) if (key.startsWith('LANDFLOW_')) process.env[key] = value;
});

for (const kind of KINDS) {
  const url = process.env[`LANDFLOW_TEST_${kind.toUpperCase()}`];
  describe(`live ${kind}`, () => {
    it(`serves a plugin over ${kind} and the host calls it`, { timeout: 60_000 }, async ({ skip }) => {
      if (!url) return skip(`set LANDFLOW_TEST_${kind.toUpperCase()}=<url> with the ${kind} container up (deploy/compose.infra.yml --profile ${kind})`);
      const module = await loadDriverModule(kind);
      if (!module) return skip(`this build of @landflow/transports has no "${kind}" driver module yet`);
      const pluginId = `live-${kind}-${RUN}`;
      const plugin = definePlugin({ info: { id: pluginId, name: `Live ${kind}`, version: '0.0.1' }, nodes: [echo] });

      const keyring = new Keyring(SECRET);
      const client = await MessagingClient.start({ driver: module.create(), config: module.configFrom(`env-${kind}`, url, { prefix: PREFIX }), keyring, registrySecret: null, log: silentLogger });
      clients.push(client);

      process.env.LANDFLOW_TRANSPORT_SECRET = SECRET;
      process.env.LANDFLOW_TRANSPORTS = kind;
      process.env[`LANDFLOW_${kind.toUpperCase()}_URL`] = url;
      process.env[`LANDFLOW_${kind.toUpperCase()}_PREFIX`] = PREFIX;
      const result = await serve(plugin, { registryUrl: false, maxConcurrency: 2, telemetry: await createTelemetry({ pluginId, env: { OTEL_SDK_DISABLED: 'true' }, logWriter: () => {} }) });
      running.push(result);
      expect(result.transports).toEqual([kind]);

      for (let i = 0; i < 300 && !client.plugin(pluginId)?.instances.length; i++) await new Promise((resolve) => setTimeout(resolve, 50));
      expect(client.plugin(pluginId)?.endpoint).toBe(`${kind}://env-${kind}/${pluginId}`);

      const request: ExecuteRequest = {
        protocol: 'landflow.plugin/v1',
        executionId: 'ex_live',
        mode: 'manual',
        node: { id: 'n1', name: 'Echo', type: `${pluginId}.echo`, typeVersion: 1 },
        parameters: {},
        itemParameters: [{}],
        inputs: [[{ json: { n: 1 } }]],
      };
      const reply = await client.invoke(pluginId, 'Execute', request, { timeoutMs: 20_000, delivery: 'at-least-once' });
      expect(reply.body.outputs).toEqual([[{ json: { n: 1, echoed: true } }]]);
      expect(await client.call(pluginId, 'Health', {}, { timeoutMs: 20_000 })).toMatchObject({ status: 'ok', pluginId });
    });
  });
}
