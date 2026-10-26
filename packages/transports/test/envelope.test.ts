/** The CloudEvents envelope: types, strict validation, binary and structured modes, size accounting, channel names. */
import { describe, expect, it } from 'vitest';
import { brokerEndpoint, channelNames, parseBrokerEndpoint } from '../src/channels';
import { prefixHeaders, unprefixHeaders } from '../src/driver';
import {
  ANNOUNCE_TYPE,
  CANCEL_TYPE,
  decodeWire,
  encodeWire,
  EnvelopeError,
  parsePluginSource,
  parseType,
  requestType,
  responseType,
  serializeBody,
  sizeOf,
  subjectOf,
  validateAttributes,
  type Attributes,
} from '../src/envelope';
import { Keyring, seal } from '../src/security';

const attributes = (extra: Partial<Attributes> = {}): Attributes => ({
  specversion: '1.0',
  id: 'abc123',
  source: 'landflow://plugin/twilio/inst1',
  type: 'dev.landflow.plugin.v1.execute.response',
  time: '2026-10-26T12:00:00.000Z',
  datacontenttype: 'application/json',
  lfcorrelation: 'call-9',
  ...extra,
});

describe('types', () => {
  it('names request and response types per method, plus cancel, announce and withdraw', () => {
    expect(requestType('Execute')).toBe('dev.landflow.plugin.v1.execute.request');
    expect(responseType('LoadOptions')).toBe('dev.landflow.plugin.v1.loadoptions.response');
    expect(requestType('TestCredentials')).toBe('dev.landflow.plugin.v1.testcredentials.request');
    expect(requestType('ReceiveWebhook')).toBe('dev.landflow.plugin.v1.receivewebhook.request');
    expect(parseType('dev.landflow.plugin.v1.getmanifest.request')).toEqual({ kind: 'request', method: 'GetManifest' });
    expect(parseType('dev.landflow.plugin.v1.webhookmethod.response')).toEqual({ kind: 'response', method: 'WebhookMethod' });
    expect(parseType(CANCEL_TYPE)).toEqual({ kind: 'cancel' });
    expect(parseType(ANNOUNCE_TYPE)).toEqual({ kind: 'announce' });
    expect(parseType('dev.landflow.plugin.v1.execute')).toBeUndefined();
    expect(parseType('dev.landflow.plugin.v1.nope.request')).toBeUndefined();
    expect(parseType('dev.landflow.plugin.v2.execute.request')).toBeUndefined();
  });

  it('parses sources and subjects', () => {
    expect(parsePluginSource('landflow://plugin/twilio/inst1')).toEqual({ pluginId: 'twilio', instanceId: 'inst1' });
    expect(parsePluginSource('landflow://host/h1')).toBeUndefined();
    expect(subjectOf('Execute', { node: { type: 'twilio.message' } })).toBe('twilio.message');
    expect(subjectOf('LoadOptions', { nodeType: 'twilio.message' })).toBe('twilio.message');
    expect(subjectOf('Health', {})).toBeUndefined();
  });
});

describe('validation', () => {
  it('requires the CloudEvents attributes and checks every known extension', () => {
    const bad = (input: Record<string, string | undefined>, pattern: RegExp) => expect(() => validateAttributes(input)).toThrow(pattern);
    const base = attributes() as unknown as Record<string, string>;
    expect(validateAttributes(base)).toEqual(attributes());
    bad({ ...base, specversion: '0.3' }, /specversion/);
    bad({ ...base, id: undefined }, /"id" is required/);
    bad({ ...base, id: 'has space' }, /"id" is malformed/);
    bad({ ...base, source: 'http://x' }, /"source"/);
    bad({ ...base, type: 'dev.landflow.plugin.v1.execute' }, /type .* not supported/);
    bad({ ...base, time: 'yesterday' }, /"time"/);
    bad({ ...base, datacontenttype: 'text/plain' }, /datacontenttype/);
    bad({ ...base, lfdeadline: '12a' }, /lfdeadline/);
    bad({ ...base, lfdelivery: 'exactly-once' }, /lfdelivery/);
    bad({ ...base, lfsig: 'abc' }, /lfsig/);
    bad({ ...base, lfkeyid: 'zz' }, /lfkeyid/);
    bad({ ...base, lfmanifest: 'XYZ' }, /lfmanifest/);
    bad({ ...base, traceparent: 'nope' }, /traceparent/);
    bad({ ...base, lfenc: 'aes-256-gcm' }, /lfenc/); // without the octet-stream content type
    bad({ ...base, datacontenttype: 'application/octet-stream' }, /lfenc/); // without lfenc
    bad({ ...base, subject: 'a\u0001b' }, /subject/);
  });

  it('drops unknown attributes, or refuses them in strict mode', () => {
    const input = { ...(attributes() as unknown as Record<string, string>), lfunknown: 'x', comexampleext: 'y' };
    expect(validateAttributes(input)).toEqual(attributes());
    expect(() => validateAttributes(input, { strict: true })).toThrow(/not a known attribute/);
  });
});

