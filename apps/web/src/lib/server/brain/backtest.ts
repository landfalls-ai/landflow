/**
 * Backtesting a detector (docs/second-brain.md#backtesting-a-detector): rerun it "as of" past points over a window
 * (a point a day for the last 30 days, by default) without writing a single suggestion, then score what it found
 * against what people decided about the same suggestions before. A finding matches a suggestion by fingerprint:
 *
 * - applied, or dismissed as done: a **hit**. Dismissed as wrong, not relevant or intended: a **false alarm**. Expired,
 *   still open, snoozed or never suggested: **unknown**.
 * - a suggestion people decided in the window that the detector did not find: a **miss** if they wanted it (applied,
 *   done), or **avoided** if they did not (it was right not to find it).
 * - precision = hits / (hits + false alarms); recall = hits / (hits + misses).
 *
 * Built-in detectors read the usage ledger with `ctx.now`; here the ledger is a view that stops at each point
 * (`asOfView`), so no query sees what came after. Detector flows run for real at each point with the run marked a
 * backtest (./backtest-scope.ts, ./flow-detectors.ts `backtestFlowAt`). The result is kept in `brain_backtests` and can be
 * gated: a precision under the threshold marks it failing, as the eval gate marks an agent's draft.
 * What is NOT replayed: the workflows and agents themselves (their definitions are as they are now), the weekly cap and
 * the hold-backs of upsertProposal, the model's enrichment.
 */
import { nanoid } from 'nanoid';
import type { BacktestFinding, BacktestMiss, BacktestResult, BacktestVerdict, DetectorId, Proposal } from '../../shared/brain';
import { BACKTEST_GATE, detectorLabel, isBuiltinDetector, isFlowDetector } from '../../shared/brain';
import { database, type Database } from '../db';
import { parse } from '../db/rows';
import { store } from '../store';
import { DETECTOR_RUNS, detectContext, type Finding } from './detectors';
import { backtestFlowAt } from './flow-detectors';
import { quietOf } from './proposals';
import { HttpError } from '../errors';

const DAY_MS = 86_400_000;
export const MAX_BACKTEST_DAYS = 90;
export const MAX_BACKTEST_POINTS = { builtin: 200, flow: 40 } as const;
/** How long a backtest may run before it stops with the points it has. */
export const BACKTEST_BUDGET_MS = 5 * 60_000;
const KEEP_PER_DETECTOR = 30;

export class BacktestError extends HttpError {
  constructor(
    message: string,
    status = 400,
  ) {
    super(message, status, { expose: true });
  }
}

/**
 * The database as it stood at `asOf`: reads of the ledger (`usage_events`, `usage_daily`) stop there, whatever the
 * query. Detectors only bound their windows from below, so this is what keeps them from seeing the future.
 */
