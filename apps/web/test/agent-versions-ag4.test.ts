/**
 * AG21: workflow versions pin agent versions (docs/features/editor.md#publishing-pins-the-agents). Publishing pins each bound
 * agent at its published version; production keeps it until a republish; the editor tests the draft; an agent draft that
 * differs refuses the publish; every run records both versions; "vN is available" is tested, then published; a version older
 * than the 20 kept in `history` still runs; the backfill pins what production runs today and changes nothing twice.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { Workflow, WorkflowNode } from '@landflow/engine';
import { runVersionsLine } from '@/lib/shared/agent-versions';
import { startFakeModels } from './fake-ai-services';

vi.setConfig({ testTimeout: 30_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-agent-versions-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_PUBLIC_URL: 'http://versions.test' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { store } = await import('@/lib/server/store');
const { runWorkflow } = await import('@/lib/server/runner');
const { agentStore } = await import('@/lib/server/agents/store');
const publish = await import('@/lib/server/publish');
const { getPublication } = await import('@/lib/server/publications');
const { database } = await import('@/lib/server/db');
const versions = await import('@/lib/server/agents/versions');
await import('@/lib/server/agents/publish-first'); // registers publishing an agent first (the publish route imports it)
const { listVersions } = await import('@/lib/server/versions');
const publishRoute = await import('@/app/api/workflows/[id]/publish/route');
const executionRoute = await import('@/app/api/executions/[id]/route');

registry.registerBuiltin(corePlugin);
const fake = await startFakeModels();

afterAll(async () => {
  await fake.close();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const base = fake.url.replace(/\/v1$/, '');
const node = (id: string, type: string, parameters: Record<string, unknown> = {}): WorkflowNode => ({ id, name: id, type, typeVersion: 1, position: [0, 0], parameters });
const edge = (source: string, target: string) => ({ id: `${source}-${target}`, type: 'main' as const, source, target, sourceIndex: 0, targetIndex: 0 });
const params = <T>(value: T) => ({ params: Promise.resolve(value) });

/** A published agent whose first rule says which version it is, so the scripted model shows it. */
function makeAgent(name: string, rule = 'rule one') {
  const agent = agentStore.create({ name, persona: { role: 'Triage', always: [rule] }, instructions: 'Answer briefly.', model: { provider: 'ollama', model: 'm', baseUrl: base } });
  agentStore.publish(agent.id);
  return agent;
}
const edit = (id: string, rule: string) => agentStore.saveDraft(id, { persona: { role: 'Triage', always: [rule] }, instructions: 'Answer briefly.', model: { provider: 'ollama', model: 'm', baseUrl: base } });

function flow(id: string, agentId: string, extra: WorkflowNode[] = []): Workflow {
  const wf: Workflow = {
    id,
    name: `Flow ${id}`,
    nodes: [node('Start', 'core.manualTrigger'), node('Agent', 'core.messageAgent', { agentId, message: 'Check this alert', conversation: 'new' }), ...extra],
    connections: [edge('Start', 'Agent')],
  };
  return store.saveWorkflow(wf);
}

/** The system prompt the scripted model saw on the newest agent call. */
const lastSystem = () => String(fake.requests.at(-1)!.body.messages[0].content);
const prod = (id: string) => publish.productionWorkflowById(id)!;
const runProduction = (id: string) => runWorkflow({ workflow: prod(id), mode: 'webhook', startNodeId: 'Start', triggerItems: [{ json: { a: 1 } }] });
const runEditor = (id: string) => runWorkflow({ workflow: store.getWorkflow(id)!, mode: 'manual', startNodeId: 'Start' });
const linesOf = async (record: { executionId: string }) => {
  const response = await executionRoute.GET(new Request('http://versions.test/x'), params({ id: record.executionId }));
  const { execution } = (await response.json()) as { execution: { versions: Parameters<typeof runVersionsLine>[0] } };
  return runVersionsLine(execution.versions);
};