describe('binary and structured modes', () => {
  const ring = new Keyring('s');
  const sealedPlain = seal(ring, 'twilio', { attributes: attributes(), body: serializeBody({ outputs: [] }) }, { encrypt: false });
  const sealedEnc = seal(ring, 'twilio', { attributes: attributes(), body: serializeBody({ outputs: [] }) }, { encrypt: true });

  it('round-trips in binary mode with attributes as bare lower-case headers', () => {
    const { wire, size } = encodeWire(sealedPlain, { mode: 'binary' });
    expect(wire.headers['content-type']).toBe('application/json');
    expect(wire.headers.lfcorrelation).toBe('call-9');
    expect(wire.headers.lfsig).toHaveLength(64);
    expect(size.bodyBytes).toBe(wire.body.byteLength);
    expect(size.totalBytes).toBe(size.headerBytes + size.bodyBytes);
    const decoded = decodeWire({ headers: { ...wire.headers, SpecVersion: wire.headers.specversion }, body: wire.body });
    expect(decoded.attributes).toEqual(sealedPlain.attributes);
    expect(Buffer.from(decoded.body).toString()).toBe('{"outputs":[]}');
  });

  it('round-trips in structured mode as one JSON document, with data_base64 for an encrypted body', () => {
    const plain = encodeWire(sealedPlain, { mode: 'structured' });
    expect(plain.wire.headers).toEqual({ 'content-type': 'application/cloudevents+json; charset=utf-8' });
    const document = JSON.parse(Buffer.from(plain.wire.body).toString());
    expect(document.data).toEqual({ outputs: [] });
    expect(document.specversion).toBe('1.0');
    expect(decodeWire(plain.wire)).toEqual(sealedPlain);
    // and without any header at all (a broker that has none)
    expect(decodeWire({ headers: {}, body: plain.wire.body })).toEqual(sealedPlain);

    const enc = encodeWire(sealedEnc, { mode: 'structured' });
    const encDocument = JSON.parse(Buffer.from(enc.wire.body).toString());
    expect(encDocument.data).toBeUndefined();
    expect(encDocument.lfenc).toBe('aes-256-gcm');
    expect(Buffer.from(encDocument.data_base64, 'base64')).toEqual(Buffer.from(sealedEnc.body));
    expect(decodeWire(enc.wire)).toEqual(sealedEnc);
  });

  it('refuses malformed, mismatched and oversized events', () => {
    const { wire } = encodeWire(sealedPlain, { mode: 'binary' });
    expect(() => decodeWire({ ...wire, headers: { ...wire.headers, 'content-type': 'text/plain' } })).toThrow(/content-type/);
    expect(() => decodeWire({ headers: {}, body: Buffer.from('not json') })).toThrow(/not valid JSON/);
    expect(() => decodeWire({ headers: {}, body: Buffer.from('[1]') })).toThrow(/JSON object/);
    expect(() => decodeWire({ headers: {}, body: Buffer.from(JSON.stringify({ ...attributes(), id: 5 })) })).toThrow(/not a string/);
    expect(() => decodeWire({ headers: { 'content-type': 'text/plain' }, body: Buffer.from('{}') })).toThrow(/CloudEvents document/);
    expect(() => decodeWire({ headers: {}, body: Buffer.from(JSON.stringify({ ...sealedEnc.attributes, data: {} })) })).toThrow(/data_base64/);
    expect(() => decodeWire({ headers: {}, body: Buffer.from(JSON.stringify({ ...sealedPlain.attributes, data_base64: 'AA==' })) })).toThrow(/data, not data_base64/);
    try {
      decodeWire(wire, { maxBytes: 10 });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(EnvelopeError);
      expect((error as EnvelopeError).reason).toBe('too_large');
    }
  });

  it('accounts sizes in bytes of headers and body', () => {
    expect(sizeOf({ headers: { ab: 'cd' }, body: new Uint8Array(3) })).toEqual({ headerBytes: 4, bodyBytes: 3, totalBytes: 7 });
    expect(sizeOf({ headers: { a: 'é' }, body: new Uint8Array() }).headerBytes).toBe(3);
  });
});

describe('driver helpers', () => {
  it('prefixes and unprefixes binding headers, keeping content-type bare', () => {
    const headers = { specversion: '1.0', lfsig: 'x', 'content-type': 'application/json' };
    expect(prefixHeaders(headers, 'ce_')).toEqual({ ce_specversion: '1.0', ce_lfsig: 'x', 'content-type': 'application/json' });
    expect(unprefixHeaders({ CE_SpecVersion: '1.0', ce_lfsig: 'x', 'Content-Type': 'application/json', 'x-other': 'dropped', ce_gone: undefined }, 'ce_')).toEqual(headers);
  });
});

describe('channels and endpoints', () => {
  it('names channels with a prefix and the protocol version', () => {
    const names = channelNames();
    expect(names.request('twilio')).toBe('landflow.v1.plugin.twilio');
    expect(names.instance('twilio', 'i1')).toBe('landflow.v1.instance.twilio.i1');
    expect(names.reply('h1')).toBe('landflow.v1.reply.h1');
    expect(names.registry()).toBe('landflow.v1.registry');
    expect(names.control('twilio')).toBe('landflow.v1.control.twilio');
    expect(channelNames('acme').registry()).toBe('acme.v1.registry');
    expect(() => names.request('bad/id')).toThrow(/plugin id/);
    expect(() => channelNames('a b')).toThrow(/prefix/);
  });

  it('forms and parses brokered endpoints', () => {
    expect(brokerEndpoint('kafka', 'kafka-main', 'twilio')).toBe('kafka://kafka-main/twilio');
    expect(parseBrokerEndpoint('kafka://kafka-main/twilio')).toEqual({ kind: 'kafka', connectionId: 'kafka-main', pluginId: 'twilio' });
    expect(parseBrokerEndpoint('grpc://10.0.0.5:7204')).toBeUndefined();
    expect(parseBrokerEndpoint('http://host/x')).toBeUndefined();
    expect(parseBrokerEndpoint('kafka://user:pw@host/x')).toBeUndefined();
  });
});