export function asOfView(db: Database, asOf: number): Database {
  const at = new Date(asOf).toISOString().replace(/'/g, '');
  const day = at.slice(0, 10);
  const rewrite = (sql: string) =>
    sql.replace(/\b(FROM|JOIN)\s+usage_events\b/g, `$1 (SELECT * FROM usage_events WHERE at <= '${at}') AS usage_events`).replace(/\b(FROM|JOIN)\s+usage_daily\b/g, `$1 (SELECT * FROM usage_daily WHERE day <= '${day}') AS usage_daily`);
  const view = Object.create(db) as Database;
  view.all = ((sql: string, ...params: never[]) => db.all(rewrite(sql), ...params)) as Database['all'];
  view.get = ((sql: string, ...params: never[]) => db.get(rewrite(sql), ...params)) as Database['get'];
  return view;
}

interface Decided {
  decision: string;
  verdict: BacktestVerdict;
  proposal: Proposal;
}

/** How people decided one suggestion. */
export function decisionOf(p: Proposal): { decision: string; verdict: BacktestVerdict } {
  if (p.status === 'applied') return { decision: 'applied', verdict: 'hit' };
  if (p.status === 'dismissed') {
    if (p.reason === 'done') return { decision: 'done', verdict: 'hit' };
    if (p.reason) return { decision: `dismissed:${p.reason}`, verdict: 'false-alarm' };
    return { decision: 'dismissed', verdict: 'unknown' };
  }
  return { decision: p.status, verdict: 'unknown' };
}

/** Each fingerprint's suggestion: a decided one before an undecided one, the newest first. */
function decisionsFor(detector: DetectorId, db: Database): Map<string, Decided> {
  const out = new Map<string, Decided>();
  const rows = db.all<{ data: string }>("SELECT data FROM proposals WHERE source = 'detector' AND detector = ? ORDER BY updated_at DESC", detector);
  for (const row of rows) {
    const proposal = parse<Proposal>(row.data);
    if (!proposal) continue;
    const next: Decided = { ...decisionOf(proposal), proposal };
    const held = out.get(proposal.fingerprint);
    if (!held || (held.verdict === 'unknown' && next.verdict !== 'unknown')) out.set(proposal.fingerprint, next);
  }
  return out;
}

interface Seen {
  fingerprint: string;
  title: string;
  confidence: number;
  firstAt: number;
  lastAt: number;
  points: number;
}

export interface BacktestOptions {
  /** How far back (default 30, at most 90). */
  days?: number;
  /** Days between points (default 1). */
  step?: number;
  /** The quiet multiplier to test (default: the detector's own now). */
  quiet?: number;
  /** Precision under this fails the gate (default 0.5). */
  threshold?: number;
  now?: number;
  db?: Database;
  signal?: AbortSignal;
  budgetMs?: number;
}

/** Backtest one detector, keep the result and return it. */
export async function backtestDetector(detector: DetectorId, options: BacktestOptions = {}): Promise<BacktestResult> {
  const db = options.db ?? database();
  const started = Date.now();
  const now = options.now ?? started;
  const days = Math.floor(options.days ?? 30);
  const step = Math.floor(options.step ?? 1);
  if (!(days >= 1 && days <= MAX_BACKTEST_DAYS)) throw new BacktestError(`Days must be between 1 and ${MAX_BACKTEST_DAYS}`);
  if (!(step >= 1 && step <= days)) throw new BacktestError('Step must be between 1 and the number of days');
  if (options.quiet !== undefined && !(options.quiet >= 0.5 && options.quiet <= 10)) throw new BacktestError('Quiet must be between 0.5 and 10');
  const threshold = options.threshold ?? BACKTEST_GATE;
  if (!(threshold >= 0 && threshold <= 1)) throw new BacktestError('The gate’s threshold must be between 0 and 1');
  const flow = isFlowDetector(detector);
  if (!flow && !isBuiltinDetector(detector)) throw new BacktestError(`Unknown detector ${detector}`);
  const count = Math.floor(days / step) + 1;
  const cap = flow ? MAX_BACKTEST_POINTS.flow : MAX_BACKTEST_POINTS.builtin;
  if (count > cap) throw new BacktestError(`${count} points is too many for ${flow ? 'a detector flow (each point is a run of the flow)' : 'a detector'}: at most ${cap}. Raise the step`);
  const quiet = options.quiet ?? quietOf(detector, db);
  const times = Array.from({ length: count }, (_, k) => now - (count - 1 - k) * step * DAY_MS);

  const seen = new Map<string, Seen>();
  const points: BacktestResult['points'] = [];
  const budget = Date.now() + (options.budgetMs ?? BACKTEST_BUDGET_MS);
  let partial = false;
  const base = flow ? undefined : detectContext({ [detector]: quiet }, db, now);
  for (const [k, at] of times.entries()) {
    if (options.signal?.aborted || Date.now() > budget) {
      partial = true;
      break;
    }
    let found: Array<{ fingerprint: string; title: string; confidence: number }> = [];
    let error: string | undefined;
    try {
      if (flow) {
        const result = await backtestFlowAt(detector, { at, quiet, ...(k > 0 && { lastAt: times[k - 1] }), signal: options.signal });
        found = result.findings;
        error = result.error;
      } else {
        const ctx = { ...base!, db: asOfView(db, at), now: at };
        found = DETECTOR_RUNS[detector as keyof typeof DETECTOR_RUNS](ctx).map(({ proposal }: Finding) => ({ fingerprint: proposal.fingerprint, title: proposal.title, confidence: proposal.confidence }));
      }
    } catch (caught) {
      error = (caught as Error).message ?? String(caught);
    }
    points.push({ at: new Date(at).toISOString(), found: found.length, ...(error && { error }) });
    for (const f of new Map(found.map((x) => [x.fingerprint, x])).values()) {
      const held = seen.get(f.fingerprint);
      if (held) {
        held.lastAt = at;
        held.points++;
        held.confidence = Math.max(held.confidence, f.confidence);
      } else seen.set(f.fingerprint, { ...f, firstAt: at, lastAt: at, points: 1 });
    }
  }
  // Every point failing is not a score of zero findings: say so.
  if (points.length && points.every((p) => p.error) && !seen.size) throw new BacktestError(`The detector failed at every point: ${points[0].error}`, 502);

  const decided = decisionsFor(detector, db);
  const findings: BacktestFinding[] = [...seen.values()]
    .sort((a, b) => a.firstAt - b.firstAt)
    .map((s) => {
      const d = decided.get(s.fingerprint);
      return {
        fingerprint: s.fingerprint,
        title: s.title,
        confidence: s.confidence,
        firstAt: new Date(s.firstAt).toISOString(),
        lastAt: new Date(s.lastAt).toISOString(),
        points: s.points,
        verdict: d?.verdict ?? 'unknown',
        decision: d?.decision ?? 'none',
        ...(d && { proposalId: d.proposal.id }),
      };
    });
  const from = times[0];
  const missed: BacktestMiss[] = [...decided.values()]
    .filter((d) => d.verdict !== 'unknown' && !seen.has(d.proposal.fingerprint) && Date.parse(d.proposal.createdAt) >= from && Date.parse(d.proposal.createdAt) <= now)
    .map((d) => ({ proposalId: d.proposal.id, fingerprint: d.proposal.fingerprint, title: d.proposal.title, decision: d.decision, wanted: d.verdict === 'hit' }));
  const hits = findings.filter((f) => f.verdict === 'hit').length;
  const falseAlarms = findings.filter((f) => f.verdict === 'false-alarm').length;
  const misses = missed.filter((m) => m.wanted).length;
  const ratio = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 1000 : null);
  const precision = ratio(hits, hits + falseAlarms);
  const ok = precision === null || precision >= threshold;
  const result: BacktestResult = {
    id: `bt_${nanoid(10)}`,
    detector,
    label: detectorLabel(detector, flow ? store.getWorkflow(detector.slice('flow:'.length))?.name : undefined),
    createdAt: new Date(started).toISOString(),
    from: new Date(from).toISOString(),
    to: new Date(now).toISOString(),
    days,
    step,
    quiet,
    quietGiven: options.quiet !== undefined,
    points,
    findings,
    missed,
    counts: { findings: findings.length, hits, falseAlarms, unknown: findings.length - hits - falseAlarms, misses, avoided: missed.length - misses },
    precision,
    recall: ratio(hits, hits + misses),
    gate: {
      threshold,
      ok,
      reason:
        precision === null
          ? 'Nothing it found was decided, so there is nothing to score'
          : ok
            ? `Precision ${Math.round(precision * 100)}% is at least ${Math.round(threshold * 100)}%`
            : `Precision ${Math.round(precision * 100)}% is under ${Math.round(threshold * 100)}%: people would mostly have dismissed what it finds`,
    },
    ...(partial && { partial: true }),
    durationMs: Date.now() - started,
  };
  saveBacktest(result, db);
  return result;
}

