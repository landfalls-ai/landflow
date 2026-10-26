/**
 * Governance per project and per workflow (lib/server/governance/scopes.ts, ./policy.ts `scopedNodeBlocked`,
 * ./project-approvers.ts) and IPv6 in the HTTP host allow-list:
 *
 * - a project's node allow-list: saving warns, publishing is refused (422), a run fails at the node with where to
 *   change it, the node creator (`/api/node-types?workflowId=`) marks them blocked; other projects are untouched; only
 *   the project's admins change it (audited);
 * - a workflow's own policy: a stricter list than its project's, and four-eyes publishing for that workflow while the
 *   instance has it off; only admins of its project change it;
 * - who approves a project's publish requests: its admins, its admins and editors, or instance owners and admins;
 * - IPv6 addresses, CIDR ranges and `[addr]:port` in the HTTP Request host list.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Workflow, WorkflowNode } from '@landflow/engine';
import type { PublishRequestedResponse } from '@/lib/shared/governance';
import type { ProjectSettingsView, WorkflowPolicyView } from '@/lib/shared/project-policy';
import type { NodeTypeInfo } from '@/lib/shared/types';

vi.setConfig({ testTimeout: 20_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-project-governance-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_AUDIT_OUTBOX: 'off', LANDFLOW_PUBLIC_URL: 'http://project-gov.test' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { store } = await import('@/lib/server/store');
const { runWorkflow } = await import('@/lib/server/runner');
const { publishedVersionId } = await import('@/lib/server/publications');
const { createUser } = await import('@/lib/server/auth/users');
const { enableTestAuth } = await import('@/lib/server/auth/test-bypass');
const policy = await import('@/lib/server/governance/policy');
const projects = await import('@/lib/server/projects');
const { queryEvents } = await import('@/lib/server/audit/store');
const workflowsRoute = await import('@/app/api/workflows/route');
const workflowRoute = await import('@/app/api/workflows/[id]/route');
const publishRoute = await import('@/app/api/workflows/[id]/publish/route');
const policyRoute = await import('@/app/api/workflows/[id]/policy/route');
const settingsRoute = await import('@/app/api/projects/[id]/settings/route');
const nodeTypesRoute = await import('@/app/api/node-types/route');
const approveRoute = await import('@/app/api/publish-requests/[id]/approve/route');

registry.registerBuiltin(corePlugin);

type User = Awaited<ReturnType<typeof createUser>>;
let alice: User; // the team's admin
let bob: User; // its editor
let erin: User; // another editor
let carol: User; // its viewer
let admin: User; // an instance admin
let team = '';
let ops = '';

beforeAll(async () => {
  alice = await createUser({ email: 'alice@project-gov.test', name: 'Alice', role: 'member', password: 'alice-password-1' });
  bob = await createUser({ email: 'bob@project-gov.test', name: 'Bob', role: 'member', password: 'bob-password-1' });
  erin = await createUser({ email: 'erin@project-gov.test', name: 'Erin', role: 'member', password: 'erin-password-1' });
  carol = await createUser({ email: 'carol@project-gov.test', name: 'Carol', role: 'member', password: 'carol-password-1' });
  admin = await createUser({ email: 'admin@project-gov.test', name: 'Ada', role: 'admin', password: 'admin-password-1' });
  team = projects.createTeamProject({ name: 'Payments' }).id;
  projects.setMember(team, alice.id, 'admin');
  projects.setMember(team, bob.id, 'editor');
  projects.setMember(team, erin.id, 'editor');
  projects.setMember(team, carol.id, 'viewer');
  ops = projects.createTeamProject({ name: 'Ops' }).id;
  projects.setMember(ops, bob.id, 'editor');
});

afterAll(() => {
  enableTestAuth();
  policy.updateGovernancePolicy({ fourEyes: { enabled: false } } as never);
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const params = <T>(value: T) => ({ params: Promise.resolve(value) });
const req = (method: string, url: string, body?: unknown) =>
  new Request(`http://project-gov.test${url}`, { method, ...(body !== undefined && { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) });
async function as<T>(user: User | undefined, fn: () => Promise<T>): Promise<T> {
  enableTestAuth(user);
  try {
    return await fn();
  } finally {
    enableTestAuth();
  }
}
async function body<T = Record<string, any>>(response: Response): Promise<{ status: number; body: T }> {
  return { status: response.status, body: (await response.json()) as T };
}

const node = (id: string, type: string, parameters: Record<string, unknown> = {}, x = 0): WorkflowNode => ({ id, name: id, type, typeVersion: 1, position: [x, 0], parameters });
const edge = (source: string, target: string) => ({ id: `${source}-${target}`, type: 'main' as const, source, target, sourceIndex: 0, targetIndex: 0 });
const setNode = (id = 'Set') => node(id, 'core.set', { mode: 'manual', includeOtherFields: false, fields: { values: [{ name: 'v', type: 'string', value: 'x' }] } }, 200);
const codeNode = (id = 'Code') => node(id, 'core.code', { jsCode: 'return [{ json: { ran: true } }];' }, 400);
const manual = (name: string, nodes: WorkflowNode[]) => {
  const all = [node('Start', 'core.manualTrigger'), ...nodes];
  return { name, nodes: all, connections: all.slice(1).map((n, i) => edge(all[i].name, n.name)) };
};
const nodeError = (record: unknown, name: string) => (record as { runData?: Record<string, Array<{ error?: { message: string; description?: string } }>> }).runData?.[name]?.[0]?.error;

/** A workflow created through the API by `user` in `projectId`, with its save's governance warnings. */
async function create(user: User, projectId: string, workflow: ReturnType<typeof manual>) {
  const created = await body<{ workflow: Workflow; policyWarnings?: Array<{ nodeName: string; rule: string; message: string }> }>(
    await as(user, () => workflowsRoute.POST(req('POST', `/api/workflows?projectId=${projectId}`, workflow))),
  );
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return created.body;
}
const patchSettings = async (user: User, projectId: string, patch: unknown) =>
  body<ProjectSettingsView & { error?: string }>(await as(user, () => settingsRoute.PATCH(req('PATCH', `/api/projects/${projectId}/settings`, patch), params({ id: projectId }))));
