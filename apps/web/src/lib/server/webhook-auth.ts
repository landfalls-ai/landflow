/**
 * Who may call a Webhook trigger or submit a Form Trigger (n8n's names): `authentication` is `none`, `basicAuth`
 * (a Basic Auth credential: user and password), `headerAuth` (a Header Auth credential: header name and value) or
 * `jwtAuth` (a JWT Auth credential: an HS256/384/512 secret, a PEM public key or a JWKS URL, with optional issuer and
 * audience); `options.ipWhitelist` limits callers to a list of addresses and CIDR ranges.
 *
 * The client address is the first `X-Forwarded-For` entry, else `X-Real-IP` (set them at your reverse proxy, which
 * must overwrite what clients send); a request with neither counts as 127.0.0.1. Secrets are compared in constant time.
 * Failures answer 401 (with `WWW-Authenticate`) or 403 before the body is read, and start no run.
 *
 * The credential must be one the workflow's project may use (owned by it or shared with it, as for node credentials in
 * runs, lib/server/projects/credentials.ts): otherwise every call gets 403 before any secret is compared, the response
 * doesn't say which credential, and the host logs a warning with the workflow, node and credential id.
 */
import { isIP } from 'node:net';
import { createRemoteJWKSet, importSPKI, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import type { JsonObject } from '@landflow/protocol';
import type { WorkflowNode } from '@landflow/engine';
import { sameSecret } from './auth/passwords';
import { credentials } from './credentials/vault';
import { error } from './http';
import { registry } from './plugins/registry';
import { triggerAuthCredential, triggerAuthUsable } from './projects/credentials';
import { singleton } from './singleton';
import { clientAddress } from './net/client-address';
import { logger } from './telemetry/logger';
import type { WebhookAuthentication } from './nodes/webhook-auth';

export type WebhookAuthResult =
  | { ok: true; /** A verified JWT's claims (`jwtAuth`): runs get them as `item.json.jwtPayload`. */ jwtPayload?: JsonObject; /** Headers that carried the secret: left out of the item. */ secretHeaders: string[] }
  | { ok: false; response: Response };

const HMAC = ['HS256', 'HS384', 'HS512'];

// ---------------------------------------------------------------------------
// IP allow-list
// ---------------------------------------------------------------------------

/** The caller's address, from the trusted-proxy rules in net/client-address.ts; 127.0.0.1 when no header names one. */
export function callerIp(request: Request): string {
  const ip = clientAddress(request);
  return ip === 'local' ? '127.0.0.1' : ip;
}

function ipv4Bits(ip: string): bigint {
  return ip.split('.').reduce((acc, part) => (acc << 8n) | BigInt(Number(part) & 255), 0n);
}

function ipv6Bits(ip: string): bigint | undefined {
  let address = ip.toLowerCase();
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(address);
  if (v4) {
    const bits = ipv4Bits(v4[1]);
    address = `${address.slice(0, -v4[1].length)}${(bits >> 16n).toString(16)}:${(bits & 0xffffn).toString(16)}`;
  }
  const [head, tail] = address.split('::');
  const left = head ? head.split(':') : [];
  const right = tail !== undefined ? (tail ? tail.split(':') : []) : [];
  const groups = tail !== undefined ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
  if (groups.length !== 8) return undefined;
  return groups.reduce((acc, group) => (acc << 16n) | BigInt(parseInt(group || '0', 16) & 0xffff), 0n);
}

/** Whether `ip` matches one entry: an address, or a CIDR range (`10.0.0.0/8`, `2001:db8::/32`). */
export function ipMatches(ip: string, entry: string): boolean {
  const [range, prefixText] = entry.trim().split('/');
  const family = isIP(range);
  if (!family || isIP(ip) !== family) return entry.trim().toLowerCase() === 'localhost' && (ip === '127.0.0.1' || ip === '::1');
  const width = family === 4 ? 32 : 128;
  const prefix = prefixText === undefined ? width : Number(prefixText);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > width) return false;
  const bits = (value: string) => (family === 4 ? ipv4Bits(value) : (ipv6Bits(value) ?? -1n));
  const a = bits(ip);
  const b = bits(range);
  if (a < 0n || b < 0n) return false;
  const shift = BigInt(width - prefix);
  return a >> shift === b >> shift;
}

/** The allow-list entries (comma, space or newline separated); empty: everyone. */
export function parseIpList(value: unknown): string[] {
  return String(value ?? '')
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// JWT
// ---------------------------------------------------------------------------

/** Remote key sets by URL (jose caches the keys and refetches on an unknown `kid`). */
const keySets = singleton('webhook-jwks', () => new Map<string, JWTVerifyGetKey>());

function jwks(url: string): JWTVerifyGetKey {
  let set = keySets.get(url);
  if (!set) {
    set = createRemoteJWKSet(new URL(url), { timeoutDuration: 5_000, cooldownDuration: 30_000 });
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
 * names the trigger in messages; `realm` is the Basic Auth realm (browsers show a sign-in prompt for forms).
 */
export async function checkWebhookAuth(request: Request, workflowId: string, node: TriggerNode, label = 'Webhook', realm = 'Webhook'): Promise<WebhookAuthResult> {
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
  try {
    const payload = await verifyJwt(match[1], secrets.jwtAuth ?? {});
    return { ok: true, jwtPayload: payload as JsonObject, secretHeaders: [] };
  } catch (caught) {
    const message = (caught as Error).message;
    // A credential that can't verify anything is the workflow's problem, not the caller's.
    if (/credential has no|signs with/.test(message)) return { ok: false, response: error(`The ${label}’s JWT Auth credential: ${message}`, 500) };
    return { ok: false, response: unauthorized('Invalid JWT', 'Bearer error="invalid_token"') };
  }
}
