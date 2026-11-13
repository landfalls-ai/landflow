/**
 * Readiness checks behind GET /api/health/ready.
 *
 * Why it exists: /api/health used to answer "ok" whatever the state of the host and served as both Kubernetes probes,
 * so a host that lost Postgres or Valkey, or was draining, kept its traffic, and a slow database restarted a healthy
 * process. Each check here is bounded by one second and answers only ok and milliseconds: the public body carries no
 * counts, ids or error texts (those go to the log).
 *
 * In Postgres mode `database` runs on the in-process copy, so it does not see Postgres go away; that shows as
 * `writeQueue` lag once a write has been queued for LANDFLOW_READY_MAX_WRITE_LAG_SECONDS. The LISTEN connection is not
 * checked (docs/limitations.md).
 */
import { envInt } from './config';
import { database, LATEST_VERSION } from './db';
import { clusterState } from './cluster/state';
import { bootState, isDraining } from './lifecycle';
import { singleton } from './singleton';
import { logger } from './telemetry/logger';

export interface CheckResult {
  ok: boolean;
  ms: number;
}

export interface Readiness {
  ready: boolean;
  checks: Record<string, CheckResult>;
}

const CHECK_TIMEOUT_MS = 1000;

/** Checks that failed on the last probe: a failure is logged when it starts, not on every probe while it lasts. */
function noteResult(name: string, ok: boolean, detail?: string) {
  const failing = singleton('readiness-failing', () => new Set<string>());
  if (ok) {
    failing.delete(name);
    return;
  }
  // `boot` is false for the whole start and the whole drain, which is expected, not a fault.
  if (name === 'boot' || failing.has(name)) return;
  failing.add(name);
  logger.warn('readiness check failed', { check: name, ...(detail ? { error: detail } : {}) });
}

/** Run one check, bounded; a throw, a timeout or `false` is not ok (the reason is logged, never returned). */
async function check(name: string, fn: () => unknown): Promise<[string, CheckResult]> {
  const started = Date.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('timed out')), CHECK_TIMEOUT_MS);
      timer.unref?.();
    });
    const outcome = await Promise.race([Promise.resolve().then(fn), timeout]);
    const ok = outcome !== false;
    noteResult(name, ok);
    return [name, { ok, ms: Date.now() - started }];
  } catch (error) {
    noteResult(name, false, error instanceof Error ? error.message : String(error));
    return [name, { ok: false, ms: Date.now() - started }];
  } finally {
    clearTimeout(timer);
  }
}

/** The write queue may lag this long (LANDFLOW_READY_MAX_WRITE_LAG_SECONDS, default 30) before the host reports not ready. */
const maxWriteLagMs = () => envInt('LANDFLOW_READY_MAX_WRITE_LAG_SECONDS', { fallback: 30, min: 1 }) * 1000;

export async function readiness(): Promise<Readiness> {
  // Boot and draining first and alone: before boot finishes the database and cluster do not exist yet.
  const boot = await check('boot', () => bootState() === 'ready' && !isDraining());
  const checks: Record<string, CheckResult> = { [boot[0]]: boot[1] };
  if (boot[1].ok) {
    const queue = clusterState().config.mode === 'queue';
    const results = await Promise.all([
      check('database', () => database().get('SELECT 1')),
      check('writeQueue', () => {
        const health = database().writeHealth();
        return health.state !== 'blocked' && health.oldestAgeMs < maxWriteLagMs();
      }),
      check('migrations', () => database().schemaVersion() >= LATEST_VERSION),
      ...(queue
        ? [
            check('valkey', async () => {
              const coordinator = clusterState().coordinator;
              if (!coordinator) return false;
              await coordinator.get('health:ping');
            }),
          ]
        : []),
    ]);
    for (const [name, result] of results) checks[name] = result;
  }
  return { ready: Object.values(checks).every((c) => c.ok), checks };
}
