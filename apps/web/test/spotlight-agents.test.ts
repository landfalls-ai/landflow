/**
 * Spotlight and the agents the caller has (docs/assistant.md#agents-and-teams): it is told the published agents, runs one
 * that fits with Run an Agent (its name becomes its id, a made-up id never gets through), and, when none fits, proposes a
 * dedicated agent with `newAgent`, which the editor saves as a draft when the change is applied.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { LanguageModel, ModelTurn, Workflow } from '@landflow/engine';
import { agentBrief, describeAgents, withAgentId, type AgentBrief } from '@/lib/shared/agent-brief';
import type { Agent } from '@/lib/shared/agents';
import { applyOps, describeOps, parseOps } from '@/lib/shared/assistant-ops';
import { planOf } from '@/lib/shared/build-steps';
import type { NodeTypeInfo } from '@/lib/shared/types';
import type { GenerateInput } from '@/lib/server/nodes/models';
import { corePlugin } from '@/lib/server/nodes';
import { registry } from '@/lib/server/plugins/registry';
import { asNewAgents, runChat, withAgentIds, withoutAgentStandIns, type ChatEvent } from '@/lib/server/assistant/chat';
import { registryLookup } from '@/lib/server/assistant/ops';

let types: NodeTypeInfo[];
beforeAll(() => {
  registry.registerBuiltin(corePlugin);
  types = registry.nodeTypes().filter((t) => t.pluginId === 'core');
});

const config = (extra: Partial<Agent> = {}) =>
  ({
    name: 'Support triage',
    description: 'Reads a support ticket, finds the customer and routes it to the right team',
    icon: 'bot',
    color: '#000000',
    instructions: 'Triage tickets.',
    skills: [{ id: 's1', name: 'Route a ticket', whenToUse: 'Use when a ticket needs an owner', instructions: '…' }],
    tools: [
      { id: 't1', type: 'node', name: 'search_crm', description: 'Find a customer', nodeType: 'attio.record', parameters: {} },
      { id: 't2', type: 'agent', agentId: 'ag_writer' },
    ],
    schedules: [],
    channels: [],
    memory: { crossSession: false },
    settings: {},
    persona: { role: 'Support lead' },
    ...extra,
  }) as unknown as Agent;

const agent = (id: string, extra: Partial<Agent> = {}, published = true): Agent => {
  const c = config(extra);
  return { ...c, id, createdAt: '', updatedAt: '', history: [], ...(published && { published: { version: 3, publishedAt: '', config: c } }) } as Agent;
};

const briefs: AgentBrief[] = [
  { id: 'ag_triage', name: 'Support triage', description: 'Routes support tickets', version: 3, skills: [], tools: [] },
  { id: 'ag_release', name: 'Release notes writer', version: 1, skills: [], tools: [] },
];

describe('agent briefs', () => {
  it('reads a published agent: what it does, its role, skills and tools, and the agents it asks by name', () => {
    const brief = agentBrief(agent('ag_triage'), (id) => (id === 'ag_writer' ? 'Writer' : undefined))!;
    expect(brief).toEqual({
      id: 'ag_triage',
      name: 'Support triage',
      description: 'Reads a support ticket, finds the customer and routes it to the right team',
      role: 'Support lead',
      version: 3,
      skills: ['Route a ticket (Use when a ticket needs an owner)'],
      tools: ['search_crm', 'asks Writer'],
    });
    expect(describeAgents([brief])).toBe(
      '- “Support triage” (agentId ag_triage, v3): Reads a support ticket, finds the customer and routes it to the right team Role: Support lead. Skills: Route a ticket (Use when a ticket needs an owner). Tools: search_crm, asks Writer.',
    );
  });

  it('leaves out an agent never published, and falls back to the persona’s mission', () => {
    expect(agentBrief(agent('ag_draft', {}, false))).toBeUndefined();
    expect(agentBrief(agent('ag_m', { description: '', persona: { mission: 'Keeps the docs current' } } as Partial<Agent>))?.description).toBe('Keeps the docs current');
  });

  it('turns the agent name a model writes into its id, and leaves anything else as written', () => {
    expect(withAgentId({ agentId: 'support triage agent', message: 'x' }, briefs)).toEqual({ agentId: 'ag_triage', message: 'x' });
    expect(withAgentId({ agentId: 'ag_release' }, briefs)).toEqual({ agentId: 'ag_release' });
    expect(withAgentId({ agentId: 'Billing bot' }, briefs)).toEqual({ agentId: 'Billing bot' });
    expect(withAgentId({ agentId: '{{ $json.agent }}' }, briefs)).toEqual({ agentId: '{{ $json.agent }}' });
  });
});

describe('newAgent', () => {
  const flow = (): Workflow => ({
    id: 'wf',
    name: 'Flow',
    nodes: [{ id: 'a', name: 'Start', type: 'core.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} }],
    connections: [],
  });
  const spec = { name: 'Contract reviewer', description: 'Reviews vendor contracts for risky clauses', instructions: 'Read the contract and list risky clauses.' };

  it('is a Run an Agent node that carries the agent to save, wired like any added node', () => {
    const { ops } = parseOps([{ op: 'newAgent', ref: 'rev', ...spec, parameters: { message: '{{ $json.text }}', agentId: 'made_up' }, after: 'Start' }]);
    expect(ops).toEqual([{ op: 'addNode', type: 'core.messageAgent', name: 'Contract reviewer', newAgent: spec, ref: 'rev', parameters: { message: '{{ $json.text }}', agentId: 'made_up' }, after: 'Start' }]);
    // An addNode of Run an Agent with a newAgent is the same thing.
    expect(parseOps([{ op: 'addNode', type: 'core.messageAgent', name: 'Reviewer', newAgent: spec }]).ops[0]).toMatchObject({ newAgent: spec });

    const result = applyOps(flow(), withAgentIds(ops, briefs) as typeof ops, registryLookup(types), { newId: () => 'x' });
    const node = result.workflow.nodes.find((n) => n.type === 'core.messageAgent')!;
    expect(node.name).toBe('Contract reviewer');
    // The editor sets the agent once it is saved: no id the model wrote gets on the node.
    expect(node.parameters.agentId).toBe('');
    expect(result.applied[0]).toMatchObject({ op: 'addNode', newAgent: spec, after: 'Start' });
    expect(describeOps(result.applied)[0].text).toBe('new agent “Contract reviewer” (saved as a draft) and a Run an Agent step for it after “Start” · Reviews vendor contracts for risky clauses');
    expect(planOf(flow(), result.applied, registryLookup(types)).steps[0].title).toBe('Create the agent Contract reviewer');
  });

  it('needs a name', () => {
    expect(parseOps([{ op: 'newAgent', description: 'x' }]).ops).toEqual([]);
  });
});

/** A LanguageModel that answers from a script and records what it was asked. */
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

