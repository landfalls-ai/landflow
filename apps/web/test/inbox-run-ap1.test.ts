/**
 * AP02 (wave ap1): a run nobody watches pauses at an asks-first tool and waits in the approval inbox (nodes/agents.ts).
 * Run an Agent in a webhook (or any trigger) run with Tool Approvals Ask opens one inbox request per held call (masked
 * effective parameters, destination, workflow and agent versions, the trigger word), waits with the expiry as its `until`, and on
 * every resume reads the record: approved runs once; denied, expired or cancelled is refused and the run goes on. A fake port
 * stands in for AP01's (the integrator's joins use the real one). A scripted model, a fake SMTP behind the real messaging plugin.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { toToolName, type ExecutionMode, type Workflow, type WorkflowNode } from '@landflow/engine';
import { startFakeModels, type FakeReply } from './fake-ai-services';
import { startFakeSmtp } from '../../../plugins/messaging/test/fake-smtp';

vi.setConfig({ testTimeout: 30_000 });

const SMTP_PASSWORD = 'pw-ap1-run-smtp-made-up';
const smtp = await startFakeSmtp({ auth: { user: 'mail', password: SMTP_PASSWORD }, authMethods: ['PLAIN'] });
const dataDir = mkdtempSync(join(tmpdir(), 'landflow-inbox-run-'));
const ENV = {
  LANDFLOW_DATA_DIR: dataDir,
  LANDFLOW_REGISTRY_GRPC_PORT: 'off',
  LANDFLOW_SCAN_ON_START: 'false',
  LANDFLOW_PLUGINS: '',
  LANDFLOW_SMTP_HOST: '127.0.0.1',
  LANDFLOW_SMTP_PORT: String(smtp.port),
  LANDFLOW_SMTP_USER: 'mail',
  LANDFLOW_SMTP_PASS: SMTP_PASSWORD,
  LANDFLOW_SMTP_IGNORE_TLS: 'true',
};
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { plugin: messaging } = await import('../../../plugins/messaging/src/main');
const { store } = await import('@/lib/server/store');
const { runWorkflow, resumeExecution } = await import('@/lib/server/runner');
const { agentStore } = await import('@/lib/server/agents/store');
const { decideApproval } = await import('@/lib/server/approvals');
const { credentials } = await import('@/lib/server/credentials/vault');
const { registerInboxPort } = await import('@/lib/server/approval-inbox/port');
const { settledLine, MASK } = await import('@/lib/shared/approval-inbox');
import type { InboxOpen, InboxStatus } from '@/lib/shared/approval-inbox';
import type { InboxOutcome, InboxPort } from '@/lib/server/approval-inbox/port';

registry.registerBuiltin(corePlugin);
registry.registerBuiltin(messaging);

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
  await smtp.close();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

// ---------------------------------------------------------------------------
// A fake inbox port: records `open`, answers `outcome` and `settle`
// ---------------------------------------------------------------------------

const EXPIRES = new Date(Date.now() + 24 * 3_600_000).toISOString();
const inbox = {
  opens: [] as InboxOpen[][],
  fresh: [] as string[],
  rows: new Map<string, InboxOutcome>(),
  ids: new Map<string, string>(),
  settled: [] as Array<[string, string]>,
};
const key = (executionId: string, callId: string) => `${executionId}|${callId}`;
const fakePort: InboxPort = {
  async open(calls) {
    inbox.opens.push(calls);
    const ids: Record<string, string> = {};
    for (const call of calls) {
      const k = key(call.executionId, call.callId);
      if (!inbox.ids.has(k)) {
        inbox.ids.set(k, `ib_${inbox.ids.size + 1}`);
        inbox.rows.set(k, { status: 'waiting' });
        inbox.fresh.push(k);
      }
      ids[call.callId] = inbox.ids.get(k)!;
    }
    return { ids, expiresAt: EXPIRES, minutes: 1440 };
  },
  outcome: (executionId, callId) => inbox.rows.get(key(executionId, callId)),
  async settle(executionId, callId, to) {
    const k = key(executionId, callId);
    inbox.settled.push([k, to]);
    const current = inbox.rows.get(k);
    if (current && current.status !== 'waiting') return { won: false, outcome: current };
    const outcome: InboxOutcome = { status: to, via: to === 'expired' ? 'expiry' : 'cancel', at: new Date().toISOString() };
    inbox.rows.set(k, outcome);
    return { won: true, outcome };
  },
  view: () => undefined,
};
/** AP01's claim, as the fake sees it: the record says what the door decided before the resume starts. */
const claim = (executionId: string, callId: string, status: InboxStatus, by = 'usr_owner') => inbox.rows.set(key(executionId, callId), { status, by, byName: 'Owner', via: 'inbox', at: new Date().toISOString() });

