'use client';
/**
 * The Access page's client side (docs/access-requests.md#the-access-page): the calls to /api/access, and the plain functions the
 * page's rules are made of (which tabs a person gets, the words for each state, whether Ask is ready, what an approver may allow),
 * so a test reads them without a browser.
 */
import { createContext, createElement, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Viewer } from '@/lib/shared/auth';
import {
  type AccessEntryView,
  type AccessGrantView,
  type AccessRequestView,
  type AccessSetup,
  type AccessState,
  type AccessSystem,
  type VerifiedBy,
  ACCESS_LIMITS,
} from '@/lib/shared/access';
import type { CredentialSummary } from '@/lib/shared/types';
import { api, ApiError } from './api';

type Person = Pick<Viewer, 'id' | 'role'>;

export type AccessTabId = 'ask' | 'mine' | 'decide' | 'grants' | 'catalog' | 'settings';
export interface AccessTab {
  id: AccessTabId;
  label: string;
  /** A count beside the label (To decide). */
  count?: number;
}

/** Owners and admins: the built-in roles, as the server's `isInstanceAdmin` (a custom role never counts). */
export const isAdminViewer = (viewer: Pick<Viewer, 'role'> | null | undefined): boolean => viewer?.role === 'owner' || viewer?.role === 'admin';

/** The person approves at least one entry (the first step lists them), or is an admin, who stand in when an entry has nobody else. */
export function isApprover(viewer: Person, entries: AccessEntryView[]): boolean {
  return isAdminViewer(viewer) || entries.some((entry) => entry.steps.some((step) => step.approvers.userIds.includes(viewer.id)));
}

/** The tabs a person gets once access requests are set up: none before. */
export function accessTabs(input: { setup: AccessSetup | undefined; viewer: Person; entries: AccessEntryView[]; toDecide: number; /** Admins only: the page asks for it (C36 outside requesters' settings). */ settings?: boolean }): AccessTab[] {
  if (!input.setup?.installed) return [];
  const tabs: AccessTab[] = [
    { id: 'ask', label: 'Ask' },
    { id: 'mine', label: 'My requests' },
  ];
  if (isApprover(input.viewer, input.entries)) tabs.push({ id: 'decide', label: 'To decide', count: input.toDecide });
  tabs.push({ id: 'grants', label: 'Grants' });
  if (isAdminViewer(input.viewer) || input.entries.some((entry) => entry.canEdit)) tabs.push({ id: 'catalog', label: 'Catalog' });
  if (input.settings && isAdminViewer(input.viewer)) tabs.push({ id: 'settings', label: 'Settings' });
  return tabs;
}

/** The rail's Access item: everyone once set up, admins always (it opens the setup card). */
export function showAccessInRail(viewer: Pick<Viewer, 'role'> | null | undefined, setup: AccessSetup | undefined): boolean {
  return Boolean(viewer) && (Boolean(setup?.installed) || isAdminViewer(viewer));
}

/** The one word a person sees for a request (spec item 3). */
export const STATE_WORDS: Record<AccessState, string> = {
  waiting: 'Waiting',
  approved: 'Approved',
  granted: 'Granted',
  denied: 'Denied',
  expired: 'Expired',
  failed: 'Failed',
  cancelled: 'Cancelled',
  removed: 'Removed',
};

/**
 * What each system asks for in the entry sheet. It repeats lib/server/access/systems.ts on purpose (that file imports server code a
 * page can't load); `test/access-ui.test.ts` fails when the two drift.
 */
