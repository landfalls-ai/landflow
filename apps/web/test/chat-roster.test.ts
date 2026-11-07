/**
 * Chat with agents, step 2 (docs/specs/16): the roster of a Chat trigger. An off-roster key is refused, each picked agent
 * has its own memory session, the lead is the default, the config lists no node ids, and a flow without a roster is unchanged.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Workflow, WorkflowNode } from '@landflow/engine';
import { defineNode, definePlugin } from '@landflow/sdk';

vi.setConfig({ testTimeout: 30_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-chat-roster-'));
Object.assign(process.env, { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' });

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { loadTranscript, chatRoster, pickAgent, agentSessionId } = await import('@/lib/server/chat');
const { CHAT_CLIENT_JS } = await import('@/lib/server/chat-client');
const { store } = await import('@/lib/server/store');
const { publishDraft } = await import('@/lib/server/publish');
const chatRoute = await import('@/app/chat/[...path]/route');
registry.registerBuiltin(corePlugin);

// An answerer that reports the item it was started with, the way an agent reads its session key from `$json.sessionId`.
const echo = defineNode({
  description: { name: 'echoItem', displayName: 'Echo item', description: 'Test node', version: 1, kind: 'action', inputs: [{ type: 'main' }], outputs: [{ type: 'main' }], properties: [] },
  async execute(ctx) {
    const json = ctx.getInputData()[0].json;
    return [[{ json: { output: JSON.stringify({ node: ctx.getNode().name, ...json }) } }]];
  },
});
registry.registerBuiltin(definePlugin({ info: { id: 'rostertest', name: 'Roster test', version: '0.0.1', description: 'test', icon: 'lucide:bot', color: '#000', author: 'test' }, nodes: [echo] }));

const node = (id: string, type: string, parameters: Record<string, unknown> = {}, extra: Partial<WorkflowNode> = {}): WorkflowNode => ({ id, name: id, type, typeVersion: 1, position: [0, 0], parameters, ...extra });
const edge = (source: string, target: string) => ({ id: `${source}-${target}`, type: 'main' as const, source, target, sourceIndex: 0, targetIndex: 0 });

const roster = {
  agent: [
    { key: 'billing', label: 'Billing', face: '🧾', target: 'BillingNode', seesTranscript: true },
    { key: 'tech', label: 'Tech', target: 'TechNode', seesTranscript: false },
    { key: 'ghost', label: 'Ghost', target: 'NoSuchNode' },
  ],
};

async function chat(id: string, withRoster: boolean): Promise<Workflow> {
  const workflow: Workflow = {
    id,
    name: id,
    nodes: [
      node('Chat', 'core.chatTrigger', { public: true, responseMode: 'lastNode', ...(withRoster && { roster }) }),
      node('Lead', 'rostertest.echoItem'),
      node('BillingNode', 'rostertest.echoItem'),
      node('TechNode', 'rostertest.echoItem'),
      node('Secret', 'rostertest.echoItem'),
    ],
    connections: [edge('Chat', 'Lead')],
  };
  store.saveWorkflow(workflow);
  await publishDraft(id, 'tester', 'chat');
  return workflow;
}

const ctx = (path: string) => ({ params: Promise.resolve({ path: path.split('/').filter(Boolean) }) });
const ask = (path: string, body: unknown) => chatRoute.POST(new Request(`http://chat.test/chat/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), ctx(path));
const answer = async (response: Response) => JSON.parse(((await response.json()) as { output: string }).output) as Record<string, unknown>;

describe('the roster of a Chat trigger', () => {
  it('keeps valid entries only (a key, a target that is a node of the flow)', async () => {
    const workflow = await chat('wf_roster_parse', true);
    const entries = chatRoster(workflow, workflow.nodes[0]);
    expect(entries.map((e) => e.key)).toEqual(['billing', 'tech']);
    expect(entries[0]).toMatchObject({ label: 'Billing', face: '🧾', targetId: 'BillingNode', seesTranscript: true });
    expect(entries[1].seesTranscript).toBe(false);
  });

  it('lists label and face in the config, never the node', async () => {
    await chat('wf_roster_config', true);
    const response = await chatRoute.GET(new Request('http://chat.test/chat/wf_roster_config/config'), ctx('wf_roster_config/config'));
    const raw = await response.text();
    expect(JSON.parse(raw).agents).toEqual([
      { key: 'billing', label: 'Billing', face: '🧾' },
      { key: 'tech', label: 'Tech' },
    ]);
    for (const hidden of ['BillingNode', 'TechNode', 'targetId', 'target']) expect(raw).not.toContain(hidden);
  });

  it('a flow without a roster has no agents in its config and starts as before', async () => {
    await chat('wf_roster_none', false);
    const config = await (await chatRoute.GET(new Request('http://chat.test/chat/wf_roster_none/config'), ctx('wf_roster_none/config'))).json();
    expect('agents' in config).toBe(false);
    const out = await answer(await ask('wf_roster_none', { sessionId: 's1', message: 'Hi' }));
    expect(out).toMatchObject({ node: 'Lead', sessionId: 's1', chatInput: 'Hi' });
    expect(out).not.toHaveProperty('agentKey');
    expect(loadTranscript('wf_roster_none', 's1')[1]).not.toHaveProperty('agentKey');
  });
});

describe('picking an agent', () => {
  it('the lead is the default when nothing is picked', async () => {
    await chat('wf_roster_lead', true);
    for (const body of [
      { sessionId: 's1', message: 'Hi' },
      { sessionId: 's2', message: 'Hi', agentKey: '' },
    ]) {
      const out = await answer(await ask('wf_roster_lead', body));
      expect(out.node).toBe('Lead');
      expect(out.sessionId).toBe(body.sessionId);
    }
  });

  it('starts the run at the picked target, with its own memory session', async () => {
    await chat('wf_roster_pick', true);
    const billing = await answer(await ask('wf_roster_pick', { sessionId: 'sess', message: 'Refund?', agentKey: 'billing' }));
    const tech = await answer(await ask('wf_roster_pick', { sessionId: 'sess', message: 'Broken?', agentKey: 'tech' }));
    const lead = await answer(await ask('wf_roster_pick', { sessionId: 'sess', message: 'Hello' }));
    expect(billing).toMatchObject({ node: 'BillingNode', sessionId: 'sess:billing', visitorSessionId: 'sess', agentKey: 'billing', chatInput: 'Refund?' });
    expect(tech).toMatchObject({ node: 'TechNode', sessionId: 'sess:tech' });
    expect(new Set([billing.sessionId, tech.sessionId, lead.sessionId]).size).toBe(3);
    expect(agentSessionId('sess', 'billing')).toBe('sess:billing');
  });

  it('gives the visible conversation to a specialist that sees it, and not to one that does not', async () => {
    await chat('wf_roster_see', true);
    await ask('wf_roster_see', { sessionId: 'sess', message: 'First question' });
    const billing = await answer(await ask('wf_roster_see', { sessionId: 'sess', message: 'Next', agentKey: 'billing' }));
    const tech = await answer(await ask('wf_roster_see', { sessionId: 'sess', message: 'Next', agentKey: 'tech' }));
    expect((billing.transcript as Array<{ text: string }>).some((m) => m.text === 'First question')).toBe(true);
    expect(tech).not.toHaveProperty('transcript');
  });

  it('keeps one visible conversation with the agent on each message', async () => {
    await chat('wf_roster_log', true);
    await ask('wf_roster_log', { sessionId: 'sess', message: 'Refund?', agentKey: 'billing' });
    const [user, reply] = loadTranscript('wf_roster_log', 'sess');
    expect(user).toMatchObject({ role: 'user', agentKey: 'billing' });
    expect(reply).toMatchObject({ role: 'assistant', agentKey: 'billing', agentName: 'Billing' });
    expect(loadTranscript('wf_roster_log', 'sess:billing')).toEqual([]);
  });

  it('refuses a key that is off the roster, and never starts a node that is not on it', async () => {
    await chat('wf_roster_off', true);
    for (const agentKey of ['Secret', 'Lead', 'BillingNode', 'ghost', 'billing ', '__proto__', 5, ['billing']]) {
      const response = await ask('wf_roster_off', { sessionId: 'sess', message: 'Hi', agentKey });
      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: string }).error).toContain('isn’t available');
    }
    expect(loadTranscript('wf_roster_off', 'sess')).toEqual([]);
    expect(pickAgent([], 'billing')).toHaveProperty('error');
  });

  it('a flow without a roster refuses any agentKey', async () => {
    await chat('wf_roster_none2', false);
    expect((await ask('wf_roster_none2', { sessionId: 'sess', message: 'Hi', agentKey: 'billing' })).status).toBe(400);
  });
});

describe('the page', () => {
  it('is valid JavaScript, shows the roster as chips and sends agentKey', () => {
    expect(() => new Function(CHAT_CLIENT_JS)).not.toThrow();
    expect(CHAT_CLIENT_JS).toContain('config.agents');
    expect(CHAT_CLIENT_JS).toContain('payload.agentKey');
    expect(CHAT_CLIENT_JS).toContain("body.append('agentKey'");
    expect(CHAT_CLIENT_JS).toContain('@media (max-width: 600px)');
  });
});
