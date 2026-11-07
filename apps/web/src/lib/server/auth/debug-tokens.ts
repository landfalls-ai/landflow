/**
 * Debug tokens (docs/specs/19-debug-token.md): a short-lived, read-only credential bound to ONE execution, so an agent
 * on someone's laptop can explain a failed remote run without a user's API key or an instance admin token.
 *
 * - Format `lf_dbg_<random>`: opaque, not a JWT, so no existing verifier (MCP JWTs, API keys, the instance access token,
 *   the identity provider) can mistake it for theirs. Only the SHA-256 is kept, in `debug_tokens` (migration 2042).
 * - Scopes: `executions:read` (get_execution, explain_failure) and `trace:read` (get_run_trace), and `runs:debug`: the
 *   one-node local override, which is write-like, so it is never minted with a read scope, is bound to one node, works once,
 *   and only while the owner's setting is on (lib/server/debug-node/).
 * - TTL: 1 hour by default, at least one minute, at most 24 hours. A use cap (DEBUG_TOKEN_MAX_USES calls) bounds a leak.
 * - The token acts for nobody: it is not a `Principal`, the REST guard refuses it (guard.ts) and so does every MCP
 *   endpoint but `/api/mcp` (identity.ts, instance.ts). There it opens a server of three tools (mcp/debug-token-server.ts).
 * - It dies with its minter: a deactivated user, or one who lost read access to the workflow, voids it on the next call.
 */
import { nanoid } from 'nanoid';
import type { Role } from '../../shared/auth';
import { canResource } from '../projects/access';
import { authDb } from './db';
import { randomToken, tokenHash } from './passwords';
import { getDebugNodeSettings } from '../debug-node/settings';
import { getUser, type UserRecord } from './users';

export const DEBUG_TOKEN_PREFIX = 'lf_dbg_';
export const DEBUG_TOKEN_SCOPES = ['executions:read', 'trace:read'] as const;
/** The write-like scope: run ONE node of the recorded execution against a plugin the developer serves. Never mixed with the read scopes. */
export const DEBUG_RUN_SCOPE = 'runs:debug' as const;
export type DebugTokenScope = (typeof DEBUG_TOKEN_SCOPES)[number] | typeof DEBUG_RUN_SCOPE;
/** A `runs:debug` token is single use and short: at most an hour (15 minutes by default). */
export const DEBUG_RUN_DEFAULT_TTL_SECONDS = 900;
export const DEBUG_RUN_MAX_TTL_SECONDS = 3600;
export const maxUsesOf = (scopes: readonly string[]) => (scopes.includes(DEBUG_RUN_SCOPE) ? 1 : DEBUG_TOKEN_MAX_USES);

export const DEBUG_TOKEN_DEFAULT_TTL_SECONDS = 3600;
export const DEBUG_TOKEN_MIN_TTL_SECONDS = 60;
export const DEBUG_TOKEN_MAX_TTL_SECONDS = 86_400;
/** Tool calls one token may make before it stops working. */
export const DEBUG_TOKEN_MAX_USES = 1000;
/** Live tokens per execution, so a loop cannot fill the table. */
export const DEBUG_TOKEN_MAX_LIVE_PER_EXECUTION = 20;

export class DebugTokenError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

interface Row {
  id: string;
  token_hash: string;
  hint: string;
  label: string;
  execution_id: string;
  workflow_id: string;
  scopes: string;
  node_id: string | null;
  node_name: string | null;
  created_by: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  revoked_by: string | null;
  last_used_at: string | null;
  use_count: number | string;
}

/** A debug token as listed (never the token itself). */
export interface DebugTokenRecord {
  id: string;
  hint: string;
  label: string;
  executionId: string;
  workflowId: string;
  scopes: DebugTokenScope[];
  /** A `runs:debug` token: the one node it may run. */
  nodeId?: string;
  nodeName?: string;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  revokedAt?: string;
  revokedBy?: string;
  lastUsedAt?: string;
  uses: number;
}

const fromRow = (row: Row): DebugTokenRecord => ({
  id: row.id,
  hint: row.hint,
  label: row.label,
  executionId: row.execution_id,
  workflowId: row.workflow_id,
  scopes: parseDebugScopes(JSON.parse(row.scopes) as unknown),
  ...(row.node_id && { nodeId: row.node_id, nodeName: row.node_name ?? row.node_id }),
  createdBy: row.created_by,
  createdAt: row.created_at,
  expiresAt: row.expires_at,
  ...(row.revoked_at && { revokedAt: row.revoked_at }),
  ...(row.revoked_by && { revokedBy: row.revoked_by }),
  ...(row.last_used_at && { lastUsedAt: row.last_used_at }),
  uses: Number(row.use_count),
});

