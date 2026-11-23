/**
 * C36-C: the public /request-access page and the admin side of outside requesters (docs/access-requests.md#the-request-page).
 * Static renders with made-up data and a mocked fetch, no browser and no server: the client seam (`AccessClient`), the page's
 * states, the Settings tab, the entry flag, the badges, and a guard that the public page imports nothing of the app shell or the
 * admin components. The routes are A's and B's (plan.md "Public routes", "Admin routes"); the shapes are coded against that table.
 */
import { createElement } from 'react';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AccessEntryView, AccessGrantView, AccessRequestView, AccessSetup } from '../src/lib/shared/access';
import type { CredentialSummary } from '../src/lib/shared/types';
import { accessApi, accessTabs, AccessClientProvider, canSwitchOutsideOn, normalizeDomain, oidcCredentials, requesterInfo } from '../src/lib/client/access';
import { OUTSIDE_SESSION_ENDED, outsideApi } from '../src/lib/client/access-outside';
import { AskForm, AskProblem } from '../src/components/access/ask-form';
import { RequestRows } from '../src/components/access/my-requests';
import { GrantCards } from '../src/components/access/grants-grid';
import { AccessChat } from '../src/components/access/access-chat';
import { CatalogGrid } from '../src/components/access/catalog-grid';
import { EntryFields } from '../src/components/access/entry-sheet';
import { DecideList } from '../src/components/access/to-decide';
import { OutsideSettingsForm } from '../src/components/access/outside-settings';
import { OutsideFrame } from '../src/components/access/outside/outside-frame';
import { SignInCard } from '../src/components/access/outside/sign-in-card';
import { VerifyCard } from '../src/components/access/outside/verify-card';
import { OutsideView, errorSentence, tokenFromHash } from '../src/components/access/outside/outside-page';

vi.mock('next/link', () => ({ default: (p: { href: string; children: unknown; className?: string }) => createElement('a', { href: p.href, className: p.className }, p.children as never) }));

const html = (node: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(node);
const asOutside = (node: React.ReactElement) => createElement(AccessClientProvider, { client: outsideApi }, node);

const setupDone: AccessSetup = { installed: true, active: true, workflowId: 'w1', chatWorkflowId: 'w2', projectId: 'p1', mail: true, flowsAdminOnly: true, lockedWorkflowIds: [] };
const admin = { id: 'u1', role: 'owner' as const };
const member = { id: 'u2', role: 'member' as const };

const entry = (over: Partial<AccessEntryView> = {}): AccessEntryView => ({
  id: 'e1',
  name: 'Platform team',
  description: 'The platform repos',
  system: 'github-team',
  target: { key: 'acme/platform', type: 'github-team', label: 'acme/platform', config: { org: 'acme', team: 'platform' } },
  durations: [60, 240],
  steps: [{ name: 'Approver', approvers: { userIds: ['u1'] }, approvalsRequired: 1 }],
  approverNames: ['Ada Owner'],
  owners: ['u1'],
  eligibleUserIds: [],
  enabled: true,
  canEdit: true,
  version: 1,
  ...over,
});
/** What an outsider's entry list holds: no approvers, owners or credential (plan D-13). */
const openEntry = () => {
  const { approverNames: _a, owners: _o, steps: _s, eligibleUserIds: _e, ...rest } = entry({ canEdit: false });
  void _a, void _o, void _s, void _e;
  return rest as unknown as AccessEntryView;
};
const request = (over: Partial<AccessRequestView> = {}): AccessRequestView => ({
  id: 'r1',
  entryId: 'e1',
  entryName: 'Platform team',
  system: 'github-team',
  requester: { id: 'ext_a1', name: 'Erin' },
  account: 'erin-p',
  durationMinutes: 60,
  reason: 'On call',
  channel: 'form',
  status: 'pending',
  decisions: [],
  approverNames: [],
  canDecide: false,
  canCancel: true,
  createdAt: '2026-11-23T10:00:00Z',
  ...over,
});
const grant = (over: Partial<AccessGrantView> = {}): AccessGrantView => ({
  id: 'g1',
  entryId: 'e1',
  entryName: 'Platform team',
  holder: { id: 'ext_a1', name: 'Erin' },
  account: 'erin-p',
  system: 'github-team',
  targetLabel: 'acme/platform',
  status: 'active',
  until: '2026-11-23T11:05:00Z',
  alreadyHad: false,
  canRevoke: true,
  canMarkDone: false,
  canRetry: false,
  ...over,
});

const calls: Array<{ url: string; init?: RequestInit }> = [];
function mockFetch(answer: (url: string, init?: RequestInit) => { status?: number; body?: unknown } = () => ({ body: {} })) {
  calls.length = 0;
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const { status = 200, body } = answer(url, init);
    return new Response(body === undefined ? '' : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  });
}
afterEach(() => vi.unstubAllGlobals());

