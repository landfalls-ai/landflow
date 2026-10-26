/**
 * A `nats` driver and a `jetstream` driver on the same server with the same channel names, at the same time (docs/protocol.md
 * §14.9). Gated on `LANDFLOW_TEST_NATS`; every name carries a unique prefix, and the run deletes its streams.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import type { ChannelSpec, Delivery, WireEvent } from '../../driver';
import natsModule from './index';
import jetstreamModule, { NatsDriver, type JetStreamConfig } from './jetstream';

const url = process.env.LANDFLOW_TEST_NATS;
const run = randomBytes(3).toString('hex');
const streamPrefix = `lftest-same-${run}-`;
const enc = new TextEncoder();
const dec = new TextDecoder();
const event = (text: string): WireEvent => ({ headers: { specversion: '1.0', id: text, type: 'test', source: 'test', 'content-type': 'text/plain' }, body: enc.encode(text) });
const until = async (cond: () => boolean, ms = 3_000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
};

if (!url) describe.skip('nats + jetstream on one server (set LANDFLOW_TEST_NATS=nats://127.0.0.1:54222 to run)', () => {});
else {
  describe('nats + jetstream on one server, same prefix', () => {
    const prefix = `lftest-same-${run}`;
    const plugin = `${prefix}.v1.plugin.echo`;
    const registry = `${prefix}.v1.registry`;
    const spec = (name: string, role: ChannelSpec['role'], shared: boolean): ChannelSpec => ({ name, role, delivery: shared ? 'shared' : 'broadcast', durable: shared });
    const jsConfig: JetStreamConfig = { ...jetstreamModule.configFrom('same-js', url, { streamPrefix }), connectTimeoutMs: 3_000 };

    afterAll(async () => {
      const driver = jetstreamModule.create() as NatsDriver<JetStreamConfig>;
      await driver.connect(jsConfig);
      try {
        const { jetstreamManager } = await import('@nats-io/jetstream');
        const jsm = await jetstreamManager(driver.connection!);
        for await (const name of jsm.streams.names()) if (name.startsWith(streamPrefix)) await jsm.streams.delete(name);
      } finally {
        await driver.close();
      }
    });

    it('keeps requests, replies and announces of each kind to its own side', async () => {
      const core = natsModule.create();
      const js = jetstreamModule.create();
      await core.connect({ ...natsModule.configFrom('same-core', url), connectTimeoutMs: 3_000 });
      await js.connect(jsConfig);
      const seen: Record<string, string[]> = { core: [], js: [], coreReg: [], jsReg: [] };
      const subs = [];
      try {
        await core.declare([spec(plugin, 'request', true), spec(registry, 'registry', false)]);
        await js.declare([spec(plugin, 'request', true), spec(registry, 'registry', false)]);
        const answer = (who: 'core' | 'js') => async (e: WireEvent, d: Delivery) => {
          seen[who].push(dec.decode(e.body));
          await d.reply?.(event(`${who}:${dec.decode(e.body)}`));
          await d.ack();
        };
        subs.push(await core.consume(plugin, { group: plugin, prefetch: 4, ackMode: 'manual' }, answer('core')));
        subs.push(await js.consume(plugin, { group: plugin, prefetch: 4, ackMode: 'manual' }, answer('js')));
        subs.push(await core.consume(registry, { prefetch: 4, ackMode: 'auto' }, async (e) => void seen.coreReg.push(dec.decode(e.body))));
        subs.push(await js.consume(registry, { prefetch: 4, ackMode: 'auto' }, async (e) => void seen.jsReg.push(dec.decode(e.body))));

        const viaCore = await core.request!(plugin, event('a'), { timeoutMs: 3_000 });
        const viaJs = await js.request!(plugin, event('b'), { timeoutMs: 3_000 });
        expect(viaCore.outcome).toBe('replied');
        expect(viaJs.outcome).toBe('replied');
        if (viaCore.outcome === 'replied') expect(dec.decode(viaCore.event.body)).toBe('core:a');
        if (viaJs.outcome === 'replied') expect(dec.decode(viaJs.event.body)).toBe('js:b');
        expect(seen.core).toEqual(['a']);
        expect(seen.js).toEqual(['b']);

        await core.publish(registry, event('from-core'));
        await js.publish(registry, event('from-js'));
        await until(() => seen.coreReg.length >= 1 && seen.jsReg.length >= 1);
        await new Promise((r) => setTimeout(r, 200));
        expect(seen.coreReg).toEqual(['from-core']);
        expect(seen.jsReg).toEqual(['from-js']);
      } finally {
        await Promise.allSettled(subs.map((s) => s.close()));
        await core.close();
        await js.close();
      }
    });
  });
}
