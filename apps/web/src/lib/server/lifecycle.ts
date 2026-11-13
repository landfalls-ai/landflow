/**
 * Process lifecycle, in one place: the shutdown registry (what to stop, in which phase, in which order), draining and
 * in-flight request counting, the boot state readiness reads, and the process-wide signal and error handlers.
 *
 * Why it exists: a main used to stop without flushing the Postgres write queue, releasing the leader lease, stopping
 * the timers or flushing telemetry, and a failed boot left every request answering 500 (docs/deployment.md, "Stopping
 * the host"). State lives in `singleton('lifecycle')` because Next.js compiles instrumentation and each route into
 * separate module graphs.
 */
import { metrics } from '@opentelemetry/api';
import { singleton } from './singleton';
import { logger } from './telemetry/logger';

export type ShutdownPhase = 'intake' | 'services' | 'runs' | 'cluster' | 'storage' | 'telemetry';
/** Phases run in this order. */
export const SHUTDOWN_PHASES: ShutdownPhase[] = ['intake', 'services', 'runs', 'cluster', 'storage', 'telemetry'];

export type BootState = 'starting' | 'ready' | 'failed';

interface Step {
  name: string;
  fn: () => unknown;
  phase: ShutdownPhase;
  timeoutMs?: number;
}

interface LifecycleState {
  steps: Map<string, Step>;
  draining: boolean;
  shutdownPromise?: Promise<void>;
  inFlight: number;
  idleWaiters: Array<() => void>;
  boot: BootState;
  bootError?: unknown;
  bootstrapper?: () => Promise<void>;
  booting?: Promise<void>;
  handlersInstalled: boolean;
}

const state = () =>
  singleton<LifecycleState>('lifecycle', () => ({ steps: new Map(), draining: false, inFlight: 0, idleWaiters: [], boot: 'starting', handlersInstalled: false }));

/** The deadline for the whole shutdown: LANDFLOW_SHUTDOWN_SECONDS (default 25, inside Kubernetes' 30 s grace period). */
export function shutdownDeadlineMs(): number {
  const seconds = Number(process.env.LANDFLOW_SHUTDOWN_SECONDS);
  return (Number.isFinite(seconds) && seconds > 0 ? seconds : 25) * 1000;
}

// ---------------------------------------------------------------------------
// Shutdown registry
// ---------------------------------------------------------------------------

/** Register a step of the shutdown. The same name again replaces the entry (hot reload). Returns an unregister function. */
export function onShutdown(name: string, fn: () => unknown, phase: ShutdownPhase, options: { timeoutMs?: number } = {}): () => void {
  const step: Step = { name, fn, phase, ...(options.timeoutMs !== undefined && { timeoutMs: options.timeoutMs }) };
  state().steps.set(name, step);
  return () => {
    const steps = state().steps;
    if (steps.get(name) === step) steps.delete(name);
  };
}

