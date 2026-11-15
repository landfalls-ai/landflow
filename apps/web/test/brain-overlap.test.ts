/**
 * The work-overlap detector (docs/second-brain.md#work-overlap): two people whose team or org work of the last three days
 * is about the same thing get one introduction, never from private work, never twice in 14 days, and the card holds only
 * the titles each may open.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 20_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-brain-overlap-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_BRAIN_MODEL: 'off', LANDFLOW_BRAIN_EMBEDDINGS: 'off' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { database } = await import('@/lib/server/db');
const { createUser } = await import('@/lib/server/auth/users');
const { enableTestAuth } = await import('@/lib/server/auth/test-bypass');
const { recordWork } = await import('@/lib/server/brain/work');
const { createTeamProject, setMember } = await import('@/lib/server/projects/store');
const { DETECTOR_RUNS, detectContext } = await import('@/lib/server/brain/detectors');
const { upsertProposal, dismissProposal, listProposals } = await import('@/lib/server/brain/proposals');
const { rankOverlaps, mayOpen } = await import('@/lib/server/brain/overlap');
type OwnedItem = import('@/lib/server/brain/overlap').OwnedItem;

const owner = await createUser({ email: 'owner@ov.test', name: 'Owner', role: 'owner', password: 'owner-password-1' });
const alice = await createUser({ email: 'alice@ov.test', name: 'Alice', role: 'member', password: 'alice-password-1' });
const bob = await createUser({ email: 'bob@ov.test', name: 'Bob', role: 'member', password: 'bob-password-1' });
const carol = await createUser({ email: 'carol@ov.test', name: 'Carol', role: 'member', password: 'carol-password-1' });
const team = createTeamProject({ name: 'Platform', createdBy: owner.id });
setMember(team.id, alice.id, 'editor');
setMember(team.id, bob.id, 'editor');
const actorOf = (user: { id: string; role: 'owner' | 'admin' | 'member' }) => ({ id: user.id, role: user.role });

afterAll(() => {
  enableTestAuth();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const at = (hoursAgo: number) => new Date(Date.now() - hoursAgo * 3_600_000).toISOString();
const session = (sourceId: string, patch: Record<string, unknown> = {}) => ({ kind: 'work.session', source: 'claude-code', sourceId, occurredAt: at(2), title: `Work ${sourceId}`, repo: 'acme/widgets', areas: ['apps/billing'], ...patch });
const run = () => DETECTOR_RUNS['work-overlap'](detectContext());

beforeEach(() => {
  const db = database();
  for (const [table, column] of Object.entries({ usage_events: 'at', proposals: 'created_at' } as const)) db.deleteBefore(table as 'usage_events', column, '9999');
});

describe('the detector', () => {
  it('two people on the same area with team work get one suggestion for both', () => {
    recordWork(actorOf(alice), [session('a1', { visibility: 'org', title: 'Fix invoice rounding' })]);
    recordWork(actorOf(bob), [session('b1', { visibility: 'org', title: 'Billing page totals' })]);
    const found = run();
    expect(found).toHaveLength(1);
    const { proposal } = found[0];
    expect(proposal.detector).toBe('work-overlap');
    expect(proposal.slack).toBeUndefined();
    expect(proposal.audience?.map((m) => m.userId).sort()).toEqual([alice.id, bob.id].sort());
    expect(proposal.title).toMatch(/(Alice and Bob|Bob and Alice) are both on acme\/widgets\/apps\/billing/);
    expect(proposal.evidence.map((e) => e.value).sort()).toEqual(['Billing page totals', 'Fix invoice rounding']);
  });

  it('one side private: none', () => {
    recordWork(actorOf(alice), [session('a1', { visibility: 'org' })]);
    recordWork(actorOf(bob), [session('b1')]);
    expect(run()).toEqual([]);
  });

  it('team work is never used, even between project mates: the card is readable by admins', () => {
    recordWork(actorOf(alice), [session('a1', { visibility: 'team' })]);
    recordWork(actorOf(bob), [session('b1', { visibility: 'team' })]);
    expect(run()).toEqual([]);
  });

  it('the evidence is only org items', () => {
    recordWork(actorOf(alice), [session('a1', { visibility: 'team', title: 'Team item' }), session('a2', { visibility: 'org', title: 'Org item' }), session('a3', { title: 'Private item' })]);
    recordWork(actorOf(carol), [session('c1', { visibility: 'org', title: 'Carol org item' })]);
    const [finding] = run();
    expect(finding.proposal.audience?.map((m) => m.userId).sort()).toEqual([alice.id, carol.id].sort());
    expect(finding.proposal.evidence.map((e) => e.value)).toEqual(expect.arrayContaining(['Carol org item', 'Org item']));
    expect(JSON.stringify(finding.proposal)).not.toMatch(/Private item|Team item/);
  });

  it('introduced in the last 14 days: none, even after it is dismissed as not relevant; muted: none later', () => {
    recordWork(actorOf(alice), [session('a1', { visibility: 'org' })]);
    recordWork(actorOf(bob), [session('b1', { visibility: 'org' })]);
    const [first] = run();
    const saved = upsertProposal(first.proposal)!;
    expect(run()).toEqual([]);
    dismissProposal(saved.id, 'not-relevant', { actorId: alice.id });
    expect(run()).toEqual([]);
    expect(listProposals({ detector: 'work-overlap', status: 'all' }).length).toBe(1);
  });

  it('after 14 days it may speak again, unless a person said not to', () => {
    recordWork(actorOf(alice), [session('a1', { visibility: 'org' })]);
    recordWork(actorOf(bob), [session('b1', { visibility: 'org' })]);
    const [first] = run();
    const old = Date.now() - 20 * 86_400_000;
    const saved = upsertProposal(first.proposal, undefined, old)!;
    expect(run()).toHaveLength(1);
    dismissProposal(saved.id, 'intended', { actorId: bob.id });
    expect(run()).toEqual([]);
  });

  const threeOrg = () => {
    recordWork(actorOf(alice), [session('a1', { visibility: 'org' })]);
    recordWork(actorOf(bob), [session('b1', { visibility: 'org' })]);
    recordWork(actorOf(carol), [session('c1', { visibility: 'org' })]);
    const old = Date.now() - 20 * 86_400_000;
    const pairOf = (x: string, y: string) => run().find((f) => [x, y].every((id) => f.proposal.audience?.some((m) => m.userId === id)));
    return { saved: upsertProposal(pairOf(alice.id, bob.id)!.proposal, undefined, old)!, pairOf };
  };

  it('a muted person is left out of every pair, a third person\'s pair with them too', () => {
    const { saved, pairOf } = threeOrg();
    dismissProposal(saved.id, 'intended', { actorId: bob.id });
    expect(pairOf(alice.id, bob.id)).toBeUndefined();
    expect(pairOf(bob.id, carol.id)).toBeUndefined();
    expect(pairOf(alice.id, carol.id)).toBeDefined();
  });

  it('a Slack-side decision, or one by someone outside the card, mutes no one', () => {
    const { saved, pairOf } = threeOrg();
    dismissProposal(saved.id, 'intended', { actorId: 'slack:U123' });
    expect(pairOf(alice.id, bob.id)).toBeDefined();
    expect(pairOf(bob.id, carol.id)).toBeDefined();
  });
});

describe('the pure ranking', () => {
  const item = (ownerId: string, visibility: 'org' | 'org' | 'private', over: Partial<OwnedItem['item']> & { initiative?: string; customer?: string } = {}): OwnedItem => ({
    ownerId,
    ...(over.initiative && { initiative: over.initiative }),
    ...(over.customer && { customer: over.customer }),
    item: { id: `${ownerId}${visibility}`, sourceId: 's', source: 'x', kind: 'work.session', title: `T ${ownerId}`, at: '2026-11-14T10:00:00Z', visibility, ...over },
  });
  const mates = new Map([['a', new Set(['b'])], ['b', new Set(['a'])]]);

  it('an initiative in common is enough; private items never count', () => {
    expect(rankOverlaps([item('a', 'org', { initiative: 'Q4 launch' }), item('b', 'org', { initiative: 'Q4 launch' })], mates)).toHaveLength(1);
    expect(rankOverlaps([item('a', 'private', { initiative: 'Q4 launch' }), item('b', 'org', { initiative: 'Q4 launch' })], mates)).toEqual([]);
  });

  it('team work reaches only teammates', () => {
    const a = item('a', 'team');
    expect(mayOpen('b', a, mates)).toBe(true);
    expect(mayOpen('c', a, mates)).toBe(false);
  });

  it('the same repository with the same initiative or customer is a lead', () => {
    const found = (over: Partial<OwnedItem['item']> & { initiative?: string; customer?: string }) => rankOverlaps([item('a', 'org', { repo: 'x/y', ...over }), item('b', 'org', { repo: 'x/y', ...over })], mates);
    expect(found({ initiative: 'Q4 launch' })[0]?.thing).toEqual({ type: 'initiative', name: 'Q4 launch' });
    expect(found({ customer: 'Acme' })[0]?.thing).toEqual({ type: 'customer', name: 'Acme' });
  });

  it('the same directory in different repositories, or without a repository, is no lead; in the same repository it is', () => {
    expect(rankOverlaps([item('a', 'org', { repo: 'x/y', areas: ['src'] }), item('b', 'org', { repo: 'p/q', areas: ['src'] })], mates)).toEqual([]);
    expect(rankOverlaps([item('a', 'org', { areas: ['docs'] }), item('b', 'org', { areas: ['docs'] })], mates)).toEqual([]);
    expect(rankOverlaps([item('a', 'org', { repo: 'x/y', areas: ['src'] }), item('b', 'org', { repo: 'x/y', areas: ['src'] })], mates)[0]?.thing).toEqual({ type: 'area', name: 'x/y/src' });
  });

  it('the same repository alone is not a lead', () => {
    expect(rankOverlaps([item('a', 'org', { repo: 'x/y' }), item('b', 'org', { repo: 'x/y' })], mates)).toEqual([]);
  });
});
