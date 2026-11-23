'use client';
/**
 * The public request page's client (docs/access-requests.md#the-request-page): the calls to `/request-access/api/*`, with the
 * requester cookie (`landflow_requester`, httpOnly: the browser sends it, the page never reads it). It is an `AccessClient`, so the
 * Ask, My requests, Grants and Chat components of the Access page serve this page too. Nothing here touches `/api/*`, the Landflow
 * session or the login redirect of `api()`: an outsider whose session ended is told so on this page, never sent to /login.
 */
import type { AccessGrantView, AccessPerson, AccessRequestView, AccessSystem, OutsideEntryView, OutsideGrantView, OutsideRequestView, VerifiedBy } from '@/lib/shared/access';
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
  requester: { email: string; name?: string | null; verifiedBy?: VerifiedBy };
  chat: boolean;
}

async function call<T>(path: string, init: { method?: string; json?: unknown } = {}): Promise<T> {
  const response = await fetch(`${OUTSIDE_BASE}/${path}`, {
    method: init.method ?? 'GET',
    // The server refuses a write that is not JSON (415), so every write says so, with an empty object when it has nothing to send.
    headers: init.json !== undefined || init.method ? { 'content-type': 'application/json' } : undefined,
    body: init.json !== undefined ? JSON.stringify(init.json) : init.method && init.method !== 'GET' ? '{}' : undefined,
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

/** What the server calls the signed-in person, for the rows that need a requester (the views of an outsider never name one). */
const SELF: AccessPerson = { id: 'self', name: 'You', kind: 'outside' };

/** An open entry (B's `OutsideEntryView`) as the Ask form reads it: no approvers, no owners. */
function askEntry(entry: OutsideEntryView): AskEntry {
  return { id: entry.id, name: entry.name, ...(entry.description && { description: entry.description }), system: entry.system, durations: entry.durations, target: { key: entry.id, type: entry.system, label: entry.targetLabel, config: {} } };
}

/** The outsider's own grant (`OutsideGrantView`) as the shared grant components read it. */
function grantView(grant: OutsideGrantView): AccessGrantView {
  return {
    id: grant.id,
    ...(grant.requestId && { requestId: grant.requestId }),
    entryId: grant.entryId,
    entryName: grant.entryName,
    holder: SELF,
    ...(grant.account && { account: grant.account }),
    system: grant.system,
    targetLabel: grant.targetLabel,
    status: grant.status,
    ...(grant.since && { since: grant.since }),
    ...(grant.until !== undefined && { until: grant.until }),
    ...(grant.endedAt && { endedAt: grant.endedAt }),
    ...(grant.endReason && { endReason: grant.endReason }),
    alreadyHad: false,
    canRevoke: grant.canGiveBack,
    canMarkDone: false,
    canRetry: false,
  };
}

/** The outsider's own request (`OutsideRequestView`) as the shared request components read it: nobody else is named. */
function requestView(request: OutsideRequestView): AccessRequestView {
  return {
    id: request.id,
    entryId: request.entryId,
    entryName: request.entryName,
    system: request.system,
    requester: SELF,
    ...(request.account && { account: request.account }),
    durationMinutes: request.durationMinutes,
    reason: request.reason,
    channel: request.channel,
    status: request.status,
    decisions: [],
    ...(request.approvedMinutes !== undefined && { approvedMinutes: request.approvedMinutes }),
    ...(request.note && { note: request.note }),
    ...(request.grant && { grant: grantView(request.grant) }),
    approverNames: [],
    canDecide: false,
    canCancel: request.canCancel,
    createdAt: request.createdAt,
  };
}

export const outsideHref = (tab: AccessTabId, requestId?: string) => `${OUTSIDE_PATH}?tab=${tab}${requestId ? `&request=${requestId}` : ''}`;

export const outsideApi = {
  kind: 'outside' as const,
  hrefFor: outsideHref,
  config: () => call<OutsideConfig>('config'),
  session: () => call<OutsideSession>('session'),
  signInEmail: (email: string) => call<unknown>('sign-in/email', { method: 'POST', json: { email } }),
  /** Whose link is it? The masked address, without using the link up. */
  peek: (token: string) => call<{ email: string }>('sign-in/peek', { method: 'POST', json: { token } }),
  verify: (token: string) => call<unknown>('sign-in/verify', { method: 'POST', json: { token } }),
  signOut: () => call<unknown>('sign-out', { method: 'POST' }),
  entries: async (): Promise<{ items: AskEntry[] }> => ({ items: itemsOf<OutsideEntryView>(await call('entries')).map(askEntry) }),
  requests: async (_scope: 'mine' = 'mine'): Promise<{ items: AccessRequestView[] }> => ({ items: itemsOf<OutsideRequestView>(await call('requests')).map(requestView) }),
  ask: async (input: { entryId: string; durationMinutes: number | null; reason: string; account?: string }): Promise<AccessRequestView> => requestView(await call<OutsideRequestView>('requests', { method: 'POST', json: input })),
  cancel: (id: string) => call<unknown>(`requests/${id}/cancel`, { method: 'POST' }),
  grants: async (_scope: 'mine' | 'all' = 'mine'): Promise<{ items: AccessGrantView[] }> => ({ items: itemsOf<OutsideGrantView>(await call('grants')).map(grantView) }),
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
