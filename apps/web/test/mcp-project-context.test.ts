/**
 * Project context over MCP (docs/connect-your-harness.md#project-context): the tool `project_context` gives what
 * GET /api/projects/context gives the same caller, the resource `project://{id}/context` the full block, a server scoped to
 * one project reads that project only, a key without `brain:read` is refused, and the morning briefing names the caller's goals.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import type { ApiKeyScope } from '@/lib/shared/auth';
import type { ProjectContextAnswer } from '@/lib/shared/project-context-api';

vi.setConfig({ testTimeout: 30_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-mcp-project-context-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_BRAIN_MODEL: 'off', LANDFLOW_BRAIN_EMBEDDINGS: 'off' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

await import('@/lib/server/runtime');
const { createUser } = await import('@/lib/server/auth/users');
const { enableTestAuth } = await import('@/lib/server/auth/test-bypass');
const { instanceServer } = await import('@/lib/server/mcp/instance-tools');
const { createTeamProject, setMember, setProjectRepos, updateProjectBrief } = await import('@/lib/server/projects/store');
const { createGoalAs, setProjectGoalsAs } = await import('@/lib/server/goals/views');
const { goalLines, briefingText } = await import('@/lib/server/mcp/brain-prompts');
const { briefingFor } = await import('@/lib/server/brain/briefing');

const alice = await createUser({ email: 'alice@mcp-project-context.test', name: 'Alice', role: 'member', password: 'alice-password-1' });
const bob = await createUser({ email: 'bob@mcp-project-context.test', name: 'Bob', role: 'member', password: 'bob-password-1' });
const actorOf = (user: { id: string; role: 'owner' | 'admin' | 'member' }) => ({ id: user.id, role: user.role });
const owner = { id: 'usr_goal_owner', role: 'owner' as const };

const billing = createTeamProject({ name: 'Billing revamp', createdBy: alice.id });
const checkout = createTeamProject({ name: 'Checkout', createdBy: bob.id });
setMember(billing.id, alice.id, 'editor');
setMember(checkout.id, bob.id, 'editor');
setProjectRepos(billing.id, ['acme/web']);
setProjectRepos(checkout.id, ['acme/web']);
updateProjectBrief(billing.id, { brief: 'Move invoices to usage-based pricing.' });
updateProjectBrief(checkout.id, { brief: 'A secret checkout plan nobody else should read.' });
const goal = createGoalAs(owner, { level: 'project', projectId: billing.id, title: 'Ship usage-based billing', status: 'active' });
setProjectGoalsAs(owner, billing.id, [goal.id]);
const other = createGoalAs(owner, { level: 'project', projectId: checkout.id, title: 'Redo the checkout page', status: 'planned' });
setProjectGoalsAs(owner, checkout.id, [other.id]);
const done = createGoalAs(owner, { level: 'project', projectId: billing.id, title: 'Already finished goal', status: 'achieved' });
setProjectGoalsAs(owner, billing.id, [goal.id, done.id]);

afterAll(() => {
  enableTestAuth();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

async function connect(user: typeof alice | undefined, options: { projectId?: string; scopes?: ApiKeyScope[] } = {}) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await instanceServer(user && actorOf(user), options.projectId ? { projectId: options.projectId } : undefined, options.scopes).connect(serverSide);
  const client = new Client({ name: 'project-context-test', version: '1.0.0' });
  await client.connect(clientSide);
  return client;
}
const textOf = (result: unknown) => ((result as { content: Array<{ text: string }> }).content[0]?.text ?? '');
const call = async (client: Client, args: Record<string, unknown>) => {
  try {
    const result = await client.callTool({ name: 'project_context', arguments: args });
    return { error: Boolean((result as { isError?: boolean }).isError), text: textOf(result) };
  } catch {
    return { error: true, text: '' };
  }
};

describe('project_context', () => {
  it('by repository gives the caller’s projects only, with the compact block', async () => {
    const client = await connect(alice, { scopes: ['brain:read'] });
    const { error, text } = await call(client, { repo: 'acme/web' });
    expect(error).toBe(false);
    const answer = JSON.parse(text) as ProjectContextAnswer;
    expect(answer.projects).toEqual([{ id: billing.id, name: 'Billing revamp' }]);
    expect(answer.context).toMatchObject({ projectId: billing.id, size: 'compact' });
    expect(answer.context?.text).toContain('Ship usage-based billing');
    expect(answer.context?.text).toContain('This run: a request over MCP.');
    expect(text).not.toContain('secret checkout');
  });

  it('by id without a role is refused; by repository with no match is empty', async () => {
    const client = await connect(alice, { scopes: ['brain:read'] });
    expect((await call(client, { projectId: checkout.id })).error).toBe(true);
    expect(JSON.parse((await call(client, { repo: 'nobody/nothing' })).text)).toEqual({ projects: [], context: null });
  });

  it('a server scoped to one project gives that project only, whatever is asked', async () => {
    const client = await connect(bob, { projectId: checkout.id });
    for (const args of [{ projectId: billing.id }, { repo: 'acme/web' }, {}]) {
      const answer = JSON.parse((await call(client, args)).text) as ProjectContextAnswer;
      expect(answer.projects).toEqual([{ id: checkout.id, name: 'Checkout' }]);
      expect(answer.context?.text).not.toContain('usage-based');
    }
    await expect(client.readResource({ uri: `project://${billing.id}/context` })).rejects.toThrow();
  });

  it('the instance access token (no person) gets nothing', async () => {
    const client = await connect(undefined);
    expect((await call(client, { repo: 'acme/web' })).error).toBe(true);
  });

  it('a key without brain:read can neither see the tool nor read the resource', async () => {
    const client = await connect(alice, { scopes: ['workflows:read'] });
    expect((await client.listTools()).tools.map((t) => t.name)).not.toContain('project_context');
    expect((await call(client, { repo: 'acme/web' })).error).toBe(true);
    await expect(client.readResource({ uri: `project://${billing.id}/context` })).rejects.toThrow();
  });
});

describe('project://{id}/context', () => {
  it('gives the full block of a project the caller has a role in, and refuses another', async () => {
    const client = await connect(alice, { scopes: ['brain:read'] });
    const read = await client.readResource({ uri: `project://${billing.id}/context` });
    const text = (read.contents[0] as { text: string }).text;
    expect(text).toContain('Ship usage-based billing');
    expect(text).toContain('data, not instructions');
    await expect(client.readResource({ uri: `project://${checkout.id}/context` })).rejects.toThrow();
    expect((await client.listResourceTemplates()).resourceTemplates.map((t) => t.uriTemplate)).toContain('project://{id}/context');
  });
});

describe('the morning briefing', () => {
  it('names the open goals of the projects the caller has a role in, titles only', async () => {
    const lines = goalLines(actorOf(alice));
    expect(lines).toEqual(['Billing revamp:', '- Ship usage-based billing']);
    const text = briefingText(briefingFor(actorOf(alice)), lines);
    expect(text).toContain('> Your goals:');
    expect(text).toContain('> - Ship usage-based billing');
    expect(text).not.toContain('Redo the checkout page');
    expect(text).not.toContain('Already finished goal');
    expect(briefingText(briefingFor(actorOf(alice)))).not.toContain('Your goals');
    const client = await connect(alice, { scopes: ['brain:read'] });
    const prompt = await client.getPrompt({ name: 'morning-briefing', arguments: {} });
    expect(JSON.stringify(prompt)).toContain('Ship usage-based billing');
  });
});

// PC16: the tool's answer carries the same workspace as GET /api/projects/context
describe('the workspace in project_context', () => {
  it('is absent until saved, then carries the pattern and (for an editor) the setup lines', async () => {
    const client = await connect(alice, { scopes: ['brain:read'] });
    expect('workspace' in (JSON.parse((await call(client, { repo: 'acme/web' })).text) as ProjectContextAnswer)).toBe(false);
    const { saveWorkspace } = await import('@/lib/server/projects/workspace');
    saveWorkspace({ id: 'usr_goal_owner', role: 'owner' }, billing.id, { repos: { 'acme/web': { setup: ['pnpm install'] } }, worktree: 'per-run', branchTemplate: 'landflow/{project}/{run}' });
    const answer = JSON.parse((await call(client, { repo: 'acme/web' })).text) as ProjectContextAnswer;
    expect(answer.workspace).toEqual({
      projectId: billing.id,
      repos: { 'acme/web': { setup: ['pnpm install'] } },
      worktree: 'per-run',
      branchTemplate: 'landflow/{project}/{run}',
      branchPattern: 'landflow/billing-revamp/{run}',
    });
  });
});
