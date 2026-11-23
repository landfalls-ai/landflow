/**
 * Ask a Person's two options (docs/features/engine.md#ask-a-person, C35): Answer Choices (the approver picks one, the output
 * carries it) and People Only (an API key or an MCP caller can't answer, only a signed-in person or a signed email link). Both off by
 * default: a flow without them is unchanged.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { Workflow } from '@landflow/engine';
import { readSse } from './fake-ai-services';

vi.setConfig({ testTimeout: 30_000 });

const ENV = { LANDFLOW_DATA_DIR: mkdtempSync(join(tmpdir(), 'landflow-confirm-choices-')), LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);
afterAll(() => {
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { store } = await import('@/lib/server/store');
const { runWorkflow } = await import('@/lib/server/runner');
const { createUser } = await import('@/lib/server/auth/users');
const { enableTestAuth } = await import('@/lib/server/auth/test-bypass');
const { singleton } = await import('@/lib/server/singleton');
const { signLink } = await import('@/lib/server/approval-email');
const { useLink } = await import('@/lib/server/approval-email');
const { setMailTransport } = await import('@/lib/server/auth/mail');
const approvalsRoute = await import('@/app/api/executions/[id]/approvals/route');
const { needsYou } = await import('@/lib/server/journal/needs-you');

registry.registerBuiltin(corePlugin);
setMailTransport({ async send() {} });

const ada = await createUser({ email: 'ada@landflow.test', name: 'Ada Approver', role: 'member' });
const bob = await createUser({ email: 'bob@landflow.test', name: 'Bob Bystander', role: 'member' });
const as = (user: Parameters<typeof enableTestAuth>[0]) => enableTestAuth(user);
const asApiKey = async <T>(via: 'api-key' | 'mcp', fn: () => Promise<T>): Promise<T> => {
  const state = singleton('auth-test-bypass', () => ({}) as { principal?: unknown });
  state.principal = { user: ada, via, ...(via === 'api-key' && { apiKey: { id: 'key1', scopes: ['admin'] } }) };
  try {
    return await fn();
  } finally {
    enableTestAuth();
  }
};

let count = 0;
async function ask(parameters: Record<string, unknown> = {}) {
  const id = `wf_choices_${++count}`;
  const saved = {
    id,
    name: `Choices ${count}`,
    nodes: [
      { id: 'Start', name: 'Start', type: 'core.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
      { id: 'Ask', name: 'Ask', type: 'core.confirmDraft', typeVersion: 1, position: [200, 0], parameters: { title: 'Give Mia the team?', draft: 'Mia asks for 1 h', allowEdit: false, ...parameters } },
    ],
    connections: [{ id: 'e1', type: 'main', source: 'Start', target: 'Ask', sourceIndex: 0, targetIndex: 0 }],
  } as unknown as Workflow;
  store.saveWorkflow(saved);
  const record = await runWorkflow({ workflow: saved, mode: 'manual', startNodeId: 'Start' });
  expect(record.status).toBe('waiting');
  return record.executionId;
}
const answer = async (executionId: string, body: Record<string, unknown>) => {
  const response = await approvalsRoute.POST(new Request('http://landflow.test/api/executions/x/approvals', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ callId: 'confirm', ...body }) }), { params: Promise.resolve({ id: executionId }) });
  if (response.headers.get('content-type')?.includes('event-stream')) await readSse(response);
  return response;
};
const output = (executionId: string) => {
  const outputs = store.getExecution(executionId)!.runData.Ask.at(-1)!.outputs;
  return { json: (outputs[0]?.[0] ?? outputs[1]?.[0])!.json as Record<string, unknown>, branch: outputs[0]?.length ? 'approved' : 'rejected' };
};
const CHOICES = '60: 1 h\n15: 15 min';

describe('without the options', () => {
  it('is as before: no choice in the output, and a choice sent is refused', async () => {
    const id = await ask();
    as(ada);
    expect((await answer(id, { approved: true, choice: '60' })).status).toBe(400);
    expect((await answer(id, { approved: true })).status).toBe(200);
    expect(output(id).json).not.toHaveProperty('choice');
    expect(output(id).branch).toBe('approved');
  });
});

describe('Answer Choices', () => {
  it('carries the approver’s pick to the output', async () => {
    const id = await ask({ choices: CHOICES });
    as(ada);
    await answer(id, { approved: true, choice: '15' });
    expect(output(id)).toMatchObject({ branch: 'approved', json: { approved: true, choice: '15', by: 'ada@landflow.test' } });
  });

  it('approves with the first choice when none is picked', async () => {
    const id = await ask({ choices: CHOICES });
    as(ada);
    await answer(id, { approved: true });
    expect(output(id).json).toMatchObject({ choice: '60' });
  });

  it('refuses a choice that is not in the list, and a choice with a rejection, and leaves the run waiting', async () => {
    const id = await ask({ choices: CHOICES });
    as(ada);
    const stranger = await answer(id, { approved: true, choice: '1440' });
    expect(stranger.status).toBe(400);
    expect(((await stranger.json()) as { error: string }).error).toMatch(/not one of the choices/);
    expect((await answer(id, { approved: false, choice: '15' })).status).toBe(400);
    expect(store.getExecution(id)!.status).toBe('waiting');
    await answer(id, { approved: false, comment: 'No' });
    expect(output(id)).toMatchObject({ branch: 'rejected', json: { approved: false, comment: 'No' } });
    expect(output(id).json).not.toHaveProperty('choice');
  });

  it('shows the choices in the pending approval for the card to render', async () => {
    const id = await ask({ choices: '60: 1 h\n15\n\n' });
    const approval = store.getExecution(id)!.wait!.data!.approval as { confirm: { choices: unknown } };
    expect(approval.confirm.choices).toEqual([{ value: '60', label: '1 h' }, { value: '15', label: '15' }]);
  });
});

describe('People Only', () => {
  it('refuses an API key and an MCP caller, even a listed approver’s, and keeps waiting', async () => {
    const id = await ask({ approvers: 'ada@landflow.test', peopleOnly: true });
    for (const via of ['api-key', 'mcp'] as const) {
      const refused = await asApiKey(via, () => answer(id, { approved: true }));
      expect(refused.status).toBe(403);
      expect(((await refused.json()) as { error: string }).error).toBe('A person answers this request');
      expect(store.getExecution(id)!.status).toBe('waiting');
    }
    const { decideApproval } = await import('@/lib/server/approvals');
    for (const principal of ['api-key', 'mcp'] as const) {
      await expect(decideApproval(id, 'confirm', true, { by: 'ada@landflow.test', principal })).rejects.toThrow('A person answers this request');
    }
    await expect(decideApproval(id, 'confirm', true)).rejects.toThrow('A person answers this request');
    expect(store.getExecution(id)!.status).toBe('waiting');
  });

  it('lets a signed-in listed approver answer and keeps out another signed-in person', async () => {
    const id = await ask({ approvers: 'ada@landflow.test', peopleOnly: true, choices: CHOICES });
    as(bob);
    const { decideApproval } = await import('@/lib/server/approvals');
    await expect(decideApproval(id, 'confirm', true, { by: 'bob@landflow.test', principal: 'session' })).rejects.toThrow(/not one of the people who may answer/);
    as(ada);
    await answer(id, { approved: true, choice: '15' });
    expect(output(id).json).toMatchObject({ approved: true, choice: '15', by: 'ada@landflow.test' });
  });

  it('lets a signed email link sent to a listed address decide, with the first choice', async () => {
    const id = await ask({ approvers: 'ada@landflow.test', peopleOnly: true, choices: CHOICES });
    const token = signLink({ g: `g-${id}`, t: { t: 'wf', e: id, c: 'confirm' }, d: 'approve', m: 'ada@landflow.test', x: Date.now() + 3_600_000 });
    await useLink(token);
    expect(output(id).json).toMatchObject({ approved: true, choice: '60', by: 'email:ada@landflow.test' });
  });

  it('refuses a link to an address that is not listed', async () => {
    const id = await ask({ approvers: 'ada@landflow.test', peopleOnly: true });
    const token = signLink({ g: `g-other-${id}`, t: { t: 'wf', e: id, c: 'confirm' }, d: 'approve', m: 'stranger@landflow.test', x: Date.now() + 3_600_000 });
    await expect(useLink(token)).rejects.toThrow(/not one of the people who may answer/);
    expect(store.getExecution(id)!.status).toBe('waiting');
  });

  it('does not count a Slack answer unless that Slack id is listed', async () => {
    const id = await ask({ approvers: 'ada@landflow.test, U0123ABCD', peopleOnly: true });
    const { decideApproval } = await import('@/lib/server/approvals');
    await expect(decideApproval(id, 'confirm', true, { slackUser: 'U9999' })).rejects.toThrow(/not one of the people who may answer/);
    await decideApproval(id, 'confirm', true, { slackUser: 'U0123ABCD' });
    expect(output(id).json).toMatchObject({ approved: true, by: 'slack:U0123ABCD' });
  });

  it('is off by default: an API key answers an ordinary Ask a Person as before', async () => {
    const id = await ask();
    const done = await asApiKey('api-key', () => answer(id, { approved: true }));
    expect(done.status).toBe(200);
    expect(output(id).json).toMatchObject({ approved: true });
  });
});

describe('Needs you', () => {
  it('still reads “Waiting for …” for a request with options', async () => {
    const id = await ask({ approvers: 'ada@landflow.test', peopleOnly: true, choices: CHOICES });
    const item = (await needsYou(undefined)).find((i) => i.executionId === id);
    expect(item).toMatchObject({ kind: 'approval', title: 'Waiting for ada@landflow.test: Give Mia the team?' });
  });
});
