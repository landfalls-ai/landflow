/**
 * Passkeys (WebAuthn) as a second factor, on `@simplewebauthn/server`. The relying party id and the expected origin come
 * from the configured public URL (`LANDFLOW_PUBLIC_URL`), never from a request header; attestation is `none` (no
 * device trust is built on it) and user verification is `preferred` (a passkey is a second factor on top of the
 * password). A passkey is a `user_mfa_factors` row (credential id, public key, counter, transports); up to ten per
 * person. Every ceremony runs on a challenge from `mfa_challenges` (single use, bound to the person and the purpose).
 * The signature counter only moves forward, decided in `takeOnce`: an authenticator that never counts (always 0) is
 * allowed, a lower or repeated count refuses the sign-in and flags the key until it is removed (a cloned key signs from
 * its own count). Public keys, credential ids and challenges are never logged or audited; audit rows carry factor ids.
 */
import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse, type AuthenticationResponseJSON, type PublicKeyCredentialCreationOptionsJSON, type PublicKeyCredentialRequestOptionsJSON, type RegistrationResponseJSON } from '@simplewebauthn/server';
import { isoBase64URL } from '@simplewebauthn/server/helpers';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import type { MfaFactorView } from '../../../shared/auth';
import { recordAudit } from '../../audit';
import { publicUrl } from '../../config/urls';
import { MfaError } from './errors';
import { authDb } from '../db';
import type { UserRecord } from '../users';
import { consumeWebauthnChallenge, openChallenge, peekChallenge, setWebauthnChallenge, useChallenge, type ChallengePurpose } from './challenges';
import { takeOnce } from './once';
import { newRecoveryCodes } from './recovery';

export const MAX_PASSKEYS = 10;
const TIMEOUT_MS = 5 * 60_000;

/** The relying party: its id is the public URL's host, its origin that URL's origin (scheme, host, port). */
export function relyingParty(): { id: string; name: string; origin: string } {
  const url = new URL(publicUrl());
  return { id: url.hostname, name: 'Landflow', origin: url.origin };
}

const b64 = z.string().min(1).max(4096);
/** What a browser's `navigator.credentials.get()` gives (as @simplewebauthn/browser's JSON): bounded strings only. */
export const assertionSchema = z.object({
  id: z.string().min(1).max(1400),
  rawId: z.string().min(1).max(1400),
  type: z.literal('public-key'),
  response: z.object({ clientDataJSON: b64, authenticatorData: b64, signature: b64, userHandle: z.string().max(1400).nullish() }),
  clientExtensionResults: z.record(z.string(), z.unknown()).default({}),
  authenticatorAttachment: z.string().max(32).nullish(),
});
/** What `navigator.credentials.create()` gives. */
export const attestationSchema = z.object({
  id: z.string().min(1).max(1400),
  rawId: z.string().min(1).max(1400),
  type: z.literal('public-key'),
  response: z.object({ clientDataJSON: b64, attestationObject: b64, authenticatorData: b64.optional(), transports: z.array(z.string().max(32)).max(8).optional(), publicKeyAlgorithm: z.number().optional(), publicKey: b64.optional() }),
  clientExtensionResults: z.record(z.string(), z.unknown()).default({}),
  authenticatorAttachment: z.string().max(32).nullish(),
});
export type Assertion = z.infer<typeof assertionSchema>;
export type Attestation = z.infer<typeof attestationSchema>;

interface PasskeyRow {
  id: string;
  user_id: string;
  name: string;
  credential_id: string;
  public_key: string;
  counter: number | null;
  transports: string | null;
  confirmed_at: string | null;
  flagged_at: string | null;
  created_at: string;
  last_used_at: string | null;
}

const passkeys = (userId: string) => authDb().all<PasskeyRow>(`SELECT * FROM user_mfa_factors WHERE user_id = ? AND kind = 'webauthn' AND confirmed_at IS NOT NULL ORDER BY created_at`, userId);
const transportsOf = (row: PasskeyRow) => (row.transports ? row.transports.split(',').filter(Boolean) : undefined);
const GONE = 'This passkey request has expired. Start again.';

/** Whether the person has a confirmed, unflagged passkey: what makes `webauthn` a sign-in method. */
export const hasUsablePasskey = (userId: string): boolean => passkeys(userId).some((row) => !row.flagged_at);

