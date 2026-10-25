/**
 * A self-signed X.509 certificate built with node:crypto alone: a P-256 key, a
 * hand-encoded DER TBSCertificate (CN=localhost, SAN localhost + 127.0.0.1)
 * signed with ECDSA-SHA256. For TLS tests only.
 */
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';

function length(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

const tlv = (tag: number, content: Buffer) => Buffer.concat([Buffer.from([tag]), length(content.length), content]);
const seq = (...items: Buffer[]) => tlv(0x30, Buffer.concat(items));
const set = (...items: Buffer[]) => tlv(0x31, Buffer.concat(items));
const integer = (bytes: Buffer) => tlv(0x02, bytes[0] & 0x80 ? Buffer.concat([Buffer.from([0]), bytes]) : bytes);
const utf8 = (text: string) => tlv(0x0c, Buffer.from(text, 'utf8'));
const utcTime = (date: Date) => tlv(0x17, Buffer.from(`${date.toISOString().replace(/[-:T]/g, '').slice(2, 14)}Z`));
const explicit = (n: number, content: Buffer) => tlv(0xa0 + n, content);

function oid(dotted: string): Buffer {
  const [a, b, ...rest] = dotted.split('.').map(Number);
  const bytes = [40 * a + b];
  for (const part of rest) {
    const encoded: number[] = [];
    let v = part;
    do {
      encoded.unshift(v & 0x7f);
      v = Math.floor(v / 128);
    } while (v > 0);
    for (let i = 0; i < encoded.length - 1; i++) encoded[i] |= 0x80;
    bytes.push(...encoded);
  }
  return tlv(0x06, Buffer.from(bytes));
}

export function selfSignedCertificate(commonName = 'localhost'): { cert: string; key: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const ecdsaWithSha256 = seq(oid('1.2.840.10045.4.3.2'));
  const name = seq(set(seq(oid('2.5.4.3'), utf8(commonName))));
  const serial = randomBytes(8);
  serial[0] = (serial[0] & 0x7f) | 0x01;
  const now = Date.now();
  const subjectAltName = seq(tlv(0x82, Buffer.from('localhost')), tlv(0x87, Buffer.from([127, 0, 0, 1])));
  const tbs = seq(
    explicit(0, integer(Buffer.from([2]))), // v3
    integer(serial),
    ecdsaWithSha256,
    name,
    seq(utcTime(new Date(now - 3_600_000)), utcTime(new Date(now + 86_400_000))),
    name,
    publicKey.export({ type: 'spki', format: 'der' }),
    explicit(3, seq(seq(oid('2.5.29.17'), tlv(0x04, subjectAltName)))),
  );
  const certificate = seq(tbs, ecdsaWithSha256, tlv(0x03, Buffer.concat([Buffer.from([0]), sign('sha256', tbs, privateKey)])));
  const pem = certificate
    .toString('base64')
    .match(/.{1,64}/g)!
    .join('\n');
  return { cert: `-----BEGIN CERTIFICATE-----\n${pem}\n-----END CERTIFICATE-----\n`, key: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string };
}
