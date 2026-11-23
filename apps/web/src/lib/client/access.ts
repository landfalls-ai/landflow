'use client';
/**
 * The Access page's client side (docs/access-requests.md#the-access-page): the calls to /api/access, and the plain functions the
 * page's rules are made of (which tabs a person gets, the words for each state, whether Ask is ready, what an approver may allow),
 * so a test reads them without a browser.
 */
import { useCallback, useEffect, useState } from 'react';
import type { Viewer } from '@/lib/shared/auth';
import {
  type AccessEntryView,
  type AccessGrantView,
  type AccessRequestView,
  type AccessSetup,
  type AccessState,
  type AccessSystem,
  ACCESS_LIMITS,
} from '@/lib/shared/access';
import { api, ApiError } from './api';

type Person = Pick<Viewer, 'id' | 'role'>;

export type AccessTabId = 'ask' | 'mine' | 'decide' | 'grants' | 'catalog';
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
export function accessTabs(input: { setup: AccessSetup | undefined; viewer: Person; entries: AccessEntryView[]; toDecide: number }): AccessTab[] {
  if (!input.setup?.installed) return [];
  const tabs: AccessTab[] = [
    { id: 'ask', label: 'Ask' },
    { id: 'mine', label: 'My requests' },
  ];
  if (isApprover(input.viewer, input.entries)) tabs.push({ id: 'decide', label: 'To decide', count: input.toDecide });
  tabs.push({ id: 'grants', label: 'Grants' });
  if (isAdminViewer(input.viewer) || input.entries.some((entry) => entry.canEdit)) tabs.push({ id: 'catalog', label: 'Catalog' });
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

/** Whether Ask is ready: an entry, one of its durations, a reason of 3 characters or more and, for GitHub, the username. */
export function canAsk(input: { entry: AccessEntryView | undefined; durationMinutes: number | null | undefined; reason: string; account: string }): boolean {
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

export const accessApi = {
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
  return { ...common, system: draft.system, target: draft.target, credentialId: draft.credentialId || null };
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