/** Step 1 of adding a passkey: options for `navigator.credentials.create()` and the token that must come back with the answer. */
export async function registrationOptions(user: UserRecord): Promise<{ challenge: string; options: PublicKeyCredentialCreationOptionsJSON }> {
  if (!user.passwordHash) throw new MfaError('Accounts that sign in with single sign-on use their identity provider’s second factor', 409);
  const existing = passkeys(user.id);
  if (existing.length >= MAX_PASSKEYS) throw new MfaError(`You can have up to ${MAX_PASSKEYS} passkeys. Remove one to add another`, 409);
  const rp = relyingParty();
  const options = await generateRegistrationOptions({
    rpName: rp.name,
    rpID: rp.id,
    userName: user.email,
    userDisplayName: user.name,
    userID: new TextEncoder().encode(user.id),
    attestationType: 'none',
    timeout: TIMEOUT_MS,
    excludeCredentials: existing.map((row) => ({ id: row.credential_id, transports: transportsOf(row) })),
    // A second factor, not a passwordless login: no discoverable credential needed, verification asked for but not forced.
    authenticatorSelection: { residentKey: 'discouraged', userVerification: 'preferred' },
  });
  const challenge = await openChallenge(user, 'register', 'password');
  await setWebauthnChallenge(challenge, options.challenge);
  return { challenge, options };
}

/** The challenge row of `token` when it is live and of this purpose and this person; else the "expired" error. */
function ownChallenge(token: string, purpose: ChallengePurpose, userId: string) {
  const row = peekChallenge(token);
  if (!row || row.purpose !== purpose || row.userId !== userId) throw new MfaError(GONE, 400);
}

/** Step 2: verify the authenticator's answer and keep the new passkey. The first factor of any kind brings the recovery codes, returned once. */
export async function finishRegistration(user: UserRecord, token: string, name: string, response: Attestation): Promise<{ factor: MfaFactorView; recoveryCodes?: string[] }> {
  ownChallenge(token, 'register', user.id);
  const expected = await consumeWebauthnChallenge(token);
  if (!expected) throw new MfaError(GONE, 400);
  const rp = relyingParty();
  let verified: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
  try {
    verified = await verifyRegistrationResponse({ response: response as unknown as RegistrationResponseJSON, expectedChallenge: expected, expectedOrigin: rp.origin, expectedRPID: rp.id, requireUserVerification: false });
  } catch {
    throw new MfaError('That passkey could not be verified. Try again.', 400);
  }
  const credential = verified.verified ? verified.registrationInfo?.credential : undefined;
  if (!credential) throw new MfaError('That passkey could not be verified. Try again.', 400);
  const db = authDb();
  if (passkeys(user.id).length >= MAX_PASSKEYS) throw new MfaError(`You can have up to ${MAX_PASSKEYS} passkeys. Remove one to add another`, 409);
  // A credential id is one passkey in the whole instance (also a unique index); the answer names no account.
  if (db.get('SELECT 1 AS one FROM user_mfa_factors WHERE credential_id = ?', credential.id)) throw new MfaError('That passkey is already registered', 409);
  if (!(await useChallenge(token))) throw new MfaError(GONE, 400);
  const first = !db.get(`SELECT 1 AS one FROM user_mfa_factors WHERE user_id = ? AND confirmed_at IS NOT NULL LIMIT 1`, user.id);
  const now = new Date().toISOString();
  const id = `mfa_${nanoid(14)}`;
  db.insertNew('user_mfa_factors', {
    id,
    user_id: user.id,
    kind: 'webauthn',
    name,
    credential_id: credential.id,
    public_key: isoBase64URL.fromBuffer(credential.publicKey),
    counter: credential.counter,
    transports: (credential.transports ?? response.response.transports ?? []).join(',') || null,
    confirmed_at: now,
    created_at: now,
  });
  const recoveryCodes = first ? newRecoveryCodes(user.id) : undefined;
  recordAudit({ action: 'auth.mfa_added', target: { type: 'user', id: user.id }, summary: 'Added a second factor', details: { kind: 'webauthn', factorId: id } });
  return { factor: { id, kind: 'webauthn', name, confirmed: true, createdAt: now }, ...(recoveryCodes && { recoveryCodes }) };
}

