/**
 * The join of a project's export (PC21) with the stores it must not leak (PC16's workspace, PC14's budget, PC19's tasks) and
 * with the agents' install: a real project with a brief, a lead and a decision owner, goals, a home agent, a shared agent, a
 * workspace with setup lines, a budget and tasks goes through the real route. The zip holds PROJECT.md and the home agent
 * only, no setup line, task title, budget, person's name, email or id appears in any file, and the exported agent installs
 * again through the marketplace.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const ENV = { LANDFLOW_DATA_DIR: mkdtempSync(join(tmpdir(), 'landflow-project-export-join-')), LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_MARKETPLACE_REGISTRY_URL: 'off', LANDFLOW_AUDIT_OUTBOX: 'off' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

// runtime.ts first: its side-effect registrations are the real ones.
await import('@/lib/server/runtime');
const route = await import('@/app/api/projects/[id]/export/route');
const { createUser } = await import('@/lib/server/auth/users');
const { enableTestAuth } = await import('@/lib/server/auth/test-bypass');
const projects = await import('@/lib/server/projects');
const goals = await import('@/lib/server/goals/store');
const { agentStore } = await import('@/lib/server/agents/store');
const { saveBudget } = await import('@/lib/server/budgets/store');
const { saveWorkspace } = await import('@/lib/server/projects/workspace');
const { createTask } = await import('@/lib/server/tasks/service');
const { viewerOf } = await import('@/lib/server/tasks/views');
const { unzipFiles } = await import('@/lib/server/zip');
const { marketplace } = await import('@/lib/server/marketplace/service');
const { clearTreeCache } = await import('@/lib/server/marketplace/reader');

afterAll(async () => {
  delete process.env.LANDFLOW_MARKETPLACE_ALLOW_LOCAL;
  enableTestAuth();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const LEAD = 'Zelda Quillfeather';
const DECIDER = 'Bartholomew Nightjar';
const lead = await createUser({ email: 'zelda@export-join.test', name: LEAD, role: 'member', password: 'password-123' });
const decider = await createUser({ email: 'bart@export-join.test', name: DECIDER, role: 'member', password: 'password-123' });
const SETUP = 'pnpm install --frozen-lockfile';
const TASK = 'Reconcile the October ledger';

const project = projects.createTeamProject({ name: 'Billing Ledger', createdBy: lead.id });
projects.setMember(project.id, lead.id, 'admin');
projects.setMember(project.id, decider.id, 'editor');
projects.updateProjectBrief(project.id, { brief: 'Move the billing exports to the new ledger.', constraints: 'No downtime.', doneWhen: 'Finance signs off.', glossary: '', status: 'active', targetDate: '2026-12-31', leadId: lead.id, decisionOwnerId: decider.id });
projects.setProjectRepos(project.id, ['acme/ledger']);
saveWorkspace({ id: lead.id, role: 'member' }, project.id, { repos: { 'acme/ledger': { defaultBranch: 'develop', setup: [SETUP] } }, worktree: 'per-run', branchTemplate: 'landflow/{project}/{run}' });
saveBudget({ projectId: project.id, monthlyUsd: 123.45, warnPercent: 80, hardStop: true });
const company = goals.createGoal({ title: 'Boring invoices', level: 'company', ownerId: decider.id });
const sub = goals.createGoal({ title: 'Ledger migration', level: 'project', projectId: project.id, parentId: company.id, ownerId: lead.id });
const other = projects.createTeamProject({ name: 'Secret Skunkworks' });
const clerk = agentStore.create({ name: 'Ledger Clerk', description: 'Reconciles the ledger.', instructions: 'Reconcile.', persona: { role: 'Bookkeeper' } } as never);
projects.setHomeProject('agent', clerk.id, project.id);
const shared = agentStore.create({ name: 'Shared Helper', instructions: 'Help.' } as never);
projects.setHomeProject('agent', shared.id, other.id);
projects.putShare('agent', shared.id, project.id, 'viewer');
const task = createTask(viewerOf({ id: lead.id, role: 'member' }, project.id)!, projects.getProject(project.id)!, { title: TASK, assignee: { kind: 'agent', id: clerk.id } } as never);

async function exported() {
  enableTestAuth(lead);
  try {
    const res = await route.GET(new Request(`http://localhost/api/projects/${project.id}/export?marketplace=1`), { params: Promise.resolve({ id: project.id }) });
    expect(res.status).toBe(200);
    return unzipFiles(new Uint8Array(await res.arrayBuffer())).map((f) => ({ path: f.path, content: f.content.toString('utf8') }));
  } finally {
    enableTestAuth();
  }
}

describe('the export of a furnished project', () => {
  it('has PROJECT.md with the brief and the goals, and only the home agent', async () => {
    const files = await exported();
    const paths = files.map((f) => f.path).sort();
    expect(paths).toEqual(['.claude-plugin/marketplace.json', '.claude-plugin/plugin.json', '.landflow/agents/ledger-clerk.json', '.landflow/project.json', 'PROJECT.md', 'README.md', 'agents/ledger-clerk.md']);
    const md = files.find((f) => f.path === 'PROJECT.md')!.content;
    expect(md).toContain('Move the billing exports to the new ledger.');
    expect(md).toContain('Goal (company): Boring invoices');
    expect(md).toContain('└ Goal (project): Ledger migration.');
    expect(md).toContain('[Ledger Clerk](agents/ledger-clerk.md)');
  });

  it('has no setup line, task, budget, person, email or id in any file or path', async () => {
    const files = await exported();
    const text = files.map((f) => `${f.path}\n${f.content}`).join('\n');
    for (const needle of [SETUP, TASK, task.id, '123.45', 'monthlyUsd', 'acme/ledger', 'develop', LEAD, DECIDER, 'Zelda', 'Nightjar', 'export-join.test', lead.id, decider.id, project.id, company.id, sub.id, clerk.id, shared.id, other.id, 'Shared Helper', 'Skunkworks'])
      expect(text, needle).not.toContain(needle);
    expect(text).not.toMatch(/\b(usr|goal|prj|ag|tsk|trn|cred)_[A-Za-z0-9_-]{6,}/);
    expect(files.some((f) => /task|workspace|budget/i.test(f.path))).toBe(false);
  });
});

describe('installing the exported project', () => {
  it('creates the home agent again, with its persona, and uninstall removes it', async () => {
    const files = await exported();
    const root = mkdtempSync(join(tmpdir(), 'landflow-project-export-root-'));
    for (const file of files) {
      mkdirSync(dirname(join(root, file.path)), { recursive: true });
      writeFileSync(join(root, file.path), file.content);
    }
    process.env.LANDFLOW_MARKETPLACE_ALLOW_LOCAL = '1';
    clearTreeCache();
    agentStore.delete(clerk.id);
    const added = await marketplace.add(root);
    try {
      const result = (await marketplace.install(added.id, 'billing-ledger')) as { installed: { id: string; agents: Array<{ id: string; name: string }> } };
      expect(result.installed.agents.map((a) => a.name)).toEqual(['Ledger Clerk']);
      const again = agentStore.get(result.installed.agents[0].id)!;
      expect(again.persona).toMatchObject({ role: 'Bookkeeper' });
      expect(again.instructions).toBe('Reconcile.');
      await marketplace.uninstall(result.installed.id);
      expect(agentStore.get(again.id)).toBeUndefined();
    } finally {
      await marketplace.remove(added.id);
    }
  });
});
