/**
 * The tomorrow sync (docs/work-and-briefings.md#the-nightly-sync): the template's workflow run in process over seeded people
 * and work, the briefing store, the deterministic text, what is served, and delivery that is opt-in. No model, a fake Slack.
 */
import { createServer, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { executeWorkflow, inProcessNodeType, type NodeTypeResolver } from '@landflow/engine';
import type { GatheredWork } from '@/lib/shared/brain-work';

vi.setConfig({ testTimeout: 20_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-briefing-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_BRAIN_MODEL: 'off', LANDFLOW_BRAIN_EMBEDDINGS: 'off' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { database } = await import('@/lib/server/db');
const { createUser } = await import('@/lib/server/auth/users');
const { updateSettings } = await import('@/lib/server/settings');
const { setPreferences } = await import('@/lib/server/preferences');
const { corePlugin } = await import('@/lib/server/nodes');
const { registry } = await import('@/lib/server/plugins/registry');
const { BUILTIN_TEMPLATES } = await import('@/lib/server/templates');
const { validateWorkflow } = await import('@/lib/server/mcp/workflows');
const { recordWork } = await import('@/lib/server/brain/work');
const { briefingFor, deterministicBriefing, dayBefore, writeBriefingText } = await import('@/lib/server/brain/briefing');
const { createDraft, latestReady, markReady, pruneBriefings, writeText } = await import('@/lib/server/brain/briefings-store');
const { briefingText } = await import('@/lib/server/mcp/brain-prompts');
const { setMailTransport } = await import('@/lib/server/auth/mail');
const { createTeamProject, setMember } = await import('@/lib/server/projects/store');
const { items } = await import('./helpers');
const { store } = await import('@/lib/server/store');
const { briefingMarkdown } = await import('@/lib/server/mcp/brain-prompts');
const { runWorkflow, planRerun } = await import('@/lib/server/runner');
const { currentActorId, outsideRequest, withAuth } = await import('@/lib/server/auth/context');
const { credentials: vault } = await import('@/lib/server/credentials/vault');
const { setHomeProject } = await import('@/lib/server/projects/store');
const { instanceServer } = await import('@/lib/server/mcp/instance-tools');
const { dayOf } = await import('@/lib/server/usage/ledger');
const { Client, InMemoryTransport } = await import('@modelcontextprotocol/client');
const { publishOrRequest } = await import('@/lib/server/governance/approvals');
const { productionWorkflowById } = await import('@/lib/server/publish');
const { getPublication } = await import('@/lib/server/publications');
const { listVersions, versionAuthor } = await import('@/lib/server/versions');
const { upsertProposal, applyProposal } = await import('@/lib/server/brain/proposals');
const { planRetry } = await import('@/lib/server/runner/rerun');
const credentialRoute = await import('@/app/api/credentials/[id]/route');
const { enableTestAuth } = await import('@/lib/server/auth/test-bypass');

const { defineCredentialType, definePlugin } = await import('@landflow/sdk');
registry.registerBuiltin(corePlugin);
// The Slack credential types (the messaging plugin isn't loaded here): Deliver Briefing reads neither, but a saved graph
// may still reference one on it (it had credential slots before).
registry.registerBuiltin(
  definePlugin({
    info: { id: 'messaging', name: 'Messaging', version: '1.0.0', language: 'typescript' },
    credentialTypes: [
      defineCredentialType({
        name: 'slackApi',
        displayName: 'Slack API',
        properties: [
          { name: 'accessToken', displayName: 'Access Token', type: 'string', required: true, typeOptions: { password: true } },
          { name: 'baseUrl', displayName: 'Base URL', type: 'string', default: 'https://slack.com/api' },
        ],
      }),
      defineCredentialType({
        name: 'slackOAuth2Api',
        displayName: 'Slack OAuth2 API',
        extends: ['oAuth2Api'],
        properties: [
          { name: 'baseUrl', displayName: 'Base URL', type: 'string', default: 'https://slack.com/api' },
        ],
      }),
    ],
    nodes: [],
  }),
);
const owner = await createUser({ email: 'owner@sync.test', name: 'Owner', role: 'owner', password: 'owner-password-1' });
const alice = await createUser({ email: 'alice@sync.test', name: 'Alice', role: 'member', password: 'alice-password-1' });
const bob = await createUser({ email: 'bob@sync.test', name: 'Bob', role: 'member', password: 'bob-password-1' });
const idle = await createUser({ email: 'idle@sync.test', name: 'Idle', role: 'member', password: 'idle-password-1' });
const team = createTeamProject({ name: 'Platform', createdBy: owner.id });
setMember(team.id, alice.id, 'editor');
setMember(team.id, bob.id, 'editor');
const actorOf = (user: { id: string; role: 'owner' | 'admin' | 'member' }) => ({ id: user.id, role: user.role });

const template = BUILTIN_TEMPLATES.find((t) => t.id === 'brain-tomorrow-sync')!;
const resolver: NodeTypeResolver = {
  resolve(type) {
    const [pluginId, name] = type.split('.');
    const node = pluginId === 'core' ? corePlugin.nodes.find((n) => n.description.name === name) : undefined;
    return node ? inProcessNodeType(pluginId, node) : { error: `Unknown node type ${type}` };
  },
};

let slack: Server;
const slackCalls: Array<{ url: string; body: string; auth: string }> = [];
const slackUrl = await new Promise<string>((resolve) => {
  slack = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      slackCalls.push({ url: request.url ?? '', body, auth: String(request.headers.authorization) });
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(request.url?.startsWith('/users.lookupByEmail') ? { ok: true, user: { id: 'U0ALICE1' } } : { ok: true, ts: '1.1' }));
    });
  }).listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(slack.address() as { port: number }).port}`));
});
// Deliver Briefing sends with the server's Slack bot only: its token and API base URL (here, the fake) are server settings.
const SERVER_TOKEN = 'xoxb-dev-only-server-bot';
const ENV_SLACK = { LANDFLOW_BRIEFING_SLACK_URL: slackUrl, LANDFLOW_BRIEFING_SLACK_TOKEN: SERVER_TOKEN };
Object.assign(process.env, ENV_SLACK);
/** Run `fn` with no Slack token on the server. */
const withoutSlackToken = async <T,>(fn: () => Promise<T>): Promise<T> => {
  delete process.env.LANDFLOW_BRIEFING_SLACK_TOKEN;
  try {
    return await fn();
  } finally {
    Object.assign(process.env, ENV_SLACK);
  }
};

afterAll(async () => {
  slack.close();
  setMailTransport(undefined);
  for (const key of [...Object.keys(ENV), ...Object.keys(ENV_SLACK)]) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();
const work = (sourceId: string, patch: Record<string, unknown> = {}) => ({ kind: 'work.session', source: 'claude-code', sourceId, occurredAt: minutesAgo(1), title: `Work ${sourceId}`, ...patch });

/**
 * The template's content and delivery, run in the engine: an owner's manual run (the execution row the runner would
 * save). Who may run the nodes is tested through the real runner below.
 */
async function sync(options: { workflowId?: string } = {}) {
  const workflow = { ...template.workflow, id: options.workflowId ?? 'wf_sync' };
  const executionId = `ex_${Math.random().toString(36).slice(2)}`;
  store.saveExecution({ executionId, workflowId: workflow.id, workflowName: workflow.name, mode: 'manual', status: 'running', startedAt: new Date().toISOString(), finishedAt: '', durationMs: 0, runData: {}, executionOrder: [], workflow, startedBy: owner.id } as never);
  return executeWorkflow({
    workflow,
    resolver,
    executionId,
    mode: 'manual',
    startNodeId: 'nightly',
    triggerItems: items({}),
  });
}

const rowsFor = (userId: string, status?: string) => database().all<{ id: string; status: string; text: string; model: string; gathered: string; day: string }>(`SELECT * FROM brain_briefings WHERE user_id = ?${status ? ` AND status = '${status}'` : ''} ORDER BY created_at`, userId);

// The nodes run only in a workflow that no member made: a seeded one, and one a member made (as her: a body's createdBy is ignored).
store.saveWorkflow({ ...template.workflow, id: 'wf_sync' });
withAuth({ principal: { user: alice, via: 'test' } }, () => store.saveWorkflow({ ...template.workflow, id: 'wf_member', createdBy: owner.id }));

beforeEach(() => {
  const db = database();
  db.deleteBefore('usage_events', 'at', '9999');
  db.deleteBefore('brain_briefings', 'created_at', '9999');
  updateSettings({ timezone: 'UTC' });
  for (const user of [alice, bob, idle]) setPreferences(user.id, { briefingDelivery: 'none' });
  slackCalls.length = 0;
  setMailTransport(undefined);
});

describe('the template', () => {
  it('imports cleanly and runs from a Schedule at 02:00 through the five brain nodes, with a privacy note', () => {
    expect(template.workflow.nodes.map((n) => n.type)).toEqual(['core.schedule', 'core.brainListPeople', 'core.brainGatherWork', 'core.brainWriteBriefing', 'core.brainSaveBriefing', 'core.brainDeliverBriefing']);
    expect(template.workflow.nodes[0].parameters).toEqual({ rule: { interval: [{ field: 'days', daysInterval: 1, triggerAtHour: 2, triggerAtMinute: 0 }] } });
    expect(template.workflow.stickyNotes?.[0].content).toContain('Nothing is sent');
    const result = validateWorkflow({ ...template.workflow, id: 'wf_sync' }) as { valid?: boolean; errors?: unknown[] };
    expect(result.errors ?? []).toEqual([]);
  });
});

describe('a run of the sync', () => {
  it('writes one ready briefing per active person, with ids and counts in the run data and no text', async () => {
    recordWork(actorOf(alice), [work('a1', { repo: 'acme/billing', title: 'Fix the invoice export', visibility: 'team' }), work('a2', { repo: 'acme/billing', title: 'PRIVATE-ALICE secret plan' })]);
    recordWork(actorOf(bob), [work('b1', { repo: 'acme/billing', title: 'Billing retries', visibility: 'team', summary: 'invoice export retries' }), work('b2', { title: 'PRIVATE-BOB diary' })]);
    const result = await sync();
    expect(result.status).toBe('success');
    const data = JSON.stringify(result.runData);
    for (const secret of ['Fix the invoice export', 'Billing retries', 'PRIVATE-ALICE', 'PRIVATE-BOB', 'secret plan']) expect(data).not.toContain(secret);
    const delivered = result.runData.deliver.at(-1)!.outputs[0].map((item) => item.json);
    expect(delivered.map((j) => Object.keys(j).sort())).toEqual([['briefingId', 'counts', 'day', 'delivered', 'userId'], ['briefingId', 'counts', 'day', 'delivered', 'userId']]);
    expect(delivered.every((j) => j.delivered === false)).toBe(true);
    expect(rowsFor(alice.id, 'ready')).toHaveLength(1);
    expect(rowsFor(bob.id, 'ready')).toHaveLength(1);
    expect(rowsFor(idle.id)).toHaveLength(0);
    expect(rowsFor(owner.id)).toHaveLength(0);
    expect(rowsFor(alice.id, 'ready')[0].model).toBe('deterministic');
  });

  it('adds the goals that moved to each person’s draft, counted in the run data and named in the text, never a title', async () => {
    const { createGoal } = await import('@/lib/server/goals/store');
    const goal = createGoal({ title: 'Faster billing', level: 'project', projectId: team.id });
    database().upsert('usage_events', { id: 'ev_goal_alice', at: minutesAgo(5), day: dayOf(Date.now() - 5 * 60_000), kind: 'work.session', project_id: team.id, goal_id: null, owner_id: alice.id, visibility: 'private', source: 'test', source_id: 'g1', message: 'PRIVATE-GOAL-WORK' });
    recordWork(actorOf(bob), [work('g2', { title: 'Bob’s day' })]);
    const result = await sync();
    expect(result.status).toBe('success');
    const counts = Object.fromEntries(result.runData.deliver.at(-1)!.outputs[0].map((item) => [item.json.userId as string, (item.json.counts as Record<string, number>).goalsMoved]));
    // Alice's private event moves the goal for her; Bob's numbers do not include it.
    expect(counts[alice.id]).toBe(1);
    expect(counts[bob.id] ?? 0).toBe(0);
    expect(rowsFor(alice.id, 'ready')[0].text).toContain(`Goals that moved: ${goal.title} (1 update).`);
    expect(rowsFor(bob.id, 'ready')[0].text).not.toContain('Goals that moved');
    expect(JSON.stringify(result.runData)).not.toContain('PRIVATE-GOAL-WORK');
  });

  it('keeps one person’s private items out of another’s gathered work', async () => {
    recordWork(actorOf(alice), [work('a1', { repo: 'acme/billing', title: 'Fix the invoice export', visibility: 'team' }), work('a2', { repo: 'acme/billing', title: 'PRIVATE-ALICE secret plan' })]);
    recordWork(actorOf(bob), [work('b1', { repo: 'acme/billing', title: 'Billing retries', visibility: 'team' })]);
    await sync();
    const bobs = rowsFor(bob.id, 'ready')[0];
    expect(bobs.gathered).toContain('Fix the invoice export');
    expect(bobs.gathered).not.toContain('PRIVATE-ALICE');
    expect(bobs.text).not.toContain('PRIVATE-ALICE');
    expect(rowsFor(alice.id, 'ready')[0].gathered).toContain('PRIVATE-ALICE');
    expect(rowsFor(alice.id, 'ready')[0].gathered).toContain('Billing retries');
  });

  it('a second run supersedes the first', async () => {
    recordWork(actorOf(alice), [work('a1', { title: 'Fix the invoice export' })]);
    await sync();
    await sync();
    expect(rowsFor(alice.id).map((r) => r.status).sort()).toEqual(['ready', 'superseded']);
    const day = rowsFor(alice.id, 'ready')[0].day;
    expect(latestReady(alice.id, day)?.status).toBe('ready');
  });

  it('serves the stored briefing as source flow, and says so in the MCP prompt', async () => {
    recordWork(actorOf(alice), [work('a1', { repo: 'acme/billing', title: 'Fix the invoice export' })]);
    const run = await sync();
    const day = rowsFor(alice.id, 'ready')[0].day;
    const live = briefingFor(actorOf(alice), { day: dayBefore(day) });
    expect(live.source).toBe('live');
    const served = briefingFor(actorOf(alice), { day });
    expect(served.source).toBe('flow');
    expect(served.summary).toBe(rowsFor(alice.id, 'ready')[0].text);
    expect(served.generatedBy).toEqual({ workflowId: 'wf_sync', executionId: run.executionId });
    expect(briefingText(served)).toContain('From last night’s sync');
    // Bob never sees Alice's.
    expect(briefingFor(actorOf(bob), { day }).source).toBe('live');
  });
});

describe('the day', () => {
  it('a 02:00 run on D gathers D-1 and D, and the morning of D finds it with no day given', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-11-13T15:00:00Z'));
      recordWork(actorOf(alice), [work('y1', { title: 'Fix the invoice export', occurredAt: '2026-11-13T14:00:00Z' })]);
      vi.setSystemTime(new Date('2026-11-14T02:00:00Z'));
      const result = await sync();
      expect(result.status).toBe('success');
      const ready = rowsFor(alice.id, 'ready')[0];
      expect(ready.day).toBe('2026-11-14');
      expect(ready.gathered).toContain('Fix the invoice export');
      expect(ready.text).toContain('Recently you');
      vi.setSystemTime(new Date('2026-11-14T08:00:00Z'));
      const served = briefingFor(actorOf(alice));
      expect(served.day).toBe('2026-11-14');
      expect(served.source).toBe('flow');
      expect(served.summary).toBe(ready.text);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('who may run the nodes', () => {
  it('a member’s workflow gathers, saves and delivers nothing', async () => {
    recordWork(actorOf(alice), [work('a1')]);
    recordWork(actorOf(bob), [work('b1')]);
    setPreferences(bob.id, { briefingDelivery: 'slack' });
    const result = await sync({ workflowId: 'wf_member' });
    expect(result.status).not.toBe('success');
    expect(rowsFor(alice.id)).toHaveLength(0);
    expect(rowsFor(bob.id)).toHaveLength(0);
    expect(slackCalls).toEqual([]);
  });
});

describe('who started the run (through the runner)', () => {
  type AnyUser = typeof owner;
  const as = <T,>(user: AnyUser, fn: () => T): T => withAuth({ principal: { user, via: 'test' } }, fn);
  const graph = (id: string, withinDays: number) => ({
    ...template.workflow,
    id,
    nodes: template.workflow.nodes.map((n) => (n.id === 'people' ? { ...n, parameters: { ...n.parameters, withinDays } } : n)),
  });
  // The nightly workflow, in the team Alice and Bob are editors of (Alice may run it): first saved by the owner, then by
  // Alice with her own graph, then by the owner again, so Alice's graph is an older version in its history.
  const ownerGraph = graph('wf_nightly', 3);
  const aliceGraph = graph('wf_nightly', 0);
  as(owner, () => store.saveWorkflow(ownerGraph));
  setHomeProject('workflow', 'wf_nightly', team.id);
  as(alice, () => store.saveWorkflow(aliceGraph));
  as(owner, () => store.saveWorkflow(ownerGraph));
  const saved = () => store.getWorkflow('wf_nightly')!;
  // What the scheduler runs: the published version (a schedule of the saved draft is refused). The owner publishes the
  // owner's graph first.
  const publishNightly = () => as(owner, () => publishOrRequest({ workflowId: 'wf_nightly', action: 'publish', by: owner.id }));
  const scheduled = (workflow = productionWorkflowById('wf_nightly')!) => runWorkflow({ workflow, mode: 'trigger', startNodeId: 'nightly', triggerItems: items({}) });
  beforeAll(async () => {
    await publishNightly();
  });
  const today = () => dayOf(Date.now());
  const slackPosts = () => slackCalls.filter((c) => c.url === '/chat.postMessage');

  beforeEach(() => {
    recordWork(actorOf(bob), [work('b1', { title: 'PRIVATE-BOB diary' })]);
    setPreferences(bob.id, { briefingDelivery: 'slack' });
  });

  it('a scheduled run of an owner-saved workflow writes and delivers the briefings', async () => {
    const run = await scheduled();
    expect(run.error?.message).toBeUndefined();
    expect(run.status).toBe('success');
    expect(run.startedBy).toBeUndefined();
    expect(rowsFor(bob.id, 'ready')).toHaveLength(1);
    expect(slackPosts()).toHaveLength(1);
  });

  it('a member’s MCP run from Gather Work with their own items is refused, and nothing is written or sent', async () => {
    const run = await as(alice, () => runWorkflow({ workflow: saved(), mode: 'mcp', startNodeId: 'gather', triggerItems: items({ userId: bob.id, day: today() }) }));
    expect(run.status).toBe('error');
    expect(run.startedBy).toBe(alice.id);
    // And her manual run of an unsaved graph under the saved id.
    const unsaved = { ...saved(), name: 'Alice’s copy' };
    expect((await as(alice, () => runWorkflow({ workflow: unsaved, mode: 'manual', startNodeId: 'nightly' }))).status).toBe('error');
    expect(rowsFor(bob.id)).toHaveLength(0);
    expect(slackCalls).toEqual([]);
  });

  it('the same through the MCP tool execute_workflow', async () => {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await instanceServer(actorOf(alice)).connect(serverSide);
    const client = new Client({ name: 'briefing-test', version: '1.0.0' });
    await client.connect(clientSide);
    const result = (await client.callTool({ name: 'execute_workflow', arguments: { id: 'wf_nightly', startNode: 'gather', input: { userId: bob.id, day: today() } } })) as { content: Array<{ text: string }> };
    expect(JSON.parse(result.content[0].text).status).toBe('error');
    expect(rowsFor(bob.id)).toHaveLength(0);
    expect(slackCalls).toEqual([]);
  });

  it('a member’s re-run of a scheduled run with an older version’s graph is refused', async () => {
    const nightly = await scheduled();
    slackCalls.length = 0;
    const plan = planRerun(nightly.executionId, { scope: 'all' }, aliceGraph);
    const run = await as(alice, () => runWorkflow(plan));
    expect(run.versionId).toBeTruthy();
    expect(run.status).toBe('error');
    expect(rowsFor(bob.id)).toHaveLength(1);
    expect(slackCalls).toEqual([]);
  });

  it('a member’s plain re-run of a scheduled run, from the start or from a node, is refused and delivers nothing again', async () => {
    const nightly = await scheduled();
    slackCalls.length = 0;
    for (const request of [{ scope: 'all' as const }, { scope: 'from' as const, nodeId: 'gather' }, { scope: 'only' as const, nodeId: 'deliver' }]) {
      const run = await as(alice, () => runWorkflow(planRerun(nightly.executionId, request)));
      expect(run.status).toBe('error');
    }
    expect(rowsFor(bob.id)).toHaveLength(1);
    expect(slackCalls).toEqual([]);
  });

  it('a re-run with no person behind it is refused too, and an owner’s re-run is allowed', async () => {
    const nightly = await scheduled();
    expect((await runWorkflow(planRerun(nightly.executionId, { scope: 'all' }))).status).toBe('error');
    const again = await as(owner, () => runWorkflow(planRerun(nightly.executionId, { scope: 'all' })));
    expect(again.startedBy).toBe(owner.id);
    expect(again.status).toBe('success');
    expect(rowsFor(bob.id).map((r) => r.status).sort()).toEqual(['ready', 'superseded']);
  });

  it('a trigger run of an older version is refused; a retry passes only when automatic, and only of a source that passes', async () => {
    expect((await scheduled(aliceGraph)).status).toBe('error');
    expect(rowsFor(bob.id)).toHaveLength(0);
    const nightly = await scheduled();
    database().deleteBefore('brain_briefings', 'created_at', '9999');
    // A failed copy of the nightly run, and one with nobody behind it in a mode a person starts (a run from before startedBy).
    const failed = (id: string, patch: Record<string, unknown> = {}) => {
      store.saveExecution({ ...nightly, executionId: id, status: 'error', error: { message: 'Slack was down' }, ...patch } as never);
      return id;
    };
    const retry = async (sourceId: string, automatic: boolean) => runWorkflow(planRetry(sourceId, { automatic, from: 'start' }));
    expect((await retry(failed('ex_failed_nightly'), false)).status).toBe('error');
    expect((await retry(failed('ex_failed_manual', { mode: 'manual' }), true)).status).toBe('error');
    expect((await retry(failed('ex_failed_rerun', { rerunOf: { executionId: nightly.executionId } }), true)).status).toBe('error');
    expect(rowsFor(bob.id)).toHaveLength(0);
    // A made-up source is refused: there is nothing to check.
    expect((await runWorkflow({ workflow: productionWorkflowById('wf_nightly')!, mode: 'trigger', startNodeId: 'nightly', triggerItems: items({}), retry: { of: 'ex_made_up', attempt: 1, automatic: true } })).status).toBe('error');
    const automatic = await retry('ex_failed_nightly', true);
    expect(automatic.retryAutomatic).toBe(true);
    expect(automatic.error?.message).toBeUndefined();
    expect(automatic.status).toBe('success');
  });

  it('a member saving a change does not touch the published version; published by an owner it stops the nightly run until an owner or admin saves a change; a save with no change counts for nothing', async () => {
    as(alice, () => store.saveWorkflow(saved()));
    expect((await scheduled()).status).toBe('success');
    as(alice, () => store.saveWorkflow({ ...graph('wf_nightly', 5), active: true }));
    try {
      // The schedule still runs the owner's published version; the member's draft is not what runs.
      expect((await scheduled()).status).toBe('success');
      await publishNightly();
      const run = await scheduled();
      expect(run.status).toBe('error');
      expect(run.error?.message).toBe('A member, or nobody, saved the version of this workflow that ran: it handles no one’s briefings until an owner or admin saves a change to it (and publishes that version, when it is published)');
      // An owner's save of the same graph is no change: the version is still Alice's.
      as(owner, () => store.saveWorkflow(saved()));
      await publishNightly();
      expect((await scheduled()).status).toBe('error');
      expect(rowsFor(bob.id).filter((r) => r.status === 'ready')).toHaveLength(1);
    } finally {
      as(owner, () => store.saveWorkflow(ownerGraph));
      await publishNightly();
    }
    expect((await scheduled()).status).toBe('success');
  });

  it('a scheduled run of an owner-saved but unpublished workflow is refused and writes and sends nothing; the owner publishing it makes it run', async () => {
    as(owner, () => store.saveWorkflow(graph('wf_unpublished', 3)));
    setHomeProject('workflow', 'wf_unpublished', team.id);
    const before = rowsFor(bob.id).length;
    slackCalls.length = 0;
    const draft = await runWorkflow({ workflow: store.getWorkflow('wf_unpublished')!, mode: 'trigger', startNodeId: 'nightly', triggerItems: items({}) });
    expect(draft.status).toBe('error');
    expect(JSON.stringify(draft.runData)).toContain('A schedule handles people’s briefings only from the published version: an owner or admin publishes it first');
    expect(rowsFor(bob.id)).toHaveLength(before);
    expect(slackCalls).toEqual([]);
    await as(owner, () => publishOrRequest({ workflowId: 'wf_unpublished', action: 'publish', by: owner.id }));
    const run = await runWorkflow({ workflow: productionWorkflowById('wf_unpublished')!, mode: 'trigger', startNodeId: 'nightly', triggerItems: items({}) });
    expect(run.error?.message).toBeUndefined();
    expect(run.status).toBe('success');
    expect(slackPosts()).toHaveLength(1);
  });

  it('with the brain off nothing is written or sent, from any start node', async () => {
    const nightly = await scheduled();
    const briefingId = rowsFor(bob.id, 'ready')[0].id;
    database().deleteBefore('brain_briefings', 'created_at', '9999');
    slackCalls.length = 0;
    process.env.LANDFLOW_BRAIN = 'false';
    try {
      expect(nightly.status).toBe('success');
      for (const startNodeId of ['nightly', 'people', 'gather', 'write', 'save', 'deliver']) {
        const run = await as(owner, () => runWorkflow({ workflow: saved(), mode: 'manual', startNodeId, triggerItems: items({ userId: bob.id, day: today(), briefingId }) }));
        expect(run.status).toBe('success');
      }
    } finally {
      delete process.env.LANDFLOW_BRAIN;
    }
    expect(rowsFor(bob.id)).toHaveLength(0);
    expect(slackCalls).toEqual([]);
  });

  describe('which version ran: who saved it and who published it', () => {
    // Each case has its own workflow in the team (Alice is an editor there), saved and published by the owner first.
    const fresh = async (id: string, publish = true) => {
      as(owner, () => store.saveWorkflow(graph(id, 3)));
      setHomeProject('workflow', id, team.id);
      if (publish) await as(owner, () => publishOrRequest({ workflowId: id, action: 'publish', by: owner.id }));
      return id;
    };
    const production = (id: string) => runWorkflow({ workflow: productionWorkflowById(id)!, mode: 'trigger', startNodeId: 'nightly', triggerItems: items({}) });
    // The owner publishes whatever the draft is now (a schedule runs only the published version), then it runs.
    const draftRun = async (id: string) => {
      await as(owner, () => publishOrRequest({ workflowId: id, action: 'publish', by: owner.id }));
      return production(id);
    };
    // A graph of Alice's: List People pinned to a person and a day of her choosing (only manual runs use pins).
    const pinnedTo = (id: string, day: string) => ({ ...graph(id, 0), pinData: { people: [{ json: { userId: idle.id, day } }] } });
    const idleRows = () => rowsFor(idle.id);

    it('an owner-saved, owner-published version runs on its schedule', async () => {
      const id = await fresh('wf_v_owner');
      const run = await production(id);
      expect(run.error?.message).toBeUndefined();
      expect(run.status).toBe('success');
      expect(run.versionPublished).toBe(true);
      expect(rowsFor(bob.id, 'ready')).toHaveLength(1);
    });

    it('A: a member publishes her own older version after the owner saved again: refused', async () => {
      const id = await fresh('wf_v_a');
      as(alice, () => store.saveWorkflow({ ...store.getWorkflow(id)!, ...pinnedTo(id, '2020-01-02'), active: true }));
      const aliceVersion = listVersions(id)[0];
      expect(versionAuthor(id, aliceVersion.id)).toBe(alice.id);
      as(owner, () => store.saveWorkflow({ ...store.getWorkflow(id)!, ...graph(id, 3), pinData: undefined, active: true }));
      expect(store.getWorkflow(id)!.updatedBy).toBe(owner.id);
      await as(alice, () => publishOrRequest({ workflowId: id, action: 'publish', versionId: aliceVersion.id, by: alice.id }));
      expect(getPublication(id)).toMatchObject({ versionId: aliceVersion.id, publishedBy: alice.id });
      const run = await production(id);
      expect(run.status).toBe('error');
      expect(run.error?.message).toMatch(/^A member, or nobody, saved the version/);
      expect(idleRows()).toHaveLength(0);
      expect(rowsFor(bob.id)).toHaveLength(0);
    });

    it('B: a member publishes her graph and puts the draft back to the owner’s: production runs her version, refused', async () => {
      const id = await fresh('wf_v_b');
      as(alice, () => store.saveWorkflow({ ...store.getWorkflow(id)!, ...pinnedTo(id, '2020-01-03'), active: true }));
      await as(alice, () => publishOrRequest({ workflowId: id, action: 'publish', by: alice.id }));
      as(alice, () => store.saveWorkflow({ ...store.getWorkflow(id)!, ...graph(id, 3), pinData: undefined, active: true }));
      as(owner, () => store.saveWorkflow(store.getWorkflow(id)!));
      expect((await production(id)).status).toBe('error');
      // The draft is the owner's graph again, but Alice's save made its version: a trigger run of the draft is refused too.
      expect((await draftRun(id)).status).toBe('error');
      expect(idleRows()).toHaveLength(0);
      expect(rowsFor(bob.id)).toHaveLength(0);
    });

    it('an owner publishing a version a member saved is refused: the version’s author must be an owner or admin', async () => {
      const id = await fresh('wf_v_pub_member');
      as(alice, () => store.saveWorkflow(graph(id, 5)));
      await as(owner, () => publishOrRequest({ workflowId: id, action: 'publish', by: owner.id }));
      expect(getPublication(id)?.publishedBy).toBe(owner.id);
      expect((await production(id)).status).toBe('error');
      // An owner's change makes a version of their own; published, it runs.
      as(owner, () => store.saveWorkflow(graph(id, 4)));
      await as(owner, () => publishOrRequest({ workflowId: id, action: 'publish', by: owner.id }));
      expect((await production(id)).status).toBe('success');
    });

    it('a member publishing an owner’s version is refused: the publisher must be an owner or admin', async () => {
      const id = await fresh('wf_v_member_pub', false);
      await as(alice, () => publishOrRequest({ workflowId: id, action: 'publish', by: alice.id }));
      const run = await production(id);
      expect(run.status).toBe('error');
      expect(run.error?.message).toMatch(/^A member published the version/);
    });

    it('an admin restoring a member’s version credits it to the member: still refused', async () => {
      const id = await fresh('wf_v_restore');
      as(alice, () => store.saveWorkflow(graph(id, 5)));
      const aliceVersion = listVersions(id)[0];
      as(owner, () => store.saveWorkflow(graph(id, 3)));
      const { POST } = await import('@/app/api/workflows/[id]/versions/[versionId]/restore/route');
      const response = await POST(new Request(`http://localhost/api/workflows/${id}/versions/${aliceVersion.id}/restore`, { method: 'POST' }), { params: Promise.resolve({ id, versionId: aliceVersion.id }) });
      expect(response.status).toBe(200);
      const restored = listVersions(id)[0];
      expect(restored.restoredFrom?.id).toBe(aliceVersion.id);
      expect(versionAuthor(id, restored.id)).toBe(alice.id);
      expect((await draftRun(id)).status).toBe('error');
      // Moving, activating or publishing it adds no version and credits nobody new.
      await as(owner, () => publishOrRequest({ workflowId: id, action: 'publish', by: owner.id }));
      expect(listVersions(id)[0].id).toBe(restored.id);
      expect((await production(id)).status).toBe('error');
      expect(rowsFor(bob.id)).toHaveLength(0);
    });

    it('C: a save with no person behind it makes a version with no author, and the nightly run is refused', async () => {
      const id = await fresh('wf_v_c', false);
      withAuth({}, () => store.saveWorkflow({ ...store.getWorkflow(id)!, ...graph(id, 0) }));
      const version = listVersions(id)[0];
      expect(versionAuthor(id, version.id)).toBeUndefined();
      expect(store.getWorkflow(id)!.updatedBy).toBeUndefined();
      expect((await draftRun(id)).status).toBe('error');
      // A pin added with no person behind it changes no version, and records nobody as the last saver.
      as(owner, () => store.saveWorkflow(graph(id, 3)));
      withAuth({}, () => store.saveWorkflow({ ...store.getWorkflow(id)!, pinData: { people: [{ json: { userId: idle.id, day: '2020-01-04' } }] } }));
      expect(store.getWorkflow(id)!.updatedBy).toBeUndefined();
      expect(versionAuthor(id, listVersions(id)[0].id)).toBe(owner.id);
      expect(rowsFor(bob.id)).toHaveLength(0);
    });

    it('C: applying a suggestion saves as the person who applies it, never as the last saver or the request around it', async () => {
      const id = await fresh('wf_v_apply', false);
      const suggest = (fingerprint: string, withinDays: number) =>
        upsertProposal({ source: 'workflow', fingerprint, target: { type: 'workflow', id }, title: 'Everyone, every night', why: 'so nobody is missed', evidence: [], ops: [{ op: 'setParameters', node: 'List People', parameters: { withinDays } }], risk: 'low', confidence: 0.5, score: 1 } as never)!;
      // A Slack click: no signed-in request, nobody named (or someone Slack could not match).
      withAuth({}, () => applyProposal(suggest('apply-nobody', 0).id, {}));
      expect(versionAuthor(id, listVersions(id)[0].id)).toBeUndefined();
      expect((await draftRun(id)).status).toBe('error');
      // A member's apply inside an owner's request is still hers.
      as(owner, () => applyProposal(suggest('apply-alice', 1).id, { actorId: alice.id }));
      expect(versionAuthor(id, listVersions(id)[0].id)).toBe(alice.id);
      expect((await draftRun(id)).status).toBe('error');
      // The owner's own apply makes an owner's version.
      applyProposal(suggest('apply-owner', 2).id, { actorId: owner.id });
      expect(versionAuthor(id, listVersions(id)[0].id)).toBe(owner.id);
      expect((await draftRun(id)).status).toBe('success');
    });

    it('a body’s createdBy and updatedBy are ignored: the saver is who saved it', () => {
      const saved = as(alice, () => store.saveWorkflow({ ...graph('wf_v_body', 3), createdBy: owner.id, updatedBy: owner.id }));
      expect(saved).toMatchObject({ createdBy: alice.id, updatedBy: alice.id });
      expect(withAuth({}, () => store.saveWorkflow({ ...graph('wf_v_body_nobody', 3), createdBy: owner.id, updatedBy: owner.id }))).not.toHaveProperty('createdBy');
    });

    it('pinned data is ignored on a schedule: a member’s pin on List People picks no one', async () => {
      const id = await fresh('wf_v_pin');
      as(alice, () => store.saveWorkflow({ ...store.getWorkflow(id)!, pinData: { people: [{ json: { userId: idle.id, day: '2020-01-06' } }] } }));
      expect(listVersions(id)).toHaveLength(1);
      const run = await draftRun(id);
      expect(run.status).toBe('success');
      expect(idleRows()).toHaveLength(0);
      expect(rowsFor(bob.id, 'ready')).toHaveLength(1);
    });

    it('a member’s pin upstream refuses an owner’s manual run (pins apply there), and the schedule still runs', async () => {
      const id = await fresh('wf_v_pin_manual');
      // A pin-only save: no version, so the version check alone would pass.
      as(alice, () => store.saveWorkflow({ ...store.getWorkflow(id)!, pinData: { people: [{ json: { userId: idle.id, day: '2020-01-07' } }] } }));
      expect(listVersions(id)).toHaveLength(1);
      const manual = await as(owner, () => runWorkflow({ workflow: store.getWorkflow(id)!, mode: 'manual', startNodeId: 'nightly', triggerItems: items({}) }));
      expect(manual.startedBy).toBe(owner.id);
      expect(manual.status).toBe('error');
      expect(manual.error?.message).toMatch(/^Pin data on this node or a node before it/);
      // Pins the owner's own editor run carries (an unsaved draft) refuse too: pins are test data.
      const draft = { ...store.getWorkflow(id)!, pinData: undefined };
      const own = await as(owner, () => runWorkflow({ workflow: { ...draft, pinData: { gather: [{ json: { userId: idle.id, day: '2020-01-08', briefingId: 'x' } }] } }, mode: 'manual', startNodeId: 'nightly', triggerItems: items({}) }));
      expect(own.status).toBe('error');
      expect(idleRows()).toHaveLength(0);
      // The schedule ignores pins (no denial of the nightly run by pinning).
      expect((await draftRun(id)).status).toBe('success');
      // Pins removed, the owner's manual run works.
      as(owner, () => store.saveWorkflow({ ...store.getWorkflow(id)!, pinData: undefined }));
      expect((await as(owner, () => runWorkflow({ workflow: store.getWorkflow(id)!, mode: 'manual', startNodeId: 'nightly', triggerItems: items({}) }))).status).toBe('success');
    });

    it('an agent’s tool call runs for its caller: not for the owner whose request is around it', async () => {
      const id = await fresh('wf_v_tool', false);
      const tool = (extra: Record<string, unknown> = {}) => runWorkflow({ workflow: store.getWorkflow(id)!, mode: 'tool', startNodeId: 'gather', triggerItems: items({ userId: bob.id, day: today() }), ...extra });
      const inOwnersContext = await as(owner, () => new Promise<Awaited<ReturnType<typeof tool>>>((resolve) => setTimeout(() => resolve(tool()), 0)));
      expect(inOwnersContext.startedBy).toBeUndefined();
      expect(inOwnersContext.status).toBe('error');
      // Called from a run of Alice's: refused; from the nightly run: it may.
      const hers = await as(alice, () => runWorkflow({ workflow: store.getWorkflow(id)!, mode: 'mcp', startNodeId: 'nightly', triggerItems: items({}) }));
      expect((await tool({ parent: { executionId: hers.executionId } })).status).toBe('error');
      expect(rowsFor(bob.id)).toHaveLength(0);
      const nightly = await draftRun(id);
      expect(nightly.status).toBe('success');
      const called = await tool({ parent: { executionId: nightly.executionId } });
      expect(called.error?.message).toBeUndefined();
      expect(called.status).toBe('success');
    });

    it('an error workflow’s run is checked through the run that failed', async () => {
      const id = await fresh('wf_v_error', false);
      const answer = (failedId: string) => runWorkflow({ workflow: store.getWorkflow(id)!, mode: 'trigger', startNodeId: 'nightly', triggerItems: items({}), errorOf: failedId });
      const hers = await as(alice, () => runWorkflow({ workflow: store.getWorkflow(id)!, mode: 'mcp', startNodeId: 'nightly', triggerItems: items({}) }));
      expect((await answer(hers.executionId)).status).toBe('error');
      expect((await answer('ex_made_up')).status).toBe('error');
      expect(rowsFor(bob.id)).toHaveLength(0);
      const nightly = await draftRun(id);
      expect((await answer(nightly.executionId)).status).toBe('success');
    });

    it('what a request only sets off (a decision’s listening workflows) runs as nobody', async () => {
      const seen = await as(owner, () => outsideRequest(() => new Promise<string | undefined>((resolve) => setTimeout(() => resolve(currentActorId()), 0))));
      expect(seen).toBeUndefined();
      expect(as(owner, () => currentActorId())).toBe(owner.id);
    });

    it('a metric’s measurement run is refused: whoever wrote the suggestion chose the workflow', async () => {
      const id = await fresh('wf_v_metric', false);
      const run = await runWorkflow({ workflow: store.getWorkflow(id)!, mode: 'trigger', startNodeId: 'nightly', triggerItems: items({}), metricOf: 'pr_x' });
      expect(run.metricOf).toBe('pr_x');
      expect(run.status).toBe('error');
      expect(rowsFor(bob.id)).toHaveLength(0);
    });
  });
});