/** Options for `navigator.credentials.get()` for the person's usable passkeys, tied to `token` (a sign-in or step-up challenge). */
export async function authenticationOptions(userId: string, token: string): Promise<PublicKeyCredentialRequestOptionsJSON> {
  const usable = passkeys(userId).filter((row) => !row.flagged_at);
  if (usable.length === 0) throw new MfaError('You have no passkey', 409);
  const options = await generateAuthenticationOptions({
    rpID: relyingParty().id,
    allowCredentials: usable.map((row) => ({ id: row.credential_id, transports: transportsOf(row) })),
    userVerification: 'preferred',
    timeout: TIMEOUT_MS,
  });
  if (!(await setWebauthnChallenge(token, options.challenge))) throw new MfaError('This sign-in has expired. Sign in again.', 401);
  return options;
}

/** A step-up challenge for a signed-in person, with the options their passkeys answer. */
export async function stepUpOptions(user: UserRecord): Promise<{ challenge: string; options: PublicKeyCredentialRequestOptionsJSON }> {
  const challenge = await openChallenge(user, 'step-up', 'password');
  return { challenge, options: await authenticationOptions(user.id, challenge) };
}

/**
 * Does `response` answer the challenge of `token` with one of the person's passkeys? The WebAuthn challenge is taken
 * first (works once; a failed try burns it), the signature, origin and relying party are verified, then the counter is
 * moved forward in one conditional write. The library gets counter 0 so it does not judge the counter itself: ours
 * flags a regression (below, or equal and not zero) and audits it.
 */
export async function verifyPasskey(userId: string, token: string, response: Assertion, now = Date.now()): Promise<boolean> {
  const expected = await consumeWebauthnChallenge(token, now);
  if (!expected) return false;
  const row = authDb().get<PasskeyRow>(`SELECT * FROM user_mfa_factors WHERE credential_id = ? AND user_id = ? AND kind = 'webauthn' AND confirmed_at IS NOT NULL`, response.id, userId);
  if (!row || row.flagged_at) return false;
  const rp = relyingParty();
  let counter: number;
  try {
    const result = await verifyAuthenticationResponse({
      response: response as unknown as AuthenticationResponseJSON,
      expectedChallenge: expected,
      expectedOrigin: rp.origin,
      expectedRPID: rp.id,
      credential: { id: row.credential_id, publicKey: isoBase64URL.toBuffer(row.public_key) as Uint8Array<ArrayBuffer>, counter: 0, transports: transportsOf(row) as never },
      requireUserVerification: false,
    });
    if (!result.verified) return false;
    counter = result.authenticationInfo.newCounter;
  } catch {
    return false;
  }
  const at = new Date(now).toISOString();
  const forward = await takeOnce({
    table: 'user_mfa_factors',
    key: { id: row.id },
    set: { counter, last_used_at: at },
    when: 'flagged_at IS NULL AND (counter IS NULL OR counter < ? OR (counter = 0 AND ? = 0))',
    whenParams: [counter, counter],
    check: (r) => !r.flagged_at && (r.counter == null || Number(r.counter) < counter || (Number(r.counter) === 0 && counter === 0)),
  });
  if (forward) return true;
  const flagged = await takeOnce({ table: 'user_mfa_factors', key: { id: row.id }, set: { flagged_at: at }, when: 'flagged_at IS NULL', whenParams: [], check: (r) => !r.flagged_at });
  if (flagged) {
    const user = authDb().get<{ id: string; name: string; email: string }>('SELECT id, name, email FROM users WHERE id = ?', userId);
    recordAudit({ action: 'auth.mfa_flagged', outcome: 'failure', ...(user && { actor: { id: user.id, name: user.name, email: user.email } }), target: { type: 'user', id: userId }, summary: 'Flagged a passkey whose signature counter went back', details: { kind: 'webauthn', factorId: row.id } });
  }
  return false;
}

/** A signed-in person's passkey answer to a step-up challenge (made by `stepUpOptions`, theirs only); spends the challenge on success. */
export async function stepUpPasskey(user: UserRecord, token: string, response: Assertion): Promise<boolean> {
  const row = peekChallenge(token);
  if (!row || row.purpose !== 'step-up' || row.userId !== user.id) return false;
  if (!(await verifyPasskey(user.id, token, response))) return false;
  return Boolean(await useChallenge(token));
}
