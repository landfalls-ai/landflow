'use client';
/**
 * The public request page's client (docs/access-requests.md#the-request-page): the calls to `/request-access/api/*`, with the
 * requester cookie (`landflow_requester`, httpOnly: the browser sends it, the page never reads it). It is an `AccessClient`, so the
 * Ask, My requests, Grants and Chat components of the Access page serve this page too. Nothing here touches `/api/*`, the Landflow
 * session or the login redirect of `api()`: an outsider whose session ended is told so on this page, never sent to /login.
 */
import type { AccessGrantView, AccessRequestView, AccessSystem } from '@/lib/shared/access';
import { ApiError } from './api';
import type { AccessAccounts, AccessClient, AccessTabId, AskEntry } from './access';

export const OUTSIDE_PATH = '/request-access';
export const OUTSIDE_BASE = '/request-access/api';
/** Fired on the window when a call answers 401: the requester's session ended (or never was). */
export const OUTSIDE_SESSION_ENDED = 'landflow:outside-session-ended';

/** What `GET config` says: nothing but whether the page is on and which ways in exist. */
export interface OutsideConfig {
  enabled: boolean;
  google: boolean;
  /** The host can send the sign-in link. */
  email: boolean;
}
/** What `GET session` says. */
export interface OutsideSession {
  requester: { email: string; name?: string; verifiedBy?: 'email' | 'google' };
  chat: boolean;
}

async function call<T>(path: string, init: { method?: string; json?: unknown } = {}): Promise<T> {
  const response = await fetch(`${OUTSIDE_BASE}/${path}`, {
    method: init.method ?? 'GET',
    headers: init.json !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
    cache: 'no-store',
    credentials: 'same-origin',
  });
  const text = await response.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }
  if (!response.ok) {
    if (response.status === 401 && typeof window !== 'undefined') window.dispatchEvent(new Event(OUTSIDE_SESSION_ENDED));
    const message = (body as { error?: string } | undefined)?.error ?? (response.status === 429 ? 'Too many tries. Wait a little and try again.' : `Something went wrong (${response.status})`);
    throw new ApiError(message, response.status, body);
  }
  return body as T;
}

/** The server's list answers `{ items }`; a bare array is accepted too. */
const itemsOf = <T>(body: unknown): T[] => (Array.isArray(body) ? (body as T[]) : ((body as { items?: T[] } | undefined)?.items ?? []));

interface OpenEntry {
  id: string;
  name: string;
  description?: string;
  durations: Array<number | null>;
  system?: AccessSystem;
  target?: { label?: string };
  targetLabel?: string;
  needsGithub?: boolean;
  githubRequired?: boolean;
}

/** An open entry as the Ask form reads it: the system follows the GitHub need unless the server names it; no approvers. */
function askEntry(entry: OpenEntry): AskEntry {
  const needsGithub = entry.needsGithub ?? entry.githubRequired ?? false;
  const system: AccessSystem = entry.system ?? (needsGithub ? 'github-team' : 'manual');
  const label = entry.target?.label ?? entry.targetLabel ?? entry.name;
  return { id: entry.id, name: entry.name, ...(entry.description && { description: entry.description }), system, durations: entry.durations, target: { key: entry.id, type: system, label, config: {} } };
}

export const outsideHref = (tab: AccessTabId, requestId?: string) => `${OUTSIDE_PATH}?tab=${tab}${requestId ? `&request=${requestId}` : ''}`;

export const outsideApi = {
  kind: 'outside' as const,
  hrefFor: outsideHref,
  config: () => call<OutsideConfig>('config'),
  session: () => call<OutsideSession>('session'),
  signInEmail: (email: string) => call<unknown>('sign-in/email', { method: 'POST', json: { email } }),
  verify: (token: string) => call<unknown>('sign-in/verify', { method: 'POST', json: { token } }),
  signOut: () => call<unknown>('sign-out', { method: 'POST' }),
  entries: async (): Promise<{ items: AskEntry[] }> => ({ items: itemsOf<OpenEntry>(await call('entries')).map(askEntry) }),
  requests: async (_scope: 'mine' = 'mine'): Promise<{ items: AccessRequestView[] }> => ({ items: itemsOf<AccessRequestView>(await call('requests')) }),
  ask: (input: { entryId: string; durationMinutes: number | null; reason: string; account?: string }) => call<AccessRequestView>('requests', { method: 'POST', json: { ...input, channel: 'form' } }),
  cancel: (id: string) => call<unknown>(`requests/${id}/cancel`, { method: 'POST' }),
  grants: async (_scope: 'mine' | 'all' = 'mine'): Promise<{ items: AccessGrantView[] }> => ({ items: itemsOf<AccessGrantView>(await call('grants')) }),
  // An outsider has Give it back only: the Access page's "revoke" is the same button.
  grantAction: (id: string, action: 'revoke' | 'done' | 'retry') => {
    if (action !== 'revoke') return Promise.reject(new ApiError('Only giving access back is possible here.', 400));
    return call<unknown>(`grants/${id}/give-back`, { method: 'POST' });
  },
  accounts: async (): Promise<AccessAccounts> => {
    const body = await call<{ github?: string } | undefined>('account');
    return { ...(body?.github && { github: body.github }) };
  },
  saveGithub: (github: string) => call<unknown>('account', { method: 'PUT', json: { github } }),
  chat: (message: string, sessionId: string) => call<{ reply: string; requestId?: string }>('chat', { method: 'POST', json: { message, sessionId } }),
} satisfies AccessClient & Record<string, unknown>;
