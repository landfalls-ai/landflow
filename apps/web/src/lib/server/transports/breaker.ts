/**
 * The circuit breaker of one endpoint (docs/transports.md "Choosing a transport per call", rule 6): open after 5
 * failures in a row or more than half of the last 20 outcomes (once at least `minSamples` are in), half-open after
 * 15 s. Half-open lets one trial through (a probe or a real call); its success closes the breaker, its failure opens
 * it again for another 15 s. Successes while open (a probe that got lucky inside the 15 s) don't close it: the spec's
 * timing stands.
 */
import type { BreakerState } from '../../shared/transports';

export interface BreakerOptions {
  /** Failures in a row that open the breaker. */
  consecutive?: number;
  /** The ring the ratio rule looks at, and the share of failures that opens the breaker. */
  window?: number;
  ratio?: number;
  /** Outcomes the ring needs before the ratio rule applies (two failures of two calls are not "more than half of the last 20"). */
  minSamples?: number;
  halfOpenAfterMs?: number;
}

export const BREAKER_DEFAULTS: Required<BreakerOptions> = { consecutive: 5, window: 20, ratio: 0.5, minSamples: 10, halfOpenAfterMs: 15_000 };

export class CircuitBreaker {
  private readonly options: Required<BreakerOptions>;
  private readonly ring: boolean[] = [];
  private consecutive = 0;
  private openedAt?: number;
  private trial = false;
  /** Why it opened, for the feed. */
  cause?: string;

  constructor(
    private readonly now: () => number = Date.now,
    options: BreakerOptions = {},
  ) {
    this.options = { ...BREAKER_DEFAULTS, ...options };
  }

  state(): BreakerState {
    if (this.openedAt === undefined) return 'closed';
    return this.now() - this.openedAt >= this.options.halfOpenAfterMs ? 'half-open' : 'open';
  }

  /** Whether a call may go to the endpoint now: closed → yes; half-open → one trial at a time; open → no. */
  allows(): boolean {
    const state = this.state();
    if (state === 'closed') return true;
    if (state === 'open' || this.trial) return false;
    this.trial = true;
    return true;
  }

  /** The outcome of a call or probe. Returns the transition it caused, if any. */
  record(ok: boolean): 'opened' | 'closed' | undefined {
    const state = this.state();
    this.trial = false;
    if (ok) {
      this.consecutive = 0;
      if (state === 'half-open') {
        this.openedAt = undefined;
        this.ring.length = 0;
        this.cause = undefined;
        return 'closed';
      }
      if (state === 'closed') this.push(false);
      return undefined;
    }
    this.consecutive++;
    if (state === 'half-open') {
      this.openedAt = this.now();
      this.cause = 'the trial call failed';
      return 'opened';
    }
    if (state === 'open') return undefined;
    this.push(true);
    const failures = this.ring.filter(Boolean).length;
    if (this.consecutive >= this.options.consecutive) this.cause = `${this.consecutive} failures in a row`;
    else if (this.ring.length >= this.options.minSamples && failures > this.options.ratio * this.ring.length) this.cause = `${failures} of the last ${this.ring.length} calls failed`;
    else return undefined;
    this.openedAt = this.now();
    return 'opened';
  }

  private push(failed: boolean): void {
    this.ring.push(failed);
    if (this.ring.length > this.options.window) this.ring.shift();
  }

  /** Back to closed with a clean slate (the endpoint was re-registered). */
  reset(): void {
    this.openedAt = undefined;
    this.ring.length = 0;
    this.consecutive = 0;
    this.trial = false;
    this.cause = undefined;
  }
}
