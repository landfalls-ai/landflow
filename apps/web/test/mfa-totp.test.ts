/**
 * C16 / P15a: the second-factor building blocks. TOTP by hand (RFC 6238 vectors, ±1 step, no reuse of a step), recovery
 * codes (Crockford base32, keyed hash, one use), the one-use challenge, the sealed secret and its re-sealing on key
 * rotation, and the migration (2923).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-mfa-totp-'));
const N0 = 'ab'.repeat(32);
const ENV: Record<string, string> = { LANDFLOW_ENCRYPTION_KEYS: `n1:a new passphrase for the vault,n0:${N0}`, LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const ring = await import('@/lib/server/credentials/key-ring');
const totp = await import('@/lib/server/auth/mfa/totp');
const recovery = await import('@/lib/server/auth/mfa/recovery');
const factors = await import('@/lib/server/auth/mfa/factors');
const challenges = await import('@/lib/server/auth/mfa/challenges');
const auth = await import('@/lib/server/auth');
const { database } = await import('@/lib/server/db');
const { TABLES, MIGRATIONS } = await import('@/lib/server/db/schema');
const { rotateEncryption } = await import('@/lib/server/credentials/rotate');

afterAll(() => {
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

/** RFC 4226's test secret, base32 of "12345678901234567890". */
const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

describe('migration 2923', () => {
  it('adds the three tables, the session column and their TABLES rows', () => {
    const db = database();
    for (const table of ['user_mfa_factors', 'user_recovery_codes', 'mfa_challenges']) expect(db.get(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, table)).toBeTruthy();
    expect(db.all<{ name: string }>('PRAGMA table_info(sessions)').map((c) => c.name)).toContain('mfa_verified_at');
    expect(TABLES).toMatchObject({ user_mfa_factors: ['id'], user_recovery_codes: ['user_id', 'code_hash'], mfa_challenges: ['id'] });
    expect(MIGRATIONS.some((m) => m.version === 2923)).toBe(true);
  });
});

describe('TOTP', () => {
  it('matches the RFC 6238 SHA-1 vectors (6 digits)', () => {
    const at = (seconds: number) => totp.totpAt(RFC_SECRET, Math.floor(seconds / 30));
    expect(at(59)).toBe('287082');
    expect(at(1111111109)).toBe('081804');
    expect(at(1111111111)).toBe('050471');
    expect(at(1234567890)).toBe('005924');
    expect(at(2000000000)).toBe('279037');
    expect(at(20000000000)).toBe('353130');
  });

  it('accepts the previous, current and next step and refuses two steps away', () => {
    const now = 1_700_000_000_000;
    const step = Math.floor(now / 1000 / 30);
    expect(totp.matchingStep(RFC_SECRET, totp.totpAt(RFC_SECRET, step), now)).toBe(step);
    expect(totp.matchingStep(RFC_SECRET, totp.totpAt(RFC_SECRET, step - 1), now)).toBe(step - 1);
    expect(totp.matchingStep(RFC_SECRET, totp.totpAt(RFC_SECRET, step + 1), now)).toBe(step + 1);
    expect(totp.matchingStep(RFC_SECRET, totp.totpAt(RFC_SECRET, step - 2), now)).toBeUndefined();
    expect(totp.matchingStep(RFC_SECRET, totp.totpAt(RFC_SECRET, step + 2), now)).toBeUndefined();
    expect(totp.matchingStep(RFC_SECRET, 'abcdef', now)).toBeUndefined();
    expect(totp.matchingStep(RFC_SECRET, `${totp.totpAt(RFC_SECRET, step).slice(0, 3)} ${totp.totpAt(RFC_SECRET, step).slice(3)}`, now)).toBe(step);
  });

  it('makes a 32 character base32 secret and an otpauth URL that escapes the email', () => {
    const secret = totp.newTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(totp.newTotpSecret()).not.toBe(secret);
    const url = totp.otpauthUrl(secret, 'a+b c@example.test');
    expect(url).toBe(`otpauth://totp/Landflow:a%2Bb%20c%40example.test?secret=${secret}&issuer=Landflow&algorithm=SHA1&digits=6&period=30`);
  });

  it('draws the QR code as an SVG data URL', async () => {
    expect(await totp.qrSvgDataUrl('otpauth://totp/Landflow:x?secret=ABC')).toMatch(/^data:image\/svg\+xml;base64,/);
  });
});

describe('recovery codes (pure parts)', () => {
  it('makes ten different codes of the form xxxxx-xxxxx from Crockford base32', () => {
    const codes = recovery.generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
  });

  it('normalises case, the dash, spaces and the O/0 and I/L/1 mix-ups', () => {
    expect(recovery.normalizeRecoveryCode('ab12o-iL9zz')).toBe('AB1201 19ZZ'.replace(' ', ''));
    expect(recovery.normalizeRecoveryCode(' AB12O IL9ZZ ')).toBe(recovery.normalizeRecoveryCode('ab12o-il9zz'));
  });
});

