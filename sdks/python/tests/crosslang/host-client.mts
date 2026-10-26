/**
 * Cross-language helper for sdks/python/tests/test_transport_crosslang_live.py: the TypeScript host side (a `MessagingClient`
 * from packages/transports with the real driver for a kind) calling a Python plugin over a live broker. Run with
 * `packages/transports/node_modules/.bin/tsx host-client.mts`; JSON in on stdin, JSON out on stdout.
 *
 * Input: { kind, url, secret, registrySecret?, prefix?, pluginId, waitMs?, calls: [{ method, body, timeoutMs?, delivery?, idempotencyKey?, instanceId?, cancelAfterMs? }] }
 * Output: { plugin: AnnouncedPlugin | null, results: [{ body, instanceId, attributes } | { error, code, knowledge }] }
 */
import { Keyring, MessagingClient } from '../../../../packages/transports/src/index.ts';
import { loadDriverModule } from '../../../../packages/transports/src/drivers/index.ts';

interface Call { method: string; body: unknown; timeoutMs?: number; delivery?: 'at-most-once' | 'at-least-once'; idempotencyKey?: string; instanceId?: string; cancelAfterMs?: number }
interface Input { kind: string; url: string; secret: string; registrySecret?: string; prefix?: string; pluginId: string; waitMs?: number; calls: Call[]; options?: Record<string, unknown> }

const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Input;

const module = await loadDriverModule(input.kind as never);
if (!module) throw new Error(`no TS driver for ${input.kind}`);
const config = module.configFrom('xl-host', input.url, { ...(input.prefix && { prefix: input.prefix }), ...input.options });
const client = new MessagingClient({ driver: module.create(), config, keyring: new Keyring(input.secret), registrySecret: input.registrySecret ?? null, statsIntervalMs: 0, log: () => {} });
await client.start();
const until = Date.now() + (input.waitMs ?? 15_000);
while (Date.now() < until && !(client.plugin(input.pluginId)?.instances.length)) await new Promise((r) => setTimeout(r, 50));
const results: unknown[] = [];
for (const call of input.calls) {
  const controller = new AbortController();
  if (call.cancelAfterMs) setTimeout(() => controller.abort(new Error('cancelled by the TS host')), call.cancelAfterMs);
  try {
    const reply = await client.invoke(input.pluginId, call.method as never, call.body as never, {
      timeoutMs: call.timeoutMs ?? 10_000, delivery: call.delivery, idempotencyKey: call.idempotencyKey, instanceId: call.instanceId, signal: controller.signal,
    });
    results.push({ body: reply.body, instanceId: reply.instanceId, attributes: reply.attributes });
  } catch (error) {
    const e = error as { message: string; code?: string; knowledge?: string; remoteCode?: string };
    results.push({ error: e.message, code: e.remoteCode ?? e.code, knowledge: e.knowledge });
  }
}
const plugin = client.plugin(input.pluginId) ?? null;
await client.close();
process.stdout.write(JSON.stringify({ plugin, results }));
process.exit(0);