export function parseDebugScopes(value: unknown): DebugTokenScope[] {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[\s,]+/) : [];
  return [...new Set(list.filter((s): s is DebugTokenScope => (DEBUG_TOKEN_SCOPES as readonly string[]).includes(String(s)) || s === DEBUG_RUN_SCOPE))];
}

export const looksLikeDebugToken = (token: string | undefined): boolean => Boolean(token?.startsWith(DEBUG_TOKEN_PREFIX));

export const isLive = (record: Pick<DebugTokenRecord, 'revokedAt' | 'expiresAt' | 'uses' | 'scopes'>, now = Date.now()) => !record.revokedAt && Date.parse(record.expiresAt) > now && record.uses < maxUsesOf(record.scopes);

/**
 * Mint a token for `user` on one execution of `workflowId` (the caller has checked the execution exists). The user must be
 * able to read the workflow: a token never reads more than its minter could. The token is returned once.
 */
export function mintDebugToken(
  user: UserRecord,
  input: { executionId: string; workflowId: string; ttlSeconds?: number; scopes?: readonly string[]; label?: string; node?: { id: string; name: string } },
  now = Date.now(),
): { token: string; record: DebugTokenRecord } {
  if (user.disabledAt) throw new DebugTokenError('This account is deactivated', 403);
  if (!canResource({ id: user.id, role: user.role as Role }, 'workflow', input.workflowId, 'read')) throw new DebugTokenError('Execution not found', 404);
  const requested = input.scopes?.length ? [...new Set(input.scopes)] : undefined;
  if (requested?.some((scope) => !(DEBUG_TOKEN_SCOPES as readonly string[]).includes(scope) && scope !== DEBUG_RUN_SCOPE)) {
    throw new DebugTokenError(`The scopes are ${DEBUG_TOKEN_SCOPES.join(', ')} and ${DEBUG_RUN_SCOPE}`);
  }
  const running = Boolean(requested?.includes(DEBUG_RUN_SCOPE));
  if (running) {
    // The write-like scope: never with a read scope, only while the owner allows it, for someone who may run the workflow, for one node.
    if (requested!.length > 1) throw new DebugTokenError(`“${DEBUG_RUN_SCOPE}” cannot be minted together with a read scope: mint a separate token`);
    if (!getDebugNodeSettings().enabled) throw new DebugTokenError('Local node overrides are off: an owner turns them on in the Local node override card of the Debug access dialog (Run Trace page)', 403);
    if (!canResource({ id: user.id, role: user.role as Role }, 'workflow', input.workflowId, 'run')) throw new DebugTokenError('You can read this workflow but not run it, so you cannot mint a runs:debug token', 403);
    if (!input.node) throw new DebugTokenError(`“${DEBUG_RUN_SCOPE}” is bound to one node: name it (node)`);
  } else if (input.node) throw new DebugTokenError('A node binds only a runs:debug token');
  const ttl = input.ttlSeconds ?? (running ? DEBUG_RUN_DEFAULT_TTL_SECONDS : DEBUG_TOKEN_DEFAULT_TTL_SECONDS);
  const maxTtl = running ? DEBUG_RUN_MAX_TTL_SECONDS : DEBUG_TOKEN_MAX_TTL_SECONDS;
  if (!Number.isInteger(ttl) || ttl < DEBUG_TOKEN_MIN_TTL_SECONDS || ttl > maxTtl) {
    throw new DebugTokenError(`The lifetime must be between ${DEBUG_TOKEN_MIN_TTL_SECONDS / 60} minute and ${maxTtl / 3600} hour${maxTtl > 3600 ? 's' : ''}`);
  }
  const scopes = (requested as DebugTokenScope[] | undefined) ?? [...DEBUG_TOKEN_SCOPES];
  const db = authDb();
  purgeDebugTokens({ now }); // dead rows older than a week go with the next mint
  const live = listDebugTokens({ executionId: input.executionId }).filter((r) => isLive(r, now));
  if (live.length >= DEBUG_TOKEN_MAX_LIVE_PER_EXECUTION) throw new DebugTokenError(`This execution already has ${live.length} live debug tokens: revoke some first`, 409);
  const token = `${DEBUG_TOKEN_PREFIX}${randomToken(32)}`;
  const row: Row = {
    id: `dbgt_${nanoid(12)}`,
    token_hash: tokenHash(token),
    hint: token.slice(-4),
    label: (input.label?.trim() || 'Debug token').slice(0, 100),
    execution_id: input.executionId,
    workflow_id: input.workflowId,
    scopes: JSON.stringify(scopes),
    node_id: running ? input.node!.id : null,
    node_name: running ? input.node!.name : null,
    created_by: user.id,
    created_at: new Date(now).toISOString(),
    expires_at: new Date(now + ttl * 1000).toISOString(),
    revoked_at: null,
    revoked_by: null,
    last_used_at: null,
    use_count: 0,
  };
  db.insertNew('debug_tokens', { ...row });
  return { token, record: fromRow(row) };
}

