/**
 * AG01 (wave ag1): the editor chat runs on the typed message, not the Chat Message trigger's pinned sample, and the last
 * Unpin is saved. The run route (chat branch) and the save route are real; the editor's store builds the saved draft.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Workflow, WorkflowNode } from '@landflow/engine';
import type { NodeTypeInfo } from '@/lib/shared/types';
import { starterFlow } from '@/lib/shared/agent-card';
import { readSse, startFakeModels } from './fake-ai-services';

vi.setConfig({ testTimeout: 20_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-chat-input-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

vi.mock('@/components/canvas/sticky-note', () => ({ STICKY_DEFAULT_CONTENT: '## Note', STICKY_DEFAULT_SIZE: { width: 260, height: 180 } }));

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { store } = await import('@/lib/server/store');
const { agentStore } = await import('@/lib/server/agents/store');
const runRoute = await import('@/app/api/workflows/[id]/run/route');
const workflowRoute = await import('@/app/api/workflows/[id]/route');
const executeRoute = await import('@/app/api/workflows/[id]/execute/route');
const { useEditor } = await import('@/components/editor/store');

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

const params = <T>(value: T) => ({ params: Promise.resolve(value) });
const node = (id: string, type: string, parameters: Record<string, unknown> = {}): WorkflowNode => ({ id, name: id, type, typeVersion: 1, position: [0, 0], parameters });
const post = (path: string, method: string, body: unknown) => new Request(`http://chat.test${path}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const chat = async (id: string, message: string) => {
  const events = await readSse(await runRoute.POST(post(`/api/workflows/${id}/run`, 'POST', { chat: { message, sessionId: 's1' } }), params({ id })));
  const result = events.find((e) => e.event === 'result')!.data;
  expect(result.status).toBe('success');
  return (await store.loadExecution(result.executionId))!;
};

describe('the editor chat with a pinned sample on the trigger', () => {
  it('runs the next step on the typed message, not the pin', async () => {
    const wf: Workflow = {
      id: 'wf_chat_pin',
      name: 'Chat pin',
      nodes: [node('Chat', 'core.chatTrigger'), node('Copy', 'core.set', { values: [{ name: 'seen', value: '{{ $json.chatInput }}' }] })],
      connections: [{ id: 'e', type: 'main', source: 'Chat', sourceIndex: 0, target: 'Copy', targetIndex: 0 }],
      pinData: { Chat: [{ json: { chatInput: 'Paste a Grafana alert about high CPU on a host', sessionId: 'sample' } }] },
    };
    store.saveWorkflow(wf);
    const typed = 'Wazuh alert: rule 5710, sshd brute force on host db-3';
    const execution = await chat(wf.id, typed);
    const out = JSON.stringify(execution.runData.Copy.at(-1)!.outputs);
    expect(out).toContain(typed);
    expect(out).not.toContain('Grafana');
    expect(execution.runData.Chat[0].logs?.map((l) => l.message)).toContain('Used the chat message, not the pinned sample');
  });

  it('the starter flow reaches its Run an Agent step with what was typed', async () => {
    const agent = agentStore.create({ name: 'Math desk', instructions: 'Answer briefly.', model: { provider: 'ollama', model: 'm', baseUrl: fake.url.replace(/\/v1$/, '') } });
    agentStore.publish(agent.id);
    useEditor.getState().load({ id: 'wf_starter', name: 'Starter', nodes: [], connections: [] }, types);
    const starter = starterFlow(agent, 'Hello Math desk, what can you do?');
    useEditor.getState().applyTemplate({ ...starter, id: 'starter', description: '' } as never);
    const target = useEditor.getState().nodes.find((n) => n.data.wf.type === 'core.chatTrigger')!;
    useEditor.getState().setPinData(target.id, Object.values(starter.pinData)[0]);
    const draft = useEditor.getState().toWorkflow();
    expect(Object.keys(draft.pinData ?? {})).toHaveLength(1);
    store.saveWorkflow(draft);
    const execution = await chat(draft.id, 'What is 2+2?');
    const agentNode = draft.nodes.find((n) => n.type === 'core.messageAgent')!;
    expect(JSON.stringify(execution.runData[agentNode.id].at(-1)!.inputs)).toContain('What is 2+2?');
    expect(JSON.stringify(execution.runData[agentNode.id].at(-1)!.outputs)).toContain('Echo: What is 2+2?');
  });
});

describe('Unpin is saved', () => {
  it('sends pinData {} once the last pin is gone, and the server keeps no pins; an old client body keeps them', async () => {
    const wf: Workflow = {
      id: 'wf_unpin',
      name: 'Unpin',
      nodes: [node('Chat', 'core.chatTrigger')],
      connections: [],
      pinData: { Chat: [{ json: { chatInput: 'sample' } }] },
    };
    store.saveWorkflow(wf);
    useEditor.getState().load(store.getWorkflow(wf.id)!, types);
    const trigger = useEditor.getState().nodes[0].id;
    expect(Object.keys(useEditor.getState().toWorkflow().pinData ?? {})).toEqual([trigger]);
    useEditor.getState().setPinData(trigger, undefined);
    const draft = useEditor.getState().toWorkflow();
    expect(draft.pinData).toEqual({});

    const oldClient = { ...draft } as Record<string, unknown>;
    delete oldClient.pinData;
    await workflowRoute.PUT(post(`/api/workflows/${wf.id}`, 'PUT', oldClient), params({ id: wf.id }));
    expect(Object.keys(store.getWorkflow(wf.id)!.pinData ?? {})).toHaveLength(1);

    const saved = await workflowRoute.PUT(post(`/api/workflows/${wf.id}`, 'PUT', draft), params({ id: wf.id }));
    expect(saved.status).toBe(200);
    expect(Object.keys(store.getWorkflow(wf.id)!.pinData ?? {})).toHaveLength(0);
  });
});

describe('Execute with no input on a pinned trigger', () => {
  it('hands the pin to the next step (the route invents a bare {} seed)', async () => {
    const wf: Workflow = {
      id: 'wf_exec_pin',
      name: 'Exec pin',
      nodes: [node('Chat', 'core.chatTrigger'), node('Copy', 'core.set', { values: [{ name: 'seen', value: '{{ $json.chatInput }}' }] })],
      connections: [{ id: 'e', type: 'main', source: 'Chat', sourceIndex: 0, target: 'Copy', targetIndex: 0 }],
      pinData: { Chat: [{ json: { chatInput: 'pinned sample text', sessionId: 'sample' } }] },
    };
    store.saveWorkflow(wf);
    const res = await executeRoute.POST(post(`/api/workflows/${wf.id}/execute`, 'POST', {}), params({ id: wf.id }));
    const { executionId } = await res.json();
    let execution = await store.loadExecution(executionId);
    for (let i = 0; i < 100 && (!execution || execution.status === 'running'); i++) {
      await new Promise((r) => setTimeout(r, 50));
      execution = await store.loadExecution(executionId);
    }
    expect(execution!.status).toBe('success');
    expect(JSON.stringify(execution!.runData.Copy.at(-1)!.outputs)).toContain('pinned sample text');
  });
});
