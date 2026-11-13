/**
 * Signed chain heads: the hash chain (./chain) proves nothing was changed inside the database, but whoever can rewrite the
 * whole table can rebuild a chain that verifies. A signed head pins it from outside: the chain's newest link (its sequence
 * number and hash) signed with an Ed25519 key, so a copy kept elsewhere (an S3 bucket, a webhook receiver: ./anchoring) can later
 * be compared with the log, and `landflow audit verify --head` checks the signature offline.
 *
 * Keys live in `audit_signing_keys` (migration 1882): the public key as SPKI PEM, the private key sealed with the credentials
 * key. The first signature creates one. Signed heads (`audit_heads`) are envelopes (`SignedAuditHead`): `payload` is the exact JSON
 * text that was signed, so verifying needs no canonical form. Signing first verifies the whole chain: a broken chain is
 * never attested (the attempt is audited as a failure).
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { AUDIT_HEAD_FORMAT, type AuditHeadPayload, type AuditHeadRecord, type AuditSigningKey, type SignedAuditHead } from '../../shared/audit';
import { credentials } from '../credentials/vault';
import { parse } from '../db/rows';
import { auditDb, verifyChain } from './chain';
import { HttpError } from '../errors';

export class AuditSigningError extends HttpError {
  constructor(
    message: string,
    status = 409,
  ) {
    super(message, status, { expose: true });
  }
}

interface KeyRow {
  key_id: string;
  public_key: string;
  private_key: string;
  created_at: string;
  retired_at: string | null;
}

interface HeadRow {
  seq: number | string;
  signed_at: string;
  envelope: string;
  anchored_at: string | null;
  anchor_error: string | null;
}

/** The key's id: the first 16 hex characters of the SHA-256 of its SPKI DER. */
export function keyIdOf(publicKeyPem: string): string {
  return createHash('sha256').update(createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 16);
}

/** Every key that ever signed, oldest first (the current one last). */
export function signingKeys(): AuditSigningKey[] {
  return auditDb()
    .all<KeyRow>('SELECT * FROM audit_signing_keys ORDER BY created_at, key_id')
    .map((row) => ({ keyId: row.key_id, publicKey: row.public_key, createdAt: row.created_at }));
}

/** The key that signs now, created at the first use. */
function currentKey(): { keyId: string; publicKey: string; privateKey: string } {
  const db = auditDb();
  const newest = () => db.get<KeyRow>('SELECT * FROM audit_signing_keys WHERE retired_at IS NULL ORDER BY created_at DESC, key_id LIMIT 1');
  let row = newest();
  if (!row) {
    const pair = generateKeyPairSync('ed25519');
    const publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const privateKey = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    db.upsert('audit_signing_keys', { key_id: keyIdOf(publicKey), public_key: publicKey, private_key: credentials.sealSecret(privateKey), created_at: new Date().toISOString(), retired_at: null });
    row = newest()!;
  }
  return { keyId: row.key_id, publicKey: row.public_key, privateKey: credentials.openSecret(row.private_key) };
}

/** Start a new key: the current one is retired (it stays in the list, so heads it signed still verify). */
export function rotateSigningKey(): AuditSigningKey {
  const db = auditDb();
  const now = new Date().toISOString();
  for (const row of db.all<KeyRow>('SELECT * FROM audit_signing_keys WHERE retired_at IS NULL')) db.upsert('audit_signing_keys', { ...row, retired_at: now });
  const key = currentKey();
  return { keyId: key.keyId, publicKey: key.publicKey, createdAt: now };
}

/** Sign `payload` (the text) with the current key. */
export function signPayload(payload: string): SignedAuditHead {
  const key = currentKey();
  const signature = sign(null, Buffer.from(payload), createPrivateKey(key.privateKey)).toString('base64');
  return { format: AUDIT_HEAD_FORMAT, payload, algorithm: 'Ed25519', keyId: key.keyId, signature, publicKey: key.publicKey };
}

export type HeadVerdict = { ok: true; payload: AuditHeadPayload } | { ok: false; reason: string };

/**
 * Check a signed head against the public key the verifier trusts (SPKI PEM; the envelope's own `publicKey` only when none
 * is given: that proves the envelope is consistent, not who made it).
 */
