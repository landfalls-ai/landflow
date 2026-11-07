/**
 * Chat leftovers (docs/specs/17-notes/FinishChat.md): feedback on a picked agent's answer checks the session from the run
 * itself, a roster target whose Session Key can't give a picked agent its own memory is warned about, the roster's Node
 * field lists the workflow's agent nodes, and the sentence splitter that reads a streaming reply aloud.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Workflow, WorkflowNode } from '@landflow/engine';
import { defineNode, definePlugin } from '@landflow/sdk';

vi.setConfig({ testTimeout: 30_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-chat-finish-'));
Object.assign(process.env, { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' });

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { rosterSessionKeyProblems } = await import('@/lib/server/chat');
const { takeSentences } = await import('@/lib/server/chat-client');
const { sessionKeyProblem, WORKFLOW_NODES_METHOD, ROSTER_TARGET_TYPES } = await import('@/lib/shared/chat-roster-hints');
const { store } = await import('@/lib/server/store');
const { publishDraft } = await import('@/lib/server/publish');
const { validateWorkflow } = await import('@/lib/server/mcp/workflows');
const chatRoute = await import('@/app/chat/[...path]/route');
registry.registerBuiltin(corePlugin);

const echo = defineNode({
  description: { name: 'echoItem', displayName: 'Echo item', description: 'Test node', version: 1, kind: 'action', inputs: [{ type: 'main' }], outputs: [{ type: 'main' }], properties: [] },
  async execute(ctx) {
    return [[{ json: { output: JSON.stringify({ node: ctx.getNode().name }) } }]];
  },
});
registry.registerBuiltin(definePlugin({ info: { id: 'finishtest', name: 'Finish test', version: '0.0.1', description: 'test', icon: 'lucide:bot', color: '#000', author: 'test' }, nodes: [echo] }));

const node = (id: string, type: string, parameters: Record<string, unknown> = {}): WorkflowNode => ({ id, name: id, type, typeVersion: 1, position: [0, 0], parameters });
const edge = (source: string, target: string) => ({ id: `${source}-${target}`, type: 'main' as const, source, target, sourceIndex: 0, targetIndex: 0 });
const roster = { agent: [{ key: 'billing', label: 'Billing', target: 'Billing' }] };

const ctx = (path: string) => ({ params: Promise.resolve({ path: path.split('/').filter(Boolean) }) });
const post = (path: string, body: unknown) => chatRoute.POST(new Request(`http://chat.test/chat/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), ctx(path));

async function chat(id: string): Promise<void> {
  const workflow: Workflow = {
    id,
    name: id,
    nodes: [node('Chat', 'core.chatTrigger', { public: true, responseMode: 'lastNode', roster }), node('Lead', 'finishtest.echoItem'), node('Billing', 'finishtest.echoItem')],
    connections: [edge('Chat', 'Lead')],
  };
  store.saveWorkflow(workflow);
  await publishDraft(id, 'tester', 'chat');
}

describe('feedback on a picked agent', () => {
  it('rates the answer of its own session, and refuses another session', async () => {
    await chat('wf_finish_fb');
    const answered = (await (await post('wf_finish_fb', { sessionId: 'visitor-a', message: 'Refund?', agentKey: 'billing' })).json()) as { executionId: string };
    const rate = (sessionId: string) => post('wf_finish_fb/feedback', { sessionId, executionId: answered.executionId, rating: 'up' });
    expect((await rate('visitor-b')).status).toBe(403);
    const ok = await rate('visitor-a');
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { feedback: { rating: string; sessionId: string } }).feedback).toMatchObject({ rating: 'up', sessionId: 'visitor-a' });
  });

  it('still checks the lead (the trigger ran)', async () => {
    await chat('wf_finish_lead');
    const answered = (await (await post('wf_finish_lead', { sessionId: 'visitor-a', message: 'Hi' })).json()) as { executionId: string };
    expect((await post('wf_finish_lead/feedback', { sessionId: 'visitor-b', executionId: answered.executionId, rating: 'up' })).status).toBe(403);
    expect((await post('wf_finish_lead/feedback', { sessionId: 'visitor-a', executionId: answered.executionId, rating: 'down' })).status).toBe(200);
  });
});

const agentNode = (parameters: Record<string, unknown>) => node('Billing', 'core.messageAgent', parameters);
const workflowWith = (target: WorkflowNode, triggerName = 'Chat'): Workflow => ({
  id: 'wf_finish_warn',
  name: 'warn',
  nodes: [{ ...node('Chat', 'core.chatTrigger', { public: true, roster }), name: triggerName }, target],
  connections: [edge('Chat', 'Billing')],
});

describe('a roster target whose memory key ignores the pick', () => {
  it('warns about a fixed Session Key', () => {
    const problems = rosterSessionKeyProblems(workflowWith(agentNode({ conversation: 'key', sessionKey: 'shared' })));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('fixed Session Key "shared"');
  });
  it('warns about a key read from the trigger by name (Run an Agent and AI Agent)', () => {
    expect(rosterSessionKeyProblems(workflowWith(agentNode({ conversation: 'key', sessionKey: "{{ $('Chat').item.json.sessionId }}" })))[0]).toContain('by name');
    const ai = node('Billing', 'core.aiAgent', { options: { sessionId: '{{ $node["Chat"].json.sessionId }}' } });
    expect(rosterSessionKeyProblems(workflowWith(ai))).toHaveLength(1);
  });
  it('is quiet for the default, a new session per item, other expressions and a team', () => {
    expect(rosterSessionKeyProblems(workflowWith(agentNode({ conversation: 'key', sessionKey: '{{ $json.sessionId }}' })))).toEqual([]);
    expect(rosterSessionKeyProblems(workflowWith(agentNode({ conversation: 'new', sessionKey: 'shared' })))).toEqual([]);
    expect(rosterSessionKeyProblems(workflowWith(agentNode({ conversation: 'key', sessionKey: '{{ $json.user }}' })))).toEqual([]);
    expect(rosterSessionKeyProblems(workflowWith(node('Billing', 'core.runTeam', { teamId: 't' })))).toEqual([]);
  });
  it('is quiet when the chat is not public', () => {
    const workflow = workflowWith(agentNode({ conversation: 'key', sessionKey: 'shared' }));
    workflow.nodes[0].parameters = { roster };
    expect(rosterSessionKeyProblems(workflow)).toEqual([]);
  });
  it('shows in validate_workflow as a warning, without changing the parameters', async () => {
    const workflow = workflowWith(agentNode({ conversation: 'key', sessionKey: 'shared' }));
    const result = (await validateWorkflow(workflow)) as { warnings: string[] };
    expect(result.warnings.some((w) => w.startsWith('Public chat:') && w.includes('fixed Session Key'))).toBe(true);
    expect(workflow.nodes[1].parameters).toEqual({ conversation: 'key', sessionKey: 'shared' });
  });
  it('the editor hint uses the same rule', () => {
    const trigger = { id: 'Chat', name: 'When chat', type: 'core.chatTrigger' };
    expect(sessionKeyProblem({ id: 'a', name: 'A', type: 'core.messageAgent', parameters: { conversation: 'key', sessionKey: 'x' } }, trigger)).toContain('fixed');
    expect(sessionKeyProblem({ id: 'a', name: 'A', type: 'core.messageAgent', parameters: {} }, trigger)).toBeUndefined();
  });
});

describe('the roster Node field', () => {
  it('asks the editor to list the workflow’s agent, team and AI Agent nodes', async () => {
    const trigger = registry.resolve('core.chatTrigger');
    if ('error' in trigger) throw new Error('no trigger');
    const group = trigger.descriptor.properties.find((p) => p.name === 'roster')!.groups![0];
    const field = group.values.find((v) => v.name === 'target')!;
    expect(field.type).toBe('string');
    expect(field.typeOptions?.loadOptionsMethod).toBe(`${WORKFLOW_NODES_METHOD}${ROSTER_TARGET_TYPES.join('|')}`);
    for (const type of ROSTER_TARGET_TYPES) expect(registry.resolve(type)).not.toHaveProperty('error');
  });
});

describe('the sentence splitter for streaming speech', () => {
  it('takes complete sentences and holds the unfinished one', () => {
    const r = takeSentences('One. Two! Thr', false);
    expect(r.sentences).toEqual(['One.', 'Two!']);
    expect('One. Two! Thr'.slice(r.used).trim()).toBe('Thr');
  });
  it('waits for the white space after a full stop (3.5 and "e.g" stay whole while streaming)', () => {
    expect(takeSentences('It costs 3.5', false).sentences).toEqual([]);
    expect(takeSentences('It costs 3.5 euros. Next', false).sentences).toEqual(['It costs 3.5 euros.']);
    expect(takeSentences('Done.', false).sentences).toEqual([]);
    expect(takeSentences('Done.', true).sentences).toEqual(['Done.']);
  });
  it('ends at a line break and keeps closing quotes and brackets', () => {
    expect(takeSentences('A heading\nShe said "go." Then (ok.) end', false).sentences).toEqual(['A heading', 'She said "go."', 'Then (ok.)']);
  });
  it('flushes the rest at the end and drops empty pieces', () => {
    expect(takeSentences('  \n First. Rest of it', true).sentences).toEqual(['First.', 'Rest of it']);
    expect(takeSentences('', true)).toEqual({ sentences: [], used: 0 });
  });
  it('cuts a very long run at a space', () => {
    const long = `${'word '.repeat(60)}end`;
    const r = takeSentences(long, false);
    expect(r.sentences.length).toBeGreaterThan(0);
    expect(r.sentences[0].length).toBeLessThanOrEqual(241);
  });
  it('reading the next call from `used` never repeats a sentence', () => {
    let text = '';
    let said = 0;
    const spoken: string[] = [];
    for (const piece of ['Hello the', 're. How a', 're you? Fine', '. Bye']) {
      text += piece;
      const r = takeSentences(text.slice(said), false);
      said += r.used;
      spoken.push(...r.sentences);
    }
    spoken.push(...takeSentences(text.slice(said), true).sentences);
    expect(spoken).toEqual(['Hello there.', 'How are you?', 'Fine.', 'Bye']);
  });
});
