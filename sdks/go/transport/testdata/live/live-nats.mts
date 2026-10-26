/**
 * Live cross-language check, TypeScript side (see main.go and README.md). Run with the repo's tsx:
 *
 *   LIVE_PREFIX=lflive LANDFLOW_TRANSPORT_SECRET=… LANDFLOW_REGISTRY_SECRET=… packages/transports/node_modules/.bin/tsx live-nats.mts
 *
 * It starts a TS MessagingServer ("ts-echo", one echo node) over the NATS driver, then a MessagingClient that waits for
 * the Go plugin "live-go" to announce, calls Health, GetManifest, Execute (checking the manifest hash it announced is the
 * one its GetManifest reply hashes to), LoadOptions, an unknown node and a cancelled call, prints the outcomes and keeps
 * the echo server up a little longer so the Go host can call it.
 */
import { createHash } from 'node:crypto';
import { Keyring, MessagingClient, MessagingServer, DispatchError, RemoteError, CancelledError } from '../../../../../packages/transports/src/index.ts';
import { natsDriver, type NatsConfig } from '../../../../../packages/transports/src/drivers/nats/index.ts';

const servers = process.env.LIVE_NATS_URL ?? 'nats://127.0.0.1:54222';
const prefix = process.env.LIVE_PREFIX ?? 'lflive';
process.env.LANDFLOW_TRANSPORT_SECRET ??= 'live-cross-transport-secret';
process.env.LANDFLOW_REGISTRY_SECRET ??= 'live-cross-registry-secret';
const keyring = Keyring.fromEnv();
const config: NatsConfig = { connectionId: 'nats-live', prefix, servers };
const log = (...args: unknown[]) => console.log('[ts]', ...args);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const manifest = {
  protocol: 'landflow.plugin/v1' as const,
  plugin: { id: 'ts-echo', name: 'TS Echo', version: '0.0.1', language: 'typescript' as const },
  nodes: [{ name: 'echo', displayName: 'Echo', description: '', version: 1, kind: 'action' as const, inputs: [{ type: 'main' as const }], outputs: [{ type: 'main' as const }], properties: [], idempotent: true }],
  maxConcurrency: 2,
};
const server = await MessagingServer.start({
  driver: natsDriver(), config, keyring, pluginId: 'ts-echo', version: '0.0.1', manifest, log: () => {},
  dispatch: async (method, body, context) => {
    log(`ts-echo got ${method} (delivery ${context.delivery}, attempt ${context.attempt}, from ${context.source})`);
    if (method === 'Health') return { status: 'ok', uptimeMs: 1, pluginId: 'ts-echo', version: '0.0.1' } as never;
    if (method === 'Execute') {
      const req = body as { node: { type: string }; inputs: unknown[][] };
      if (req.node.type !== 'ts-echo.echo') throw new DispatchError(`unknown node ${req.node.type}`, 'not_found');
      return { outputs: [req.inputs[0].map((item) => ({ json: { ...(item as { json: object }).json, echoedBy: 'ts' } }))] } as never;
    }
    return {} as never;
  },
});
log(`ts-echo serving on ${server.endpoint} (instance ${server.instanceId}, manifest ${server.manifestHash})`);

const client = await MessagingClient.start({ driver: natsDriver(), config, keyring, hostInstanceId: 'ts-host', statsIntervalMs: 0, log: () => {} });
log('waiting for live-go to announce…');
const until = Date.now() + 30_000;
while (!client.plugin('live-go')?.instances.length) {
  if (Date.now() > until) {
    log('live-go never announced; is main.go running?');
    process.exit(1);
  }
  await sleep(100);
}
const announced = client.plugin('live-go')!;
log(`discovered ${announced.pluginId} ${announced.version} manifest ${announced.manifestHash} endpoint ${announced.endpoint} instances ${announced.instances.length}`);

const outcome = async <T>(label: string, fn: () => Promise<T>) => {
  try {
    const value = await fn();
    log(`${label} →`, JSON.stringify(value));
    return value;
  } catch (error) {
    log(`${label} → ${(error as Error).constructor.name}: ${(error as Error).message}`, error instanceof RemoteError ? `(code ${error.remoteCode})` : '');
    return undefined;
  }
};
await outcome('Health', () => client.call('live-go', 'Health', {}, { timeoutMs: 5000 }));
const got = await outcome('GetManifest', () => client.invoke('live-go', 'GetManifest', {}, { timeoutMs: 5000 }));
if (got) {
  const hash = createHash('sha256').update(JSON.stringify(got.body)).digest('hex').slice(0, 16);
  log(`manifest hash check: announced ${announced.manifestHash}, lfmanifest ${got.attributes.lfmanifest}, sha256(JSON.stringify(body)) ${hash} → ${hash === announced.manifestHash ? 'MATCH' : 'MISMATCH'}`);
}
const execute = (type: string, value: string) => ({
  protocol: 'landflow.plugin/v1' as const, executionId: 'live-ts-1', mode: 'manual' as const,
  node: { id: 'n1', name: 'upper', type, typeVersion: 1 }, parameters: { field: 'value' }, itemParameters: [{}],
  inputs: [[{ json: { value } }]], credentials: { api: { token: 'ts-token' } },
});
await outcome('Execute upper (at most once)', () => client.call('live-go', 'Execute', execute('live-go.upper', 'hello from ts'), { timeoutMs: 5000 }));
await outcome('Execute upper (at least once)', () => client.call('live-go', 'Execute', execute('live-go.upper', 'again'), { timeoutMs: 5000, delivery: 'at-least-once' }));
await outcome('LoadOptions', () => client.call('live-go', 'LoadOptions', { nodeType: 'live-go.upper', method: 'modes', parameters: {} }, { timeoutMs: 5000 }));
await outcome('Execute unknown node', () => client.call('live-go', 'Execute', execute('live-go.nope', 'x'), { timeoutMs: 5000 }));
await outcome('Health with a stale manifest hash', () => client.call('live-go', 'Health', {}, { timeoutMs: 5000, manifestHash: 'deadbeefdeadbeef' }));
const controller = new AbortController();
setTimeout(() => controller.abort(new Error('ts gave up')), 50);
await outcome('Execute aborted after 50 ms', () => client.call('live-go', 'Execute', execute('live-go.upper', 'slow'), { timeoutMs: 5000, signal: controller.signal }).catch((e) => { if (e instanceof CancelledError) return 'CancelledError as expected'; throw e; }));

log('done; keeping ts-echo up 8 s for the Go host…');
await sleep(8000);
await client.close();
await server.stop();
log('bye');
