/**
 * Landflow-issued MCP tokens (docs/transports.md "Sign-in and identity", docs/protocol.md §15.3–15.4): signed JWTs an
 * agent sends as `Authorization: Bearer` to the gateway (which validates them against this host's JWKS) or straight to
 * the host's MCP endpoints. Claims: `iss` = the instance URL, `sub` = the user id, `aud` = the host's MCP resource
 * (and the gateway's `/mcp` when configured), `jti` = the token id, `scope` (lib/shared/mcp.ts), `exp`, `iat`.
 *
 * Keys: ES256, generated on first use and kept in the `settings` table (`mcp_signing_keys`) with the private key
 * sealed by the credential vault's key, like SAML decryption keys; the public parts are served at /api/mcp/jwks with
 * their `kid`. Tokens are shown once and kept as rows in `mcp_tokens` (migration 1723) by `jti`, with the SHA-256 of
 * the JWT, a hint, scopes, expiry, revocation and last use, so a revoked token stops working on the next call even
 * though its signature is still valid.
 */
import { createHash, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { createLocalJWKSet, exportJWK, importPKCS8, jwtVerify, SignJWT, type JWK, type JWTPayload } from 'jose';
import { nanoid } from 'nanoid';
import { MCP_TOKEN_SCOPES, type McpTokenScope, type McpTokenView } from '../../shared/mcp';
import { mcpDb } from './db';
import { getUser, type UserRecord } from '../auth/users';
import type { Role } from '../../shared/auth';
import { projectRole } from '../projects/access';
import { getProject } from '../projects/store';
import { credentials } from '../credentials/vault';
import { parse } from '../db/rows';
import { singleton } from '../singleton';
import { publicUrl } from '../config';
import { HttpError } from '../errors';

const SETTINGS_KEY = 'mcp_signing_keys';
export const MCP_TOKEN_ALG = 'ES256';
/** The longest life a token may be issued with. */
export const MCP_TOKEN_MAX_DAYS = 365;
export const MCP_TOKEN_DEFAULT_DAYS = 30;
/** last_used_at is written at most this often per token. */
const TOUCH_EVERY_MS = 60_000;

export class McpTokenError extends HttpError {
  constructor(
    message: string,
    status = 400,
  ) {
    super(message, status, { expose: true });
  }
}

// ---- the instance's URLs ------------------------------------------------------

/** The instance URL (LANDFLOW_PUBLIC_URL, else localhost): the `iss` of MCP tokens and the base of the MCP resources. */
export function instanceUrl(): string {
  return publicUrl();
}

/** LANDFLOW_MCP_GATEWAY_PUBLIC_URL without a trailing slash, when configured. */
export function gatewayPublicUrl(): string | undefined {
  const url = process.env.LANDFLOW_MCP_GATEWAY_PUBLIC_URL?.trim().replace(/\/+$/, '');
  return url || undefined;
}

/** The host's MCP resource root (`<instance>/api/mcp`): every per-plugin endpoint sits below it. */
export function mcpResourceRoot(): string {
  return `${instanceUrl()}/api/mcp`;
}

/** The audiences a Landflow-issued token carries: the host's MCP root and the gateway's `/mcp`. */
export function tokenAudiences(): string[] {
  const gateway = gatewayPublicUrl();
  return [mcpResourceRoot(), ...(gateway ? [`${gateway}/mcp`] : [])];
}

// ---- signing keys ---------------------------------------------------------------

interface StoredKey {
  kid: string;
  alg: string;
  /** Sealed PKCS#8 PEM. */
  privateKey: string;
  publicJwk: JWK;
  createdAt: string;
  /** Set when rotated out: still in the JWKS (tokens it signed stay valid), no longer used to sign. */
  retiredAt?: string;
}

interface StoredKeys {
  keys: StoredKey[];
}

function storedKeys(): StoredKeys {
  return parse<StoredKeys>(mcpDb().get<{ value: string }>('SELECT value FROM settings WHERE key = ?', SETTINGS_KEY)?.value) ?? { keys: [] };
}

function saveKeys(next: StoredKeys) {
  mcpDb().upsert('settings', { key: SETTINGS_KEY, value: JSON.stringify(next) });
}

async function newKey(): Promise<StoredKey> {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const publicJwk = await exportJWK(publicKey);
  const kid = `mcp-${nanoid(10)}`;
  return {
    kid,
    alg: MCP_TOKEN_ALG,
    privateKey: credentials.sealSecret(privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()),
    publicJwk: { ...publicJwk, kid, alg: MCP_TOKEN_ALG, use: 'sig' },
    createdAt: new Date().toISOString(),
  };
}

/** The key that signs new tokens, generated on first use. */
async function signingKey(): Promise<StoredKey> {
  const stored = storedKeys();
  const active = stored.keys.find((k) => !k.retiredAt);
  if (active) return active;
  const key = await newKey();
  saveKeys({ keys: [...stored.keys, key] });
  return key;
}

/** Retire the signing key and generate a new one; tokens signed with the old key stay valid until they expire. */
export async function rotateMcpSigningKey(): Promise<{ kid: string }> {
  const stored = storedKeys();
  const now = new Date().toISOString();
  const key = await newKey();
  saveKeys({ keys: [...stored.keys.map((k) => (k.retiredAt ? k : { ...k, retiredAt: now })), key] });
  return { kid: key.kid };
}

/** The public keys (RFC 7517), for /api/mcp/jwks and the gateway's validation. Generates the first key when none exists. */
export async function mcpJwks(): Promise<{ keys: JWK[] }> {
  await signingKey();
  return { keys: storedKeys().keys.map((k) => k.publicJwk) };
}

const privateKeyCache = () => singleton('mcp-signing-private-keys', () => new Map<string, Promise<KeyObject | CryptoKey>>());

async function privateKeyOf(key: StoredKey): Promise<KeyObject | CryptoKey> {
  const cache = privateKeyCache();
  let loading = cache.get(key.kid);
  if (!loading) {
    loading = importPKCS8(credentials.openSecret(key.privateKey), key.alg);
    cache.set(key.kid, loading);
  }
  return loading;
}

// ---- tokens ---------------------------------------------------------------------

interface TokenRow {
  id: string;
  user_id: string;
  label: string;
  token_hash: string;
  hint: string;
  scopes: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
  /** The project the token is scoped to (migration 1870). */
  project_id?: string | null;
}

export interface McpTokenRecord extends Omit<McpTokenView, 'userName'> {}

const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');

export function parseTokenScopes(value: unknown): McpTokenScope[] {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[\s,]+/) : [];
  return [...new Set(list.filter((s): s is McpTokenScope => (MCP_TOKEN_SCOPES as readonly string[]).includes(String(s))))];
}

