/** Unit tests for the Valkey driver module that need no server: URL parsing, the stream-entry field mapping, helpers. */
import { describe, expect, it } from 'vitest';
import { NotConnectedError } from '../../driver';
import { loadDriverModule } from '../index';
import valkeyModule, { fromFields, toFields, valkey, valkeyConfigFrom } from './index';

describe('valkeyConfigFrom', () => {
  it('accepts the four schemes and turns on TLS only for the secure ones', () => {
    expect(valkeyConfigFrom('v', 'redis://127.0.0.1:56379')).toEqual({ connectionId: 'v', url: 'redis://127.0.0.1:56379' });
    expect(valkeyConfigFrom('v', 'valkey://valkey:6379')).toEqual({ connectionId: 'v', url: 'redis://valkey:6379' });
    expect(valkeyConfigFrom('v', 'rediss://valkey:6380')).toEqual({ connectionId: 'v', url: 'rediss://valkey:6380', tls: true });
    expect(valkeyConfigFrom('v', 'valkeys://valkey:6380')).toEqual({ connectionId: 'v', url: 'rediss://valkey:6380', tls: true });
    expect(valkeyConfigFrom('v', 'rediss://valkey:6380', { tls: false }).tls).toBeUndefined();
    expect(valkeyConfigFrom('v', 'redis://valkey:6379', { tls: true })).toMatchObject({ url: 'rediss://valkey:6379', tls: true });
  });

  it('reads the database, credentials and prefixes, with the connection fields winning', () => {
    expect(valkeyConfigFrom('v', 'redis://alice:p%40ss@valkey:6379/3')).toMatchObject({ username: 'alice', password: 'p@ss', db: 3 });
    expect(valkeyConfigFrom('v', 'redis://valkey:6379/3', { db: '5', username: 'bob', password: 'pw', prefix: 'acme', keyPrefix: 'lf:' })).toEqual({
      connectionId: 'v',
      url: 'redis://valkey:6379',
      prefix: 'acme',
      username: 'bob',
      password: 'pw',
      db: 5,
      keyPrefix: 'lf:',
    });
    expect(valkeyConfigFrom('v', 'redis://valkey', { maxLen: '500', claimIdleMs: 2000, blockMs: 'x' })).toMatchObject({ maxLen: 500, claimIdleMs: 2000 });
    expect(valkeyConfigFrom('v', 'redis://valkey').db).toBeUndefined();
  });

  it('rejects other schemes, missing hosts and bad database indexes', () => {
    expect(() => valkeyConfigFrom('v', 'nats://valkey:6379')).toThrow(/redis:\/\/, rediss:\/\//);
    expect(() => valkeyConfigFrom('v', 'not a url')).toThrow(/redis:\/\/host:6379/);
    expect(() => valkeyConfigFrom('v', 'redis://valkey:6379/two')).toThrow(/database index/);
    expect(() => valkeyConfigFrom('v', 'redis://valkey:6379', { db: -1 })).toThrow(/database index/);
  });
});

describe('stream entry fields', () => {
  it('round-trips headers as h:<name> fields and the body as bytes', () => {
    const body = new Uint8Array([0, 1, 2, 255, 254]);
    const fields = toFields({ headers: { 'Content-Type': 'application/octet-stream', specversion: '1.0', lfenc: 'aes-256-gcm' }, body });
    expect(fields.filter((_, i) => i % 2 === 0)).toEqual(['h:content-type', 'h:specversion', 'h:lfenc', 'b']);
    const back = fromFields(fields.map((f) => (typeof f === 'string' ? Buffer.from(f) : f)));
    expect(back.headers).toEqual({ 'content-type': 'application/octet-stream', specversion: '1.0', lfenc: 'aes-256-gcm' });
    expect([...back.body]).toEqual([0, 1, 2, 255, 254]);
  });

  it('ignores fields that are neither headers nor the body', () => {
    expect(fromFields([Buffer.from('x'), Buffer.from('1'), Buffer.from('b'), Buffer.from('{}')])).toEqual({ headers: {}, body: new Uint8Array(Buffer.from('{}')) });
    expect(fromFields([]).body.byteLength).toBe(0);
  });
});

describe('module and SDK helper', () => {
  it('declares its kind, label, fields and capabilities, and loadDriverModule finds it', async () => {
    expect(valkeyModule.kind).toBe('valkey');
    expect(valkeyModule.fields?.map((f) => f.name)).toEqual(['keyPrefix', 'db']);
    expect(valkeyModule.capabilities).toMatchObject({ replies: 'reply-channel', buffering: true, undeliverable: 'inferred', persistence: 'disk', headers: true, nack: true, attempts: true });
    expect(valkeyModule.create().capabilities).toEqual(valkeyModule.capabilities);
    expect((await loadDriverModule('valkey'))?.label).toBe(valkeyModule.label);
  });

  it('builds a broker target with the env connection id by default', () => {
    const target = valkey({ url: 'redis://127.0.0.1:56379', keyPrefix: 'lf:' });
    expect(target.kind).toBe('valkey');
    expect(target.config).toEqual({ connectionId: 'env-valkey', url: 'redis://127.0.0.1:56379', keyPrefix: 'lf:' });
    expect(target.driver().kind).toBe('valkey');
    expect(() => valkey({ url: '' })).toThrow(/url/);
  });

  it('refuses to publish, consume or declare before connecting without touching the client library', async () => {
    const driver = valkeyModule.create();
    const event = { headers: { 'content-type': 'application/json' }, body: new Uint8Array() };
    await expect(driver.publish('x', event)).rejects.toBeInstanceOf(NotConnectedError);
    await expect(driver.consume('x', { prefetch: 1, ackMode: 'auto' }, async () => {})).rejects.toBeInstanceOf(NotConnectedError);
    await expect(driver.stats!('x')).rejects.toBeInstanceOf(NotConnectedError);
    await driver.close();
  });
});
