/**
 * Who is making the current request, for code below the route handler (saving a workflow records `updatedBy`, a
 * manual run records `startedBy`). The route guard (`handler` in lib/server/http.ts) runs each handler inside
 * `withAuth`; outside a request (schedules, webhooks, boot) there is no actor.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { ApiKeyScope } from '../../shared/auth';
import { singleton } from '../singleton';
import type { SessionMethod } from './sessions';
import type { UserRecord } from './users';

export interface Principal {
  user: UserRecord;
  via: 'session' | 'api-key' | 'test' | 'mcp';
  /** The SHA-256 id of the session (via session). */
  sessionId?: string;
  /** How the session was made (via session): the guard's enrolment rule reads it. */
  sessionMethod?: SessionMethod;
  /**
   * A covered account with no second factor yet (LANDFLOW_MFA_REQUIRED): this session may only enrol one. The guard refuses it
   * everywhere else; a public route that reads the session cookie itself must treat it as no one (see ./policy `enrolmentRequired`).
   */
  enrolOnly?: boolean;
  /** The key (via api-key). */
  apiKey?: { id: string; scopes: ApiKeyScope[]; /** The key's use cap: the request is counted after the guard (http.ts, auth/api-key-uses.ts). */ maxUses?: number; label?: string };
}

export interface RequestAuth {
  /** Absent on public routes and for anonymous callers. */
  principal?: Principal;
}

const storage = () => singleton('auth-context', () => new AsyncLocalStorage<RequestAuth>());

export function withAuth<T>(auth: RequestAuth, fn: () => T): T {
  return storage().run(auth, fn);
}

/** The current request's auth, inside a route handler; undefined elsewhere. */
export function requestAuth(): RequestAuth | undefined {
  return storage().getStore();
}

/** The id of the user making the current request, if any. */
export function currentActorId(): string | undefined {
  return storage().getStore()?.principal?.user.id;
}

/**
 * Run `fn` outside the current request's auth: no actor inside it, nor in the timers and promises it starts. For work a
 * request only sets off (a decision's listening workflows): it must not run as the person who made the request.
 */
export function outsideRequest<T>(fn: () => T): T {
  return storage().exit(fn);
}
