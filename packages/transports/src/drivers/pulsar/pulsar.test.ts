/** Unit tests that need no broker: `configFrom`, topic naming, the SDK helper and the module shape. */
import { describe, expect, it } from 'vitest';
import { NotConnectedError } from '../../driver';
import pulsarModule, { PULSAR_CAPABILITIES, PulsarDriver, adminTopicPath, pulsar, pulsarConfigFrom, topicName } from './index';

describe('pulsar configFrom', () => {
  it('reads pulsar:// and pulsar+ssl:// URLs, defaulting the port', () => {
    expect(pulsarConfigFrom('pulsar-main', 'pulsar://127.0.0.1:56650')).toEqual({ connectionId: 'pulsar-main', serviceUrl: 'pulsar://127.0.0.1:56650' });
    expect(pulsarConfigFrom('p', ' pulsar://broker/ ').serviceUrl).toBe('pulsar://broker:6650');
    expect(pulsarConfigFrom('p', 'pulsar+ssl://broker').serviceUrl).toBe('pulsar+ssl://broker:6651');
    expect(pulsarConfigFrom('p', 'pulsars://broker:6651').serviceUrl).toBe('pulsar+ssl://broker:6651');
    expect(pulsarConfigFrom('p', 'pulsar://broker:6650', { tls: true }).serviceUrl).toBe('pulsar+ssl://broker:6650');
    expect(pulsarConfigFrom('p', 'pulsar://[::1]:6650').serviceUrl).toBe('pulsar://[::1]:6650');
  });

  it('takes the admin URL, tenant, namespace, token and prefix from the connection fields', () => {
    const config = pulsarConfigFrom('p', 'pulsar://a:6650', { adminUrl: 'http://a:8080/', tenant: 'acme', namespace: 'prod', password: 'jwt', prefix: 'lf', maxMessageBytes: 1024 });
    expect(config).toEqual({ connectionId: 'p', serviceUrl: 'pulsar://a:6650', adminUrl: 'http://a:8080', tenant: 'acme', namespace: 'prod', token: 'jwt', prefix: 'lf', maxMessageBytes: 1024 });
    expect(pulsarConfigFrom('p', 'pulsar://a:6650', { tenant: ' ', namespace: '' })).toEqual({ connectionId: 'p', serviceUrl: 'pulsar://a:6650' });
  });

  it('refuses malformed input with a readable message', () => {
    expect(() => pulsarConfigFrom('p', '')).toThrow(/service URL/);
    expect(() => pulsarConfigFrom('p', 'kafka://a:9092')).toThrow(/not a Pulsar service URL/);
    expect(() => pulsarConfigFrom('p', 'pulsar://user:pw@a:6650')).toThrow(/not a Pulsar service URL/);
    expect(() => pulsarConfigFrom('p', 'pulsar://a:99999')).toThrow(/invalid port/);
    expect(() => pulsarConfigFrom('p', 'pulsar://a:6650', { adminUrl: 'a:8080' })).toThrow(/admin URL/);
    expect(() => pulsarConfigFrom('p', 'pulsar://a:6650', { tenant: 'bad/tenant' })).toThrow(/tenant/);
  });
});

describe('pulsar topics', () => {
  it('names topics under the tenant and namespace and encodes admin paths', () => {
    expect(topicName({}, 'landflow.v1.plugin.twilio')).toBe('persistent://public/default/landflow.v1.plugin.twilio');
    expect(topicName({ tenant: 'acme', namespace: 'prod' }, 'x', false)).toBe('non-persistent://acme/prod/x');
    expect(adminTopicPath({}, 'landflow.v1.plugin.twilio')).toBe('persistent/public/default/landflow.v1.plugin.twilio');
  });
});

describe('pulsar driver module', () => {
  it('exposes the module shape the loader and the SDK helper rely on', () => {
    expect(pulsarModule.kind).toBe('pulsar');
    expect(pulsarModule.label).toBe('Apache Pulsar');
    expect(pulsarModule.exampleUrl).toMatch(/^pulsar:\/\//);
    expect(pulsarModule.capabilities).toBe(PULSAR_CAPABILITIES);
    expect(pulsarModule.create().capabilities).toEqual(PULSAR_CAPABILITIES);
    expect(pulsarModule.fields?.map((f) => f.name)).toEqual(['adminUrl', 'tenant', 'namespace']);
    expect(PULSAR_CAPABILITIES).toMatchObject({ replies: 'reply-channel', workSharing: true, buffering: true, ttl: false, undeliverable: 'inferred', nack: true, attempts: true, orderingKeys: false, headers: true, maxMessageBytes: 5 * 1024 * 1024 });
    const target = pulsar({ serviceUrl: 'pulsar://127.0.0.1:56650' });
    expect(target.kind).toBe('pulsar');
    expect(target.config).toEqual({ serviceUrl: 'pulsar://127.0.0.1:56650', connectionId: 'env-pulsar' });
    expect(pulsar({ serviceUrl: 'pulsar://a:1', connectionId: 'mine' }).config.connectionId).toBe('mine');
    expect(target.driver()).toBeInstanceOf(PulsarDriver);
  });

  it('throws NotConnectedError before connect() and after close(), and closes idempotently', async () => {
    const driver = new PulsarDriver();
    await expect(driver.publish('x', { headers: {}, body: new Uint8Array() })).rejects.toBeInstanceOf(NotConnectedError);
    await expect(driver.stats!('x')).rejects.toBeInstanceOf(NotConnectedError);
    await driver.close();
    await driver.close();
    await expect(driver.publish('x', { headers: {}, body: new Uint8Array() })).rejects.toBeInstanceOf(NotConnectedError);
  });

  it('rejects connect() to an unreachable broker without sending anything', async () => {
    const driver = new PulsarDriver();
    await expect(driver.connect({ connectionId: 'dead', serviceUrl: 'pulsar://127.0.0.1:1', connectTimeoutMs: 2_000 })).rejects.toThrow(/cannot connect to pulsar:\/\/127.0.0.1:1/);
    await expect(driver.publish('x', { headers: {}, body: new Uint8Array() })).rejects.toBeInstanceOf(NotConnectedError);
  }, 15_000);
});