export interface SystemForm {
  label: string;
  account: 'github' | 'google' | 'none';
  credentialTypes: string[];
  fields: Array<{ name: string; label: string; required: boolean; placeholder?: string; options?: Array<{ value: string; label: string }> }>;
}
const pick = (...values: Array<[string, string]>) => values.map(([value, label]) => ({ value, label }));
const GITHUB = ['github.githubApi'];
export const SYSTEM_FORM: Record<AccessSystem, SystemForm> = {
  'github-team': {
    label: 'GitHub team',
    account: 'github',
    credentialTypes: GITHUB,
    fields: [
      { name: 'org', label: 'Organization', required: true, placeholder: 'acme' },
      { name: 'team', label: 'Team slug', required: true, placeholder: 'platform' },
      { name: 'role', label: 'Role', required: false, options: pick(['member', 'Member'], ['maintainer', 'Maintainer']) },
    ],
  },
  'github-org': {
    label: 'GitHub organization',
    account: 'github',
    credentialTypes: GITHUB,
    fields: [
      { name: 'org', label: 'Organization', required: true, placeholder: 'acme' },
      { name: 'role', label: 'Role', required: false, options: pick(['direct_member', 'Member'], ['admin', 'Owner']) },
    ],
  },
  'github-repo': {
    label: 'GitHub repository',
    account: 'github',
    credentialTypes: GITHUB,
    fields: [
      { name: 'owner', label: 'Owner', required: true, placeholder: 'acme' },
      { name: 'repository', label: 'Repository', required: true, placeholder: 'widgets' },
      { name: 'permission', label: 'Permission', required: false, options: pick(['pull', 'Read'], ['triage', 'Triage'], ['push', 'Write'], ['maintain', 'Maintain'], ['admin', 'Admin']) },
    ],
  },
  'github-project': {
    label: 'GitHub project',
    account: 'github',
    credentialTypes: GITHUB,
    fields: [
      { name: 'org', label: 'Organization', required: true, placeholder: 'acme' },
      { name: 'projectNumber', label: 'Project number', required: true, placeholder: '7' },
      { name: 'role', label: 'Role', required: false, options: pick(['READER', 'Reader'], ['WRITER', 'Writer'], ['ADMIN', 'Admin']) },
    ],
  },
  'google-group': {
    label: 'Google group',
    account: 'google',
    credentialTypes: ['google.googleApi', 'google.googleOAuth2Api'],
    fields: [
      { name: 'groupKey', label: 'Group email', required: true, placeholder: 'eng@example.com' },
      { name: 'role', label: 'Role', required: false, options: pick(['MEMBER', 'Member'], ['MANAGER', 'Manager'], ['OWNER', 'Owner']) },
      { name: 'adminEmail', label: 'Admin to impersonate', required: false, placeholder: 'admin@example.com' },
    ],
  },
  manual: {
    label: 'Manual (done by hand)',
    account: 'none',
    credentialTypes: [],
    fields: [{ name: 'instructions', label: 'How to grant it', required: false, placeholder: 'Add them in the Figma admin console' }],
  },
};

/** What the Ask form needs of an entry: an outsider's list has no approvers, owners or credential (plan D-13), so those are optional. */
export type AskEntry = Pick<AccessEntryView, 'id' | 'name' | 'system' | 'durations' | 'target'> & Partial<Pick<AccessEntryView, 'description' | 'approverNames'>>;

/** A catalog entry with the C36 flag: an admin opened it to people without a Landflow account. */
export type CatalogEntry = AccessEntryView & { outsideMayAsk?: boolean };

/** Whether Ask is ready: an entry, one of its durations, a reason of 3 characters or more and, for GitHub, the username. */
export function canAsk(input: { entry: AskEntry | undefined; durationMinutes: number | null | undefined; reason: string; account: string }): boolean {
  const { entry } = input;
  if (!entry || input.durationMinutes === undefined || !entry.durations.includes(input.durationMinutes)) return false;
  if (input.reason.trim().length < ACCESS_LIMITS.reasonChars[0]) return false;
  return SYSTEM_FORM[entry.system].account !== 'github' || input.account.trim().length > 0;
}

/** A refused request in words, with the open request's id when the 409 names it. */
export function requestProblem(error: unknown): { message: string; existingId?: string } {
  if (error instanceof ApiError) {
    const existingId = (error.body as { existingId?: unknown } | undefined)?.existingId;
    return { message: error.message, ...(typeof existingId === 'string' && { existingId }) };
  }
  return { message: error instanceof Error ? error.message : 'Something went wrong' };
}

