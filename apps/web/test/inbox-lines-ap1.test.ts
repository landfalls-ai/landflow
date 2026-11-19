/**
 * AP02 (wave ap1): the publish card's lines. GET /api/workflows/:id/unattended-approvals answers `PublishLine[]`: `waits` with
 * `waitLine(tool, trigger, minutes)` (the expiry from LANDFLOW_APPROVAL_INBOX_EXPIRY_MINUTES) for a Run an Agent step set to Ask
 * whose trigger's runs can wait; `refuses` with `refusesLine(tool, trigger, why)` for Refuse (or no value), a model or tools wired
 * to the step, an MCP trigger, the hosted chat and a host with no inbox. Nothing for a read-only agent.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Workflow, WorkflowNode } from '@landflow/engine';
import { defineNode, definePlugin } from '@landflow/sdk';

const ENV = { LANDFLOW_DATA_DIR: mkdtempSync(join(tmpdir(), 'landflow-inbox-lines-')), LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { store } = await import('@/lib/server/store');
const { agentStore } = await import('@/lib/server/agents/store');
const { publishDraft } = await import('@/lib/server/publish');
const { disableTestAuth, enableTestAuth, TEST_OWNER } = await import('@/lib/server/auth/test-bypass');
const { registerInboxPort } = await import('@/lib/server/approval-inbox/port');
const { waitLine, refusesLine, EXPIRY_VARIABLE } = await import('@/lib/shared/approval-inbox');
const route = await import('@/app/api/workflows/[id]/unattended-approvals/route');
import type { InboxPort } from '@/lib/server/approval-inbox/port';

registry.registerBuiltin(corePlugin);
// A plugin's trigger whose source is `chat` (a chat app's messages): it can wait, unlike the hosted chat page (core.chatTrigger).
registry.registerBuiltin(
  definePlugin({
    info: { id: 'chatapp', name: 'Chat app', version: '1.0.0' },
    nodes: [defineNode({ description: { name: 'chatMessage', displayName: 'Chat message', description: 'A chat app message', version: 1, kind: 'trigger', triggerSource: 'chat', inputs: [], outputs: [{ type: 'main' }], properties: [] } as never, async execute() { return [[]]; } } as never)],
  }),
);
afterAll(() => {
  for (const key of [...Object.keys(ENV), EXPIRY_VARIABLE]) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const port: InboxPort = { open: async () => ({ ids: {}, expiresAt: '', minutes: 0 }), outcome: () => undefined, settle: async () => ({ won: false, outcome: { status: 'waiting' } }), view: () => undefined };
beforeEach(() => {
  enableTestAuth(TEST_OWNER);
  delete process.env[EXPIRY_VARIABLE];
  registerInboxPort(port);
});

const SEND = { id: 't1', type: 'node' as const, name: 'Send Email', description: 'Send', nodeType: 'core.noOp', parameters: {}, requireApproval: true };
const READ = { id: 't2', type: 'node' as const, name: 'Look Up', description: 'Look', nodeType: 'core.noOp', parameters: {} };
const model = { provider: 'ollama', model: 'm', baseUrl: 'http://127.0.0.1:9' };
const triager = agentStore.create({ name: 'Triager', instructions: 'Triage.', model, tools: [SEND, READ] });
agentStore.publish(triager.id);
const reader = agentStore.create({ name: 'Reader', instructions: 'Read.', model, tools: [READ] });
agentStore.publish(reader.id);

const node = (id: string, type: string, parameters: Record<string, unknown> = {}): WorkflowNode => ({ id, name: id, type, typeVersion: 1, position: [0, 0], parameters });
let n = 0;
function flow(trigger: string, agentId: string, step: Record<string, unknown> = { toolApprovals: 'askInChat' }, wired = false): Workflow {
  const wf: Workflow = {
    id: `wf_ap1_lines_${++n}`,
    name: 'lines',
    nodes: [node('Start', trigger, trigger === 'core.webhook' ? { path: `ap1-lines-${n}` } : {}), node('Agent', 'core.messageAgent', { agentId, message: 'Go', ...step }), ...(wired ? [node('Model', 'core.noOp')] : [])],
    connections: [
      { id: 'a', type: 'main', source: 'Start', target: 'Agent', sourceIndex: 0, targetIndex: 0 },
      ...(wired ? [{ id: 'b', type: 'ai_languageModel' as const, source: 'Model', target: 'Agent', sourceIndex: 0, targetIndex: 1 }] : []),
    ],
  };
  store.saveWorkflow(wf);
  return wf;
}
const ask = async (id: string, query = '') => {
  const response = await (route.GET as (r: Request, c: { params: Promise<{ id: string }> }) => Promise<Response>)(new Request(`http://localhost:3000/api/workflows/${id}/unattended-approvals${query}`), { params: Promise.resolve({ id }) });
  return { status: response.status, body: (await response.json()) as Array<Record<string, unknown>> };
};

describe('GET /api/workflows/:id/unattended-approvals (the publish card’s lines)', () => {
  it('a published Webhook flow whose step is Ask waits, with the expiry from the variable', async () => {
    const wf = flow('core.webhook', triager.id);
    store.saveWorkflow({ ...wf, active: true });
    await publishDraft(wf.id, 'usr_test_owner');
    const answer = await ask(wf.id);
    expect(answer.body).toEqual([{ tool: 'Send Email', agent: 'Triager', node: 'Agent', trigger: 'webhook', line: waitLine('Send Email', 'webhook', 1440), outcome: 'waits', expiresAfterMinutes: 1440 }]);
    expect(answer.body[0]!.line).toBe('In production “Send Email” will wait for your approval in Needs you: a webhook run pauses until someone approves or denies it, and the request expires after 24 h.');
    process.env[EXPIRY_VARIABLE] = '10';
    expect((await ask(wf.id)).body[0]).toMatchObject({ outcome: 'waits', expiresAfterMinutes: 10, line: waitLine('Send Email', 'webhook', 10) });
    expect((await ask(wf.id)).body[0]!.line).toContain('expires after 10 min');
  });

  it('the schedule, form and app triggers wait; an MCP trigger and the hosted chat refuse, with their reasons', async () => {
    for (const [type, word] of [['core.schedule', 'schedule'], ['core.formTrigger', 'form'], ['core.detectorTrigger', 'detector'], ['core.errorTrigger', 'error workflow']] as const) {
      expect((await ask(flow(type, triager.id).id, '?version=draft')).body, type).toEqual([expect.objectContaining({ trigger: word, outcome: 'waits', line: waitLine('Send Email', word, 1440) })]);
    }
    expect((await ask(flow('core.mcpTrigger', triager.id).id, '?version=draft')).body).toEqual([expect.objectContaining({ trigger: 'MCP call', outcome: 'refuses', why: 'mcp', line: refusesLine('Send Email', 'MCP call', 'mcp') })]);
    expect((await ask(flow('core.chatTrigger', triager.id).id, '?version=draft')).body).toEqual([expect.objectContaining({ trigger: 'chat', outcome: 'refuses', why: 'hostedChat', line: refusesLine('Send Email', 'chat', 'hostedChat') })]);
    expect((await ask(flow('core.manualTrigger', triager.id).id, '?version=draft')).body).toEqual([]);
  });

  it('a plugin chat trigger keeps its own word: it waits while the hosted chat page beside it refuses, and the refusal never merges away', async () => {
    const wf = flow('core.chatTrigger', triager.id);
    store.saveWorkflow({ ...wf, nodes: [...wf.nodes, node('Chat app', 'chatapp.chatMessage')], connections: [...wf.connections, { id: 'c', type: 'main', source: 'Chat app', target: 'Agent', sourceIndex: 0, targetIndex: 0 }] });
    const lines = (await ask(wf.id, '?version=draft')).body;
    expect(lines).toHaveLength(2);
    expect(lines).toEqual(expect.arrayContaining([expect.objectContaining({ trigger: 'chat', outcome: 'refuses', why: 'hostedChat' }), expect.objectContaining({ trigger: 'chat app', outcome: 'waits' })]));
    const { unattendedTrigger } = await import('@/lib/server/agents/unattended');
    expect(unattendedTrigger('chatapp.chatMessage')).toBe('chat app');
    expect(unattendedTrigger('core.chatTrigger')).toBe('chat');
  });

  it('a plugin trigger whose plugin is offline is still the trigger it declared (no transport is chosen to look it up)', async () => {
    const { unattendedTrigger } = await import('@/lib/server/agents/unattended');
    const { triggerCanWait } = await import('@/lib/server/runner/trigger');
    // What `registry.resolve` answers for a remote plugin with no endpoint online (transports/selector.ts): an error.
    const offline = vi.spyOn(registry, 'resolve').mockReturnValue({ error: 'Plugin "chatapp" is offline — start it or check its endpoint' });
    try {
      expect(unattendedTrigger('chatapp.chatMessage')).toBe('chat app');
      expect(triggerCanWait('chatapp.chatMessage')).toBe(true);
      expect(unattendedTrigger('chatapp.missing')).toBeUndefined();
    } finally {
      offline.mockRestore();
    }
  });

  it('a step set to Refuse (or saved with no value), a wired model and a host with no inbox refuse, with their reasons', async () => {
    const refuse = (await ask(flow('core.webhook', triager.id, { toolApprovals: 'refuse' }).id, '?version=draft')).body;
    expect(refuse).toEqual([expect.objectContaining({ outcome: 'refuses', why: 'refuseSetting', line: refusesLine('Send Email', 'webhook', 'refuseSetting') })]);
    expect(refuse[0]).not.toHaveProperty('expiresAfterMinutes');
    expect((await ask(flow('core.webhook', triager.id, {}).id, '?version=draft')).body[0]).toMatchObject({ outcome: 'refuses', why: 'refuseSetting' });
    expect((await ask(flow('core.webhook', triager.id, { toolApprovals: 'askInChat' }, true).id, '?version=draft')).body[0]).toMatchObject({ outcome: 'refuses', why: 'wired', line: refusesLine('Send Email', 'webhook', 'wired') });
    registerInboxPort(undefined as never);
    expect((await ask(flow('core.webhook', triager.id).id, '?version=draft')).body[0]).toMatchObject({ outcome: 'refuses', why: 'noInbox', line: refusesLine('Send Email', 'webhook', 'noInbox') });
  });

  it('says nothing for a read-only agent; the version and update queries still work; access is kept', async () => {
    expect((await ask(flow('core.webhook', reader.id).id, '?version=draft')).body).toEqual([]);
    const wf = flow('core.webhook', triager.id);
    expect((await ask(wf.id, `?version=draft&update=${triager.id}`)).body).toHaveLength(1);
    expect((await ask(wf.id, '?version=999')).status).toBe(404);
    expect((await ask('wf_nothing')).status).toBe(404);
    disableTestAuth();
    expect((await ask(wf.id, '?version=draft')).status).not.toBe(200);
  });
});