const putPolicy = async (user: User, workflowId: string, patch: unknown) =>
  body<WorkflowPolicyView & { error?: string }>(await as(user, () => policyRoute.PUT(req('PUT', `/api/workflows/${workflowId}/policy`, patch), params({ id: workflowId }))));
const publish = async (user: User, workflowId: string) =>
  body<PublishRequestedResponse & { error?: string }>(await as(user, () => publishRoute.POST(req('POST', `/api/workflows/${workflowId}/publish`, {}), params({ id: workflowId }))));
const nodeTypes = async (user: User, query: string) =>
  (await body<{ nodeTypes: NodeTypeInfo[] }>(await as(user, () => nodeTypesRoute.GET(req('GET', `/api/node-types${query}`))))).body.nodeTypes;

describe('IPv6 in the HTTP host allow-list', () => {
  it('matches IPv6 addresses, CIDR ranges, bracketed hosts with ports and IPv4-mapped addresses', () => {
    expect(policy.hostMatches('2001:db8::/32', '2001:db8::1')).toBe(true);
    expect(policy.hostMatches('2001:db8::/32', '[2001:db8:0:1::5]')).toBe(true);
    expect(policy.hostMatches('2001:db8::/32', '2001:db9::1')).toBe(false);
    expect(policy.hostMatches('fd00::/8', 'fd12:3456::1')).toBe(true);
    expect(policy.hostMatches('fd00::/8', 'fe80::1')).toBe(false);
    expect(policy.hostMatches('::1', '[::1]')).toBe(true);
    expect(policy.hostMatches('[::1]:8080', '[::1]', '8080')).toBe(true);
    expect(policy.hostMatches('[::1]:8080', '[::1]', '9090')).toBe(false);
    expect(policy.hostMatches('2001:DB8::1', '2001:db8:0:0:0:0:0:1')).toBe(true);
    // An IPv4-mapped IPv6 address is that IPv4 address.
    expect(policy.hostMatches('10.0.0.0/8', '[::ffff:10.1.2.3]')).toBe(true);
    expect(policy.hostMatches('::ffff:0:0/96', '10.1.2.3')).toBe(true);
    // Host names and IPv4 work as before.
    expect(policy.hostMatches('10.0.0.0/8', '10.20.30.40')).toBe(true);
    expect(policy.hostMatches('*.example.com', 'api.example.com')).toBe(true);
    expect(policy.hostMatches('2001:db8::/32', 'example.com')).toBe(false);
  });

  it('checks URLs with IPv6 hosts against the list', () => {
    const allow = { ...policy.getGovernancePolicy(), http: { mode: 'allow' as const, hosts: ['2001:db8::/32', '[::1]:8080'] } };
    expect(policy.httpUrlBlocked('http://[2001:db8::7]/orders', allow)).toBeUndefined();
    expect(policy.httpUrlBlocked('http://[::1]:8080/health', allow)).toBeUndefined();
    expect(policy.httpUrlBlocked('http://[::1]:9090/health', allow)).toMatch(/not allowed on this instance/);
    expect(policy.httpUrlBlocked('http://[2001:db9::7]/orders', allow)).toMatch(/not allowed/);
    const block = { ...policy.getGovernancePolicy(), http: { mode: 'block' as const, hosts: ['fd00::/8'] } };
    expect(policy.httpUrlBlocked('https://[fd00::10]/', block)).toMatch(/blocked on this instance/);
    expect(policy.httpUrlBlocked('https://[2001:db8::1]/', block)).toBeUndefined();
  });
});

