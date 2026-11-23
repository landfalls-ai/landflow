/**
 * The calls between the host and a runner (C29, docs/network-runners.md): the node's request waits in `network_calls`, a
 * runner's long poll claims it, the runner answers, the node reads the answer. Every step is one statement on the shared
 * table, so any main and any worker can queue, claim or read a call (queue mode needs no sticky routing).
 *
 * The statements run past the in-memory copy on purpose: on SQLite straight on the connection (a statement is atomic,
 * and the file is the database), on Postgres through `database.direct` (an `UPDATE … RETURNING` decides the one winner
 * of a claim). The copy is never read for this table. Rows are short lived: the request and the response are sealed
 * (`sealSecret`: they hold credential headers and answers), and a row goes when the node has read its answer, when the
 * call expired, or two minutes after it ended (purged on the next enqueue; D9: no rotation needed).
 *
 * Timing is on read (D7): a runner is online when seen in the last 30 s; a call nobody claims in 30 s expires; a claimed
 * call whose runner is unseen for 30 s fails as lost and is never retried (a side effect may have happened: FR-7).
 */
import { EventEmitter } from 'node:events';
import { nanoid } from 'nanoid';
import { credentials } from '../credentials/vault';
import { database, type Database } from '../db';
import { HttpError } from '../errors';
import { singleton } from '../singleton';
import { lastSeenMs, networkRow, onlineRunnerCount, runnerActive, type RunnerRecord } from './store';

/** Host → runner (plan D12). Bodies are base64; header lists keep order and repeats. */
export interface CallRequest {
  method: string;
  url: string;
  headers: Array<[string, string]>;
  body?: string;
  timeoutMs: number;
}

/** Runner → host: a response, or why the runner could not make one. */
export type RunnerAnswer =
  | { status: number; headers: Array<[string, string]>; body?: string }
  | { error: { code: 'refused' | 'timeout' | 'network'; message: string } };

/** The numbers; a test shortens them. */
export const limits = { claimWithinMs: 30_000, lostAfterMs: 30_000, keepEndedMs: 120_000, queueCap: 1_000, pollMs: 100, seenEveryMs: 5_000, pollWaitMs: 25_000 };

const PURPOSE = 'network.call';

export class RunnerCallError extends HttpError {
  static readonly errorName: string = 'RunnerCallError';
  constructor(message: string, code: string, status = 502) {
    super(message, status, { expose: true, code });
  }
}

export class RunnerRevokedError extends HttpError {
  static readonly errorName: string = 'RunnerRevokedError';
  constructor() {
    super('This runner’s token was revoked', 401, { expose: true });
  }
}

const events = () => singleton('network-calls-events', () => new EventEmitter().setMaxListeners(0));

/** SQLite binds `?`; Postgres wants `$1…`. The statements below hold no literal question marks. */
const toPg = (text: string) => {
  let n = 0;
  return text.replace(/\?/g, () => `$${++n}`);
};

/** One statement on the shared table (see the module comment); resolves its rows (`RETURNING`, `SELECT`). */
async function runOn<T>(db: Database, text: string, params: Array<string | number | null>): Promise<T[]> {
  const direct = db.direct((client) => client.query<T>(toPg(text), params).then((result) => result.rows));
  if (direct) return direct;
  return db.sqlite.prepare(text).all(...params) as T[];
}

const run = <T>(text: string, ...params: Array<string | number | null>) => runOn<T>(database(), text, params);

const iso = (ms: number) => new Date(ms).toISOString();
const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      events().off('queued', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
    events().once('queued', done);
  });

const seal = (value: unknown) => credentials.sealSecret(JSON.stringify(value), PURPOSE);
const open = <T>(sealed: string): T => JSON.parse(credentials.openSecret(sealed, PURPOSE)) as T;

interface CallRow {
  id: string;
  network_id: string;
  state: string;
  runner_id: string | null;
  request: string;
  response: string | null;
  queued_at: string;
  claimed_at: string | null;
}

/** Queue a call for `networkId`'s runners; returns its id. Fails "network busy" when the queue is full. */
export async function enqueueCall(networkId: string, call: CallRequest, meta: { executionId?: string; workflowId?: string; node?: string }, now = Date.now()): Promise<string> {
  await run('DELETE FROM network_calls WHERE state = ? AND done_at < ? RETURNING id', 'done', iso(now - limits.keepEndedMs));
  const [queued] = await run<{ n: number | string }>('SELECT COUNT(*) AS n FROM network_calls WHERE network_id = ? AND state = ?', networkId, 'queued');
  if (Number(queued?.n ?? 0) >= limits.queueCap) throw new RunnerCallError('This network is busy: too many calls are waiting', 'network_busy', 503);
  const id = `call_${nanoid(16)}`;
  await run(
    'INSERT INTO network_calls (id, network_id, execution_id, workflow_id, node, state, runner_id, request, response, queued_at, claimed_at, done_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, NULL, NULL) RETURNING id',
    id,
    networkId,
    meta.executionId ?? null,
    meta.workflowId ?? null,
    meta.node ?? null,
    'queued',
    seal(call),
    iso(now),
  );
  events().emit('queued');
  return id;
}

