/** Unit tests that need no broker: `configFrom`, the topic and property mappings, attempts, the SDK helper and the module shape. */
import { describe, expect, it } from 'vitest';
import { NotConnectedError } from '../../driver';
import mqttModule, { ATTEMPT_PROPERTY, MQTT_CAPABILITIES, MqttDriver, attemptOf, channelOf, connectionUrl, expirySeconds, headersToProperties, inferShared, mqtt, mqttConfigFrom, propertiesToHeaders, topicOf } from './index';

describe('mqtt configFrom', () => {
  it('accepts mqtt://, mqtts://, ws:// and wss:// URLs, moving credentials out of the URL', () => {
    expect(mqttConfigFrom('m', 'mqtt://mosquitto:1883')).toEqual({ connectionId: 'm', url: 'mqtt://mosquitto:1883' });
    expect(mqttConfigFrom('m', 'mqtt://u:p%40ss@mosquitto:1883')).toEqual({ connectionId: 'm', url: 'mqtt://mosquitto:1883', username: 'u', password: 'p@ss' });
    expect(mqttConfigFrom('m', 'mqtts://broker.example:8883')).toMatchObject({ url: 'mqtts://broker.example:8883', tls: true });
    expect(mqttConfigFrom('m', 'wss://broker.example/mqtt')).toMatchObject({ url: 'wss://broker.example/mqtt', tls: true });
    expect(mqttConfigFrom('m', 'ws://broker.example/mqtt', { tls: true }).url).toBe('wss://broker.example/mqtt');
    expect(mqttConfigFrom('m', 'tcp://h:1883').url).toBe('mqtt://h:1883');
    expect(mqttConfigFrom('m', 'ssl://h:8883')).toMatchObject({ url: 'mqtts://h:8883', tls: true });
    expect(mqttConfigFrom('m', ' mqtt://127.0.0.1:51883 ', { tls: true }).url).toBe('mqtts://127.0.0.1:51883');
  });

  it('lets the username and password fields win and carries prefix, clientId and maxMessageBytes', () => {
    const config = mqttConfigFrom('m', 'mqtt://old:pw@host', { username: 'landflow', password: 's3cret', prefix: 'acme', clientId: 'plugin-1', maxMessageBytes: 2048 });
    expect(config).toEqual({ connectionId: 'm', url: 'mqtt://host', username: 'landflow', password: 's3cret', prefix: 'acme', clientId: 'plugin-1', maxMessageBytes: 2048 });
    expect(connectionUrl({ connectionId: 'm', url: 'mqtt://u:p@host:1883/', tls: true })).toBe('mqtts://host:1883/');
    expect(connectionUrl({ connectionId: 'm', url: 'ws://host/mqtt', tls: true })).toBe('wss://host/mqtt');
  });

  it('refuses malformed input with a readable message', () => {
    expect(() => mqttConfigFrom('m', '')).toThrow(/needs a URL/);
    expect(() => mqttConfigFrom('m', 'not a url')).toThrow(/is not a URL/);
    expect(() => mqttConfigFrom('m', 'amqp://host:5672')).toThrow(/mqtt:\/\/, mqtts:\/\//);
  });
});

describe('mqtt mapping', () => {
  it('translates channel names to topics and back', () => {
    expect(topicOf('landflow.v1.plugin.twilio')).toBe('landflow/v1/plugin/twilio');
    expect(channelOf('landflow/v1/instance/twilio/abc')).toBe('landflow.v1.instance.twilio.abc');
    expect(inferShared('landflow.v1.plugin.twilio')).toBe(true);
    expect(inferShared('landflow.v1.instance.twilio.abc')).toBe(true);
    expect(inferShared('landflow.v1.control.twilio')).toBe(false);
    expect(inferShared('landflow.v1.registry')).toBe(false);
    expect(inferShared('landflow.v1.reply.host1')).toBe(false);
    expect(inferShared('lfconf.abcd.whatever')).toBe(true);
  });

  it('maps bare headers to user properties plus the Content Type property, both ways, dropping the driver property', () => {
    const bare = { specversion: '1.0', id: 'abc', type: 'dev.landflow.plugin.v1.execute.request', 'content-type': 'application/octet-stream', lfsig: 'ff' };
    const { userProperties, contentType } = headersToProperties(bare);
    expect(contentType).toBe('application/octet-stream');
    expect(userProperties).toEqual({ specversion: '1.0', id: 'abc', type: 'dev.landflow.plugin.v1.execute.request', lfsig: 'ff' });
    expect(propertiesToHeaders({ ...userProperties, [ATTEMPT_PROPERTY]: '3', Dup: ['first', 'second'] }, contentType)).toEqual({ ...bare, dup: 'first' });
    expect(propertiesToHeaders(undefined, undefined)).toEqual({});
  });

  it('counts attempts from the republish property and rounds expiry up to whole seconds', () => {
    expect(attemptOf({ properties: {} })).toBe(1);
    expect(attemptOf({ properties: { userProperties: { [ATTEMPT_PROPERTY]: '2' } } })).toBe(2);
    expect(attemptOf({ properties: { userProperties: { [ATTEMPT_PROPERTY]: 'x' } } })).toBe(1);
    expect(expirySeconds(20)).toBe(1);
    expect(expirySeconds(1500)).toBe(2);
  });
});

describe('mqtt driver module', () => {
  it('exposes the module shape the loader and the SDK helper rely on', () => {
    expect(mqttModule.kind).toBe('mqtt');
    expect(mqttModule.label).toMatch(/MQTT/);
    expect(mqttModule.exampleUrl).toMatch(/^mqtt:\/\//);
    expect(mqttModule.capabilities).toBe(MQTT_CAPABILITIES);
    expect(mqttModule.create().capabilities).toEqual(MQTT_CAPABILITIES);
    expect(MQTT_CAPABILITIES).toMatchObject({ replies: 'native', workSharing: true, buffering: false, ttl: true, undeliverable: 'reported', nack: true, attempts: true, orderingKeys: false });
    expect(typeof mqttModule.create().request).toBe('function');
    expect(mqttModule.create().stats).toBeUndefined();
    const target = mqtt({ url: 'mqtt://127.0.0.1:51883' });
    expect(target.kind).toBe('mqtt');
    expect(target.config).toEqual({ url: 'mqtt://127.0.0.1:51883', connectionId: 'env-mqtt' });
    expect(mqtt({ url: 'mqtt://h', connectionId: 'mine' }).config.connectionId).toBe('mine');
    expect(target.driver()).toBeInstanceOf(MqttDriver);
    expect(() => mqtt({ url: '' })).toThrow(/url/);
  });

  it('throws NotConnectedError before connect() and after close(), and closes idempotently', async () => {
    const driver = new MqttDriver();
    await expect(driver.publish('x', { headers: {}, body: new Uint8Array() })).rejects.toBeInstanceOf(NotConnectedError);
    await expect(driver.request('x', { headers: {}, body: new Uint8Array() }, { timeoutMs: 10 })).rejects.toBeInstanceOf(NotConnectedError);
    await driver.close();
    await driver.close();
    await expect(driver.publish('x', { headers: {}, body: new Uint8Array() })).rejects.toBeInstanceOf(NotConnectedError);
  });

  it('rejects connect() to an unreachable broker without sending anything', async () => {
    const driver = new MqttDriver();
    await expect(driver.connect({ connectionId: 'dead', url: 'mqtt://127.0.0.1:1', connectTimeoutMs: 2_000 })).rejects.toThrow(/cannot connect to mqtt:\/\/127.0.0.1:1/);
    await expect(driver.publish('x', { headers: {}, body: new Uint8Array() })).rejects.toBeInstanceOf(NotConnectedError);
  });
});
