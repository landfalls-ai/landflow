/**
 * AG10: Run an Agent asks in the editor's chat (nodes/agents.ts, Tool Approvals). In a chat-mode run with "Ask in the editor's
 * chat", a tool that needs approval puts the execution to wait (the AI Agent node's wait: data.approval); the person's decision
 * through the approvals route's function resumes the same agent session. Every other mode, and "Refuse" (the default), deny
 * the call exactly as before. A scripted model on the fake Ollama; a stand-in write tool with requireApproval.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { toToolName, type ExecutionMode, type Workflow, type WorkflowNode } from '@landflow/engine';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { startFakeModels, type FakeReply } from './fake-ai-services';

vi.setConfig({ testTimeout: 30_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-run-agent-chat-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { store } = await import('@/lib/server/store');
const { runWorkflow } = await import('@/lib/server/runner');
const { agentStore } = await import('@/lib/server/agents/store');
const { decideApproval } = await import('@/lib/server/approvals');
const { starterFlow } = await import('@/lib/shared/agent-card');
const { registerInboxPort } = await import('@/lib/server/approval-inbox/port'); // AP02:

registry.registerBuiltin(corePlugin);

type Body = { model: string; messages: Array<{ role: string; content: string }> };
let script: (turn: number, body: Body) => FakeReply = () => ({ text: 'ok' });
let turn = 0;
const toolResults: string[] = [];
const fake = await startFakeModels({
  reply: (_provider, body: Body) => {
    turn += 1;
    const last = [...body.messages].reverse().find((m) => m.role === 'tool');
    if (last) toolResults.push(last.content);
    return script(turn, body);
  },
});
afterAll(async () => {
  await fake.close();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const SEND = 'Send Email';
const WRITE = toToolName(SEND);
const writer = agentStore.create({
  name: 'Mailer',
  instructions: 'You send emails.',
  model: { provider: 'ollama', model: 'mailer-model', baseUrl: fake.url.replace(/\/v1$/, '') },
  tools: [
    { id: 't1', type: 'node', name: SEND, description: 'Send', nodeType: 'core.noOp', parameters: {}, requireApproval: true },
    { id: 't2', type: 'node', name: 'Post Update', description: 'Post', nodeType: 'core.noOp', parameters: {}, requireApproval: true },
  ],
});
agentStore.publish(writer.id);
const POST = toToolName('Post Update');

const node = (id: string, type: string, parameters: Record<string, unknown> = {}): WorkflowNode => ({ id, name: id, type, typeVersion: 1, position: [0, 0], parameters });
let n = 0;
function flow(parameters: Record<string, unknown>, trigger = 'core.chatTrigger'): Workflow {
  const wf: Workflow = {
    id: `wf_ag10_${++n}`,
    name: 'ag10',
    nodes: [node('Start', trigger, trigger === 'core.webhook' ? { path: `ag10-${n}`, method: 'POST' } : {}), node('Agent', 'core.messageAgent', { agentId: writer.id, message: 'Email oncall', ...parameters })],
    connections: [{ id: 'a', type: 'main', source: 'Start', target: 'Agent', sourceIndex: 0, targetIndex: 0 }],
  };
  store.saveWorkflow(wf);
  return wf;
}
const run = (wf: Workflow, mode: ExecutionMode) => {
  turn = 0;
  toolResults.length = 0;
  return runWorkflow({ workflow: wf, mode, startNodeId: 'Start', triggerItems: [{ json: { chatInput: 'Email oncall' } }] });
};
const call = (name: string, args: Record<string, unknown>, id: string) => ({ id, name, arguments: args });
const out = (record: Awaited<ReturnType<typeof run>>) => record.runData.Agent?.at(-1)?.outputs?.[0]?.[0]?.json as { reply: string; steps: Array<{ tool: string; status: string }> };
const approvalOf = (record: Awaited<ReturnType<typeof run>>) => record.wait?.data?.approval as { calls: Array<{ id: string; tool: string; input: Record<string, unknown> }>; channel: string };

const idOf = (record: Awaited<ReturnType<typeof run>>, index: number) => approvalOf(record).calls[index].id;

describe('Run an Agent, Tool Approvals', () => {
  it('asks in the editor’s chat, then runs the tool once on Approve', async () => {
    script = (t, body) => (t === 1 ? { toolCalls: [call(WRITE, { to: 'oncall@landflow.test' }, 'c_send')] } : { text: `Sent: ${[...body.messages].reverse().find((m) => m.role === 'tool')?.content.slice(0, 40)}` });
    const record = await run(flow({ toolApprovals: 'askInChat' }), 'chat');
    expect(record.status).toBe('waiting');
    const approval = approvalOf(record);
    expect(approval.channel).toBe('chat');
    expect(approval.calls).toEqual([{ id: expect.any(String), tool: SEND, input: { to: 'oncall@landflow.test' } }]);
    expect(record.wait?.data).toMatchObject({ agentApproval: { agent: 'Mailer' } });
    // The tool has not run: the model was asked once and has seen no tool result.
    expect(turn).toBe(1);
    expect(toolResults).toEqual([]);
    const outcome = await decideApproval(record.executionId, idOf(record, 0), true, { by: 'owner@landflow.test' });
    expect(outcome.status).toBe('resumed');
    const done = (outcome as { record: typeof record }).record;
    expect(done.error?.message ?? done.status).toBe('success');
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]).not.toContain('needs a person');
    expect(out(done).reply).toMatch(/^Sent:/);
    expect(out(done).steps).toEqual([expect.objectContaining({ tool: WRITE, status: 'success' })]);
  });

  it('Approve with changes runs the tool with the person’s input', async () => {
    script = (t) => (t === 1 ? { toolCalls: [call(WRITE, { to: 'model@x' }, 'c_send')] } : { text: 'Sent.' });
    const record = await run(flow({ toolApprovals: 'askInChat' }), 'chat');
    const outcome = await decideApproval(record.executionId, idOf(record, 0), true, { input: { to: 'oncall@landflow.test' } });
    const done = (outcome as { record: typeof record }).record;
    expect(done.status).toBe('success');
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]).toContain('oncall@landflow.test');
    expect(toolResults[0]).not.toContain('model@x');
  });

  it('on Reject the tool never runs and the model answers', async () => {
    script = (t) => (t === 1 ? { toolCalls: [call(WRITE, { to: 'oncall@landflow.test' }, 'c_send')] } : { text: 'I did not send it.' });
    const record = await run(flow({ toolApprovals: 'askInChat' }), 'chat');
    expect(record.status).toBe('waiting');
    const outcome = await decideApproval(record.executionId, idOf(record, 0), false, { by: 'owner@landflow.test' });
    const done = (outcome as { record: typeof record }).record;
    expect(done.status).toBe('success');
    expect(out(done).reply).toBe('I did not send it.');
    expect(out(done).steps).toEqual([expect.objectContaining({ tool: WRITE, status: 'denied' })]);
  });

  it('two writes in one turn wait together and one resume follows both decisions', async () => {
    script = (t) => (t === 1 ? { toolCalls: [call(WRITE, { to: 'a' }, 'c_one'), call(POST, { text: 'b' }, 'c_two')] } : { text: 'Done.' });
    const record = await run(flow({ toolApprovals: 'askInChat' }), 'chat');
    expect(approvalOf(record).calls.map((c) => c.tool)).toEqual([SEND, 'Post Update']);
    const first = await decideApproval(record.executionId, idOf(record, 0), true);
    expect(first.status).toBe('waiting');
    const second = await decideApproval(record.executionId, idOf(record, 1), false);
    expect(second.status).toBe('resumed');
    const done = (second as { record: typeof record }).record;
    expect(done.status).toBe('success');
    expect(out(done).steps.map((s) => s.status)).toEqual(['success', 'denied']);
    expect(out(done).reply).toBe('Done.');
  });

  it('two writes, the first approved plainly and the second with changes, both run', async () => {
    script = (t) => (t === 1 ? { toolCalls: [call(WRITE, { to: 'a' }, 'c_one'), call(POST, { text: 'model' }, 'c_two')] } : { text: 'Done.' });
    const record = await run(flow({ toolApprovals: 'askInChat' }), 'chat');
    const first = await decideApproval(record.executionId, idOf(record, 0), true);
    expect(first.status).toBe('waiting');
    const second = await decideApproval(record.executionId, idOf(record, 1), true, { input: { text: 'edited' } });
    expect(second.status).toBe('resumed');
    const done = (second as { record: typeof record }).record;
    expect(done.error?.message ?? done.status).toBe('success');
    expect(out(done).steps.map((s) => s.status)).toEqual(['success', 'success']);
    expect(toolResults.join('\n')).toContain('edited');
    expect(toolResults.join('\n')).not.toContain('model');
  });

  it('a second approval in the same run waits again', async () => {
    script = (t) => (t === 1 ? { toolCalls: [call(WRITE, { to: 'a' }, 'c_one')] } : t === 2 ? { toolCalls: [call(POST, { text: 'b' }, 'c_two')] } : { text: 'Both.' });
    const record = await run(flow({ toolApprovals: 'askInChat' }), 'chat');
    const next = await decideApproval(record.executionId, idOf(record, 0), true);
    const waiting = (next as { record: typeof record }).record;
    expect(waiting.status).toBe('waiting');
    expect(approvalOf(waiting).calls.map((c) => c.tool)).toEqual(['Post Update']);
    const last = await decideApproval(record.executionId, idOf(waiting, 0), true);
    expect((last as { record: typeof record }).record.status).toBe('success');
    expect(out((last as { record: typeof record }).record).reply).toBe('Both.');
  });

  it('a second chat message to a keyed conversation that waits for approval fails and sends nothing; the first still ends success', async () => {
    script = (_t, body) => (body.messages.some((m) => m.role === 'tool') ? { text: 'Sent.' } : { toolCalls: [call(WRITE, { to: 'oncall@landflow.test' }, 'c_send')] });
    const wf = flow({ toolApprovals: 'askInChat', conversation: 'key', sessionKey: 'fixed-key' });
    const first = await run(wf, 'chat');
    expect(first.status).toBe('waiting');
    const asked = turn;
    const second = await run(wf, 'chat');
    expect(second.status).toBe('error');
    expect(second.error?.message).toMatch(/waiting for Approve or Reject on its last tool call/);
    expect(turn).toBe(0);
    expect(asked).toBe(1);
    const outcome = await decideApproval(first.executionId, idOf(first, 0), true);
    expect(outcome.status).toBe('resumed');
    expect((outcome as { record: typeof first }).record.status).toBe('success');
  });

  it('the chat’s step list reads Waiting for approval while a call waits, Denied after Deny, and Done after Approve', async () => {
    const { streamer } = await import('@/lib/server/nodes/agents');
    const { ToolCalls } = await import('@/components/editor/chat-panel');
    const sent: Array<{ tool?: { status: string } }> = [];
    const feed = streamer((c) => sent.push(c as never), 0);
    const entry = (status: string) => feed({ type: 'entry', entry: { type: 'tool', callId: 'c1', tool: 'send_email', status, input: {} } } as never);
    const label = (status: 'approval' | 'denied' | 'finished' | 'failed') => renderToStaticMarkup(createElement(ToolCalls, { calls: [{ id: 'c1', name: 'send_email', status }] }));
    entry('awaiting_approval');
    entry('denied');
    entry('success');
    entry('error');
    expect(sent.map((c) => c.tool?.status)).toEqual(['approval', 'denied', 'finished', 'failed']);
    expect(label('approval')).toContain('Waiting for approval');
    expect(label('approval')).not.toContain('Failed');
    expect(label('denied')).toContain('Denied');
    expect(label('finished')).toContain('Done');
    expect(label('failed')).toContain('Failed');
  });

  it('a resumed run updates the waiting row instead of starting a second one; Deny reads Denied at once', async () => {
    const { settleEarlierCall, markCallDenied, ToolCalls } = await import('@/components/editor/chat-panel');
    const calls = [{ id: 'c1', name: 'send_email', status: 'approval' as const, input: { to: 'a' } }];
    const html = (rows: typeof calls | ReturnType<typeof markCallDenied>) => renderToStaticMarkup(createElement(ToolCalls, { calls: rows as never }));
    const started = settleEarlierCall(calls, { type: 'tool', tool: { id: 'c1', name: 'send_email', status: 'started' } } as never)!;
    const done = settleEarlierCall(started, { type: 'tool', tool: { id: 'c1', name: 'send_email', status: 'finished', output: 'sent' } } as never)!;
    expect(done).toEqual([expect.objectContaining({ id: 'c1', status: 'finished', output: 'sent', input: { to: 'a' } })]);
    expect(html(done)).toContain('Done');
    expect(html(done)).not.toContain('Waiting for approval');
    // A call of the new reply, or any non-tool chunk, is not the old row's.
    expect(settleEarlierCall(calls, { type: 'tool', tool: { id: 'c2', name: 'post', status: 'started' } } as never)).toBeUndefined();
    expect(settleEarlierCall(calls, { type: 'item', content: 'hi' } as never)).toBeUndefined();
    expect(html(markCallDenied(calls, 'c1') as never)).toContain('Denied');
  });

  it('a tool that takes only what its schema offers: the waiting step and the card show what runs, and an edit that adds a field says it was ignored', async () => {
    const poster = agentStore.create({
      name: 'Poster',
      instructions: 'You post notes.',
      model: { provider: 'ollama', model: 'poster-model', baseUrl: fake.url.replace(/\/v1$/, '') },
      tools: [{ id: 't9', type: 'node', name: 'Post Note', description: 'Post', nodeType: 'core.noOp', parameters: { text: "{{ $fromAI('text', 'the note', 'string') }}" }, requireApproval: true }],
    });
    agentStore.publish(poster.id);
    const NOTE = toToolName('Post Note');
    script = (_t, body) => (body.messages.some((m) => m.role === 'tool') ? { text: 'Posted.' } : { toolCalls: [call(NOTE, { text: 'hello', toEmail: 'attacker@example.net' }, 'c_note')] });
    const record = await run(flow({ agentId: poster.id, toolApprovals: 'askInChat' }), 'chat');
    expect(record.status).toBe('waiting');
    expect(approvalOf(record).calls[0].input).toEqual({ text: 'hello' });
    const summary = agentStore.listSessions(poster.id, 5)[0];
    expect(summary).toBeDefined();
    const timeline = JSON.stringify(agentStore.getSession(summary.id)!.timeline);
    expect(timeline).toContain('hello');
    expect(timeline).not.toContain('attacker@example.net');
    const outcome = await decideApproval(record.executionId, idOf(record, 0), true, { input: { text: 'edited', other: 'x' } });
    expect((outcome as { record: typeof record }).record.status).toBe('success');
    expect(toolResults.join('\n')).toMatch(/other is not something this tool takes; ignored/);
    const after = agentStore.getSession(summary.id)!;
    expect(after.timeline.some((e) => e.type === 'notice' && /other is not something Post Note takes; ignored/.test(e.message))).toBe(true);
  });

  it('a keyed conversation whose waiting run was cancelled is not locked: the orphan call is settled as cancelled and the next message goes on', async () => {
    script = (_t, body) => (body.messages.some((m) => m.role === 'tool') ? { text: 'Back again.' } : { toolCalls: [call(WRITE, { to: 'oncall@landflow.test' }, 'c_send')] });
    const wf = flow({ toolApprovals: 'askInChat', conversation: 'key', sessionKey: 'cancel-key' });
    const first = await run(wf, 'chat');
    expect(first.status).toBe('waiting');
    // Still waiting: the guard holds.
    expect((await run(wf, 'chat')).error?.message).toMatch(/waiting for Approve or Reject/);
    // The run is cancelled: nobody can decide it.
    store.saveExecution({ ...store.getExecution(first.executionId)!, status: 'canceled' });
    const next = await run(wf, 'chat');
    expect(next.error?.message ?? next.status).toBe('success');
    expect(toolResults.some((t) => /Cancelled: the run waiting for approval was cancelled/.test(t))).toBe(true);
    expect(out(next).reply).toBe('Back again.');
  });

  it('while an Approve is resuming the run (status running), a second message is refused and sends nothing; the Approve still ends success', async () => {
    script = (_t, body) => (body.messages.some((m) => m.role === 'tool') ? { text: 'Sent.' } : { toolCalls: [call(WRITE, { to: 'oncall@landflow.test' }, 'c_send')] });
    const wf = flow({ toolApprovals: 'askInChat', conversation: 'key', sessionKey: 'resume-window' });
    const first = await run(wf, 'chat');
    expect(first.status).toBe('waiting');
    const record = store.getExecution(first.executionId)!;
    store.saveExecution({ ...record, status: 'running' });
    const second = await run(wf, 'chat');
    expect(second.error?.message).toMatch(/waiting for Approve or Reject/);
    expect(turn).toBe(0);
    store.saveExecution({ ...record, status: 'waiting' });
    const outcome = await decideApproval(first.executionId, idOf(first, 0), true);
    expect((outcome as { record: typeof first }).record.status).toBe('success');
    expect(toolResults.join('\n')).not.toContain('Cancelled');
  });

  it.each([
    ['chat mode with Refuse (the default)', {}, 'chat'],
    ['webhook mode with Ask in the editor’s chat and no approval inbox on the host (AP02: with an inbox it waits, below)', { toolApprovals: 'askInChat' }, 'webhook'],
    ['webhook mode with Refuse, even with an approval inbox (AP02)', { toolApprovals: 'refuse' }, 'webhook'],
    ['manual mode with Ask in the editor’s chat', { toolApprovals: 'askInChat' }, 'manual'],
  ] as const)('refuses as before: %s', async (_name, parameters, mode) => {
    script = (t) => (t === 1 ? { toolCalls: [call(WRITE, { to: 'a' }, 'c_send')] } : { text: 'Could not send.' });
    const record = await run(flow({ ...parameters }), mode);
    expect(record.status).toBe('success');
    expect(toolResults[0]).toContain("needs a person's approval");
    expect(out(record).steps).toEqual([expect.objectContaining({ tool: WRITE, status: 'denied' })]);
  });

  it('AP02: a webhook trigger with Ask waits when the host has an approval inbox (the twin above refuses with none, or with Refuse)', async () => {
    const opened: unknown[] = [];
    registerInboxPort({ open: async (calls) => (opened.push(...calls), { ids: Object.fromEntries(calls.map((c) => [c.callId, 'ib_1'])), expiresAt: new Date(Date.now() + 3_600_000).toISOString(), minutes: 60 }), outcome: () => undefined, settle: async (_e, _c, to) => ({ won: false, outcome: { status: to } }), view: () => undefined });
    try {
      script = (t) => (t === 1 ? { toolCalls: [call(WRITE, { to: 'a' }, 'c_send')] } : { text: 'Could not send.' });
      const record = await run(flow({ toolApprovals: 'askInChat' }, 'core.webhook'), 'webhook');
      expect(record.status).toBe('waiting');
      expect(record.triggerType).toBe('core.webhook');
      expect(opened).toHaveLength(1);
      expect(toolResults).toEqual([]);
      // Refuse still refuses with an inbox on the host.
      const refused = await run(flow({ toolApprovals: 'refuse' }, 'core.webhook'), 'webhook');
      expect(refused.status).toBe('success');
      expect(toolResults[0]).toContain("needs a person's approval");
    } finally {
      registerInboxPort(undefined as never);
    }
  });

  it.each([
    ['the hosted chat page (core.chatTrigger, mode webhook)', 'core.chatTrigger', 'webhook', 'the hosted chat page cannot show an approval'],
    ['an MCP trigger (mode mcp)', 'core.mcpTrigger', 'mcp', 'an MCP call answers its caller at once'],
    ['an MCP trigger even in mode webhook', 'core.mcpTrigger', 'webhook', 'an MCP call answers its caller at once'],
  ] as const)('wave ap1: Ask refuses from %s even with an approval inbox, and says why', async (_name, trigger, mode, why) => {
    const opened: unknown[] = [];
    registerInboxPort({ open: async (calls) => (opened.push(...calls), { ids: Object.fromEntries(calls.map((c) => [c.callId, 'ib_1'])), expiresAt: new Date(Date.now() + 3_600_000).toISOString(), minutes: 60 }), outcome: () => undefined, settle: async (_e, _c, to) => ({ won: false, outcome: { status: to } }), view: () => undefined });
    try {
      script = (t) => (t === 1 ? { toolCalls: [call(WRITE, { to: 'a' }, 'c_send')] } : { text: 'Could not send.' });
      turn = 0;
      toolResults.length = 0;
      // The trigger's output is given (an MCP trigger's own item is the tool call), so the step gets the chat input either way.
      const record = await runWorkflow({ workflow: flow({ toolApprovals: 'askInChat' }, trigger), mode, triggerOutput: { nodeId: 'Start', items: [{ json: { chatInput: 'Email oncall' } }] } });
      expect(record.status).toBe('success');
      expect(record.triggerType).toBe(trigger);
      expect(opened).toEqual([]);
      expect(toolResults[0]).toContain("needs a person's approval");
      expect(toolResults[0]).toContain(why);
      expect(out(record).steps).toEqual([expect.objectContaining({ tool: WRITE, status: 'denied' })]);
    } finally {
      registerInboxPort(undefined as never);
    }
  });

  it('wave ap1: the hosted chat that starts at a roster target (triggerType given) refuses too', async () => {
    const opened: unknown[] = [];
    registerInboxPort({ open: async (calls) => (opened.push(...calls), { ids: Object.fromEntries(calls.map((c) => [c.callId, 'ib_1'])), expiresAt: new Date(Date.now() + 3_600_000).toISOString(), minutes: 60 }), outcome: () => undefined, settle: async (_e, _c, to) => ({ won: false, outcome: { status: to } }), view: () => undefined });
    try {
      script = (t) => (t === 1 ? { toolCalls: [call(WRITE, { to: 'a' }, 'c_send')] } : { text: 'Could not send.' });
      turn = 0;
      toolResults.length = 0;
      const record = await runWorkflow({ workflow: flow({ toolApprovals: 'askInChat' }), mode: 'webhook', startNodeId: 'Agent', triggerType: 'core.chatTrigger', triggerItems: [{ json: { chatInput: 'Email oncall' } }] });
      expect(record.status).toBe('success');
      expect(opened).toEqual([]);
      expect(toolResults[0]).toContain('the hosted chat page cannot show an approval');
    } finally {
      registerInboxPort(undefined as never);
    }
  });

  it('the starter flow asks in the chat; a flow saved without the setting refuses', () => {
    const card = starterFlow({ id: 'a1', name: 'Mailer' }, 'hi');
    const agentNode = card.nodes.find((x) => x.type === 'core.messageAgent');
    expect(agentNode?.parameters).toMatchObject({ agentId: 'a1', toolApprovals: 'askInChat' });
  });
});