describe('a project’s allowed nodes', () => {
  it('is changed by the project’s admins only, and audited', async () => {
    const view = await body<ProjectSettingsView>(await as(carol, () => settingsRoute.GET(req('GET', `/api/projects/${team}/settings`), params({ id: team }))));
    expect(view.status).toBe(200);
    expect(view.body).toMatchObject({ canEdit: false, settings: { nodes: { mode: 'off' }, approvers: 'default' } });
    expect(view.body.nodeTypes.some((t) => t.type === 'core.code')).toBe(true);
    expect((await patchSettings(bob, team, { nodes: { mode: 'allow', types: ['core.set'] } })).status).toBe(403);
    expect((await patchSettings(carol, team, { approvers: 'editors' })).status).toBe(403);
    expect((await patchSettings(alice, team, { nodes: { mode: 'sometimes' } })).status).toBe(400);
    const saved = await patchSettings(alice, team, { nodes: { mode: 'allow', types: ['core.manualTrigger', 'core.set', ' core.set '] } });
    expect(saved.status).toBe(200);
    expect(saved.body.settings.nodes).toEqual({ mode: 'allow', plugins: [], types: ['core.manualTrigger', 'core.set'] });
    expect(queryEvents({ action: ['project.settings.update'] }, { limit: 1 }).events[0]).toMatchObject({ target: { type: 'project', id: team }, details: { nodesMode: 'allow' } });
  });

  it('warns at save, refuses to publish, fails the node at run time and hides it from the node creator', async () => {
    const { workflow, policyWarnings } = await create(bob, team, manual('TMP project list', [setNode(), codeNode()]));
    expect(policyWarnings).toEqual([expect.objectContaining({ nodeName: 'Code', rule: 'node', message: expect.stringContaining('“Payments” project’s list of allowed nodes') })]);

    const refused = await publish(bob, workflow.id);
    expect(refused.status).toBe(422);
    expect(refused.body.error).toMatch(/can’t be published: “Code”: core\.code is not on the “Payments” project’s list/);
    expect(publishedVersionId(workflow.id)).toBeUndefined();

    const record = await runWorkflow({ workflow: store.getWorkflow(workflow.id)!, mode: 'manual' });
    expect(record.status).toBe('error');
    expect(nodeError(record, 'Code')).toMatchObject({ message: expect.stringMatching(/^Blocked by policy: core\.code is not on the “Payments” project’s list/), description: expect.stringContaining('project’s settings') });
    expect(nodeError(record, 'Set')).toBeUndefined();

    // The node creator, for this workflow: Code is blocked; for the instance (no workflow) it isn't.
    const scoped = await nodeTypes(bob, `?workflowId=${workflow.id}`);
    expect(scoped.find((t) => t.type === 'core.code')?.blocked).toMatch(/“Payments” project’s list/);
    expect(scoped.find((t) => t.type === 'core.set')?.blocked).toBeUndefined();
    expect((await nodeTypes(bob, `?projectId=${team}`)).find((t) => t.type === 'core.code')?.blocked).toBeDefined();
    expect((await nodeTypes(bob, '')).find((t) => t.type === 'core.code')?.blocked).toBeUndefined();
  });

  it('leaves other projects alone, and lets plugins in by id', async () => {
    const { workflow, policyWarnings } = await create(bob, ops, manual('TMP other project', [setNode(), codeNode()]));
    expect(policyWarnings).toBeUndefined();
    expect((await runWorkflow({ workflow: store.getWorkflow(workflow.id)!, mode: 'manual' })).status).toBe('success');

    expect((await patchSettings(alice, team, { nodes: { plugins: ['core'] } })).status).toBe(200);
    const again = await create(bob, team, manual('TMP plugin listed', [codeNode()]));
    expect(again.policyWarnings).toBeUndefined();
    expect((await runWorkflow({ workflow: store.getWorkflow(again.workflow.id)!, mode: 'manual' })).status).toBe('success');
    expect((await patchSettings(alice, team, { nodes: { mode: 'off', plugins: [], types: [] } })).status).toBe(200);
  });
});

