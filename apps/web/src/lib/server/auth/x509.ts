/**
 * X.509 certificates without a dependency: an RSA key pair from node:crypto and a v3 certificate written in DER and
 * signed with SHA-256 (RSA PKCS#1 v1.5), self-signed or signed by a CA. "Generate" for the SAML decryption certificate
 * (Settings → Security, ./saml-keys) uses it, and tests make throwaway CAs, servers and clients with it (mTLS).
 *
 * Also the small checks the settings need: PEM certificates in a text, a certificate's subject, expiry and fingerprint,
 * and whether a private key belongs to a certificate.
 */
import { createHash, createPrivateKey, generateKeyPairSync, randomBytes, sign, X509Certificate, type KeyObject } from 'node:crypto';
import { isIP } from 'node:net';

// ---- DER ---------------------------------------------------------------------------------------------------------

function length(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

const tlv = (tag: number, ...content: Buffer[]) => {
  const body = Buffer.concat(content);
  return Buffer.concat([Buffer.from([tag]), length(body.length), body]);
};
const seq = (...parts: Buffer[]) => tlv(0x30, ...parts);
const set = (...parts: Buffer[]) => tlv(0x31, ...parts);
const utf8 = (text: string) => tlv(0x0c, Buffer.from(text, 'utf8'));
const bool = (value: boolean) => tlv(0x01, Buffer.from([value ? 0xff : 0x00]));
const octets = (bytes: Buffer) => tlv(0x04, bytes);
const bits = (bytes: Buffer, unused = 0) => tlv(0x03, Buffer.from([unused]), bytes);
const explicit = (n: number, content: Buffer) => tlv(0xa0 + n, content);
const NULL = Buffer.from([0x05, 0x00]);

/** A non-negative INTEGER (big-endian bytes, or a small number). */
function integer(value: Buffer | number): Buffer {
  let bytes = typeof value === 'number' ? Buffer.from([value]) : value;
  while (bytes.length > 1 && bytes[0] === 0 && !(bytes[1] & 0x80)) bytes = bytes.subarray(1);
  if (bytes[0] & 0x80) bytes = Buffer.concat([Buffer.from([0]), bytes]);
  return tlv(0x02, bytes);
}

function oid(text: string): Buffer {
  const parts = text.split('.').map(Number);
  const bytes = [parts[0] * 40 + parts[1]];
  for (const part of parts.slice(2)) {
    const chunk: number[] = [];
    let v = part;
    do {
      chunk.unshift(v & 0x7f);
      v = Math.floor(v / 128);
    } while (v > 0);
    for (let i = 0; i < chunk.length - 1; i++) chunk[i] |= 0x80;
    bytes.push(...chunk);
  }
  return tlv(0x06, Buffer.from(bytes));
}

/** UTCTime until 2049, GeneralizedTime after (RFC 5280 §4.1.2.5). */
function time(date: Date): Buffer {
  const digits = date.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const year = date.getUTCFullYear();
  return year >= 1950 && year < 2050 ? tlv(0x17, Buffer.from(`${digits.slice(2)}Z`)) : tlv(0x18, Buffer.from(`${digits}Z`));
}

/** The element at `offset`: where its content starts and where it ends. */
function element(der: Buffer, offset: number): { tag: number; content: number; end: number } {
  const tag = der[offset];
  let size = der[offset + 1];
  let content = offset + 2;
  if (size & 0x80) {
    const count = size & 0x7f;
    size = 0;
    for (let i = 0; i < count; i++) size = size * 256 + der[content + i];
    content += count;
  }
  return { tag, content, end: content + size };
}

/** The subject Name of a certificate, as the DER it holds (a CA's subject is its certificates' issuer, byte for byte). */
function subjectDer(certPem: string): Buffer {
  const der = new X509Certificate(certPem).raw;
  const tbs = element(der, element(der, 0).content);
  let at = tbs.content;
  // [0] version, serial, signature algorithm, issuer, validity, subject
  if (der[at] === 0xa0) at = element(der, at).end;
  for (let i = 0; i < 4; i++) at = element(der, at).end;
  return der.subarray(at, element(der, at).end);
}

// ---- certificates --------------------------------------------------------------------------------------------------

const OID = {
  commonName: '2.5.4.3',
  organization: '2.5.4.10',
  sha256WithRsa: '1.2.840.113549.1.1.11',
  basicConstraints: '2.5.29.19',
  keyUsage: '2.5.29.15',
  extKeyUsage: '2.5.29.37',
  subjectAltName: '2.5.29.17',
  subjectKeyId: '2.5.29.14',
  serverAuth: '1.3.6.1.5.5.7.3.1',
  clientAuth: '1.3.6.1.5.5.7.3.2',
};

const KEY_USAGE_BITS = { digitalSignature: 0, keyEncipherment: 2, dataEncipherment: 3, keyCertSign: 5, cRLSign: 6 } as const;
export type KeyUsage = keyof typeof KEY_USAGE_BITS;

function keyUsage(usages: KeyUsage[]): Buffer {
  const positions = usages.map((usage) => KEY_USAGE_BITS[usage]);
  const last = Math.max(...positions);
  const bytes = Buffer.alloc(Math.floor(last / 8) + 1);
  for (const position of positions) bytes[Math.floor(position / 8)] |= 0x80 >> position % 8;
  return bits(bytes, 7 - (last % 8));
}

const extension = (id: string, critical: boolean, value: Buffer) => seq(oid(id), ...(critical ? [bool(true)] : []), octets(value));

function altName(name: string): Buffer {
  const version = isIP(name);
  if (version === 4) return tlv(0x87, Buffer.from(name.split('.').map(Number)));
  if (version === 6) {
    const [head, tail = ''] = name.split('::');
    const left = head ? head.split(':') : [];
    const right = tail ? tail.split(':') : [];
    const groups = name.includes('::') ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
    return tlv(0x87, Buffer.concat(groups.map((group) => Buffer.from(group.padStart(4, '0'), 'hex'))));
  }
  return tlv(0x82, Buffer.from(name, 'ascii'));
}

export interface CertificateOptions {
  commonName: string;
  organization?: string;
  /** Valid for this many days from now (default ten years). */
  days?: number;
  /** Signed by this CA; self-signed when absent. */
  issuer?: { cert: string; key: string };
  /** A CA certificate (basicConstraints CA:TRUE, keyCertSign). */
  ca?: boolean;
  /** subjectAltName: DNS names and IP addresses. */
  altNames?: string[];
  /** extendedKeyUsage: TLS server and/or client. */
  usage?: Array<'server' | 'client'>;
  /** keyUsage (default: digitalSignature and keyEncipherment, or keyCertSign and cRLSign for a CA). */
  keyUsage?: KeyUsage[];
  /** RSA modulus length (default 2048). */
  keyBits?: number;
}

export interface GeneratedCertificate {
  /** PEM. */
  cert: string;
  /** PKCS#8 PEM, unencrypted. */
  key: string;
}

const pem = (label: string, der: Buffer) => `-----BEGIN ${label}-----\n${der.toString('base64').match(/.{1,64}/g)!.join('\n')}\n-----END ${label}-----\n`;

/** A new RSA key pair and a v3 certificate for it (see CertificateOptions). */
export function createCertificate(options: CertificateOptions): GeneratedCertificate {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: options.keyBits ?? 2048 });
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const subject = seq(
    ...(options.organization ? [set(seq(oid(OID.organization), utf8(options.organization)))] : []),
    set(seq(oid(OID.commonName), utf8(options.commonName))),
  );
  const issuer = options.issuer ? subjectDer(options.issuer.cert) : subject;
  const signer: KeyObject = options.issuer ? createPrivateKey(options.issuer.key) : privateKey;
  const now = Date.now();
  const serial = randomBytes(16);
  serial[0] &= 0x7f;
  const extensions = [
    extension(OID.basicConstraints, true, options.ca ? seq(bool(true)) : seq()),
    extension(OID.keyUsage, true, keyUsage(options.keyUsage ?? (options.ca ? ['keyCertSign', 'cRLSign'] : ['digitalSignature', 'keyEncipherment']))),
    extension(OID.subjectKeyId, false, octets(createHash('sha1').update(spki).digest())),
    ...(options.usage?.length ? [extension(OID.extKeyUsage, false, seq(...options.usage.map((u) => oid(u === 'server' ? OID.serverAuth : OID.clientAuth))))] : []),
    ...(options.altNames?.length ? [extension(OID.subjectAltName, false, seq(...options.altNames.map(altName)))] : []),
  ];
  const algorithm = seq(oid(OID.sha256WithRsa), NULL);
  const tbs = seq(
    explicit(0, integer(2)),
    integer(serial),
    algorithm,
    issuer,
    // A minute in the past, for clocks a little behind.
    seq(time(new Date(now - 60_000)), time(new Date(now + (options.days ?? 3650) * 86_400_000))),
    subject,
    spki,
    explicit(3, seq(...extensions)),
  );
  const signature = sign('sha256', tbs, signer);
  return { cert: pem('CERTIFICATE', seq(tbs, algorithm, bits(signature))), key: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string };
}

