/**
 * Who a person without a Landflow account is (docs/access-requests.md#signing-in-without-an-account): their verified address, proved
 * by a one-time email link or by Google sign-in, and nothing else. Never a Landflow user: an address that belongs to one gets no outside
 * identity (a mail points it to Landflow's own Access page), so there are never two identities for one email.
 *
 * Email link: 32 random bytes, only the SHA-256 kept, 15 minutes, single use by one conditional update (`claimLink`), one live link per
 * address; asked for through an answer that is the same whatever happens (a refused address, a limit, a Landflow user all read "if that
 * address may ask here, a link is on its way"), with the mail sent after the answer so timing tells nothing; the one visible refusal is
 * the per-network-address limit. Google: the OpenID Connect code flow with PKCE, state, nonce, `email_verified` and an allowed `hd`.
 * Every outcome is an `access.outside.*` audit event; a token, a code or a secret never is.
 */
import { nanoid } from 'nanoid';
import { recordAudit } from '../../audit';
import { mailConfigured, sendMail } from '../../auth/mail';
import { beginCodeFlow, finishCodeFlow, OidcError, type OidcClient } from '../../auth/oidc';
import { randomToken, tokenHash } from '../../auth/passwords';
import { credentials } from '../../credentials/vault';
import { HttpError } from '../../errors';
import { singleton } from '../../singleton';
import { logger } from '../../telemetry/logger';
import { GOOGLE_ISSUER, OIDC_CLIENT_TYPE } from '../../nodes/oidc-client-credential';
import { outsideLimiters } from './limits';
import { startSession } from './sessions';
import { domainAllowed, domainOf, GOOGLE_CALLBACK_PATH, googleReady, OUTSIDE_PAGE_PATH, outsideSettings } from './settings';
import { canonicalEmail, claimLink, deleteOpenLinks, hasSubaddress, insertLink, landflowUserWithEmail, requesterRow, requesterRowByKey, saveRequester, toRequester, type RequesterRow } from './store';

/** A person without a Landflow account, as the rest of Landflow sees them. `id` starts with `ext_`: never a Landflow user id. */
export type OutsideRequester = { id: string; email: string; name: string | null; verifiedBy: 'link' | 'google'; blocked: boolean };

export const getOutsideRequester = (id: string): OutsideRequester | undefined => {
  const row = requesterRow(id);
  return row ? toRequester(row) : undefined;
};

/** By address, compared on its canonical form. */
export const outsideRequesterByEmail = (email: string): OutsideRequester | undefined => {
  const row = requesterRowByKey(canonicalEmail(email));
  return row ? toRequester(row) : undefined;
};

const LINK_TTL_MS = 15 * 60_000;

/** Why a sign-in was refused: the page maps `code` to a sentence; the HTTP status is the one the routes answer with. */
export class OutsideAuthError extends HttpError {
  static readonly errorName: string = 'OutsideAuthError';
  constructor(
    readonly reason: 'expired' | 'domain' | 'blocked' | 'landflow_user' | 'not_verified' | 'subject_changed' | 'denied' | 'failed' | 'google_off' | 'limited' | 'off',
    message: string,
    status: number,
    details?: Record<string, unknown>,
  ) {
    super(message, status, { code: reason, expose: true, ...(details && { details }) });
  }
}

export const SIGN_IN_ASKED = 'If that address may ask here, a sign-in link is on its way. It works once, for 15 minutes.';
const EXPIRED = 'This link has expired or was already used. Ask for a new one.';

const clip = (text: string, max = 200) => (text.length > max ? `${text.slice(0, max)}…` : text);

function auditSignIn(outcome: 'success' | 'denied', method: 'link' | 'google', email: string | undefined, extra: Record<string, unknown> = {}, requester?: RequesterRow) {
  recordAudit({
    action: 'access.outside.sign_in',
    outcome,
    actor: requester ? { id: requester.id, name: requester.name ?? requester.email, email: requester.email } : 'anonymous',
    target: { type: 'access_outside', id: requester?.id ?? 'sign-in', name: email ? clip(email, 120) : 'sign-in' },
    project: null,
    summary: outcome === 'success' ? `${email} signed in to ask for access (${method === 'google' ? 'Google' : 'email link'})` : `A sign-in to ask for access was refused (${method === 'google' ? 'Google' : 'email link'})`,
    details: { method, ...(email && { email: clip(email, 120) }), ...extra },
  });
}

// ---- the email link ---------------------------------------------------------------------------------------

