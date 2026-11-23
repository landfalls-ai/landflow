/**
 * The Access page (C35-C2): the tabs each person gets, the state words, the form, My requests, To decide, Grants, the catalog sheet
 * and the chat panel, as static markup with made-up data (no fetch, no browser), plus the pure helpers in lib/client/access.ts.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { AccessEntryView, AccessGrantView, AccessRequestView, AccessSetup, AccessState } from '../src/lib/shared/access';
import { ApiError } from '../src/lib/client/api';
import { SYSTEMS } from '../src/lib/server/access/systems';
import { accessTabs, canAsk, overdueGrants, requestProblem, showAccessInRail, STATE_WORDS, SYSTEM_FORM } from '../src/lib/client/access';
import { RAIL_ITEMS } from '../src/components/shell/section-nav';
import { AccessFrame } from '../src/components/access/access-page';
import { StateBadge } from '../src/components/access/state-badge';
import { AskForm, AskProblem } from '../src/components/access/ask-form';
import { RequestRows } from '../src/components/access/my-requests';
import { GrantCards, GrantsGrid, OverdueBanner } from '../src/components/access/grants-grid';
import { EntryFields } from '../src/components/access/entry-sheet';
import { CatalogGrid } from '../src/components/access/catalog-grid';
import { AccessChat } from '../src/components/access/access-chat';
import { DecideList } from '../src/components/access/to-decide';

vi.mock('next/link', () => ({ default: (p: { href: string; children: unknown; className?: string }) => createElement('a', { href: p.href, className: p.className }, p.children as never) }));

const setupDone: AccessSetup = { installed: true, active: true, workflowId: 'w1', chatWorkflowId: 'w2', projectId: 'p1', mail: false, flowsAdminOnly: true, lockedWorkflowIds: [] };
const member = { id: 'u2', role: 'member' as const };
const owner = { id: 'u1', role: 'owner' as const };

const entry = (over: Partial<AccessEntryView> = {}): AccessEntryView => ({
  id: 'e1',
  name: 'Platform team',
  description: 'The platform repos',
  system: 'github-team',
  target: { key: 'acme/platform', type: 'github-team', label: 'acme/platform', config: { org: 'acme', team: 'platform' } },
  durations: [1, 60, 240, null],
  steps: [{ name: 'Approver', approvers: { userIds: ['u1'] }, approvalsRequired: 1 }],
  approverNames: ['Ada Owner'],
  owners: ['u1'],
  eligibleUserIds: [],
  enabled: true,
  canEdit: false,
  version: 3,
  ...over,
});
const google = entry({ id: 'e2', name: 'Eng group', system: 'google-group', target: { key: 'eng@x.io', type: 'google-group', label: 'eng@x.io', config: { groupKey: 'eng@x.io' } } });

const Q = { title: 'Give Mia Member Platform team for 1 h?', text: 'Mia Member asks for Platform team\nWhat: GitHub team acme/platform (member)\nFor: 1 h\nAccount: mia-gh (unverified: typed by the requester)\n--- the requester wrote:\n“On call this week”' };
const request = (over: Partial<AccessRequestView> = {}): AccessRequestView => ({
  id: 'r1',
  entryId: 'e1',
  entryName: 'Platform team',
  system: 'github-team',
  requester: { id: 'u2', name: 'Mia Member' },
  account: 'mia-gh',
  durationMinutes: 240,
  reason: 'On call this week',
  channel: 'form',
  status: 'pending',
  decisions: [],
  approverNames: ['Ada Owner'],
  canDecide: false,
  canCancel: true,
  createdAt: '2026-11-23T10:00:00Z',
  ...over,
});
const grant = (over: Partial<AccessGrantView> = {}): AccessGrantView => ({
  id: 'g1',
  requestId: 'r1',
  entryId: 'e1',
  entryName: 'Platform team',
  holder: { id: 'u2', name: 'Mia Member' },
  account: 'mia-gh',
  system: 'github-team',
  targetLabel: 'acme/platform',
  status: 'active',
  since: '2026-11-23T10:05:00Z',
  until: '2026-11-23T11:05:00Z',
  approvedBy: 'Ada Owner',
  alreadyHad: false,
  canRevoke: false,
  canMarkDone: false,
  canRetry: false,
  ...over,
});
const html = (node: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(node);

describe('the tabs each person gets (U-1)', () => {
  it('a member sees Ask, My requests and Grants; nothing else', () => {
    const tabs = accessTabs({ setup: setupDone, viewer: member, entries: [entry()], toDecide: 0 });
    expect(tabs.map((t) => t.label)).toEqual(['Ask', 'My requests', 'Grants']);
  });
  it('an approver also gets To decide with its count', () => {
    const tabs = accessTabs({ setup: setupDone, viewer: { id: 'u1', role: 'member' }, entries: [entry()], toDecide: 2 });
    expect(tabs.map((t) => [t.label, t.count])).toEqual([['Ask', undefined], ['My requests', undefined], ['To decide', 2], ['Grants', undefined]]);
  });
  it('owners of an entry and admins get the Catalog', () => {
    expect(accessTabs({ setup: setupDone, viewer: member, entries: [entry({ canEdit: true })], toDecide: 0 }).map((t) => t.label)).toContain('Catalog');
    expect(accessTabs({ setup: setupDone, viewer: owner, entries: [], toDecide: 0 }).map((t) => t.label)).toEqual(['Ask', 'My requests', 'To decide', 'Grants', 'Catalog']);
  });
  it('before setup there are no tabs', () => {
    expect(accessTabs({ setup: { ...setupDone, installed: false, active: false }, viewer: owner, entries: [], toDecide: 0 })).toEqual([]);
  });
  it('the rail shows Access once set up, and to admins always', () => {
    expect(showAccessInRail(member, { ...setupDone, installed: false })).toBe(false);
    expect(showAccessInRail(owner, { ...setupDone, installed: false })).toBe(true);
    expect(showAccessInRail(member, setupDone)).toBe(true);
    expect(showAccessInRail(member, undefined)).toBe(false);
    // The rail's nine places stay nine: Access is added by the sidebar, not by RAIL_ITEMS.
    expect(RAIL_ITEMS).toHaveLength(9);
  });
});

describe('the page shell (U-1)', () => {
  it('before setup a member is told to ask an admin', () => {
    const out = html(createElement(AccessFrame, { viewer: member, setup: { ...setupDone, installed: false, active: false }, tabs: [], tab: 'ask', onTab: () => {}, children: 'BODY' }));
    expect(out).toContain('Access requests aren&#x27;t set up yet. Ask an admin.');
    expect(out).not.toContain('BODY');
    expect(out).not.toContain('Set up access requests');
  });
  it('before setup an admin sees the setup card', () => {
    const out = html(createElement(AccessFrame, { viewer: owner, setup: { ...setupDone, installed: false, active: false }, tabs: [], tab: 'ask', onTab: () => {}, children: 'BODY' }));
    expect(out).toContain('Set up access requests');
    expect(out).not.toContain('BODY');
  });
  it('after setup the tabs and the body show, the count beside To decide', () => {
    const tabs = accessTabs({ setup: setupDone, viewer: owner, entries: [], toDecide: 2 });
    const out = html(createElement(AccessFrame, { viewer: owner, setup: setupDone, tabs, tab: 'ask', onTab: () => {}, children: 'BODY' }));
    for (const label of ['Ask', 'My requests', 'To decide', 'Grants', 'Catalog']) expect(out).toContain(label);
    expect(out).toContain('BODY');
    expect(out).toMatch(/To decide[^]*?>2</);
  });
  it('every state has its word', () => {
    const states: AccessState[] = ['waiting', 'approved', 'granted', 'denied', 'expired', 'failed', 'cancelled', 'removed'];
    for (const state of states) {
      expect(STATE_WORDS[state]).toBeTruthy();
      expect(html(createElement(StateBadge, { state }))).toContain(STATE_WORDS[state]);
    }
    expect(Object.keys(STATE_WORDS).sort()).toEqual([...states].sort());
  });
});

describe('Ask: the form (U-2)', () => {
  const form = (entries: AccessEntryView[], over: Record<string, unknown> = {}) => html(createElement(AskForm, { entries, savedGithub: 'mia-gh', email: 'mia@x.io', onAsked: () => {}, ...over }));
  it('an entry shows its durations as chips, who approves, and the GitHub username filled from the saved one', () => {
    const out = form([entry(), google], { initialEntryId: 'e1' });
    for (const text of ['1 min', '1 h', '4 h', 'unlimited']) expect(out).toContain(text);
    expect(out).toContain('Ada Owner');
    expect(out).toContain('GitHub username');
    expect(out).toContain('value="mia-gh"');
  });
  it('a Google entry has no username field and says it goes to the person’s email', () => {
    const out = form([entry(), google], { initialEntryId: 'e2' });
    expect(out).not.toContain('GitHub username');
    expect(out).toContain('mia@x.io');
  });
  it('Ask is disabled without a reason of 3 characters', () => {
    expect(form([entry()], { initialEntryId: 'e1' })).toMatch(/<button[^>]*disabled[^>]*>[^<]*(<[^>]*>)*\s*Ask/);
    const e = entry();
    expect(canAsk({ entry: e, durationMinutes: 60, reason: 'ab', account: 'x' })).toBe(false);
    expect(canAsk({ entry: e, durationMinutes: 60, reason: 'abc', account: 'x' })).toBe(true);
    expect(canAsk({ entry: e, durationMinutes: 60, reason: 'abc', account: ' ' })).toBe(false);
    expect(canAsk({ entry: google, durationMinutes: 60, reason: 'abc', account: '' })).toBe(true);
    expect(canAsk({ entry: e, durationMinutes: undefined, reason: 'abc', account: 'x' })).toBe(false);
    expect(canAsk({ entry: undefined, durationMinutes: 60, reason: 'abc', account: 'x' })).toBe(false);
  });
  it('a 409 shows its sentence and links the open request', () => {
    const problem = requestProblem(new ApiError('You already have an open request for this.', 409, { existingId: 'r9' }));
    expect(problem).toEqual({ message: 'You already have an open request for this.', existingId: 'r9' });
    const out = html(createElement(AskProblem, { problem }));
    expect(out).toContain('You already have an open request for this.');
    expect(out).toContain('href="/access?tab=mine&amp;request=r9"');
    expect(html(createElement(AskProblem, { problem: { message: 'Nope' } }))).not.toContain('href');
  });
  it('with no entry yet it says so', () => {
    expect(form([])).toContain('Nothing to ask for yet');
  });
});

describe('My requests (U-2)', () => {
  const rows = (requests: AccessRequestView[]) => html(createElement(RequestRows, { requests, viewerId: 'u2', onCancel: () => {}, onGiveBack: () => {} }));
  it('shows the state word and Cancel while waiting', () => {
    const out = rows([request()]);
    expect(out).toContain('Waiting');
    expect(out).toContain('Cancel');
    expect(out).toContain('Ada Owner');
  });
  it('shows the reason of a denial and of a failure', () => {
    const denied = rows([request({ status: 'denied', canCancel: false, note: 'Not this quarter', decisions: [{ step: 1, outcome: 'deny', by: 'u1', byName: 'Ada Owner', comment: 'Not this quarter', channel: 'session', at: '2026-11-23T10:10:00Z' }] })]);
    expect(denied).toContain('Denied');
    expect(denied).toContain('Not this quarter');
    expect(denied).not.toContain('Cancel');
    const failed = rows([request({ status: 'failed', canCancel: false, note: 'GitHub says no such team' })]);
    expect(failed).toContain('Failed');
    expect(failed).toContain('GitHub says no such team');
  });
  it('a live grant says granted until, with Give it back', () => {
    const out = rows([request({ status: 'approved', canCancel: false, approvedMinutes: 60, grant: grant({ canRevoke: true }) })]);
    expect(out).toContain('Granted');
    expect(out).toContain('Give it back');
    expect(out).not.toContain('Cancel');
  });
  it('an unlimited grant reads unlimited and an empty list says so', () => {
    expect(rows([request({ status: 'approved', canCancel: false, grant: grant({ until: null }) })])).toContain('no end');
    expect(rows([])).toContain('No requests yet');
  });
});

describe('Grants (U-4)', () => {
  const grid = (grants: AccessGrantView[]) => html(createElement(GrantsGrid, { grants, onAct: () => {} }));
  it('Revoke now, Done and Retry show only where the view says so', () => {
    const none = grid([grant()]);
    expect(none).not.toContain('Revoke now');
    expect(none).not.toContain('Done');
    expect(none).not.toContain('Retry');
    const all = grid([grant({ canRevoke: true }), grant({ id: 'g2', status: 'pending', system: 'manual', canMarkDone: true }), grant({ id: 'g3', status: 'failed', canRetry: true })]);
    expect(all).toContain('Revoke now');
    expect(all).toContain('Done');
    expect(all).toContain('Retry');
  });
  it('the phone cards follow the same rules', () => {
    const out = html(createElement(GrantCards, { grants: [grant({ canRevoke: true }), grant({ id: 'g2' })], onAct: () => {} }));
    expect(out.match(/Revoke now/g)).toHaveLength(1);
  });
  it('shows who, what, account and status', () => {
    const out = grid([grant()]);
    for (const text of ['Mia Member', 'acme/platform', 'mia-gh', 'Ada Owner']) expect(out).toContain(text);
  });
  it('the overdue banner shows for a removal that failed more than a day ago', () => {
    const now = Date.parse('2026-11-25T12:00:00Z');
    const late = grant({ status: 'revoke_failed', until: '2026-11-24T10:00:00Z', lastError: 'GitHub is down' });
    const fresh = grant({ id: 'g2', status: 'revoke_failed', until: '2026-11-25T11:00:00Z' });
    expect(overdueGrants([late, fresh, grant({ id: 'g3' })], now).map((g) => g.id)).toEqual(['g1']);
    expect(html(createElement(OverdueBanner, { grants: [late], now }))).toContain('could not be removed');
    expect(html(createElement(OverdueBanner, { grants: [fresh], now }))).toBe('');
  });
});

describe('the catalog (U-4)', () => {
  it('lists entries with their system and durations, and offers New entry only to admins', () => {
    const e = entry({ canEdit: true });
    const admin = html(createElement(CatalogGrid, { entries: [e], isAdmin: true, onOpen: () => {}, onNew: () => {} }));
    expect(admin).toContain('Platform team');
    expect(admin).toContain('GitHub team');
    expect(admin).toContain('New entry');
    expect(html(createElement(CatalogGrid, { entries: [e], isAdmin: false, onOpen: () => {}, onNew: () => {} }))).not.toContain('New entry');
  });
  const people = [{ id: 'u1', name: 'Ada Owner' }, { id: 'u2', name: 'Mia Member' }];
  const fields = (over: Record<string, unknown>) =>
    html(createElement(EntryFields, { draft: { name: 'Platform team', description: '', system: 'github-team', target: { org: 'acme', team: 'platform' }, credentialId: '', durations: [60, null], approverIds: ['u1'], owners: ['u1'], eligibleUserIds: [], enabled: true }, people, credentials: [], isAdmin: true, canEdit: true, onChange: () => {}, onCreateCredential: () => {}, ...over }));
  it('shows the chosen system’s target fields, durations as editable chips, approvers and owners', () => {
    const out = fields({});
    for (const text of ['Organization', 'Team slug', 'Credential', 'Approvers', 'Owners', '1 h', 'unlimited']) expect(out).toContain(text);
    expect(out).not.toContain('Group email');
    const g = fields({ draft: { name: 'Eng', description: '', system: 'google-group', target: { groupKey: 'eng@x.io' }, credentialId: '', durations: [60], approverIds: ['u1'], owners: ['u1'], eligibleUserIds: [], enabled: true } });
    expect(g).toContain('Group email');
    expect(g).not.toContain('Team slug');
  });
  it('an owner who isn’t an admin is offered nothing longer than the entry already has, and no end only if it has one', () => {
    const draft = { name: 'Platform team', description: '', system: 'github-team', target: { org: 'acme', team: 'platform' }, credentialId: '', durations: [60], approverIds: ['u1'], owners: ['u1'], eligibleUserIds: [], enabled: true };
    const owner = fields({ draft, isAdmin: false, canEdit: true, saved: [60] });
    expect(owner).toContain('Add duration');
    expect(owner).not.toMatch(/<option[^>]*value="unlimited"/);
    expect(owner).not.toMatch(/<option[^>]*value="240"/);
    expect(owner).toMatch(/<option[^>]*value="15"/);
    expect(fields({ draft, isAdmin: true, canEdit: true, saved: [60] })).toMatch(/<option[^>]*value="unlimited"/);
    expect(fields({ draft: { ...draft, durations: [60, null] }, isAdmin: false, canEdit: true, saved: [60, null] })).toMatch(/<option[^>]*value="240"/);
  });
  it('a viewer who can’t edit sees read-only fields', () => {
    const out = fields({ canEdit: false, isAdmin: false });
    expect(out).toContain('disabled');
    expect(out).not.toContain('Add duration');
  });
  it('an owner who is not an admin may change who approves but not the target or credential', () => {
    const out = fields({ isAdmin: false });
    expect(out).toMatch(/aria-label="Organization"[^>]*disabled|disabled[^>]*aria-label="Organization"/);
    expect(out).toContain('Add duration');
  });
});

describe('the client’s system table follows the server’s (U-4)', () => {
  it('has the same systems, labels, fields and credential types', () => {
    expect(Object.keys(SYSTEM_FORM).sort()).toEqual(Object.keys(SYSTEMS).sort());
    for (const [system, spec] of Object.entries(SYSTEMS)) {
      const client = SYSTEM_FORM[system as keyof typeof SYSTEM_FORM];
      expect(client.label).toBe(spec.label);
      expect(client.account).toBe(spec.account);
      expect(client.credentialTypes).toEqual(spec.credentialTypes);
      expect(client.fields.map((f) => [f.name, f.required])).toEqual(spec.fields.map((f) => [f.name, f.required]));
    }
  });
});

describe('To decide (U-3)', () => {
  it('lists only what the viewer may decide, as the confirm card', () => {
    const out = html(createElement(DecideList, { requests: [request({ canDecide: true, question: Q, choices: [{ value: '60', label: '1 h' }, { value: '1', label: '1 min' }] }), request({ id: 'r2', canDecide: false })], onDecided: () => {} }));
    expect(out.match(/data-testid="confirm-card"/g)).toHaveLength(1);
    expect(out).toContain('Mia Member');
    expect(out).toContain('On call this week');
    expect(out).toContain('mia-gh');
    expect(html(createElement(DecideList, { requests: [], onDecided: () => {} }))).toContain('Nothing waits for you');
  });
  it('shows the server-built question (the target and the unverified account) and the server choices', () => {
    const out = html(createElement(DecideList, { requests: [request({ canDecide: true, question: Q, choices: [{ value: '60', label: '1 h' }, { value: '1', label: '1 min' }] })], onDecided: () => {} }));
    expect(out).toContain('What: GitHub team acme/platform (member)');
    expect(out).toContain('mia-gh (unverified: typed by the requester)');
    expect(out).toContain('1 min');
  });
  it('a failed grant shows Retry on My requests', () => {
    const out = html(createElement(RequestRows, { requests: [request({ status: 'approved', canCancel: false, grant: grant({ status: 'failed', canRetry: true }) })], viewerId: 'u2', onCancel: () => {}, onGiveBack: () => {}, onRetry: () => {} }));
    expect(out).toContain('Retry');
  });
});

describe('the chat panel (U-5)', () => {
  it('says what it can do, and nothing more', () => {
    const out = html(createElement(AccessChat, { available: true }));
    expect(out).toContain('It can only file a request; an approver decides');
  });
  it('without a chat flow it says to ask an admin to connect a model', () => {
    const out = html(createElement(AccessChat, { available: false }));
    expect(out).toContain('Ask an admin to connect a model for the chat');
  });
});

describe('words (review fixes)', () => {
  it('says "with no end" in a sentence, and an expired grant is Expired, not Removed', async () => {
    const { forDuration, requestState } = await import('../src/lib/shared/access');
    expect(forDuration(null)).toBe('with no end');
    expect(forDuration(60)).toBe('for 1 h');
    expect(requestState({ status: 'approved', grant: { status: 'expired' } })).toBe('expired');
    expect(requestState({ status: 'approved', grant: { status: 'revoked' } })).toBe('removed');
    expect(STATE_WORDS.expired).toBe('Expired');
  });
});
