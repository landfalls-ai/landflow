/** A project as a Claude Code plugin (docs/marketplace.md#export-a-project): PROJECT.md, what is left out, who may export. */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const ENV = { LANDFLOW_DATA_DIR: mkdtempSync(join(tmpdir(), 'landflow-project-export-')), LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const route = await import('@/app/api/projects/[id]/export/route');
const { createUser } = await import('@/lib/server/auth/users');
const { enableTestAuth } = await import('@/lib/server/auth/test-bypass');
const projects = await import('@/lib/server/projects');
const goals = await import('@/lib/server/goals/store');
const { agentStore } = await import('@/lib/server/agents/store');
const { exportAgentPlugin, exportTeamPlugin } = await import('@/lib/server/marketplace/export');
const { projectMarkdown } = await import('@/lib/server/marketplace/project-export');
const { updateSettings } = await import('@/lib/server/settings');
const { unzipFiles } = await import('@/lib/server/zip');
const { FIXED } = await import('./export-snapshot');

afterAll(() => {
  enableTestAuth();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
type User = Awaited<ReturnType<typeof createUser>>;
const as = async <T>(user: User | undefined, fn: () => Promise<T>): Promise<T> => {
  enableTestAuth(user);
  try {
    return await fn();
  } finally {
    enableTestAuth();
  }
};
const exportOf = (id: string, query = '', user?: User) => as(user, () => route.GET(new Request(`http://localhost/api/projects/${id}/export${query}`), ctx(id)));
/** The exported files, as `user` (default: the project's lead, an editor; `null`: the instance owner). */
async function files(id: string, query = '', user: User | null = lead) {
  const res = await exportOf(id, query, user ?? undefined);
  expect(res.status).toBe(200);
  return new Map(unzipFiles(new Uint8Array(await res.arrayBuffer())).map((f) => [f.path, f.content.toString('utf8')]));
}

// Made-up people and ids that must never appear in a zip.
const LEAD = 'Zelda Quillfeather';
const DECIDER = 'Bartholomew Nightjar';
const GOAL_OWNER = 'Ottoline Gannet';
const BRIEF = 'Move the billing exports to the new ledger. It must not change what finance sees. Token sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 leaked.';

const lead = await createUser({ email: 'zelda@quill.test', name: LEAD, role: 'member', password: 'password-123' });
const decider = await createUser({ email: 'bart@nightjar.test', name: DECIDER, role: 'member', password: 'password-123' });
const goalOwner = await createUser({ email: 'otto@gannet.test', name: GOAL_OWNER, role: 'member', password: 'password-123' });
const viewer = await createUser({ email: 'vi@viewer.test', name: 'Vivian Viewer', role: 'member', password: 'password-123' });
const stranger = await createUser({ email: 'sam@stranger.test', name: 'Sam Stranger', role: 'member', password: 'password-123' });
updateSettings({ company: { mission: 'Make every invoice boring' } });

const project = projects.createTeamProject({ name: 'Billing Ledger', createdBy: lead.id });
projects.setMember(project.id, viewer.id, 'viewer');
projects.setMember(project.id, lead.id, 'editor');
projects.setMember(project.id, decider.id, 'editor');
projects.updateProjectBrief(project.id, { brief: BRIEF, constraints: 'No downtime.', doneWhen: 'Finance signs off.', glossary: 'Ledger: the books.', status: 'active', targetDate: '2026-12-31', leadId: lead.id, decisionOwnerId: decider.id });
const other = projects.createTeamProject({ name: 'Secret Skunkworks' });
const company = goals.createGoal({ title: 'Boring invoices', level: 'company', ownerId: goalOwner.id, targetDate: '2027-03-31', why: 'Calm finance' });
const sub = goals.createGoal({ title: 'Ledger migration', level: 'project', projectId: project.id, parentId: company.id, ownerId: goalOwner.id });
const hidden = goals.createGoal({ title: 'Skunkworks only', level: 'project', projectId: other.id }, [project.id]);

const agent = agentStore.create({
  name: 'Ledger Clerk',
  description: 'Reconciles the ledger.',
  instructions: 'Reconcile.',
  skills: [{ id: 'sk_clerk', name: 'Reconcile', whenToUse: 'Use when reconciling', instructions: '1. Match\n2. Report' }],
} as never);
projects.setHomeProject('agent', agent.id, project.id);
const shared = agentStore.create({ name: 'Shared Helper', instructions: 'Help.' } as never);
projects.setHomeProject('agent', shared.id, other.id);
projects.addShare('agent', shared.id, project.id, 'viewer');

describe('PROJECT.md', () => {
  it('is exact for a project with a brief, two goals and one home agent', async () => {
    const all = await files(project.id);
    expect(all.get('PROJECT.md')).toBe(
      [
        '---',
        'name: billing-ledger',
        'title: "Billing Ledger"',
        'status: "active"',
        'target: "2026-12-31"',
        'goals:',
        '  - title: "Boring invoices"',
        '    level: "company"',
        '    status: "active"',
        '  - title: "Ledger migration"',
        '    level: "project"',
        '    status: "active"',
        '---',
        '',
        '# Billing Ledger',
        '',
        'Move the billing exports to the new ledger. It must not change what finance sees. Token [redacted] leaked.',
        '',
        '## Constraints',
        '',
        'No downtime.',
        '',
        '## Done when',
        '',
        'Finance signs off.',
        '',
        '## Words we use',
        '',
        'Ledger: the books.',
        '',
        '## Fits under',
        '',
        'Company mission: Make every invoice boring.',
        'Goal (company): Boring invoices, by 2027-03-31.',
        '└ Goal (project): Ledger migration.',
        '',
        '## Agents',
        '',
        '- [Ledger Clerk](agents/ledger-clerk.md)',
        '',
      ].join('\n'),
    );
    expect([...all.keys()].sort()).toEqual(
      ['.claude-plugin/plugin.json', '.landflow/agents/ledger-clerk.json', '.landflow/project.json', 'PROJECT.md', 'README.md', 'agents/ledger-clerk.md', 'skills/reconcile/SKILL.md'].sort(),
    );
  });

  it('is pure: nothing but sections that are set', () => {
    expect(projectMarkdown({ name: 'Bare', project: { name: 'Bare' }, goals: [], agents: [] })).toBe('---\nname: bare\ntitle: "Bare"\n---\n\n# Bare\n');
  });
});

describe('the plugin', () => {
  it('names itself by the project and describes itself with the brief’s first sentence', async () => {
    const all = await files(project.id);
    const plugin = JSON.parse(all.get('.claude-plugin/plugin.json')!);
    expect(plugin).toMatchObject({ name: 'billing-ledger', description: 'Move the billing exports to the new ledger.', keywords: ['landflow', 'project'], agents: ['./agents/ledger-clerk.md'], skills: ['./skills/reconcile'] });
    expect(all.get('README.md')).toContain('PROJECT.md has its brief and goals');
    const bare = projects.createTeamProject({ name: 'Bare Project' });
    expect(JSON.parse((await files(bare.id, '', null)).get('.claude-plugin/plugin.json')!).description).toBe('Bare Project, a Landflow project.');
  });

  it('leaves out an agent that is only shared to the project', async () => {
    const all = await files(project.id);
    expect([...all.keys()].some((p) => p.includes('shared-helper'))).toBe(false);
  });

  it('keeps the goals in .landflow/project.json with parent indexes', async () => {
    const data = JSON.parse((await files(project.id)).get('.landflow/project.json')!);
    expect(data.kind).toBe('landflow/project');
    expect(data.agents).toEqual(['ledger-clerk']);
    expect(data.goals).toEqual([
      { title: 'Boring invoices', level: 'company', status: 'active', targetDate: '2027-03-31', why: 'Calm finance' },
      { title: 'Ledger migration', level: 'project', status: 'active', parent: 0 },
    ]);
    expect(data.project).toMatchObject({ name: 'Billing Ledger', constraints: 'No downtime.', status: 'active', targetDate: '2026-12-31' });
  });

  it('leaves out a goal the caller cannot see', async () => {
    const asViewer = JSON.parse((await files(project.id, '', viewer)).get('.landflow/project.json')!);
    expect(asViewer.goals.map((g: { title: string }) => g.title)).toEqual(['Boring invoices', 'Ledger migration']);
    const asOwner = JSON.parse((await files(project.id, '', null)).get('.landflow/project.json')!);
    // The instance owner sees every goal, so the one homed in another project shows for them.
    expect(asOwner.goals.map((g: { title: string }) => g.title)).toContain('Skunkworks only');
  });
});

describe('what never leaves', () => {
  it('has no person, email, id or secret anywhere in the zip', async () => {
    const all = await files(project.id, '?marketplace=1');
    const text = [...all.entries()].map(([path, content]) => `${path}\n${content}`).join('\n');
    for (const needle of [LEAD, DECIDER, GOAL_OWNER, 'Zelda', 'quill.test', 'nightjar.test', 'gannet.test', lead.id, decider.id, goalOwner.id, project.id, company.id, sub.id, hidden.id, agent.id, 'sk-ant-api03']) expect(text, needle).not.toContain(needle);
    expect(all.get('.landflow/project.json')).toContain('[redacted]');
    expect(text).not.toMatch(/\b(usr|goal|proj|agent)_[A-Za-z0-9]{6,}/);
  });
});

describe('the route', () => {
  it('lists the files with preview=1 and adds marketplace.json with marketplace=1', async () => {
    const preview = await (await exportOf(project.id, '?preview=1')).json();
    expect(preview.name).toBe('billing-ledger');
    expect(preview.files.map((f: { path: string }) => f.path)).toContain('PROJECT.md');
    expect(preview.files.map((f: { path: string }) => f.path)).not.toContain('.claude-plugin/marketplace.json');
    expect((await files(project.id, '?marketplace=1')).has('.claude-plugin/marketplace.json')).toBe(true);
    const res = await exportOf(project.id);
    expect(res.headers.get('content-disposition')).toContain('billing-ledger.zip');
    expect((await exportOf(project.id, '?format=tar')).status).toBe(400);
  });

  it('lets a viewer export and answers a non-member 404', async () => {
    expect((await exportOf(project.id, '', viewer)).status).toBe(200);
    const res = await exportOf(other.id, '', viewer);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('Project not found');
    expect((await exportOf('proj_nope')).status).toBe(404);
  });
});

describe('the agent and team exports', () => {
  it('stay byte-identical to what main wrote', () => {
    const before = JSON.parse(readFileSync(join(__dirname, 'fixtures/export-before.json'), 'utf8')) as Record<string, Array<{ path: string; content: string }>>;
    const a = agentStore.create(FIXED.alpha as never);
    const b = agentStore.create(FIXED.beta as never);
    const norm = (list: Array<{ path: string; content: string }>) => list.map((f) => ({ path: f.path, content: f.content.split(a.id).join('<A>').split(b.id).join('<B>') }));
    const team = { id: 't', name: 'Fixed team', goal: 'Ship it', members: [{ id: 'm_a', kind: 'agent', agentId: a.id, title: 'Lead' }, { id: 'm_b', kind: 'agent', agentId: b.id, title: 'Dev', reportsTo: 'm_a' }] };
    expect(norm(exportAgentPlugin(a, { marketplace: true, author: 'Me', version: '2.0.0' }).files)).toEqual(before.agent);
    expect(norm(exportAgentPlugin(a).files)).toEqual(before.agentPlain);
    expect(norm(exportTeamPlugin(team as never, { marketplace: true }).files)).toEqual(before.team);
  });
});
