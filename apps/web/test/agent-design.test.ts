/**
 * The Agent architect with the host's models and knowledge bases (lib/server/assistant/agent-resources.ts) and
 * designing Spotlight's newAgent without a conversation (designAgent): the draft runs on a model the host has, the local
 * one first, searches a knowledge base that exists or starts an empty one, and a model that proposes nothing still
 * leaves an agent on the first model.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { LanguageModel, ModelTurn } from '@landflow/engine';
import type { NodeTypeInfo } from '@/lib/shared/types';
import type { AgentResources } from '@/lib/server/assistant/agent-resources';

const { corePlugin } = await import('@/lib/server/nodes');
const { registry } = await import('@/lib/server/plugins/registry');
const { chooseModel } = await import('@/lib/server/assistant/agent-resources');
const { designAgent, designBrief, designRequest, draftFrom, fromDesign } = await import('@/lib/server/assistant/architect');
const { TEST_OWNER } = await import('@/lib/server/auth/test-bypass');

let types: NodeTypeInfo[];
beforeAll(() => {
  registry.registerBuiltin(corePlugin);
  types = registry.nodeTypes().filter((t) => t.pluginId === 'core');
});

const embeddings = { provider: 'ollama' as const, model: 'nomic-embed-text:latest', queryPrefix: 'search_query: ' };
const resources: AgentResources = {
  models: [
    { provider: 'ollama', model: 'qwen3-coder:30b', note: 'local, tools ✓' },
    { provider: 'ollama', model: 'qwen3.8:latest', note: 'local, tools ✓' },
  ],
  knowledge: [{ type: 'knowledge', name: 'search_policies', description: 'Company policies and contract playbooks', store: 'sqlite', collection: 'policies', embeddings, usedBy: ['Support triage'] }],
  embeddings,
};

function scripted(turns: Array<Partial<ModelTurn>>, offered: string[][] = []) {
  const model: LanguageModel = {
    provider: 'test',
    model: 'scripted',
    async generate(request) {
      offered.push((request.tools ?? []).map((t) => t.name));
      const next = turns.shift();
      if (!next) throw new Error('No scripted turn left');
      return { text: '', toolCalls: [], stopReason: 'stop', ...next };
    },
  };
  return model;
}

describe('the architect’s models and knowledge bases', () => {
  it('runs the agent on the model named when the host has it, else on the first (local) one', () => {
    expect(chooseModel('ollama/qwen3.8:latest', resources.models)).toEqual({ provider: 'ollama', model: 'qwen3.8:latest' });
    expect(chooseModel('qwen3.8:latest', resources.models)).toEqual({ provider: 'ollama', model: 'qwen3.8:latest' });
    expect(chooseModel('gpt-9', resources.models)).toEqual({ provider: 'ollama', model: 'qwen3-coder:30b' });
    expect(chooseModel(undefined, [])).toBeUndefined();

    const { config, dropped } = draftFrom({ name: 'Reviewer', role: 'Lawyer', instructions: 'Review.', tools: [], model: 'anthropic/claude-nope' }, { types, actor: TEST_OWNER, known: '', resources });
    expect(config.model).toEqual({ provider: 'ollama', model: 'qwen3-coder:30b' });
    expect(dropped).toContain('the model “anthropic/claude-nope”, which isn\'t here: it runs on ollama/qwen3-coder:30b');
  });

  it('searches a knowledge base that exists, or starts an empty one the user fills', () => {
    const { config, needs } = draftFrom(
      {
        name: 'Reviewer',
        role: 'Lawyer',
        instructions: 'Review.',
        tools: [
          { type: 'knowledge', collection: 'policies' },
          { type: 'knowledge', collection: 'Vendor Contracts', description: 'Signed vendor contracts' },
        ],
      },
      { types, actor: TEST_OWNER, known: '', resources },
    );
    expect(config.tools).toEqual([
      expect.objectContaining({ type: 'knowledge', name: 'search_policies', collection: 'policies', store: 'sqlite', embeddings, description: 'Company policies and contract playbooks' }),
      expect.objectContaining({ type: 'knowledge', name: 'search_vendor_contracts', collection: 'vendor-contracts', store: 'sqlite', embeddings, description: 'Signed vendor contracts' }),
    ]);
    expect(needs.map((n) => n.text)).toEqual(['search_vendor_contracts: add documents to the new “vendor-contracts” knowledge base (the agent\'s Knowledge tab)']);

    const without = draftFrom({ name: 'R', role: 'R', instructions: 'R', tools: [{ type: 'knowledge', collection: 'notes' }] }, { types, actor: TEST_OWNER, known: '', resources: { ...resources, embeddings: undefined } });
    expect(without.config.tools).toEqual([]);
    expect(without.dropped[0]).toMatch(/no embeddings model is pulled/);
  });
});

describe('designing Spotlight’s new agent', () => {
  const spec = { name: 'Legal Contract Reviewer', description: 'Reviews vendor contracts for risky clauses', instructions: 'Flag auto-renewal and liability caps.', workflow: 'Support tickets', after: 'Webhook Trigger', before: 'Triage Ticket' };

  it('asks the architect to design it now, with where it runs', () => {
    const request = designRequest(spec);
    expect(request).toContain('without asking me anything');
    expect(request).toContain('in the workflow “Support tickets”, after the step “Webhook Trigger”, before “Triage Ticket”');
    expect(request).toContain('list_models');
  });

  it('keeps the architect’s draft, under the name Spotlight gave it', async () => {
    const model = scripted([
      { toolCalls: [{ id: 'c1', name: 'list_knowledge_bases', input: {} }] },
      { toolCalls: [{ id: 'c2', name: 'propose_agent', input: { summary: 'Draft', name: 'Contract Carl', role: 'Contract reviewer', instructions: 'Search the playbook, then flag clauses.', model: 'ollama/qwen3.8:latest', tools: [{ type: 'knowledge', collection: 'policies' }] } }] },
      { text: 'Proposed.' },
    ]);
    const design = await designAgent(spec, { types, actor: TEST_OWNER, resources, model });
    expect(design.designed).toBe(true);
    expect(design.config).toMatchObject({ name: 'Legal Contract Reviewer', model: { provider: 'ollama', model: 'qwen3.8:latest' }, instructions: 'Search the playbook, then flag clauses.' });
    expect(design.config.tools).toEqual([expect.objectContaining({ type: 'knowledge', collection: 'policies' })]);
  });

  it('leaves an agent on the first model when the architect proposes nothing', async () => {
    const design = await designAgent(spec, { types, actor: TEST_OWNER, resources, model: scripted([{ text: 'Which contracts?' }]) });
    expect(design).toMatchObject({ designed: false, config: { name: 'Legal Contract Reviewer', instructions: 'Flag auto-renewal and liability caps.', model: { provider: 'ollama', model: 'qwen3-coder:30b' }, tools: [] } });
  });

  it('passes a reached usage cap on instead of making an agent; a failing model still gets the fallback', async () => {
    const { UsageCapError } = await import('@/lib/server/ai-usage');
    const failing = (error: Error): LanguageModel => ({ provider: 'test', model: 'failing', generate: async () => { throw error; } });
    const cap = new UsageCapError({ metric: 'tokens', max: 1000, subject: 'Your account', setIn: 'Settings → AI usage caps' } as ConstructorParameters<typeof UsageCapError>[0], 1200);
    await expect(designAgent(spec, { types, actor: TEST_OWNER, resources, model: failing(cap) })).rejects.toBe(cap);
    const design = await designAgent(spec, { types, actor: TEST_OWNER, resources, model: failing(new Error('Ollama error 500')) });
    expect(design.designed).toBe(false);
  });

  it('hands the model what it would look up, and offers one flat call first', async () => {
    const brief = designBrief({ name: 'CRM Sender', description: 'Sends each ticket to the CRM over HTTP', instructions: '' }, { types, resources });
    expect(brief).toContain('ollama/qwen3-coder:30b (local, tools ✓)');
    expect(brief).toContain('policies: Company policies and contract playbooks');
    expect(brief).toContain('core.httpRequest (HTTP Request)');
    // "to" and "on" are inside half the node names: they aren't searched.
    const slack = designBrief({ name: 'Escalation Poster', description: 'Posts urgent support tickets to the on-call Slack channel', instructions: '' }, { types, resources });
    expect(slack).not.toContain('core.respondToWebhook');

    const offered: string[][] = [];
    const model = scripted(
      [
        { toolCalls: [{ id: 'c1', name: 'propose_design', input: { role: 'Contract reviewer', instructions: 'Search the playbook, then flag clauses.', whatIDo: 'Reviews contracts\n<parameter=0>\nFlags risky clauses', tones: 'Precise, Direct', model: 'ollama/qwen3.8:latest', knowledge: 'policies', nodeTools: 'none', missing: 'none' } }] },
        { text: 'Proposed.' },
      ],
      offered,
    );
    const design = await designAgent(spec, { types, actor: TEST_OWNER, resources, model });
    expect(offered[0]).toEqual(['propose_design']);
    expect(design).toMatchObject({ designed: true, config: { name: 'Legal Contract Reviewer', model: { provider: 'ollama', model: 'qwen3.8:latest' }, persona: { whatIDo: ['Reviews contracts', 'Flags risky clauses'] } } });
    expect(design.config.tools).toEqual([expect.objectContaining({ type: 'knowledge', collection: 'policies' })]);
  });

  it('reads the flat call’s plain strings as a proposal', () => {
    expect(fromDesign({ role: 'Poster', instructions: 'Post it.', model: 'ollama/qwen3-coder:30b', knowledge: '', nodeTools: 'core.httpRequest, core.mcpClient', missing: 'Slack: post a message\nnone' })).toMatchObject({
      role: 'Poster',
      tools: [
        { type: 'node', nodeType: 'core.httpRequest' },
        { type: 'node', nodeType: 'core.mcpClient' },
      ],
      missing: ['Slack: post a message'],
    });
  });
});