describe('a workflow’s own policy', () => {
  it('narrows its project’s list, and only admins of its project change it', async () => {
    const { workflow } = await create(bob, team, manual('TMP stricter', [setNode()]));
    expect((await runWorkflow({ workflow: store.getWorkflow(workflow.id)!, mode: 'manual' })).status).toBe('success');
    const read = await body<WorkflowPolicyView>(await as(bob, () => policyRoute.GET(req('GET', `/api/workflows/${workflow.id}/policy`), params({ id: workflow.id }))));
    expect(read.body).toMatchObject({ canEdit: false, instanceFourEyes: false, policy: { fourEyes: false, nodes: { mode: 'off' } }, project: { id: team, name: 'Payments' } });

    expect((await putPolicy(bob, workflow.id, { nodes: { mode: 'allow', types: ['core.manualTrigger'] } })).status).toBe(403);
    const saved = await putPolicy(alice, workflow.id, { nodes: { mode: 'allow', types: ['core.manualTrigger'] } });
    expect(saved.status).toBe(200);
    expect(saved.body.policy.nodes).toEqual({ mode: 'allow', plugins: [], types: ['core.manualTrigger'] });
    expect(queryEvents({ action: ['workflow.policy.update'] }, { limit: 1 }).events[0]).toMatchObject({ target: { id: workflow.id } });

    const record = await runWorkflow({ workflow: store.getWorkflow(workflow.id)!, mode: 'manual' });
    expect(nodeError(record, 'Set')?.message).toMatch(/core\.set is not on this workflow’s list of allowed nodes/);
    expect(nodeError(record, 'Set')?.description).toMatch(/Workflow settings → Governance/);
    expect((await publish(bob, workflow.id)).status).toBe(422);
    expect((await nodeTypes(bob, `?workflowId=${workflow.id}`)).find((t) => t.type === 'core.set')?.blocked).toMatch(/this workflow’s list/);

    // Switching it off removes the policy.
    expect((await putPolicy(alice, workflow.id, { nodes: { mode: 'off', types: [] } })).body.policy).toMatchObject({ fourEyes: false, nodes: { mode: 'off' } });
    expect((await runWorkflow({ workflow: store.getWorkflow(workflow.id)!, mode: 'manual' })).status).toBe('success');
  });

  it('asks for four-eyes publishing of that workflow while the instance has it off', async () => {
    policy.updateGovernancePolicy({ fourEyes: { enabled: false } } as never);
    const guarded = (await create(bob, team, manual('TMP four eyes', [setNode()]))).workflow;
    const free = (await create(bob, team, manual('TMP no four eyes', [setNode()]))).workflow;
    expect((await putPolicy(alice, guarded.id, { fourEyes: true })).body.policy.fourEyes).toBe(true);

    const asked = await publish(bob, guarded.id);
    expect(asked.status).toBe(202);
    expect(asked.body.approvalRequired).toBe(true);
    expect(publishedVersionId(guarded.id)).toBeUndefined();
    expect((await publish(bob, free.id)).status).toBe(200);
    expect(publishedVersionId(free.id)).toBeDefined();

    // Bob can't approve his own request; Erin (an editor, the instance's rule) can.
    const self = await as(bob, () => approveRoute.POST(req('POST', `/api/publish-requests/${asked.body.request.id}/approve`), params({ id: asked.body.request.id })));
    expect(self.status).toBe(403);
    const approved = await body(await as(erin, () => approveRoute.POST(req('POST', `/api/publish-requests/${asked.body.request.id}/approve`), params({ id: asked.body.request.id }))));
    expect(approved.status).toBe(200);
    expect(publishedVersionId(guarded.id)).toBeDefined();
  });
});

