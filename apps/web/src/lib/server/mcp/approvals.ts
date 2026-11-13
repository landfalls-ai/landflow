/**
 * Approvals for MCP tool calls that need a person (docs/transports.md "Credentials, permissions and audit"). A grant
 * says when (`always`, `destructive`: tools with `destructiveHint`, the default, or `never`; migration 1750); this
 * file decides how the person is asked, in two ways:
 *
 * - **MCP elicitation** (2026-07-28 clients that declared `elicitation`): the call answers `input_required` with a form
 *   (a confirm checkbox, a message naming the tool and the arguments). The client asks its user and retries the call
 *   with the answer; `accept` + `confirm: true` runs it, `decline` / `cancel` refuses it. The retry repeats the
 *   arguments, so the `requestState` the host minted is signed over the caller, the tool and the arguments' hash: an
 *   answer to a different call is no answer. 2025-era clients can't be asked this way: the host answers each request
 *   alone (no session, no stream to send a request on), so the SDK's server-side shim has nothing to talk to.
 * - **A Landflow approval** (everyone else): a row in `mcp_approvals`, shown in Settings → MCP and answered by a
 *   project member, an admin or the caller's own user (`decideMcpApproval`). The call waits for the answer for a
 *   short while (LANDFLOW_MCP_APPROVAL_WAIT_SECONDS, default 20, never past the tool's timeout), because a person may
 *   be watching; a 2025-era client gives a request about a minute (the MCP TS client's default), a gateway has its own
 *   timeouts, and a held request survives neither a restart nor a person who comes back after lunch. If nobody answers
 *   in time, the result is an `isError` that says where to approve and that the same call, repeated within
 *   LANDFLOW_MCP_APPROVAL_TTL_SECONDS (default 600) of the approval, runs without asking again (one use).
 *
 * Approvals of workflow agents (lib/server/approvals.ts) are tied to a waiting execution of an AI Agent node; an MCP call
 * is a one-node run that has to answer the agent now, so it keeps its own small table.
 */
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { inputRequired, type CallToolResult, type InputRequiredResult } from '@modelcontextprotocol/server';
import type { JsonObject, JsonValue } from '@landflow/protocol';
import type { McpApprovalView } from '../../shared/mcp-approval';
import type { UserRecord } from '../auth/users';
import { signPayload } from './signing';
import type { Database } from '../db';
import { membershipsOf } from '../projects/store';
import { publicUrl } from '../runner';
import { mcpDb } from './db';
import { sameSecret, textResult } from './server';
import { envNumber } from '../config';
import { HttpError } from '../errors';

const DEFAULT_WAIT_SECONDS = 20;
const DEFAULT_TTL_SECONDS = 600;
const POLL_MS = 400;
const MAX_SUMMARY = 700;
const ELICIT_KEY = 'approve';
const SECRETISH = /pass(word|phrase)?|secret|token|api[-_]?key|authorization|credential|private/i;

// ---------------------------------------------------------------------------
// What the person sees
// ---------------------------------------------------------------------------

const clipText = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

function shown(value: JsonValue, key: string): string {
  if (SECRETISH.test(key)) return '••••';
  if (typeof value === 'string') return JSON.stringify(clipText(value, 120));
  return clipText(JSON.stringify(value) ?? 'null', 120);
}

/** `key: value` lines of the arguments (long values and secret-looking keys clipped), at most ~700 characters. */
export function summarizeArguments(args: JsonObject): string {
  const lines = Object.entries(args).map(([key, value]) => `${key}: ${shown(value, key)}`);
  return clipText(lines.join('\n') || '(no arguments)', MAX_SUMMARY);
}

const canonical = (value: JsonValue): JsonValue =>
  Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, canonical(v as JsonValue)])) : value;

/** A hash of the arguments, key order aside: an answer binds to exactly this call. */
export const argumentsHash = (args: JsonObject) => createHash('sha256').update(JSON.stringify(canonical(args))).digest('hex').slice(0, 32);

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

interface ApprovalRow {
  id: string;
  plugin_id: string;
  tool: string;
  caller: string;
  caller_user_id: string | null;
  args_hash: string;
  summary: string;
  credentials: string;
  status: string;
  created_at: string;
  expires_at: string;
  decided_by: string | null;
  decided_at: string | null;
  used_at: string | null;
}