/** Tokens of an execution, or of a minter (newest first). Expired and revoked rows stay listed until purged. */
export function listDebugTokens(filter: { executionId?: string; createdBy?: string } = {}): DebugTokenRecord[] {
  const where = [filter.executionId && ['execution_id', filter.executionId], filter.createdBy && ['created_by', filter.createdBy]].filter(Boolean) as Array<[string, string]>;
  const sql = `SELECT * FROM debug_tokens${where.length ? ` WHERE ${where.map(([column]) => `${column} = ?`).join(' AND ')}` : ''} ORDER BY created_at DESC`;
  return authDb().all<Row>(sql, ...where.map(([, value]) => value)).map(fromRow);
}

export function getDebugToken(id: string): DebugTokenRecord | undefined {
  const row = authDb().get<Row>('SELECT * FROM debug_tokens WHERE id = ?', id);
  return row && fromRow(row);
}

/** Revoke: the token stops working on its next call. False when unknown or already revoked. */
export function revokeDebugToken(id: string, by: string | undefined, now = new Date()): boolean {
  const db = authDb();
  const row = db.get<Row>('SELECT * FROM debug_tokens WHERE id = ?', id);
  if (!row || row.revoked_at) return false;
  db.upsert('debug_tokens', { ...row, revoked_at: now.toISOString(), revoked_by: by ?? null });
  return true;
}

/** Revoke every live token of an execution (it was deleted, or the person wants all access closed). Returns how many. */
export function revokeDebugTokensOf(executionId: string, by: string | undefined, now = new Date()): number {
  let count = 0;
  for (const record of listDebugTokens({ executionId })) if (!record.revokedAt && revokeDebugToken(record.id, by, now)) count++;
  return count;
}

/** Delete rows that have been dead (revoked or expired) for more than `olderThanDays`. */
export function purgeDebugTokens(options: { olderThanDays?: number; now?: number } = {}): number {
  const cutoff = new Date((options.now ?? Date.now()) - (options.olderThanDays ?? 7) * 86_400_000).toISOString();
  const rows = authDb().all<Row>('SELECT * FROM debug_tokens WHERE (revoked_at IS NOT NULL AND revoked_at < ?) OR expires_at < ?', cutoff, cutoff);
  for (const row of rows) authDb().delete('debug_tokens', { id: row.id });
  return rows.length;
}

export type DebugTokenCheck =
  | { ok: true; record: DebugTokenRecord; user: UserRecord }
  | { ok: false; reason: 'invalid' | 'expired' | 'revoked' | 'exhausted' | 'user'; record?: DebugTokenRecord };

/**
 * Check a presented token: known, not revoked, not expired, under its use cap, its minter still active and still able to
 * read the workflow. Does not count a use: `recordDebugUse` does, once per audited tool call.
 */
export function verifyDebugToken(token: string | undefined, now = Date.now()): DebugTokenCheck {
  if (!token || !looksLikeDebugToken(token) || token.length > 200) return { ok: false, reason: 'invalid' };
  const row = authDb().get<Row>('SELECT * FROM debug_tokens WHERE token_hash = ?', tokenHash(token));
  if (!row) return { ok: false, reason: 'invalid' };
  const record = fromRow(row);
  if (record.revokedAt) return { ok: false, reason: 'revoked', record };
  if (Date.parse(record.expiresAt) <= now) return { ok: false, reason: 'expired', record };
  if (record.uses >= maxUsesOf(record.scopes)) return { ok: false, reason: 'exhausted', record };
  const user = getUser(record.createdBy);
  if (!user || user.disabledAt || !canResource({ id: user.id, role: user.role as Role }, 'workflow', record.workflowId, 'read')) return { ok: false, reason: 'user', record };
  return { ok: true, record, user };
}

/** Count one tool call against the token. */
export function recordDebugUse(id: string, now = Date.now()): void {
  const db = authDb();
  const row = db.get<Row>('SELECT * FROM debug_tokens WHERE id = ?', id);
  if (row) db.upsert('debug_tokens', { ...row, use_count: Number(row.use_count) + 1, last_used_at: new Date(now).toISOString() });
}
