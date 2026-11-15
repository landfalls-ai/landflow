/**
 * The practices inbox (docs/practices.md#the-inbox): every draft files a suggestion, a tainted one only links to /brain, an
 * untainted one is applied (approved) by owners and admins, /brain decisions settle it, a newer version replaces it, Slack
 * gets no buttons for it, and the practice-drift detector fires on seeded rows. Imports practices/inbox first, as a test
 * that fakes an applier must.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { Proposal } from '@/lib/shared/brain';
import type { PracticeDraftInput } from '@/lib/shared/practices';

vi.setConfig({ testTimeout: 20_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-practice-inbox-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_PUBLIC_URL: 'http://inbox.test' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

await import('@/lib/server/practices/inbox');
const { createUser } = await import('@/lib/server/auth/users');
const { enableTestAuth } = await import('@/lib/server/auth/test-bypass');
const projects = await import('@/lib/server/projects');
const { database } = await import('@/lib/server/db');
const proposals = await import('@/lib/server/brain/proposals');
const { applyable, canDecide, canSee, changesSomething, mirrorBlocks, mirrorButtons } = await import('@/lib/server/brain/audience');
const { storePort } = await import('@/lib/server/practices/register');
const { approvePractice, rejectVersion, retirePractice } = await import('@/lib/server/practices/approve');
const { getPractice, markRetired } = await import('@/lib/server/practices/store');
const applyRoute = await import('@/app/api/proposals/[id]/apply/route');
const { ProposalCard, cardButtons } = await import('@/components/brain/proposal-card');
const { ViewerProvider } = await import('@/components/auth/viewer');
const { practiceDrift } = await import('@/lib/server/brain/practice-drift');
const { detectContext, DETECTOR_RUNS } = await import('@/lib/server/brain/detectors');
const { DETECTORS, DETECTOR_LABELS } = await import('@/lib/shared/brain');

const owner = await createUser({ email: 'owner@pi.test', name: 'Owner', role: 'owner', password: 'owner-password-1' });
const admin = await createUser({ email: 'admin@pi.test', name: 'Admin', role: 'admin', password: 'admin-password-1' });
const member = await createUser({ email: 'member@pi.test', name: 'Member', role: 'member', password: 'member-password-1' });
const padmin = await createUser({ email: 'padmin@pi.test', name: 'Project Admin', role: 'member', password: 'padmin-password-1' });
const alpha = projects.createTeamProject({ name: 'Alpha' }).id;
projects.setMember(alpha, padmin.id, 'admin');
projects.setMember(alpha, member.id, 'editor');

afterAll(() => {
  enableTestAuth();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

let seq = 0;
const input = (over: Partial<PracticeDraftInput> = {}): PracticeDraftInput => ({
  handle: `rules/inbox-${++seq}`,
  title: 'Charts live under deploy/helm',
  level: 'org',
  strength: 'required',
  topics: [`inbox-${seq}`],
  repos: [],
  paths: [],
  summary: 'Charts live in deploy/helm/<service>/',
  body: 'SECRET BODY TEXT: put each chart in deploy/helm/<service>/.',
  ...over,
});
const suggestionsOf = (practiceId: string, status = 'open'): Proposal[] => proposals.listProposals({ status: status as 'open', limit: 500 }).filter((p) => p.practice?.practiceId === practiceId);
const only = (practiceId: string): Proposal => {
  const found = suggestionsOf(practiceId);
  expect(found).toHaveLength(1);
  return found[0];
};
const apply = async (user: typeof owner, id: string) => {
  enableTestAuth(user);
  const response = await applyRoute.POST(new Request(`http://pi.test/api/proposals/${id}/apply`, { method: 'POST' }), { params: Promise.resolve({ id }) });
  return { status: response.status, body: (await response.json()) as { error?: string; proposal?: Proposal } };
};

describe('filing', () => {
  it('files an applyable suggestion for a person’s draft, addressed to the approvers', () => {
    const { practice } = storePort.draft(input(), { source: 'person', actor: member });
    const s = only(practice.id);
    expect(s).toMatchObject({ source: 'practice', practice: { practiceId: practice.id, version: 1, tainted: false }, target: { type: 'instance' } });
    expect(s.title).toContain('Charts live under deploy/helm');
    expect(s.why).toContain('Charts live in deploy/helm/<service>/');
    expect(s.audience?.map((m) => m.userId).sort()).toEqual([owner.id, admin.id].sort());
    expect(changesSomething(s)).toBe(true);
    expect(canSee(owner, s)).toBe(true);
    expect(canSee(member, s)).toBe(false);
  });

  it('files a tainted suggestion, with no body text in it, for an agent’s or a repository’s draft', () => {
    const agent = storePort.draft(input(), { source: 'agent', actor: member });
    const learned = storePort.draft(input({ repos: ['acme/web'] }), { source: 'learned', actor: member });
    for (const { practice } of [agent, learned]) {
      const s = only(practice.id);
      expect(s.practice?.tainted).toBe(true);
      expect(JSON.stringify(s)).not.toContain('SECRET BODY TEXT');
      expect(s.why).toContain('/brain');
    }
  });

  it('addresses a project practice to the project’s admins too', () => {
    const { practice } = storePort.draft(input({ level: 'project', projectId: alpha }), { source: 'person', actor: member });
    const s = only(practice.id);
    expect(s.projectId).toBe(alpha);
    expect(s.audience?.map((m) => m.userId).sort()).toEqual([owner.id, admin.id, padmin.id].sort());
    expect(canSee(padmin, s)).toBe(true);
    expect(canSee(member, s)).toBe(false);
  });

  it('lets a newer draft version replace the open suggestion of the older one', () => {
    const { practice } = storePort.draft(input(), { source: 'person', actor: member });
    const first = only(practice.id);
    storePort.draft({ ...input({ handle: practice.handle }), practiceId: practice.id }, { source: 'person', actor: member });
    const now = only(practice.id);
    expect(now.practice?.version).toBe(2);
    expect(now.id).not.toBe(first.id);
    expect(proposals.getProposal(first.id)).toMatchObject({ status: 'expired', note: 'Replaced by version 2' });
  });
});

describe('Apply', () => {
  it('approves the version as an owner and settles the suggestion', async () => {
    const { practice } = storePort.draft(input(), { source: 'person', actor: member });
    const s = only(practice.id);
    const done = await apply(owner, s.id);
    expect(done.status).toBe(200);
    expect(getPractice(practice.id)).toMatchObject({ status: 'approved', approvedVersion: 1 });
    expect(proposals.getProposal(s.id)).toMatchObject({ status: 'applied', appliedBy: owner.id });
    expect((await apply(owner, s.id)).status).toBe(409);
  });

  it('marks the suggestion applied once: one proposal.applied usage event, and the Approved note stays', async () => {
    const { practice } = storePort.draft(input(), { source: 'person', actor: member });
    const s = only(practice.id);
    expect((await apply(owner, s.id)).status).toBe(200);
    const events = database().all<{ attrs: string }>("SELECT attrs FROM usage_events WHERE kind = 'proposal.applied'").filter((e) => String(e.attrs).includes(s.id));
    expect(events).toHaveLength(1);
    expect(proposals.getProposal(s.id)?.decision?.note).toBe('Approved');
  });

  it('is refused for a member in the audience, and the suggestion stays', async () => {
    const { practice } = storePort.draft(input({ level: 'project', projectId: alpha }), { source: 'person', actor: member });
    const s = only(practice.id);
    expect(canDecide(padmin, s, 'apply')).toBe(false);
    expect(canDecide(padmin, s, 'other')).toBe(true);
    const refused = await apply(padmin, s.id);
    expect(refused.status).toBe(403);
    expect(getPractice(practice.id)?.status).toBe('draft');
    expect(proposals.getProposal(s.id)?.status).toBe('open');
    // The applier refuses too, whoever calls it.
    expect(() => proposals.applyProposal(s.id, { actorId: padmin.id })).toThrow(/owners and admins/);
    expect((await apply(admin, s.id)).status).toBe(200);
  });

  it('is refused for a tainted draft even for an owner', async () => {
    const { practice } = storePort.draft(input(), { source: 'agent', actor: member });
    const s = only(practice.id);
    const refused = await apply(owner, s.id);
    expect(refused.status).toBe(403);
    expect(refused.body.error).toContain('/brain');
    expect(getPractice(practice.id)?.status).toBe('draft');
    expect(proposals.getProposal(s.id)?.status).toBe('open');
  });

  it('answers 409 and dismisses the suggestion when the practice was retired behind its back', async () => {
    const { practice } = storePort.draft(input(), { source: 'person', actor: member });
    const s = only(practice.id);
    // What deleting a project does (projects/store.ts): the practice is retired without the practices store settling anything.
    markRetired(practice.id);
    const stale = await apply(owner, s.id);
    expect(stale.status).toBe(409);
    expect(proposals.getProposal(s.id)).toMatchObject({ status: 'dismissed' });
    expect(proposals.getProposal(s.id)?.decision?.note).toContain('retired');
  });
});

describe('deciding on /brain settles the suggestion', () => {
  it('approving applies it, and a newer pending version’s older suggestion is no longer open', () => {
    const { practice } = storePort.draft(input(), { source: 'person', actor: member });
    const s = only(practice.id);
    approvePractice(owner, practice.id, { version: 1 });
    expect(proposals.getProposal(s.id)).toMatchObject({ status: 'applied', appliedBy: owner.id });
  });

  it('rejecting dismisses it with the reason', () => {
    const { practice } = storePort.draft(input(), { source: 'person', actor: member });
    const s = only(practice.id);
    rejectVersion(owner, practice.id, 1, 'Contradicts our runbook');
    const dismissed = proposals.getProposal(s.id)!;
    expect(dismissed.status).toBe('dismissed');
    expect(dismissed.decision?.note).toBe('Rejected: Contradicts our runbook');
  });

  it('retiring dismisses every open suggestion of the practice', () => {
    const first = storePort.draft(input(), { source: 'person', actor: member });
    approvePractice(owner, first.practice.id, { version: 1 });
    storePort.draft({ ...input({ handle: first.practice.handle }), practiceId: first.practice.id }, { source: 'person', actor: member });
    const s = only(first.practice.id);
    retirePractice(owner, first.practice.id);
    expect(proposals.getProposal(s.id)?.status).toBe('dismissed');
    expect(suggestionsOf(first.practice.id)).toHaveLength(0);
  });
});

describe('the card and Slack', () => {
  const viewer = (user: typeof owner) => ({ id: user.id, name: user.name, email: user.email, role: user.role, sso: false, hasPassword: true });
  const actions = { apply() {}, act() {}, dismiss() {}, snooze() {} };
  const html = (p: Proposal, user: typeof owner) => renderToStaticMarkup(createElement(ViewerProvider, { viewer: viewer(user) }, createElement(ProposalCard, { proposal: p, actions, expanded: true })));

  it('shows Approve to an owner for an untainted draft and only a link to everyone else', () => {
    const { practice } = storePort.draft(input(), { source: 'person', actor: member });
    const s = only(practice.id);
    expect(cardButtons(s, true).hasApply).toBe(true);
    expect(cardButtons(s, false).hasApply).toBe(false);
    expect(html(s, owner)).toContain('Approve');
    const asAdmin = html(s, member);
    expect(asAdmin).not.toContain('>Approve<');
    expect(asAdmin).toContain(`/brain/practices/${practice.id}`);
  });

  it('says to read a tainted draft against its sources on /brain and has no Apply for anyone', () => {
    const { practice } = storePort.draft(input(), { source: 'agent', actor: member });
    const s = only(practice.id);
    expect(cardButtons(s, true).hasApply).toBe(false);
    const markup = html(s, owner);
    expect(markup).toContain('Read it against its sources on /brain');
    expect(markup).not.toContain('>Approve<');
    expect(markup).not.toContain('SECRET BODY TEXT');
  });

  it('mirrors to Slack with a link and no buttons', () => {
    const { practice } = storePort.draft(input(), { source: 'person', actor: member });
    const s = only(practice.id);
    expect(applyable(s)).toBe(false);
    expect(mirrorButtons(s)).toEqual([]);
    const blocks = mirrorBlocks(s);
    expect(blocks.some((b) => b.type === 'actions')).toBe(false);
    expect(JSON.stringify(blocks)).toContain(`http://inbox.test/brain/practices/${practice.id}`);
  });
});

describe('the practice-drift detector', () => {
  const DAY = 86_400_000;
  const rows = (practiceId: string, kind: 'delivered' | 'cited' | 'check-pass' | 'check-fail', n: number, daysAgo = 2) => {
    for (let i = 0; i < n; i++) storePort.record({ practiceId, version: 1, kind, at: new Date(Date.now() - daysAgo * DAY).toISOString() });
  };
  const approvedPractice = (over: Partial<PracticeDraftInput> = {}) => {
    const { practice } = storePort.draft(input({ title: 'Pin chart versions', ...over }), { source: 'person', actor: owner });
    approvePractice(owner, practice.id, { version: 1 });
    return practice;
  };
  const find = (practiceId: string) => practiceDrift(detectContext({}, database())).filter((f) => f.proposal.fingerprint && f.proposal.target.name === getPractice(practiceId)!.handle);

  it('is a built-in detector with a label and a run', () => {
    expect(DETECTORS).toContain('practice-drift');
    expect(DETECTOR_LABELS['practice-drift']).toBe('Practice drift');
    expect(DETECTOR_RUNS['practice-drift']).toBe(practiceDrift);
  });

  it('files a suggestion for a practice given 10 times and cited under 20%, with the numbers', () => {
    const practice = approvedPractice();
    rows(practice.id, 'delivered', 12);
    rows(practice.id, 'cited', 1);
    const found = find(practice.id);
    expect(found).toHaveLength(1);
    const p = found[0].proposal;
    expect(p).toMatchObject({ source: 'detector', detector: 'practice-drift', ops: [], title: 'Review Pin chart versions: rarely followed' });
    expect(p.why).toContain('8%');
    expect(p.evidence).toEqual(expect.arrayContaining([{ label: 'Given (14 days)', value: 12 }, { label: 'Practice', value: practice.handle, href: `/brain/practices/${practice.id}` }]));
    expect(proposals.upsertProposal(p)).toBeDefined();
  });

  it('fires on checks that failed more than half the time', () => {
    const practice = approvedPractice();
    rows(practice.id, 'delivered', 10);
    rows(practice.id, 'cited', 10);
    rows(practice.id, 'check-pass', 2);
    rows(practice.id, 'check-fail', 3);
    expect(find(practice.id)).toHaveLength(1);
  });

  it('stays quiet under the floor, when it is followed, or when the rows are old', () => {
    const few = approvedPractice();
    rows(few.id, 'delivered', 9);
    expect(find(few.id)).toHaveLength(0);
    const followed = approvedPractice();
    rows(followed.id, 'delivered', 20);
    rows(followed.id, 'cited', 10);
    rows(followed.id, 'check-pass', 4);
    rows(followed.id, 'check-fail', 2);
    expect(find(followed.id)).toHaveLength(0);
    const old = approvedPractice();
    rows(old.id, 'delivered', 15, 20);
    expect(find(old.id)).toHaveLength(0);
  });
});
