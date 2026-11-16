/**
 * SB05: a new agent survives a send-back. Its name counts as proposed only once its proposal is held, "after X" places it
 * after X, `newAgent` carries the tools and documents it needs, and Spotlight's request to the architect names them.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { LanguageModel, ModelTurn, Workflow } from '@landflow/engine';
import { newAgentSpec } from '@/lib/shared/assistant-ops';
import type { NodeTypeInfo } from '@/lib/shared/types';
import { corePlugin } from '@/lib/server/nodes';
import { registry } from '@/lib/server/plugins/registry';
import { runChat, type ChatEvent } from '@/lib/server/assistant/chat';
import { asNewAgents, placedAsAsked, withoutAgentStandIns } from '@/lib/server/assistant/guards';
import { designBrief, designRequest } from '@/lib/server/assistant/architect';

let types: NodeTypeInfo[];
beforeAll(() => {
  registry.registerBuiltin(corePlugin);
  types = registry.nodeTypes().filter((t) => t.pluginId === 'core');
});

const flow = (): Workflow => ({
  id: 'wf',
  name: 'Sample',
  nodes: [
    { id: 'a', name: 'Start', type: 'core.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
    { id: 'b', name: 'Sample question', type: 'core.set', typeVersion: 1, position: [200, 0], parameters: {} },
    { id: 'c', name: 'Reply', type: 'core.noOp', typeVersion: 1, position: [400, 0], parameters: {} },
  ],
  connections: [
    { id: 'k1', source: 'a', target: 'b', sourceIndex: 0, targetIndex: 0, type: 'main' },
    { id: 'k2', source: 'b', target: 'c', sourceIndex: 0, targetIndex: 0, type: 'main' },
  ],
});

function scripted(turns: Array<Partial<ModelTurn>>) {
  const model: LanguageModel = {
    provider: 'test',
    model: 'scripted',
    async generate() {
      const next = turns.shift();
      if (!next) throw new Error('No scripted turn left');
      return { text: '', toolCalls: [], stopReason: 'stop', ...next };
    },
  };
  return model;
}
const propose = (id: string, ops: unknown[]): Partial<ModelTurn> => ({ toolCalls: [{ id, name: 'propose_changes', input: { summary: 'A docs agent', ops } }] });

async function ask(message: string, turns: Array<Partial<ModelTurn>>) {
  const events: ChatEvent[] = [];
  await runChat({ messages: [{ role: 'user', content: message }], workflow: flow(), model: scripted(turns), types, onEvent: (e) => events.push(e) });
  return events.filter((e): e is Extract<ChatEvent, { type: 'proposal' }> => e.type === 'proposal');
}

const agentOp = { op: 'newAgent', ref: 'docs', name: 'Docs Answerer', description: 'Answers from the docs', instructions: 'Answer from the docs.', tools: ['Linear: read issues'], knowledge: 'our docs', after: 'Sample question' };

describe('a new agent survives a send-back', () => {
  it('keeps a newAgent when its first proposal is sent back for a connection to a node never added', async () => {
    const proposals = await ask('add an agent after Sample question that answers from our docs', [
      propose('c1', [agentOp, { op: 'connect', from: 'ghost', to: 'Reply' }]),
      propose('c2', [agentOp]),
      { text: 'Adds the Docs Answerer agent.' },
    ]);
    expect(proposals).toHaveLength(1);
    expect(proposals[0].ops[0]).toMatchObject({ op: 'addNode', name: 'Docs Answerer', newAgent: { name: 'Docs Answerer' } });
  });

  it('keeps an AI Agent turned into a new agent when the first try is sent back for a dangling node', async () => {
    const ai = { op: 'addNode', ref: 'docs', type: 'core.aiAgent', name: 'Docs Answerer', parameters: { systemMessage: 'Answer from the docs. Be short.' }, after: 'Sample question' };
    const proposals = await ask('add an agent after Sample question that answers from our docs', [
      propose('c1', [ai, { op: 'addNode', ref: 'x', type: 'core.noOp', name: 'Loose end' }]),
      propose('c2', [ai]),
      { text: 'Adds the Docs Answerer agent.' },
    ]);
    expect(proposals).toHaveLength(1);
    expect(JSON.stringify(proposals[0].ops)).toContain('Docs Answerer');
    expect(JSON.stringify(proposals[0].ops)).toContain('newAgent');
  });
});

describe('placedAsAsked', () => {
  const names = ['Start', 'Sample question', 'Reply'];
  it('puts an agent after the step the message says "after"', () => {
    const { ops } = placedAsAsked([{ op: 'newAgent', name: 'Docs', before: 'Reply' }], 'add an agent after Sample question that answers from our docs', names) as { ops: Array<Record<string, unknown>> };
    expect(ops[0]).toMatchObject({ after: 'Sample question' });
    expect(ops[0]).not.toHaveProperty('before');
  });
  it('does the same for the addNode a newAgent became', () => {
    const { ops } = placedAsAsked([{ op: 'addNode', type: 'core.messageAgent', name: 'Docs', before: 'Reply', newAgent: { name: 'Docs' } }], 'Add an agent AFTER "Sample question"', names) as { ops: Array<Record<string, unknown>> };
    expect(ops[0]).toMatchObject({ after: 'Sample question' });
    expect(ops[0]).not.toHaveProperty('before');
  });
  it('keeps "before" when the message says before, or the op has an after already', () => {
    const before = [{ op: 'newAgent', name: 'Docs', before: 'Reply' }];
    expect((placedAsAsked(before, 'add an agent before Reply', names) as { ops: unknown[] }).ops).toEqual(before);
    const both = [{ op: 'newAgent', name: 'Docs', before: 'Reply', after: 'Start' }];
    expect((placedAsAsked(both, 'add an agent after Sample question', names) as { ops: unknown[] }).ops).toEqual(both);
  });
  it('leaves it alone when the step named is not in the flow', () => {
    const ops = [{ op: 'newAgent', name: 'Docs', before: 'Reply' }];
    expect((placedAsAsked(ops, 'add an agent after Nowhere', names) as { ops: unknown[] }).ops).toEqual(ops);
  });
});

describe('newAgent carries tools and knowledge', () => {
  it('keeps them within limits', () => {
    const spec = newAgentSpec({ name: 'A', tools: Array.from({ length: 12 }, (_, i) => `Tool ${i} ${'x'.repeat(100)}`), knowledge: 'k'.repeat(300) })!;
    expect(spec.tools).toHaveLength(8);
    expect(spec.tools!.every((t) => t.length <= 80)).toBe(true);
    expect(spec.knowledge).toHaveLength(200);
    expect(newAgentSpec({ name: 'A', tools: 'nope', knowledge: 5 })).not.toHaveProperty('tools');
  });
  it('is converted from an AI Agent with its tools', () => {
    const ops = [
      { op: 'addNode', ref: 'ag', type: 'core.aiAgent', name: 'Helper', parameters: { systemMessage: 'Help.' } },
      { op: 'addNode', ref: 't', type: 'linear.issues', name: 'Linear issues', after: 'ag' },
      { op: 'connect', from: 't', to: 'ag', type: 'ai_tool' },
    ];
    const out = asNewAgents(ops, () => undefined).ops as Array<Record<string, unknown>>;
    expect(out[0]).toMatchObject({ op: 'newAgent', tools: ['Linear issues'] });
    expect(withoutAgentStandIns(out, new Set(['helper'])).ops).toBeTruthy();
  });
  it('the architect request names both and still asks for no questions', () => {
    const request = designRequest({ name: 'Docs', description: 'd', instructions: 'i', tools: ['Linear: read issues'], knowledge: 'our docs' });
    expect(request).toContain('It needs: Linear: read issues.');
    expect(request).toContain('It answers from: our docs');
    expect(request).toContain('list_knowledge_bases');
    expect(request).toContain('without asking me anything');
  });
  it('ranks the node types matching the tool hints first', () => {
    const brief = designBrief({ name: 'Docs', description: 'Answers questions', instructions: '', tools: ['Set: assign fields'] }, { types, resources: undefined });
    const line = brief.split('\n').find((l) => l.startsWith('Nodes that matched'));
    expect(line).toBeTruthy();
    expect(line!.replace('Nodes that matched the request (most are probably not needed): ', '').startsWith('core.set')).toBe(true);
  });
});
