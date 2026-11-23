/**
 * Who may call a Webhook trigger or submit a Form Trigger (n8n's names): `authentication` is `none`, `basicAuth`
 * (a Basic Auth credential: user and password), `headerAuth` (a Header Auth credential: header name and value) or
 * `jwtAuth` (a JWT Auth credential: an HS256/384/512 secret, a PEM public key or a JWKS URL, with optional issuer and
 * audience and Bound Claims, refused for GitHub Actions and GitLab tokens unless they pin a repository: jwt-claims.ts; with Single Use on a token
 * works once: token-replay.ts); `options.ipWhitelist` limits callers to a list of addresses and CIDR ranges.
 *
 * The client address comes from `clientAddress()` (net/client-address.ts): `X-Forwarded-For` trusted up to
 * LANDFLOW_TRUSTED_PROXIES hops; a request with no address counts as 127.0.0.1. Secrets are compared in constant time.
 * Failures answer 401 (with `WWW-Authenticate`) or 403 before the body is read, and start no run.
 *
 * The credential must be one the workflow's project may use (owned by it or shared with it, as for node credentials in
 * runs, lib/server/projects/credentials.ts): otherwise every call gets 403 before any secret is compared, the response
 * doesn't say which credential, and the host logs a warning with the workflow, node and credential id.
 */