beforeEach(() => {
  registerInboxPort(fakePort);
  inbox.opens.length = 0;
  inbox.fresh.length = 0;
  inbox.rows.clear();
  inbox.ids.clear();
  inbox.settled.length = 0;
  smtp.mails.length = 0;
  turn = 0;
  toolResults.length = 0;
});

// ---------------------------------------------------------------------------
// The agent and the flows
// ---------------------------------------------------------------------------

const smtpCredential = credentials.create({ name: 'Mailpit SMTP', type: 'messaging.smtp', data: { host: '127.0.0.1', port: smtp.port, secure: false, disableStartTls: true, user: 'mail', password: SMTP_PASSWORD } }).id;
const SEND = 'Send Email';
const WRITE = toToolName(SEND);
const mailer = agentStore.create({
  name: 'Alert mailer',
  instructions: 'You email on-call.',
  model: { provider: 'ollama', model: 'mailer-model', baseUrl: fake.url.replace(/\/v1$/, '') },
  tools: [{ id: 'tl_mail', type: 'node', name: SEND, description: 'Email on-call', nodeType: 'messaging.emailSend', parameters: { fromEmail: 'landflow@landflow.test', toEmail: 'oncall@landflow.test', subject: 'Alert', emailFormat: 'text', text: 'Disk is full', apiKey: 'sk-fixed-looking-secret' }, credentials: { smtp: { id: smtpCredential, name: 'Mailpit SMTP' } }, requireApproval: true }],
} as never);
agentStore.publish(mailer.id);

const node = (id: string, type: string, parameters: Record<string, unknown> = {}): WorkflowNode => ({ id, name: id, type, typeVersion: 1, position: [0, 0], parameters });
let n = 0;
/** `parameters` are the step's own; pass `undefined` for toolApprovals to leave it out (a step saved before this wave). */
function flow(parameters: Record<string, unknown>, trigger = 'core.webhook'): Workflow {
  const wf: Workflow = {
    id: `wf_ap1_run_${++n}`,
    name: 'Alert flow',
    nodes: [node('Start', trigger, trigger === 'core.webhook' ? { path: `ap1-run-${n}` } : {}), node('Agent', 'core.messageAgent', { agentId: mailer.id, message: 'Email on-call', ...parameters })],
    connections: [{ id: 'a', type: 'main', source: 'Start', target: 'Agent', sourceIndex: 0, targetIndex: 0 }],
  };
  store.saveWorkflow(wf);
  return wf;
}
const run = (wf: Workflow, mode: ExecutionMode = 'webhook') => ((turn = 0), runWorkflow({ workflow: wf, mode, startNodeId: 'Start', triggerItems: [{ json: { text: 'disk full' } }] }));
const callThenReply = (): typeof script => (t) => (t === 1 ? { toolCalls: [{ id: 'c_mail', name: WRITE, arguments: {} }] } : { text: 'Handled.' });
type Record_ = Awaited<ReturnType<typeof run>>;
const out = (record: Record_) => record.runData.Agent?.at(-1)?.outputs?.[0]?.[0]?.json as { reply: string; steps: Array<{ tool: string; status: string; approvedBy?: string; error?: string }>; sessionId: string };
const waitData = (record: Record_) => record.wait?.data as { approval: { calls: Array<{ id: string; tool: string; input: Record<string, unknown> }>; channel: string }; inbox: { ids: Record<string, string>; expiresAt: string }; agentApproval: { agent: string } };
const callOf = (record: Record_) => waitData(record).approval.calls[0]!.id;
const sessionOf = (record: Record_) => agentStore.listSessions(mailer.id, 20).find((s) => s.id && agentStore.getSession(s.id)?.execution?.executionId === record.executionId);