// ---- checks ----------------------------------------------------------------------------------------------------------

/** The PEM certificates in a text (a bundle may hold several). */
export function pemCertificates(text: string | undefined): string[] {
  return (text ?? '').match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g)?.map((block) => `${block.trim()}\n`) ?? [];
}

export interface CertificateInfo {
  subject: string;
  issuer: string;
  validFrom: string;
  validTo: string;
  /** SHA-256, colon-separated hex. */
  fingerprint: string;
}

/** What Settings shows of a certificate (the first one of a bundle). Throws when it isn't one. */
export function certificateInfo(text: string): CertificateInfo {
  const cert = new X509Certificate(pemCertificates(text)[0] ?? text);
  const oneLine = (dn: string) => dn.split('\n').filter(Boolean).join(', ');
  return { subject: oneLine(cert.subject), issuer: oneLine(cert.issuer), validFrom: new Date(cert.validFrom).toISOString(), validTo: new Date(cert.validTo).toISOString(), fingerprint: cert.fingerprint256 };
}

/**
 * Check a certificate and its private key: both readable (an encrypted key with its passphrase), and the key the
 * certificate's. Returns a reason when something is off.
 */
export function keyPairProblem(certText: string, keyText: string, passphrase?: string): string | undefined {
  const certs = pemCertificates(certText);
  if (!certs.length) return 'The certificate isn’t a PEM certificate (-----BEGIN CERTIFICATE-----)';
  let cert: X509Certificate;
  try {
    cert = new X509Certificate(certs[0]);
  } catch {
    return 'The certificate can’t be read';
  }
  const encrypted = /-----BEGIN ENCRYPTED PRIVATE KEY-----|Proc-Type:\s*4,ENCRYPTED/.test(keyText);
  if (encrypted && !passphrase) return 'The private key is encrypted: enter its passphrase';
  let key: KeyObject;
  try {
    key = createPrivateKey({ key: keyText, ...(passphrase && { passphrase }) });
  } catch {
    return encrypted ? 'The passphrase doesn’t open the private key' : 'The private key isn’t a PEM private key';
  }
  if (!cert.checkPrivateKey(key)) return 'The private key doesn’t belong to the certificate';
  return undefined;
}