/** The oldest queued, still-claimable call of the runner's network, now claimed by it (one winner), or undefined. */
export async function claimOnce(runner: RunnerRecord, now: number, db: Database = database()): Promise<{ id: string; request: CallRequest } | undefined> {
  const [row] = await runOn<CallRow>(
    db,
    `UPDATE network_calls SET state = 'claimed', runner_id = ?, claimed_at = ? WHERE state = 'queued' AND id = (SELECT id FROM network_calls WHERE network_id = ? AND state = 'queued' AND queued_at >= ? ORDER BY queued_at LIMIT 1${db.kind === 'postgres' ? ' FOR UPDATE SKIP LOCKED' : ''}) RETURNING *`,
    [runner.id, iso(now), runner.networkId, iso(now - limits.claimWithinMs)],
  );
  return row && { id: row.id, request: open<CallRequest>(row.request) };
}

/**
 * A runner's long poll: the next call for its network, held up to `waitMs`. Checks that the runner is still valid on every
 * round (a revoked one throws `RunnerRevokedError`, so the route answers 401 within a second: FR-8) and records that it is
 * here. An in-process queue wakes it at once; otherwise it looks every 100 ms (the table is the only shared state).
 */
export async function claimCall(runner: RunnerRecord, options: { waitMs: number; signal?: AbortSignal; onSeen?: () => void }): Promise<{ id: string; request: CallRequest } | undefined> {
  const until = Date.now() + options.waitMs;
  let seenAt = 0;
  for (;;) {
    if (!runnerActive(runner.id)) throw new RunnerRevokedError();
    const now = Date.now();
    if (now - seenAt >= limits.seenEveryMs) {
      options.onSeen?.();
      seenAt = now;
    }
    const claimed = options.waitMs > 0 && (await claimOnce(runner, now));
    if (claimed) return claimed;
    const left = until - Date.now();
    if (left <= 0 || options.signal?.aborted) return undefined;
    await sleep(Math.min(limits.pollMs, left), options.signal);
  }
}

/** The claiming runner's answer. 404 for any other runner, an unknown call or a call already answered. */
export async function completeCall(runner: RunnerRecord, callId: string, answer: RunnerAnswer, now = Date.now()): Promise<void> {
  const rows = await run<{ id: string }>(`UPDATE network_calls SET state = 'done', response = ?, done_at = ? WHERE id = ? AND runner_id = ? AND state = 'claimed' RETURNING id`, seal(answer), iso(now), callId, runner.id);
  if (!rows.length) throw new HttpError('Call not found', 404, { expose: true });
  events().emit(`done:${callId}`);
}

async function drop(callId: string) {
  await run('DELETE FROM network_calls WHERE id = ? RETURNING id', callId);
}

/**
 * Wait for a call's answer and delete its row. Rejects: at once when no runner of the network was seen in the last 30 s
 * (FR-6); after 30 s when nobody claimed it; as "lost" when its runner goes quiet for 30 s; when the caller aborts; or
 * after `timeoutMs` (the node's own timeout, plus a few seconds for the runner to report its own).
 */
export async function awaitAnswer(callId: string, options: { timeoutMs: number; signal?: AbortSignal }): Promise<RunnerAnswer & { runnerId?: string }> {
  const started = Date.now();
  const [first] = await run<CallRow>('SELECT * FROM network_calls WHERE id = ?', callId);
  if (!first) throw new RunnerCallError('The call was lost', 'lost');
  const name = networkRow(first.network_id)?.name ?? first.network_id;
  const noRunner = () => new RunnerCallError(`No runner online for network ${name}`, 'no_runner', 503);
  if (onlineRunnerCount(first.network_id) === 0) {
    await drop(callId);
    throw noRunner();
  }
  for (;;) {
    if (options.signal?.aborted) {
      await drop(callId);
      throw new DOMException('The call was aborted', 'AbortError');
    }
    const [row] = await run<CallRow>('SELECT * FROM network_calls WHERE id = ?', callId);
    const now = Date.now();
    if (!row) throw new RunnerCallError('The call was lost', 'lost');
    if (row.state === 'done' && row.response) {
      await drop(callId);
      const answer = open<RunnerAnswer>(row.response);
      if ('error' in answer) throw new RunnerCallError(answer.error.message, answer.error.code, answer.error.code === 'timeout' ? 504 : 502);
      return { ...answer, ...(row.runner_id && { runnerId: row.runner_id }) };
    }
    if (row.state === 'queued' && now - Date.parse(row.queued_at) > limits.claimWithinMs) {
      await drop(callId);
      throw noRunner();
    }
    if (row.state === 'claimed') {
      const lastSeen = Math.max(row.runner_id ? (lastSeenMs(row.runner_id) ?? 0) : 0, Date.parse(row.claimed_at ?? row.queued_at));
      if (now - lastSeen > limits.lostAfterMs) {
        await drop(callId);
        throw new RunnerCallError('The runner was lost during the call', 'runner_lost');
      }
    }
    if (now - started > options.timeoutMs) {
      await drop(callId);
      throw new RunnerCallError('The runner did not answer in time', 'timeout', 504);
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, limits.pollMs);
      function done() {
        clearTimeout(timer);
        events().off(`done:${callId}`, done);
        options.signal?.removeEventListener('abort', done);
        resolve();
      }
      events().once(`done:${callId}`, done);
      options.signal?.addEventListener('abort', done, { once: true });
    });
  }
}