function saveBacktest(result: BacktestResult, db: Database) {
  db.upsert('brain_backtests', { id: result.id, detector: result.detector, created_at: result.createdAt, precision_rate: result.precision, failing: result.gate.ok ? 0 : 1, data: JSON.stringify(result) });
  const stale = db.all<{ id: string }>('SELECT id FROM brain_backtests WHERE detector = ? ORDER BY created_at DESC, id DESC LIMIT -1 OFFSET ?', result.detector, KEEP_PER_DETECTOR);
  for (const { id } of stale) db.delete('brain_backtests', { id });
}

/** Past backtests, newest first (of one detector, or all). */
export function listBacktests(filter: { detector?: DetectorId; limit?: number } = {}, db: Database = database()): BacktestResult[] {
  const limit = Math.max(1, Math.min(100, Math.floor(filter.limit ?? 10)));
  const rows = filter.detector
    ? db.all<{ data: string }>('SELECT data FROM brain_backtests WHERE detector = ? ORDER BY created_at DESC, id DESC LIMIT ?', filter.detector, limit)
    : db.all<{ data: string }>('SELECT data FROM brain_backtests ORDER BY created_at DESC, id DESC LIMIT ?', limit);
  return rows.flatMap((r) => parse<BacktestResult>(r.data) ?? []);
}