describe('who approves a project’s publish requests', () => {
  const approve = async (user: User, id: string) => body<{ error?: string }>(await as(user, () => approveRoute.POST(req('POST', `/api/publish-requests/${id}/approve`), params({ id }))));
  async function requestFor(name: string) {
    const { workflow } = await create(bob, team, manual(name, [setNode()]));
    const asked = await publish(bob, workflow.id);
    expect(asked.status).toBe(202);
    return asked.body.request.id;
  }

  it('narrows the instance’s rule to the project’s admins, its admins and editors, or the instance’s admins', async () => {
    policy.updateGovernancePolicy({ fourEyes: { enabled: true, approverRole: 'member', unpublish: true, notifyEmail: false, channelIds: [] } } as never);
    try {
      expect((await patchSettings(alice, team, { approvers: 'admins' })).body.settings.approvers).toBe('admins');
      let id = await requestFor('TMP admins approve');
      const refused = await approve(erin, id);
      expect(refused.status).toBe(403);
      expect(refused.body.error).toMatch(/an admin of “Payments”/);
      expect((await approve(carol, id)).status).toBe(403);
      expect((await approve(alice, id)).status).toBe(200);

      await patchSettings(alice, team, { approvers: 'editors' });
      id = await requestFor('TMP editors approve');
      expect((await approve(carol, id)).status).toBe(403);
      expect((await approve(erin, id)).status).toBe(200);

      await patchSettings(alice, team, { approvers: 'instance' });
      id = await requestFor('TMP instance approves');
      expect((await approve(alice, id)).status).toBe(403);
      expect((await approve(admin, id)).status).toBe(200);

      // `default`: the instance's rule (members may approve) decides again.
      await patchSettings(alice, team, { approvers: 'default' });
      id = await requestFor('TMP default approves');
      expect((await approve(erin, id)).status).toBe(200);
    } finally {
      policy.updateGovernancePolicy({ fourEyes: { enabled: false } } as never);
    }
  });
});
