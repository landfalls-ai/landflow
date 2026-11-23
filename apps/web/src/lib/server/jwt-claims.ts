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
import { parseBoundClaims, type BoundClaim } from '../shared/bound-claims';

export { parseBoundClaims, type BoundClaim } from '../shared/bound-claims';

/** Hosts whose tokens come from every customer's jobs, so a valid signature says nothing about whose job it was. */
export const PUBLIC_CI_ISSUERS: readonly string[] = ['https://token.actions.githubusercontent.com', 'https://gitlab.com'];

/** GitHub Actions (also GitHub Enterprise Cloud: `token.actions.<slug>.ghe.com`) and GitLab.com; compared by host. */
const isPublicCiHost = (host: string) => host === 'token.actions.githubusercontent.com' || host === 'gitlab.com' || /^token\.actions\.[^.]+\.ghe\.com$/.test(host);

/** Claims that name the repository, project or owner by id or path, or the job's subject. */
export const BINDING_CLAIMS: readonly string[] = ['sub', 'repository', 'project_path', 'repository_id', 'repository_owner_id', 'project_id', 'namespace_id'];

/** Whether `value` matches `pattern` (`*` within one segment, everything else literal). */
export function matchesGlob(pattern: string, value: string): boolean {
  const source = pattern
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^/:]*');
  return new RegExp(`^${source}$`).test(value);
}

/** The host of an issuer or JWKS URL, lower case with a trailing dot removed (`GitLab.com.` is `gitlab.com`). */
function hostOf(value: unknown): string {
  try {
    return new URL(String(value ?? '').trim()).hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return '';
  }
}

/** Whether the credential trusts a public CI issuer: by its issuer, by its JWKS host, or by the verified token's `iss`. */
export function isPublicCiIssuer(credential: JsonObject, verifiedIss?: string): boolean {
  return [credential.issuer, credential.jwksUrl, verifiedIss].some((value) => isPublicCiHost(hostOf(value)));
}

/**
 * A bound claim narrows to one owner only when its pattern has a literal owner: `repository` and `project_path` need a
 * `/` with no `*` before it (`my-org/` then a star is fine; a star inside the owner, as in `e*` or `my-org*`, is not); `sub` must open `repo:` or
 * `project_path:` followed by a literal owner and `/`; the id claims must contain no `*` at all.
 */
function binds({ claim, pattern }: BoundClaim): boolean {
  if (!BINDING_CLAIMS.includes(claim)) return false;
  if (claim === 'repository' || claim === 'project_path') return pattern.includes('/') && !pattern.slice(0, pattern.indexOf('/')).includes('*') && pattern.indexOf('/') > 0;
  if (claim === 'sub') return /^(repo|project_path):[^*/:]+\//.test(pattern);
  return !pattern.includes('*');
}

/** What a refused CI credential tells whoever sets it up: exactly what to add, and where. */
export function claimsRequiredMessage(): string {
  return (
    'A GitHub Actions or GitLab token needs a bound claim, or a token from any repository could start this workflow. ' +
    'Open the JWT Auth credential, find Bound Claims and add a line such as “repository: my-org/my-repo” (GitHub) or ' +
    '“project_path: my-group/my-project” (GitLab); a “sub” line starting “repo:my-org/” also works. The owner before the first / must be written out: no * in it.'
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
