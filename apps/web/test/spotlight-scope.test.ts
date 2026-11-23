/**
 * SB07: the scope of a change (lib/shared/spotlight-scope.ts, docs/assistant.md#the-builder-chat): `scopeOf`, `outsideScope`, and the
 * chat that sends a change outside it back once and then leaves it out. Models are scripted fakes.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { LanguageModel, ModelTurn, Workflow } from '@landflow/engine';
import type { NodeTypeInfo } from '@/lib/shared/types';
import type { GenerateInput } from '@/lib/server/nodes/models';
import { outsideScope, scopeLabel, scopeOf, type ScopeNode } from '@/lib/shared/spotlight-scope';

Object.assign(process.env, { LANDFLOW_DATA_DIR: mkdtempSync(join(tmpdir(), 'landflow-scope-')), LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' });

const { corePlugin } = await import('@/lib/server/nodes');
const { registry } = await import('@/lib/server/plugins/registry');
const { runChat } = await import('@/lib/server/assistant/chat');
const chatRoute = await import('@/app/api/assistant/chat/route');
import type { ChatEvent } from '@/lib/server/assistant/chat';

let types: NodeTypeInfo[];
beforeAll(() => {
  registry.registerBuiltin(corePlugin);
  types = registry.nodeTypes().filter((t) => t.pluginId === 'core');
});

const node = (id: string, name: string, type: string, x: number, parameters: Record<string, unknown> = {}) => ({ id, name, type, typeVersion: 1, position: [x, 0] as [number, number], parameters });
const flow = (): Workflow => ({
  id: 'wf_scope',
  name: 'Bug triage',
  nodes: [
    node('t', 'Start', 'core.manualTrigger', 0),
    node('http', 'Open status incident', 'core.httpRequest', 280, { method: 'POST', url: 'http://127.0.0.1:3399/secure' }),
    node('save', 'Save to backlog', 'core.set', 560, { mode: 'json', json: '{}' }),
  ],
  connections: [
    { id: 'e1', type: 'main', source: 't', sourceIndex: 0, target: 'http', targetIndex: 0 },
    { id: 'e2', type: 'main', source: 'http', sourceIndex: 0, target: 'save', targetIndex: 0 },
  ],
});
const nodes: ScopeNode[] = flow().nodes.map((n) => ({ id: n.id, name: n.name }));
const graph = { nodes, connections: flow().connections };

describe('scopeOf', () => {
  it('has none when the person lifted the chip', () => {
    expect(scopeOf({ sent: null, message: 'only Open status incident', nodes, selectedId: 'http' })).toBeUndefined();
  });
  it('keeps the sent scope with the ids that exist, none when none do', () => {
    expect(scopeOf({ sent: { kind: 'only', nodes: ['http', 'gone'] }, message: 'x', nodes })).toEqual({ kind: 'only', nodes: ['http'] });
    expect(scopeOf({ sent: { kind: 'selected', nodes: ['gone'] }, message: 'x', nodes })).toBeUndefined();
    expect(scopeOf({ sent: { kind: 'insert', nodes: ['http'] }, message: 'x', nodes })).toEqual({ kind: 'insert', nodes: ['http'], side: 'after' });
  });
  it('reads "only" with names, and "only that one node" with a selection', () => {
    expect(scopeOf({ message: 'only Open status incident: retry 3 times', nodes })).toEqual({ kind: 'only', nodes: ['http'] });
    expect(scopeOf({ message: 'only that one node: retry 3 times', nodes, selectedId: 'http' })).toEqual({ kind: 'only', nodes: ['http'] });
    expect(scopeOf({ message: 'only that one node: retry 3 times', nodes })).toBeUndefined();
  });
  it('makes the tagged steps the scope', () => {
    expect(scopeOf({ message: 'tidy these', nodes, taggedIds: ['http', 'save', 'gone'] })).toEqual({ kind: 'tagged', nodes: ['http', 'save'] });
  });
  it('puts a new step where it was asked, after or before', () => {
    expect(scopeOf({ message: 'add an agent after “Open status incident” that reviews it', nodes })).toEqual({ kind: 'insert', nodes: ['http'], side: 'after' });
    expect(scopeOf({ message: 'insert a Set before Save to backlog', nodes, selectedId: 'http' })).toEqual({ kind: 'insert', nodes: ['save'], side: 'before' });
  });
  it('takes the selected step when the message names no other and adds none', () => {
    expect(scopeOf({ message: 'this HTTP step fails with 401, fix it', nodes, selectedId: 'http' })).toEqual({ kind: 'selected', nodes: ['http'] });
    expect(scopeOf({ message: 'also change Save to backlog', nodes, selectedId: 'http' })).toBeUndefined();
    expect(scopeOf({ message: 'add a retry step', nodes, selectedId: 'http' })).toBeUndefined();
    expect(scopeOf({ message: 'fix it', nodes })).toBeUndefined();
  });
  it('reads the next step without an adding verb as an insert, and still scopes a plain fix to the selection', () => {
    expect(scopeOf({ message: 'Remove duplicate items after Open status incident', nodes, selectedId: 'http' })).toEqual({ kind: 'insert', nodes: ['http'], side: 'after' });
    expect(scopeOf({ message: 'filter out empty rows after this', nodes, selectedId: 'http' })).toEqual({ kind: 'insert', nodes: ['http'], side: 'after' });
    for (const m of ['then email the team', 'filter out empty rows here', 'use an If to check the status', 'send a Slack message', 'follow with a Set']) {
      expect(scopeOf({ message: m, nodes, selectedId: 'http' }), m).toBeUndefined();
    }
    expect(scopeOf({ message: 'fix the 401 on this step', nodes, selectedId: 'http' })).toEqual({ kind: 'selected', nodes: ['http'] });
  });
  it('reads "after X" that only locates a step as no insert', () => {
    expect(scopeOf({ message: 'The step after Open status incident fails with 401, fix it', nodes })).toBeUndefined();
    expect(scopeOf({ message: 'the call after Start returns 401', nodes, selectedId: 'http' })).toBeUndefined();
    expect(scopeOf({ message: 'it breaks right after this, fix the URL', nodes, selectedId: 'http' })).toEqual({ kind: 'selected', nodes: ['http'] });
    expect(scopeOf({ message: 'Remove duplicate items after Open status incident', nodes })).toEqual({ kind: 'insert', nodes: ['http'], side: 'after' });
  });
  it('gives no selected scope when the message names a neighbour of the selection by position (SB07-O1)', () => {
    for (const m of ['the step after this fails with 401, fix it', 'the node after this is wrong', 'what comes after this returns 500, fix it', 'The step after Start fails with 401, fix it']) {
      expect(scopeOf({ message: m, nodes, selectedId: 'http' }), m).toBeUndefined();
    }
  });
  it('names a neighbour by "previous", "following" and "the one after", and keeps selected for everyday before/after phrases (SB07-O1 round 2)', () => {
    for (const m of ['the previous step is wrong, fix it', 'the following step fails, fix it', 'the one after this fails, fix it']) {
      expect(scopeOf({ message: m, nodes, selectedId: 'http' }), m).toBeUndefined();
    }
    for (const m of ['fix this one before I run it', 'retry this call before giving up', 'make this request before 9am', 'change this step before the demo tomorrow', 'it breaks right after this, fix the URL', 'set the timeout to 30s']) {
      expect(scopeOf({ message: m, nodes, selectedId: 'http' }), m).toEqual({ kind: 'selected', nodes: ['http'] });
    }
  });
  it('does not read a step named with a common verb as an add', () => {
    const named = [...nodes, { id: 'slack', name: 'Post to Slack' }];
    expect(scopeOf({ message: 'Post to Slack fails with 401, fix it', nodes: named, selectedId: 'slack' })).toEqual({ kind: 'selected', nodes: ['slack'] });
    expect(scopeOf({ message: 'use a different URL', nodes, selectedId: 'http' })).toEqual({ kind: 'selected', nodes: ['http'] });
  });
  it("an insert is dropped when the message names another step too", () => {
    expect(scopeOf({ message: "Remove the Save to backlog step, then add a new Set after Open status incident", nodes })).toBeUndefined();
  });
  it('words the chip', () => {
    expect(scopeLabel({ kind: 'only', nodes: ['http'] }, nodes)).toBe('Only “Open status incident”');
    expect(scopeLabel({ kind: 'insert', nodes: ['http'], side: 'after' }, nodes)).toBe('New step after “Open status incident”');
  });
});

describe('outsideScope', () => {
  const selected = { kind: 'selected' as const, nodes: ['http'] };
  it('puts an added step after the selected one outside when the message adds nothing', () => {
    const out = outsideScope([{ op: 'addNode', name: 'Extra', after: 'Open status incident' }, { op: 'setParameters', node: 'Open status incident' }], selected, graph, 'fix the 401');
    expect(out.map((o) => o.index)).toEqual([0]);
    expect(out[0].reason).toContain('outside what was asked');
  });
  it('puts a rewire to a step added outside the scope outside too', () => {
    const ops = [{ op: 'addNode', ref: 'n', name: 'Extra', after: 'Save to backlog' }, { op: 'connect', from: 'n', to: 'Open status incident' }];
    expect(outsideScope(ops, { kind: 'selected', nodes: ['http'] }, graph, 'add a step').map((o) => o.index)).toEqual([0, 1]);
  });
  it('lets a new step between the anchor and the step it fed, under insert', () => {
    const insert = { kind: 'insert' as const, nodes: ['http'], side: 'after' as const };
    const ops = [
      { op: 'addNode', ref: 'n1', name: 'Agent', after: 'Open status incident' },
      { op: 'disconnect', from: 'Open status incident', to: 'Save to backlog' },
      { op: 'connect', from: 'n1', to: 'Save to backlog' },
    ];
    expect(outsideScope(ops, insert, graph, 'add an agent after Open status incident')).toEqual([]);
    expect(outsideScope([{ op: 'setParameters', node: 'Save to backlog' }], insert, graph, 'add an agent after Open status incident')).toHaveLength(1);
  });
  it('lets a new step after a scope step take over the next step, under every kind', () => {
    const ops = [{ op: 'addNode', ref: 'n', name: 'Retry', after: 'Open status incident' }, { op: 'connect', from: 'n', to: 'Save to backlog' }];
    expect(outsideScope(ops, { kind: 'selected', nodes: ['http'] }, graph, 'add a retry step')).toEqual([]);
  });
  it('puts other steps outside, and workflow settings under every kind but the selection', () => {
    expect(outsideScope([{ op: 'setWorkflowSettings' }], selected, graph, 'stop the workflow if it runs longer than 5 minutes')).toEqual([]);
    for (const scope of [{ kind: 'only' as const, nodes: ['http'] }, { kind: 'tagged' as const, nodes: ['http'] }, { kind: 'insert' as const, nodes: ['http'], side: 'after' as const }]) {
      expect(outsideScope([{ op: 'setWorkflowSettings' }], scope, graph, 'x')).toHaveLength(1);
    }
    expect(outsideScope([{ op: 'setNodeSettings', node: 'Save to backlog' }], selected, graph, 'x')).toHaveLength(1);
    expect(outsideScope([{ op: 'setNodeSettings', node: 'Open status incident' }], selected, graph, 'x')).toEqual([]);
  });
});

describe('the chat', () => {
  function scripted(turns: Array<Partial<ModelTurn>>) {
    const calls: GenerateInput[] = [];
    const model: LanguageModel = {
      provider: 'test',
      model: 'scripted',
      async generate(input) {
        calls.push({ ...input, messages: [...input.messages] });
        const next = turns.shift();
        if (!next) throw new Error('No scripted turn left');
        return { text: '', toolCalls: [], stopReason: 'stop', ...next };
      },
    };
    return { model, calls };
  }
  const wander = [
    { op: 'setNodeSettings', node: 'Open status incident', settings: { maxTries: 3, retryOnFail: true } },
    { op: 'addNode', ref: 'x', type: 'core.set', name: 'Extra', after: 'Open status incident' },
    // A setting SB09's checks accept (continue-on-error nobody asked for is sent back on its own), so only the scope decides.
    { op: 'setNodeSettings', node: 'Save to backlog', settings: { timeoutSeconds: 30 } },
  ];
  const propose = (id: string, ops: unknown[]): Partial<ModelTurn> => ({ toolCalls: [{ id, name: 'propose_changes', input: { summary: 'Fix', ops } }] });
  const run = async (turns: Array<Partial<ModelTurn>>, extra: Partial<Parameters<typeof runChat>[0]> = {}) => {
    const { model, calls } = scripted(turns);
    const events: ChatEvent[] = [];
    await runChat({ messages: [{ role: 'user', content: 'this HTTP step fails with 401, fix it' }], workflow: flow(), selectedNodeId: 'http', model, types, onEvent: (e) => events.push(e), ...extra });
    return { calls, events, proposals: events.filter((e) => e.type === 'proposal') as Array<Extract<ChatEvent, { type: 'proposal' }>> };
  };
  const lastResult = (calls: GenerateInput[], at: number) => (calls[at].messages.at(-1) as { results: Array<{ content: string }> }).results[0].content;

  it('sends a change outside the selected step back once, then leaves the rest out and lists it', async () => {
    const { calls, proposals } = await run([propose('c1', wander), propose('c2', wander.slice(0, 2).concat([{ ...wander[2], settings: { onError: 'stop' } }])), { text: 'Done.' }]);
    expect(lastResult(calls, 1)).toContain('Not shown:');
    expect(lastResult(calls, 1)).toContain('The scope of this request is: Only “Open status incident”');
    expect(proposals).toHaveLength(1);
    expect(proposals[0].ops).toEqual([wander[0]]);
    expect(proposals[0].dropped.filter((d) => d.startsWith('Left out')).length).toBe(2);
    expect(calls[0].system).toContain('Scope: Only “Open status incident”');
  });

  it('keeps a fix to the selected step when the message only locates it by position', async () => {
    const fix = [{ op: 'setParameters', node: 'Open status incident', parameters: { url: 'http://127.0.0.1:3399/ok' } }];
    const { proposals } = await run([propose('c1', fix), { text: 'Done.' }], { messages: [{ role: 'user', content: 'it breaks right after this, fix the URL' }] });
    expect(proposals).toHaveLength(1);
    expect(proposals[0].ops).toEqual(fix);
  });

  it('keeps a fix to the next step when the message locates it from the selection (SB07-O1)', async () => {
    const fix = [{ op: 'setParameters', node: 'Save to backlog', parameters: { json: '{"a":1}' } }];
    const { calls, proposals } = await run([propose('c1', fix), { text: 'Done.' }], { messages: [{ role: 'user', content: 'the step after this fails with 401, fix it' }] });
    expect(proposals).toHaveLength(1);
    expect(proposals[0].ops).toEqual(fix);
    expect(calls[0].system).not.toContain('Scope:');
  });

  it('shows the whole proposal when the chip was lifted (scope: null)', async () => {
    const { calls, proposals } = await run([propose('c1', wander), { text: 'Done.' }], { scope: null });
    expect(proposals).toHaveLength(1);
    expect(proposals[0].ops).toHaveLength(3);
    expect(calls[0].system).not.toContain('Scope:');
  });

  it('applies no scope to a test-and-fix session', async () => {
    const { proposals } = await run([propose('c1', wander), { text: 'Done.' }], { session: 'fix' });
    expect(proposals).toHaveLength(1);
    expect(proposals[0].ops).toHaveLength(3);
    expect(proposals.flatMap((p) => p.dropped).filter((d) => d.startsWith('Left out'))).toEqual([]);
  });

  it('says so when every change was outside', async () => {
    const outside = [{ op: 'setNodeSettings', node: 'Save to backlog', settings: { onError: 'continue' } }];
    const { calls, proposals } = await run([propose('c1', outside), propose('c2', [{ op: 'setNodeSettings', node: 'Save to backlog', settings: { onError: 'stop' } }]), { text: 'Nothing changed.' }]);
    expect(proposals).toHaveLength(0);
    expect(lastResult(calls, 2)).toContain('every change was outside what was asked');
  });

  it('the route refuses a scope kind outside the enum', async () => {
    const send = (scope: unknown) => chatRoute.POST(new Request('http://localhost/api/assistant/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'x' }], workflow: { name: 'W', nodes: [], connections: [] }, scope }) }));
    expect((await send({ kind: 'everything', nodes: [] })).status).toBe(400);
    expect((await send({ kind: 'only', nodes: Array.from({ length: 21 }, (_, i) => `n${i}`) })).status).toBe(400);
  });
});

describe('final live run: a change to the flow’s one agent while another step is selected', () => {
  it('is in scope when the ask names the agent (its name or the word agent) and the flow has exactly one Run an Agent step', async () => {
    const { agentChangeInScope } = await import('@/lib/server/assistant/chat');
    const nodes = [{ id: 'post', name: 'Post to Reports', type: 'core.httpRequest' }, { id: 'digest', name: 'Digest', type: 'core.messageAgent' }];
    const selected = { kind: 'selected' as const, nodes: ['post'] };
    const ask = 'Give the digest access to the sales database.';
    expect(agentChangeInScope({ op: 'changeAgent', node: 'Digest' }, selected, nodes, ask)).toBe(true);
    expect(agentChangeInScope({ op: 'changeAgent' }, selected, nodes, ask)).toBe(true);
    expect(agentChangeInScope({ op: 'changeAgent', node: 'Digest' }, selected, nodes, 'Make it shorter.')).toBe(false);
    expect(agentChangeInScope({ op: 'changeAgent', node: 'Digest' }, selected, nodes, 'Give the agent access to the sales database.')).toBe(true);
    // "step" or "node" alone name no agent: the old rule holds.
    expect(agentChangeInScope({ op: 'changeAgent', node: 'Digest' }, selected, nodes, 'add a database step')).toBe(false);
    expect(agentChangeInScope({ op: 'changeAgent' }, selected, nodes, 'Wire a database into this node.')).toBe(true); // one step in scope: the old rule
    expect(agentChangeInScope({ op: 'changeAgent', node: 'Digest' }, selected, [...nodes, { id: 'two', name: 'Second', type: 'core.messageAgent' }], ask)).toBe(false);
    expect(agentChangeInScope({ op: 'changeAgent', node: 'Digest' }, { kind: 'insert', nodes: ['post'] }, nodes, ask)).toBe(false);
  });
});

describe('wave ag4 carryover (E3): a change to the selected step’s agent', () => {
  it('is in scope for that step (or none named with one in scope), not for another step’s agent or an insert', async () => {
    const { agentChangeInScope } = await import('@/lib/server/assistant/chat');
    const selected = { kind: 'selected' as const, nodes: ['http'] };
    const out = outsideScope([{ op: 'changeAgent', node: 'Open status incident' }], selected, graph, 'Wire a Sentiment tool into this step.');
    expect(out).toHaveLength(1); // the contract's filter alone sends it back; chat.ts keeps it
    expect(agentChangeInScope({ op: 'changeAgent', node: 'Open status incident' }, selected, graph.nodes)).toBe(true);
    expect(agentChangeInScope({ op: 'changeAgent' }, selected, graph.nodes)).toBe(true);
    expect(agentChangeInScope({ op: 'changeAgent', node: 'Save to backlog' }, selected, graph.nodes)).toBe(false);
    expect(agentChangeInScope({ op: 'changeAgent', node: 'Open status incident' }, { kind: 'insert', nodes: ['http'] }, graph.nodes)).toBe(false);
    expect(agentChangeInScope({ op: 'setParameters', node: 'Open status incident' }, selected, graph.nodes)).toBe(false);
  });
});