/** The value Answer Choices carry for a duration (as the trigger writes them: minutes, or `unlimited`). */
export const choiceValue = (minutes: number | null): string => (minutes === null ? 'unlimited' : String(minutes));

/**
 * The longest time an entry sheet offers to add: an admin any, an owner who isn't one no more than the entry's current longest (and
 * no end only if it already has one), as the server's check on save. The server still refuses the rest.
 */
export function durationCeiling(isAdmin: boolean, saved: Array<number | null>): number {
  return isAdmin ? Infinity : Math.max(0, ...saved.map((m) => (m === null ? Infinity : m)));
}
export const withinCeiling = (minutes: number | null, ceiling: number): boolean => (minutes === null ? Infinity : minutes) <= ceiling;

/** Grants whose removal failed and is still pending more than a day after it was due: the red banner on Grants. */
export function overdueGrants(grants: AccessGrantView[], now: number = Date.now()): AccessGrantView[] {
  return grants.filter((grant) => grant.status === 'revoke_failed' && grant.until && now - Date.parse(grant.until) > 24 * 3_600_000);
}

export const ACCESS_PATH = '/access';
/** Fired on the window when access requests were just set up, so the sidebar fetches the setup again. */
export const ACCESS_SETUP_EVENT = 'landflow:access-setup';

/** A link to a tab of the page, optionally to one request. */
export const accessHref = (tab: AccessTabId, requestId?: string) => `${ACCESS_PATH}?tab=${tab}${requestId ? `&request=${requestId}` : ''}`;

export interface AccessAccounts {
  github?: string;
  google?: string;
}
export interface EntryDraft {
  /** C36: people without a Landflow account may ask for it (admins only). */
  outsideMayAsk?: boolean;
  name: string;
  description: string;
  system: AccessSystem;
  target: Record<string, string>;
  credentialId: string;
  durations: Array<number | null>;
  approverIds: string[];
  owners: string[];
  eligibleUserIds: string[];
  enabled: boolean;
}
export interface Person2 {
  id: string;
  name: string;
}

/**
 * What the Ask, My requests, Grants and Chat components call. The Access page uses `accessApi` (`/api/access`); the public request page
 * passes `outsideApi` (`/request-access/api`, lib/client/access-outside.ts) through `AccessClientProvider`, so one set of components
 * serves both. Fields a client's views lack (approver names, holders) simply hide.
 */
export interface AccessClient {
  /** `outside`: a requester without a Landflow account; the words and links change, never the rules. */
  kind: 'user' | 'outside';
  requests(scope: 'mine'): Promise<{ items: AccessRequestView[] }>;
  ask(input: { entryId: string; durationMinutes: number | null; reason: string; account?: string }): Promise<AccessRequestView>;
  cancel(id: string): Promise<unknown>;
  grants(scope: 'mine' | 'all'): Promise<{ items: AccessGrantView[] }>;
  /** `revoke` is "Give it back" for an outside requester. */
  grantAction(id: string, action: 'revoke' | 'done' | 'retry'): Promise<unknown>;
  accounts(): Promise<AccessAccounts>;
  saveGithub(github: string): Promise<unknown>;
  chat(message: string, sessionId: string): Promise<{ reply: string; requestId?: string }>;
  /** A link to a tab of the client's own page, optionally to one request. */
  hrefFor(tab: AccessTabId, requestId?: string): string;
}

