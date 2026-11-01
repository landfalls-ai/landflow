/**
 * Asks of Claude Code members (docs/a2a.md, "The landflow-harness mod"): a command the guard lets a person allow (a push
 * to main, a force push, deleting a remote branch) is posted to the call's trace as an `ask` event (a2a/agent-trace.ts), kept
 * here in the `agent_asks` table, and shown in the run as an open wait under the member's request (`attrs.wait: 'approval'`,
 * `attrs.ask`), so Run Trace's Needs you and the team node offer Approve / Reject. The workflow run is not paused: the member's
 * A2A call goes on while the mod waits. A person's decision (`POST /api/executions/:id/asks/:id`, any process) is stored and
 * written to the journal; the mod reads it by polling `GET /api/agent-trace/:traceId/asks/:askId`. The table is the one place
 * the three routes meet, so it works in queue mode (the run on a worker, the decision on a main).
 */
import { createHash, randomBytes } from 'node:crypto';
import type { RunActor } from '../../shared/run-trace';
import { database } from '../db';
import type { Row } from '../db';
import { journalOf, liveJournal, releaseJournal, type Journal } from '../journal/writer';
import { logger } from '../telemetry';

/** How long an ask waits for a person, ms: the mod gives up at the same time (hooks/register.ts ASK_MS). */
export const ASK_TTL_MS = 10 * 60_000;
/** Open asks of one call: more is a loop. */
const MAX_OPEN_PER_TRACE = 5;
const MAX_WAIT_S = 30;

const HUMAN: RunActor = { id: 'human', name: 'A person', type: 'human' };

/** Where a trace's call sits in a run: the execution and the span its asks go under. */
export interface AskRun {
  executionId: string;
  workflowId: string;
  /** The span of the member's request; else the node's span (resolved when the ask comes in). */
  spanId?: string;
  nodeId?: string;
  /** Who asks, as the run shows it ("Developer"). */
  member?: string;
  actor?: RunActor;
}

export interface AskCommand {
  askId: string;
  command: string;
  cwd?: string;
  reason?: string;
  agent?: string;
}

export type AskStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'canceled';

export interface AskRecord {
  id: string;
  executionId: string;
  workflowId: string;
  spanId: string;
  parentSpanId: string;
  member?: string;
  command: string;
  cwd?: string;
  reason?: string;
  status: AskStatus;
  decidedBy?: string;
  decidedAt?: string;
  createdAt: string;
}

export class AskError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const keyOf = (traceId: string) => createHash('sha256').update(traceId).digest('hex').slice(0, 40);
const now = () => new Date().toISOString();
const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

interface AskRow {
  id: string;
  trace_key: string;
  mod_id: string;
  execution_id: string;
  workflow_id: string;
  span_id: string;
  parent_span_id: string;
  member: string | null;
  command: string;
  cwd: string | null;
  reason: string | null;
  status: AskStatus;
  decided_by: string | null;
  decided_at: string | null;
  created_at: string;
}

const recordOf = (row: AskRow): AskRecord => ({
  id: row.id,
  executionId: row.execution_id,
  workflowId: row.workflow_id,
  spanId: row.span_id,
  parentSpanId: row.parent_span_id,
  ...(row.member && { member: row.member }),
  command: row.command,
  ...(row.cwd && { cwd: row.cwd }),
  ...(row.reason && { reason: row.reason }),
  status: row.status,
  ...(row.decided_by && { decidedBy: row.decided_by }),
  ...(row.decided_at && { decidedAt: row.decided_at }),
  createdAt: row.created_at,
});

const expired = (row: AskRow, at = Date.now()) => row.status === 'pending' && at - Date.parse(row.created_at) > ASK_TTL_MS;

/** Write to the execution's journal: the running segment's when this process has it, else one opened for the write. Never throws. */
function writeJournal(executionId: string, workflowId: string, write: (journal: Journal) => void) {
  try {
    const running = liveJournal(executionId);
    const journal = running ?? journalOf(executionId, { workflowId });
    write(journal);
    journal.flush();
    if (!running) releaseJournal(executionId);
  } catch (error) {
    logger.warn('could not journal a command ask', { error: (error as Error).message, 'landflow.execution.id': executionId });
  }
}