describe('the client seam (U-1)', () => {
  it('the default client calls /api/access as before', async () => {
    mockFetch();
    await accessApi.requests('mine');
    await accessApi.grants('mine');
    await accessApi.grantAction('g1', 'revoke');
    expect(calls.map((c) => c.url)).toEqual(['/api/access/requests?scope=mine&limit=100', '/api/access/grants?scope=mine&limit=100', '/api/access/grants/g1/revoke']);
    expect(accessApi.hrefFor('mine', 'r1')).toBe('/access?tab=mine&request=r1');
  });
  it('outsideApi calls /request-access/api, and "revoke" is "give back"', async () => {
    mockFetch(() => ({ body: { items: [] } }));
    await outsideApi.requests('mine');
    await outsideApi.grants('mine');
    await outsideApi.grantAction('g1', 'revoke');
    await outsideApi.cancel('r1');
    await outsideApi.ask({ entryId: 'e1', durationMinutes: 60, reason: 'On call', account: 'erin-p' });
    await outsideApi.chat('hello', 's1');
    await outsideApi.saveGithub('erin-p');
    await outsideApi.signOut();
    expect(calls.map((c) => `${c.init?.method ?? 'GET'} ${c.url}`)).toEqual([
      'GET /request-access/api/requests',
      'GET /request-access/api/grants',
      'POST /request-access/api/grants/g1/give-back',
      'POST /request-access/api/requests/r1/cancel',
      'POST /request-access/api/requests',
      'POST /request-access/api/chat',
      'PUT /request-access/api/account',
      'POST /request-access/api/sign-out',
    ]);
    expect(JSON.parse(String(calls[4].init?.body))).toEqual({ entryId: 'e1', durationMinutes: 60, reason: 'On call', account: 'erin-p', channel: 'form' });
    expect(outsideApi.hrefFor('mine', 'r1')).toBe('/request-access?tab=mine&request=r1');
  });
  it('outsideApi sends no Landflow header and never redirects to /login; a 401 announces the end of the session', async () => {
    const ended = vi.fn();
    vi.stubGlobal('window', { dispatchEvent: (e: Event) => ended(e.type), location: { pathname: '/request-access', search: '' } });
    mockFetch(() => ({ status: 401, body: { error: 'Sign in again', signIn: true } }));
    await expect(outsideApi.requests('mine')).rejects.toMatchObject({ status: 401 });
    expect(ended).toHaveBeenCalledWith(OUTSIDE_SESSION_ENDED);
    expect(Object.keys((calls[0].init?.headers ?? {}) as object)).not.toContain('x-landflow-background');
  });
  it('an outsider’s entries become askable entries; the GitHub need decides the form', async () => {
    mockFetch(() => ({ body: { items: [{ id: 'e1', name: 'Platform team', description: 'Repos', durations: [60, null], target: { label: 'acme/platform' }, needsGithub: true }, { id: 'e2', name: 'Eng group', durations: [60], targetLabel: 'eng@partner.test', needsGithub: false, system: 'google-group' }] } }));
    const { items } = await outsideApi.entries();
    expect(items.map((e) => [e.id, e.system, e.target.label, e.durations])).toEqual([['e1', 'github-team', 'acme/platform', [60, null]], ['e2', 'google-group', 'eng@partner.test', [60]]]);
    expect(items.every((e) => e.approverNames === undefined)).toBe(true);
  });
  it('the shared views read the client: links, the "who approves" line, the give-back label', () => {
    const problem = { message: 'You already have an open request for this.', existingId: 'r9' };
    expect(html(asOutside(createElement(AskProblem, { problem })))).toContain('href="/request-access?tab=mine&amp;request=r9"');
    expect(html(createElement(AskProblem, { problem }))).toContain('href="/access?tab=mine&amp;request=r9"');
    const form = (client: 'in' | 'out') => {
      const node = createElement(AskForm, { entries: [client === 'in' ? entry() : openEntry()], email: 'erin@partner.test', onAsked: () => {}, initialEntryId: 'e1' });
      return html(client === 'out' ? asOutside(node) : node);
    };
    expect(form('in')).toContain('Approved by Ada Owner');
    expect(form('out')).not.toContain('Approved by');
    expect(form('out')).not.toContain('Ada Owner');
    expect(form('out')).toContain('GitHub username');
    const rows = (client: 'in' | 'out') => {
      const node = createElement(RequestRows, { requests: [request({ status: 'approved', canCancel: false, approvedMinutes: 60, grant: grant() })], viewerId: client === 'in' ? 'u2' : undefined, onCancel: () => {}, onGiveBack: () => {} });
      return html(client === 'out' ? asOutside(node) : node);
    };
    expect(rows('out')).toContain('Give it back');
    expect(rows('out')).not.toContain('Erin');
  });
  it('a waiting request never names an approver for an outsider', () => {
    const out = html(asOutside(createElement(RequestRows, { requests: [request({ approverNames: undefined as unknown as string[] })], onCancel: () => {}, onGiveBack: () => {} })));
    expect(out).toContain('Waiting for an approver');
    expect(out).toContain('Cancel');
  });
  it('an outsider’s grants are cards that say Give it back, with no holder or approver columns', () => {
    const out = html(asOutside(createElement(GrantCards, { grants: [{ ...grant(), holder: undefined as unknown as AccessGrantView['holder'] }], onAct: () => {} })));
    expect(out).toContain('Give it back');
    expect(out).not.toContain('Revoke now');
    expect(out).toContain('erin-p');
  });
  it('the chat reads its client and is the same panel', () => {
    expect(html(asOutside(createElement(AccessChat, { available: true })))).toContain('It can only file a request; an approver decides');
  });
});

