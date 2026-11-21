/**
 * Bound claims for the JWT Auth credential (a Webhook or Form Trigger's `jwtAuth`): a signed token from a multi-tenant
 * CI issuer (GitHub Actions, GitLab) proves only that *some* repository's job minted it, so the credential must also
 * pin which one. The text is one `claim: pattern` per line (`#` comments and blank lines ignored); every line must
 * hold. A pattern is an exact value, or has `*` standing for any text inside one `/`- or `:`-separated segment
 * (`repo:my-org/app:ref:refs/heads/*`); there is no regex. A claim whose value is an array matches when any element
 * does; a number, boolean or missing claim never matches. Pure: no I/O, so the credential's Test and the webhook check
 * share it (webhook-auth.ts, nodes/credentials.ts).
 */
import type { JWTPayload } from 'jose';
import type { JsonObject } from '@landflow/protocol';

export interface BoundClaim {
  claim: string;
  pattern: string;
}

/** Issuers that sign tokens for every customer's jobs, so a valid signature says nothing about whose job it was. */
export const PUBLIC_CI_ISSUERS: readonly string[] = ['https://token.actions.githubusercontent.com', 'https://gitlab.com'];
const PUBLIC_CI_HOSTS: readonly string[] = PUBLIC_CI_ISSUERS.map((issuer) => new URL(issuer).host);

/** Claims that name the repository or project (GitHub's `repository`, GitLab's `project_path`) or the job's subject. */
export const BINDING_CLAIMS: readonly string[] = ['sub', 'repository', 'project_path'];

const LINE = /^([^\s:]+)\s*:\s*(\S.*)$/;

/** Reads the credential's text; `problems` names every line that is not `claim: pattern`. */
export function parseBoundClaims(text: string): { claims: BoundClaim[]; problems: string[] } {
  const claims: BoundClaim[] = [];
  const problems: string[] = [];
  String(text ?? '')
    .split(/\r?\n/)
    .forEach((raw, index) => {
      const line = raw.trim();
      if (!line || line.startsWith('#')) return;
      const match = LINE.exec(line);
      if (match) claims.push({ claim: match[1], pattern: match[2].trim() });
      else problems.push(`line ${index + 1}: expected “claim: pattern”`);
    });
  return { claims, problems };
}

/** Whether `value` matches `pattern` (`*` within one segment, everything else literal). */
export function matchesGlob(pattern: string, value: string): boolean {
  const source = pattern
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^/:]*');
  return new RegExp(`^${source}$`).test(value);
}

const trimSlash = (value: string) => value.replace(/\/+$/, '').toLowerCase();

/** Whether the credential trusts a public CI issuer: by its issuer, by its JWKS host, or by the verified token's `iss`. */
export function isPublicCiIssuer(credential: JsonObject, verifiedIss?: string): boolean {
  const issuers = PUBLIC_CI_ISSUERS.map(trimSlash);
  for (const candidate of [credential.issuer, verifiedIss]) {
    if (typeof candidate === 'string' && issuers.includes(trimSlash(candidate))) return true;
  }
  const url = String(credential.jwksUrl ?? '').trim();
  if (!url) return false;
  try {
    return PUBLIC_CI_HOSTS.includes(new URL(url).host.toLowerCase());
  } catch {
    return false;
  }
}

/** A bound claim narrows to one repository only when it is a binding claim and its pattern does not open with `*`. */
const binds = ({ claim, pattern }: BoundClaim) => BINDING_CLAIMS.includes(claim) && !pattern.startsWith('*');

/** What a refused CI credential tells whoever sets it up: exactly what to add, and where. */
export function claimsRequiredMessage(): string {
  return (
    'A GitHub Actions or GitLab token needs a bound claim, or a token from any repository could start this workflow. ' +
    'Open the JWT Auth credential, find Bound Claims and add a line such as “repository: my-org/my-repo” (GitHub) or ' +
    '“project_path: my-group/my-project” (GitLab); a “sub” line also works. The pattern must not start with *.'
  );
}

export type ClaimsCheck = { ok: true } | { ok: false; reason: 'claims_required' | 'claim_mismatch' | 'claims_invalid'; claim?: string; message?: string };

/** The credential's rules alone, before any token is looked at (a CI credential with no binding, or unreadable text). */
export function checkCredentialClaims(credential: JsonObject, verifiedIss?: string): ClaimsCheck {
  const { claims, problems } = parseBoundClaims(String(credential.boundClaims ?? ''));
  if (problems.length) return { ok: false, reason: 'claims_invalid', message: `Bound Claims: ${problems.join('; ')}` };
  if (isPublicCiIssuer(credential, verifiedIss) && !claims.some(binds)) return { ok: false, reason: 'claims_required', message: claimsRequiredMessage() };
  return { ok: true };
}

/** The credential's rules, then each bound claim against a token that already verified. */
export function checkBoundClaims(credential: JsonObject, payload: JWTPayload): ClaimsCheck {
  const rules = checkCredentialClaims(credential, typeof payload.iss === 'string' ? payload.iss : undefined);
  if (!rules.ok) return rules;
  for (const { claim, pattern } of parseBoundClaims(String(credential.boundClaims ?? '')).claims) {
    const value = (payload as Record<string, unknown>)[claim];
    const values = Array.isArray(value) ? value : [value];
    if (!values.some((item) => typeof item === 'string' && matchesGlob(pattern, item))) return { ok: false, reason: 'claim_mismatch', claim };
  }
  return { ok: true };
}
