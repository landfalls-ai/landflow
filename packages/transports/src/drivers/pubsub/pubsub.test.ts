/** Unit tests for the Pub/Sub driver module that need no emulator: config parsing and the cloud guard, resource ids, helpers. */
import { describe, expect, it } from 'vitest';
import { NotConnectedError } from '../../driver';
import { loadDriverModule } from '../index';
import pubsubModule, { pubsub, pubsubConfigFrom, sharedSubscriptionIdOf, topicIdOf, PUBSUB_MAX_MESSAGE_BYTES } from './index';

describe('pubsubConfigFrom', () => {
  it('reads the emulator host and project from the URL, with the fields winning', () => {
    expect(pubsubConfigFrom('p', 'pubsub://127.0.0.1:58085/landflow-dev')).toEqual({ connectionId: 'p', projectId: 'landflow-dev', emulatorHost: '127.0.0.1:58085' });
    expect(pubsubConfigFrom('p', 'pubsub://127.0.0.1:58085/', { projectId: 'other-proj', prefix: 'acme' })).toEqual({ connectionId: 'p', projectId: 'other-proj', prefix: 'acme', emulatorHost: '127.0.0.1:58085' });
    expect(pubsubConfigFrom('p', 'pubsub://landflow-dev', { emulatorHost: 'pubsub:8085' })).toMatchObject({ projectId: 'landflow-dev', emulatorHost: 'pubsub:8085' });
    expect(pubsubConfigFrom('p', 'pubsub://127.0.0.1:58085/landflow-dev', { topicPrefix: 'lf-', ackDeadlineSeconds: '20', retentionSeconds: 1200, deadLetter: 'false', maxDeliveryAttempts: 'x' })).toMatchObject({
      topicPrefix: 'lf-',
      ackDeadlineSeconds: 20,
      retentionSeconds: 1200,
      deadLetter: false,
    });
  });

  it('refuses the real service unless allowCloud is set (the guard against a real project)', () => {
    expect(() => pubsubConfigFrom('p', 'pubsub://landflow-dev')).toThrow(/needs the emulator/);
    expect(() => pubsubConfigFrom('p', 'pubsub://pubsub.googleapis.com/landflow-dev')).toThrow(/needs the emulator/);
    expect(() => pubsubConfigFrom('p', '', { projectId: 'landflow-dev' })).toThrow(/needs the emulator/);
    expect(pubsubConfigFrom('p', 'pubsub://landflow-dev', { allowCloud: true })).toEqual({ connectionId: 'p', projectId: 'landflow-dev', allowCloud: true });
    expect(pubsubConfigFrom('p', 'pubsub://pubsub.googleapis.com/landflow-dev', { allowCloud: 'true' })).toEqual({ connectionId: 'p', projectId: 'landflow-dev', allowCloud: true });
  });

  it('rejects other schemes, missing or invalid projects, bad emulator hosts and oversized limits', () => {
    expect(() => pubsubConfigFrom('p', 'kafka://x:1/p')).toThrow(/pubsub:\/\//);
    expect(() => pubsubConfigFrom('p', 'not a url')).toThrow(/pubsub:\/\/127.0.0.1:58085/);
    expect(() => pubsubConfigFrom('p', 'pubsub://127.0.0.1:58085')).toThrow(/project id/);
    expect(() => pubsubConfigFrom('p', 'pubsub://127.0.0.1:58085/Bad_Project')).toThrow(/project id/);
    expect(() => pubsubConfigFrom('p', 'pubsub://127.0.0.1:58085/landflow-dev', { emulatorHost: 'no-port' })).toThrow(/host:port/);
    expect(() => pubsubConfigFrom('p', 'pubsub://127.0.0.1:58085/landflow-dev', { maxMessageBytes: PUBSUB_MAX_MESSAGE_BYTES + 1 })).toThrow(/service limit/);
  });
});

describe('resource ids', () => {
  it('keeps channel names as topic ids and guards the rules Pub/Sub has', () => {
    expect(topicIdOf('landflow.v1.plugin.twilio')).toBe('landflow.v1.plugin.twilio');
    expect(topicIdOf('landflow.v1.plugin.twilio', 'lf-')).toBe('lf-landflow.v1.plugin.twilio');
    expect(topicIdOf('1abc')).toBe('lf-1abc');
    expect(topicIdOf('google.x')).toBe('lf-google.x');
    expect(topicIdOf('ab')).toBe('ab_');
    expect(topicIdOf('a/b')).toBe('a_b');
  });

  it('names the shared subscription after the topic when the group is the channel', () => {
    expect(sharedSubscriptionIdOf('landflow.v1.plugin.twilio', 'landflow.v1.plugin.twilio')).toBe('landflow.v1.plugin.twilio');
    expect(sharedSubscriptionIdOf('landflow.v1.plugin.twilio', 'workers')).toBe('landflow.v1.plugin.twilio.workers');
  });
});

describe('module and SDK helper', () => {
  it('declares its kind, label, fields and capabilities, and loadDriverModule finds it', async () => {
    expect(pubsubModule.kind).toBe('pubsub');
    expect(pubsubModule.fields?.map((f) => f.name)).toEqual(['projectId', 'emulatorHost', 'allowCloud', 'topicPrefix']);
    expect(pubsubModule.capabilities).toEqual({
      replies: 'reply-channel',
      workSharing: true,
      buffering: true,
      ttl: false,
      undeliverable: 'unknown',
      persistence: 'disk',
      maxMessageBytes: 10_000_000,
      latency: 'medium',
      headers: true,
      orderingKeys: true,
      nack: true,
      attempts: true,
    });
    expect(pubsubModule.create().capabilities).toEqual(pubsubModule.capabilities);
    expect((await loadDriverModule('pubsub'))?.label).toBe(pubsubModule.label);
  });

  it('builds a broker target with the env connection id by default, and refuses the cloud without allowCloud', () => {
    const target = pubsub({ projectId: 'landflow-dev', emulatorHost: '127.0.0.1:58085' });
    expect(target.kind).toBe('pubsub');
    expect(target.config).toEqual({ connectionId: 'env-pubsub', projectId: 'landflow-dev', emulatorHost: '127.0.0.1:58085' });
    expect(target.driver().kind).toBe('pubsub');
    expect(() => pubsub({ projectId: '' })).toThrow(/projectId/);
    expect(() => pubsub({ projectId: 'landflow-dev' })).toThrow(/emulatorHost/);
    expect(pubsub({ projectId: 'landflow-dev', allowCloud: true }).config.allowCloud).toBe(true);
  });

  it('refuses to publish, consume or declare before connecting without touching the client library', async () => {
    const driver = pubsubModule.create();
    const event = { headers: { 'content-type': 'application/json' }, body: new Uint8Array() };
    await expect(driver.publish('x', event)).rejects.toBeInstanceOf(NotConnectedError);
    await expect(driver.consume('x', { prefetch: 1, ackMode: 'auto' }, async () => {})).rejects.toBeInstanceOf(NotConnectedError);
    await expect(driver.declare([])).rejects.toBeInstanceOf(NotConnectedError);
    expect(driver.stats).toBeUndefined();
    await driver.close();
  });

  it('refuses to connect without an emulator host unless allowCloud is set, before loading the client', async () => {
    const driver = pubsubModule.create();
    await expect(driver.connect({ connectionId: 'x', projectId: 'landflow-dev' })).rejects.toThrow(/emulator host/);
    await expect(driver.connect({ connectionId: 'x', projectId: 'landflow-dev', emulatorHost: 'pubsub.googleapis.com:443' })).rejects.toThrow(/real service/);
  });
});