export const accessApi = {
  kind: 'user' as const,
  hrefFor: (tab: AccessTabId, requestId?: string) => accessHref(tab, requestId),
  setup: () => api<AccessSetup>('/api/access/setup', { background: true }),
  install: (input: { projectId?: string; modelCredentialId?: string }) => api<AccessSetup>('/api/access/setup', { method: 'POST', json: input }),
  entries: () => api<{ items: AccessEntryView[]; people?: Person2[] }>('/api/access/entries', { background: true }),
  createEntry: (draft: EntryDraft) => api<AccessEntryView>('/api/access/entries', { method: 'POST', json: entryBody(draft) }),
  saveEntry: (id: string, version: number, draft: EntryDraft, admin: boolean) => api<AccessEntryView>(`/api/access/entries/${id}`, { method: 'PATCH', json: { version, ...entryBody(draft, admin) } }),
  deleteEntry: (id: string) => api<void>(`/api/access/entries/${id}`, { method: 'DELETE' }),
  requests: (scope: 'mine' | 'decide' | 'all') => api<{ items: AccessRequestView[]; setup: AccessSetup }>(`/api/access/requests?scope=${scope}&limit=100`, { background: true }),
  ask: (input: { entryId: string; durationMinutes: number | null; reason: string; account?: string }) => api<AccessRequestView>('/api/access/requests', { method: 'POST', json: input }),
  cancel: (id: string) => api<AccessRequestView>(`/api/access/requests/${id}/cancel`, { method: 'POST' }),
  decide: (id: string, body: { approved: boolean; choice?: string; comment?: string }) => api<AccessRequestView>(`/api/access/requests/${id}/decision`, { method: 'POST', json: body }),
  grants: (scope: 'mine' | 'all') => api<{ items: AccessGrantView[] }>(`/api/access/grants?scope=${scope}&limit=100`, { background: true }),
  grantAction: (id: string, action: 'revoke' | 'done' | 'retry') => api<AccessGrantView>(`/api/access/grants/${id}/${action}`, { method: 'POST' }),
  accounts: () => api<AccessAccounts>('/api/access/accounts', { background: true }),
  saveGithub: (github: string) => api<AccessAccounts>('/api/access/accounts', { method: 'PUT', json: { github } }),
  chat: (message: string, sessionId: string) => api<{ reply: string; requestId?: string }>('/api/access/chat', { method: 'POST', json: { message, sessionId } }),
};

/** The body of a create or save: an owner who isn't an admin sends only what the server lets them change. */
function entryBody(draft: EntryDraft, admin = true) {
  const common = {
    name: draft.name.trim(),
    description: draft.description.trim(),
    durations: draft.durations,
    approverIds: draft.approverIds,
    owners: draft.owners,
    eligibleUserIds: draft.eligibleUserIds,
    enabled: draft.enabled,
  };
  if (!admin) return common;
  return { ...common, outsideMayAsk: Boolean(draft.outsideMayAsk), system: draft.system, target: draft.target, credentialId: draft.credentialId || null };
}

/** The entry a sheet opens with. */
export function draftOf(entry?: AccessEntryView): EntryDraft {
  if (!entry) return { name: '', description: '', system: 'github-team', target: {}, credentialId: '', durations: [60, 240], approverIds: [], owners: [], eligibleUserIds: [], enabled: true };
  return {
    name: entry.name,
    description: entry.description ?? '',
    system: entry.system,
    target: { ...entry.target.config },
    credentialId: entry.credentialId ?? '',
    durations: [...entry.durations],
    approverIds: entry.steps.flatMap((step) => step.approvers.userIds),
    owners: [...entry.owners],
    eligibleUserIds: [...entry.eligibleUserIds],
    enabled: entry.enabled,
    outsideMayAsk: Boolean((entry as CatalogEntry).outsideMayAsk),
  };
}