describe('Spotlight with agents', () => {
  const flow = (): Workflow => ({
    id: 'wf',
    name: 'Tickets',
    nodes: [{ id: 'a', name: 'New ticket', type: 'core.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} }],
    connections: [],
  });

  it('is told the published agents, and runs the one that fits by its id', async () => {
    const { model, calls } = scripted([
      { toolCalls: [{ id: 'c1', name: 'propose_changes', input: { summary: 'Triage', ops: [{ op: 'addNode', type: 'core.messageAgent', name: 'Triage', parameters: { agentId: 'Support triage', message: '{{ $json.text }}' }, after: 'New ticket' }] } }] },
      { text: 'Support triage already routes tickets, so the flow runs it.' },
    ]);
    const events: ChatEvent[] = [];
    await runChat({ messages: [{ role: 'user', content: 'Route each new ticket to the right team' }], workflow: flow(), model, types, agents: briefs, onEvent: (e) => events.push(e) });
    expect(calls[0].system).toContain('Your agents (Run an Agent can run these; none of them may fit):\n- “Support triage” (agentId ag_triage, v3): Routes support tickets');
    expect(calls[0].system).toContain('propose {"op":"newAgent"');
    const proposal = events.find((e) => e.type === 'proposal') as Extract<ChatEvent, { type: 'proposal' }>;
    expect(proposal.ops[0]).toMatchObject({ op: 'addNode', type: 'core.messageAgent', parameters: { agentId: 'ag_triage' } });
  });

  it('says so when there are none, and a newAgent proposal reaches the editor whole', async () => {
    const { model, calls } = scripted([
      {
        toolCalls: [
          {
            id: 'c1',
            name: 'propose_changes',
            input: { summary: 'A contract reviewer', ops: [{ op: 'newAgent', ref: 'rev', name: 'Contract reviewer', description: 'Reviews vendor contracts', instructions: 'List risky clauses.', parameters: { message: '{{ $json.text }}' }, after: 'New ticket' }] },
          },
        ],
      },
      { text: 'None of your agents reviews contracts, so this adds a Contract reviewer agent.' },
    ]);
    const events: ChatEvent[] = [];
    await runChat({ messages: [{ role: 'user', content: 'Review each vendor contract for risky clauses' }], workflow: flow(), model, types, onEvent: (e) => events.push(e) });
    expect(calls[0].system).toContain('Your agents: none published yet.');
    const proposal = events.find((e) => e.type === 'proposal') as Extract<ChatEvent, { type: 'proposal' }>;
    expect(proposal.ops[0]).toMatchObject({ op: 'addNode', type: 'core.messageAgent', name: 'Contract reviewer', newAgent: { name: 'Contract reviewer', description: 'Reviews vendor contracts', instructions: 'List risky clauses.' } });
  });

  it('leaves out an AI Agent or a chat model for the new agent’s job, proposed after it (as a local model did live)', async () => {
    const kindOf = (type: string) => types.find((t) => t.type === type)?.descriptor.kind;
    const names = new Set(['legal clause reviewer']);
    const { ops, notes } = withoutAgentStandIns(
      [
        { op: 'addNode', ref: 'r2', type: 'core.aiAgent', name: 'Legal Clause Reviewer 2', after: 'New ticket' },
        { op: 'connect', from: 'r2', to: 'Triage' },
        { op: 'addNode', type: 'core.ollamaChatModel', name: 'Model', after: 'Legal Clause Reviewer' },
        { op: 'addNode', type: 'core.set', name: 'Tidy', after: 'Triage' },
      ],
      names,
      kindOf,
    );
    expect(ops).toEqual([{ op: 'addNode', type: 'core.set', name: 'Tidy', after: 'Triage' }]);
    expect(notes).toEqual(['“Legal Clause Reviewer 2” does the new agent\'s job: its Run an Agent step already runs it', "nothing attaches to the new agent's step: it runs with the agent's own model and tools"]);

    const { model, calls } = scripted([
      { toolCalls: [{ id: 'c1', name: 'propose_changes', input: { summary: 'Reviewer', ops: [{ op: 'newAgent', name: 'Legal Clause Reviewer', description: 'Reviews contracts', instructions: 'Flag risky clauses.', after: 'New ticket' }] } }] },
      { toolCalls: [{ id: 'c2', name: 'propose_changes', input: { summary: 'Again', ops: [{ op: 'addNode', type: 'core.aiAgent', name: 'Legal Clause Reviewer 2', after: 'New ticket' }] } }] },
      { text: 'Added a Legal Clause Reviewer agent.' },
    ]);
    const events: ChatEvent[] = [];
    await runChat({ messages: [{ role: 'user', content: 'Have a specialist review contracts first' }], workflow: flow(), model, types, onEvent: (e) => events.push(e) });
    expect(events.filter((e) => e.type === 'proposal')).toHaveLength(1);
    expect((calls[2].messages.at(-1) as { results: Array<{ content: string }> }).results[0].content).toContain('does the new agent\'s job');
  });

  it('makes an AI Agent step with no local chat model a dedicated agent (as a local model proposed live, on OpenAI)', async () => {
    const { ops, names } = asNewAgents([
      { op: 'addNode', ref: 'cr', type: 'core.aiAgent', name: 'Contract Review', after: 'New ticket', parameters: { systemMessage: 'You review vendor contracts. Flag auto-renewal.', prompt: '{{ $json.body.text }}' } },
      { op: 'addNode', type: 'core.openAiChatModel', name: 'OpenAI Chat Model', after: 'cr' },
      { op: 'addNode', ref: 'small', type: 'core.aiAgent', name: 'Tag it', after: 'Triage' },
      { op: 'addNode', type: 'core.ollamaChatModel', name: 'Llama', after: 'small' },
    ]);
    expect(names).toEqual(['Contract Review']);
    expect((ops as unknown[])[0]).toEqual({ op: 'newAgent', name: 'Contract Review', description: 'You review vendor contracts.', instructions: 'You review vendor contracts. Flag auto-renewal.', parameters: { message: '{{ $json.body.text }}' }, ref: 'cr', after: 'New ticket' });
    // The one on an Ollama model stays an inline step.
    expect((ops as unknown[])[2]).toMatchObject({ op: 'addNode', type: 'core.aiAgent', name: 'Tag it' });

    const { model } = scripted([
      { toolCalls: [{ id: 'c1', name: 'propose_changes', input: { summary: 'Reviewer', ops: [{ op: 'addNode', ref: 'cr', type: 'core.aiAgent', name: 'Contract Review', after: 'New ticket', parameters: { systemMessage: 'Review contracts.' } }, { op: 'addNode', type: 'core.openAiChatModel', name: 'OpenAI Chat Model', after: 'cr' }] } }] },
      { text: 'Added a contract reviewer.' },
    ]);
    const events: ChatEvent[] = [];
    await runChat({ messages: [{ role: 'user', content: 'Have a specialist review contracts first' }], workflow: flow(), model, types, onEvent: (e) => events.push(e) });
    const proposal = events.find((e) => e.type === 'proposal') as Extract<ChatEvent, { type: 'proposal' }>;
    expect(proposal.ops).toEqual([expect.objectContaining({ op: 'addNode', type: 'core.messageAgent', name: 'Contract Review', newAgent: { name: 'Contract Review', description: 'Review contracts.', instructions: 'Review contracts.' } })]);
  });
});
