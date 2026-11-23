/**
 * SB06: the Agent architect on a local model. Ollama's parser fails on the nested arrays qwen3-coder writes for
 * propose_agent, so the dialog offers the flat propose_design there, and a parse error is retried with it.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { LanguageModel, ModelTurn } from '@landflow/engine';
import { agentConfigSchema } from '@/lib/server/agents/http';
import type { NodeTypeInfo } from '@/lib/shared/types';

const { corePlugin } = await import('@/lib/server/nodes');
const { registry } = await import('@/lib/server/plugins/registry');
const { designAgent, runArchitect } = await import('@/lib/server/assistant/architect');
const { TEST_OWNER } = await import('@/lib/server/auth/test-bypass');
type ArchitectEvent = Parameters<Parameters<typeof runArchitect>[0]['onEvent']>[0];

let types: NodeTypeInfo[];
beforeAll(() => {
  registry.registerBuiltin(corePlugin);
  types = registry.nodeTypes().filter((t) => t.pluginId === 'core');
});

function scripted(provider: string, turns: Array<Partial<ModelTurn> | (() => never)>, offered: string[][] = []): LanguageModel {
  return {
    provider,
    model: 'scripted',
    async generate(request) {
      // SB17: the architect's one follow-up call for test cases (agent-brief.test.ts tests it): answered here without a scripted turn.
      if (typeof request.system === 'string' && request.system.startsWith('You write test cases')) return { text: 'Hello => A greeting\nWhat can you do? => What it does\nSomething odd => Says it cannot help', toolCalls: [], stopReason: 'stop' as const };
      offered.push((request.tools ?? []).map((t) => t.name));
      const next = turns.shift();
      if (!next) throw new Error('No scripted turn left');
      const turn = typeof next === 'function' ? next() : next;
      return { text: '', toolCalls: [], stopReason: 'stop', ...turn };
    },
  };
}

const ask = (model: LanguageModel) => {
  const events: ArchitectEvent[] = [];
  return runArchitect({ messages: [{ role: 'user', content: 'a PR reviewer' }], model, types, actor: TEST_OWNER, onEvent: (e) => events.push(e) }).then(() => events);
};

const parseError = () => {
  throw new Error('Ollama error 500: {"error":"XML syntax error on line 41: unexpected EOF"}');
};

describe('the Agent architect on a local model', () => {
  it('offers the flat propose_design on an Ollama model, today’s tools on a cloud one', async () => {
    const local: string[][] = [];
    await ask(scripted('ollama', [{ text: 'Which system?' }], local));
    expect(local[0]).toContain('propose_design');
    expect(local[0]).not.toContain('propose_agent');
    expect(local[0]).toEqual(expect.arrayContaining(['search_nodes', 'get_node_docs', 'list_workflows']));

    const cloud: string[][] = [];
    await ask(scripted('anthropic', [{ text: 'Which system?' }], cloud));
    expect(cloud[0]).toContain('propose_agent');
    expect(cloud[0]).not.toContain('propose_design');
  });

  it('turns a propose_design with every persona field into a draft', async () => {
    const events = await ask(
      scripted('ollama', [
        {
          toolCalls: [
            {
              id: 'c1',
              name: 'propose_design',
              input: {
                summary: 'A reviewer',
                name: 'PR Reviewer',
                role: 'Pull request reviewer',
                audience: 'Engineers',
                mission: 'Checks each pull request',
                always: 'Quote the practice\nSay what is good',
                never: 'Approve unread diffs',
                answerLength: 'long',
                instructions: 'Read, check, comment.',
                nodeTools: 'core.httpRequest',
                workflowTools: 'wf_nope',
                agentTools: 'ag_nope',
              },
            },
          ],
        },
        { text: 'Drafted.' },
      ]),
    );
    const draft = events.find((e) => e.type === 'draft');
    expect(draft).toBeTruthy();
    if (draft?.type !== 'draft') return;
    expect(draft.config).toMatchObject({
      name: 'PR Reviewer',
      persona: { role: 'Pull request reviewer', audience: 'Engineers', mission: 'Checks each pull request', always: ['Quote the practice', 'Say what is good'], never: ['Approve unread diffs'], length: 'detailed' },
    });
    expect(draft.config.tools).toEqual([expect.objectContaining({ type: 'node', nodeType: 'core.httpRequest' })]);
    // Workflow and agent ids that don't exist are reported, not turned into tools.
    expect(draft.dropped.join(' ')).toContain('wf_nope');
    expect(draft.dropped.join(' ')).toContain('ag_nope');
  });

  it.each([['medium', 'paragraph'], ['short', 'sentence'], ['long', 'detailed']])('a %s answer length gives a draft the import accepts', async (answerLength, length) => {
    const events = await ask(scripted('ollama', [{ toolCalls: [{ id: 'c1', name: 'propose_design', input: { name: 'Len', role: 'Tester', instructions: 'Test.', answerLength } }] }, { text: 'Drafted.' }]));
    const draft = events.find((e) => e.type === 'draft');
    if (draft?.type !== 'draft') throw new Error('no draft');
    expect(draft.config.persona?.length).toBe(length);
    expect(agentConfigSchema.safeParse(draft.config).success).toBe(true);
  });

  it('retries a parse error with the flat tool, whatever the provider, and a draft arrives', async () => {
    const offered: string[][] = [];
    const events = await ask(scripted('anthropic', [parseError, { toolCalls: [{ id: 'c1', name: 'propose_design', input: { name: 'PR Reviewer', role: 'Reviewer', instructions: 'Review.' } }] }, { text: 'Drafted.' }], offered));
    expect(offered[0]).toContain('propose_agent');
    expect(offered[1]).toContain('propose_design');
    expect(offered[1]).not.toContain('propose_agent');
    expect(events.some((e) => e.type === 'draft')).toBe(true);
  });

  it('retries the adapter’s real error shape (its words in the description), and not an out-of-memory 500 or a usage cap', async () => {
    const { NodeOperationError } = await import('@landflow/sdk');
    const real = () => {
      throw new NodeOperationError('Ollama error', { description: 'XML syntax error on line 1: unexpected EOF' });
    };
    const offered: string[][] = [];
    const events = await ask(scripted('anthropic', [real, { toolCalls: [{ id: 'c1', name: 'propose_design', input: { name: 'PR Reviewer', role: 'Reviewer', instructions: 'Review.' } }] }, { text: 'Drafted.' }], offered));
    expect(offered).toHaveLength(3);
    expect(events.some((e) => e.type === 'draft')).toBe(true);

    for (const failure of [new Error('Ollama error 500: out of memory'), Object.assign(new Error('Your monthly AI usage cap is reached (XML syntax error)'), { name: 'UsageCapError' })]) {
      const once: string[][] = [];
      await expect(ask(scripted('anthropic', [() => { throw failure; }, { text: 'never asked' }], once))).rejects.toThrow();
      expect(once).toHaveLength(1);
    }
  });

  it('an empty summary or "none" for the rules is no summary and no rule', async () => {
    const events = await ask(scripted('ollama', [{ toolCalls: [{ id: 'c1', name: 'propose_design', input: { name: 'Quiet', role: 'Tester', instructions: 'Test.', always: 'none', never: 'N/A\n-\nNo\nNever guess' } }] }, { text: 'Drafted.' }]));
    const draft = events.find((e) => e.type === 'draft');
    if (draft?.type !== 'draft') throw new Error('no draft');
    expect(draft.config.persona?.always ?? []).toEqual([]);
    expect(draft.config.persona?.never).toEqual(['Never guess']);
    expect(JSON.stringify(events)).not.toContain('Designed for Spotlight');
    const proposed = events.find((e) => e.type === 'draft') as { summary?: string };
    expect(proposed.summary ?? '').toBe('Draft: Quiet');
  });

  it('still offers only propose_design first for Spotlight’s design', async () => {
    const offered: string[][] = [];
    await designAgent({ name: 'Reviewer', description: 'Reviews PRs', instructions: '' }, { types, actor: TEST_OWNER, model: scripted('ollama', [{ text: 'x' }, { text: 'y' }], offered) });
    expect(offered[0]).toEqual(['propose_design']);
  });
});
