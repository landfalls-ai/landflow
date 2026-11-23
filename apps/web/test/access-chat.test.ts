/**
 * C35 (docs/access-requests.md#asking-in-chat): the chat can only file, and only after the person confirmed in a later turn. The server enforces
 * it: the tool answers a summary and a token, and files only with that token from a later run of the same person. The agent loop is run with a
 * fake model.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { Workflow } from '@landflow/engine';
import { startFakeModels } from './fake-ai-services';

vi.setConfig({ testTimeout: 30_000 });
const ENV = { LANDFLOW_DATA_DIR: mkdtempSync(join(tmpdir(), 'landflow-access-chat-')), LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { makeWorld } = await import('./fixtures/access-world');
const { fileAccessFromChat, signToken, verifyToken, parseDuration, runAccessChat, markChatRun, TOKEN_MINUTES } = await import('@/lib/server/access/chat');
const { fileAccessRequestNode } = await import('@/lib/server/nodes/access');
const { runWorkflow } = await import('@/lib/server/runner');
const { chatItem } = await import('@/lib/server/chat');
const { database } = await import('@/lib/server/db');
const { credentials } = await import('@/lib/server/credentials/vault');
const { createEntry } = await import('@/lib/server/access/catalog');
const { accessSettings, saveAccessSettings } = await import('@/lib/server/access/store');
const { store } = await import('@/lib/server/store');
const { setHomeProject } = await import('@/lib/server/projects/store');
const { installAccessRequests } = await import('@/lib/server/access/setup');
const { cancelRequest } = await import('@/lib/server/access/requests');

const models = await startFakeModels({
  reply: (_provider, body) => {
    const last = body.messages[body.messages.length - 1];
    const parts = Array.isArray(last.content) ? last.content : [{ type: 'text', text: String(last.content) }];
    const result = parts.find((p: { type: string }) => p.type === 'tool_result');
    const toolName = body.tools?.[0]?.name as string | undefined;
    if (result) {
      const text = typeof result.content === 'string' ? result.content : JSON.stringify(result.content);
      const token = /"confirmToken":"([^"]+)"/.exec(text)?.[1];
      if (token) script.token = token;
      return { text: token ? 'Shall I file this? Say yes.' : `Done: ${text.slice(0, 200)}` };
    }
    const said = String(parts.find((p: { type: string }) => p.type === 'text')?.text ?? '');
    if (/yes/i.test(said) && script.token) return { toolCalls: [{ id: 'call_2', name: toolName!, arguments: { entry: 'Platform team', duration: '1 h', reason: 'Fixing the build', account: 'mia-gh', confirmToken: script.token } }] };
    return { toolCalls: [{ id: 'call_1', name: toolName!, arguments: { entry: 'Platform team', duration: '1 h', reason: 'Fixing the build', account: 'mia-gh' } }] };
  },
});
const script = { token: undefined as string | undefined };
afterAll(async () => {
  await models.close?.();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const w = await makeWorld();
const { mia, ola, ann, admin, lead, team } = w;
const filed = () => database().get<{ n: number }>(`SELECT COUNT(*) AS n FROM access_requests WHERE channel = 'chat'`)!.n;
const all = () => database().get<{ n: number }>('SELECT COUNT(*) AS n FROM access_requests')!.n;
const base = { entry: 'Platform team', duration: '1 h', reason: 'Fixing the build', account: 'mia-gh' };

describe('the tool read back, then filed', () => {
  it('without a token files nothing and answers a summary and a token', async () => {
    const before = all();
    const answer = await fileAccessFromChat({ userId: mia.id, executionId: 'ex_a', ...base });
    expect(answer.status).toBe('confirm');
    expect(answer.summary).toContain('Mia Member asks for Platform team');
    expect(answer.summary).toContain('For: 1 h');
    expect(answer.confirmToken).toEqual(expect.any(String));
    expect(all()).toBe(before);
    expect(verifyToken(answer.confirmToken!)).toMatchObject({ u: mia.id, e: team.id, d: 60, x: 'ex_a' });
  });

  it('files with that token in a later run of the same person, as a chat request', async () => {
    const { confirmToken } = await fileAccessFromChat({ userId: mia.id, executionId: 'ex_a', ...base });
    const answer = await fileAccessFromChat({ userId: mia.id, executionId: 'ex_b', ...base, confirmToken });
    expect(answer).toMatchObject({ status: 'filed', requestId: expect.any(String), state: 'pending' });
    expect(w.requestRow(answer.requestId!)).toMatchObject({ channel: 'chat', requester_id: mia.id, status: 'pending' });
    await cancelRequest(mia, answer.requestId!);
  });

  it('refuses the token in the same run, for another person, after 15 minutes, or with changed fields — and files nothing', async () => {
    const before = all();
    const { confirmToken } = await fileAccessFromChat({ userId: mia.id, executionId: 'ex_c', ...base });
    for (const [label, call] of [
      ['the same run', { userId: mia.id, executionId: 'ex_c', ...base, confirmToken }],
      ['another person', { userId: ola.id, executionId: 'ex_d', ...base, confirmToken }],
      ['a changed duration', { userId: mia.id, executionId: 'ex_d', ...base, duration: '15 min', confirmToken }],
      ['a changed reason', { userId: mia.id, executionId: 'ex_d', ...base, reason: 'Something else', confirmToken }],
      ['a changed account', { userId: mia.id, executionId: 'ex_d', ...base, account: 'other-gh', confirmToken }],
      ['a forged token', { userId: mia.id, executionId: 'ex_d', ...base, confirmToken: `${confirmToken}x` }],
      ['a made-up token', { userId: mia.id, executionId: 'ex_d', ...base, confirmToken: 'abc.def' }],
    ] as const) {
      const answer = await fileAccessFromChat(call);
      expect(answer.status, label).toBe('refused');
    }
    const old = signToken({ u: mia.id, e: team.id, d: 60, r: 'Fixing the build', a: 'mia-gh', x: 'ex_old', t: Date.now() - 1 });
    expect((await fileAccessFromChat({ userId: mia.id, executionId: 'ex_e', ...base, confirmToken: old })).status).toBe('refused');
    expect(TOKEN_MINUTES).toBe(15);
    expect(all()).toBe(before);
  });

  it('asks for what is missing instead of guessing', async () => {
    const entries = await fileAccessFromChat({ userId: mia.id, executionId: 'ex_f', entry: '' });
    expect(entries).toMatchObject({ status: 'need', candidates: expect.arrayContaining(['Platform team']) });
    expect(await fileAccessFromChat({ userId: mia.id, executionId: 'ex_f', ...base, entry: 'Nothing like it' })).toMatchObject({ status: 'need', candidates: expect.any(Array) });
    expect(await fileAccessFromChat({ userId: mia.id, executionId: 'ex_f', ...base, duration: '30 min' })).toMatchObject({ status: 'need', durations: ['1 h', '15 min', '1 min', 'unlimited'] });
    expect(await fileAccessFromChat({ userId: mia.id, executionId: 'ex_f', ...base, reason: 'x' })).toMatchObject({ status: 'need' });
    expect((await fileAccessFromChat({ userId: ola.id, executionId: 'ex_f', ...base, account: '' })).message).toMatch(/GitHub username/);
    createEntry(admin, { name: 'Platform team (staging)', system: 'manual', target: { instructions: 'By hand' }, durations: [60], approverIds: [ann.id], owners: [lead.id] });
    // The exact name wins; a part of a name that two entries have is ambiguous.
    expect((await fileAccessFromChat({ userId: mia.id, executionId: 'ex_f', ...base })).status).toBe('confirm');
    expect(await fileAccessFromChat({ userId: mia.id, executionId: 'ex_f', ...base, entry: 'platform' })).toMatchObject({ status: 'need', candidates: ['Platform team', 'Platform team (staging)'] });
  });

  it('refuses a run nobody signed in for', async () => {
    const answer = await fileAccessFromChat({ userId: undefined, executionId: 'ex_g', ...base });
    expect(answer).toMatchObject({ status: 'refused', message: 'Sign in on the Access page to ask for access.' });
    expect((await fileAccessFromChat({ userId: 'usr_gone', executionId: 'ex_g', ...base })).status).toBe('refused');
  });

  it('has one operation: no way to approve, grant or choose who is asking', () => {
    const names = (fileAccessRequestNode.description.properties as Array<{ name: string }>).map((p) => p.name);
    expect(names).toEqual(['entry', 'duration', 'reason', 'account', 'confirmToken']);
    expect(fileAccessRequestNode.description.usableAsTool).toBe(true);
  });

  it('parses the durations people say', () => {
    expect(['15', '15 min', '1 h', '2 hours', '1 day', '7 days', 'unlimited', 'forever', '90 minutes', 'soon', '', null].map(parseDuration)).toEqual([15, 15, 60, 120, 1_440, 10_080, null, null, 90, undefined, undefined, null]);
  });
});

describe('the tool in a run', () => {
  const flow = (params: Record<string, unknown>): Workflow =>
    ({
      id: 'wf_chat_tool',
      name: 'Chat tool',
      nodes: [
        { id: 'chat', name: 'Chat', type: 'core.chatTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
        { id: 'file', name: 'File', type: 'core.fileAccessRequest', typeVersion: 1, position: [200, 0], parameters: params },
      ],
      connections: [{ id: 'c1', type: 'main', source: 'chat', target: 'file', sourceIndex: 0, targetIndex: 0 }],
    }) as unknown as Workflow;
  const run = async (params: Record<string, unknown>, startedBy?: string, mode: 'chat' | 'manual' = 'chat', legit = true) => {
    // As the Access page's chat starts it: the installed chat flow's id, and the run marked as its own.
    saveAccessSettings({ ...accessSettings(), chatWorkflowId: 'wf_chat_tool' });
    const workflow = flow(params);
    const executionId = `ex_tool_${Math.random().toString(36).slice(2, 8)}`;
    const item = await chatItem({ chatInput: 'hi', sessionId: 's1', files: [] }, executionId);
    if (legit) markChatRun(executionId);
    const record = await runWorkflow({ workflow, mode, startNodeId: 'chat', triggerItems: [item], executionId, ...(startedBy && { startedBy }) });
    return record.runData.file.at(-1)!.outputs[0]![0]!.json as Record<string, unknown>;
  };

  it('uses the person who sent the chat message, never a parameter', async () => {
    expect(await run(base, mia.id)).toMatchObject({ status: 'confirm' });
    expect(await run({ ...base, requesterId: ola.id }, mia.id)).toMatchObject({ status: 'confirm' });
  });
  it('refuses a hosted chat nobody signed in for, and a run that is not a chat', async () => {
    expect(await run(base, undefined)).toMatchObject({ status: 'refused', message: expect.stringMatching(/Sign in on the Access page/) });
    expect(await run(base, mia.id, 'manual')).toMatchObject({ status: 'refused' });
  });
  it('refuses a chat run the Access page’s chat did not start, and one of another flow', async () => {
    expect(await run(base, mia.id, 'chat', false)).toMatchObject({ status: 'refused', message: expect.stringMatching(/Sign in on the Access page/) });
    saveAccessSettings({ ...accessSettings(), chatWorkflowId: 'wf_some_other_chat' });
    const workflow = flow(base);
    const executionId = 'ex_other_flow';
    markChatRun(executionId);
    const item = await chatItem({ chatInput: 'hi', sessionId: 's1', files: [] }, executionId);
    const record = await runWorkflow({ workflow, mode: 'chat', startNodeId: 'chat', triggerItems: [item], executionId, startedBy: mia.id });
    expect(record.runData.file.at(-1)!.outputs[0]![0]!.json).toMatchObject({ status: 'refused' });
  });
  it('spends the confirmation token on use', async () => {
    const { confirmToken } = await fileAccessFromChat({ userId: mia.id, executionId: 'ex_s1', ...base });
    const filed = await fileAccessFromChat({ userId: mia.id, executionId: 'ex_s2', ...base, confirmToken });
    expect(filed.status).toBe('filed');
    await cancelRequest(mia, filed.requestId!);
    const again = await fileAccessFromChat({ userId: mia.id, executionId: 'ex_s3', ...base, confirmToken });
    expect(again).toMatchObject({ status: 'refused', message: expect.stringMatching(/already used/) });
  });
});

describe('the chat flow with a model', () => {
  it('reads it back, then files it after the person says yes in the next message', async () => {
    const credential = credentials.create({ name: 'Fake Anthropic', type: 'core.anthropicApi', data: { apiKey: 'sk-ant-test', baseUrl: models.origin } });
    setHomeProject('credential', credential.id, accessSettings().projectId!);
    // Install the chat flow again with the model credential (the settings forget it, as a fresh instance).
    saveAccessSettings({ workflowId: accessSettings().workflowId, projectId: accessSettings().projectId });
    await installAccessRequests(w.owner, { modelCredentialId: credential.id });
    expect(accessSettings().chatWorkflowId).toEqual(expect.any(String));
    const before = filed();

    const first = await runAccessChat(mia, { message: 'I need the platform team for an hour, my GitHub is mia-gh', sessionId: 'tab1' });
    expect(first.reply).toContain('Shall I file this');
    expect(first.requestId).toBeUndefined();
    expect(filed()).toBe(before);
    expect(script.token).toEqual(expect.any(String));

    const second = await runAccessChat(mia, { message: 'yes', sessionId: 'tab1' });
    expect(filed()).toBe(before + 1);
    expect(second.requestId).toEqual(expect.any(String));
    expect(w.requestRow(second.requestId!)).toMatchObject({ channel: 'chat', requester_id: mia.id, status: 'pending' });
    await cancelRequest(mia, second.requestId!);
    void store;
  });

  it('is a 409 until the chat flow is set up', async () => {
    saveAccessSettings({ workflowId: accessSettings().workflowId, projectId: accessSettings().projectId });
    await expect(runAccessChat(mia, { message: 'hi', sessionId: 'tab2' })).rejects.toMatchObject({ status: 409 });
  });
});
