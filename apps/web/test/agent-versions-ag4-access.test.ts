/**
 * AG21: who may do what with the agent versions a workflow pins. A workflow editor whose project only uses a shared agent
 * cannot publish that agent's draft through the workflow's publish (`agents: 'publish-first'`); the person is told whom to ask,
 * and the offer says so. The workflows that pin an agent's versions are listed only to people who can read them.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Workflow } from '@landflow/engine';
import { startFakeModels } from './fake-ai-services';

vi.setConfig({ testTimeout: 30_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-agent-versions-access-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const auth = await import('@/lib/server/auth');
const projects = await import('@/lib/server/projects');
const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { store } = await import('@/lib/server/store');
const { agentStore } = await import('@/lib/server/agents/store');
const publish = await import('@/lib/server/publish');
const { getPublication } = await import('@/lib/server/publications');
await import('@/lib/server/agents/publish-first');
const { draftOffer, listAgentUpdates } = await import('@/lib/server/assistant/publish-tools');
const { ALL_PROJECTS } = await import('@/lib/shared/projects');
const versionsRoute = await import('@/app/api/agents/[id]/versions/route');

registry.registerBuiltin(corePlugin);
const fake = await startFakeModels();
const base = fake.url.replace(/\/v1$/, '');

afterAll(async () => {
  await fake.close();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const model = { provider: 'ollama' as const, model: 'm', baseUrl: base };
const config = (rule: string) => ({ persona: { role: 'Triage', always: [rule] }, instructions: 'Answer briefly.', model });
const flow = (id: string, agentId: string): Workflow =>
  store.saveWorkflow({
    id,
    name: `Flow ${id}`,
    nodes: [
      { id: 'Start', name: 'Start', type: 'core.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
      { id: 'Agent', name: 'Agent', type: 'core.messageAgent', typeVersion: 1, position: [0, 0], parameters: { agentId, message: 'Check', conversation: 'new' } },
    ],
    connections: [{ id: 'a', type: 'main', source: 'Start', target: 'Agent', sourceIndex: 0, targetIndex: 0 }],
  });

let owner: { id: string; session: string };
let editor: { id: string; session: string };
let outsider: { id: string; session: string };
let mine = '';
let theirs = '';

async function makeUser(email: string, name: string, role: 'owner' | 'member') {
  const record = role === 'owner' ? await auth.createOwner({ email, name, password: 'password-123' }) : await auth.createUser({ email, name, role, password: 'password-123' });
  return { id: record.id, session: auth.createSession(record, 'password').token };
}

beforeAll(async () => {
  auth.disableTestAuth();
  owner = await makeUser('owner@example.com', 'Olive', 'owner');
  editor = await makeUser('editor@example.com', 'Ed', 'member');
  outsider = await makeUser('outsider@example.com', 'Out', 'member');
  mine = projects.createTeamProject({ name: 'Mine' }).id;
  theirs = projects.createTeamProject({ name: 'Theirs' }).id;
  projects.setMember(mine, editor.id, 'editor');
  projects.setMember(mine, outsider.id, 'editor');
  projects.setMember(theirs, owner.id, 'admin');
});

describe('agent versions and access', () => {
  it('a workflow editor cannot publish a shared, use-only agent through the workflow: 403 with whom to ask, nothing published', async () => {
    const shared = agentStore.create({ name: 'Shared triager', ...config('rule v1') });
    agentStore.publish(shared.id);
    projects.setHomeProject('agent', shared.id, theirs);
    projects.addShare('agent', shared.id, mine, 'user');
    flow('wf_access', shared.id);
    projects.setHomeProject('workflow', 'wf_access', mine);
    await publish.publishDraft('wf_access', owner.id);
    agentStore.saveDraft(shared.id, config('rule v2 in progress'));

    const offer = draftOffer('wf_access', editor.id)!;
    expect(offer.blocks).toMatchObject([{ name: 'Shared triager', canPublish: false }]);
    await expect(publish.publishDraft('wf_access', editor.id, undefined, { agents: 'publish-first' })).rejects.toMatchObject({ status: 403, code: 'agent_publish_forbidden', message: expect.stringContaining('Ask the owners of “Shared triager”') });
    await expect(publish.publishDraft('wf_access', editor.id)).rejects.toMatchObject({ status: 409, code: 'agent_changes_unpublished' });
    expect(agentStore.get(shared.id)!.published!.version).toBe(1);

    // Someone who may change the agent can.
    expect(draftOffer('wf_access', owner.id)!.blocks).toMatchObject([{ canPublish: true }]);
    await publish.publishDraft('wf_access', owner.id, undefined, { agents: 'publish-first' });
    expect(agentStore.get(shared.id)!.published!.version).toBe(2);
    expect(getPublication('wf_access')).toBeDefined();
  });

  it('the workflows that pin an agent are listed only to people who can read them (the versions route and Spotlight)', async () => {
    const shared = agentStore.create({ name: 'Everyone’s agent', ...config('rule v1') });
    agentStore.publish(shared.id);
    projects.setHomeProject('agent', shared.id, theirs);
    projects.addShare('agent', shared.id, ALL_PROJECTS, 'user');
    flow('wf_secret', shared.id);
    projects.setHomeProject('workflow', 'wf_secret', theirs);
    await publish.publishDraft('wf_secret', owner.id);
    flow('wf_seen', shared.id);
    projects.setHomeProject('workflow', 'wf_seen', mine);
    await publish.publishDraft('wf_seen', owner.id);
    agentStore.saveDraft(shared.id, config('rule v2'));
    agentStore.publish(shared.id);

    const read = async (session: string) => {
      const response = await versionsRoute.GET(new Request(`http://localhost:3000/api/agents/${shared.id}/versions`, { headers: { cookie: `landflow_session=${session}` } }), { params: Promise.resolve({ id: shared.id }) });
      expect(response.status, `${session === owner.session ? 'owner' : 'outsider'}: ${await response.clone().text()}`).toBe(200);
      const body = (await response.json()) as { versions: Array<{ usedBy: Array<{ workflowId: string }> }> };
      return body.versions.flatMap((v) => v.usedBy.map((u) => u.workflowId)).sort();
    };
    expect(await read(owner.session)).toEqual(['wf_secret', 'wf_seen']);
    expect(await read(outsider.session)).toEqual(['wf_seen']);

    // Spotlight's agent-scoped list keeps the same rule.
    const canRead = (workflowId: string) => workflowId === 'wf_seen';
    expect(listAgentUpdates({ agentId: shared.id }, canRead).updates.map((u) => u.workflowId)).toEqual(['wf_seen']);
    expect(listAgentUpdates({ agentId: shared.id }).updates.map((u) => u.workflowId).sort()).toEqual(['wf_secret', 'wf_seen']);
  });
});