/** Run `fn` bounded by `ms`; resolves 'timeout' rather than waiting longer. The timer never keeps the process alive. */
async function bounded(fn: () => unknown, ms: number): Promise<'ok' | 'timeout'> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), Math.max(0, ms));
    timer.unref?.();
  });
  try {
    return await Promise.race([Promise.resolve().then(fn).then(() => 'ok' as const), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Stop everything, phase by phase. Idempotent: a second call gets the same promise. Never rejects. */
export function shutdown(reason: string, options: { deadlineMs?: number } = {}): Promise<void> {
  const s = state();
  if (s.shutdownPromise) return s.shutdownPromise;
  s.draining = true;
  const started = Date.now();
  const total = options.deadlineMs ?? shutdownDeadlineMs();
  const deadline = started + total;
  // Reserve for the flush: intake, services and runs may use the budget only up to `softDeadline`; cluster, storage and
  // telemetry always keep the last `reserve` (5 s, or a fifth of a short budget) so Postgres and telemetry still flush.
  const softDeadline = deadline - Math.min(5_000, total * 0.2);
  logger.info('shutdown: starting', { reason, 'landflow.shutdown.deadline_ms': deadline - started });
  s.shutdownPromise = (async () => {
    for (const phase of SHUTDOWN_PHASES) {
      if (phase === 'intake') {
        // Next.js no longer closes its HTTP server in manual signal mode: in-flight requests are awaited here.
        logger.info('shutdown: intake/requests', { 'landflow.requests.in_flight': s.inFlight });
        await waitForRequests(softDeadline - Date.now());
      }
      const steps = [...s.steps.values()].filter((step) => step.phase === phase);
      const limit = phase === 'intake' || phase === 'services' || phase === 'runs' ? softDeadline : deadline;
      for (const step of steps) {
        const left = limit - Date.now();
        logger.info(`shutdown: ${phase}/${step.name}`);
        try {
          const outcome = await bounded(step.fn, Math.min(step.timeoutMs ?? left, left));
          if (outcome === 'timeout') logger.warn('shutdown step failed', { step: step.name, phase, error: 'timed out' });
        } catch (error) {
          logger.warn('shutdown step failed', { step: step.name, phase, error: error instanceof Error ? error.message : String(error) });
        }
      }
    }
    logger.info('shutdown complete', { reason, 'landflow.shutdown.duration_ms': Date.now() - started });
  })();
  return s.shutdownPromise;
}

// ---------------------------------------------------------------------------
// Draining and in-flight requests
// ---------------------------------------------------------------------------

export function isDraining(): boolean {
  return state().draining;
}

/** Count `fn` as an in-flight request until it settles. */
export async function trackRequest<T>(fn: () => Promise<T>): Promise<T> {
  const s = state();
  s.inFlight++;
  try {
    return await fn();
  } finally {
    s.inFlight--;
    if (s.inFlight === 0) for (const wake of s.idleWaiters.splice(0)) wake();
  }
}

/** Resolve when no request is in flight, or after `ms`. */
export function waitForRequests(ms: number): Promise<void> {
  const s = state();
  if (s.inFlight === 0 || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    timer.unref?.();
    function done() {
      clearTimeout(timer);
      resolve();
    }
    s.idleWaiters.push(done);
  });
}

// ---------------------------------------------------------------------------
// Boot state
// ---------------------------------------------------------------------------

export function bootState(): BootState {
  return state().boot;
}

export function markBooted(): void {
  const s = state();
  s.boot = 'ready';
  s.bootError = undefined;
}

export function markBootFailed(error: unknown): void {
  const s = state();
  s.boot = 'failed';
  s.bootError = error;
}

export function bootError(): unknown {
  return state().bootError;
}

/** The function `whenReady()` calls to boot the host when nothing has yet. */
export function setBootstrapper(fn: () => Promise<void>): void {
  state().bootstrapper = fn;
}

/** Resolves once the host booted; boots it through the registered bootstrapper if it hasn't started (a failed boot retries). */
export function whenReady(): Promise<void> {
  const s = state();
  if (s.boot === 'ready') return Promise.resolve();
  if (!s.bootstrapper) return Promise.reject(new Error('The host has no bootstrapper registered'));
  s.booting ??= s.bootstrapper().finally(() => {
    s.booting = undefined;
  });
  return s.booting;
}

// ---------------------------------------------------------------------------
// Process handlers
// ---------------------------------------------------------------------------

function processErrors(kind: string) {
  metrics.getMeter('landflow-host').createCounter('landflow.process.errors', { description: 'Process-level errors: unhandled rejections, uncaught exceptions, services that failed to start' }).add(1, { kind });
}

/** Count a process-level error (`landflow.process.errors{kind}`). */
export const countProcessError = processErrors;

/** An unhandled rejection is logged and counted; the process keeps running (as the worker always did). */
export function onUnhandledRejection(reason: unknown): void {
  logger.error('unhandled rejection', { error: reason });
  processErrors('unhandled_rejection');
}

export interface ProcessHandlerOptions {
  role: 'main' | 'worker';
  exit?: (code: number) => unknown;
  /** Install the SIGTERM / SIGINT handlers (default true). */
  signals?: boolean;
  /** Deadline of the signal-triggered shutdown (default LANDFLOW_SHUTDOWN_SECONDS). */
  deadlineMs?: number;
  /** Shut down and exit 1 on an uncaught exception (default true; the dev host only logs and counts, as Next.js does). */
  exitOnUncaught?: boolean;
}

/** Install the handlers once per process; never under vitest. */
export function installProcessHandlers(options: ProcessHandlerOptions): void {
  const s = state();
  if (s.handlersInstalled || process.env.VITEST) return;
  s.handlersInstalled = true;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  process.on('unhandledRejection', onUnhandledRejection);
  process.on('uncaughtException', (error) => {
    logger.error('uncaught exception', { error });
    processErrors('uncaught_exception');
    if (options.exitOnUncaught === false) return;
    void shutdown('uncaughtException', { deadlineMs: 5_000 }).then(() => exit(1));
  });
  if (options.signals === false) return;
  let signalled = false;
  const onSignal = (signal: string) => {
    if (signalled) {
      logger.warn(`${options.role}: second signal, exiting now`, { signal });
      exit(1);
      return;
    }
    signalled = true;
    void shutdown(signal, options.deadlineMs !== undefined ? { deadlineMs: options.deadlineMs } : {}).then(() => exit(0));
  };
  process.on('SIGTERM', () => onSignal('SIGTERM'));
  process.on('SIGINT', () => onSignal('SIGINT'));
}
