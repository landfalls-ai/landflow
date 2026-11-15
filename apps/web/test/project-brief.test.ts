/** The project brief (docs/projects-and-goals.md#the-brief): PATCH /api/projects/:id with `brief`, who may change it, and what a rename keeps. */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-brief-'));
const ENV: Record<string, string> = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const auth = await import('@/lib/server/auth');
const projects = await import('@/lib/server/projects');
const projectRoute = await import('@/app/api/projects/[id]/route');

type Route = (request: Request, ctx?: { params: Promise<Record<string, string>> }) => Promise<Response>;
interface Caller {
  id: string;
  session: string;
}

async function call(method: string, id: string, caller: Caller, body?: unknown) {
  const route = (method === 'GET' ? projectRoute.GET : projectRoute.PATCH) as unknown as Route;
  const headers: Record<string, string> = { cookie: `landflow_session=${caller.session}` };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await route(new Request(`http://localhost:3000/api/projects/${id}`, { method, headers, ...(body !== undefined && { body: JSON.stringify(body) }) }), { params: Promise.resolve({ id }) });
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

async function makeUser(email: string, name: string, role: 'owner' | 'member'): Promise<Caller> {
  const record = role === 'owner' ? await auth.createOwner({ email, name, password: 'password-123' }) : await auth.createUser({ email, name, role, password: 'password-123' });
  return { id: record.id, session: auth.createSession(record, 'password').token };
}

let owner: Caller, alice: Caller, bob: Caller, carol: Caller, outsider: Caller;
let team = '';

beforeAll(async () => {
  auth.disableTestAuth();
  owner = await makeUser('owner@example.com', 'Olive Owner', 'owner');
  alice = await makeUser('alice@example.com', 'Alice', 'member');
  bob = await makeUser('bob@example.com', 'Bob', 'member');
  carol = await makeUser('carol@example.com', 'Carol', 'member');
  outsider = await makeUser('erin@example.com', 'Erin', 'member');
  team = projects.createTeamProject({ name: 'Data' }).id;
  projects.setMember(team, alice.id, 'admin');
  projects.setMember(team, bob.id, 'editor');
  projects.setMember(team, carol.id, 'viewer');
});

afterAll(() => {
  auth.enableTestAuth();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

describe('the project brief', () => {
  it('lets the instance owner, with no membership row, lead a team project', async () => {
    const res = await call('PATCH', team, owner, { brief: { leadId: owner.id, decisionOwnerId: owner.id } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.project.brief.leadName).toBe('Olive Owner');
    expect((await call('PATCH', team, owner, { brief: { leadId: 'nobody' } })).status).toBe(400);
    await call('PATCH', team, owner, { brief: { leadId: null, decisionOwnerId: null } });
  });

  it('starts empty, with the viewer’s right to edit', async () => {
    expect((await call('GET', team, alice)).body.project.brief).toMatchObject({ goals: [], canEdit: true });
    expect((await call('GET', team, carol)).body.project.brief.canEdit).toBe(false);
  });

  it('lets an admin set every field', async () => {
    const brief = { brief: 'Move reports to the warehouse', constraints: 'No new tools', doneWhen: 'Finance signs off', glossary: 'MRR: monthly recurring revenue', status: 'active', targetDate: '2027-03-31', leadId: bob.id, decisionOwnerId: alice.id };
    const set = await call('PATCH', team, alice, { brief });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(set.body.project.brief).toMatchObject({ ...brief, leadName: 'Bob', decisionOwnerName: 'Alice', canEdit: true });
    expect((await call('PATCH', team, owner, { brief: { brief: 'Owner edit' } })).body.project.brief.brief).toBe('Owner edit');
  });

  it('refuses editors, viewers and outsiders', async () => {
    expect((await call('PATCH', team, bob, { brief: { brief: 'x' } })).status).toBe(403);
    expect((await call('PATCH', team, carol, { brief: { brief: 'x' } })).status).toBe(403);
    expect((await call('PATCH', team, outsider, { brief: { brief: 'x' } })).status).toBe(404);
    expect((await call('GET', team, outsider)).status).toBe(404);
  });

  it('refuses a lead or decision owner who has no role in the project', async () => {
    const lead = await call('PATCH', team, alice, { brief: { leadId: outsider.id } });
    expect(lead.status).toBe(400);
    expect(lead.body.error).toMatch(/lead/i);
    expect((await call('PATCH', team, alice, { brief: { decisionOwnerId: outsider.id } })).status).toBe(400);
    expect((await call('PATCH', team, alice, { brief: { leadId: 'usr_missing' } })).status).toBe(400);
    expect((await call('GET', team, alice)).body.project.brief.leadId).toBe(bob.id);
  });

  it('checks sizes and values', async () => {
    expect((await call('PATCH', team, alice, { brief: { brief: 'x'.repeat(1501) } })).status).toBe(400);
    expect((await call('PATCH', team, alice, { brief: { doneWhen: 'x'.repeat(601) } })).status).toBe(400);
    expect((await call('PATCH', team, alice, { brief: { status: 'wild' } })).status).toBe(400);
    expect((await call('PATCH', team, alice, { brief: { targetDate: 'soon' } })).status).toBe(400);
  });

  it('clears a field with null and leaves the others', async () => {
    const cleared = await call('PATCH', team, alice, { brief: { constraints: null, leadId: null } });
    expect(cleared.status).toBe(200);
    const brief = cleared.body.project.brief;
    expect(brief.constraints).toBeUndefined();
    expect(brief.leadId).toBeUndefined();
    expect(brief.leadName).toBeUndefined();
    expect(brief.doneWhen).toBe('Finance signs off');
  });

  it('keeps the brief when the project is renamed', async () => {
    const renamed = await call('PATCH', team, alice, { name: 'Data platform', description: 'The warehouse team' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.project).toMatchObject({ name: 'Data platform', brief: { doneWhen: 'Finance signs off', status: 'active', decisionOwnerId: alice.id } });
    expect(projects.getProject(team)).toMatchObject({ name: 'Data platform', doneWhen: 'Finance signs off', glossary: 'MRR: monthly recurring revenue' });
  });

  it('keeps the brief on a personal project too', async () => {
    const personal = `personal_${alice.id}`;
    projects.ensurePersonalProject(alice.id);
    const set = await call('PATCH', personal, alice, { brief: { brief: 'My own work', leadId: alice.id } });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(set.body.project.brief.brief).toBe('My own work');
  });
});
