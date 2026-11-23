/**
 * "This run is a backtest" (docs/second-brain.md#backtesting-a-detector): while a detector flow runs for a backtest,
 * the run carries the moment it pretends to be (`asOf`) and the quiet multiplier it is tested with. Nodes read it with
 * `backtestScope()`: Suggest Improvement posts nothing and returns the finding it would have posted, Landflow Usage reads
 * the ledger up to `asOf`, and the store keeps the run out of the ledger and Insights. It is an async-local scope, so it
 * follows the run without anything wired in the workflow; it does not cross to a queue-mode worker (backtests of flows
 * need regular mode).
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { singleton } from '../singleton';

export interface BacktestScope {
  /** The moment being replayed, in ms. */
  asOf: number;
  /** The quiet multiplier the detector is tested with. */
  quiet: number;
}

// Pinned to globalThis: Next.js compiles the routes and the node registry into separate module graphs, and a
// module-level store would leave the nodes blind to a backtest started from the route.
const scope = () => singleton('brain-backtest-scope', () => new AsyncLocalStorage<BacktestScope>());

/** The backtest this code runs in, if it does. */
export const backtestScope = (): BacktestScope | undefined => scope().getStore();

/** Run `fn` as a backtest at `asOf`. */
export const inBacktest = <T>(value: BacktestScope, fn: () => T): T => scope().run(value, fn);