describe('the public page (U-2)', () => {
  const view = (over: Record<string, unknown> = {}) => html(createElement(OutsideView, { step: 'signed-out', config: { enabled: true, google: false, email: true }, ...over } as never));
  it('off: says asking is switched off and shows no form', () => {
    const out = view({ step: 'off' });
    expect(out).toContain('Asking here is switched off. Ask the person who sent you the link.');
    expect(out).not.toContain('<input');
  });
  it('signed out: the email form; Google only when configured; no catalog before sign-in', () => {
    const out = view();
    expect(out).toContain('Email me a link');
    expect(out).toContain('type="email"');
    expect(out).not.toContain('Sign in with Google');
    expect(view({ config: { enabled: true, google: true, email: true } })).toContain('Sign in with Google');
    expect(out).not.toContain('Platform team');
  });
  it('without mail the email form is gone and Google is the way in (or the page says so)', () => {
    const onlyGoogle = view({ config: { enabled: true, google: true, email: false } });
    expect(onlyGoogle).not.toContain('Email me a link');
    expect(onlyGoogle).toContain('Sign in with Google');
    expect(view({ config: { enabled: true, google: false, email: false } })).toContain('Asking by email isn&#x27;t available');
  });
  it('after sending: check your email, once, 15 minutes', () => {
    const out = view({ sent: 'erin@partner.test', onAnother: () => {} });
    expect(out).toContain('Check your email');
    expect(out).toContain('erin@partner.test');
    expect(out).toContain('15 minutes');
    expect(out).toContain('Use another address');
  });
  it('a #t= fragment waits for Continue, and Continue does nothing until pressed', () => {
    expect(tokenFromHash('#t=abc_DEF-123')).toBe('abc_DEF-123');
    expect(tokenFromHash('#x=1')).toBeUndefined();
    expect(tokenFromHash('')).toBeUndefined();
    const out = view({ step: 'verify' });
    expect(out).toContain('Continue');
    expect(out).toContain('Confirm that you want to sign in');
    mockFetch();
    expect(calls).toHaveLength(0);
    expect(html(createElement(VerifyCard, { busy: true, onContinue: () => {} }))).toContain('disabled');
    expect(html(createElement(VerifyCard, { error: 'This link has expired or was already used. Ask for a new one.', onContinue: () => {} }))).toContain('This link has expired or was already used. Ask for a new one.');
  });
  it('?error= codes say what to do, in plain words', () => {
    expect(errorSentence('domain')).toMatch(/work (email|account)/i);
    expect(errorSentence('not_verified')).toMatch(/verif/i);
    expect(errorSentence('landflow_user')).toContain('Landflow account');
    expect(errorSentence('expired')).toContain('expired');
    expect(errorSentence('nonsense')).toBeUndefined();
    expect(view({ notice: errorSentence('domain') })).toContain(errorSentence('domain')!.replace(/'/g, '&#x27;'));
  });
  it('a session that ended goes back to sign-in with its sentence', () => {
    expect(view({ notice: 'Your session ended. Sign in again.' })).toContain('Your session ended. Sign in again.');
  });
  it('signed in: the email, Sign out, and the tabs Ask, My requests, Grants (chat only when the session has it)', () => {
    const session = { requester: { email: 'erin@partner.test', name: 'Erin', verifiedBy: 'email' as const }, chat: true };
    const out = view({ step: 'signed-in', session, tab: 'ask', mode: 'form', onSignOut: () => {} });
    expect(out).toContain('erin@partner.test');
    expect(out).toContain('Sign out');
    for (const label of ['Ask', 'My requests', 'Grants', 'Form', 'Chat']) expect(out).toContain(label);
    const noChat = view({ step: 'signed-in', session: { ...session, chat: false }, tab: 'ask', mode: 'form' });
    expect(noChat).not.toContain('How to ask');
    expect(noChat).not.toMatch(/>Chat</);
    expect(out).not.toContain('Catalog');
    expect(out).not.toContain('To decide');
  });
  it('a signed-in Landflow user is pointed to Access', () => {
    const out = view({ landflowUser: true });
    expect(out).toContain('You have a Landflow account');
    expect(out).toContain('href="/access"');
    expect(view()).not.toContain('You have a Landflow account');
  });
  it('is branded, with a labelled email field and 44 px targets on a phone', () => {
    const out = html(createElement(SignInCard, { google: true, mail: true, onSubmit: () => {} }));
    expect(out).toContain('aria-label="Your work email"');
    expect(out).toMatch(/max-md:h-11/);
    expect(html(createElement(OutsideFrame, null, 'BODY'))).toContain('Landflow');
  });
  it('the frame carries sign-out only when signed in', () => {
    expect(html(createElement(OutsideFrame, null, 'BODY'))).not.toContain('Sign out');
    expect(html(createElement(OutsideFrame, { email: 'erin@partner.test', onSignOut: () => {} }, 'BODY'))).toContain('Sign out');
  });
});

describe('the page module stays out of the app (U-2)', () => {
  const src = resolve(__dirname, '../src');
  const resolveImport = (from: string, spec: string): string | undefined => {
    let base: string;
    if (spec.startsWith('@/')) base = join(src, spec.slice(2));
    else if (spec.startsWith('.')) base = resolve(dirname(from), spec);
    else return undefined;
    for (const candidate of [`${base}.tsx`, `${base}.ts`, join(base, 'index.tsx'), join(base, 'index.ts')]) if (existsSync(candidate)) return candidate;
    return undefined;
  };
  const graph = (entryFile: string): Set<string> => {
    const seen = new Set<string>();
    const walk = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/(?:import|export)\s+(?!type\s)[^'"]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|^import\s+['"]([^'"]+)['"]/gm)) {
        const next = resolveImport(file, m[1] ?? m[2] ?? m[3]);
        if (next) walk(next);
      }
    };
    walk(entryFile);
    return seen;
  };
  it('imports no admin component, no shell and no Spotlight', () => {
    const files = [...graph(join(src, 'app/request-access/page.tsx'))].map((f) => f.slice(src.length + 1));
    expect(files).toContain('components/access/outside/outside-page.tsx');
    expect(files).toContain('components/access/ask-form.tsx');
    const forbidden = files.filter((f) => /components\/access\/(catalog-grid|entry-sheet|to-decide|setup-card|outside-settings|access-page)\.tsx$/.test(f) || /components\/shell\//.test(f) || /components\/spotlight\//.test(f) || /components\/auth\/viewer/.test(f));
    // Only the page header's Card may come from the shell (a plain wrapper).
    expect(forbidden.filter((f) => f !== 'components/shell/page-header.tsx')).toEqual([]);
    // Types only come from the server: no server module is ever bundled into the public page.
    expect(files.filter((f) => f.startsWith('lib/server/'))).toEqual([]);
  });
  it('is noindex and reads nothing on the server', () => {
    const page = readFileSync(join(src, 'app/request-access/page.tsx'), 'utf8');
    expect(page).toMatch(/robots:\s*\{\s*index:\s*false/);
    expect(page).not.toMatch(/lib\/server/);
  });
});

describe('Settings, the flag and the badges for admins (U-3)', () => {
  it('admins get a Settings tab (when asked for), others never', () => {
    const base = { setup: setupDone, entries: [entry()], toDecide: 0 };
    expect(accessTabs({ ...base, viewer: admin, settings: true }).map((t) => t.label)).toEqual(['Ask', 'My requests', 'To decide', 'Grants', 'Catalog', 'Settings']);
    expect(accessTabs({ ...base, viewer: member, settings: false }).map((t) => t.label)).not.toContain('Settings');
    expect(accessTabs({ ...base, viewer: admin }).map((t) => t.label)).not.toContain('Settings');
  });
  it('the switch can’t go on without a domain; domains are cleaned', () => {
    expect(canSwitchOutsideOn({ domains: [], google: { enabled: false } })).toBe(false);
    expect(canSwitchOutsideOn({ domains: ['partner.test'], google: { enabled: false } })).toBe(true);
    expect(canSwitchOutsideOn({ domains: ['partner.test'], google: { enabled: true } })).toBe(false);
    expect(canSwitchOutsideOn({ domains: ['partner.test'], google: { enabled: true, credentialId: 'c1' } })).toBe(true);
    expect(normalizeDomain(' @Partner.TEST ')).toBe('partner.test');
    expect(normalizeDomain('https://partner.test/')).toBe('partner.test');
    expect(normalizeDomain('*.partner.test')).toBeUndefined();
    expect(normalizeDomain('gmail.com')).toBeUndefined();
    expect(normalizeDomain('not a domain')).toBeUndefined();
  });
  const creds: CredentialSummary[] = [
    { id: 'c1', name: 'Fake Google', type: 'oidcClient', createdAt: '', updatedAt: '', usedBy: [] },
    { id: 'c2', name: 'GitHub key', type: 'github.githubApi', createdAt: '', updatedAt: '', usedBy: [] },
  ];
  it('the Google credential picker lists oidcClient credentials only', () => {
    expect(oidcCredentials(creds).map((c) => c.id)).toEqual(['c1']);
  });
  const form = (over: Record<string, unknown> = {}) =>
    html(createElement(OutsideSettingsForm, { settings: { enabled: false, domains: [], google: { enabled: false }, link: 'http://localhost:3100/request-access' }, requesters: [], credentials: creds, mail: true, onChange: () => {}, onSave: () => {}, onBlock: () => {}, onUnblock: () => {}, ...over } as never));
  it('shows the switch, the link with Copy, and a mail warning without SMTP', () => {
    const out = form();
    expect(out).toContain('People without a Landflow account can ask');
    expect(out).toContain('http://localhost:3100/request-access');
    expect(out).toContain('Copy');
    expect(out).not.toContain("can't work");
    expect(form({ mail: false })).toMatch(/email link can(&#x27;|')t work/i);
  });
  it('the switch is disabled while there is no domain', () => {
    expect(form()).toMatch(/role="switch"[^>]*disabled=""/);
    expect(form({ settings: { enabled: false, domains: ['partner.test'], google: { enabled: false }, link: 'x' } })).not.toMatch(/role="switch"[^>]*disabled=""/);
  });
  it('lists domains as chips and the requesters with Block or Unblock', () => {
    const out = form({
      settings: { enabled: true, domains: ['partner.test'], google: { enabled: true, credentialId: 'c1' }, link: 'x' },
      requesters: [
        { id: 'ext_1', email: 'erin@partner.test', verifiedBy: 'email', createdAt: '2026-11-23T10:00:00Z', lastSeenAt: '2026-11-23T11:00:00Z', openRequests: 1, liveGrants: 2, blocked: false },
        { id: 'ext_2', email: 'mal@partner.test', verifiedBy: 'google', createdAt: '2026-11-23T10:00:00Z', openRequests: 0, liveGrants: 0, blocked: true },
      ],
    });
    expect(out).toContain('partner.test');
    expect(out).toContain('erin@partner.test');
    expect(out).toContain('Block');
    expect(out).toContain('Unblock');
    expect(out).toContain('Fake Google');
    expect(out).not.toContain('GitHub key');
  });
  it('without a requester it says so', () => {
    expect(form()).toContain('Nobody has signed in yet');
  });
  const draft = { name: 'Platform team', description: '', system: 'github-team' as const, target: { org: 'acme', team: 'platform' }, credentialId: '', durations: [60], approverIds: ['u1'], owners: ['u1'], eligibleUserIds: [], enabled: true, outsideMayAsk: false };
  const fields = (over: Record<string, unknown>) => html(createElement(EntryFields, { draft, people: [{ id: 'u1', name: 'Ada' }], credentials: [], isAdmin: true, canEdit: true, onChange: () => {}, onCreateCredential: () => {}, ...over }));
  it('the entry sheet’s flag is editable for admins and read-only for owners', () => {
    expect(fields({})).toContain('Outside requesters may ask');
    expect(fields({})).not.toMatch(/role="switch"[^>]*aria-label="Outside requesters may ask"[^>]*disabled=""/);
    const owner = fields({ isAdmin: false });
    expect(owner).toMatch(/aria-label="Outside requesters may ask"[^>]*disabled=""|disabled=""[^>]*aria-label="Outside requesters may ask"/);
    expect(owner).toContain('Outside requesters may ask');
    expect(owner).toContain('Only an admin changes this');
  });
  it('the catalog says "Open outside" on entries that are', () => {
    const open = entry({ outsideMayAsk: true } as Partial<AccessEntryView>);
    const out = html(createElement(CatalogGrid, { entries: [open, entry({ id: 'e2', name: 'Closed one' })], isAdmin: true, onOpen: () => {}, onNew: () => {} }));
    expect(out.match(/Open outside/g)).toHaveLength(1);
    expect(html(createElement(CatalogGrid, { entries: [open], isAdmin: true, phone: true, onOpen: () => {}, onNew: () => {} }))).toContain('Open outside');
  });
  const outsider = { id: 'ext_1', name: 'Erin', kind: 'outside', email: 'erin@partner.test', verifiedBy: 'email' };
  it('To decide shows an outsider’s email with Outside and how it was verified', () => {
    const r = request({ canDecide: true, requester: outsider as AccessRequestView['requester'], question: { title: 'Give erin@partner.test (outside) Platform team for 1 h?', text: 'Who: outside requester erin@partner.test (email verified by link)' } });
    const out = html(createElement(DecideList, { requests: [r], onDecided: () => {} }));
    expect(out).toContain('Outside');
    expect(out).toContain('erin@partner.test');
    expect(out).toContain('verified by email link');
    const google = html(createElement(DecideList, { requests: [{ ...r, requester: { ...outsider, verifiedBy: 'google' } as AccessRequestView['requester'] }], onDecided: () => {} }));
    expect(google).toContain('verified by Google sign-in');
    expect(html(createElement(DecideList, { requests: [request({ canDecide: true, requester: { id: 'u2', name: 'Mia' } })], onDecided: () => {} }))).not.toContain('Outside');
  });
  it('My requests and Grants show the outsider badge for an admin', () => {
    const rows = html(createElement(RequestRows, { requests: [request({ requester: outsider as AccessRequestView['requester'] })], viewerId: 'u1', onCancel: () => {}, onGiveBack: () => {} }));
    expect(rows).toContain('Outside');
    expect(rows).toContain('erin@partner.test');
    const cards = html(createElement(GrantCards, { grants: [grant({ holder: outsider as AccessGrantView['holder'] })], onAct: () => {} }));
    expect(cards).toContain('Outside');
  });
  it('requesterInfo reads kind, email and verifiedBy, defaulting to a user', () => {
    expect(requesterInfo({ id: 'u2', name: 'Mia' })).toEqual({ outside: false });
    expect(requesterInfo(outsider)).toEqual({ outside: true, email: 'erin@partner.test', verifiedBy: 'email', verifiedText: 'verified by email link' });
  });
});