describe('what MCP carries of a stored briefing', () => {
  it('names a colleague only in the quoted prompt, not in the markdown of the tool and resources', () => {
    const d = createDraft({ userId: alice.id, day: '2026-11-14', gathered: { own: [], related: [], finished: [] } });
    writeText(d.id, alice.id, 'Ben worked on something related: Invoice export.', 'deterministic');
    markReady(d.id, alice.id);
    const served = briefingFor(actorOf(alice), { day: '2026-11-14' });
    expect(served.source).toBe('flow');
    expect(briefingMarkdown(served)).not.toContain('Ben');
    expect(briefingText(served)).toContain('> Ben worked on something related');
  });
});

describe('delivery', () => {
  it('sends nothing when the person chose none', async () => {
    recordWork(actorOf(alice), [work('a1')]);
    const sent: unknown[] = [];
    setMailTransport({ send: async (m) => void sent.push(m) });
    await sync();
    expect(slackCalls).toEqual([]);
    expect(sent).toEqual([]);
  });

  it('with LANDFLOW_BRIEFING_SLACK_TOKEN set, looks up and DMs someone who chose Slack with that token, and emails someone who chose email', async () => {
    recordWork(actorOf(alice), [work('a1', { title: 'Fix the invoice export' })]);
    recordWork(actorOf(bob), [work('b1', { title: 'Billing retries' })]);
    setPreferences(alice.id, { briefingDelivery: 'slack' });
    setPreferences(bob.id, { briefingDelivery: 'email' });
    const sent: Array<{ to: string; text: string }> = [];
    setMailTransport({ send: async (m) => void sent.push(m) });
    const result = await sync();
    expect(slackCalls.map((c) => c.url)).toEqual(['/users.lookupByEmail?email=alice%40sync.test', '/chat.postMessage']);
    expect(slackCalls.map((c) => c.auth)).toEqual([`Bearer ${SERVER_TOKEN}`, `Bearer ${SERVER_TOKEN}`]);
    expect(slackCalls[1].body).toContain('U0ALICE1');
    expect(sent.map((m) => m.to)).toEqual(['bob@sync.test']);
    const out = result.runData.deliver.at(-1)!.outputs[0].map((i) => i.json);
    expect(out.map((j) => j.channel).sort()).toEqual(['email', 'slack']);
    expect(out.every((j) => j.warning === undefined)).toBe(true);
    // The token never reaches the run data or its log.
    expect(JSON.stringify(result.runData)).not.toContain(SERVER_TOKEN);
  });

  it('with no token, Slack is skipped with a warning naming the server setting, and email still goes', async () => {
    recordWork(actorOf(alice), [work('a1')]);
    recordWork(actorOf(bob), [work('b1')]);
    setPreferences(alice.id, { briefingDelivery: 'slack' });
    setPreferences(bob.id, { briefingDelivery: 'email' });
    const sent: Array<{ to: string }> = [];
    setMailTransport({ send: async (m) => void sent.push(m) });
    const result = await withoutSlackToken(() => sync());
    expect(result.status).toBe('success');
    expect(slackCalls).toEqual([]);
    expect(sent.map((m) => m.to)).toEqual(['bob@sync.test']);
    const deliver = result.runData.deliver.at(-1)!;
    const alices = deliver.outputs[0].find((i) => i.json.userId === alice.id)!.json;
    expect(alices).toMatchObject({ delivered: false, warning: expect.stringMatching(/^Slack delivery skipped: .*An admin sets LANDFLOW_BRIEFING_SLACK_TOKEN .*on the server.*email delivery goes on/) });
    expect(deliver.outputs[0].find((i) => i.json.userId === bob.id)!.json).toMatchObject({ delivered: true, channel: 'email' });
    expect(JSON.stringify(deliver.logs)).toContain('Slack delivery skipped');
  });

  it('with no token and nobody choosing Slack, nothing warns', async () => {
    recordWork(actorOf(alice), [work('a1')]);
    const result = await withoutSlackToken(() => sync());
    const deliver = result.runData.deliver.at(-1)!;
    expect(deliver.outputs[0][0].json.warning).toBeUndefined();
    expect(JSON.stringify(deliver.logs ?? [])).not.toContain('Slack delivery skipped');
  });
});