const ttlMs = () => {
  const seconds = envNumber('LANDFLOW_MCP_APPROVAL_TTL_SECONDS', { fallback: DEFAULT_TTL_SECONDS });
  return 1000 * (seconds > 0 ? seconds : DEFAULT_TTL_SECONDS);
};
const waitMs = () => 1000 * envNumber('LANDFLOW_MCP_APPROVAL_WAIT_SECONDS', { fallback: DEFAULT_WAIT_SECONDS, min: 0 });

export class McpApprovalError extends HttpError {
  static readonly errorName: string = 'McpApprovalError';
  constructor(
    message: string,
    status = 400,
  ) {
    super(message, status, { expose: true });
  }
}

function view(row: ApprovalRow, canDecide?: boolean): McpApprovalView {
  const expired = (row.status === 'pending' || row.status === 'approved') && row.expires_at <= new Date().toISOString();
  return {
    id: row.id,
    pluginId: row.plugin_id,
    tool: row.tool,
    caller: row.caller,
    summary: row.summary,
    status: expired ? 'expired' : (row.status as McpApprovalView['status']),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    ...(row.decided_by && { decidedBy: row.decided_by }),
    ...(row.decided_at && { decidedAt: row.decided_at }),
    ...(canDecide !== undefined && { canDecide }),
  };
}

const rowOf = (id: string) => mcpDb().get<ApprovalRow>('SELECT * FROM mcp_approvals WHERE id = ?', id);

/** Who may answer: owners and admins, the user the call acts for, and members of a project they share. */
export function mayDecide(user: Pick<UserRecord, 'id' | 'role'>, row: Pick<ApprovalRow, 'caller_user_id'>): boolean {
  if (user.role === 'owner' || user.role === 'admin') return true;
  if (!row.caller_user_id) return false;
  if (row.caller_user_id === user.id) return true;
  try {
    const mine = new Set(membershipsOf(user.id).map((m) => m.projectId));
    return membershipsOf(row.caller_user_id).some((m) => mine.has(m.projectId));
  } catch {
    return false;
  }
}

/** The approvals `user` may see: pending ones and the last day's answers, newest first. */
export function listApprovals(user: Pick<UserRecord, 'id' | 'role'>): McpApprovalView[] {
  const since = new Date(Date.now() - 24 * 3_600_000).toISOString();
  return mcpDb()
    .all<ApprovalRow>('SELECT * FROM mcp_approvals WHERE created_at >= ? ORDER BY created_at DESC LIMIT 200', since)
    .filter((row) => mayDecide(user, row))
    .map((row) => view(row, mayDecide(user, row)));
}

/** Answer a pending approval. Throws McpApprovalError when it is gone, answered, expired or not the user's to answer. */
export function decideMcpApproval(id: string, approve: boolean, user: Pick<UserRecord, 'id' | 'role' | 'email' | 'name'>): McpApprovalView {
  return mcpDb().transaction(() => {
    const row = rowOf(id);
    if (!row) throw new McpApprovalError('Approval not found', 404);
    if (!mayDecide(user, row)) throw new McpApprovalError('You are not one of the people who may answer this approval', 403);
    if (row.status !== 'pending') throw new McpApprovalError(`Already ${row.status}`, 409);
    const now = new Date();
    if (row.expires_at <= now.toISOString()) throw new McpApprovalError('This approval has expired: ask the agent to call the tool again', 410);
    const next: ApprovalRow = {
      ...row,
      status: approve ? 'approved' : 'denied',
      decided_by: user.email || user.name || user.id,
      decided_at: now.toISOString(),
      // An approval is good for a retry for as long as a request lives.
      expires_at: approve ? new Date(now.getTime() + ttlMs()).toISOString() : row.expires_at,
    };
    mcpDb().upsert('mcp_approvals', { ...next });
    return view(next, true);
  });
}

export interface CallIdentity {
  pluginId: string;
  tool: string;
  caller: string;
  callerUserId?: string;
  args: JsonObject;
  credentialNames: string[];
}

