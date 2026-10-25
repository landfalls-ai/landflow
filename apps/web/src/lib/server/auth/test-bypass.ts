/**
 * Tests only: the route guard signs guarded requests that carry no credentials in as a synthetic owner, so the
 * suite can call route handlers directly. test/setup.ts turns it on for every test file; auth tests turn it off.
 * Nothing in the app calls this, and no environment variable reaches it. Imports nothing heavy: test/setup.ts loads
 * it before each test file sets its environment.
 */
import { singleton } from '../singleton';
import type { Principal } from './context';
import type { UserRecord } from './users';

const state = () => singleton<{ principal?: Principal }>('auth-test-bypass', () => ({}));

/** The synthetic user guarded requests run as under `enableTestAuth`. */
export const TEST_OWNER: UserRecord = {
  id: 'usr_test_owner',
  email: 'owner@landflow.test',
  name: 'Test Owner',
  role: 'owner',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

export function enableTestAuth(user: UserRecord = TEST_OWNER) {
  state().principal = { user, via: 'test' };
}

export function disableTestAuth() {
  state().principal = undefined;
}

/** The bypass principal, when tests turned it on. */
export function testPrincipal(): Principal | undefined {
  return state().principal;
}
