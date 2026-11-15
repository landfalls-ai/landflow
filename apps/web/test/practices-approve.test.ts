/** Practices: a tainted version needs a reading, overlaps need an answer, and a citation is verified only from the files a flow read. */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { PracticeDraftInput } from '@/lib/shared/practices';

vi.setConfig({ testTimeout: 20_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-practices-approve-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { createUser } = await import('@/lib/server/auth/users');
const { enableTestAuth } = await import('@/lib/server/auth/test-bypass');
const projects = await import('@/lib/server/projects');
const approveRoute = await import('@/app/api/practices/[id]/approve/route');
const { storePort } = await import('@/lib/server/practices/register');
const { practicesPort } = await import('@/lib/server/practices/port');
const { verifyCitations } = await import('@/lib/server/practices/citations');

const owner = await createUser({ email: 'owner@pa.test', name: 'Owner', role: 'owner', password: 'owner-password-1' });
const member = await createUser({ email: 'member@pa.test', name: 'Member', role: 'member', password: 'member-password-1' });
const team = projects.createTeamProject({ name: 'Team' }).id;
const other = projects.createTeamProject({ name: 'Other' }).id;

afterAll(() => {
  enableTestAuth();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

let seq = 0;
const input = (over: Partial<PracticeDraftInput> = {}): PracticeDraftInput => ({
  handle: `rules/rule-${++seq}`,
  title: 'A rule',
  level: 'org',
  strength: 'recommended',
  topics: ['monitoring'],
  repos: [],
  paths: [],
  summary: 'A short rule',
  body: 'The full rule.',
  ...over,
});
const approve = async (id: string, body: Record<string, unknown>) => {
  enableTestAuth(owner);
  const response = await approveRoute.POST(new Request(`http://pa.test/api/practices/${id}/approve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });
  return { status: response.status, body: (await response.json()) as { code?: string; error?: string; conflicts?: Array<{ id: string; overlap: string }> } };
};

describe('tainted versions', () => {
  it('need reviewedSources', async () => {
    const { practice } = storePort.draft(input({ topics: ['t-taint'] }), { source: 'agent', actor: member });
    const refused = await approve(practice.id, { version: 1 });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('practice_needs_review');
    expect((await approve(practice.id, { version: 1, reviewedSources: true })).status).toBe(200);
  });

  it('stay tainted when a person edits a draft nobody has reviewed', () => {
    const first = storePort.draft(input({ topics: ['t-edit'] }), { source: 'learned', actor: member });
    const edited = storePort.draft({ ...input({ topics: ['t-edit'] }), practiceId: first.practice.id, handle: first.practice.handle }, { source: 'person', actor: member });
    expect(edited.version).toMatchObject({ version: 2, source: 'person', tainted: true });
  });
});

describe('conflicts', () => {
  it('answer every overlap: 409 with the list, then Supersede retires the other and Keep leaves both', async () => {
    const first = storePort.draft(input({ topics: ['t-over', 'a'], repos: ['acme/web'], paths: ['deploy/**'] }), { source: 'person', actor: owner });
    const second = storePort.draft(input({ topics: ['t-over'], repos: [], paths: ['deploy/helm/*.yaml'] }), { source: 'person', actor: owner });
    const third = storePort.draft(input({ topics: ['t-over'], repos: ['acme/api'] }), { source: 'person', actor: owner });
    expect((await approve(first.practice.id, { version: 1 })).status).toBe(200);

    const blocked = await approve(second.practice.id, { version: 1 });
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('practice_conflict');
    expect(blocked.body.conflicts).toHaveLength(1);
    expect(blocked.body.conflicts![0]).toMatchObject({ id: first.practice.id, overlap: expect.stringContaining('topic t-over') });
    expect((await approve(second.practice.id, { version: 1, conflicts: { [first.practice.id]: 'supersede' } })).status).toBe(200);
    const handles = practicesPort()!.approved({ projectIds: 'all' }).map((p) => p.id);
    expect(handles).toContain(second.practice.id);
    expect(handles).not.toContain(first.practice.id);

    // The third names another repository: its scope does not meet the first's, but meets the second's (any repository).
    const viaSecond = await approve(third.practice.id, { version: 1 });
    expect(viaSecond.status).toBe(409);
    expect((await approve(third.practice.id, { version: 1, conflicts: { [second.practice.id]: 'keep' } })).status).toBe(200);
    const kept = practicesPort()!.approved({ projectIds: 'all' }).map((p) => p.id);
    expect(kept).toEqual(expect.arrayContaining([second.practice.id, third.practice.id]));
  });

  it('do not meet across two projects, or across disjoint paths', async () => {
    const a = storePort.draft(input({ topics: ['t-iso'], level: 'project', projectId: team }), { source: 'person', actor: owner });
    const b = storePort.draft(input({ topics: ['t-iso'], level: 'project', projectId: other }), { source: 'person', actor: owner });
    const c = storePort.draft(input({ topics: ['t-iso2'], paths: ['docs/**'] }), { source: 'person', actor: owner });
    const d = storePort.draft(input({ topics: ['t-iso2'], paths: ['src/**'] }), { source: 'person', actor: owner });
    for (const id of [a, b, c, d].map((x) => x.practice.id)) expect((await approve(id, { version: 1 })).status).toBe(200);
  });
});

describe('citations', () => {
  const citation = { repo: 'acme/web', sha: 'abc1234', path: 'CLAUDE.md', excerpt: 'Charts live in deploy/helm.' };
  const file = { repo: 'acme/web', sha: 'abc1234', path: 'CLAUDE.md', content: 'Intro\r\nCharts live in deploy/helm.\r\nMore' };

  it('are verified only where the excerpt is in the same repo, sha and path', () => {
    expect(verifyCitations([citation], [file])[0].verified).toBe(true);
    expect(verifyCitations([citation], [{ ...file, sha: 'def5678' }])[0].verified).toBe(false);
    expect(verifyCitations([citation], [{ ...file, path: 'README.md' }])[0].verified).toBe(false);
    expect(verifyCitations([citation], [{ ...file, repo: 'acme/api' }])[0].verified).toBe(false);
    expect(verifyCitations([{ ...citation, excerpt: 'Charts live elsewhere.' }], [file])[0].verified).toBe(false);
    expect(verifyCitations([citation], undefined)[0].verified).toBe(false);
  });

  it('are stored verified only from origin.files, and a caller’s claim is ignored', () => {
    const claimed = { ...citation, verified: true } as unknown as NonNullable<PracticeDraftInput['citations']>[number];
    const without = storePort.draft(input({ topics: ['t-cite1'], citations: [claimed] }), { source: 'learned', actor: member });
    expect(without.version.citations[0].verified).toBe(false);
    const withFiles = storePort.draft(input({ topics: ['t-cite2'], citations: [citation] }), { source: 'learned', workflowId: 'wf_any', actor: owner, files: [file] });
    expect(withFiles.version.citations[0].verified).toBe(true);
    expect(withFiles.version.tainted).toBe(true);
    expect(withFiles.version.draftedBy).toBe('workflow:wf_any');
  });
});
