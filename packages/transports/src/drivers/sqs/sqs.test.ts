/** Unit tests for the SQS driver module that need no LocalStack: config parsing and the AWS guard, queue names, the body encoding, helpers. */
import { describe, expect, it } from 'vitest';
import { NotConnectedError } from '../../driver';
import { loadDriverModule } from '../index';
import sqsModule, { broadcastPrefixOf, fromSqsMessage, isBroadcastChannel, isSqsText, queueNameOf, sqs, sqsConfigFrom, toSqsMessage, SQS_MAX_MESSAGE_BYTES } from './index';

describe('sqsConfigFrom', () => {
  it('takes the endpoint from http(s):// and sqs:// URLs, the region from the field or the query, credentials from username/password', () => {
    expect(sqsConfigFrom('s', 'http://127.0.0.1:54566')).toEqual({ connectionId: 's', region: 'us-east-1', endpoint: 'http://127.0.0.1:54566' });
    expect(sqsConfigFrom('s', 'http://127.0.0.1:54566/', { username: 'test', password: 'test', prefix: 'acme' })).toEqual({
      connectionId: 's',
      region: 'us-east-1',
      prefix: 'acme',
      endpoint: 'http://127.0.0.1:54566',
      accessKeyId: 'test',
      secretAccessKey: 'test',
    });
    expect(sqsConfigFrom('s', 'sqs://localstack:4566').endpoint).toBe('http://localstack:4566');
    expect(sqsConfigFrom('s', 'sqs://sqs.eu-west-1.amazonaws.com', { tls: true, region: 'eu-west-1' })).toMatchObject({ endpoint: 'https://sqs.eu-west-1.amazonaws.com', region: 'eu-west-1' });
    expect(sqsConfigFrom('s', 'http://127.0.0.1:54566?region=eu-central-1').region).toBe('eu-central-1');
    expect(sqsConfigFrom('s', 'http://127.0.0.1:54566', { endpoint: 'http://10.0.0.5:4566', region: 'us-west-2' })).toMatchObject({ endpoint: 'http://10.0.0.5:4566', region: 'us-west-2' });
    expect(sqsConfigFrom('s', 'http://127.0.0.1:54566', { queuePrefix: 'lf-', visibilityTimeoutSeconds: '5', waitTimeSeconds: 2, retentionSeconds: 'x' })).toMatchObject({ queuePrefix: 'lf-', visibilityTimeoutSeconds: 5, waitTimeSeconds: 2 });
  });

  it('refuses to use the default AWS endpoint unless allowAws is set (the guard against real AWS)', () => {
    expect(() => sqsConfigFrom('s', '')).toThrow(/explicit endpoint/);
    expect(() => sqsConfigFrom('s', 'sqs://aws')).toThrow(/explicit endpoint/);
    expect(() => sqsConfigFrom('s', 'sqs://aws/eu-west-1', { allowAws: 'false' })).toThrow(/explicit endpoint/);
    expect(sqsConfigFrom('s', 'sqs://aws/eu-west-1', { allowAws: true })).toEqual({ connectionId: 's', region: 'eu-west-1', allowAws: true });
    expect(sqsConfigFrom('s', '', { allowAws: 'true', region: 'ap-southeast-2' })).toEqual({ connectionId: 's', region: 'ap-southeast-2', allowAws: true });
    // With an endpoint, allowAws changes nothing about where requests go.
    expect(sqsConfigFrom('s', 'http://127.0.0.1:54566', { allowAws: true }).endpoint).toBe('http://127.0.0.1:54566');
  });

  it('rejects other schemes, bad endpoints, bad regions, half credentials and oversized limits', () => {
    expect(() => sqsConfigFrom('s', 'amqp://x:1')).toThrow(/http:\/\/, https:\/\/ or sqs:\/\//);
    expect(() => sqsConfigFrom('s', 'not a url')).toThrow(/must be the endpoint/);
    expect(() => sqsConfigFrom('s', 'http://127.0.0.1:54566', { endpoint: 'ftp://x' })).toThrow(/http:\/\/ or https:\/\//);
    expect(() => sqsConfigFrom('s', 'http://127.0.0.1:54566', { region: 'Mars' })).toThrow(/region/);
    expect(() => sqsConfigFrom('s', 'http://127.0.0.1:54566', { username: 'only-key' })).toThrow(/both an access key id/);
    expect(() => sqsConfigFrom('s', 'http://127.0.0.1:54566', { maxMessageBytes: SQS_MAX_MESSAGE_BYTES + 1 })).toThrow(/service limit/);
  });
});

describe('queue names', () => {
  it('maps a channel to [A-Za-z0-9_-]{1,80}, consistently, and shortens long names with a hash', () => {
    expect(queueNameOf('landflow.v1.plugin.twilio')).toBe('landflow_v1_plugin_twilio');
    expect(queueNameOf('landflow.v1.plugin.twilio', 'lf-')).toBe('lf-landflow_v1_plugin_twilio');
    const long = `landflow.v1.instance.${'p'.repeat(60)}.${'i'.repeat(32)}`;
    const name = queueNameOf(long);
    expect(name).toHaveLength(80);
    expect(name).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(queueNameOf(long)).toBe(name);
    expect(queueNameOf(long + 'x')).not.toBe(name);
  });

  it('tells broadcast channels from their role in the name when nothing was declared', () => {
    expect(isBroadcastChannel('landflow.v1.reply.host-1')).toBe(true);
    expect(isBroadcastChannel('acme.v1.registry')).toBe(true);
    expect(isBroadcastChannel('landflow.v1.control.twilio')).toBe(true);
    expect(isBroadcastChannel('landflow.v1.plugin.twilio')).toBe(false);
    expect(isBroadcastChannel('landflow.v1.instance.twilio.abc')).toBe(false);
    expect(isBroadcastChannel('lfconf.abcd.name')).toBe(false);
    expect(isBroadcastChannel('landflow.v1.plugin.twilio', { name: 'x', role: 'request', delivery: 'broadcast', durable: false })).toBe(true);
  });

  it('leaves room for the per-consumer suffix of broadcast queues', () => {
    expect(broadcastPrefixOf('landflow.v1.registry')).toBe('landflow_v1_registry--bc-');
    const long = broadcastPrefixOf(`landflow.v1.reply.${'h'.repeat(100)}`);
    expect(long.endsWith('--bc-')).toBe(true);
    expect(long.length + 10).toBeLessThanOrEqual(80);
  });
});

describe('message encoding', () => {
  it('sends text bodies as they are with the content type as an attribute', () => {
    const event = { headers: { 'content-type': 'application/cloudevents+json; charset=utf-8' }, body: new TextEncoder().encode('{"specversion":"1.0","data":{"ü":1}}') };
    const message = toSqsMessage(event);
    expect(message.body).toBe('{"specversion":"1.0","data":{"ü":1}}');
    expect(message.attributes).toEqual({ 'content-type': { DataType: 'String', StringValue: 'application/cloudevents+json; charset=utf-8' } });
    const back = fromSqsMessage({ Body: message.body, MessageAttributes: message.attributes });
    expect(back.headers).toEqual({ 'content-type': 'application/cloudevents+json; charset=utf-8' });
    expect(new TextDecoder().decode(back.body)).toBe('{"specversion":"1.0","data":{"ü":1}}');
  });

  it('falls back to base64 for bytes SQS cannot carry, and marks empty bodies', () => {
    const binary = new Uint8Array([0, 1, 2, 255, 254]);
    const message = toSqsMessage({ headers: {}, body: binary });
    expect(message.attributes['lf-encoding']).toEqual({ DataType: 'String', StringValue: 'base64' });
    expect([...fromSqsMessage({ Body: message.body, MessageAttributes: message.attributes }).body]).toEqual([0, 1, 2, 255, 254]);
    const control = toSqsMessage({ headers: {}, body: new TextEncoder().encode('a\u0001b') });
    expect(control.attributes['lf-encoding']?.StringValue).toBe('base64');
    const empty = toSqsMessage({ headers: { 'content-type': 'a/b' }, body: new Uint8Array() });
    expect(empty.body).toBe('-');
    expect(fromSqsMessage({ Body: empty.body, MessageAttributes: empty.attributes }).body.byteLength).toBe(0);
    expect(isSqsText('tab\t nl\n cr\r ok ünï 😀')).toBe(true);
    expect(isSqsText('\u0000')).toBe(false);
    expect(isSqsText('￾')).toBe(false);
  });
});

describe('module and SDK helper', () => {
  it('declares its kind, label, fields and capabilities, and loadDriverModule finds it', async () => {
    expect(sqsModule.kind).toBe('sqs');
    expect(sqsModule.fields?.map((f) => f.name)).toEqual(['region', 'endpoint', 'allowAws', 'queuePrefix']);
    expect(sqsModule.capabilities).toEqual({
      replies: 'reply-channel',
      workSharing: true,
      buffering: true,
      ttl: false,
      undeliverable: 'unknown',
      persistence: 'disk',
      maxMessageBytes: 1024 * 1024,
      latency: 'high',
      headers: false,
      orderingKeys: false,
      nack: true,
      attempts: true,
    });
    expect(sqsModule.create().capabilities).toEqual(sqsModule.capabilities);
    expect((await loadDriverModule('sqs'))?.label).toBe(sqsModule.label);
  });

  it('builds a broker target with the env connection id and us-east-1 by default, and refuses AWS without allowAws', () => {
    const target = sqs({ endpoint: 'http://127.0.0.1:54566' });
    expect(target.kind).toBe('sqs');
    expect(target.config).toEqual({ connectionId: 'env-sqs', region: 'us-east-1', endpoint: 'http://127.0.0.1:54566' });
    expect(target.driver().kind).toBe('sqs');
    expect(() => sqs({})).toThrow(/endpoint/);
    expect(sqs({ allowAws: true, region: 'eu-west-1' }).config).toMatchObject({ allowAws: true, region: 'eu-west-1' });
  });

  it('refuses to publish, consume or declare before connecting without touching the client library', async () => {
    const driver = sqsModule.create();
    const event = { headers: { 'content-type': 'application/json' }, body: new Uint8Array() };
    await expect(driver.publish('x', event)).rejects.toBeInstanceOf(NotConnectedError);
    await expect(driver.consume('x', { prefetch: 1, ackMode: 'auto' }, async () => {})).rejects.toBeInstanceOf(NotConnectedError);
    await expect(driver.declare([])).rejects.toBeInstanceOf(NotConnectedError);
    await expect(driver.stats!('x')).rejects.toBeInstanceOf(NotConnectedError);
    await driver.close();
  });

  it('refuses to connect without an endpoint unless allowAws is set, before loading the client', async () => {
    const driver = sqsModule.create();
    await expect(driver.connect({ connectionId: 'x', region: 'us-east-1' })).rejects.toThrow(/explicit endpoint/);
  });
});