export type LinkDenial = 'off' | 'subaddress' | 'domain' | 'blocked' | 'limit' | 'landflow_user' | 'mail';

export type LinkResult =
  /** Answer 202 with `SIGN_IN_ASKED` whatever happened. `denial` is for the audit row and for tests, never for the page. `delivery` settles when the mail did. */
  | { limited: false; denial?: LinkDenial; delivery?: Promise<void> }
  /** The one refusal an asker sees: too many asks from this network address. */
  | { limited: true; retryAfter: number };

const deliveries = () => singleton('access-outside-deliveries', () => new Set<Promise<void>>());
/** Tests (and a shutdown): wait for the mails started so far. */
export const mailSettled = async (): Promise<void> => {
  await Promise.allSettled([...deliveries()]);
};

function deliver(to: string, subject: string, lines: string[]): Promise<void> {
  const task = sendMail({ to, subject, text: `${lines.join('\n')}\n` })
    .catch((error: unknown) => logger.warn('a sign-in email for an access request could not be sent', { error: (error as Error).message }))
    .finally(() => deliveries().delete(task));
  deliveries().add(task);
  return task;
}

const lastLimitNote = () => singleton('access-outside-domain-limit-note', () => new Map<string, number>());

/**
 * Someone asked for a sign-in link for `email`. Decides, silently, whether one is sent: the feature on, a `+`-free address of an allowed
 * domain, not blocked, within the limits, not a Landflow user's (who is mailed a pointer to Landflow's Access page, with no token). `origin`
 * is the emailed origin (never taken from a request header in production); without it or without SMTP nothing is sent.
 */
export async function requestLink(email: string, meta: { ip: string; origin?: string; now?: number }): Promise<LinkResult> {
  const now = meta.now ?? Date.now();
  const limits = outsideLimiters();
  const ip = await limits.ip.check(meta.ip, now);
  if (!ip.ok) return { limited: true, retryAfter: ip.retryAfter };
  await limits.ip.hit(meta.ip, now);

  const address = email.trim().toLowerCase();
  const key = canonicalEmail(address);
  const domain = domainOf(address);
  const settings = outsideSettings();
  const deny = (denial: LinkDenial, extra: Record<string, unknown> = {}): LinkResult => {
    recordAudit({
      action: 'access.outside.link',
      outcome: 'denied',
      actor: 'anonymous',
      target: { type: 'access_outside', id: clip(key, 120), name: clip(key, 120) },
      project: null,
      summary: `A sign-in link for ${clip(key, 120)} was not sent (${denial})`,
      details: { reason: denial, email: clip(key, 120), ...extra },
    });
    return { limited: false, denial };
  };

  if (!settings.enabled) return deny('off');
  if (hasSubaddress(address)) return deny('subaddress');
  if (!domainAllowed(address, settings)) return deny('domain');
  if (requesterRowByKey(key)?.blocked_at) return deny('blocked');

  const overAddress = !(await limits.address.check(key, now)).ok || !(await limits.addressDay.check(key, now)).ok;
  const overDomain = !(await limits.domain.check(domain, now)).ok;
  if (overAddress) return deny('limit', { scope: 'address' });
  if (overDomain) {
    // An abuse signal for the admin, once an hour: the audit log is not for a flood to fill.
    const notes = lastLimitNote();
    const hour = Math.floor(now / 3_600_000);
    if (notes.get(domain) === hour) return { limited: false, denial: 'limit' };
    notes.set(domain, hour);
    return deny('limit', { scope: 'domain', domain });
  }
  await limits.address.hit(key, now);
  await limits.addressDay.hit(key, now);
  await limits.domain.hit(domain, now);

  if (!meta.origin || !mailConfigured()) return deny('mail');

  if (landflowUserWithEmail(address)) {
    const result = deny('landflow_user');
    if (result.limited) return result;
    return { ...result, delivery: deliver(address, 'You have a Landflow account', ['Someone asked for a sign-in link for this address on the page for people without a Landflow account.', 'You have a Landflow account, so ask for access on Landflow’s own Access page. Nothing else is needed.', '', `${meta.origin}/access`]) };
  }

  const token = randomToken(32);
  deleteOpenLinks(key);
  insertLink({ id: `ol_${nanoid(12)}`, token_hash: tokenHash(token), email_key: key, email: address, ip: meta.ip.slice(0, 64), created_at: new Date(now).toISOString(), expires_at: new Date(now + LINK_TTL_MS).toISOString(), used_at: null });
  recordAudit({
    action: 'access.outside.link',
    outcome: 'success',
    actor: 'anonymous',
    target: { type: 'access_outside', id: clip(key, 120), name: clip(key, 120) },
    project: null,
    summary: `A sign-in link was sent to ${clip(key, 120)}`,
    details: { email: clip(key, 120) },
  });
  // The token is in the fragment (`#t=`): a browser never sends it to the server, a proxy log or a Referer.
  const delivery = deliver(address, 'Your link to ask for access', ['Use this link to sign in and ask for access. It works once, for 15 minutes.', '', `${meta.origin}${OUTSIDE_PAGE_PATH}#t=${token}`, '', 'If you did not ask for this, ignore this email: nothing happens until the link is used.']);
  return { limited: false, delivery };
}