/** The pending approval of this exact call by this caller, or a new one. */
function pendingFor(call: CallIdentity): ApprovalRow {
  const hash = argumentsHash(call.args);
  const now = new Date().toISOString();
  const existing = mcpDb()
    .all<ApprovalRow>(`SELECT * FROM mcp_approvals WHERE plugin_id = ? AND tool = ? AND args_hash = ? AND caller = ? AND status = 'pending' ORDER BY created_at DESC`, call.pluginId, call.tool, hash, call.caller)
    .find((row) => row.expires_at > now);
  if (existing) return existing;
  const row: ApprovalRow = {
    id: `mcpa_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
    plugin_id: call.pluginId,
    tool: call.tool,
    caller: call.caller,
    caller_user_id: call.callerUserId ?? null,
    args_hash: hash,
    summary: summarizeArguments(call.args),
    credentials: JSON.stringify(call.credentialNames),
    status: 'pending',
    created_at: now,
    expires_at: new Date(Date.now() + ttlMs()).toISOString(),
    decided_by: null,
    decided_at: null,
    used_at: null,
  };
  mcpDb().upsert('mcp_approvals', { ...row });
  return row;
}

/**
 * Use up an approved, unexpired approval of this exact call (one retry per approval). Of several callers racing for
 * it, one wins: on SQLite the IMMEDIATE transaction decides; with Postgres (queue mode, a copy per main) the decision
 * is a guarded `UPDATE … WHERE status = 'approved'` there, whose row count says who got it, and a loser tries the
 * next approved row of the call, if any. `db` is for tests.
 */
export async function consumeApproved(call: CallIdentity, db: Database = mcpDb()): Promise<ApprovalRow | undefined> {
  const hash = argumentsHash(call.args);
  const candidates = () =>
    db
      .all<ApprovalRow>(`SELECT * FROM mcp_approvals WHERE plugin_id = ? AND tool = ? AND args_hash = ? AND caller = ? AND status = 'approved' ORDER BY decided_at DESC`, call.pluginId, call.tool, hash, call.caller)
      .filter((r) => r.expires_at > new Date().toISOString());
  if (db.kind !== 'postgres') {
    return db.transaction(() => {
      const row = candidates()[0];
      if (!row) return undefined;
      db.upsert('mcp_approvals', { ...row, status: 'used', used_at: new Date().toISOString() });
      return row;
    });
  }
  await db.flush();
  for (const row of candidates()) {
    const usedAt = new Date().toISOString();
    const won = await db.direct((client) => client.query(`UPDATE mcp_approvals SET status = 'used', used_at = $1 WHERE id = $2 AND status = 'approved'`, [usedAt, row.id]));
    if (won?.rowCount) {
      // This main's copy at once (the other mains learn from the write's notice).
      db.upsert('mcp_approvals', { ...row, status: 'used', used_at: usedAt });
      return row;
    }
    // Someone else used it first: forget it here too.
    db.upsert('mcp_approvals', { ...row, status: 'used', used_at: row.used_at ?? usedAt });
  }
  return undefined;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true });
  });

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

/** What the gate decided; `how` and `by` go to the audit entry of the call. */
export type ApprovalOutcome =
  | { proceed: true; how: 'elicitation' | 'approval'; by?: string; approvalId?: string }
  | { proceed: false; result: CallToolResult | InputRequiredResult; audit?: { reason: string; approvalId?: string; by?: string } };

export interface GateInput {
  call: CallIdentity;
  title: string;
  /** The call's retry material (2026-07-28): the answer to the form and the state the host minted. */
  inputResponses?: Record<string, unknown>;
  requestState?: unknown;
  /** The client declared form elicitation and speaks 2026-07-28 (the only case a form can be asked in). */
  canElicit: boolean;
  /** Cap of the wait (the tool's timeout, seconds). */
  timeoutSeconds: number;
  signal?: AbortSignal;
}

const confirmSchema = z.object({ confirm: z.boolean() });

const stateOf = (call: CallIdentity) => ({ h: argumentsHash(call.args), t: `${call.pluginId}/${call.tool}`, c: call.caller });

function mintState(call: CallIdentity, now = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ ...stateOf(call), x: Math.floor((now + ttlMs()) / 1000) })).toString('base64url');
  return `lfa1.${payload}.${signPayload('mcp-approval.1', payload)}`;
}

/** Whether `state` is one this host minted for this very call, unexpired. */
function stateMatches(state: unknown, call: CallIdentity, now = Date.now()): boolean {
  const [version, payload, signature] = typeof state === 'string' ? state.split('.') : [];
  if (version !== 'lfa1' || !payload || !sameSecret(signature, signPayload('mcp-approval.1', payload))) return false;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as ReturnType<typeof stateOf> & { x: number };
    const want = stateOf(call);
    return claims.h === want.h && claims.t === want.t && claims.c === want.c && claims.x * 1000 > now;
  } catch {
    return false;
  }
}

const refusal = (why: string) => textResult(`${why} The tool did not run.`, true);

/** The elicitation round trip: ask, or read the answer to the form the last round asked. */
function viaElicitation(input: GateInput): ApprovalOutcome {
  const { call } = input;
  const answered = input.inputResponses?.[ELICIT_KEY] as { action?: string; content?: Record<string, unknown> } | undefined;
  if (answered && stateMatches(input.requestState, call)) {
    if (answered.action === 'accept' && confirmSchema.safeParse(answered.content).data?.confirm === true) return { proceed: true, how: 'elicitation' };
    const action = answered.action === 'decline' ? 'declined' : answered.action === 'cancel' ? 'cancelled' : 'did not confirm';
    return { proceed: false, result: refusal(`The person ${action} this call.`), audit: { reason: `elicitation ${action}` } };
  }
  const message = `Run ${call.tool} (${call.pluginId})?\n${summarizeArguments(call.args)}`;
  return {
    proceed: false,
    result: inputRequired({
      inputRequests: {
        [ELICIT_KEY]: inputRequired.elicit({
          message,
          requestedSchema: { type: 'object', properties: { confirm: { type: 'boolean', title: `Run ${input.title}`, description: 'Tick to let the agent run this tool with these arguments.', default: false } }, required: ['confirm'] },
        }),
      },
      requestState: mintState(call),
    }),
    audit: { reason: 'elicitation requested' },
  };
}

/** A Landflow approval: consume an approved one, else ask and wait a while. */
async function viaApproval(input: GateInput): Promise<ApprovalOutcome> {
  const { call } = input;
  const used = await consumeApproved(call);
  if (used) return { proceed: true, how: 'approval', by: used.decided_by ?? undefined, approvalId: used.id };
  const row = pendingFor(call);
  const deadline = Date.now() + Math.min(waitMs(), input.timeoutSeconds * 1000);
  while (Date.now() < deadline && !input.signal?.aborted) {
    await sleep(Math.min(POLL_MS, Math.max(1, deadline - Date.now())), input.signal);
    const now = rowOf(row.id);
    if (!now) break;
    if (now.status === 'denied') return { proceed: false, result: refusal(`${now.decided_by ?? 'A person'} denied this call.`), audit: { reason: 'approval denied', approvalId: row.id, by: now.decided_by ?? undefined } };
    if (now.status === 'approved') {
      const taken = await consumeApproved(call);
      if (taken) return { proceed: true, how: 'approval', by: taken.decided_by ?? undefined, approvalId: taken.id };
    }
  }
  const where = `${publicUrl()}/settings#mcp`;
  return {
    proceed: false,
    result: textResult(
      `${call.tool} needs a person's approval before it runs, and nobody has answered yet. Ask them to open Landflow → Settings → MCP → Approvals (${where}) and approve approval ${row.id}. ` +
        `Then call ${call.tool} again with the same arguments within ${Math.round(ttlMs() / 60_000)} minutes: it runs without asking again (once).`,
      true,
    ),
    audit: { reason: 'approval pending', approvalId: row.id },
  };
}

/** Ask for a person's OK for one call: through the client's elicitation when it can, else a Landflow approval. */
export function requireApproval(input: GateInput): Promise<ApprovalOutcome> | ApprovalOutcome {
  return input.canElicit ? viaElicitation(input) : viaApproval(input);
}