/** Close the ask's wait in the journal: the wait ends and, when a person answered, an Approval check says who decided what. */
function journalAnswer(row: AskRow, answer: { status: Exclude<AskStatus, 'pending'>; by?: string; at: string }) {
  writeJournal(row.execution_id, row.workflow_id, (journal) => {
    const who = answer.by ?? 'A person';
    const word = answer.status === 'approved' ? 'approved' : answer.status === 'denied' ? 'rejected' : undefined;
    const subject = row.member ?? undefined;
    if (word) {
      const from: RunActor = { id: `human:${answer.by ?? 'unknown'}`, name: who, type: 'human' };
      journal.record({ type: 'message', spanId: row.span_id, from, text: `${word === 'approved' ? 'Approved' : 'Rejected'} ${cut(row.command, 200)}`, at: answer.at });
      journal.record({
        type: 'check',
        spanId: row.parent_span_id,
        check: {
          name: 'Approval',
          status: word === 'approved' ? 'pass' : 'warn',
          message: `${who} ${word} ${row.member ? `${row.member}'s ` : ''}command ${cut(row.command, 200)} at ${answer.at.replace('T', ' ').replace(/:\d\d(?:\.\d+)?Z$/, ' UTC')}`,
          ...(subject && { subject }),
          source: 'person',
          evidence: { command: row.command, decision: answer.status, ...(answer.by && { by: answer.by }), at: answer.at },
        },
        at: answer.at,
      });
    } else {
      journal.record({
        type: 'check',
        spanId: row.parent_span_id,
        check: { name: 'Approval', status: 'warn', message: `${row.member ? `${row.member}'s ` : ''}command ${cut(row.command, 200)} was not approved in time`, ...(subject && { subject }), source: 'person', evidence: { command: row.command, decision: answer.status } },
        at: answer.at,
      });
    }
    journal.record({ type: 'span.ended', spanId: row.span_id, status: word ? 'success' : 'canceled', attrs: { decision: answer.status, ...(answer.by && { by: answer.by }) }, at: answer.at });
  });
}

/**
 * A command the mod asks a person about: stored, and shown in the run as an open wait under the member's request. A call
 * outside a run (no `run`) or with too many open asks is denied at once, so the mod does not wait for nobody.
 */
export function openAsk(traceId: string, run: AskRun | undefined, ask: AskCommand): AskRecord | undefined {
  const db = database();
  const trace_key = keyOf(traceId);
  const mod_id = ask.askId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) || 'ask';
  const known = db.get<AskRow>('SELECT * FROM agent_asks WHERE trace_key = ? AND mod_id = ?', trace_key, mod_id);
  if (known) return recordOf(known);
  const id = `ask_${randomBytes(9).toString('base64url')}`;
  const at = now();
  const base = { id, trace_key, mod_id, member: run?.member ?? null, command: ask.command, cwd: ask.cwd ?? null, reason: ask.reason ?? null, decided_by: null, decided_at: null, created_at: at };
  const open = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM agent_asks WHERE trace_key = ? AND status = 'pending'", trace_key)?.n ?? 0;
  if (!run || open >= MAX_OPEN_PER_TRACE) {
    const row: AskRow = { ...base, execution_id: run?.executionId ?? '', workflow_id: run?.workflowId ?? '', span_id: '', parent_span_id: '', status: 'denied', decided_by: 'Landflow', decided_at: at };
    db.upsert('agent_asks', row as unknown as Row);
    return recordOf(row);
  }
  const journal = liveJournal(run.executionId);
  const parent = run.spanId ?? (run.nodeId ? journal?.spanOfNode(run.nodeId) : undefined) ?? 'run';
  const row: AskRow = { ...base, execution_id: run.executionId, workflow_id: run.workflowId, span_id: `${parent}/ask:${id}`, parent_span_id: parent, status: 'pending' };
  db.upsert('agent_asks', row as unknown as Row);
  const who = run.member ?? run.actor?.name ?? 'An agent';
  writeJournal(run.executionId, run.workflowId, (j) =>
    j.record({
      type: 'span.started',
      spanId: row.span_id,
      parentSpanId: parent,
      kind: 'wait',
      name: `${who} wants to run ${cut(ask.command, 160)}`,
      actor: HUMAN,
      ...(run.actor && { caller: run.actor }),
      input: ask.command,
      attrs: { wait: 'approval', ask: id, tool: 'Bash', command: ask.command, ...(run.member && { member: run.member }), ...(ask.cwd && { cwd: ask.cwd }), ...(ask.reason && { reason: ask.reason }), ...(ask.agent && { subagent: ask.agent }) },
      at,
    }),
  );
  return recordOf(row);
}