describe('Run an Agent in a run nobody watches (the approval inbox)', () => {
  it('waits: one request per held call with the masked effective parameters, the destination, the versions and the trigger word', async () => {
    script = callThenReply();
    const record = await run(flow({ toolApprovals: 'askInChat' }));
    expect(record.status).toBe('waiting');
    expect(record.wait?.until).toBe(EXPIRES);
    expect(turn).toBe(1);
    expect(smtp.mails).toHaveLength(0);
    const data = waitData(record);
    expect(data.agentApproval).toEqual({ agent: 'Alert mailer' });
    expect(data.approval.channel).toBe('chat');
    expect(data.inbox).toEqual({ ids: { [callOf(record)]: 'ib_1' }, expiresAt: EXPIRES });
    // The wait shows the masked parameters the call would run with, never the secret-looking one.
    expect(data.approval.calls).toEqual([{ id: callOf(record), tool: SEND, input: expect.objectContaining({ toEmail: 'oncall@landflow.test', apiKey: MASK }) }]);
    expect(JSON.stringify(record.wait)).not.toContain('sk-fixed-looking-secret');
    // One open, for the one call.
    expect(inbox.opens).toHaveLength(1);
    const [opened] = inbox.opens[0]!;
    expect(opened).toMatchObject({
      executionId: record.executionId,
      callId: callOf(record),
      workflowId: record.workflowId,
      workflowName: 'Alert flow',
      nodeId: 'Agent',
      nodeName: 'Agent',
      agentId: mailer.id,
      agentName: 'Alert mailer',
      agentVersion: 1,
      tool: SEND,
      trigger: 'webhook',
      params: expect.objectContaining({ toEmail: 'oncall@landflow.test', subject: 'Alert', apiKey: MASK }),
    });
    expect(opened!.destination).toContain('oncall@landflow.test');
    expect(opened!.sessionId).toBe(sessionOf(record)!.id);
    expect(JSON.stringify(opened)).not.toContain('sk-fixed-looking-secret');
    expect(JSON.stringify(opened)).not.toContain(SMTP_PASSWORD);
  });

  it('Approve through decideApproval runs the tool once; the tool entry says the settled line', async () => {
    script = callThenReply();
    const record = await run(flow({ toolApprovals: 'askInChat' }));
    claim(record.executionId, callOf(record), 'approved');
    const outcome = await decideApproval(record.executionId, callOf(record), true, { by: 'usr_owner' });
    expect(outcome.status).toBe('resumed');
    const done = (outcome as { record: Record_ }).record;
    expect(done.error?.message ?? done.status).toBe('success');
    expect(smtp.mails).toHaveLength(1);
    expect(smtp.mails[0]!.to).toEqual(['oncall@landflow.test']);
    expect(out(done).reply).toBe('Handled.');
    expect(out(done).steps).toEqual([expect.objectContaining({ tool: WRITE, status: 'success' })]);
    const line = settledLine({ status: 'approved', tool: SEND, decidedByName: 'Owner', decidedVia: 'inbox', decidedAt: inbox.rows.get(key(record.executionId, callOf(record)))!.at }, (iso) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }));
    expect(out(done).steps[0]!.approvedBy).toBe(line);
    const entry = agentStore.getSession(out(done).sessionId)!.timeline.find((e) => e.type === 'tool');
    expect(entry).toMatchObject({ status: 'success', decidedLine: line });
    // No agent-level approval mail for a workflow's session, and no secret anywhere.
    expect(smtp.mails.every((m) => !m.data.includes('Approve'))).toBe(true);
    const everything = JSON.stringify([done, agentStore.getSession(out(done).sessionId), inbox.opens]);
    expect(everything).not.toContain(SMTP_PASSWORD);
    expect(everything).not.toContain('sk-fixed-looking-secret');
  });

  it('an edited input on an inbox wait is not carried: the call runs as reviewed, never with the mask or the edit', async () => {
    script = callThenReply();
    const record = await run(flow({ toolApprovals: 'askInChat' }));
    claim(record.executionId, callOf(record), 'approved');
    const outcome = await decideApproval(record.executionId, callOf(record), true, { by: 'usr_owner', input: { toEmail: 'attacker@evil.test', apiKey: MASK, subject: 'changed' } });
    expect(outcome.status).toBe('resumed');
    expect(smtp.mails).toHaveLength(1);
    for (const mail of smtp.mails) {
      expect(mail.to).toEqual(['oncall@landflow.test']);
      expect(mail.data).not.toContain(MASK);
      expect(mail.data).not.toContain('changed');
      expect(mail.data).not.toContain('attacker@evil.test');
    }
  });

  it('a call held in the inbox is refused by decide() without the inbox flag (route, mail link and Teams click)', async () => {
    script = callThenReply();
    const record = await run(flow({ toolApprovals: 'askInChat' }));
    const session = sessionOf(record)!;
    const { decide } = await import('@/lib/server/agents/runtime');
    const agent = agentStore.get(session.agentId)!;
    await expect(decide(agent, session.id, callOf(record), true, {})).rejects.toMatchObject({ status: 409 });
    expect(smtp.mails).toHaveLength(0);
    expect(agentStore.getSession(session.id)!.pending!.calls[0]!.decision).toBeUndefined();
  });

  it('Deny: the agent hears the refusal, no mail is sent, the step succeeds', async () => {
    script = callThenReply();
    const record = await run(flow({ toolApprovals: 'askInChat' }));
    claim(record.executionId, callOf(record), 'denied');
    const outcome = await decideApproval(record.executionId, callOf(record), false, { by: 'usr_owner' });
    const done = (outcome as { record: Record_ }).record;
    expect(done.status).toBe('success');
    expect(smtp.mails).toHaveLength(0);
    expect(toolResults.join('\n')).toContain('denied “Send Email” in the approval inbox, so it did not run');
    expect(out(done).steps).toEqual([expect.objectContaining({ tool: WRITE, status: 'denied' })]);
    expect(out(done).steps[0]!.approvedBy).toMatch(/^Denied by Owner in Needs you/);
  });

  it('a timeout resume with the record still waiting settles it expired: refused, no mail, the run goes on', async () => {
    script = callThenReply();
    const record = await run(flow({ toolApprovals: 'askInChat' }));
    const done = await resumeExecution(record.executionId, { kind: 'timeout' });
    expect(done.status).toBe('success');
    expect(inbox.settled).toEqual([[key(record.executionId, callOf(record)), 'expired']]);
    expect(smtp.mails).toHaveLength(0);
    expect(toolResults.join('\n')).toContain('Nobody approved “Send Email” within 24 h, so it did not run');
    expect(out(done as never).steps[0]).toMatchObject({ status: 'denied' });
    expect(out(done as never).steps[0]!.approvedBy).toMatch(/^Expired/);
  });

  it('a timeout resume when the record already says approved (a claim raced the timer) runs the call once', async () => {
    script = callThenReply();
    const record = await run(flow({ toolApprovals: 'askInChat' }));
    claim(record.executionId, callOf(record), 'approved');
    const done = await resumeExecution(record.executionId, { kind: 'timeout' });
    expect(done.status).toBe('success');
    expect(inbox.settled).toEqual([]);
    expect(smtp.mails).toHaveLength(1);
  });

  it('a cancelled record is refused, and an approval the record does not say fails closed (nothing is sent)', async () => {
    script = callThenReply();
    const first = await run(flow({ toolApprovals: 'askInChat' }));
    claim(first.executionId, callOf(first), 'cancelled');
    const done = await resumeExecution(first.executionId, { kind: 'timeout' });
    expect(done.status).toBe('success');
    expect(toolResults.join('\n')).toContain('The run was cancelled while “Send Email” waited for approval');
    const second = await run(flow({ toolApprovals: 'askInChat' }));
    // The door recorded an approval on the wait, but the record (AP01's claim) never moved: the node does not run the call.
    const outcome = await decideApproval(second.executionId, callOf(second), true, { by: 'usr_owner' }).catch((error: Error) => error);
    const final = outcome instanceof Error ? undefined : (outcome as { record: Record_ }).record;
    expect(final?.status).not.toBe('success');
    expect(smtp.mails).toHaveLength(0);
  });

  it('the request ids and call ids the node opens are the wait’s own, so a node that runs again gets the same requests', async () => {
    script = callThenReply();
    const record = await run(flow({ toolApprovals: 'askInChat' }));
    const [opened] = inbox.opens[0]!;
    expect(opened!.callId).toBe(waitData(record).approval.calls[0]!.id);
    // The same call opened again (a re-run after a crash) is the same request and nobody is nudged twice.
    const again = await fakePort.open([opened!]);
    expect(again.ids).toEqual(waitData(record).inbox.ids);
    expect(inbox.fresh).toEqual([key(record.executionId, callOf(record))]);
  });

  it.each([
    ['Tool Approvals Refuse', { toolApprovals: 'refuse' }, 'webhook'],
    ['a step saved without Tool Approvals', {}, 'webhook'],
    ['an MCP call', { toolApprovals: 'askInChat' }, 'mcp'],
    ['a workflow an agent calls as a tool', { toolApprovals: 'askInChat' }, 'tool'],
  ] as const)('refuses as before and opens nothing: %s', async (_name, parameters, mode) => {
    script = callThenReply();
    const record = await run(flow({ ...parameters }), mode);
    expect(record.status).toBe('success');
    expect(toolResults[0]).toContain("needs a person's approval");
    expect(inbox.opens).toHaveLength(0);
    expect(smtp.mails).toHaveLength(0);
  });

  it('a call held twice in a row keeps the inbox on the resumed turn: masked review, no agent-session mail, on both holds', async () => {
    const twice = agentStore.create({
      name: 'Twice mailer',
      instructions: 'You email on-call.',
      model: { provider: 'ollama', model: 'mailer-model', baseUrl: fake.url.replace(/\/v1$/, '') },
      settings: { approvalEmails: ['ana@landflow.test'] },
      tools: [{ id: 'tl_mail2', type: 'node', name: SEND, description: 'Email on-call', nodeType: 'messaging.emailSend', parameters: { fromEmail: 'landflow@landflow.test', toEmail: 'oncall@landflow.test', subject: 'Alert', emailFormat: 'text', text: 'Disk is full', apiKey: 'sk-fixed-looking-secret' }, credentials: { smtp: { id: smtpCredential, name: 'Mailpit SMTP' } }, requireApproval: true }],
    } as never);
    agentStore.publish(twice.id);
    script = (t) => (t === 1 ? { toolCalls: [{ id: 'c_one', name: WRITE, arguments: {} }] } : t === 2 ? { toolCalls: [{ id: 'c_two', name: WRITE, arguments: {} }] } : { text: 'Done.' });
    const wf = flow({ toolApprovals: 'askInChat', agentId: twice.id });
    const first = await run(wf);
    expect(first.status).toBe('waiting');
    claim(first.executionId, callOf(first), 'approved');
    const outcome = await decideApproval(first.executionId, callOf(first), true, { by: 'usr_owner' });
    expect(outcome.status).toBe('resumed');
    const second = (outcome as { record: Record_ }).record;
    expect(second.status).toBe('waiting');
    expect(inbox.opens).toHaveLength(2);
    const [opened] = inbox.opens[1]!;
    expect(opened).toMatchObject({ callId: callOf(second), params: expect.objectContaining({ toEmail: 'oncall@landflow.test', apiKey: MASK }) });
    expect(opened!.destination).toContain('oncall@landflow.test');
    expect(waitData(second).approval.calls).toEqual([{ id: callOf(second), tool: SEND, input: expect.objectContaining({ toEmail: 'oncall@landflow.test', apiKey: MASK }) }]);
    expect(JSON.stringify([second.wait, inbox.opens])).not.toContain('sk-fixed-looking-secret');
    // Only the one approved call mailed on-call, and no approval mail went to the agent's approvers on either hold.
    expect(smtp.mails.filter((m) => m.to.includes('ana@landflow.test'))).toHaveLength(0);
  });

  it('a model wired to the step is refused at run time and opens nothing', async () => {
    script = callThenReply();
    const wf = flow({ toolApprovals: 'askInChat' });
    wf.nodes.push(node('Model', 'core.ollamaChatModel', { baseUrl: fake.url.replace(/\/v1$/, ''), model: 'mailer-model', temperature: 0 }));
    wf.connections.push({ id: 'w', type: 'ai_languageModel', source: 'Model', target: 'Agent', sourceIndex: 0, targetIndex: 0 });
    store.saveWorkflow(wf);
    const record = await run(wf);
    expect(record.status).toBe('success');
    expect(inbox.opens).toHaveLength(0);
    expect(smtp.mails).toHaveLength(0);
  });

  it('refuses as before when the host has no inbox, and the other triggers wait', async () => {
    script = callThenReply();
    registerInboxPort(undefined as never);
    const refused = await run(flow({ toolApprovals: 'askInChat' }));
    expect(refused.status).toBe('success');
    expect(toolResults[0]).toContain("needs a person's approval");
    registerInboxPort(fakePort);
    for (const [trigger, mode] of [['core.schedule', 'trigger'], ['core.formTrigger', 'webhook']] as const) {
      const record = await run(flow({ toolApprovals: 'askInChat' }, trigger), mode);
      expect(record.status, trigger).toBe('waiting');
    }
    expect(inbox.opens.map(([o]) => o!.trigger)).toEqual(['schedule', 'form']);
  });
});
