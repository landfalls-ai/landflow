/**
 * Compatibility module: the host's composition root is lib/server/runtime.ts (one service table for the main and the
 * worker). `ensureBootstrapped()` starts the main's services once; instrumentation.ts registers it as the bootstrapper
 * that `whenReady()` (lib/server/lifecycle.ts) calls, so route modules no longer import it, and tests and pages call it
 * directly.
 */
import { startRuntime } from './runtime';

export const ensureBootstrapped = (): Promise<void> => startRuntime({ role: 'main' });