export interface AskAnswer {
  decision: 'pending' | 'approved' | 'denied';
  by?: string;
  at?: string;
  /** Denied because nobody answered in time, or the call ended (the mod says so to Claude Code). */
  expired?: boolean;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function answerOf(row: AskRow | undefined): AskAnswer | undefined {
  if (!row) return undefined;
  if (row.status === 'approved') return { decision: 'approved', ...(row.decided_by && { by: row.decided_by }), ...(row.decided_at && { at: row.decided_at }) };
  if (row.status === 'denied') return { decision: 'denied', ...(row.decided_by && { by: row.decided_by }), ...(row.decided_at && { at: row.decided_at }) };
  if (row.status === 'expired' || row.status === 'canceled') return { decision: 'denied', expired: true };
  return { decision: 'pending' };
}

/** An ask's row; one past its time is closed here (the wait ends, an Approval check says nobody answered). */
function fresh(traceId: string, modId: string): AskRow | undefined {
  const row = database().get<AskRow>('SELECT * FROM agent_asks WHERE trace_key = ? AND mod_id = ?', keyOf(traceId), modId);
  if (row && expired(row)) return close(row, 'expired');
  return row;
}

function close(row: AskRow, status: 'expired' | 'canceled'): AskRow {
  const at = now();
  const next: AskRow = { ...row, status, decided_at: at };
  database().upsert('agent_asks', next as unknown as Row);
  journalAnswer(next, { status, at });
  return next;
}

/**
 * The answer to an ask, for the mod's polling. `waitSeconds` holds the request until a person decides (long poll, at most 30 s),
 * so the answer reaches the mod at once and the mod's own clock stays still. Undefined: no such ask.
 */
export async function askAnswer(traceId: string, modId: string, waitSeconds = 0): Promise<AskAnswer | undefined> {
  const id = modId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
  const until = Date.now() + Math.min(Math.max(0, waitSeconds), MAX_WAIT_S) * 1000;
  for (;;) {
    const answer = answerOf(fresh(traceId, id));
    if (!answer || answer.decision !== 'pending' || Date.now() >= until) return answer;
    await sleep(400);
  }
}

/** The call ended: asks still open are closed, so nobody is asked about a command that will never run. */
export function cancelAsks(traceId: string) {
  try {
    for (const row of database().all<AskRow>("SELECT * FROM agent_asks WHERE trace_key = ? AND status = 'pending'", keyOf(traceId))) close(row, 'canceled');
  } catch (error) {
    logger.warn('could not close the open command asks', { error: (error as Error).message });
  }
}

/** Asks waiting for a person: of one execution, or of all (the Needs you list). */
export function openAsks(executionId?: string): AskRecord[] {
  const rows = executionId
    ? database().all<AskRow>("SELECT * FROM agent_asks WHERE execution_id = ? AND status = 'pending' ORDER BY created_at", executionId)
    : database().all<AskRow>("SELECT * FROM agent_asks WHERE status = 'pending' ORDER BY created_at");
  const open: AskRecord[] = [];
  for (const row of rows) {
    if (expired(row)) close(row, 'expired');
    else open.push(recordOf(row));
  }
  return open;
}

/** A person's decision on an ask of the execution. Throws AskError: 404 no such ask, 409 already answered or past its time. */
export function decideAsk(executionId: string, id: string, approved: boolean, by?: string): AskRecord {
  const row = database().get<AskRow>('SELECT * FROM agent_asks WHERE id = ? AND execution_id = ?', id, executionId);
  if (!row) throw new AskError('No such command is waiting for approval', 404);
  if (row.status !== 'pending') throw new AskError(row.status === 'approved' || row.status === 'denied' ? `Already ${row.status === 'approved' ? 'approved' : 'rejected'}` : 'This command is no longer waiting', 409);
  if (expired(row)) {
    close(row, 'expired');
    throw new AskError('Nobody answered in time: the agent was told this command did not run', 409);
  }
  const at = now();
  const status = approved ? 'approved' : 'denied';
  const next: AskRow = { ...row, status, decided_by: by ?? null, decided_at: at };
  database().upsert('agent_asks', next as unknown as Row);
  journalAnswer(next, { status, ...(by && { by }), at });
  return recordOf(next);
}

/** Delete the asks older than a day (their waits ended long ago). */
export function pruneAsks(before = new Date(Date.now() - 86_400_000).toISOString()): number {
  return database().deleteBefore('agent_asks', 'created_at', before);
}
