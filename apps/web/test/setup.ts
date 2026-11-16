/**
 * Runs before every test file: route handlers are called directly, without a session, so the auth guard signs
 * guarded requests in as a synthetic owner (lib/server/auth/test-bypass.ts). Auth tests call `disableTestAuth()`.
 */
import { enableTestAuth } from '@/lib/server/auth/test-bypass';
import { setBootstrapper } from '@/lib/server/lifecycle';

enableTestAuth();

// Exact counting of a prompt's parts talks to the model's server (count endpoint, /api/tags): off in tests unless a test
// asks for it (ai-call-count.test.ts sets `exact`), so no background request lands in a fake service's log.
process.env.LANDFLOW_AI_PARTS_COUNT = 'estimate';

// Routes wait on `whenReady()`; tests register the bootstrapper instrumentation.ts registers, so a route test boots
// the host lazily on its first handler call (the module is imported then, after the test set its environment).
setBootstrapper(() => import('@/lib/server/bootstrap').then((m) => m.ensureBootstrapped()));