/** Make or refresh the requester of a verified address, or refuse it: the one place both ways of signing in end. Synchronous on purpose (find then insert in one tick). */
function admit(email: string, method: 'link' | 'google', extra: { name?: string | null; subject?: string; now: number }): RequesterRow {
  const settings = outsideSettings();
  const key = canonicalEmail(email);
  if (!settings.enabled) throw new OutsideAuthError('off', 'Asking here is switched off', 404);
  if (hasSubaddress(email) || !domainAllowed(email, settings)) throw new OutsideAuthError('domain', 'This address can’t ask for access here', 403);
  const existing = requesterRowByKey(key);
  if (existing?.blocked_at) throw new OutsideAuthError('blocked', 'You can’t ask for access here. Ask an admin.', 403);
  if (landflowUserWithEmail(email)) throw new OutsideAuthError('landflow_user', 'You have a Landflow account. Ask for access on Landflow’s own Access page.', 409, { signInUrl: '/access' });
  if (existing?.google_subject && extra.subject && existing.google_subject !== extra.subject) {
    throw new OutsideAuthError('subject_changed', 'This address now belongs to another Google account. Ask an admin.', 403);
  }
  const at = new Date(extra.now).toISOString();
  const row: RequesterRow = existing
    ? { ...existing, verified_by: method, last_verified_at: at, last_seen_at: at, name: extra.name || existing.name, google_subject: existing.google_subject ?? extra.subject ?? null }
    : { id: `ext_${nanoid(12)}`, email: email.trim().toLowerCase(), email_key: key, name: extra.name || null, verified_by: method, google_subject: extra.subject ?? null, created_at: at, last_verified_at: at, last_seen_at: at, blocked_at: null, blocked_by: null };
  saveRequester(row);
  return row;
}

export interface SignedIn {
  requester: OutsideRequester;
  /** The cookie value and when it ends. */
  session: { token: string; expiresAt: Date };
}

/** The person opened a sign-in link: use it up (once, whoever is first) and start their session. */
export async function verifyLink(token: string, meta: { ip: string; userAgent?: string; replacing?: string; now?: number }): Promise<SignedIn> {
  const now = meta.now ?? Date.now();
  const failures = outsideLimiters().verifyFailures;
  const checked = await failures.check(meta.ip, now);
  if (!checked.ok) throw new OutsideAuthError('limited', 'Too many attempts. Try again later.', 429, { retryAfter: checked.retryAfter });
  const link = token && token.length <= 200 ? await claimLink(tokenHash(token), now) : undefined;
  if (!link) {
    await failures.hit(meta.ip, now);
    auditSignIn('denied', 'link', undefined, { reason: 'expired' });
    throw new OutsideAuthError('expired', EXPIRED, 400);
  }
  let row: RequesterRow;
  try {
    row = admit(link.email, 'link', { now });
  } catch (error) {
    if (error instanceof OutsideAuthError) auditSignIn('denied', 'link', link.email, { reason: error.reason });
    throw error;
  }
  const session = startSession(row.id, 'link', { ip: meta.ip, userAgent: meta.userAgent, replacing: meta.replacing, now });
  auditSignIn('success', 'link', row.email, {}, row);
  return { requester: toRequester(row), session };
}

// ---- Google -----------------------------------------------------------------------------------------------

