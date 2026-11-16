/**
 * The first draft's guards (lib/server/assistant/draft-guards.ts): made-up channels, tables and ids cleared and listed,
 * one trigger, no empty Set, a credential listed per step that needs one; and the build route applying a workflow's
 * allowed node types.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { NodeTypeInfo } from '@/lib/shared/types';
import { startFakeModels } from './fake-ai-services';

let answer = '{}';
const fake = await startFakeModels({ reply: () => ({ text: answer }) });
const ENV = { LANDFLOW_DATA_DIR: mkdtempSync(join(tmpdir(), 'landflow-draft-guards-')), LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', OLLAMA_URL: fake.url.replace(/\/v1$/, '') };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { guardDraft } = await import('@/lib/server/assistant/draft-guards');
const buildRoute = await import('@/app/api/ai/build/route');
const workflowsRoute = await import('@/app/api/workflows/route');
const policyRoute = await import('@/app/api/workflows/[id]/policy/route');
registry.registerBuiltin(corePlugin);

afterAll(async () => {
  await fake.close();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

type Draft = Parameters<typeof guardDraft>[0];
const info = (type: string, kind: 'trigger' | 'action', extra: { triggerSource?: string; credentials?: Array<{ name: string; required?: boolean }>; pluginName?: string } = {}): NodeTypeInfo =>
  ({ type, pluginId: type.split('.')[0], pluginName: extra.pluginName ?? 'Core', language: 'ts', transport: 'http', available: true, descriptor: { name: type, displayName: type, description: '', version: 1, kind, triggerSource: extra.triggerSource, inputs: [], outputs: [], properties: [], credentials: extra.credentials } }) as unknown as NodeTypeInfo;
const TYPES = new Map<string, NodeTypeInfo>([
  ['core.manualTrigger', info('core.manualTrigger', 'trigger', { triggerSource: 'manual' })],
  ['core.schedule', info('core.schedule', 'trigger', { triggerSource: 'schedule' })],
  ['core.set', info('core.set', 'action')],
  ['messaging.slack', info('messaging.slack', 'action', { credentials: [{ name: 'slackApi', required: true }], pluginName: 'Slack' })],
  ['linear.issues', info('linear.issues', 'action', { credentials: [{ name: 'linearApi', required: true }], pluginName: 'Linear' })],
  ['core.table', info('core.table', 'action')],
  ['core.httpRequest', info('core.httpRequest', 'action')],
]);
const byType = (t: string) => TYPES.get(t);
const node = (key: string, type: string, name: string, parameters?: Record<string, unknown>) => ({ key, type, name, x: 0, y: 0, ...(parameters && { parameters }) });
const draftOf = (nodes: Draft['nodes'], edges: Draft['edges']): Draft => ({ name: 'D', nodes, edges, model: 'm', durationMs: 1, dropped: [] });
const ctx = (prompt: string) => ({ prompt, known: prompt, byType });
const main = (a: string, b: string): Draft['edges'][number] => [a, b, 0, 'main'];

describe('made-up values in a first draft', () => {
  // The evaluation's B1 draft: a channel, a table and a team nobody named.
  const b1 = () =>
    draftOf(
      [
        node('t', 'core.schedule', 'Every morning'),
        node('bugs', 'linear.issues', 'Get bugs', { teamId: 'ENG', state: 'open' }),
        node('slack', 'messaging.slack', 'Post to Slack', { channel: '#bugs', text: '{{ $json.title }}' }),
        node('save', 'core.table', 'Save bug', { table: 'bugs', operation: 'insert' }),
      ],
      [main('t', 'bugs'), main('bugs', 'slack'), main('slack', 'save')],
    );

  it('clears the channel, the table and the team id, and lists them', () => {
    const out = guardDraft(b1(), ctx('Every morning, get the new bugs and post a summary to Slack, and save each bug to a table'));
    const by = (name: string) => out.nodes.find((n) => n.name === name)!.parameters!;
    expect(by('Get bugs')).toEqual({ state: 'open' });
    expect(by('Post to Slack')).toEqual({ text: '{{ $json.title }}' });
    expect(by('Save bug')).toEqual({ operation: 'insert' });
    const madeUp = out.left!.filter((l) => l.kind === 'made-up');
    expect(madeUp.map((l) => `${l.node}.${l.field}`).sort()).toEqual(['Get bugs.teamId', 'Post to Slack.channel', 'Save bug.table']);
    expect(madeUp.find((l) => l.field === 'channel')!.text).toContain('#bugs');
    expect(out.left!.filter((l) => l.kind === 'credential').map((l) => l.node).sort()).toEqual(['Get bugs', 'Post to Slack']);
    expect(JSON.stringify(out.left)).not.toMatch(/cred_|credentialId/);
  });

  it('keeps a channel the prompt names and expressions', () => {
    const d = draftOf([node('t', 'core.manualTrigger', 'Run'), node('slack', 'messaging.slack', 'Post', { channel: '#triage' }), node('s2', 'messaging.slack', 'Post 2', { channel: '{{ $json.channel }}' })], [main('t', 'slack'), main('slack', 's2')]);
    const out = guardDraft(d, ctx('post to #triage'));
    expect(out.nodes[1].parameters).toEqual({ channel: '#triage' });
    expect(out.nodes[2].parameters).toEqual({ channel: '{{ $json.channel }}' });
    expect(out.left!.some((l) => l.kind === 'made-up')).toBe(false);
  });

  it('clears a URL whose host nobody gave', () => {
    const d = draftOf([node('t', 'core.manualTrigger', 'Run'), node('h', 'core.httpRequest', 'Notify', { url: 'https://httpbin.org/post' })], [main('t', 'h')]);
    const out = guardDraft(d, ctx('post the result to http://127.0.0.1:3403/vip'));
    expect(out.nodes[1].parameters).toEqual({});
    expect(out.left!.find((l) => l.kind === 'made-up')!.text).toContain('url');
  });
});

describe('credentials, with the real core types', () => {
  const real = (t: string) => registry.nodeTypes().find((i) => i.type === t);
  const agent = (parameters?: Record<string, unknown>) => draftOf([node('t', 'core.manualTrigger', 'Run'), node('a', 'core.aiAgent', 'Agent', parameters)], [main('t', 'a')]);
  const run = (d: Draft) => guardDraft(d, { prompt: 'run an agent', known: 'run an agent', byType: real, credentialName: (n) => (/slack/i.test(n) ? 'Slack API' : undefined) });

  it('lists none for an AI Agent step with default parameters', () => {
    expect(real('core.aiAgent')).toBeDefined();
    expect(run(agent()).left?.filter((l) => l.kind === 'credential') ?? []).toEqual([]);
  });

  it('lists the Slack credential when the agent asks in Slack, by its type name', () => {
    const left = run(agent({ approvalChannel: 'slack', requireApproval: 'all' })).left!.filter((l) => l.kind === 'credential');
    expect(left).toHaveLength(1);
    expect(left[0].text).toContain('Slack');
    expect(left[0].text).not.toContain('Landflow Core');
  });
});

describe('a removed step’s leftovers', () => {
  it('drops what the builder left for a trigger this guard removed, and wires every step the kept trigger did not feed', () => {
    const d = { ...draftOf([node('m', 'core.manualTrigger', 'Run'), node('s', 'core.schedule', 'Every morning'), node('a', 'core.httpRequest', 'A'), node('b', 'core.httpRequest', 'B'), node('c', 'core.httpRequest', 'C')], [main('m', 'a'), main('a', 'b'), main('s', 'c')]), left: [{ node: 'Run', kind: 'empty' as const, text: 'Run is empty' }] };
    const out = guardDraft(d as Draft, ctx('every morning'));
    expect(out.left!.some((l) => l.kind === 'empty')).toBe(false);
    expect(out.edges).toContainEqual(main('s', 'a'));
    expect(out.edges).toContainEqual(main('s', 'c'));
  });
});

describe('one trigger', () => {
  const two = () => draftOf([node('m', 'core.manualTrigger', 'Run'), node('s', 'core.schedule', 'Every morning'), node('a', 'core.httpRequest', 'Fetch')], [main('m', 'a'), main('s', 'a')]);

  it('keeps the schedule the prompt names and drops the manual trigger with its edges', () => {
    const out = guardDraft({ ...two(), pinData: { m: [{ json: { q: 1 } }] } }, ctx('every morning, fetch the page'));
    expect(out.nodes.map((n) => n.key)).toEqual(['s', 'a']);
    expect(out.edges).toEqual([main('s', 'a')]);
    expect(out.left!.filter((l) => l.kind === 'dropped')).toHaveLength(1);
    // A schedule's own item is only a time: the manual trigger's pin is not moved onto it.
    expect(Object.keys(out.pinData ?? {})).toEqual([]);
  });

  it('moves the pin of the dropped trigger to a kept one that holds a pin (a manual trigger), and not to a schedule', () => {
    const out = guardDraft({ ...two(), pinData: { s: [{ json: { q: 1 } }] } }, ctx('run it by hand, fetch the page'));
    expect(out.nodes.map((n) => n.key)).toEqual(['m', 'a']);
    expect(Object.keys(out.pinData ?? {})).toEqual(['m']);
  });

  it('keeps the first when the prompt names none, wiring its steps', () => {
    const d = draftOf([node('m', 'core.manualTrigger', 'Run'), node('s', 'core.schedule', 'Timer'), node('a', 'core.httpRequest', 'Fetch')], [main('s', 'a')]);
    const out = guardDraft(d, ctx('fetch the page'));
    expect(out.nodes.map((n) => n.key)).toEqual(['m', 'a']);
    expect(out.edges).toEqual([main('m', 'a')]);
  });
});

describe('an empty Set', () => {
  const flow = (reader: Record<string, unknown>) =>
    draftOf([node('t', 'core.manualTrigger', 'Run'), node('set', 'core.set', 'Prepare', { mode: 'manual', fields: { values: [] } }), node('h', 'core.httpRequest', 'Send', reader)], [main('t', 'set'), main('set', 'h')]);

  it('is removed when nothing reads it, and its neighbours are joined', () => {
    const out = guardDraft(flow({ method: 'GET' }), ctx('send it'));
    expect(out.nodes.map((n) => n.key)).toEqual(['t', 'h']);
    expect(out.edges).toEqual([main('t', 'h')]);
    expect(out.left!.find((l) => l.node === 'Prepare')!.kind).toBe('dropped');
  });

  it('stays when a later step reads it', () => {
    const out = guardDraft(flow({ body: "{{ $('Prepare').item.json.id }}" }), ctx('send it'));
    expect(out.nodes.map((n) => n.key)).toEqual(['t', 'set', 'h']);
  });
});

describe('POST /api/ai/build', () => {
  const reply = JSON.stringify({ name: 'D', nodes: [{ key: 'start', type: 'core.manualTrigger', name: 'Start' }, { key: 'set', type: 'core.set', name: 'Edit', parameters: { mode: 'manual', fields: { values: [{ name: 'a', type: 'string', value: 'x' }] } } }], connections: [{ from: 'start', to: 'set' }] });
  const post = (json: unknown) => buildRoute.POST(new Request('http://localhost/api/ai/build', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(json) }));

  it('offers a workflow’s allowed types only, and leaves the others out', async () => {
    const created = await workflowsRoute.POST(new Request('http://localhost/api/workflows', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'W', nodes: [], connections: [] }) }));
    const id = ((await created.json()) as { workflow: { id: string } }).workflow.id;
    const saved = await policyRoute.PUT(new Request(`http://localhost/api/workflows/${id}/policy`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nodes: { mode: 'allow', types: ['core.manualTrigger'] } }) }), { params: Promise.resolve({ id }) });
    expect(saved.status).toBe(200);

    answer = reply;
    const limited = (await (await post({ prompt: 'copy the fields', workflowId: id })).json()) as { draft: { nodes: Array<{ type: string }>; left?: Array<{ kind: string }> } };
    expect(limited.draft.nodes.map((n) => n.type)).toEqual(['core.manualTrigger']);
    expect(limited.draft.left?.some((l) => l.kind === 'dropped')).toBe(true);
    expect(JSON.stringify(fake.last('/api/chat')?.body)).not.toContain('- core.set —');

    const open = (await (await post({ prompt: 'copy the fields' })).json()) as { draft: { nodes: Array<{ type: string }> } };
    expect(open.draft.nodes.map((n) => n.type)).toEqual(['core.manualTrigger', 'core.set']);
    expect(JSON.stringify(fake.last('/api/chat')?.body)).toContain('- core.set —');
  });
});