function fromRow(row: TokenRow): McpTokenRecord {
  return {
    id: row.id,
    userId: row.user_id,
    label: row.label,
    hint: row.hint,
    scopes: parseTokenScopes(parse<string[]>(row.scopes) ?? []),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    ...(row.revoked_at && { revokedAt: row.revoked_at }),
    ...(row.last_used_at && { lastUsedAt: row.last_used_at }),
    ...(row.project_id && { projectId: row.project_id }),
  };
}

export function mcpTokenView(record: McpTokenRecord): McpTokenView {
  return { ...record, userName: getUser(record.userId)?.name, ...(record.projectId && { projectName: getProject(record.projectId)?.name }) };
}

export interface IssueTokenInput {
  label: string;
  scopes?: McpTokenScope[];
  /** Days until it expires (1–365; default 30). */
  expiresInDays?: number;
  /** Scope the token to one project: the instance MCP server then lists and changes only that project's workflows. */
  projectId?: string;
}

/** Issue a token for `user`; the result's `token` is the JWT, shown once. */
export async function issueMcpToken(user: UserRecord, input: IssueTokenInput, now = Date.now()): Promise<{ token: string; record: McpTokenRecord }> {
  if (user.disabledAt) throw new McpTokenError('This account is deactivated', 403);
  const days = input.expiresInDays ?? MCP_TOKEN_DEFAULT_DAYS;
  if (!Number.isInteger(days) || days < 1 || days > MCP_TOKEN_MAX_DAYS) throw new McpTokenError(`Expiry must be between 1 and ${MCP_TOKEN_MAX_DAYS} days`);
  const scopes = input.scopes?.length ? parseTokenScopes(input.scopes) : [...MCP_TOKEN_SCOPES];
  if (!scopes.length) throw new McpTokenError('Pick at least one scope');
  if (input.projectId) {
    const project = getProject(input.projectId);
    if (!project) throw new McpTokenError('Project not found', 404);
    // Someone who can't see the project can't scope a token to it.
    if (!projectRole({ id: user.id, role: user.role as Role }, project.id)) throw new McpTokenError(`You are not a member of “${project.name}”`, 403);
  }
  const key = await signingKey();
  const id = `mcpt_${nanoid(16)}`;
  const issuedAt = Math.floor(now / 1000);
  const expiresAt = issuedAt + days * 86_400;
  const token = await new SignJWT({ scope: scopes.join(' ') })
    .setProtectedHeader({ alg: key.alg, kid: key.kid, typ: 'at+jwt' })
    .setIssuer(instanceUrl())
    .setSubject(user.id)
    .setAudience(tokenAudiences())
    .setJti(id)
    .setIssuedAt(issuedAt)
    .setExpirationTime(expiresAt)
    .sign(await privateKeyOf(key));
  const row: TokenRow = {
    id,
    user_id: user.id,
    label: input.label.trim().slice(0, 100) || 'MCP token',
    token_hash: tokenHash(token),
    hint: token.slice(-6),
    scopes: JSON.stringify(scopes),
    created_at: new Date(now).toISOString(),
    expires_at: new Date(expiresAt * 1000).toISOString(),
    revoked_at: null,
    last_used_at: null,
    ...(input.projectId && { project_id: input.projectId }),
  };
  mcpDb().insertNew('mcp_tokens', { ...row });
  return { token, record: fromRow(row) };
}