/** Loads one thing the page shows; `reload` fetches again (after an action). A failure shows as `error`. */
export function useLoaded<T>(load: () => Promise<T>, deps: unknown[] = []) {
  const [state, setState] = useState<{ data?: T; error?: string }>({});
  const reload = useCallback(async () => {
    try {
      setState({ data: await load() });
    } catch (e) {
      setState((s) => ({ ...s, error: (e as Error).message }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { ...state, reload };
}

const ClientContext = createContext<AccessClient>(accessApi);
/** The client the shared Access components call: `accessApi` unless a page provides another. */
export const useAccessClient = (): AccessClient => useContext(ClientContext);
export function AccessClientProvider({ client, children }: { client: AccessClient; children: ReactNode }) {
  return createElement(ClientContext.Provider, { value: client }, children);
}

/** A person on a request or grant: a Landflow user, or (C36) an outside requester with the address and how it was verified. */
export function requesterInfo(person: { id: string; name: string; kind?: string; email?: string; verifiedBy?: VerifiedBy } | undefined): { outside: boolean; email?: string; verifiedBy?: VerifiedBy; verifiedText?: string } {
  const p = person;
  if (p?.kind !== 'outside') return { outside: false };
  const verifiedText = p.verifiedBy === 'google' ? 'verified by Google sign-in' : p.verifiedBy === 'link' ? 'verified by email link' : undefined;
  return { outside: true, ...(p.email && { email: p.email }), ...(p.verifiedBy && { verifiedBy: p.verifiedBy }), ...(verifiedText && { verifiedText }) };
}

/** Access → Settings (C36): who without a Landflow account may ask, and the requesters who signed in. */
export interface OutsideSettingsView {
  enabled: boolean;
  domains: string[];
  google: { enabled: boolean; credentialId?: string; credentialName?: string };
  /** The page's address: the server's `pageUrl` (from the public URL), else the browser builds it from its own origin. */
  link?: string;
  pageUrl?: string;
  /** The address to register with Google as the redirect URI. */
  redirectUrl?: string;
  /** The host can send the sign-in link. */
  mail?: boolean;
}
export interface OutsideRequesterRow {
  id: string;
  email: string;
  name?: string | null;
  verifiedBy: VerifiedBy;
  createdAt: string;
  lastSeenAt?: string | null;
  openRequests: number;
  liveGrants: number;
  blocked: boolean;
}

/** An organization's own domains only: no wildcards, no public mail domains (the server refuses them too). */
const PUBLIC_MAIL = new Set(['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'yahoo.com', 'icloud.com', 'aol.com', 'proton.me', 'protonmail.com']);
export function normalizeDomain(text: string): string | undefined {
  const value = text.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^@/, '').replace(/\/+$/, '');
  if (!/^(?=.{3,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(value)) return undefined;
  return PUBLIC_MAIL.has(value) ? undefined : value;
}

/** On needs a domain; Google on needs its credential. */
export function canSwitchOutsideOn(draft: Pick<OutsideSettingsView, 'domains' | 'google'>): boolean {
  return draft.domains.length > 0 && (!draft.google.enabled || Boolean(draft.google.credentialId));
}

/** The credentials the Google picker offers: OpenID Connect clients only. */
export const oidcCredentials = (credentials: CredentialSummary[]): CredentialSummary[] => credentials.filter((c) => c.type === 'oidcClient' || c.type.endsWith('.oidcClient'));

/** The server names the page's address `pageUrl`; the form calls it `link`. */
const withLink = (settings: OutsideSettingsView): OutsideSettingsView => ({ ...settings, link: settings.pageUrl ?? settings.link });

export const outsideAdminApi = {
  settings: async () => withLink(await api<OutsideSettingsView>('/api/access/outside', { background: true })),
  // Only the fields the server takes: its google object is strict, so the credential's name is never sent back.
  saveSettings: async (settings: OutsideSettingsView) =>
    withLink(await api<OutsideSettingsView>('/api/access/outside', { method: 'PUT', json: { enabled: settings.enabled, domains: settings.domains, google: { enabled: settings.google.enabled, credentialId: settings.google.credentialId ?? null } } })),
  /** The server answers `{ requesters }`. */
  requesters: async (): Promise<{ items: OutsideRequesterRow[] }> => ({ items: (await api<{ requesters: OutsideRequesterRow[] }>('/api/access/outside/requesters', { background: true })).requesters }),
  block: (id: string) => api<unknown>(`/api/access/outside/requesters/${id}/block`, { method: 'POST' }),
  unblock: (id: string) => api<unknown>(`/api/access/outside/requesters/${id}/unblock`, { method: 'POST' }),
};
