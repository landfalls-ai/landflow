/**
 * Cap-raise requests (docs/llm-gateway.md#asking-for-a-higher-cap): the Cap Raise Request trigger, the cap-raise template
 * with Ask a Person, and Apply Cap Raise. The engine runs in process; the budgets sync (LL04) is stood in for by a
 * caps listener that writes the link row.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { Workflow, WorkflowNode } from '@landflow/engine';
import type { CapRaiseRequest, CapRaiseSetup } from '@/lib/shared/llm-gateway';
import { readSse } from './fake-ai-services';

vi.setConfig({ testTimeout: 30_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-cap-raise-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { store } = await import('@/lib/server/store');
const { database } = await import('@/lib/server/db');
const { runWorkflow, resumeExecution } = await import('@/lib/server/runner');
const { createUser } = await import('@/lib/server/auth/users');
const { enableTestAuth, TEST_OWNER } = await import('@/lib/server/auth/test-bypass');
const { aiCaps, saveAiCaps: saveCaps } = await import('@/lib/server/ai-usage/caps');
const { aiUsageMeter } = await import('@/lib/server/ai-usage');
const saveAiCaps = (value: unknown) => {
  saveCaps(value);
  aiUsageMeter().invalidateCaps();
};
const { agentStore } = await import('@/lib/server/agents/store');
const { onCapsChanged } = await import('@/lib/server/llm-gateway/events');
const { applyCapRequest, createCapRequest } = await import('@/lib/server/llm-gateway/cap-requests');
const { resetCapRaiseTrigger } = await import('@/lib/server/llm-gateway/cap-raise-trigger');
const { BUILTIN_TEMPLATES } = await import('@/lib/server/templates');
const { validateWorkflow } = await import('@/lib/server/mcp/workflows');
const requestsRoute = await import('@/app/api/ai/cap-requests/route');
const setupRoute = await import('@/app/api/ai/cap-requests/setup/route');
const cancelRoute = await import('@/app/api/ai/cap-requests/[id]/cancel/route');
const approvalsRoute = await import('@/app/api/executions/[id]/approvals/route');

registry.registerBuiltin(corePlugin);

const caps: Array<{ trigger: string; capIds?: string[] }> = [];
const stopListening = onCapsChanged((trigger, capIds) => {
  caps.push({ trigger, ...(capIds && { capIds }) });
});
afterAll(() => {
  stopListening();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const admin = await createUser({ email: 'admin@landflow.test', name: 'Ada Admin', role: 'admin' });
const second = await createUser({ email: 'second@landflow.test', name: 'Sam Second', role: 'admin' });
const member = await createUser({ email: 'mia@landflow.test', name: 'Mia Member', role: 'member' });
const other = await createUser({ email: 'ola@landflow.test', name: 'Ola Other', role: 'member' });
const as = (user: { id: string; email: string; name: string; role: 'owner' | 'admin' | 'member'; createdAt: string; updatedAt: string }) => enableTestAuth(user);

const url = 'http://landflow.test/api/ai/cap-requests';
const post = (path: string, body?: unknown) => new Request(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, ...(body !== undefined && { body: JSON.stringify(body) }) });
const ask = async (capId: string, requested: number, reason = 'A longer report to finish') => {
  const response = await requestsRoute.POST(post('', { capId, requested, reason }));
  return { response, body: (await response.json()) as CapRaiseRequest & { error?: string; existingId?: string } };
};
const list = async (query = '') => (await (await requestsRoute.GET(new Request(`${url}${query}`))).json()) as { items: CapRaiseRequest[]; nextCursor?: string; setup: CapRaiseSetup };
const answer = async (executionId: string, body: Record<string, unknown>) => {
  const response = await approvalsRoute.POST(new Request(`http://landflow.test/api/executions/${executionId}/approvals`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ callId: 'confirm', ...body }) }), { params: Promise.resolve({ id: executionId }) });
  if (response.headers.get('content-type')?.includes('event-stream')) await readSse(response);
  return response;
};
const stored = (id: string) => database().get<{ status: string; decided_by: string | null; note: string | null; gateway: string | null; execution_id: string | null }>('SELECT * FROM ai_cap_requests WHERE id = ?', id)!;
const userCap = (id: string) => aiCaps().users[id];
const link = (userId: string, state: string) => database().upsert('llm_gateway_links', { kind: 'customer', landflow_id: userId, litellm_id: `landflow-user-${userId}`, state, budget: null, error: null, synced_at: '2000-01-01T00:00:00.000Z' });

saveAiCaps({ credentials: {}, users: { [member.id]: { name: 'Mia', dayCost: 5 }, [other.id]: { name: 'Ola', dayCost: 3 }, [second.id]: { name: 'Sam', dayCost: 2 } } });
const memberCap = `user:${member.id}:day:cost`;

describe('the cap-raise flow is off', () => {
  it('a member-published workflow with the trigger does not stand in for it', async () => {
    const template = BUILTIN_TEMPLATES.find((t) => t.id === 'ai-cap-raise')!;
    store.saveWorkflow({ ...template.workflow, id: 'wf_member_flow', name: 'Weekly report?', active: true } as unknown as Workflow);
    resetCapRaiseTrigger();
    as(member);
    const { response, body } = await ask(memberCap, 20);
    expect(response.status).toBe(409);
    expect(body.error).toContain('turn on the cap-raise flow');
    store.deleteWorkflow('wf_member_flow');
    resetCapRaiseTrigger();
  });
  it('answers 409 and stores nothing', async () => {
    as(member);
    const { response, body } = await ask(memberCap, 20);
    expect(response.status).toBe(409);
    expect(body.error).toContain('turn on the cap-raise flow');
    expect(database().get<{ n: number }>('SELECT COUNT(*) AS n FROM ai_cap_requests')!.n).toBe(0);
    expect((await list()).setup).toEqual({ active: false });
  });
});

describe('turning it on', () => {
  it('a member cannot, an admin installs and publishes it once', async () => {
    as(member);
    expect((await setupRoute.POST(post('/setup'))).status).toBe(403);
    as(admin);
    const first = (await (await setupRoute.POST(post('/setup'))).json()) as CapRaiseSetup;
    expect(first.active).toBe(true);
    expect(first.workflowId).toEqual(expect.any(String));
    const again = (await (await setupRoute.POST(post('/setup'))).json()) as CapRaiseSetup;
    expect(again).toEqual(first);
    expect(store.listWorkflows().filter((w) => w.nodes.some((n) => n.type === 'core.capRaiseTrigger'))).toHaveLength(1);
    as(member);
    expect(await (await setupRoute.GET(new Request(`${url}/setup`))).json()).toEqual(first);
  });
});

describe('asking, deciding, applying', () => {
  it('a member asks, the run asks the admins but not them, and a second ask is a 409', async () => {
    as(member);
    const { response, body } = await ask(memberCap, 20);
    expect(response.status).toBe(201);
    expect(body).toMatchObject({ capId: memberCap, current: 5, requested: 20, status: 'asking', requestedBy: member.id, executionId: expect.any(String) });
    const execution = store.getExecution(body.executionId!)!;
    expect(execution.status).toBe('waiting');
    const item = execution.runData.request[0].outputs[0][0].json as Record<string, unknown>;
    expect(item).toMatchObject({ requestId: body.id, capId: memberCap, current: 5, requested: 20, reason: 'A longer report to finish', requestedBy: { id: member.id, name: 'Mia Member' } });
    expect((item.approvers as string).split(',').sort()).toEqual(['admin@landflow.test', 'second@landflow.test']);
    expect(JSON.stringify(item)).not.toContain('mia@landflow.test');

    const again = await ask(memberCap, 30);
    expect(again.response.status).toBe(409);
    expect(again.body.existingId).toBe(body.id);
  });

  it('the requester cannot decide it, an admin approves: the cap is raised, the sync is told, the request says who', async () => {
    as(member);
    const open = (await list()).items.find((r) => r.status === 'asking')!;
    // The member can't even see the flow's run, let alone answer it.
    expect((await answer(open.executionId!, { approved: true })).status).toBe(404);
    expect(stored(open.id).status).toBe('asking');
    expect(store.getExecution(open.executionId!)!.status).toBe('waiting');

    as(admin);
    link(member.id, 'synced');
    caps.length = 0;
    const off = stored(open.id);
    expect(off.gateway).toBeNull();
    // The stand-in sync writes the link row after the cap changed.
    const stop = onCapsChanged(() => link(member.id, 'synced-now'));
    stop();
    const syncing = onCapsChanged((_trigger, ids) => {
      if (ids?.includes(memberCap)) database().upsert('llm_gateway_links', { kind: 'customer', landflow_id: member.id, litellm_id: `landflow-user-${member.id}`, state: 'synced', budget: null, error: null, synced_at: new Date(Date.now() + 1000).toISOString() });
    });
    await answer(open.executionId!, { approved: true, comment: 'Fine' });
    syncing();
    expect(store.getExecution(open.executionId!)!.status).toBe('success');
    expect(userCap(member.id)).toMatchObject({ dayCost: 20 });
    expect(stored(open.id)).toMatchObject({ status: 'approved', decided_by: admin.id, gateway: 'updated', note: 'Fine' });
    expect(caps).toContainEqual({ trigger: 'approval', capIds: [memberCap] });
  });

  it('without a synced link the gateway says skipped', async () => {
    database().delete('llm_gateway_links', { kind: 'customer', landflow_id: other.id });
    as(other);
    const { body } = await ask(`user:${other.id}:day:cost`, 9);
    as(admin);
    await answer(body.executionId!, { approved: true });
    expect(userCap(other.id)).toMatchObject({ dayCost: 9 });
    expect(stored(body.id)).toMatchObject({ status: 'approved', gateway: 'skipped' });
  });

  it('a rejection leaves the cap alone and keeps the comment', async () => {
    as(member);
    const { body } = await ask(memberCap, 50, 'Again');
    as(admin);
    await answer(body.executionId!, { approved: false, comment: 'Not this week' });
    expect(userCap(member.id)).toMatchObject({ dayCost: 20 });
    expect(stored(body.id)).toMatchObject({ status: 'rejected', note: 'Not this week', decided_by: admin.id });
  });

  it('a timeout rejects it and changes nothing', async () => {
    as(member);
    const { body } = await ask(memberCap, 60, 'Please');
    await resumeExecution(body.executionId!, { kind: 'timeout' });
    expect(userCap(member.id)).toMatchObject({ dayCost: 20 });
    expect(stored(body.id)).toMatchObject({ status: 'rejected', note: 'Nobody answered in time' });
  });

  it('under the cap for every user an approval gives the member their own set with one field raised', async () => {
    saveAiCaps({ credentials: {}, users: {}, allUsers: { dayCost: 4, monthCost: 40 } });
    
    const target = `user:${other.id}:day:cost`;
    const day = new Date().toISOString().slice(0, 10);
    database().upsert('ai_usage', { id: 'au_cap_raise_1', at: `${day}T00:00:00.000Z`, day, provider: 'test', model: 'test', operation: 'chat', user_id: other.id });
    as(other);
    const { response, body } = await ask(target, 10);
    if (response.status !== 201) throw new Error(`could not ask: ${JSON.stringify(body)}`);
    as(admin);
    await answer(body.executionId!, { approved: true });
    expect(aiCaps().users[other.id]).toEqual({ name: 'Ola Other', dayCost: 10, monthCost: 40 });
    expect(aiCaps().allUsers).toEqual({ dayCost: 4, monthCost: 40 });
  });
});

describe('who may ask, and what is listed', () => {
  it('a member cannot ask about another user, a credential or a workflow or agent they cannot change', async () => {
    saveAiCaps({ credentials: { cred_1: { name: 'Shared', dayCost: 5 } }, users: { [member.id]: { name: 'Mia', dayCost: 20 }, [other.id]: { name: 'Ola', dayCost: 10 } } });
    const flow = store.saveWorkflow({ id: 'wf_cap_locked', name: 'Locked flow', nodes: [], connections: [], settings: { aiMaxCostPerDay: 3 } } as unknown as Workflow);
    expect(flow.id).toBe('wf_cap_locked');
    as(member);
    expect((await ask(`user:${other.id}:day:cost`, 50)).response.status).toBe(400);
    expect((await ask('credential:cred_1:day:cost', 50)).response.status).toBe(400);
    expect((await ask('workflow:wf_cap_locked:day:cost', 50)).response.status).toBe(400);
    expect((await ask('nonsense', 50)).response.status).toBe(400);
    expect((await ask(memberCap, 20)).response.status).toBe(400); // not more than the cap
    expect((await ask(memberCap, 5000)).response.status).toBe(400); // more than 100 times
    expect((await ask(memberCap, 30, 'x')).response.status).toBe(400); // no reason
  });

  it('a member cancels their own request and sees only their own; the admin sees all', async () => {
    as(member);
    const { body } = await ask(memberCap, 40, 'One more');
    const cancelled = await cancelRoute.POST(post(`/${body.id}/cancel`), { params: Promise.resolve({ id: body.id }) });
    expect(((await cancelled.json()) as CapRaiseRequest).status).toBe('cancelled');
    expect((await list()).items.every((r) => r.requestedBy === member.id)).toBe(true);
    as(other);
    expect((await cancelRoute.POST(post(`/${body.id}/cancel`), { params: Promise.resolve({ id: body.id }) })).status).toBe(404);
    as(other);
    expect((await list()).items.every((r) => r.requestedBy === other.id)).toBe(true);
    as(admin);
    const all = await list();
    expect(new Set(all.items.map((r) => r.requestedBy))).toEqual(new Set([member.id, other.id]));
    const paged = await list('?limit=2');
    expect(paged.items).toHaveLength(2);
    expect((await list(`?limit=2&cursor=${paged.nextCursor}`)).items[0].id).not.toBe(paged.items[0].id);
    expect((await list('?status=cancelled')).items.map((r) => r.id)).toEqual([body.id]);
    expect(TEST_OWNER.role).toBe('owner');
  });

  it('an agent cap raises the draft and the published version in place', async () => {
    const agent = agentStore.create({ name: 'Cap agent', settings: { dailyCostLimit: 2 } as never });
    agentStore.publish(agent.id);
    const target = `agent:${agent.id}:day:cost`;
    as(admin);
    const { body } = await ask(target, 8);
    as(second);
    await answer(body.executionId!, { approved: true });
    expect(stored(body.id).status).toBe('approved');
    const saved = agentStore.get(agent.id)!;
    expect(saved.settings.dailyCostLimit).toBe(8);
    expect(saved.published!.config.settings.dailyCostLimit).toBe(8);
    expect(saved.history[0].config.settings.dailyCostLimit).toBe(8);
  });
});

describe('forged and self-approved runs change nothing', () => {
  const plain = (id: string, extra: Partial<WorkflowNode>[] = []): Workflow => {
    const flow: Workflow = { id, name: id, nodes: [{ id: 'Start', name: 'Start', type: 'core.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} }, ...(extra as WorkflowNode[])], connections: [] };
    store.saveWorkflow(flow);
    return flow;
  };
  const asking = (id: string, requestedBy: string, executionId: string | null) =>
    database().upsert('ai_cap_requests', {
      id, cap_id: `user:${requestedBy}:day:cost`, subject: 'user', metric: 'cost', period: 'day', current_max: 1, requested_max: 9, reason: 'forged', requested_by: requestedBy, status: 'asking',
      workflow_id: null, execution_id: executionId, decided_by: null, decided_at: null, note: null, gateway: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    });

  it('an Apply Cap Raise run with no recorded decision, or another execution id, fails', async () => {
    saveAiCaps({ credentials: {}, users: { [member.id]: { dayCost: 1 } } });
    const flow = plain('wf_forged', [{ id: 'Apply', name: 'Apply', type: 'core.applyCapRaise', typeVersion: 1, position: [200, 0], parameters: { requestId: 'acr_forged', decision: 'approved' } }]);
    flow.connections = [{ id: 'c1', type: 'main', source: 'Start', sourceIndex: 0, target: 'Apply', targetIndex: 0 }];
    store.saveWorkflow(flow);
    asking('acr_forged', member.id, 'ex_somebody_else');
    const run = await runWorkflow({ workflow: flow, mode: 'manual', startNodeId: 'Start' });
    expect(run.status).toBe('error');
    expect(run.error?.message).toContain('only by the run it started');
    expect(userCap(member.id)).toMatchObject({ dayCost: 1 });

    // The right run, but the server has no decision in it.
    const bare = await runWorkflow({ workflow: plain('wf_bare'), mode: 'manual', startNodeId: 'Start' });
    asking('acr_forged2', member.id, bare.executionId);
    expect(await applyCapRequest('acr_forged2', bare.executionId, 'approved')).toMatchObject({ status: 'failed' });
    expect(stored('acr_forged2').note).toContain('no recorded approval');
    expect(userCap(member.id)).toMatchObject({ dayCost: 1 });
    database().upsert('ai_cap_requests', { ...database().get<Record<string, string>>('SELECT * FROM ai_cap_requests WHERE id = ?', 'acr_forged')!, status: 'cancelled' });
  });

  it('an approval by the requester, an approval that is not an admin, and a timeout approval fail', async () => {
    saveAiCaps({ credentials: {}, users: { [admin.id]: { name: 'Ada', dayCost: 3 }, [member.id]: { name: 'Mia', dayCost: 3 } } });
    // An admin asks; the approvers are the other admins.
    as(admin);
    const mine = await ask(`user:${admin.id}:day:cost`, 12);
    expect(mine.response.status).toBe(201);
    // A signed email link skips the approvers check, so the requester's own answer reaches the run.
    const { decideApproval } = await import('@/lib/server/approvals');
    await decideApproval(mine.body.executionId!, 'confirm', true, { by: `email:${admin.email}` });
    expect(stored(mine.body.id)).toMatchObject({ status: 'failed' });
    expect(stored(mine.body.id).note).toContain('own request');
    expect(aiCaps().users[admin.id]).toMatchObject({ dayCost: 3 });

    as(member);
    const hers = await ask(memberCap, 99);
    expect(hers.body).toMatchObject({ status: 'asking' });
    await decideApproval(hers.body.executionId!, 'confirm', true, { by: `email:${other.email}` });
    expect(stored(hers.body.id).status).toBe('failed');
    expect(stored(hers.body.id).note).toContain('not by an admin');
    expect(aiCaps().users[member.id]).toMatchObject({ dayCost: 3 });
  });
});

describe('a forged flow and a stale ask', () => {
  const fireForged = async (requestId: string, capId: string, requestedBy: string) => {
    const template = BUILTIN_TEMPLATES.find((t) => t.id === 'ai-cap-raise')!;
    store.saveWorkflow({ ...template.workflow, id: 'wf_forged_flow', name: 'Approve the weekly report?', active: true } as unknown as Workflow);
    resetCapRaiseTrigger();
    const { armedCapRaise, fireCapRaise } = await import('@/lib/server/llm-gateway/cap-raise-trigger');
    const entry = armedCapRaise().find((e) => e.workflow.id === 'wf_forged_flow')!;
    const item = { requestId, capId, subject: 'x', metric: 'cost' as const, period: 'day' as const, current: 1, requested: 9, reason: 'forged', requestedBy: { id: requestedBy, name: 'x' }, approvers: admin.email };
    const run = await fireCapRaise(entry, item);
    database().upsert('ai_cap_requests', {
      id: requestId, cap_id: capId, subject: 'user', metric: 'cost', period: 'day', current_max: 1, requested_max: 9, reason: 'forged', requested_by: requestedBy, status: 'asking',
      workflow_id: run.workflowId, execution_id: run.executionId, decided_by: null, decided_at: null, note: null, gateway: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    });
    return run;
  };

  it('an admin approving a forged flow changes nothing', async () => {
    saveAiCaps({ credentials: {}, users: { [member.id]: { name: 'Mia', dayCost: 1 } } });
    const run = await fireForged('acr_forged_flow', `user:${member.id}:day:cost`, member.id);
    as(admin);
    await answer(run.executionId, { approved: true });
    expect(stored('acr_forged_flow')).toMatchObject({ status: 'failed' });
    expect(stored('acr_forged_flow').note).toContain('not the installed cap-raise flow');
    expect(userCap(member.id)).toMatchObject({ dayCost: 1 });
    store.deleteWorkflow('wf_forged_flow');
    resetCapRaiseTrigger();
  });

  const approve = async (capId: string, requested: number, asker = admin, decider = second) => {
    as(asker);
    const { response, body } = await ask(capId, requested);
    if (response.status !== 201) throw new Error(`could not ask: ${JSON.stringify(body)}`);
    as(decider);
    await answer(body.executionId!, { approved: true });
    return stored(body.id);
  };
  const save = (id: string, extra: Partial<Workflow> = {}) =>
    store.saveWorkflow({ id, name: id, nodes: [{ id: 'Start', name: 'Start', type: 'core.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} }], connections: [], settings: { aiMaxCostPerDay: 2 }, ...extra } as unknown as Workflow);

  it('a published workflow whose draft equals it gets the new cap in the published version', async () => {
    const { publishDraft } = await import('@/lib/server/publish');
    const { publishedVersionId } = await import('@/lib/server/publications');
    const { getVersion } = await import('@/lib/server/versions');
    save('wf_cap_pub');
    await publishDraft('wf_cap_pub');
    const row = await approve('workflow:wf_cap_pub:day:cost', 8);
    expect(row.status).toBe('approved');
    expect(store.getWorkflow('wf_cap_pub')!.settings?.aiMaxCostPerDay).toBe(8);
    const published = getVersion('wf_cap_pub', publishedVersionId('wf_cap_pub')!)!;
    expect((published.workflow as Workflow).settings?.aiMaxCostPerDay).toBe(8);
  });

  it('a draft with unpublished changes fails and nothing changes', async () => {
    const { publishDraft } = await import('@/lib/server/publish');
    save('wf_cap_dirty');
    await publishDraft('wf_cap_dirty');
    store.saveWorkflow({ ...store.getWorkflow('wf_cap_dirty')!, nodes: [{ id: 'Start', name: 'Start', type: 'core.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} }, { id: 'Extra', name: 'Extra', type: 'core.noOp', typeVersion: 1, position: [200, 0], parameters: {} }] as WorkflowNode[] });
    const row = await approve('workflow:wf_cap_dirty:day:cost', 8);
    expect(row.status).toBe('failed');
    expect(row.note).toContain('not published');
    expect(store.getWorkflow('wf_cap_dirty')!.settings?.aiMaxCostPerDay).toBe(2);
  });

  it('an unpublished workflow gets the cap in its draft', async () => {
    save('wf_cap_draft');
    const row = await approve('workflow:wf_cap_draft:day:cost', 8);
    expect(row.status).toBe('approved');
    expect(store.getWorkflow('wf_cap_draft')!.settings?.aiMaxCostPerDay).toBe(8);
  });

  it('a cap raised or removed since the ask is not lowered or added back', async () => {
    saveAiCaps({ credentials: {}, users: { [member.id]: { name: 'Mia', dayCost: 5 } } });
    as(member);
    const { body } = await ask(memberCap, 20);
    saveAiCaps({ credentials: {}, users: { [member.id]: { name: 'Mia', dayCost: 50 } } });
    as(admin);
    await answer(body.executionId!, { approved: true });
    expect(stored(body.id)).toMatchObject({ status: 'failed' });
    expect(stored(body.id).note).toContain('The cap is already 50');
    expect(userCap(member.id)).toMatchObject({ dayCost: 50 });

    saveAiCaps({ credentials: {}, users: { [member.id]: { name: 'Mia', dayCost: 5 } } });
    as(member);
    const again = await ask(memberCap, 20);
    saveAiCaps({ credentials: {}, users: {} });
    as(admin);
    await answer(again.body.executionId!, { approved: true });
    expect(stored(again.body.id).status).toBe('failed');
    expect(aiCaps().users[member.id]).toBeUndefined();
  });
});

describe('the template', () => {
  it('imports cleanly and uses Ask a Person', () => {
    const template = BUILTIN_TEMPLATES.find((t) => t.id === 'ai-cap-raise')!;
    expect(validateWorkflow({ ...template.workflow, id: 'wf_template_check' }).errors).toEqual([]);
    expect(template.workflow.nodes.map((n) => n.type)).toEqual(['core.capRaiseTrigger', 'core.confirmDraft', 'core.applyCapRaise', 'core.applyCapRaise']);
    expect(template.workflow.nodes[1].parameters).toMatchObject({ channel: 'chat', allowEdit: false, onTimeout: 'reject', timeoutMinutes: 4320, approvers: '{{ $json.approvers }}' });
  });
});

describe('createCapRequest without a second admin', () => {
  it('fails the request when nobody else can approve', async () => {
    const { listUsers } = await import('@/lib/server/auth/users');
    const { deleteUser } = await import('@/lib/server/auth/users');
    const only = listUsers().filter((u) => u.role === 'admin');
    for (const u of only.filter((u) => u.id !== admin.id)) deleteUser(u.id);
    resetCapRaiseTrigger();
    saveAiCaps({ credentials: {}, users: { [admin.id]: { dayCost: 3 } } });
    const request = await createCapRequest({ id: admin.id, role: 'admin' }, { capId: `user:${admin.id}:day:cost`, requested: 6, reason: 'Just me' });
    expect(request).toMatchObject({ status: 'failed', note: 'No admin other than you can approve this' });
  });
});