/** A user's tokens (newest first), or everyone's when `userId` is omitted. */
export function listMcpTokens(userId?: string): McpTokenRecord[] {
  const db = mcpDb();
  const rows = userId ? db.all<TokenRow>('SELECT * FROM mcp_tokens WHERE user_id = ? ORDER BY created_at DESC', userId) : db.all<TokenRow>('SELECT * FROM mcp_tokens ORDER BY created_at DESC');
  return rows.map(fromRow);
}

export function getMcpToken(id: string): McpTokenRecord | undefined {
  const row = mcpDb().get<TokenRow>('SELECT * FROM mcp_tokens WHERE id = ?', id);
  return row && fromRow(row);
}

/** Revoke a token: it stops working on the next call. Returns false when unknown or already revoked. */
export function revokeMcpToken(id: string, now = new Date()): boolean {
  const db = mcpDb();
  const row = db.get<TokenRow>('SELECT * FROM mcp_tokens WHERE id = ?', id);
  if (!row || row.revoked_at) return false;
  db.upsert('mcp_tokens', { ...row, revoked_at: now.toISOString() });
  return true;
}

/** Delete a token's row (after revoking; for tests and clean-up). */
export function deleteMcpToken(id: string): boolean {
  return mcpDb().delete('mcp_tokens', { id }) > 0;
}

/** Whether a token no longer works (revoked, or past its expiry): only such rows may be deleted by hand. */
export function isDeadMcpToken(record: Pick<McpTokenRecord, 'revokedAt' | 'expiresAt'>, now = Date.now()): boolean {
  return Boolean(record.revokedAt) || Date.parse(record.expiresAt) <= now;
}

/**
 * Delete the rows of tokens revoked or expired more than `olderThanDays` ago (the gateway sync's tick runs this; a
 * revoked token's `jti` is useless once its `exp` has passed too, so nothing is lost). Returns how many went.
 */
export function purgeMcpTokens(options: { olderThanDays?: number; now?: number } = {}): number {
  const cutoff = new Date((options.now ?? Date.now()) - (options.olderThanDays ?? 30) * 86_400_000).toISOString();
  const rows = mcpDb().all<TokenRow>('SELECT * FROM mcp_tokens WHERE (revoked_at IS NOT NULL AND revoked_at < ?) OR expires_at < ?', cutoff, cutoff);
  for (const row of rows) mcpDb().delete('mcp_tokens', { id: row.id });
  return rows.length;
}

export type McpTokenCheck = { ok: true; record: McpTokenRecord; user: UserRecord; claims: JWTPayload } | { ok: false; reason: 'invalid' | 'expired' | 'revoked' | 'audience' | 'user' };

