/**
 * AG21: "Alert triager v3 is available" (docs/features/editor.md#publishing-pins-the-agents): the updates of a workflow and of an
 * agent, which workflow versions pin each agent version, the pins and the version's connections routes, `list_agent_updates`
 * in-process and over MCP, Spotlight's three publish tools (scripted turns: they offer a card and publish nothing), and the
 * words of the contract. No answer holds a secret.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import type { LanguageModel, ModelTurn, Workflow, WorkflowNode } from '@landflow/engine';
import { availableLine, pinsSummary, publishOfferLine, runVersionsLine, usedByLine, type PublishOffer } from '@/lib/shared/agent-versions';
import type { NodeTypeInfo } from '@/lib/shared/types';
import { startFakeModels } from './fake-ai-services';

vi.setConfig({ testTimeout: 30_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-agent-updates-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_PUBLIC_URL: 'http://updates.test', LANDFLOW_BRAIN_MODEL: 'off', LANDFLOW_BRAIN_EMBEDDINGS: 'off' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { store } = await import('@/lib/server/store');
const { agentStore } = await import('@/lib/server/agents/store');
const publish = await import('@/lib/server/publish');
const { getPublication } = await import('@/lib/server/publications');
const versions = await import('@/lib/server/agents/versions');
const { listAgentUpdates } = await import('@/lib/server/assistant/publish-tools');
const { runChat } = await import('@/lib/server/assistant/chat');
const { instanceServer } = await import('@/lib/server/mcp/instance-tools');
const { TEST_OWNER } = await import('@/lib/server/auth/test-bypass');
const versionsRoute = await import('@/app/api/agents/[id]/versions/route');
const connectionsRoute = await import('@/app/api/agents/[id]/versions/[version]/connections/route');
const pinsRoute = await import('@/app/api/workflows/[id]/versions/[versionId]/pins/route');
const updatesRoute = await import('@/app/api/workflows/[id]/agent-updates/route');

registry.registerBuiltin(corePlugin);
const fake = await startFakeModels();
let types: NodeTypeInfo[];
beforeAll(() => {
  types = registry.nodeTypes().filter((t) => t.pluginId === 'core');
});
afterAll(async () => {
  await fake.close();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const base = fake.url.replace(/\/v1$/, '');
const model = (name: string) => ({ provider: 'ollama' as const, model: name, baseUrl: base });
const node = (id: string, type: string, parameters: Record<string, unknown> = {}): WorkflowNode => ({ id, name: id, type, typeVersion: 1, position: [0, 0], parameters });
const params = <T>(value: T) => ({ params: Promise.resolve(value) });
const get = (url: string) => new Request(`http://updates.test${url}`);

function agent(name: string, modelName = 'm1') {
  const made = agentStore.create({ name, persona: { role: 'Triage', always: ['rule v1'] }, instructions: 'Answer briefly.', model: model(modelName) });
  agentStore.publish(made.id);
  return made;
}
function flow(id: string, agentId: string): Workflow {
  return store.saveWorkflow({
    id,
    name: `Flow ${id}`,
    nodes: [node('Start', 'core.manualTrigger'), node('Agent', 'core.messageAgent', { agentId, message: 'Check this', conversation: 'new' })],
    connections: [{ id: 'e', type: 'main', source: 'Start', sourceIndex: 0, target: 'Agent', targetIndex: 0 }],
  });
}
const bump = (id: string, modelName: string) => {
  agentStore.saveDraft(id, { ...agentStore.get(id)!, model: model(modelName) });
  agentStore.publish(id);
};

const s1 = agent('Alert triager');
flow('wf_a', s1.id);
await publish.publishDraft('wf_a', 'owner');
flow('wf_b', s1.id);
await publish.publishDraft('wf_b', 'owner');
bump(s1.id, 'm2'); // v2
bump(s1.id, 'm3'); // v3

describe('what is available and who uses what', () => {
  it('lists the updates of a workflow and of an agent, in the contract\'s words', () => {
    expect(versions.agentUpdates({ workflowId: 'wf_a' })).toMatchObject([{ workflowId: 'wf_a', agentName: 'Alert triager', pinned: 1, latest: 3, nodes: ['Agent'], workflowVersion: 1 }]);
    const byAgent = versions.agentUpdates({ agentId: s1.id });
    expect(byAgent.map((u) => u.workflowId).sort()).toEqual(['wf_a', 'wf_b']);
    expect(availableLine(byAgent[0]!)).toBe('Alert triager v3 is available (production runs v1)');
    expect(listAgentUpdates({ workflowId: 'wf_a' }).updates[0]!.line).toBe('Alert triager v3 is available (production runs v1)');
  });

  it('GET /api/agents/:id/versions answers usedBy per version, production marked', async () => {
    const response = await versionsRoute.GET(get(`/api/agents/${s1.id}/versions`), params({ id: s1.id }));
    const { versions: list } = (await response.json()) as { versions: Array<Parameters<typeof usedByLine>[0]> };
    expect(list.map((v) => v.version)).toEqual([3, 2, 1]);
    const v1 = list.find((v) => v.version === 1)!;
    expect(v1.usedBy.map((u) => [u.name, u.workflowVersion, u.production]).sort()).toEqual([['Flow wf_a', 1, true], ['Flow wf_b', 1, true]]);
    expect(usedByLine(v1)).toMatch(/^v1 · used by Flow wf_[ab] v1 \(production\), Flow wf_[ab] v1 \(production\)$/);
    expect(usedByLine(list.find((v) => v.version === 3)!)).toBe('v3 · no workflow pins it');
  });

  it('the pins route and the version-connections route (v1\'s model, not the draft\'s)', async () => {
    const versionId = getPublication('wf_a')!.versionId;
    const pins = (await (await pinsRoute.GET(get('/x'), params({ id: 'wf_a', versionId }))).json()) as { pins: Array<{ nodeName?: string; agentName?: string; version: number }> };
    expect(pins.pins).toMatchObject([{ nodeName: 'Agent', agentName: 'Alert triager', version: 1 }]);
    const response = await connectionsRoute.GET(get('/x'), params({ id: s1.id, version: '1' }));
    const body = (await response.json()) as { version: number; connections: Array<{ kind: string; name: string }> };
    expect(body.version).toBe(1);
    expect(body.connections.find((c) => c.kind === 'model')?.name).toBe('m1');
    expect((await connectionsRoute.GET(get('/x'), params({ id: s1.id, version: '99' }))).status).toBe(404);
    // The updates route carries the card's data.
    const updates = (await (await updatesRoute.GET(get('/x'), params({ id: 'wf_a' }))).json()) as { updates: unknown[]; offer?: PublishOffer };
    expect(updates.updates).toHaveLength(1);
    expect(updates.offer).toMatchObject({ kind: 'update', workflowId: 'wf_a' });
  });

  it('the contract\'s examples read as written', () => {
    expect(runVersionsLine({ workflow: { number: 4, production: true }, agents: [{ nodeId: 'n', agentId: 'a', agentName: 'Alert triager', version: 2, source: 'pinned' }] })).toBe('workflow v4 · Alert triager v2');
    expect(runVersionsLine({ workflow: { number: 5, production: false }, agents: [{ nodeId: 'n', agentId: 'a', agentName: 'Alert triager', version: 'draft', source: 'draft' }] })).toBe('workflow draft (v5) · Alert triager draft');
    expect(pinsSummary([{ agentName: 'Alert triager', from: 1, to: 2 }])).toBe('Alert triager v1 → v2');
    const offer = { workflowId: 'w', kind: 'update', nextVersion: 9, pins: [], updates: [{ workflowId: 'w', workflowName: 'W', workflowVersion: 8, agentId: 'a', agentName: 'Alert triager', pinned: 1, latest: 2, nodes: ['n'] }] } satisfies PublishOffer;
    expect(publishOfferLine(offer)).toBe('Publish v9: Alert triager v1 → v2 (test first)');
    expect(publishOfferLine({ workflowId: 'w', kind: 'draft', nextVersion: 7, pins: [{ nodeId: 'n', agentId: 'a', agentName: 'Alert triager', version: 1 }] })).toBe('Publish v7: runs Alert triager v1');
  });
});

describe('list_agent_updates over MCP', () => {
  async function connect(keyScopes?: Array<'workflows:read' | 'brain:read'>) {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await instanceServer({ id: TEST_OWNER.id, role: 'owner' }, undefined, keyScopes).connect(serverSide);
    const client = new Client({ name: 'updates-test', version: '1.0.0' });
    await client.connect(clientSide);
    return client;
  }
  const textOf = (result: unknown) => ((result as { content: Array<{ text: string }> }).content[0]?.text ?? '');

  it('answers what the in-process tool answers, and needs workflows:read', async () => {
    const client = await connect(['workflows:read']);
    expect((await client.listTools()).tools.map((t) => t.name)).toContain('list_agent_updates');
    const viaMcp = JSON.parse(textOf(await client.callTool({ name: 'list_agent_updates', arguments: { workflowId: 'wf_a' } })));
    expect(viaMcp).toEqual(JSON.parse(JSON.stringify(listAgentUpdates({ workflowId: 'wf_a' }))));
    const byAgent = JSON.parse(textOf(await client.callTool({ name: 'list_agent_updates', arguments: { agentId: s1.id } })));
    expect(byAgent.updates).toHaveLength(2);
    const other = await connect(['brain:read']);
    expect((await other.listTools()).tools.map((t) => t.name)).not.toContain('list_agent_updates');
  });
});

describe('Spotlight offers; the card publishes', () => {
  type Script = Array<Partial<ModelTurn> & { tokens?: string[] }>;
  function scripted(script: Script) {
    const model: LanguageModel = {
      provider: 'test',
      model: 'scripted',
      async generate() {
        const next = script.shift();
        if (!next) throw new Error('No scripted turn left');
        const { tokens, ...turn } = next;
        return { text: tokens?.join('') ?? '', toolCalls: [], stopReason: 'stop', usage: { inputTokens: 10, outputTokens: 5 }, ...turn };
      },
    };
    return model;
  }
  async function ask(text: string, workflowId: string, script: Script) {
    const events: Array<{ type: string; offer?: PublishOffer; name?: string }> = [];
    await runChat({ messages: [{ role: 'user', content: text }], workflow: store.getWorkflow(workflowId)!, model: scripted(script), types, trace: true, userId: TEST_OWNER.id, onEvent: (e) => events.push(e as never) });
    return events;
  }
  const call = (name: string, input: Record<string, unknown> = {}) => ({ toolCalls: [{ id: `c_${name}`, name, input }], stopReason: 'tool_use' as const });

  it('"Alert triager has a new version…": list_agent_updates, then propose_agent_update: a card, nothing published', async () => {
    const before = getPublication('wf_a')!.versionId;
    const events = await ask('Alert triager has a new version. Test this flow with it and put it live if it works.', 'wf_a', [call('list_agent_updates'), call('propose_agent_update', { agentIds: [s1.id] }), { tokens: ['It needs your test, then your Publish on the card.'] }]);
    expect(events.filter((e) => e.type === 'tool').map((e) => e.name)).toEqual(['list_agent_updates', 'propose_agent_update']);
    const offer = events.find((e) => e.type === 'publishOffer')!.offer!;
    expect(offer).toMatchObject({ kind: 'update', workflowId: 'wf_a', updates: [{ agentName: 'Alert triager', pinned: 1, latest: 3 }] });
    expect(publishOfferLine(offer)).toMatch(/^Publish v\d+: Alert triager v1 → v3 \(test first\)$/);
    expect(getPublication('wf_a')!.versionId).toBe(before);
  });

  it('"Publish this flow.": propose_publish offers the draft, with the block when an agent draft differs; nothing publishes', async () => {
    const t = agent('Fresh');
    flow('wf_c', t.id);
    const plain = await ask('Publish this flow.', 'wf_c', [call('propose_publish'), { tokens: ['Press Publish on the card.'] }]);
    const offer = plain.find((e) => e.type === 'publishOffer')!.offer!;
    expect(offer).toMatchObject({ kind: 'draft', workflowId: 'wf_c', pins: [{ agentName: 'Fresh', version: 1 }] });
    expect(offer.blocks).toBeUndefined();
    expect(getPublication('wf_c')).toBeUndefined();
    agentStore.saveDraft(t.id, { ...agentStore.get(t.id)!, instructions: 'Answer in French.' });
    const blocked = await ask('Publish this flow.', 'wf_c', [call('propose_publish'), { tokens: ['An agent draft differs.'] }]);
    expect(blocked.find((e) => e.type === 'publishOffer')!.offer!.blocks).toMatchObject([{ name: 'Fresh', published: 1 }]);
    expect(getPublication('wf_c')).toBeUndefined();
  });

  it('a propose_agent_update with nothing to update says so and offers no card', async () => {
    const events = await ask('Update the agent.', 'wf_c', [call('propose_agent_update', { agentIds: ['nope'] }), { tokens: ['Nothing to update.'] }]);
    expect(events.some((e) => e.type === 'publishOffer')).toBe(false);
  });

  it('no answer holds a secret', async () => {
    const all = JSON.stringify([listAgentUpdates({ workflowId: 'wf_a' }), versions.agentVersionUses(s1.id), versions.pinsFor(getPublication('wf_a')!.versionId)]);
    expect(all).not.toMatch(/sk-|apiKey|password|secret|token/i);
  });
});