describe('a Slack credential on Deliver Briefing in a saved graph is ignored', () => {
  type AnyUser = typeof owner;
  const as = <T,>(user: AnyUser, fn: () => T): T => withAuth({ principal: { user, via: 'test' } }, fn);
  /** Call a route as `user` (the suite's synthetic owner again afterwards). */
  const patch = async (user: AnyUser, id: string, body: Record<string, unknown>) => {
    enableTestAuth(user);
    try {
      return await credentialRoute.PATCH(new Request(`http://landflow.test/api/credentials/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });
    } finally {
      enableTestAuth();
    }
  };
  /** A server of a member's own that records what reaches it. */
  const memberServer = async () => {
    const got: string[] = [];
    const server = createServer((request, response) => {
      got.push(`${request.url} ${request.headers.authorization}`);
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ ok: true, user: { id: 'UEVIL' }, ts: '1.1' }));
    });
    const url = await new Promise<string>((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`)));
    return { got, url, close: () => server.close() };
  };
  /** The nightly workflow with `refs` on Deliver Briefing, saved and published by the owner in the team. */
  const ready = async (id: string, refs: Record<string, { id: string; name: string }>) => {
    as(owner, () => store.saveWorkflow({ ...template.workflow, id, nodes: template.workflow.nodes.map((n) => (n.id === 'deliver' ? { ...n, credentials: refs } : n)) }));
    setHomeProject('workflow', id, team.id);
    await as(owner, () => publishOrRequest({ workflowId: id, action: 'publish', by: owner.id }));
  };
  const production = (id: string) => runWorkflow({ workflow: productionWorkflowById(id)!, mode: 'trigger', startNodeId: 'nightly', triggerItems: items({}) });
  const mail: Array<{ to: string }> = [];
  beforeEach(() => {
    mail.length = 0;
    setMailTransport({ send: async (m) => void mail.push(m) });
    recordWork(actorOf(bob), [work('b1', { title: 'PRIVATE-BOB diary' })]);
    recordWork(actorOf(alice), [work('a1', { title: 'Alice’s own work' })]);
    setPreferences(bob.id, { briefingDelivery: 'slack' });
    setPreferences(alice.id, { briefingDelivery: 'email' });
  });

  it('N1: a member puts her own workspace’s token in the credential and an owner then changes another field: her token is never used; the server’s bot delivers', async () => {
    const key = vault.create({ name: 'Team Slack', type: 'messaging.slackApi', data: { accessToken: 'xoxb-dev-only-owner', baseUrl: slackUrl } }, { actor: owner.id });
    setHomeProject('credential', key.id, team.id);
    await ready('wf_ignored_n1', { 'messaging.slackApi': { id: key.id, name: key.name } });
    expect((await patch(alice, key.id, { data: { accessToken: 'xoxb-dev-only-alice' } })).status).toBe(200);
    // The owner edits a different field: the vault now names the owner as the last changer.
    expect((await patch(owner, key.id, { data: { baseUrl: `${slackUrl}/` } })).status).toBe(200);
    expect(vault.lastChangedBy(key.id)).toBe(owner.id);
    const run = await production('wf_ignored_n1');
    expect(run.error?.message).toBeUndefined();
    expect(run.status).toBe('success');
    expect(slackCalls.map((c) => [c.url, c.auth])).toEqual([
      ['/users.lookupByEmail?email=bob%40sync.test', `Bearer ${SERVER_TOKEN}`],
      ['/chat.postMessage', `Bearer ${SERVER_TOKEN}`],
    ]);
    expect(mail.map((m) => m.to)).toEqual(['alice@sync.test']);
    // With no server token, the credential is no fallback: Slack is skipped and email goes on.
    slackCalls.length = 0;
    mail.length = 0;
    const skipped = await withoutSlackToken(() => production('wf_ignored_n1'));
    expect(skipped.status).toBe('success');
    expect(slackCalls).toEqual([]);
    expect(mail.map((m) => m.to)).toEqual(['alice@sync.test']);
  });

  it('N2: an OAuth2 credential a member pointed at her own server and connected to her app, then an owner edited: nothing reaches her server', async () => {
    const evil = await memberServer();
    try {
      const oauth = vault.create({ name: 'Team Slack OAuth2', type: 'messaging.slackOAuth2Api', data: { grantType: 'clientCredentials', clientId: 'client-1', clientSecret: 'secret-1', accessTokenUrl: `${evil.url}/token`, baseUrl: slackUrl } }, { actor: owner.id });
      setHomeProject('credential', oauth.id, team.id);
      await ready('wf_ignored_n2', { 'messaging.slackOAuth2Api': { id: oauth.id, name: oauth.name } });
      expect((await patch(alice, oauth.id, { data: { clientId: 'ALICEAPP', baseUrl: evil.url } })).status).toBe(200);
      vault.saveOAuth2Token(oauth.id, { access_token: 'xoxb-dev-only-alice-oauth', token_type: 'bearer' } as never, undefined, { actor: alice.id });
      expect((await patch(owner, oauth.id, { data: { scope: 'chat:write' } })).status).toBe(200);
      expect(vault.lastChangedBy(oauth.id)).toBe(owner.id);
      const run = await production('wf_ignored_n2');
      expect(run.error?.message).toBeUndefined();
      expect(run.status).toBe('success');
      expect(evil.got).toEqual([]);
      expect(slackCalls.map((c) => c.auth)).toEqual([`Bearer ${SERVER_TOKEN}`, `Bearer ${SERVER_TOKEN}`]);
      // Nor with no server token.
      await withoutSlackToken(() => production('wf_ignored_n2'));
      expect(evil.got).toEqual([]);
    } finally {
      evil.close();
    }
  });

  it('a reference to a deleted credential, or one the project can’t use, does not fail the run', async () => {
    const elsewhere = vault.create({ name: 'Someone else’s Slack', type: 'messaging.slackApi', data: { accessToken: 'xoxb-dev-only-x', baseUrl: slackUrl } }, { actor: owner.id });
    await ready('wf_ignored_gone', { 'messaging.slackApi': { id: 'cred_deleted', name: 'Gone' }, 'messaging.slackOAuth2Api': { id: elsewhere.id, name: elsewhere.name } });
    const run = await production('wf_ignored_gone');
    expect(run.error?.message).toBeUndefined();
    expect(run.status).toBe('success');
    expect(slackCalls.filter((c) => c.url === '/chat.postMessage')).toHaveLength(1);
  });
});

