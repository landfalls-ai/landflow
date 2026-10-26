/** Unit tests that need no broker: `configFrom`, the header mapping, attempts, role inference, the SDK helper and the module shape. */
import { describe, expect, it } from 'vitest';
import { NotConnectedError } from '../../driver';
import amqpModule, { AMQP_CAPABILITIES, AmqpDriver, amqp, amqpConfigFrom, amqpHeadersToWire, attemptOf, connectionUrl, inferRole, wireToAmqpHeaders } from './index';

describe('amqp configFrom', () => {
  it('accepts amqp:// and amqps:// URLs with credentials and a vhost', () => {
    expect(amqpConfigFrom('rabbit', 'amqp://u:p@rabbitmq:5672/').url).toBe('amqp://u:p@rabbitmq:5672/');
    expect(amqpConfigFrom('rabbit', 'amqps://rabbitmq/prod')).toMatchObject({ url: 'amqps://rabbitmq/prod', tls: true });
    expect(amqpConfigFrom('rabbit', 'amqp+ssl://rabbitmq:5671/').tls).toBe(true);
    expect(amqpConfigFrom('rabbit', 'amqp://rabbitmq', { tls: true }).url).toBe('amqps://rabbitmq');
    expect(amqpConfigFrom('rabbit', ' amqp://127.0.0.1:55672 ').connectionId).toBe('rabbit');
  });

  it('lets the username and password fields win and carries the prefix and queue type', () => {
    const config = amqpConfigFrom('r', 'amqp://old:pw@host:5672/', { username: 'landflow', password: 's3cret', prefix: 'acme', queueType: 'classic' });
    expect(config).toMatchObject({ username: 'landflow', password: 's3cret', prefix: 'acme', queueType: 'classic' });
    expect(connectionUrl(config)).toBe('amqp://landflow:s3cret@host:5672/');
    expect(connectionUrl({ connectionId: 'r', url: 'amqp://host/', username: 'a b', password: 'p@ss/w' })).toBe('amqp://a%20b:p%40ss%2Fw@host/');
    expect(connectionUrl({ connectionId: 'r', url: 'amqp://host/', tls: true })).toBe('amqps://host/');
  });

  it('refuses malformed input with a readable message', () => {
    expect(() => amqpConfigFrom('r', '')).toThrow(/needs a URL/);
    expect(() => amqpConfigFrom('r', 'not a url')).toThrow(/is not a URL/);
    expect(() => amqpConfigFrom('r', 'kafka://host:9092')).toThrow(/amqp:\/\/ or amqps:\/\//);
  });
});

describe('amqp headers', () => {
  it('maps bare CloudEvents headers to cloudEvents_ headers plus the contentType property, both ways', () => {
    const bare = { specversion: '1.0', id: 'abc', type: 'dev.landflow.plugin.v1.execute.request', 'content-type': 'application/octet-stream', lfsig: 'ff' };
    const { headers, contentType } = wireToAmqpHeaders(bare);
    expect(contentType).toBe('application/octet-stream');
    expect(headers).toEqual({ cloudEvents_specversion: '1.0', cloudEvents_id: 'abc', cloudEvents_type: 'dev.landflow.plugin.v1.execute.request', cloudEvents_lfsig: 'ff' });
    expect(amqpHeadersToWire({ ...headers, 'x-delivery-count': 2, other: Buffer.from('zzz') }, contentType)).toEqual(bare);
    expect(amqpHeadersToWire(undefined, undefined)).toEqual({});
  });

  it('counts attempts from x-delivery-count, else from the redelivered flag', () => {
    const base = { fields: { redelivered: false } as never, properties: { headers: {} } as never };
    expect(attemptOf(base)).toBe(1);
    expect(attemptOf({ ...base, fields: { redelivered: true } as never })).toBe(2);
    expect(attemptOf({ ...base, properties: { headers: { 'x-delivery-count': 3 } } as never })).toBe(4);
  });

  it('infers the role of undeclared channels from the core naming', () => {
    expect(inferRole('landflow.v1.plugin.twilio')).toBe('queue');
    expect(inferRole('landflow.v1.instance.twilio.abc')).toBe('queue');
    expect(inferRole('landflow.v1.control.twilio')).toBe('exchange');
    expect(inferRole('landflow.v1.registry')).toBe('exchange');
    expect(inferRole('landflow.v1.reply.host1')).toBe('exchange');
    expect(inferRole('whatever')).toBe('queue');
  });
});

describe('amqp driver module', () => {
  it('exposes the module shape the loader and the SDK helper rely on', () => {
    expect(amqpModule.kind).toBe('amqp');
    expect(amqpModule.label).toMatch(/RabbitMQ/);
    expect(amqpModule.exampleUrl).toMatch(/^amqp:\/\//);
    expect(amqpModule.capabilities).toBe(AMQP_CAPABILITIES);
    expect(amqpModule.create().capabilities).toEqual(AMQP_CAPABILITIES);
    expect(AMQP_CAPABILITIES.replies).toBe('native');
    expect(typeof amqpModule.create().request).toBe('function');
    const target = amqp({ url: 'amqp://127.0.0.1:55672/' });
    expect(target.kind).toBe('amqp');
    expect(target.config).toEqual({ url: 'amqp://127.0.0.1:55672/', connectionId: 'env-amqp' });
    expect(amqp({ url: 'amqp://h/', connectionId: 'mine' }).config.connectionId).toBe('mine');
    expect(target.driver()).toBeInstanceOf(AmqpDriver);
  });

  it('throws NotConnectedError before connect() and after close(), and closes idempotently', async () => {
    const driver = new AmqpDriver();
    await expect(driver.publish('x', { headers: {}, body: new Uint8Array() })).rejects.toBeInstanceOf(NotConnectedError);
    await expect(driver.request('x', { headers: {}, body: new Uint8Array() }, { timeoutMs: 10 })).rejects.toBeInstanceOf(NotConnectedError);
    await driver.close();
    await driver.close();
    await expect(driver.publish('x', { headers: {}, body: new Uint8Array() })).rejects.toBeInstanceOf(NotConnectedError);
  });

  it('rejects connect() to an unreachable broker without sending anything', async () => {
    const driver = new AmqpDriver();
    await expect(driver.connect({ connectionId: 'dead', url: 'amqp://u:secret@127.0.0.1:1/' })).rejects.toThrow(/cannot connect to amqp:\/\/u:\*\*\*@127.0.0.1:1\/.*ECONNREFUSED/);
    await expect(driver.publish('x', { headers: {}, body: new Uint8Array() })).rejects.toBeInstanceOf(NotConnectedError);
  });
});