/** Whether `token` looks like a JWT this host issued (three parts, `iss` = the instance URL), before verifying it. */
export function looksLikeLandflowMcpToken(token: string): boolean {
  const claims = unverifiedClaims(token);
  return Boolean(claims && String(claims.iss ?? '').replace(/\/+$/, '') === instanceUrl());
}

/** The payload of a JWT without checking anything (to route a token to the issuer that can verify it). */
export function unverifiedClaims(token: string): JWTPayload | undefined {
  const parts = token.split('.');
  if (parts.length !== 3) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as unknown;
    return payload && typeof payload === 'object' ? (payload as JWTPayload) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Verify a Landflow-issued token: signature against this host's keys, issuer, audience (`audiences`, any one of them,
 * default: the host's MCP root), expiry, then the row: known, not revoked, its user active. Touches last_used_at.
 */
export async function verifyMcpToken(token: string, options: { audiences?: string[]; now?: number } = {}): Promise<McpTokenCheck> {
  const now = options.now ?? Date.now();
  await signingKey();
  const jwks = createLocalJWKSet({ keys: storedKeys().keys.map((k) => k.publicJwk) });
  let claims: JWTPayload;
  try {
    ({ payload: claims } = await jwtVerify(token, jwks, { issuer: instanceUrl(), algorithms: [MCP_TOKEN_ALG], currentDate: new Date(now) }));
  } catch (error) {
    const code = (error as { code?: string }).code;
    return { ok: false, reason: code === 'ERR_JWT_EXPIRED' ? 'expired' : 'invalid' };
  }
  const wanted = options.audiences ?? [mcpResourceRoot()];
  const aud = Array.isArray(claims.aud) ? claims.aud : claims.aud ? [claims.aud] : [];
  if (!aud.some((a) => wanted.includes(a))) return { ok: false, reason: 'audience' };
  if (!claims.jti || !claims.sub) return { ok: false, reason: 'invalid' };
  const db = mcpDb();
  const row = db.get<TokenRow>('SELECT * FROM mcp_tokens WHERE id = ?', claims.jti);
  if (!row || row.user_id !== claims.sub || row.token_hash !== tokenHash(token)) return { ok: false, reason: 'invalid' };
  if (row.revoked_at) return { ok: false, reason: 'revoked' };
  if (Date.parse(row.expires_at) <= now) return { ok: false, reason: 'expired' };
  const user = getUser(row.user_id);
  if (!user || user.disabledAt) return { ok: false, reason: 'user' };
  touch(row, now);
  return { ok: true, record: fromRow(row), user, claims };
}

function touch(row: TokenRow, now: number) {
  const touched = singleton('mcp-token-touched', () => new Map<string, number>());
  if (now - (touched.get(row.id) ?? 0) > TOUCH_EVERY_MS) {
    touched.set(row.id, now);
    mcpDb().upsert('mcp_tokens', { ...row, last_used_at: new Date(now).toISOString() });
  }
}

/**
 * The gateway forwards only `iss` and `sub` (and `jti` when its transformation sets `x-landflow-caller-jti`). Resolve
 * a Landflow-issued token's subject that way: by `jti` when given, else the user has to hold at least one live token.
 */
export function resolveTokenSubject(subject: string, jti: string | undefined, now = Date.now()): { user: UserRecord; record?: McpTokenRecord } | undefined {
  const db = mcpDb();
  const live = (row: TokenRow) => !row.revoked_at && Date.parse(row.expires_at) > now;
  if (jti) {
    const row = db.get<TokenRow>('SELECT * FROM mcp_tokens WHERE id = ?', jti);
    if (!row || row.user_id !== subject || !live(row)) return undefined;
    const user = getUser(row.user_id);
    if (!user || user.disabledAt) return undefined;
    touch(row, now);
    return { user, record: fromRow(row) };
  }
  const rows = db.all<TokenRow>('SELECT * FROM mcp_tokens WHERE user_id = ?', subject).filter(live);
  if (!rows.length) return undefined;
  const user = getUser(subject);
  if (!user || user.disabledAt) return undefined;
  return { user, ...(rows.length === 1 && { record: fromRow(rows[0]) }) };
}
