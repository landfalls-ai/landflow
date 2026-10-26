/**
 * Cross-language check over SQS, TypeScript side (see ../crosslang_test.go, which runs this with the repo's tsx).
 *
 * LIVE_URL is the LocalStack endpoint, LIVE_PREFIX the channel prefix. It starts a TS MessagingServer ("ts-echo", one echo
 * node) and a MessagingClient that waits for the Go plugin "live-go" to announce, then calls Health, GetManifest (checking
 * the announced manifest hash), Execute in both delivery modes, LoadOptions, an unknown node, a stale manifest hash and an
 * aborted call, printing one `RESULT <label> <json>` line per outcome for the Go test to assert on. It keeps ts-echo up
 * until stdin closes, so the Go host can call it. Only the explicit endpoint and dummy credentials are used.
 */
import { createHash } from 'node:crypto';
import { Keyring, MessagingClient, MessagingServer, DispatchError, RemoteError, CancelledError } from '../../../../../packages/transports/src/index.ts';
import { sqs } from '../../../../../packages/transports/src/drivers/sqs/index.ts';

process.env.AWS_SHARED_CREDENTIALS_FILE = '/dev/null';
process.env.AWS_CONFIG_FILE = '/dev/null';
const url = process.env.LIVE_URL ?? 'http://127.0.0.1:54566';
const prefix = process.env.LIVE_PREFIX ?? 'lflive';
const keyring = Keyring.fromEnv();
const log = (...args: unknown[]) => console.log('[ts]', ...args);
const result = (label: string, value: unknown) => console.log(`RESULT ${label} ${JSON.stringify(value)}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const t = sqs({ connectionId: 'sqs-live', prefix, endpoint: url, accessKeyId: 'test', secretAccessKey: 'test', visibilityTimeoutSeconds: 5, waitTimeSeconds: 2, fanoutRefreshMs: 500 });
const manifest = {
  protocol: 'landflow.plugin/v1' as const,
  plugin: { id: 'ts-echo', name: 'TS Echo', version: '0.0.1', language: 'typescript' as const },
  nodes: [{ name: 'echo', displayName: 'Echo', description: '', version: 1, kind: 'action' as const, inputs: [{ type: 'main' as const }], outputs: [{ type: 'main' as const }], properties: [], idempotent: true }],
  maxConcurrency: 2,
};
const server = await MessagingServer.start({
  driver: t.driver(), config: t.config, keyring, pluginId: 'ts-echo', version: '0.0.1', manifest, log: () => {},
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
console.log(`READY ${server.endpoint}`);

const client = await MessagingClient.start({ driver: t.driver(), config: t.config, keyring, hostInstanceId: 'ts-host', statsIntervalMs: 0, log: () => {} });
log('waiting for live-go to announce…');
const until = Date.now() + 40_000;
while (!client.plugin('live-go')?.instances.length) {
  if (Date.now() > until) {
    result('discovered', { error: 'live-go never announced' });
    process.exit(1);
  }
  await sleep(100);
}
const announced = client.plugin('live-go')!;
result('discovered', { pluginId: announced.pluginId, endpoint: announced.endpoint, manifestHash: announced.manifestHash, instances: announced.instances.length });

const outcome = async <T>(label: string, fn: () => Promise<T>) => {
  try {
    const value = await fn();
    result(label, { ok: value });
    return value;
  } catch (error) {
    result(label, { error: (error as Error).constructor.name, message: (error as Error).message, code: error instanceof RemoteError ? error.remoteCode : undefined });
    return undefined;
  }
};
await outcome('health', () => client.call('live-go', 'Health', {}, { timeoutMs: 15_000 }));
const got = await outcome('manifest', () => client.invoke('live-go', 'GetManifest', {}, { timeoutMs: 15_000 }));
if (got) {
  const hash = createHash('sha256').update(JSON.stringify(got.body)).digest('hex').slice(0, 16);
  result('manifest-hash', { announced: announced.manifestHash, lfmanifest: got.attributes.lfmanifest, computed: hash, match: hash === announced.manifestHash });
}
const execute = (type: string, value: string) => ({
  protocol: 'landflow.plugin/v1' as const, executionId: 'live-ts-1', mode: 'manual' as const,
  node: { id: 'n1', name: 'upper', type, typeVersion: 1 }, parameters: { field: 'value' }, itemParameters: [{}],
  inputs: [[{ json: { value } }]], credentials: { api: { token: 'ts-token' } },
});
await outcome('execute-amo', () => client.call('live-go', 'Execute', execute('live-go.upper', 'hello from ts'), { timeoutMs: 15_000 }));
await outcome('execute-alo', () => client.call('live-go', 'Execute', execute('live-go.upper', 'again'), { timeoutMs: 15_000, delivery: 'at-least-once' }));
await outcome('load-options', () => client.call('live-go', 'LoadOptions', { nodeType: 'live-go.upper', method: 'modes', parameters: {} }, { timeoutMs: 15_000 }));
await outcome('unknown-node', () => client.call('live-go', 'Execute', execute('live-go.nope', 'x'), { timeoutMs: 15_000 }));
await outcome('stale-manifest', () => client.call('live-go', 'Health', {}, { timeoutMs: 15_000, manifestHash: 'deadbeefdeadbeef' }));
const controller = new AbortController();
setTimeout(() => controller.abort(new Error('ts gave up')), 50);
await outcome('aborted', () => client.call('live-go', 'Execute', execute('live-go.upper', 'slow'), { timeoutMs: 15_000, signal: controller.signal }).catch((e) => { if (e instanceof CancelledError) return 'CancelledError'; throw e; }));
console.log('DONE');

// Stay up for the Go host until stdin closes (the Go test closes it when it is done).
await new Promise<void>((resolve) => {
  process.stdin.on('end', () => resolve());
  process.stdin.on('close', () => resolve());
  process.stdin.resume();
  setTimeout(resolve, 90_000);
});
await client.close();
await server.stop();
log('bye');
process.exit(0);
