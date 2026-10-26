/** Unit tests for the two NATS driver modules that need no broker: URL parsing, header mapping, helpers and capabilities. */
import { describe, expect, it } from 'vitest';
import { NotConnectedError, prefixHeaders, unprefixHeaders } from '../../driver';
import { availableDriverKinds, loadDriverModule } from '../index';
import natsModule, { nats, natsConfigFrom, NATS_HEADER_PREFIX } from './index';
import jetstreamModule, { jetstream, jetstreamConfigFrom, streamNameOf } from './jetstream';

describe('natsConfigFrom', () => {
  it('parses a plain URL and a host list', () => {
    expect(natsConfigFrom('nats-main', 'nats://127.0.0.1:54222')).toEqual({ connectionId: 'nats-main', servers: ['127.0.0.1:54222'] });
    expect(natsConfigFrom('c', 'nats://a:4222,b:4222, c:4222').servers).toEqual(['a:4222', 'b:4222', 'c:4222']);
  });

  it('reads credentials, tokens and TLS from the URL, with the connection fields winning', () => {
    expect(natsConfigFrom('c', 'nats://alice:s%20cret@nats:4222')).toMatchObject({ user: 'alice', pass: 's cret' });
    expect(natsConfigFrom('c', 'nats://tok3n@nats:4222')).toMatchObject({ token: 'tok3n' });
    expect(natsConfigFrom('c', 'nats://nats:4222?token=t2').token).toBe('t2');
    expect(natsConfigFrom('c', 'tls://nats:4222')).toMatchObject({ tls: true });
    expect(natsConfigFrom('c', 'nats://nats:4222', { username: 'bob', password: 'pw', tls: true, prefix: 'acme' })).toEqual({ connectionId: 'c', servers: ['nats:4222'], user: 'bob', pass: 'pw', tls: true, prefix: 'acme' });
    expect(natsConfigFrom('c', 'tls://nats:4222', { tls: false }).tls).toBeUndefined();
    expect(natsConfigFrom('c', 'nats://nats:4222', { maxMessageBytes: '65536' }).maxMessageBytes).toBe(65536);
  });

  it('rejects other schemes, empty hosts and mixed authentication', () => {
    expect(() => natsConfigFrom('c', 'redis://nats:4222')).toThrow(/nats:\/\/host:4222/);
    expect(() => natsConfigFrom('c', 'nats://')).toThrow();
    expect(() => natsConfigFrom('c', 'nats://a b:4222')).toThrow(/invalid host/);
    expect(() => natsConfigFrom('c', 'nats://alice:pw@nats:4222?token=t')).toThrow(/either a username and password or a token/);
  });

  it('adds the JetStream options', () => {
    expect(jetstreamConfigFrom('js', 'nats://nats:4222', { streamPrefix: 'acme-', ackWaitMs: '15000', storage: 'memory', replicas: 3 })).toEqual({
      connectionId: 'js',
      servers: ['nats:4222'],
      streamPrefix: 'acme-',
      ackWaitMs: 15000,
      storage: 'memory',
      replicas: 3,
    });
    expect(jetstreamConfigFrom('js', 'nats://nats:4222', { ackWaitMs: 'soon', storage: 'tape' })).toEqual({ connectionId: 'js', servers: ['nats:4222'] });
  });
});

describe('header mapping', () => {
  it('uses the CloudEvents NATS binding prefix and comes back lower-cased without driver headers', () => {
    const headers = { 'content-type': 'application/json', specversion: '1.0', id: 'abc', lfsig: 'ff' };
    const onWire = prefixHeaders(headers, NATS_HEADER_PREFIX);
    expect(onWire).toEqual({ 'content-type': 'application/json', 'ce-specversion': '1.0', 'ce-id': 'abc', 'ce-lfsig': 'ff' });
    expect(unprefixHeaders({ ...onWire, 'CE-Subject': 'x.y', 'Landflow-Reply': '_INBOX.1', 'Nats-Msg-Id': 'n' }, NATS_HEADER_PREFIX)).toEqual({ ...headers, subject: 'x.y' });
  });

  it('turns channel names into stream and consumer names', () => {
    expect(streamNameOf('landflow.v1.plugin.twilio')).toBe('landflow_v1_plugin_twilio');
    expect(streamNameOf('landflow.v1.plugin.twilio', 'acme-')).toBe('acme-landflow_v1_plugin_twilio');
  });
});

describe('modules and SDK helpers', () => {
  it('declare their kinds, labels and capabilities, and loadDriverModule finds them', async () => {
    expect(natsModule.kind).toBe('nats');
    expect(jetstreamModule.kind).toBe('jetstream');
    expect(natsModule.capabilities).toMatchObject({ replies: 'native', buffering: false, undeliverable: 'reported', persistence: 'memory', headers: true });
    expect(jetstreamModule.capabilities).toMatchObject({ replies: 'native', buffering: true, undeliverable: 'inferred', persistence: 'disk', nack: true, attempts: true });
    expect(natsModule.create().capabilities).toEqual(natsModule.capabilities);
    expect(jetstreamModule.create().capabilities).toEqual(jetstreamModule.capabilities);
    expect(natsModule.create().kind).toBe('nats');
    expect(jetstreamModule.create().kind).toBe('jetstream');
    expect(availableDriverKinds()).toEqual(expect.arrayContaining(['nats', 'jetstream', 'valkey']));
    expect((await loadDriverModule('nats'))?.label).toBe(natsModule.label);
    expect((await loadDriverModule('jetstream'))?.exampleUrl).toBe('nats://127.0.0.1:54222');
  });

  it('build broker targets with the env connection id by default', () => {
    const target = nats({ servers: 'nats://127.0.0.1:54222' });
    expect(target.kind).toBe('nats');
    expect(target.config).toEqual({ connectionId: 'env-nats', servers: 'nats://127.0.0.1:54222' });
    expect(target.driver().kind).toBe('nats');
    const js = jetstream({ servers: ['a:4222'], connectionId: 'js-main', streamPrefix: 'p-' });
    expect(js.kind).toBe('jetstream');
    expect(js.config).toEqual({ connectionId: 'js-main', servers: ['a:4222'], streamPrefix: 'p-' });
    expect(js.driver().capabilities.buffering).toBe(true);
    expect(() => nats({ servers: [] })).toThrow(/servers/);
  });

  it('refuses to publish, consume or declare before connecting without touching the client library', async () => {
    const event = { headers: { 'content-type': 'application/json' }, body: new Uint8Array() };
    for (const driver of [natsModule.create(), jetstreamModule.create()]) {
      await expect(driver.publish('x', event)).rejects.toBeInstanceOf(NotConnectedError);
      await expect(driver.request!('x', event, { timeoutMs: 10 })).rejects.toBeInstanceOf(NotConnectedError);
      await expect(driver.consume('x', { prefetch: 1, ackMode: 'auto' }, async () => {})).rejects.toBeInstanceOf(NotConnectedError);
      await expect(driver.declare([])).rejects.toBeInstanceOf(NotConnectedError);
      await driver.close();
    }
  });
});
