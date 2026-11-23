/**
 * C35 (docs/access-requests.md#the-catalog): who creates, sees and edits an access entry, what a valid entry is, and that every
 * change is audited. Library calls with real users (an admin, an owner of one entry, two members); credentials are real vault rows.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const ENV = { LANDFLOW_DATA_DIR: mkdtempSync(join(tmpdir(), 'landflow-access-catalog-')), LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);
afterAll(() => {
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const { registry } = await import('@/lib/server/plugins/registry');
const { credentials } = await import('@/lib/server/credentials/vault');
const { createOwner, createUser } = await import('@/lib/server/auth/users');
const { createTeamProject, setHomeProject, defaultProjectId } = await import('@/lib/server/projects/store');
const { database } = await import('@/lib/server/db');
const { queryEvents } = await import('@/lib/server/audit/store');
const { fakeGithubPlugin, fakeGooglePlugin } = await import('./fixtures/fake-access-plugins');
const { saveAccessSettings } = await import('@/lib/server/access/store');
const { createEntry, deleteEntry, getEntry, listEntries, updateEntry } = await import('@/lib/server/access/catalog');
const { AccessError } = await import('@/lib/server/access/errors');

registry.registerBuiltin(fakeGithubPlugin);
registry.registerBuiltin(fakeGooglePlugin);

const owner = await createOwner({ email: 'owner@landflow.test', name: 'Olive Owner', password: 'password-123' });
const admin = await createUser({ email: 'admin@landflow.test', name: 'Ada Admin', role: 'admin' });
const lead = await createUser({ email: 'lead@landflow.test', name: 'Lee Lead', role: 'member' });
const mia = await createUser({ email: 'mia@landflow.test', name: 'Mia Member', role: 'member' });
const ola = await createUser({ email: 'ola@landflow.test', name: 'Ola Other', role: 'member' });
const github = credentials.create({ name: 'GitHub', type: 'github.githubApi', data: { accessToken: 'ghp_catalog-test-token' } });
const google = credentials.create({ name: 'Google', type: 'google.googleApi', data: { privateKey: 'google-catalog-test-key' } });
saveAccessSettings({ projectId: defaultProjectId() });

const team = (extra: Record<string, unknown> = {}) => ({ name: 'Platform team', system: 'github-team', target: { org: 'acme', team: 'platform' }, credentialId: github.id, durations: [60, 240, null], approverIds: [admin.id], owners: [lead.id], ...extra });
const refused = async (fn: () => unknown, status: number, text?: RegExp) => {
  try {
    await fn();
  } catch (error) {
    expect(error).toBeInstanceOf(AccessError);
    expect((error as InstanceType<typeof AccessError>).status).toBe(status);
    if (text) expect((error as Error).message).toMatch(text);
    return;
  }
  throw new Error(`expected ${status}`);
};
const audited = (action: string) => queryEvents({ action: [action] }, { limit: 100 }).events;

describe('creating', () => {
  it('lets an admin create an entry and a member not', async () => {
    await refused(() => createEntry(mia, team()), 403);
    const made = createEntry(admin, team());
    expect(made).toMatchObject({ name: 'Platform team', system: 'github-team', canEdit: true, version: 1, durations: [60, 240, null], owners: [lead.id], approverNames: ['Ada Admin'] });
    expect(made.target).toMatchObject({ key: 'acme/platform', label: 'GitHub team acme/platform (member)' });
    expect(made.credentialId).toBe(github.id);
    const adminAudit = audited('access.entry.create');
    expect(adminAudit.find((e) => e.target?.id === made.id)).toMatchObject({ actor: { id: admin.id }, target: { id: made.id } });
  });

  it('refuses a bad target, a wrong credential type and a credential the editor or the access project can’t use', async () => {
    await refused(() => createEntry(admin, team({ target: { org: 'acme', team: '' } })), 400, /Team slug/);
    await refused(() => createEntry(admin, team({ credentialId: google.id })), 400, /needs a github.githubApi credential/);
    await refused(() => createEntry(admin, team({ credentialId: 'cred_missing' })), 400, /Credential not found/);
    await refused(() => createEntry(admin, team({ credentialId: undefined })), 400, /Pick the credential/);
    const elsewhere = credentials.create({ name: 'Elsewhere', type: 'github.githubApi', data: { accessToken: 'ghp_elsewhere-token' } });
    setHomeProject('credential', elsewhere.id, createTeamProject({ name: 'Other project' }).id);
    await refused(() => createEntry(admin, team({ credentialId: elsewhere.id })), 400, /not shared with the project/);
  });

  it('checks durations: whole minutes from 1 to 129,600, no repeats, at most 8, at least one', async () => {
    for (const durations of [[0], [129_601], [1.5], [60, 60], [1, 2, 3, 4, 5, 6, 7, 8, 9], []]) await refused(() => createEntry(admin, team({ durations })), 400);
    expect(createEntry(admin, team({ name: 'One minute', durations: [1, 129_600, null] })).durations).toEqual([1, 129_600, null]);
  });

  it('needs an approver, an owner, and people who exist', async () => {
    await refused(() => createEntry(admin, team({ approverIds: [] })), 400);
    await refused(() => createEntry(admin, team({ owners: [] })), 400);
    await refused(() => createEntry(admin, team({ owners: ['usr_nobody'] })), 400);
  });

  it('makes a manual entry with no credential', async () => {
    const manual = createEntry(admin, { name: 'Figma editor', system: 'manual', target: { instructions: 'Add them in Figma' }, durations: [1_440], approverIds: [admin.id], owners: [admin.id] });
    expect(manual.credentialId).toBeUndefined();
    expect(manual.target.label).toBe('By hand: Add them in Figma');
  });
});

describe('seeing', () => {
  const group = createEntry(admin, { name: 'Engineering group', system: 'google-group', target: { groupKey: 'eng@example.com' }, credentialId: google.id, durations: [null], approverIds: [admin.id], owners: [lead.id], eligibleUserIds: [mia.id] });
  const off = createEntry(admin, team({ name: 'Switched off', enabled: false }));

  it('shows a member the enabled entries they may ask for, without the credential', () => {
    const seen = listEntries(mia);
    expect(seen.map((e) => e.name)).toEqual(expect.arrayContaining(['Platform team', 'Engineering group']));
    expect(seen.map((e) => e.name)).not.toContain('Switched off');
    for (const entry of seen) {
      expect(entry.credentialId).toBeUndefined();
      expect(entry.canEdit).toBe(false);
    }
  });

  it('hides an entry that lists other people from everyone else with a 404', async () => {
    expect(listEntries(ola).map((e) => e.name)).not.toContain('Engineering group');
    await refused(() => getEntry(ola, group.id), 404);
    expect(getEntry(mia, group.id).name).toBe('Engineering group');
  });

  it('shows owners and admins everything, including a switched-off entry and the credential', () => {
    expect(getEntry(lead, group.id)).toMatchObject({ canEdit: true, credentialId: google.id });
    expect(getEntry(lead, off.id).enabled).toBe(false);
    expect(listEntries(admin).map((e) => e.name)).toContain('Switched off');
    expect(listEntries(owner).map((e) => e.name)).toContain('Switched off');
    expect(getEntry(admin, group.id).eligibleUserIds).toEqual([mia.id]);
    expect(getEntry(mia, group.id).eligibleUserIds).toEqual([]);
  });
});

describe('editing', () => {
  const made = createEntry(admin, team({ name: 'Editable' }));

  it('lets an owner who is a member change durations and approvers, and nobody else', async () => {
    const changed = updateEntry(lead, made.id, { durations: [15, 60], approverIds: [admin.id, owner.id] }, made.version);
    expect(changed).toMatchObject({ durations: [15, 60], version: 2, approverNames: ['Ada Admin', 'Olive Owner'] });
    await refused(() => updateEntry(mia, made.id, { durations: [1] }, 2), 403);
    await refused(() => updateEntry(ola, made.id, { durations: [1] }, 2), 403);
  });

  it('answers 409 to a stale version and changes nothing', async () => {
    await refused(() => updateEntry(lead, made.id, { name: 'Stale' }, 1), 409, /Someone else/);
    expect(getEntry(lead, made.id).name).toBe('Editable');
  });

  it('keeps the system, target and credential for an admin', async () => {
    await refused(() => updateEntry(lead, made.id, { target: { org: 'acme', team: 'secrets' } }, 2), 403, /admin changes what an entry reaches/);
    await refused(() => updateEntry(lead, made.id, { credentialId: github.id, system: 'github-org', target: { org: 'acme' } }, 2), 403);
    // Sending the same target back is no change.
    expect(updateEntry(lead, made.id, { target: { org: 'acme', team: 'platform' }, credentialId: github.id, name: 'Editable team' }, 2).version).toBe(3);
    expect(updateEntry(admin, made.id, { target: { org: 'acme', team: 'secrets' } }, 3).target.key).toBe('acme/secrets');
  });

  it('never leaves an entry without an owner', async () => {
    await refused(() => updateEntry(lead, made.id, { owners: [] }, 4), 400);
    expect(updateEntry(lead, made.id, { owners: [lead.id, mia.id] }, 4).owners).toEqual([lead.id, mia.id]);
  });

  it('records what it was and what it became', () => {
    const events = audited('access.entry.update');
    expect(events.length).toBeGreaterThanOrEqual(3);
    expect(events[0]!.details).toMatchObject({ from: expect.stringContaining('Editable'), to: expect.any(String) });
    const text = JSON.stringify(audited('access.entry.create').concat(events));
    expect(text).not.toContain('ghp_catalog-test-token');
    expect(text).not.toContain(github.id);
  });
});

describe('deleting', () => {
  it('is an admin’s, and refused while access is in place or a request waits', async () => {
    const e = createEntry(admin, team({ name: 'To delete' }));
    await refused(() => deleteEntry(lead, e.id), 403);
    const now = new Date().toISOString();
    database().insertNew('access_grants', { id: 'ag_live', request_id: null, entry_id: e.id, holder_id: mia.id, account: 'x', system: 'github-team', target: '{}', credential_id: null, status: 'active', since: now, until: null, approved_by: null, already_had: 0, attempts: 0, overdue_noted: 0, created_at: now, updated_at: now });
    await refused(() => deleteEntry(admin, e.id), 409, /disable it instead/);
    database().upsert('access_grants', { id: 'ag_live', request_id: null, entry_id: e.id, holder_id: mia.id, account: 'x', system: 'github-team', target: '{}', credential_id: null, status: 'expired', since: now, until: null, approved_by: null, already_had: 0, attempts: 0, overdue_noted: 0, created_at: now, updated_at: now });
    deleteEntry(admin, e.id);
    await refused(() => getEntry(admin, e.id), 404);
    expect(audited('access.entry.delete').map((e) => e.target?.id)).toEqual([e.id]);
  });
});
