/**
 * Signed resume URLs. `/api/waiting/<id>` and `/form/waiting/<id>` are public and the execution id used to be the only
 * credential; ids show up in logs, spans and the UI. A signature (HMAC of the id under a key derived from the
 * encryption key) in `?sig=` makes the URL itself the secret. LANDFLOW_RESUME_SIGNATURES: `required` (the default in
 * production: a wait saved with `signed: true` needs a valid sig) or `optional` (the development default: URLs are
 * handed out unsigned and unsigned calls are accepted, but a wrong sig is still refused).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { envString, isProduction } from './config';
import { credentials } from './credentials/vault';

export type ResumeSignatureMode = 'required' | 'optional';

export function resumeSignatureMode(): ResumeSignatureMode {
  const value = envString('LANDFLOW_RESUME_SIGNATURES')?.toLowerCase();
  if (value === 'required' || value === 'optional') return value;
  return isProduction() ? 'required' : 'optional';
}

const signWith = (key: Buffer, id: string) => createHmac('sha256', key).update(id).digest('base64url').slice(0, 32);

/** base64url(HMAC-SHA256(deriveKey('resume-url'), id)), 32 characters. */
export function resumeSignature(id: string): string {
  return signWith(credentials.deriveKey('resume-url'), id);
}

export function verifyResumeSignature(id: string, sig: string | null | undefined): boolean {
  if (!sig) return false;
  const given = Buffer.from(sig);
  // Any key of the ring, and the pre-HKDF one: URLs already handed out outlive a rotation and the upgrade.
  return credentials.deriveKeys('resume-url').some((key) => {
    const expected = Buffer.from(signWith(key, id));
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

/**
 * Whether a resume call may proceed: a wrong sig never; a missing one only when signatures are optional or the wait
 * predates signing (`signed` unset, so URLs handed out before an upgrade keep working).
 */
export function checkResume(id: string, sig: string | null, wait: { signed?: boolean }): { ok: true; legacy: boolean } | { ok: false } {
  if (sig) return verifyResumeSignature(id, sig) ? { ok: true, legacy: false } : { ok: false };
  if (resumeSignatureMode() === 'optional' || !wait.signed) return { ok: true, legacy: resumeSignatureMode() === 'required' };
  return { ok: false };
}

/** The path of a waiting form page, with the signature when signatures are required (redirects to the next page use it). */
export function resumeFormPath(id: string): string {
  return `/form/waiting/${id}${resumeSignatureMode() === 'required' ? `?sig=${resumeSignature(id)}` : ''}`;
}
