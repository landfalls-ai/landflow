// @vitest-environment happy-dom
/**
 * AG23 (wave ag5): production approvals, said before they bite. GET /api/workflows/:id/unattended-approvals names each tool that
 * asks first which a trigger run of the version will refuse (a webhook, schedule, chat, form or app trigger starts with nobody in
 * the editor): one `unattendedLine(tool, trigger)` per tool and trigger; `[]` when none. The agent is read at its pin, else the
 * published version. The publish card and the Publish menu show the lines.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Workflow, WorkflowNode } from '@landflow/engine';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
Object.assign(process.env, { LANDFLOW_DATA_DIR: mkdtempSync(join(tmpdir(), 'landflow-ag23-unattended-')), LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' });

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { store } = await import('@/lib/server/store');
const { agentStore } = await import('@/lib/server/agents/store');
const { publishDraft } = await import('@/lib/server/publish');
const { refusesLine } = await import('@/lib/shared/approval-inbox'); // AP02: these steps carry no Tool Approvals value, so they still refuse and the line says why
const { disableTestAuth, enableTestAuth, TEST_OWNER } = await import('@/lib/server/auth/test-bypass');
const route = await import('@/app/api/workflows/[id]/unattended-approvals/route');
const { UnattendedLines } = await import('@/components/editor/spotlight/unattended-line');
const { PublishCardView } = await import('@/components/editor/spotlight/publish-card');
const { useEditor } = await import('@/components/editor/store');

registry.registerBuiltin(corePlugin);

const SEND = { id: 't1', type: 'node' as const, name: 'Send Email', description: 'Send', nodeType: 'core.noOp', parameters: {}, requireApproval: true };
const READ = { id: 't2', type: 'node' as const, name: 'Look Up', description: 'Look', nodeType: 'core.noOp', parameters: {} };
const model = { provider: 'ollama', model: 'm', baseUrl: 'http://127.0.0.1:9' };
const triager = agentStore.create({ name: 'Triager', instructions: 'Triage.', model, tools: [SEND, READ] });
agentStore.publish(triager.id); // v1 asks first for Send Email
const readOnly = agentStore.create({ name: 'Reader', instructions: 'Read.', model, tools: [READ] });
agentStore.publish(readOnly.id);

const node = (id: string, type: string, parameters: Record<string, unknown> = {}): WorkflowNode => ({ id, name: id, type, typeVersion: 1, position: [0, 0], parameters });
let n = 0;
function flow(trigger: string, agentId: string, extra: Record<string, unknown> = {}): Workflow {
  const wf: Workflow = {
    id: `wf_ag23u_${++n}`,
    name: 'unattended',
    nodes: [node('Start', trigger, extra), node('Agent', 'core.messageAgent', { agentId, message: 'Go' })],
    connections: [{ id: 'a', type: 'main', source: 'Start', target: 'Agent', sourceIndex: 0, targetIndex: 0 }],
  };
  store.saveWorkflow(wf);
  return wf;
}
const ask = async (id: string, query = '') => {
  const response = await (route.GET as (r: Request, c: { params: Promise<{ id: string }> }) => Promise<Response>)(new Request(`http://localhost:3000/api/workflows/${id}/unattended-approvals${query}`), { params: Promise.resolve({ id }) });
  const text = await response.text();
  return { status: response.status, text, body: response.status === 200 ? (JSON.parse(text) as Array<Record<string, string>>) : undefined };
};
const publish = async (wf: Workflow) => {
  store.saveWorkflow({ ...wf, active: true });
  await publishDraft(wf.id, 'usr_test_owner');
};

beforeEach(() => enableTestAuth(TEST_OWNER));

describe('GET /api/workflows/:id/unattended-approvals', () => {
  it('a published Webhook flow whose agent asks first for Send Email: one line, the webhook one', async () => {
    const wf = flow('core.webhook', triager.id, { path: 'ag23u-hook' });
    await publish(wf);
    const answer = await ask(wf.id);
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual([{ tool: 'Send Email', agent: 'Triager', node: 'Agent', trigger: 'webhook', line: refusesLine('Send Email', 'webhook', 'refuseSetting'), outcome: 'refuses', why: 'refuseSetting' }]);
    expect(answer.body![0].line).toBe('In production “Send Email” is refused: a webhook run cannot wait for an approval here (Tool Approvals is set to Refuse on this step).');
  });

  it('counts the triggers nobody watches: schedule, chat, form (one line each), and not a manual trigger', async () => {
    for (const [type, word] of [['core.schedule', 'schedule'], ['core.chatTrigger', 'chat'], ['core.formTrigger', 'form']] as const) {
      const wf = flow(type, triager.id);
      const answer = await ask(wf.id, '?version=draft');
      expect(answer.body, type).toEqual([expect.objectContaining({ tool: 'Send Email', trigger: word, line: refusesLine('Send Email', word, 'refuseSetting') })]);
    }
    expect((await ask(flow('core.manualTrigger', triager.id).id, '?version=draft')).body).toEqual([]);
  });

  it('counts every trigger but the manual and evaluation ones: usage, suggestion, detector, cap raise, error, called workflow, MCP', async () => {
    const words: Array<[string, string]> = [
      ['core.usageTrigger', 'usage event'],
      ['core.suggestionDecidedTrigger', 'suggestion decision'],
      ['core.detectorTrigger', 'detector'],
      ['core.capRaiseTrigger', 'cap raise'],
      ['core.errorTrigger', 'error workflow'],
      ['core.workflowTrigger', 'called workflow'],
      ['core.executeWorkflowTrigger', 'called workflow'],
      ['core.mcpTrigger', 'MCP call'],
    ];
    for (const [type, word] of words) {
      const answer = await ask(flow(type, triager.id).id, '?version=draft');
      expect(answer.body, type).toEqual([expect.objectContaining({ tool: 'Send Email', trigger: word, line: refusesLine('Send Email', word, 'refuseSetting') })]);
    }
    expect((await ask(flow('core.evaluationTrigger', triager.id).id, '?version=draft')).body).toEqual([]);
  });

  it('a version pinned to an agent version without the tool says nothing, and an agent that reads only says nothing', async () => {
    const wf = flow('core.webhook', triager.id, { path: 'ag23u-pin' });
    await publish(wf); // pinned to Triager v1 (asks first)
    // The agent's v2 drops the tool; the published workflow still runs v1 until republished.
    agentStore.saveDraft(triager.id, { tools: [READ] });
    agentStore.publish(triager.id);
    expect((await ask(wf.id)).body).toHaveLength(1);
    // A workflow published now binds v2: no tool asks first.
    const wf2 = flow('core.webhook', triager.id, { path: 'ag23u-pin2' });
    await publish(wf2);
    expect((await ask(wf2.id)).body).toEqual([]);
    const reader = flow('core.webhook', readOnly.id, { path: 'ag23u-read' });
    await publish(reader);
    expect((await ask(reader.id)).body).toEqual([]);
    agentStore.saveDraft(triager.id, { tools: [SEND, READ] });
    agentStore.publish(triager.id);
  });

  it('an update offer is answered for the agents at their latest published version, not the old pins', async () => {
    const agent = agentStore.create({ name: 'Updater', instructions: 'Go.', model, tools: [READ] });
    agentStore.publish(agent.id); // v1: nothing asks first
    const wf = flow('core.webhook', agent.id, { path: 'ag23u-update' });
    await publish(wf);
    expect((await ask(wf.id)).body).toEqual([]);
    agentStore.saveDraft(agent.id, { tools: [SEND, READ] });
    agentStore.publish(agent.id); // v2 asks first
    expect((await ask(wf.id)).body).toEqual([]); // production still runs v1
    expect((await ask(wf.id, `?update=${agent.id}`)).body).toEqual([expect.objectContaining({ tool: 'Send Email', trigger: 'webhook' })]);
    // The reverse: an update that drops the tool no longer warns.
    agentStore.saveDraft(agent.id, { tools: [READ] });
    agentStore.publish(agent.id);
    expect((await ask(wf.id, `?update=${agent.id}`)).body).toEqual([]);
  });

  it('answers by access: an unknown workflow or version is 404, someone without access gets 404, no sign-in is refused; no secret is in the answer', async () => {
    const wf = flow('core.webhook', triager.id, { path: 'ag23u-access' });
    expect((await ask('wf_nothing')).status).toBe(404);
    expect((await ask(wf.id, '?version=999')).status).toBe(404);
    const owner = await ask(wf.id, '?version=draft');
    expect(owner.status).toBe(200);
    expect(owner.text).not.toMatch(/password|token|secret|apikey/i);
    // Read access decides, as for every workflow route: someone with no access to the workflow's project gets the 404 of a missing one.
    enableTestAuth({ ...TEST_OWNER, id: 'usr_outsider', email: 'outsider@landflow.test', role: 'member' });
    expect((await ask(wf.id, '?version=draft')).status).toBe(404);
    disableTestAuth();
    expect((await ask(wf.id, '?version=draft')).status).toBe(401);
  });
});

describe('the publish card and the menu say it', () => {
  let root: Root;
  let host: HTMLElement;
  beforeEach(() => {
    useEditor.setState({ workflowId: 'wf1', dirty: false } as never);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const body = String(url).includes('/unattended-approvals') ? [{ tool: 'Send Email', agent: 'Triager', node: 'Agent', trigger: 'webhook', line: refusesLine('Send Email', 'webhook', 'refuseSetting') }] : {};
        return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
      }),
    );
    host = document.body.appendChild(document.createElement('div'));
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  it('the publish card renders the line (once per tool) for a draft offer', async () => {
    const offer = { workflowId: 'wf1', kind: 'draft' as const, nextVersion: 7, pins: [{ nodeId: 'n1', agentId: 'a1', agentName: 'Triager', version: 1 }] };
    await act(async () => root.render(createElement(PublishCardView, { itemId: 'i1', offer })));
    await vi.waitFor(() => expect(host.querySelector('[data-testid="unattended-lines"]')).not.toBeNull());
    expect(host.querySelector('[data-testid="unattended-lines"]')!.textContent).toBe(refusesLine('Send Email', 'webhook', 'refuseSetting'));
    expect(host.querySelectorAll('[data-testid="unattended-lines"] > div')).toHaveLength(1);
  });

  it('the publish card of an update offer asks for the agents being updated', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (urls.push(String(url)), new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }))));
    const offer = { workflowId: 'wf1', kind: 'update' as const, nextVersion: 3, pins: [{ nodeId: 'n1', agentId: 'a1', agentName: 'Triager', version: 2 }], updates: [{ agentId: 'a1', agentName: 'Triager' }] };
    await act(async () => root.render(createElement(PublishCardView, { itemId: 'i2', offer: offer as never })));
    await vi.waitFor(() => expect(urls.some((u) => u.includes('/unattended-approvals'))).toBe(true));
    expect(urls.find((u) => u.includes('/unattended-approvals'))).toContain('update=a1');
  });

  it('the menu’s component shows nothing when no tool asks first', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })));
    await act(async () => root.render(createElement(UnattendedLines, { workflowId: 'wf1', version: 'draft' })));
    await new Promise((r) => setTimeout(r, 20));
    expect(host.querySelector('[data-testid="unattended-lines"]')).toBeNull();
  });
});