describe('a workflow version pins its agents', () => {
  it('pins at publish; production keeps v1 after the agent publishes v2; the editor tests the draft', async () => {
    const s1 = makeAgent('Alert triager', 'rule v1');
    flow('wf_pin', s1.id);
    await publish.publishDraft('wf_pin', 'owner');
    const published = getPublication('wf_pin')!.versionId;
    expect(versions.pinsFor(published)).toMatchObject([{ nodeId: 'Agent', agentId: s1.id, version: 1 }]);
    // The agent moves on: v2 published, then a draft v3 in progress.
    edit(s1.id, 'rule v2');
    agentStore.publish(s1.id);
    edit(s1.id, 'rule draft');

    const production = await runProduction('wf_pin');
    expect(production.status).toBe('success');
    expect(lastSystem()).toContain('rule v1');
    expect(await linesOf(production)).toBe('workflow v1 · Alert triager v1');
    expect(versions.runVersions(production.executionId)!.agents).toMatchObject([{ agentId: s1.id, version: 1, source: 'pinned' }]);

    // The editor runs the agent's draft.
    const manual = await runEditor('wf_pin');
    expect(manual.status).toBe('success');
    expect(lastSystem()).toContain('rule draft');
    expect(versions.runVersions(manual.executionId)!.agents).toMatchObject([{ version: 'draft', source: 'draft' }]);
    expect(await linesOf(manual)).toMatch(/Alert triager draft$/);
  });

  it('an agent never published runs in the editor and fails "Publish first" in a production run', async () => {
    const draftOnly = agentStore.create({ name: 'Drafty', persona: { role: 'Triage', always: ['only a draft'] }, instructions: 'x', model: { provider: 'ollama', model: 'm', baseUrl: base } });
    flow('wf_never', draftOnly.id);
    const manual = await runEditor('wf_never');
    expect(manual.status).toBe('success');
    expect(lastSystem()).toContain('only a draft');
    // A production run of a flow that was never published (a sub-workflow call): the published version, which there is none of.
    const record = await runWorkflow({ workflow: store.getWorkflow('wf_never')!, mode: 'webhook', startNodeId: 'Start' });
    expect(record.status).toBe('error');
    expect(record.error?.message).toContain('Publish “Drafty” first');
  });

  it('refuses a publish whose agent draft differs, and offers the three ways out', async () => {
    const s1 = makeAgent('Refused', 'rule v1');
    flow('wf_block', s1.id);
    edit(s1.id, 'rule changed');
    const refused = await publishRoute.POST(new Request('http://versions.test/p', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } }), params({ id: 'wf_block' }));
    expect(refused.status).toBe(409);
    const body = (await refused.json()) as { code: string; agents: Array<{ name: string; published: number; changes: string[] }> };
    expect(body.code).toBe('agent_changes_unpublished');
    expect(body).toMatchObject({ agents: [{ name: 'Refused', published: 1 }] });
    expect(body.agents[0]!.changes.length).toBeGreaterThan(0);
    expect(getPublication('wf_block')).toBeUndefined();

    // As published: pinned at v1, the log says so.
    const asPublished = await publishRoute.POST(new Request('http://versions.test/p', { method: 'POST', body: JSON.stringify({ agents: 'as-published' }), headers: { 'content-type': 'application/json' } }), params({ id: 'wf_block' }));
    expect(asPublished.status).toBe(200);
    expect(versions.pinsFor(getPublication('wf_block')!.versionId)).toMatchObject([{ agentId: s1.id, version: 1 }]);
    expect(getPublication('wf_block')!.note).toContain('not the agent drafts the editor tested');
  });

  it('publish-first runs the agent through its smoke test, then pins the new version', async () => {
    const s1 = makeAgent('First', 'rule v1');
    flow('wf_first', s1.id);
    edit(s1.id, 'rule v2');
    const result = await publish.publishDraft('wf_first', 'owner', undefined, { agents: 'publish-first' });
    expect(result.published?.versionId).toBeTruthy();
    expect(agentStore.get(s1.id)!.published!.version).toBe(2);
    expect(versions.pinsFor(getPublication('wf_first')!.versionId)).toMatchObject([{ agentId: s1.id, version: 2 }]);
  });

  it('publish-first with an agent that cannot be published publishes nothing', async () => {
    const s1 = makeAgent('Held', 'rule v1');
    flow('wf_held', s1.id);
    agentStore.saveDraft(s1.id, { persona: { role: 'Triage', always: ['x'] }, instructions: 'x', model: { provider: 'ollama', model: 'm', baseUrl: 'http://127.0.0.1:9' } }); // a model nobody answers: the smoke test fails
    await expect(publish.publishDraft('wf_held', 'owner', undefined, { agents: 'publish-first' })).rejects.toMatchObject({ status: 409, code: 'agent_publish_held' });
    expect(getPublication('wf_held')).toBeUndefined();
    expect(agentStore.get(s1.id)!.published!.version).toBe(1);
  });

  it('a version is one graph and one set of agents: republishing with a newer agent is a new version; a rollback runs its own pins', async () => {
    const s1 = makeAgent('Rolling', 'rule v1');
    flow('wf_roll', s1.id);
    await publish.publishDraft('wf_roll', 'owner');
    const first = getPublication('wf_roll')!.versionId;
    edit(s1.id, 'rule v2');
    agentStore.publish(s1.id);
    await publish.publishDraft('wf_roll', 'owner');
    const second = getPublication('wf_roll')!.versionId;
    expect(second).not.toBe(first);
    expect(listVersions('wf_roll')[0]!.summary).toBe('Rolling v1 → v2');
    expect(versions.pinsFor(first)[0]!.version).toBe(1);
    expect(versions.pinsFor(second)[0]!.version).toBe(2);
    await runProduction('wf_roll');
    expect(lastSystem()).toContain('rule v2');
    await publish.publishVersion('wf_roll', first, 'owner');
    await runProduction('wf_roll');
    expect(lastSystem()).toContain('rule v1');
  });

  it('"vN is available": test the production graph with the new version, then publish it without the draft', async () => {
    const s1 = makeAgent('Alert triager', 'rule v1');
    flow('wf_update', s1.id);
    await publish.publishDraft('wf_update', 'owner');
    await runProduction('wf_update'); // the last production run: its trigger data is what the test replays
    edit(s1.id, 'rule v2');
    agentStore.publish(s1.id);
    // The draft moves on (a node added, saved, not published).
    const draft = store.getWorkflow('wf_update')!;
    store.saveWorkflow({ ...draft, nodes: [...draft.nodes, node('Extra', 'core.noOp')], connections: [...draft.connections, edge('Agent', 'Extra')] });

    expect(versions.agentUpdates({ workflowId: 'wf_update' })).toMatchObject([{ agentName: 'Alert triager', pinned: 1, latest: 2, nodes: ['Agent'] }]);
    expect(versions.agentUpdates({ agentId: s1.id })).toHaveLength(1);

    // Publishing the update before a passing test is refused.
    await expect(publish.publishUpdate('wf_update', [s1.id], 'owner')).rejects.toMatchObject({ status: 409, code: 'not_tested' });
    const { testUpdate } = await import('@/lib/server/agents/updates');
    const tested = await testUpdate('wf_update', [s1.id], 'owner');
    expect(tested.status).toBe('success');
    expect(lastSystem()).toContain('rule v2');
    expect(await linesOf({ executionId: tested.executionId })).toMatch(/^workflow v\d+ · Alert triager v2$/);

    const before = getPublication('wf_update')!.versionId;
    await publish.publishUpdate('wf_update', [s1.id], 'owner', tested.executionId);
    const after = getPublication('wf_update')!.versionId;
    expect(after).not.toBe(before);
    expect(versions.pinsFor(after)[0]!.version).toBe(2);
    expect(versions.agentUpdates({ workflowId: 'wf_update' })).toEqual([]);
    // Production runs the old graph (no Extra node); the draft is untouched.
    expect(prod('wf_update').nodes.map((n) => n.id)).not.toContain('Extra');
    expect(store.getWorkflow('wf_update')!.nodes.map((n) => n.id)).toContain('Extra');
  });

  it('keeps versions older than the 20 in history: a version pinned at v1 still runs v1', async () => {
    const s1 = makeAgent('Many', 'rule v1');
    flow('wf_many', s1.id);
    await publish.publishDraft('wf_many', 'owner');
    for (let n = 2; n <= 22; n++) {
      edit(s1.id, `rule v${n}`);
      agentStore.publish(s1.id);
    }
    expect(agentStore.get(s1.id)!.history).toHaveLength(20);
    expect(agentStore.get(s1.id)!.history.some((v) => v.version === 1)).toBe(false);
    expect(versions.agentVersionConfig(s1.id, 1)?.persona?.always).toEqual(['rule v1']);
    const record = await runProduction('wf_many');
    expect(record.status).toBe('success');
    expect(lastSystem()).toContain('rule v1');
  });

  it('fails the step, with the way out, when a pinned version no longer exists', async () => {
    const s1 = makeAgent('Gone', 'rule v1');
    flow('wf_gone', s1.id);
    await publish.publishDraft('wf_gone', 'owner');
    database().delete('agent_versions', { agent_id: s1.id, version: 1 });
    agentStore.write?.({ ...agentStore.get(s1.id)!, published: { ...agentStore.get(s1.id)!.published!, version: 5 }, history: [] } as never);
    const record = await runProduction('wf_gone');
    expect(record.status).toBe('error');
    expect(record.error?.message).toContain('v1, which this version of the workflow runs, no longer exists: publish the workflow again');
  });

  it('the backfill pins what production runs today and fills the versions table; a second call changes nothing', async () => {
    const s1 = makeAgent('Backfilled', 'rule v1');
    edit(s1.id, 'rule v2');
    agentStore.publish(s1.id);
    const wf = flow('wf_backfill', s1.id);
    const version = listVersions(wf.id)[0]!;
    // As before the upgrade: published, with no pins and no version rows.
    const { setPublication } = await import('@/lib/server/publications');
    setPublication('wf_backfill', version.id, 'migration');
    database().delete('agent_versions', { agent_id: s1.id, version: 1 });
    database().delete('agent_versions', { agent_id: s1.id, version: 2 });
    database().delete('meta', { key: 'agents.versions.backfilled' });
    expect(versions.pinsFor(version.id)).toEqual([]);
    expect(await versions.backfillVersions()).toBeGreaterThanOrEqual(1);
    expect(versions.pinsFor(version.id)).toMatchObject([{ agentId: s1.id, version: 2 }]);
    expect(database().all('SELECT version FROM agent_versions WHERE agent_id = ?', s1.id)).toHaveLength(2);
    const pins = database().all('SELECT * FROM workflow_version_pins');
    expect(await versions.backfillVersions()).toBe(0);
    expect(database().all('SELECT * FROM workflow_version_pins')).toEqual(pins);
  });
});
