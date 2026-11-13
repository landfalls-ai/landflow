/**
 * Runs before every test file: route handlers are called directly, without a session, so the auth guard signs
 * guarded requests in as a synthetic owner (lib/server/auth/test-bypass.ts). Auth tests call `disableTestAuth()`.
 */
import { enableTestAuth } from '@/lib/server/auth/test-bypass';
import { setBootstrapper } from '@/lib/server/lifecycle';

enableTestAuth();

// Routes wait on `whenReady()`; tests register the bootstrapper instrumentation.ts registers, so a route test boots
// the host lazily on its first handler call (the module is imported then, after the test set its environment).
setBootstrapper(() => import('@/lib/server/bootstrap').then((m) => m.ensureBootstrapped()));
