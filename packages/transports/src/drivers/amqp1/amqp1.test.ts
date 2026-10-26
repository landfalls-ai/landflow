/** Unit tests that need no broker: `configFrom`, the header mapping, attempts, role inference, the SDK helper and the module shape. */
import { describe, expect, it } from 'vitest';
import { NotConnectedError } from '../../driver';
import amqp1Module, { AMQP1_CAPABILITIES, Amqp1Driver, amqp1, amqp1ConfigFrom, amqp1PropertiesToHeaders, attemptOf, headersToAmqp1Properties, inferRole } from './index';

describe('amqp1 configFrom', () => {
  it('accepts amqp:// and amqps:// URLs, moving credentials out of the URL', () => {
    expect(amqp1ConfigFrom('a', 'amqp://artemis:5672')).toEqual({ connectionId: 'a', url: 'amqp://artemis:5672' });
    expect(amqp1ConfigFrom('a', 'amqp://u:p%40ss@artemis:5672')).toEqual({ connectionId: 'a', url: 'amqp://artemis:5672', username: 'u', password: 'p@ss' });
    expect(amqp1ConfigFrom('a', 'amqps://artemis:5671')).toMatchObject({ url: 'amqps://artemis:5671', tls: true });
    expect(amqp1ConfigFrom('a', 'amqp+ssl://artemis:5671').tls).toBe(true);
    expect(amqp1ConfigFrom('a', 'amqp://artemis', { tls: true }).url).toBe('amqps://artemis');
    expect(amqp1ConfigFrom('a', ' amqp://127.0.0.1:55674 ').connectionId).toBe('a');
  });

  it('lets the username and password fields win and carries the prefix and the limit', () => {
    const config = amqp1ConfigFrom('a', 'amqp://old:pw@host:5672', { username: 'landflow', password: 's3cret', prefix: 'acme', maxMessageBytes: 4096 });
    expect(config).toEqual({ connectionId: 'a', url: 'amqp://host:5672', username: 'landflow', password: 's3cret', prefix: 'acme', maxMessageBytes: 4096 });
  });

  it('refuses malformed input with a readable message', () => {
    expect(() => amqp1ConfigFrom('a', '')).toThrow(/needs a URL/);
    expect(() => amqp1ConfigFrom('a', 'not a url')).toThrow(/is not a URL/);
    expect(() => amqp1ConfigFrom('a', 'mqtt://host:1883')).toThrow(/amqp:\/\/ or amqps:\/\//);
  });
});

describe('amqp1 mapping', () => {
  it('maps bare CloudEvents headers to cloudEvents_ application properties plus content-type, both ways', () => {
    const bare = { specversion: '1.0', id: 'abc', type: 'dev.landflow.plugin.v1.execute.request', 'content-type': 'application/octet-stream', lfsig: 'ff' };
    const { properties, contentType } = headersToAmqp1Properties(bare);
    expect(contentType).toBe('application/octet-stream');
    expect(properties).toEqual({ cloudEvents_specversion: '1.0', cloudEvents_id: 'abc', cloudEvents_type: 'dev.landflow.plugin.v1.execute.request', cloudEvents_lfsig: 'ff' });
    expect(amqp1PropertiesToHeaders({ ...properties, JMSXDeliveryCount: 2, other: Buffer.from('zzz') }, contentType)).toEqual(bare);
    expect(amqp1PropertiesToHeaders(undefined, undefined)).toEqual({});
  });

  it('counts attempts from delivery-count and infers roles from the core naming', () => {
    expect(attemptOf({})).toBe(1);
    expect(attemptOf({ delivery_count: 0 })).toBe(1);
    expect(attemptOf({ delivery_count: 3 })).toBe(4);
    expect(inferRole('landflow.v1.plugin.twilio')).toBe('queue');
    expect(inferRole('landflow.v1.instance.twilio.abc')).toBe('queue');
    expect(inferRole('landflow.v1.control.twilio')).toBe('topic');
    expect(inferRole('landflow.v1.registry')).toBe('topic');
    expect(inferRole('landflow.v1.reply.host1')).toBe('topic');
    expect(inferRole('whatever')).toBe('queue');
  });
});

describe('amqp1 driver module', () => {
  it('exposes the module shape the loader and the SDK helper rely on', () => {
    expect(amqp1Module.kind).toBe('amqp1');
    expect(amqp1Module.label).toMatch(/AMQP 1\.0/);
    expect(amqp1Module.exampleUrl).toMatch(/^amqp:\/\//);
    expect(amqp1Module.capabilities).toBe(AMQP1_CAPABILITIES);
    expect(amqp1Module.create().capabilities).toEqual(AMQP1_CAPABILITIES);
    expect(AMQP1_CAPABILITIES).toMatchObject({ replies: 'native', workSharing: true, buffering: true, ttl: true, undeliverable: 'inferred', nack: true, attempts: true, orderingKeys: true });
    expect(typeof amqp1Module.create().request).toBe('function');
    expect(typeof amqp1Module.create().stats).toBe('function');
    const target = amqp1({ url: 'amqp://127.0.0.1:55674' });
    expect(target.kind).toBe('amqp1');
    expect(target.config).toEqual({ url: 'amqp://127.0.0.1:55674', connectionId: 'env-amqp1' });
    expect(amqp1({ url: 'amqp://h', connectionId: 'mine' }).config.connectionId).toBe('mine');
    expect(target.driver()).toBeInstanceOf(Amqp1Driver);
    expect(() => amqp1({ url: '' })).toThrow(/url/);
  });

  it('throws NotConnectedError before connect() and after close(), and closes idempotently', async () => {
    const driver = new Amqp1Driver();
    await expect(driver.publish('x', { headers: {}, body: new Uint8Array() })).rejects.toBeInstanceOf(NotConnectedError);
    await expect(driver.request('x', { headers: {}, body: new Uint8Array() }, { timeoutMs: 10 })).rejects.toBeInstanceOf(NotConnectedError);
    await driver.close();
    await driver.close();
    await expect(driver.publish('x', { headers: {}, body: new Uint8Array() })).rejects.toBeInstanceOf(NotConnectedError);
  });

  it('rejects connect() to an unreachable broker without sending anything', async () => {
    const driver = new Amqp1Driver();
    await expect(driver.connect({ connectionId: 'dead', url: 'amqp://u:secret@127.0.0.1:1', connectTimeoutMs: 2_000 })).rejects.toThrow(/cannot connect to amqp:\/\/u:\*\*\*@127.0.0.1:1/);
    await expect(driver.publish('x', { headers: {}, body: new Uint8Array() })).rejects.toBeInstanceOf(NotConnectedError);
  });
});
