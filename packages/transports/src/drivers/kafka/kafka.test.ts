/** Unit tests that need no broker: `configFrom`, the header mapping, the SDK helper and the module shape. */
import { describe, expect, it } from 'vitest';
import { NotConnectedError, prefixHeaders, unprefixHeaders } from '../../driver';
import kafkaModule, { ATTEMPT_HEADER, KAFKA_CAPABILITIES, KAFKA_HEADER_PREFIX, KafkaDriver, kafka, kafkaConfigFrom, recordHeaders } from './index';

describe('kafka configFrom', () => {
  it('reads broker lists with and without a scheme, defaulting the port to 9092', () => {
    expect(kafkaConfigFrom('kafka-main', 'kafka://broker-1:9092,broker-2:9093').brokers).toEqual(['broker-1:9092', 'broker-2:9093']);
    expect(kafkaConfigFrom('k', ' 127.0.0.1:59092 ').brokers).toEqual(['127.0.0.1:59092']);
    expect(kafkaConfigFrom('k', 'kafka://a, b:1234').brokers).toEqual(['a:9092', 'b:1234']);
    expect(kafkaConfigFrom('k', 'kafka://[::1]:9092').brokers).toEqual(['[::1]:9092']);
    expect(kafkaConfigFrom('k', 'kafka://a:9092').connectionId).toBe('k');
    expect(kafkaConfigFrom('k', 'kafka://a:9092').ssl).toBeUndefined();
  });

  it('turns on TLS for kafkas:// and kafka+ssl://, or with the tls option', () => {
    expect(kafkaConfigFrom('k', 'kafkas://a:9093').ssl).toBe(true);
    expect(kafkaConfigFrom('k', 'kafka+ssl://a:9093').ssl).toBe(true);
    expect(kafkaConfigFrom('k', 'kafka://a:9092', { tls: true }).ssl).toBe(true);
  });

  it('maps username/password to SASL with a mechanism from the extra field', () => {
    expect(kafkaConfigFrom('k', 'kafka://a:9092', { username: 'u', password: 'p' }).sasl).toEqual({ mechanism: 'plain', username: 'u', password: 'p' });
    expect(kafkaConfigFrom('k', 'kafka://a:9092', { username: 'u', password: 'p', saslMechanism: 'SCRAM-SHA-512' }).sasl?.mechanism).toBe('scram-sha-512');
    expect(() => kafkaConfigFrom('k', 'kafka://a:9092', { username: 'u', saslMechanism: 'gssapi' })).toThrow(/SASL mechanism/);
    expect(kafkaConfigFrom('k', 'kafka://a:9092', { prefix: 'acme', partitions: 12, groupProtocol: 'classic' })).toMatchObject({ prefix: 'acme', partitions: 12, groupProtocol: 'classic' });
  });

  it('refuses malformed input with a readable message', () => {
    expect(() => kafkaConfigFrom('k', '')).toThrow(/broker list/);
    expect(() => kafkaConfigFrom('k', 'amqp://a:5672')).toThrow(/not a Kafka URL/);
    expect(() => kafkaConfigFrom('k', 'kafka://user:pw@a:9092')).toThrow(/username and password fields/);
    expect(() => kafkaConfigFrom('k', 'kafka://a:99999')).toThrow(/invalid port/);
  });
});

describe('kafka headers', () => {
  it('prefixes every CloudEvents header with ce_ and leaves content-type bare, both ways', () => {
    const bare = { specversion: '1.0', id: 'abc', type: 'dev.landflow.plugin.v1.health.request', 'content-type': 'application/json', lfsig: 'ff' };
    const onWire = prefixHeaders(bare, KAFKA_HEADER_PREFIX);
    expect(onWire).toEqual({ ce_specversion: '1.0', ce_id: 'abc', ce_type: 'dev.landflow.plugin.v1.health.request', 'content-type': 'application/json', ce_lfsig: 'ff' });
    const received = recordHeaders({ ...Object.fromEntries(Object.entries(onWire).map(([k, v]) => [k, Buffer.from(v)])), [ATTEMPT_HEADER]: '3', ce_multi: ['a', Buffer.from('b')] });
    expect(received[ATTEMPT_HEADER]).toBe('3');
    expect(received.ce_multi).toBe('b');
    expect(unprefixHeaders(received, KAFKA_HEADER_PREFIX)).toEqual({ ...bare, multi: 'b' });
  });
});

describe('kafka driver module', () => {
  it('exposes the module shape the loader and the SDK helper rely on', () => {
    expect(kafkaModule.kind).toBe('kafka');
    expect(kafkaModule.label).toBe('Kafka');
    expect(kafkaModule.exampleUrl).toMatch(/^kafka:\/\//);
    expect(kafkaModule.capabilities).toBe(KAFKA_CAPABILITIES);
    expect(kafkaModule.create().capabilities).toEqual(KAFKA_CAPABILITIES);
    expect(kafkaModule.configFrom('c', 'kafka://a:9092').connectionId).toBe('c');
    const target = kafka({ brokers: ['127.0.0.1:59092'] });
    expect(target.kind).toBe('kafka');
    expect(target.config).toEqual({ brokers: ['127.0.0.1:59092'], connectionId: 'env-kafka' });
    expect(kafka({ brokers: ['a:1'], connectionId: 'mine' }).config.connectionId).toBe('mine');
    expect(target.driver()).toBeInstanceOf(KafkaDriver);
  });

  it('throws NotConnectedError before connect() and after close(), and closes idempotently', async () => {
    const driver = new KafkaDriver();
    await expect(driver.publish('x', { headers: {}, body: new Uint8Array() })).rejects.toBeInstanceOf(NotConnectedError);
    await expect(driver.stats!('x')).rejects.toBeInstanceOf(NotConnectedError);
    await driver.close();
    await driver.close();
    await expect(driver.publish('x', { headers: {}, body: new Uint8Array() })).rejects.toBeInstanceOf(NotConnectedError);
  });

  it('rejects connect() to an unreachable broker without sending anything', async () => {
    const driver = new KafkaDriver();
    await expect(driver.connect({ connectionId: 'dead', brokers: ['127.0.0.1:1'], connectTimeoutMs: 1_500 })).rejects.toThrow(/cannot connect to 127.0.0.1:1/);
    await expect(driver.publish('x', { headers: {}, body: new Uint8Array() })).rejects.toBeInstanceOf(NotConnectedError);
  }, 15_000);
});
