/** Deleting a project retires its project-level practices (docs/practices.md#when-a-project-is-deleted): no agent gets them again, and the audit trail stays. */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { PracticeDraftInput } from '@/lib/shared/practices';

vi.setConfig({ testTimeout: 20_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-practices-delete-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { createUser } = await import('@/lib/server/auth/users');
const { enableTestAuth } = await import('@/lib/server/auth/test-bypass');
const projects = await import('@/lib/server/projects');
const { storePort } = await import('@/lib/server/practices/register');
const { approvePractice } = await import('@/lib/server/practices/approve');
const { getPractice, versionsOf } = await import('@/lib/server/practices/store');
const { database } = await import('@/lib/server/db');

const owner = await createUser({ email: 'owner@pd.test', name: 'Owner', role: 'owner', password: 'owner-password-1' });
enableTestAuth(owner);

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
  topics: [`t-delete-${seq}`],
  repos: [],
  paths: [],
  summary: 'A short rule',
  body: 'The full rule.',
  ...over,
});
const approved = (draft: PracticeDraftInput) => {
  const { practice } = storePort.draft(draft, { source: 'person', actor: owner });
  approvePractice(owner, practice.id, { version: 1 });
  return practice.id;
};

describe('deleting a project', () => {
  it('retires its project practices, keeps their versions, and leaves the org and other projects alone', () => {
    const doomed = projects.createTeamProject({ name: 'Doomed' }).id;
    const kept = projects.createTeamProject({ name: 'Kept' }).id;
    const mine = approved(input({ level: 'project', projectId: doomed }));
    const theirs = approved(input({ level: 'project', projectId: kept }));
    const org = approved(input());
    const draft = storePort.draft(input({ level: 'project', projectId: doomed }), { source: 'person', actor: owner }).practice.id;
    expect(storePort.approved({ projectIds: [doomed] }).map((p) => p.id)).toContain(mine);

    projects.deleteProjectWithTransfer(doomed, undefined, owner.id);

    expect(getPractice(mine)?.status).toBe('retired');
    expect(getPractice(draft)?.status).toBe('retired');
    expect(versionsOf(mine)).toHaveLength(1);
    expect(getPractice(theirs)?.status).toBe('approved');
    expect(getPractice(org)?.status).toBe('approved');
    expect(storePort.approved({ projectIds: [doomed, kept] }).map((p) => p.id).sort()).toEqual([org, theirs].sort());
    expect(database().all("SELECT 1 FROM audit_events WHERE action = 'practice.retired' AND target_id = ?", mine)).toHaveLength(1);
  });

  it('retires them when the project’s resources are transferred too, and does not move them', () => {
    const from = projects.createTeamProject({ name: 'From' }).id;
    const to = projects.createTeamProject({ name: 'To' }).id;
    const id = approved(input({ level: 'project', projectId: from }));
    projects.deleteProjectWithTransfer(from, to, owner.id);
    expect(getPractice(id)).toMatchObject({ status: 'retired', projectId: from });
    expect(storePort.approved({ projectIds: [to] }).map((p) => p.id)).not.toContain(id);
  });
});
