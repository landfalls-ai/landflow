/**
 * Who is making the current request, for code below the route handler (saving a workflow records `updatedBy`, a
 * manual run records `startedBy`). The route guard (`handler` in lib/server/http.ts) runs each handler inside
 * `withAuth`; outside a request (schedules, webhooks, boot) there is no actor.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { ApiKeyScope } from '../../shared/auth';
import { singleton } from '../singleton';
import type { UserRecord } from './users';

export interface Principal {
  user: UserRecord;
  via: 'session' | 'api-key' | 'test' | 'mcp';
  /** The SHA-256 id of the session (via session). */
  sessionId?: string;
  /** The key (via api-key). */
  apiKey?: { id: string; scopes: ApiKeyScope[] };
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