describe('the store and the text', () => {
  const gathered: GatheredWork = {
    own: [
      { id: '1', sourceId: 'p1', source: 'github', kind: 'work.pr_merged', title: 'Add retries', repo: 'acme/billing', at: '2026-11-13T10:00:00Z', visibility: 'private' },
      { id: '2', sourceId: 'p2', source: 'github', kind: 'work.pr_merged', title: 'Fix totals', repo: 'acme/billing', at: '2026-11-13T11:00:00Z', visibility: 'private' },
    ],
    related: [{ person: { name: 'Ben' }, items: [{ id: '3', sourceId: 'x', source: 'github', kind: 'work.pr_merged', title: 'Invoice export', repo: 'acme/billing', at: '2026-11-13T12:00:00Z', visibility: 'team' }], because: { type: 'repo', name: 'acme/billing' } }],
    finished: [{ id: '4', sourceId: 'y', source: 'github', kind: 'work.release', title: 'Release 4.2', repo: 'acme/billing', at: '2026-11-13T13:00:00Z', visibility: 'org' }],
  };

  it('deterministicBriefing reads the lists for fixed data', () => {
    expect(deterministicBriefing(gathered, 1200)).toBe(['Recently you merged 2 PRs in acme/billing.', 'Ben worked on something related (repo: acme/billing): Invoice export.', 'Finished in acme/billing: Release 4.2.'].join('\n'));
    expect(deterministicBriefing({ own: [], related: [], finished: [] })).toBe('Nothing of yours was recorded in the last two days.');
    expect(deterministicBriefing(gathered, 60).length).toBeLessThanOrEqual(60);
  });

  it('writeBriefingText uses a working model, redacts what it is given, cuts to the limit, and falls back when it fails', async () => {
    let prompt = '';
    const model = { provider: 'fake', model: 'm', generate: async (input: { messages: Array<{ content: unknown }> }) => ((prompt = String(input.messages[0].content)), { text: 'x'.repeat(5000) }) };
    const withEmail = { ...gathered, own: [{ ...gathered.own[0], title: 'Mailed bob@sync.test about it' }] };
    const written = await writeBriefingText(withEmail, model as never);
    expect(written.model).toBe('fake/m');
    expect(written.text.length).toBeLessThanOrEqual(1200);
    expect(prompt).toContain('<work>');
    expect(prompt).not.toContain('bob@sync.test');
    const broken = { provider: 'fake', model: 'm', generate: async () => Promise.reject(new Error('down')) };
    expect((await writeBriefingText(gathered, broken as never)).model).toBe('deterministic');
  });

  it('markReady supersedes, one person cannot read another’s draft, and old briefings are pruned', () => {
    const a = createDraft({ userId: alice.id, day: '2026-11-14', gathered });
    expect(writeText(a.id, bob.id, 'nope', 'm')).toBeUndefined();
    writeText(a.id, alice.id, 'one', 'm');
    expect(markReady(a.id, bob.id)).toBeUndefined();
    markReady(a.id, alice.id);
    const b = createDraft({ userId: alice.id, day: '2026-11-14', gathered });
    writeText(b.id, alice.id, 'two', 'm');
    markReady(b.id, alice.id);
    expect(latestReady(alice.id, '2026-11-14')?.text).toBe('two');
    expect(pruneBriefings(database(), Date.now() + 31 * 86_400_000)).toBe(2);
  });
});
