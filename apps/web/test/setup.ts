/**
 * Runs before every test file: route handlers are called directly, without a session, so the auth guard signs
 * guarded requests in as a synthetic owner (lib/server/auth/test-bypass.ts). Auth tests call `disableTestAuth()`.
 */
import { enableTestAuth } from '@/lib/server/auth/test-bypass';

enableTestAuth();
