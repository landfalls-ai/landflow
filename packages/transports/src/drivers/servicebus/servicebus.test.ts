/** Unit tests that need no namespace: `configFrom`, the entity mapping, the header mapping, the SDK helper and the module shape. */
import { describe, expect, it } from 'vitest';
import { NotConnectedError } from '../../driver';
import servicebusModule, {
  BROADCAST_SESSION,
  CHANNEL_PROPERTY,
  RateGate,
  SERVICEBUS_CAPABILITIES,
  ServiceBusDriver,
  describeError,
  entityNames,
  entityOf,
  inferRole,
  isEmulatorConnectionString,
  isTransient,
  isoDuration,
  missingHint,
  propertiesToWire,
  servicebus,
  servicebusConfigFrom,
  withBackoff,
  wireToProperties,
} from './index';

const EMULATOR = 'Endpoint=sb://127.0.0.1:55675;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=SAS_KEY_VALUE;UseDevelopmentEmulator=true;';

describe('servicebus configFrom', () => {
  it('takes a connection string as is and recognises the emulator', () => {
    expect(servicebusConfigFrom('sb-main', EMULATOR)).toEqual({ connectionId: 'sb-main', connectionString: EMULATOR, emulator: true });
    const real = 'Endpoint=sb://acme.servicebus.windows.net/;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=abc=';
    expect(servicebusConfigFrom('sb', real, { prefix: 'lf', maxMessageBytes: 1_048_576 })).toEqual({ connectionId: 'sb', connectionString: real + ';', prefix: 'lf', maxMessageBytes: 1_048_576 });
    expect(servicebusConfigFrom('sb', real, { maxMessageBytes: '1048576' }).maxMessageBytes).toBe(1_048_576);
  });

  it('builds a connection string from an sb:// endpoint and the username/password fields', () => {
    expect(servicebusConfigFrom('sb', 'sb://acme.servicebus.windows.net', { username: 'RootManageSharedAccessKey', password: 'k=' }).connectionString).toBe('Endpoint=sb://acme.servicebus.windows.net;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=k=;');
    expect(servicebusConfigFrom('sb', 'sb://127.0.0.1:55675')).toEqual({ connectionId: 'sb', connectionString: 'Endpoint=sb://127.0.0.1:55675;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=SAS_KEY_VALUE;UseDevelopmentEmulator=true;', emulator: true });
    expect(servicebusConfigFrom('sb', 'sb://sb-emulator:5672', { emulator: true }).emulator).toBe(true);
    expect(servicebusConfigFrom('sb', 'Endpoint=sb://sb-emulator;SharedAccessKeyName=Root;SharedAccessKey=x', { emulator: 'true' }).connectionString).toContain('UseDevelopmentEmulator=true');
    expect(servicebusConfigFrom('sb', 'Endpoint=sb://a;SharedAccessKeyName=n', { password: 'secret' }).connectionString).toBe('Endpoint=sb://a;SharedAccessKeyName=n;SharedAccessKey=secret;');
  });

  it('refuses malformed input with a readable message', () => {
    expect(() => servicebusConfigFrom('sb', '')).toThrow(/connection string/);
    expect(() => servicebusConfigFrom('sb', 'amqp://a:5672')).toThrow(/not a Service Bus/);
    expect(() => servicebusConfigFrom('sb', 'sb://acme.servicebus.windows.net')).toThrow(/key name/);
    expect(() => servicebusConfigFrom('sb', 'Endpoint=https://a;SharedAccessKey=x')).toThrow(/sb:\/\//);
    expect(() => servicebusConfigFrom('sb', 'Endpoint=sb://a;SharedAccessKeyName=n')).toThrow(/SharedAccessKey/);
  });
});

describe('servicebus entities', () => {
  it('maps the five roles onto queues, sessions and the broadcast topic', () => {
    expect(entityNames({})).toEqual({ instanceQueue: 'landflow.v1.instance', replyQueue: 'landflow.v1.reply', broadcastTopic: 'landflow.v1.broadcast', broadcastSubscriptions: Array.from({ length: 16 }, (_, i) => `bc-${String(i).padStart(2, '0')}`) });
    expect(entityNames({ prefix: 'acme', entities: { broadcastSubscriptions: ['a', 'b'] } })).toMatchObject({ instanceQueue: 'acme.v1.instance', broadcastSubscriptions: ['a', 'b'] });
    expect(entityOf({}, 'landflow.v1.plugin.twilio', 'request')).toEqual({ kind: 'queue', name: 'landflow.v1.plugin.twilio' });
    expect(entityOf({ queueFor: (c) => c.replace(/\.v1\.plugin\..*/, '.v1.plugin') }, 'landflow.v1.plugin.twilio', 'request')).toEqual({ kind: 'queue', name: 'landflow.v1.plugin' });
    expect(entityOf({}, 'landflow.v1.instance.twilio.i1', 'instance')).toEqual({ kind: 'session', name: 'landflow.v1.instance', session: 'landflow.v1.instance.twilio.i1' });
    expect(entityOf({}, 'landflow.v1.reply.h1', 'reply')).toEqual({ kind: 'session', name: 'landflow.v1.reply', session: 'landflow.v1.reply.h1' });
    expect(entityOf({}, 'landflow.v1.control.twilio', 'broadcast')).toEqual({ kind: 'topic', name: 'landflow.v1.broadcast' });
  });

  it('infers the role of an undeclared channel from its name', () => {
    expect(inferRole('landflow.v1.plugin.twilio')).toBe('request');
    expect(inferRole('landflow.v1.instance.twilio.i1')).toBe('instance');
    expect(inferRole('landflow.v1.reply.h1')).toBe('reply');
    expect(inferRole('landflow.v1.registry')).toBe('broadcast');
    expect(inferRole('landflow.v1.control.twilio')).toBe('broadcast');
    expect(inferRole('lfconf.1234.roundtrip')).toBe('request');
  });

  it('formats durations and recognises emulator connection strings', () => {
    expect(isoDuration(60_000)).toBe('PT60S');
    expect(isoDuration(1)).toBe('PT1S');
    expect(isEmulatorConnectionString(EMULATOR)).toBe(true);
    expect(isEmulatorConnectionString('Endpoint=sb://a;UseDevelopmentEmulator=false')).toBe(false);
  });
});

describe('servicebus headers', () => {
  it('prefixes attributes with ce_, keeps content-type as the message content type and adds the channel, both ways', () => {
    const bare = { specversion: '1.0', id: 'abc', type: 'dev.landflow.plugin.v1.health.request', 'content-type': 'application/json', lfsig: 'ff' };
    const { applicationProperties, contentType } = wireToProperties(bare, 'landflow.v1.plugin.x');
    expect(contentType).toBe('application/json');
    expect(applicationProperties).toEqual({ ce_specversion: '1.0', ce_id: 'abc', ce_type: 'dev.landflow.plugin.v1.health.request', ce_lfsig: 'ff', [CHANNEL_PROPERTY]: 'landflow.v1.plugin.x' });
    expect(propertiesToWire({ ...applicationProperties, ce_num: 3 }, contentType)).toEqual({ ...bare, num: '3' });
    expect(propertiesToWire(undefined, undefined)).toEqual({});
    expect(BROADCAST_SESSION).toBe('broadcast');
  });
});

describe('missing entities and createEntities', () => {
  it('names the entity and the script for the emulator, and the option for a real namespace', () => {
    expect(missingHint({ emulator: true }, 'landflow.v1.plugin.my-plugin')).toMatch(/servicebus-config\.py --plugin my-plugin,/);
    expect(missingHint({ emulator: true }, 'lfconf.roundtrip')).toMatch(/servicebus-config\.py --queue lfconf\.roundtrip,/);
    expect(missingHint({ emulator: true })).toMatch(/servicebus-config\.py, then recreate/);
    expect(missingHint({ emulator: false }, 'landflow.v1.plugin.x')).toMatch(/createEntities.*Manage rights/);
  });

  it('reads createEntities from the connection fields', () => {
    expect(servicebusConfigFrom('c', EMULATOR).createEntities).toBeUndefined();
    expect(servicebusConfigFrom('c', EMULATOR, { createEntities: 'true' }).createEntities).toBe(true);
    expect(servicebusConfigFrom('c', EMULATOR, { createEntities: false }).createEntities).toBe(false);
  });
});

describe('servicebus driver module', () => {
  it('exposes the module shape the loader and the SDK helper rely on', () => {
    expect(servicebusModule.kind).toBe('servicebus');
    expect(servicebusModule.label).toBe('Azure Service Bus');
    expect(servicebusModule.exampleUrl).toMatch(/^Endpoint=sb:\/\//);
    expect(servicebusModule.capabilities).toBe(SERVICEBUS_CAPABILITIES);
    expect(servicebusModule.create().capabilities).toEqual(SERVICEBUS_CAPABILITIES);
    expect(servicebusModule.fields?.map((f) => f.name)).toEqual(['emulator', 'createEntities', 'maxMessageBytes', 'maxOpsPerSecond']);
    expect(SERVICEBUS_CAPABILITIES).toMatchObject({ replies: 'reply-channel', workSharing: true, buffering: true, ttl: true, undeliverable: 'unknown', nack: true, attempts: true, orderingKeys: false, headers: true, maxHeaderBytes: 65_536, maxMessageBytes: 245_760 });
    const target = servicebus({ connectionString: EMULATOR });
    expect(target.kind).toBe('servicebus');
    expect(target.config).toEqual({ connectionString: EMULATOR, connectionId: 'env-servicebus' });
    expect(servicebus({ connectionString: EMULATOR, connectionId: 'mine' }).config.connectionId).toBe('mine');
    expect(target.driver()).toBeInstanceOf(ServiceBusDriver);
  });

  it('throws NotConnectedError before connect() and after close(), and closes idempotently', async () => {
    const driver = new ServiceBusDriver();
    await expect(driver.publish('x', { headers: {}, body: new Uint8Array() })).rejects.toBeInstanceOf(NotConnectedError);
    await expect(driver.stats!('x')).rejects.toBeInstanceOf(NotConnectedError);
    await driver.close();
    await driver.close();
    await expect(driver.publish('x', { headers: {}, body: new Uint8Array() })).rejects.toBeInstanceOf(NotConnectedError);
  });

  it('rejects connect() to an unreachable namespace without sending anything', async () => {
    const driver = new ServiceBusDriver();
    await expect(driver.connect({ connectionId: 'dead', connectionString: 'Endpoint=sb://127.0.0.1:1;SharedAccessKeyName=n;SharedAccessKey=k;UseDevelopmentEmulator=true;' })).rejects.toThrow(/cannot connect/);
    await expect(driver.publish('x', { headers: {}, body: new Uint8Array() })).rejects.toBeInstanceOf(NotConnectedError);
  }, 60_000);
});

describe('throttling and errors', () => {
  const busy = () => Object.assign(new Error('The request was terminated because the namespace is being throttled. Error code : 50002'), { code: 'ServiceBusy', retryable: true });

  it('classifies what is worth another try', () => {
    expect(isTransient(busy())).toBe(true);
    expect(isTransient(Object.assign(new Error('x'), { code: 'ServiceTimeout' }))).toBe(true);
    expect(isTransient(Object.assign(new Error('x'), { retryable: true }))).toBe(true);
    expect(isTransient(Object.assign(new Error('x'), { code: 'MessagingEntityNotFound' }))).toBe(false);
    expect(isTransient(Object.assign(new Error('x'), { code: 'SessionCannotBeLocked' }))).toBe(false);
    expect(isTransient(Object.assign(new Error('x'), { code: 'MessageLockLost' }))).toBe(false);
    expect(isTransient(new Error('plain'))).toBe(false);
  });

  it('retries a throttled operation on the backoff schedule and gives up on a permanent error', async () => {
    let calls = 0;
    await expect(withBackoff(async () => { if (++calls < 3) throw busy(); return 'ok'; }, () => true, [1, 1, 1])).resolves.toBe('ok');
    expect(calls).toBe(3);
    calls = 0;
    await expect(withBackoff(async () => { calls++; throw busy(); }, () => true, [1, 1])).rejects.toThrow(/throttled/);
    expect(calls).toBe(3);
    calls = 0;
    await expect(withBackoff(async () => { calls++; throw Object.assign(new Error('gone'), { code: 'MessagingEntityNotFound' }); }, () => true, [1, 1])).rejects.toThrow('gone');
    expect(calls).toBe(1);
    calls = 0;
    await expect(withBackoff(async () => { calls++; throw busy(); }, () => false, [1, 1])).rejects.toThrow(/throttled/);
    expect(calls).toBe(1);
  });

  it('describes an AggregateError (whose own message is empty) with its causes', () => {
    const aggregate = new AggregateError([Object.assign(new Error('link detached'), { code: 'ServiceCommunicationProblem' }), new Error('timed out')], '');
    expect(describeError(aggregate)).toContain('link detached');
    expect(describeError(aggregate)).toContain('timed out');
    expect(describeError(busy())).toContain('[ServiceBusy]');
  });

  it('paces to the configured rate after the burst, and not at all at 0', async () => {
    const gate = new RateGate(100, 4); // 10 ms apart, 4 free
    const start = Date.now();
    for (let i = 0; i < 14; i++) await gate.take();
    expect(Date.now() - start).toBeGreaterThanOrEqual(85); // 10 paced after the 4 burst tokens ≈ 100 ms
    const off = new RateGate(0);
    const t = Date.now();
    for (let i = 0; i < 1000; i++) await off.take();
    expect(Date.now() - t).toBeLessThan(50);
  });

  it('charges an operation for the bytes it moves', async () => {
    const gate = new RateGate(1000, 1, 1); // 1 ms per operation + 1 ms per KiB
    const start = Date.now();
    for (let i = 0; i < 4; i++) await gate.take(20 * 1024); // 21 ms each
    expect(Date.now() - start).toBeGreaterThanOrEqual(55);
  });

  it('reads maxOpsPerSecond from the connection fields', () => {
    expect(servicebusConfigFrom('c', 'sb://127.0.0.1:55675', { maxOpsPerSecond: '25' }).maxOpsPerSecond).toBe(25);
    expect(servicebusConfigFrom('c', 'sb://127.0.0.1:55675', { maxOpsPerSecond: 0 }).maxOpsPerSecond).toBe(0);
    expect(servicebusConfigFrom('c', 'sb://127.0.0.1:55675').maxOpsPerSecond).toBeUndefined();
  });
});