import { createRemoteJWKSet, customFetch, importSPKI, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import type { JsonObject } from '@landflow/protocol';
import type { WorkflowNode } from '@landflow/engine';
import { sameSecret } from './auth/passwords';
import { credentials } from './credentials/vault';
import { metrics } from '@opentelemetry/api';
import { deniedReadDue } from './audit/http';
import { recordAudit } from './audit';
import { error } from './http';
import { checkBoundClaims, checkCredentialClaims, type ClaimsCheck } from './jwt-claims';
import { OutboundBlockedError, safeFetch } from './net/safe-fetch';
import { registry } from './plugins/registry';
import { triggerAuthCredential, triggerAuthUsable } from './projects/credentials';
import { useTokenOnce } from './token-replay';
import { singleton } from './singleton';
import { callerIp, ipMatches, parseIpList } from './net/ip-allow';
import { logger } from './telemetry/logger';
import type { WebhookAuthentication } from './nodes/webhook-auth';

export type WebhookAuthResult =
  | { ok: true; /** A verified JWT's claims (`jwtAuth`): runs get them as `item.json.jwtPayload`. */ jwtPayload?: JsonObject; /** Headers that carried the secret: left out of the item. */ secretHeaders: string[] }
  | { ok: false; response: Response };

const HMAC = ['HS256', 'HS384', 'HS512'];

// The IP allow-list helpers moved to ./net/ip-allow (API keys use them too); these names stay importable from here.
export { callerIp, ipMatches, parseIpList };

// ---------------------------------------------------------------------------
// JWT
// ---------------------------------------------------------------------------

/** Remote key sets by URL (jose caches the keys and refetches on an unknown `kid`). */
const keySets = singleton('webhook-jwks', () => new Map<string, JWTVerifyGetKey>());

function jwks(url: string): JWTVerifyGetKey {
  let set = keySets.get(url);
  if (!set) {
    // Through safeFetch, so the outbound policy applies to the issuer's key set like any other call a user can steer.
    set = createRemoteJWKSet(new URL(url), { timeoutDuration: 5_000, cooldownDuration: 30_000, [customFetch]: (target, init) => safeFetch(target, init) });
    keySets.set(url, set);
  }
  return set;
}

/** Verify a JWT against a JWT Auth credential. Throws when it doesn't check out. */
export async function verifyJwt(token: string, credential: JsonObject): Promise<JWTPayload> {
  const keyType = String(credential.keyType ?? 'passphrase');
  const algorithm = String(credential.algorithm ?? (keyType === 'passphrase' ? 'HS256' : 'RS256'));
  const options = {
    ...(credential.issuer ? { issuer: String(credential.issuer) } : {}),
    ...(credential.audience ? { audience: String(credential.audience) } : {}),
    clockTolerance: 30,
  };
  if (keyType === 'jwks') {
    const url = String(credential.jwksUrl ?? '').trim();
    if (!/^https?:\/\//.test(url)) throw new Error('The JWT Auth credential has no JWKS URL');
    return (await jwtVerify(token, jwks(url), { ...options, algorithms: credential.algorithm ? [algorithm] : undefined })).payload;
  }
  if (keyType === 'pemKey') {
    const pem = String(credential.publicKey ?? '').trim();
    if (!pem) throw new Error('The JWT Auth credential has no public key');
    return (await jwtVerify(token, await importSPKI(pem, algorithm), { ...options, algorithms: [algorithm] })).payload;
  }
  const secret = String(credential.secret ?? '');
  if (!secret) throw new Error('The JWT Auth credential has no secret');
  if (!HMAC.includes(algorithm)) throw new Error(`A passphrase signs with HS256, HS384 or HS512, not ${algorithm}`);
  return (await jwtVerify(token, new TextEncoder().encode(secret), { ...options, algorithms: [algorithm] })).payload;
}

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

function unauthorized(message: string, challenge: string): Response {
  const response = error(message, 401);
  response.headers.set('www-authenticate', challenge);
  return response;
}

function basicCredentials(request: Request): { user: string; password: string } | undefined {
  const match = /^Basic\s+(\S+)$/i.exec(request.headers.get('authorization')?.trim() ?? '');
  if (!match) return undefined;
  const decoded = Buffer.from(match[1], 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  return colon < 0 ? undefined : { user: decoded.slice(0, colon), password: decoded.slice(colon + 1) };
}

type TriggerNode = Pick<WorkflowNode, 'type' | 'name' | 'parameters' | 'credentials'>;

/**
 * Undefined when the trigger's authentication credential (if any) is one `workflowId`'s project may use; else the 403
 * every caller gets, without naming the credential (the log line says which one, for whoever runs the host).
 */
export function triggerAuthRefusal(workflowId: string, node: TriggerNode, label: string, respond: (message: string) => Response = (message) => error(message, 403)): Response | undefined {
  if (triggerAuthUsable(workflowId, node)) return undefined;
  logger.warn('trigger call refused: its authentication credential isn’t available to the workflow’s project', {
    'landflow.workflow.id': workflowId,
    'landflow.node.name': node.name,
    'landflow.node.type': node.type,
    'landflow.credential.id': triggerAuthCredential(node)?.id ?? '',
  });
  return respond(`Forbidden: the ${label}’s authentication credential isn’t available to its workflow’s project`);
}

/**
 * Check a call to a Webhook or Form Trigger node of `workflowId` against its authentication and IP allow-list. `label`
 * names the trigger in messages; `realm` is the Basic Auth realm (browsers show a sign-in prompt for forms). `spend: false`
 * verifies a single-use token without using it up: a Form Trigger's page view (GET), so the submission can use it.
 */
export async function checkWebhookAuth(request: Request, workflowId: string, node: TriggerNode, label = 'Webhook', realm = 'Webhook', { spend = true }: { spend?: boolean } = {}): Promise<WebhookAuthResult> {
  const options = (node.parameters.options ?? {}) as { ipWhitelist?: string };
  const allowed = parseIpList(options.ipWhitelist);
  if (allowed.length) {
    const ip = callerIp(request);
    if (!allowed.some((entry) => ipMatches(ip, entry))) return { ok: false, response: error('IP address not allowed', 403) };
  }

  const authentication = String(node.parameters.authentication ?? 'none') as WebhookAuthentication;
  if (!['basicAuth', 'headerAuth', 'jwtAuth'].includes(authentication)) return { ok: true, secretHeaders: [] };
  // Before any secret is compared: the caller learns nothing about the one they sent.
  const refused = triggerAuthRefusal(workflowId, node, label);
  if (refused) return { ok: false, response: refused };
  const resolved = registry.resolve(node.type);
  if ('error' in resolved) return { ok: false, response: error(resolved.error, 500) };
  let secrets: Record<string, JsonObject>;
  try {
    secrets = credentials.resolveFor(node, resolved.descriptor);
  } catch (caught) {
    return { ok: false, response: error(`The ${label}’s credential is missing: ${(caught as Error).message}`, 500) };
  }

  if (authentication === 'basicAuth') {
    const expected = secrets.httpBasicAuth ?? {};
    if (!expected.user && !expected.password) return { ok: false, response: error(`The ${label}’s Basic Auth credential is empty`, 500) };
    const given = basicCredentials(request);
    // Both compared, always: no early exit that tells the user name apart.
    const userOk = sameSecret(given?.user ?? '', String(expected.user ?? '')) || (!expected.user && !given?.user);
    const passwordOk = sameSecret(given?.password ?? '', String(expected.password ?? ''));
    if (!given || !userOk || !passwordOk) return { ok: false, response: unauthorized('Authorization is required', `Basic realm="${realm.replace(/"/g, '')}", charset="UTF-8"`) };
    return { ok: true, secretHeaders: [] };
  }

  if (authentication === 'headerAuth') {
    const name = String(secrets.httpHeaderAuth?.name ?? '').trim();
    if (!name) return { ok: false, response: error(`The ${label}’s Header Auth credential has no header name`, 500) };
    if (!sameSecret(request.headers.get(name), String(secrets.httpHeaderAuth?.value ?? ''))) {
      return { ok: false, response: error(`Authorization failed: send the “${name}” header`, 403) };
    }
    return { ok: true, secretHeaders: [name.toLowerCase()] };
  }

  const match = /^Bearer\s+(\S+)$/i.exec(request.headers.get('authorization')?.trim() ?? '');
  if (!match) return { ok: false, response: unauthorized('Send a JWT as “Authorization: Bearer <token>”', 'Bearer') };
  const jwtAuth = secrets.jwtAuth ?? {};
  // A credential that trusts a public CI issuer without pinning a repository is refused before its JWKS is fetched.
  const unsafe = checkCredentialClaims(jwtAuth);
  if (!unsafe.ok) return { ok: false, response: claimsRefusal(unsafe, workflowId, label, jwtAuth) };
  try {
    const payload = await verifyJwt(match[1], jwtAuth);
    const claims = checkBoundClaims(jwtAuth, payload);
    if (!claims.ok) return { ok: false, response: claimsRefusal(claims, workflowId, label, jwtAuth, typeof payload.iss === 'string' ? payload.iss : undefined) };
    // After the claims (a token that fails them is not spent) and before the route reads the body or starts a run.
    if (spend && (jwtAuth.singleUse === true || jwtAuth.singleUse === 'true')) {
      const iss = typeof payload.iss === 'string' ? payload.iss : String(jwtAuth.issuer ?? '');
      let use: Awaited<ReturnType<typeof useTokenOnce>>;
      try {
        use = await useTokenOnce(payload, match[1], { credentialId: triggerAuthCredential(node)?.id });
      } catch {
        // Not a token problem: say so, and log only which workflow (the error text can hold anything).
        logger.error('trigger call refused: the single-use token store failed', { 'landflow.workflow.id': workflowId });
        return { ok: false, response: error(`The ${label} could not check whether this token was used; try again`, 503) };
      }
      if (!use.ok && use.reason === 'no_expiry') return { ok: false, response: unauthorized('Single use needs tokens with an expiry', 'Bearer error="invalid_token"') };
      if (!use.ok && use.reason === 'exp_too_far') return { ok: false, response: unauthorized('Single use needs tokens that expire within 24 hours', 'Bearer error="invalid_token"') };
      if (!use.ok) return { ok: false, response: replayRefusal(workflowId, label, iss) };
    }
    return { ok: true, jwtPayload: payload as JsonObject, secretHeaders: [] };
  } catch (caught) {
    if (caught instanceof OutboundBlockedError) {
      return { ok: false, response: error(`The ${label}’s JWT Auth credential: the JWKS URL is not allowed by the outbound policy (LANDFLOW_OUTBOUND_ALLOW lists exceptions)`, 500) };
    }
    const message = (caught as Error).message;
    // A credential that can't verify anything is the workflow's problem, not the caller's.
    if (/credential has no|signs with/.test(message)) return { ok: false, response: error(`The ${label}’s JWT Auth credential: ${message}`, 500) };
    return { ok: false, response: unauthorized('Invalid JWT', 'Bearer error="invalid_token"') };
  }
}

/** Refused claim checks by reason: counted always, so a throttled or capped audit row never leaves the refusal silent. */
const claimsRefused = () => metrics.getMeter('landflow-webhook').createCounter('landflow.webhook.jwt_claims_refused', { description: 'JWT claim checks refused, by reason' });

/**
 * The answer for a refused claim check. Every refusal is counted (`landflow.webhook.jwt_claims_refused{reason}`, a
 * bounded label); the audit row (the route layer skips webhooks) and the log line are written once a minute per webhook
 * and reason, outside the shared denied-read cap so other denied reads cannot crowd them out. They hold the reason, the
 * claim's name and the issuer, never the token or a claim's value.
 */
function claimsRefusal(check: Exclude<ClaimsCheck, { ok: true }>, workflowId: string, label: string, credential: JsonObject, verifiedIss?: string): Response {
  const { reason, claim } = check;
  if (reason === 'claims_invalid') return error(`The ${label}’s JWT Auth credential: ${check.message}`, 500);
  claimsRefused().add(1, { reason });
  if (deniedReadDue(`webhook:${workflowId}`, `${label}:${reason}`)) {
    recordAudit({
      action: 'api.denied',
      outcome: 'denied',
      status: 403,
      actor: 'anonymous',
      target: { type: 'workflow', id: workflowId },
      summary: 'JWT claims refused',
      details: { reason, ...(claim && { claim }), iss: verifiedIss ?? String(credential.issuer ?? '') },
    });
    logger.warn(
      reason === 'claims_required'
        ? 'trigger call refused: its JWT Auth credential trusts a public CI issuer and binds no repository'
        : 'trigger call refused: a verified JWT failed a bound claim',
      { 'landflow.workflow.id': workflowId, 'landflow.reason': reason, ...(claim && { 'landflow.jwt.claim': claim }) },
    );
  }
  if (reason === 'claims_required') return error(`Forbidden: the ${label}’s JWT Auth credential is unsafe. ${check.message}`, 403);
  return error(`Forbidden: the token does not match the “${claim}” claim this ${label} is bound to`, 403);
}

/** Replayed single-use tokens, counted always (the audit row below is throttled). */
const tokensReplayed = () => metrics.getMeter('landflow-webhook').createCounter('landflow.webhook.jwt_replayed', { description: 'Single-use JWTs presented again' });

/**
 * The answer for a single-use token used again: 409 before the body is read, no run. Counted always; the audit row and the
 * log line go through the same once-a-minute throttle as `claimsRefusal`, and hold the issuer and the reason, never the
 * token or any claim.
 */
function replayRefusal(workflowId: string, label: string, iss: string): Response {
  tokensReplayed().add(1);
  if (deniedReadDue(`webhook:${workflowId}`, `${label}:token_replayed`)) {
    recordAudit({
      action: 'api.denied',
      outcome: 'denied',
      status: 409,
      actor: 'anonymous',
      target: { type: 'workflow', id: workflowId },
      summary: 'JWT token replayed',
      details: { reason: 'token_replayed', iss },
    });
    logger.warn('trigger call refused: a single-use JWT was presented again', { 'landflow.workflow.id': workflowId, 'landflow.reason': 'token_replayed' });
  }
  return error(`Conflict: this token was already used. Single use is on for the ${label}’s JWT Auth credential, so each call needs a fresh token`, 409, { code: 'token_replayed' });
}