/** The OpenID Connect client of the credential an admin chose, with its secret read from the vault now. */
async function googleClient(): Promise<OidcClient> {
  const settings = outsideSettings();
  if (!googleReady(settings)) throw new OutsideAuthError('google_off', 'Sign in with Google is not available', 404);
  const id = settings.google.credentialId!;
  const data = await credentials.dataWithSecrets({ id, name: credentials.get(id)?.name ?? id }, OIDC_CLIENT_TYPE);
  const issuer = String(data.issuer || GOOGLE_ISSUER).trim().replace(/\/+$/, '');
  const clientId = String(data.clientId ?? '').trim();
  if (!clientId) throw new OutsideAuthError('google_off', 'Sign in with Google is not available', 404);
  return {
    issuer,
    clientId,
    ...(data.clientSecret && { clientSecret: String(data.clientSecret) }),
    ...(typeof data.discoveryUrl === 'string' && data.discoveryUrl.trim() && { discoveryUrl: data.discoveryUrl.trim() }),
    // Google's ID tokens carry either spelling of its issuer.
    ...(issuer === GOOGLE_ISSUER && { issuerAliases: ['accounts.google.com'] }),
  };
}

/** Where Google sends the browser back (register this URL with the OAuth client). */
export const googleRedirectUri = (origin: string) => `${origin}${GOOGLE_CALLBACK_PATH}`;

/** Step 1: the URL to send the browser to, and the state for its cookie. `hd` is only a hint, and only with one allowed domain. */
export async function beginGoogle(origin: string, meta: { ip: string; now?: number }): Promise<{ url: string; state: string }> {
  const now = meta.now ?? Date.now();
  const starts = outsideLimiters().googleStarts;
  const checked = await starts.check(meta.ip, now);
  if (!checked.ok) throw new OutsideAuthError('limited', 'Too many attempts. Try again later.', 429, { retryAfter: checked.retryAfter });
  const client = await googleClient();
  await starts.hit(meta.ip, now);
  const { domains } = outsideSettings();
  return beginCodeFlow(client, {
    redirectUri: googleRedirectUri(origin),
    scopes: 'openid email profile',
    purpose: 'outside',
    extra: { prompt: 'select_account', ...(domains.length === 1 && { hd: domains[0] }) },
  });
}

/** Step 2: the browser is back from Google. Every refusal is an `OutsideAuthError` the callback turns into `?error=<reason>`. */
export async function completeGoogle(
  params: { code?: string | null; state?: string | null; cookieState?: string; error?: string | null },
  meta: { ip: string; userAgent?: string; replacing?: string; now?: number },
): Promise<SignedIn> {
  const now = meta.now ?? Date.now();
  const refuse = (error: OutsideAuthError, email?: string): never => {
    auditSignIn('denied', 'google', email, { reason: error.reason });
    throw error;
  };
  if (params.error) refuse(new OutsideAuthError('denied', 'Google sign-in was cancelled', 400));
  const client = await googleClient().catch((error: unknown) => (error instanceof OutsideAuthError ? refuse(error) : Promise.reject(error)));
  let claims;
  try {
    ({ claims } = await finishCodeFlow(client, { code: params.code, state: params.state, cookieState: params.cookieState, purpose: 'outside' }));
  } catch (error) {
    if (!(error instanceof OidcError)) throw error;
    // The message names no secret (a state problem, or what the provider said); it is kept in the audit row, clipped.
    const stale = error.message.startsWith('This sign-in expired') || error.message.startsWith('The provider sent no authorization code');
    return refuse(new OutsideAuthError(stale ? 'expired' : 'failed', stale ? 'This sign-in expired or was started in another browser. Try again.' : 'Google sign-in did not work. Try again.', 400, { detail: clip(error.message) }));
  }
  const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : '';
  if (!email) refuse(new OutsideAuthError('failed', 'Google did not share an email address', 400));
  // Strictly `true`: an unverified address proves nothing.
  if (claims.email_verified !== true) refuse(new OutsideAuthError('not_verified', 'Google has not verified this email address', 403), email);
  const hd = typeof claims.hd === 'string' ? claims.hd.trim().toLowerCase() : '';
  const settings = outsideSettings();
  // A Workspace account names its domain; a personal Gmail account has none and is refused, as is a domain no one listed.
  if (!hd || !settings.domains.includes(hd) || domainOf(email) !== hd) refuse(new OutsideAuthError('domain', 'Use your work Google account, from an allowed organization', 403), email);
  let row: RequesterRow;
  try {
    row = admit(email, 'google', { now, subject: String(claims.sub), name: typeof claims.name === 'string' ? clip(claims.name.trim(), 100) : null });
  } catch (error) {
    if (error instanceof OutsideAuthError) refuse(error, email);
    throw error;
  }
  const session = startSession(row.id, 'google', { ip: meta.ip, userAgent: meta.userAgent, replacing: meta.replacing, now });
  auditSignIn('success', 'google', row.email, {}, row);
  return { requester: toRequester(row), session };
}
