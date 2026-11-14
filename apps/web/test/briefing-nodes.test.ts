/**
 * The tomorrow sync (docs/work-and-briefings.md#the-nightly-sync): the template's workflow run in process over seeded people
 * and work, the briefing store, the deterministic text, what is served, and delivery that is opt-in. No model, a fake Slack.
 */
import { createServer, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
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

registry.registerBuiltin(corePlugin);
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
const slackCalls: Array<{ url: string; body: string }> = [];
const slackUrl = await new Promise<string>((resolve) => {
  slack = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      slackCalls.push({ url: request.url ?? '', body });
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(request.url?.startsWith('/users.lookupByEmail') ? { ok: true, user: { id: 'U0ALICE1' } } : { ok: true, ts: '1.1' }));
    });
  }).listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(slack.address() as { port: number }).port}`));
});

afterAll(() => {
  slack.close();
  setMailTransport(undefined);
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();
const work = (sourceId: string, patch: Record<string, unknown> = {}) => ({ kind: 'work.session', source: 'claude-code', sourceId, occurredAt: minutesAgo(1), title: `Work ${sourceId}`, ...patch });

async function sync(options: { credentials?: Record<string, unknown>; workflowId?: string } = {}) {
  const workflow = { ...template.workflow, id: options.workflowId ?? 'wf_sync', nodes: template.workflow.nodes.map((n) => (n.id === 'deliver' && options.credentials ? { ...n, credentials: {} } : n)) };
  return executeWorkflow({
    workflow,
    resolver,
    executionId: `ex_${Math.random().toString(36).slice(2)}`,
    mode: 'manual',
    startNodeId: 'nightly',
    triggerItems: items({}),
    resolveCredentials: (node) => (node.id === 'deliver' ? (options.credentials as never) : undefined),
  });
}

const rowsFor = (userId: string, status?: string) => database().all<{ id: string; status: string; text: string; model: string; gathered: string; day: string }>(`SELECT * FROM brain_briefings WHERE user_id = ?${status ? ` AND status = '${status}'` : ''} ORDER BY created_at`, userId);

// The nodes run only in a workflow that an owner or admin made, or that nobody made: a seeded one, and one a member made.
store.saveWorkflow({ ...template.workflow, id: 'wf_sync' });
store.saveWorkflow({ ...template.workflow, id: 'wf_member', createdBy: alice.id });

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
  it('a member’s workflow gathers, saves and delivers nothing, even with their own Slack credential', async () => {
    recordWork(actorOf(alice), [work('a1')]);
    recordWork(actorOf(bob), [work('b1')]);
    setPreferences(bob.id, { briefingDelivery: 'slack' });
    const result = await sync({ workflowId: 'wf_member', credentials: { 'messaging.slackApi': { accessToken: 'xoxb-dev-only', baseUrl: slackUrl } } });
    expect(result.status).not.toBe('success');
    expect(rowsFor(alice.id)).toHaveLength(0);
    expect(rowsFor(bob.id)).toHaveLength(0);
    expect(slackCalls).toEqual([]);
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
  const credentials = { 'messaging.slackApi': { accessToken: 'xoxb-dev-only', baseUrl: slackUrl } };

  it('sends nothing when the person chose none', async () => {
    recordWork(actorOf(alice), [work('a1')]);
    const sent: unknown[] = [];
    setMailTransport({ send: async (m) => void sent.push(m) });
    await sync({ credentials });
    expect(slackCalls).toEqual([]);
    expect(sent).toEqual([]);
  });

  it('sends a Slack message to someone who chose Slack, and an email to someone who chose email', async () => {
    recordWork(actorOf(alice), [work('a1', { title: 'Fix the invoice export' })]);
    recordWork(actorOf(bob), [work('b1', { title: 'Billing retries' })]);
    setPreferences(alice.id, { briefingDelivery: 'slack' });
    setPreferences(bob.id, { briefingDelivery: 'email' });
    const sent: Array<{ to: string; text: string }> = [];
    setMailTransport({ send: async (m) => void sent.push(m) });
    const result = await sync({ credentials });
    expect(slackCalls.map((c) => c.url)).toEqual(['/users.lookupByEmail?email=alice%40sync.test', '/chat.postMessage']);
    expect(slackCalls[1].body).toContain('U0ALICE1');
    expect(sent.map((m) => m.to)).toEqual(['bob@sync.test']);
    const out = result.runData.deliver.at(-1)!.outputs[0].map((i) => i.json.channel).sort();
    expect(out).toEqual(['email', 'slack']);
  });

  it('passes the item on undelivered when the chosen channel is not set up', async () => {
    recordWork(actorOf(alice), [work('a1')]);
    setPreferences(alice.id, { briefingDelivery: 'slack' });
    const result = await sync();
    expect(result.runData.deliver.at(-1)!.outputs[0][0].json.delivered).toBe(false);
    expect(slackCalls).toEqual([]);
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