export function verifySignedHead(envelope: SignedAuditHead, trustedPublicKey?: string): HeadVerdict {
  if (envelope?.format !== AUDIT_HEAD_FORMAT || typeof envelope.payload !== 'string' || typeof envelope.signature !== 'string') return { ok: false, reason: 'Not a Landflow signed audit head' };
  let payload: AuditHeadPayload;
  try {
    payload = JSON.parse(envelope.payload) as AuditHeadPayload;
  } catch {
    return { ok: false, reason: 'The signed payload is not JSON' };
  }
  try {
    const keyPem = trustedPublicKey ?? envelope.publicKey;
    if (trustedPublicKey && keyIdOf(trustedPublicKey) !== envelope.keyId) return { ok: false, reason: `Signed by key ${envelope.keyId}, not the key you trust (${keyIdOf(trustedPublicKey)})` };
    if (!verify(null, Buffer.from(envelope.payload), createPublicKey(keyPem), Buffer.from(envelope.signature, 'base64'))) return { ok: false, reason: 'The signature does not match the payload' };
  } catch (error) {
    return { ok: false, reason: `The signature could not be checked: ${(error as Error).message}` };
  }
  if (payload.format !== AUDIT_HEAD_FORMAT || !Number.isInteger(payload.seq) || typeof payload.hash !== 'string') return { ok: false, reason: 'The payload is not an audit head' };
  return { ok: true, payload };
}

const record = (row: HeadRow): AuditHeadRecord => ({
  seq: Number(row.seq),
  signedAt: row.signed_at,
  head: parse<SignedAuditHead>(row.envelope)!,
  ...(row.anchored_at && { anchoredAt: row.anchored_at }),
  ...(row.anchor_error && { anchorError: row.anchor_error }),
});

/** The newest signed head, if any. */
export function latestHead(): AuditHeadRecord | undefined {
  const row = auditDb().get<HeadRow>('SELECT * FROM audit_heads ORDER BY seq DESC LIMIT 1');
  return row && record(row);
}

export function headAt(seq: number): AuditHeadRecord | undefined {
  const row = auditDb().get<HeadRow>('SELECT * FROM audit_heads WHERE seq = ?', seq);
  return row && record(row);
}

/** Signed heads not anchored yet, oldest first. */
export function unanchoredHeads(limit = 20): AuditHeadRecord[] {
  return auditDb()
    .all<HeadRow>('SELECT * FROM audit_heads WHERE anchored_at IS NULL ORDER BY seq DESC LIMIT ?', limit)
    .reverse()
    .map(record);
}

export function markAnchored(seq: number, error?: string) {
  const db = auditDb();
  const row = db.get<HeadRow & { key_id: string }>('SELECT * FROM audit_heads WHERE seq = ?', seq);
  if (!row) return;
  db.upsert('audit_heads', { ...row, anchored_at: error ? null : new Date().toISOString(), anchor_error: error ? error.slice(0, 500) : null });
}

/**
 * Sign the chain's head as it is now: verify the whole chain, then sign its newest link. Returns the stored head, and whether it
 * is new (a head already signed at this sequence number is returned as it is). Throws AuditSigningError when the chain is
 * broken or empty.
 */
export async function signHead(options: { instance?: string } = {}): Promise<{ record: AuditHeadRecord; created: boolean }> {
  const report = await verifyChain(auditDb());
  if (!report.ok) throw new AuditSigningError(`The audit log’s hash chain is broken${report.brokenAt ? ` at #${report.brokenAt.seq ?? '?'}: ${report.brokenAt.reason}` : ''}: not signing it`);
  const head = report.head;
  if (!head) throw new AuditSigningError('The audit log has no chained events yet');
  const existing = headAt(head.seq);
  if (existing && JSON.parse(existing.head.payload).hash === head.hash) return { record: existing, created: false };
  const key = currentKey();
  const payload = JSON.stringify({
    format: AUDIT_HEAD_FORMAT,
    seq: head.seq,
    hash: head.hash,
    ...(head.eventId && { eventId: head.eventId }),
    ...(head.at && { at: head.at }),
    signedAt: new Date().toISOString(),
    keyId: key.keyId,
    ...(options.instance && { instance: options.instance }),
  } satisfies AuditHeadPayload);
  const envelope = signPayload(payload);
  auditDb().upsert('audit_heads', { seq: head.seq, signed_at: JSON.parse(payload).signedAt, key_id: envelope.keyId, envelope: JSON.stringify(envelope), anchored_at: null, anchor_error: null });
  return { record: headAt(head.seq)!, created: true };
}
