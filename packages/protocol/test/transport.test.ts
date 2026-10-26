import { describe, expect, it } from 'vitest';
import {
  BROKER_TRANSPORT_KINDS,
  formatEndpoint,
  isBrokerTransport,
  isBrokeredEndpoint,
  isDirectTransport,
  parseEndpoint,
  TRANSPORT_KINDS,
  transportKindOf,
  tryParseEndpoint,
  type TransportKind,
} from '../src';

describe('transport kinds', () => {
  it('knows the direct kinds and the tier 1 + tier 2 brokers', () => {
    expect(TRANSPORT_KINDS.slice(0, 2)).toEqual(['http', 'grpc']);
    expect(BROKER_TRANSPORT_KINDS).toEqual(['kafka', 'amqp', 'nats', 'valkey', 'mqtt', 'sqs', 'pubsub', 'servicebus', 'amqp1', 'pulsar']);
    expect(isDirectTransport('grpc')).toBe(true);
    expect(isDirectTransport('kafka')).toBe(false);
    expect(isBrokerTransport('kafka')).toBe(true);
    expect(isBrokerTransport('in-process')).toBe(false);
    expect(isBrokerTransport('mcp')).toBe(false);
    expect(isBrokerTransport('redpanda')).toBe(true); // unknown kinds are assumed brokered
  });

  it('is an open string type', () => {
    const custom: TransportKind = 'zeromq';
    const known: TransportKind = 'nats';
    expect([custom, known]).toEqual(['zeromq', 'nats']);
  });
});

describe('parseEndpoint', () => {
  it('parses direct URLs', () => {
    expect(parseEndpoint('grpc://10.0.0.5:7204')).toEqual({ brokered: false, kind: 'grpc', url: 'grpc://10.0.0.5:7204', secure: false, host: '10.0.0.5', port: 7204 });
    expect(parseEndpoint('http://127.0.0.1:7101')).toMatchObject({ brokered: false, kind: 'http', secure: false, host: '127.0.0.1', port: 7101 });
    expect(parseEndpoint('https://plugins.example.com')).toMatchObject({ brokered: false, kind: 'http', secure: true, host: 'plugins.example.com', port: 443 });
    expect(parseEndpoint('http://web:3000/')).toMatchObject({ kind: 'http', host: 'web', port: 3000 });
  });

  it('parses brokered endpoints', () => {
    expect(parseEndpoint('kafka://kafka-main/twilio')).toEqual({ brokered: true, kind: 'kafka', connectionId: 'kafka-main', pluginId: 'twilio' });
    expect(parseEndpoint('nats://nats.prod/go-crypto')).toEqual({ brokered: true, kind: 'nats', connectionId: 'nats.prod', pluginId: 'go-crypto' });
    expect(parseEndpoint('zeromq://zmq1/x')).toMatchObject({ brokered: true, kind: 'zeromq' });
    expect(isBrokeredEndpoint('kafka://kafka-main/twilio')).toBe(true);
    expect(isBrokeredEndpoint('grpc://127.0.0.1:7203')).toBe(false);
    expect(transportKindOf('amqp://rabbit/twilio')).toBe('amqp');
    expect(transportKindOf('grpc://127.0.0.1:7203')).toBe('grpc');
  });

  it('rejects malformed endpoints', () => {
    for (const bad of ['', 'twilio', 'kafka://', 'kafka://conn', 'kafka://conn/plugin/extra', 'kafka://Conn/plugin', 'kafka://conn/plu gin', 'kafka://user:pw@host/plugin', 'grpc://nohostport', 'grpc://host', '127.0.0.1:7101']) {
      expect(tryParseEndpoint(bad), bad).toBeUndefined();
      expect(() => parseEndpoint(bad), bad).toThrow(/Invalid endpoint/);
    }
  });
});

describe('formatEndpoint', () => {
  it('round-trips', () => {
    const endpoint = formatEndpoint({ kind: 'kafka', connectionId: 'kafka-main', pluginId: 'twilio' });
    expect(endpoint).toBe('kafka://kafka-main/twilio');
    expect(parseEndpoint(endpoint)).toMatchObject({ kind: 'kafka', connectionId: 'kafka-main', pluginId: 'twilio' });
  });

  it('refuses bad segments and direct kinds', () => {
    expect(() => formatEndpoint({ kind: 'kafka', connectionId: 'Kafka Main', pluginId: 'twilio' })).toThrow(/connectionId/);
    expect(() => formatEndpoint({ kind: 'kafka', connectionId: 'kafka-main', pluginId: 'a/b' })).toThrow(/pluginId/);
    expect(() => formatEndpoint({ kind: 'grpc', connectionId: 'c', pluginId: 'p' })).toThrow(/direct transport/);
  });
});