describe('factors, recovery codes and challenges (stored)', () => {
  const userPromise = auth.createUser({ email: 'mfa-totp@example.test', name: 'Tess', role: 'member', password: 'a-long-password-1' });

  it('starts TOTP with a sealed secret that is never listed, and confirms it with a code', async () => {
    const user = await userPromise;
    const started = factors.startTotp(user);
    expect(started.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(started.otpauthUrl).toContain(started.secret);
    const row = database().get<{ secret: string; confirmed_at: string | null }>('SELECT secret, confirmed_at FROM user_mfa_factors WHERE id = ?', started.factorId)!;
    expect(row.secret).not.toContain(started.secret);
    expect(row.secret.startsWith('v2.')).toBe(true);
    expect(row.confirmed_at).toBeNull();
    expect(JSON.stringify(factors.listFactors(user.id))).not.toContain(started.secret);
    expect(factors.hasConfirmedFactor(user.id)).toBe(false);

    expect((await factors.confirmTotp(user, started.factorId, '000000')).ok).toBe(false);
    const confirmed = await factors.confirmTotp(user, started.factorId, totp.totpAt(started.secret, Math.floor(Date.now() / 30_000)));
    expect(confirmed.ok).toBe(true);
    expect(confirmed.recoveryCodes).toHaveLength(10);
    expect(factors.hasConfirmedFactor(user.id)).toBe(true);
    expect(recovery.recoveryCodesLeft(user.id)).toBe(10);
  });

  it('refuses the same code twice in its window (replay)', async () => {
    const user = await userPromise;
    const secret = factors.secretOf(factors.listFactors(user.id)[0].id);
    const now = Date.now();
    const step = Math.floor(now / 30_000);
    // The enrolment already used this step; the next one is fresh once, then spent.
    const next = totp.totpAt(secret, step + 1);
    expect(await factors.verifyTotp(user.id, next, now + 30_000)).toBe(true);
    expect(await factors.verifyTotp(user.id, next, now + 30_000)).toBe(false);
    // An older step than the last used one is refused too.
    expect(await factors.verifyTotp(user.id, totp.totpAt(secret, step), now + 30_000)).toBe(false);
  });

  it('uses a recovery code once, stores a keyed hash and counts what is left', async () => {
    const user = await userPromise;
    const codes = recovery.newRecoveryCodes(user.id);
    expect(recovery.recoveryCodesLeft(user.id)).toBe(10);
    const stored = database().all<{ code_hash: string }>('SELECT code_hash FROM user_recovery_codes WHERE user_id = ?', user.id).map((r) => r.code_hash);
    const { createHash } = await import('node:crypto');
    for (const code of codes) expect(stored).not.toContain(createHash('sha256').update(recovery.normalizeRecoveryCode(code)).digest('hex'));
    expect(await recovery.useRecoveryCode(user.id, codes[0].toLowerCase().replace('-', ''))).toEqual({ ok: true, left: 9 });
    expect(await recovery.useRecoveryCode(user.id, codes[0])).toEqual({ ok: false });
    expect(await recovery.useRecoveryCode(user.id, 'AAAAA-AAAAA')).toEqual({ ok: false });
    expect(recovery.recoveryCodesLeft(user.id)).toBe(9);
    // A new set replaces the old one.
    const fresh = recovery.newRecoveryCodes(user.id);
    expect(await recovery.useRecoveryCode(user.id, codes[1])).toEqual({ ok: false });
    expect(await recovery.useRecoveryCode(user.id, fresh[0])).toEqual({ ok: true, left: 9 });
  });

  it('opens a challenge that works once, burns after five wrong answers and expires after five minutes', async () => {
    const user = await userPromise;
    const token = await challenges.openChallenge(user, 'sign-in', 'password');
    expect(database().get('SELECT id FROM mfa_challenges WHERE id = ?', token)).toBeUndefined(); // only its hash is stored
    expect(challenges.peekChallenge(token)?.userId).toBe(user.id);
    expect((await challenges.useChallenge(token))?.userId).toBe(user.id);
    expect(await challenges.useChallenge(token)).toBeUndefined();
    expect(challenges.peekChallenge(token)).toBeUndefined();

    const burnt = await challenges.openChallenge(user, 'sign-in', 'password');
    for (let i = 0; i < 4; i++) expect(await challenges.noteWrong(burnt)).toBe('again');
    expect(await challenges.noteWrong(burnt)).toBe('burned');
    expect(challenges.peekChallenge(burnt)).toBeUndefined();
    expect(await challenges.useChallenge(burnt)).toBeUndefined();

    const old = await challenges.openChallenge(user, 'sign-in', 'reset');
    const later = Date.now() + 5 * 60_000 + 1000;
    expect(challenges.peekChallenge(old, later)).toBeUndefined();
    expect(await challenges.useChallenge(old, later)).toBeUndefined();
    expect(challenges.peekChallenge('not-a-token')).toBeUndefined();
  });

  it('re-seals the TOTP secret when the key ring rotates, and the code still verifies', async () => {
    const user = await userPromise;
    const [factor] = factors.listFactors(user.id);
    const secret = factors.secretOf(factor.id);
    // A secret sealed under the retired key n0, as a host before the rotation would have stored it.
    const old = ring.sealWith(ring.buildKeyRing(`n0:${N0}`, undefined), secret, 'landflow:secret');
    database().upsert('user_mfa_factors', { ...database().get<Record<string, string>>('SELECT * FROM user_mfa_factors WHERE id = ?', factor.id)!, secret: `v2.${old.kid}.${old.iv}.${old.tag}.${old.value}` });
    const rotated = rotateEncryption();
    const after = database().get<{ secret: string }>('SELECT secret FROM user_mfa_factors WHERE id = ?', factor.id)!.secret;
    expect(rotated.failed).toEqual([]);
    expect(rotated.stores.user_mfa_factors).toBe(1);
    expect(after.split('.')[1]).toBe('n1');
    expect(factors.secretOf(factor.id)).toBe(secret);
    expect(rotateEncryption().resealed).toBe(0);
  });
});
