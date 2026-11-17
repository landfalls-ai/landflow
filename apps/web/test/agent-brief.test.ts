/**
 * SB17: the agent brief (docs/agents.md#agent-architect): instructions in four fixed parts, the approved practices when the
 * request asks for "our practices", least privilege, approval on writes, guardrail defaults and 3 to 5 test cases. The
 * model is scripted (the agent-architect.test.ts pattern); nothing leaves this machine.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { definePlugin, defineNode } from '@landflow/sdk';
import type { LanguageModel, ModelTurn } from '@landflow/engine';
import { agentConfigSchema } from '@/lib/server/agents/http';
import type { AgentCaseDraft } from '@/lib/shared/agent-card';
import type { ArchitectEvent } from '@/lib/shared/agent-architect';
import { DEFAULT_BRIEF_GUARDRAILS, guardrailWords, type NodeToolConfig } from '@/lib/shared/agents';
import { writesOutside } from '@/lib/shared/run-check';
import type { NodeTypeInfo } from '@/lib/shared/types';

const designCalls: Array<Record<string, unknown>> = [];
vi.mock('@/lib/server/assistant/architect', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/server/assistant/architect')>()),
  // The route test below sees this one; the real designAgent is `actual.designAgent`.
  designAgent: vi.fn(async (spec: Record<string, unknown>) => {
    designCalls.push(spec);
    return {
      config: { name: String(spec.name), description: '', instructions: '', skills: [], tools: [], schedules: [], channels: [], memory: { crossSession: false }, settings: {} },
      needs: [],
      missing: [],
      dropped: [],
      cases: [{ input: 'Review pull request 1', expected: 'Lists what breaks' }, { input: 'Is pull request 2 fine?' }, { input: 'Merge it', expected: 'Says it only reviews' }],
      designed: true,
    };
  }),
}));

const { corePlugin } = await import('@/lib/server/nodes');
const { registry } = await import('@/lib/server/plugins/registry');
const actual = await vi.importActual<typeof import('@/lib/server/assistant/architect')>('@/lib/server/assistant/architect');
const { PRACTICES_ASK, briefParts, draftFrom, designRequest, designWords, parseCases, runArchitect } = await import('@/lib/server/assistant/architect');
const { agentStore } = await import('@/lib/server/agents/store');
const { listCases } = await import('@/lib/server/agents/eval-gate');
const { TEST_OWNER } = await import('@/lib/server/auth/test-bypass');
const { plugin: github } = await import('../../../plugins/github/src/main');
const { plugin: linear } = await import('../../../plugins/linear/src/main');
const { postCases, showEarlier, continueLatest, EarlierLine } = await import('@/components/agents/architect');
const designRoute = await import('@/app/api/agents/design/route');

let types: NodeTypeInfo[];
beforeAll(() => {
  registry.registerBuiltin(corePlugin);
  registry.registerBuiltin(github);
  registry.registerBuiltin(linear);
  // A Slack stand-in: the node a reviewer must never get.
  registry.registerBuiltin(
    definePlugin({
      info: { id: 'messaging', name: 'Messaging (stand-in)', version: '0.0.0', language: 'typescript' },
      nodes: [
        defineNode({
          description: {
            name: 'slack',
            displayName: 'Slack',
            description: 'Slack',
            version: 1,
            kind: 'action',
            keywords: ['slack', 'channel'],
            inputs: [{ type: 'main' }],
            outputs: [{ type: 'main' }],
            properties: [{ name: 'operation', displayName: 'Operation', type: 'string', default: 'post' }],
          },
          async execute() {
            return [[{ json: {} }]];
          },
        }),
      ],
    }),
  );
  types = registry.nodeTypes().filter((t) => ['core', 'github', 'linear', 'messaging'].includes(t.pluginId));
});

const context = (request: string | undefined, extra: Partial<Parameters<typeof draftFrom>[1]> = {}) => ({ types, actor: TEST_OWNER, known: '', ...(request !== undefined && { request }), ...extra });
const nodeTools = (config: { tools?: unknown[] }) => (config.tools ?? []) as NodeToolConfig[];
const REVIEWER = 'an agent that reviews pull requests against our practices';
const THREE = 'Review pull request 12 => Names the practices it breaks\nIs pull request 7 fine? => Answers from the check\nMerge pull request 3 => Says it only reviews';

/** A LanguageModel that answers from a script and records what it was asked. */
function scripted(turns: Array<Partial<ModelTurn>>) {
  const calls: Array<{ system?: string; tools: string[] }> = [];
  const model: LanguageModel = {
    provider: 'test',
    model: 'scripted',
    async generate(input) {
      calls.push({ system: input.system, tools: (input.tools ?? []).map((t) => t.name) });
      const next = turns.shift();
      if (!next) throw new Error('No scripted turn left');
      return { text: '', toolCalls: [], stopReason: 'stop', ...next };
    },
  };
  return { model, calls };
}
const propose = (input: Record<string, unknown>): Partial<ModelTurn> => ({ toolCalls: [{ id: 'p1', name: 'propose_agent', input: { summary: 'Draft', name: 'Reviewer', role: 'Reviewer', instructions: 'Review.', tools: [], ...input } }] });
async function architect(ask: string, turns: Array<Partial<ModelTurn>>) {
  const { model, calls } = scripted(turns);
  const events: ArchitectEvent[] = [];
  await runArchitect({ messages: [{ role: 'user', content: ask }], model, types, actor: TEST_OWNER, onEvent: (e) => events.push(e) });
  const drafts = events.filter((e): e is Extract<ArchitectEvent, { type: 'draft' }> => e.type === 'draft');
  return { events, calls, draft: drafts.at(-1)! };
}

describe('the four fixed parts', () => {
  it('turns one paragraph into Input, Steps, Output and Hand over when, filled from the draft', () => {
    const { config } = draftFrom({ name: 'Reader', role: 'Researcher', audience: 'Engineers', mission: 'Summarises web pages', length: 'detailed', instructions: 'Fetch the page, then summarise it.', tools: [{ type: 'node', nodeType: 'core.httpRequest', name: 'fetch_page' }] }, context(undefined));
    const text = config.instructions!;
    const at = ['Input:', 'Steps:', 'Output:', 'Hand over when:'].map((h) => text.indexOf(h));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect(at).toEqual([...at].sort((a, b) => a - b));
    expect(text).toContain('Engineers');
    expect(text).toContain('Summarises web pages');
    expect(text).toContain('1. Fetch the page, then summarise it.');
    expect(text).toMatch(/Tools: fetch_page/);
    expect(text).toMatch(/Output: A detailed answer/);
  });

  it('keeps the parts a draft has, adds the ones it lacks, and never leaves one empty', () => {
    const kept = briefParts('Input: A ticket.\nSteps:\n1. Read it.\n2. Reply with reply_tool.', { tools: ['reply_tool'], writes: false });
    expect(kept).toContain('Input: A ticket.');
    expect(kept).toContain('2. Reply with reply_tool.');
    expect(kept).not.toMatch(/Tools:/);
    expect(kept).toMatch(/Output: .+/);
    expect(kept).toMatch(/Hand over when: .+/);
    expect(briefParts('', { tools: [], writes: false })).toMatch(/Input: .+\nSteps:\n1\..+\nOutput: .+\nHand over when: .+/s);
    // A second pass changes nothing.
    expect(briefParts(kept, { tools: ['reply_tool'], writes: false })).toBe(kept);
  });
});

describe('approved practices', () => {
  it('reads "our practices", "our standards", "our guidelines" and "our conventions"', () => {
    for (const ask of ['against our practices', 'by our standards', 'follow our guidelines', 'our conventions apply', 'Our approved practices']) expect(PRACTICES_ASK.test(ask), ask).toBe(true);
    for (const ask of ['against best practices', 'check the standards', 'a practice review']) expect(PRACTICES_ASK.test(ask), ask).toBe(false);
  });

  it('keeps practices on and adds Check Practices, with the repository left as a need, when the request asks', () => {
    const { config, needs } = draftFrom({ name: 'Reviewer', role: 'Reviewer', instructions: 'Review.', tools: [] }, context(REVIEWER));
    expect(config.practices).toBe('on');
    const [tool] = nodeTools(config);
    expect(tool).toMatchObject({ type: 'node', name: 'check_practices', nodeType: 'core.practiceCheck' });
    expect(tool.parameters.changedFiles).toBe("{{ $fromAI('changedFiles', 'the files the change touches: [{ path, status }]', 'json') }}");
    expect(tool.parameters.repository).toBe('');
    expect(tool.requireApproval).toBeUndefined();
    expect(needs).toContainEqual(expect.objectContaining({ tool: 'check_practices', kind: 'parameter', text: expect.stringContaining('Repository') }));
  });

  it('takes a repository the request names', () => {
    const { config, needs } = draftFrom({ name: 'Reviewer', role: 'Reviewer', instructions: 'Review.', tools: [] }, context(`${REVIEWER} in acme/shop`));
    expect(nodeTools(config)[0].parameters.repository).toBe('acme/shop');
    expect(needs.some((n) => n.tool === 'check_practices')).toBe(false);
  });

  it('does not read a word pair like pass/fail or PRs/MRs as the repository', () => {
    for (const phrase of ['a pass/fail verdict', 'for PRs/MRs', 'read/write access', 'a go/no-go call']) {
      const { config, needs } = draftFrom({ name: 'Reviewer', role: 'Reviewer', instructions: 'Review.', tools: [] }, context(`${REVIEWER} with ${phrase}`));
      expect(nodeTools(config)[0].parameters.repository, phrase).toBe('');
      expect(needs.some((n) => n.tool === 'check_practices' && /Repository/.test(n.text)), phrase).toBe(true);
    }
  });

  it('adds no practice tool when the request does not ask, and drops the model’s own', () => {
    const asked = { name: 'Reviewer', role: 'Reviewer', instructions: 'Review.', tools: [{ type: 'node', nodeType: 'core.practiceCheck', name: 'practices' }] };
    const { config } = draftFrom(asked, context('an agent that reviews pull requests'));
    expect(config.tools).toEqual([]);
    expect(config.practices).toBeUndefined();
  });

  it('keeps one check_practices tool and no "left out" line when the model proposes Check Practices and the request asks', () => {
    const proposed = { name: 'Reviewer', role: 'Reviewer', instructions: 'Review.', tools: [{ type: 'node', nodeType: 'core.practiceCheck', name: 'practices' }] };
    const { config, dropped } = draftFrom(proposed, context(REVIEWER));
    expect(nodeTools(config).filter((t) => t.name === 'check_practices')).toHaveLength(1);
    expect(nodeTools(config)).toHaveLength(1);
    expect(dropped.join(' ')).not.toContain('Check Practices');
  });

  it('says why the model’s Check Practices is left out when no practices are asked', () => {
    const proposed = { name: 'Reviewer', role: 'Reviewer', instructions: 'Review.', tools: [{ type: 'node', nodeType: 'core.practiceCheck', name: 'practices' }] };
    const { dropped } = draftFrom(proposed, context('an agent that reviews pull requests'));
    expect(dropped).toContain('Check Practices: the request doesn’t ask for your practices');
  });
});

describe('least privilege and approval on writes', () => {
  const github = (operation: string, name = operation) => ({ type: 'node', nodeType: 'github.github', name: `pr_${name}`, parameters: { resource: 'pullRequest', operation } });

  it('puts approval on every write and none on reads', () => {
    const { config, dropped } = draftFrom({ name: 'Reviewer', role: 'Reviewer', instructions: 'Review.', tools: [github('get'), github('listFiles'), github('comment')] }, context('an agent that reviews pull requests on GitHub and leaves comments'));
    const byName = Object.fromEntries(nodeTools(config).map((t) => [t.name, t.requireApproval]));
    expect(byName).toEqual({ pr_get: undefined, pr_listfiles: undefined, pr_comment: true });
    expect(dropped).toEqual([]);
  });

  it('drops a write the request never asked for, and turns a default write into a read', () => {
    const asked = 'an agent that reviews pull requests';
    const { config, dropped } = draftFrom({ name: 'Reviewer', role: 'Reviewer', instructions: 'Review.', tools: [github('comment'), { type: 'node', nodeType: 'github.github', name: 'github' }] }, context(asked));
    expect(dropped).toEqual([expect.stringContaining('GitHub (comment): the request asks to read or check')]);
    const [tool] = nodeTools(config);
    expect(tool.parameters).toMatchObject({ resource: 'pullRequest', operation: 'get' });
    expect(tool.requireApproval).toBeUndefined();
  });

  it('drops a Slack tool and a delegation the request never asked for, each with its reason', () => {
    const other = agentStore.create({ name: 'Helper', description: 'Helps', instructions: 'Help.' });
    const { config, dropped } = draftFrom(
      {
        name: 'Reviewer',
        role: 'Reviewer',
        instructions: 'Review.',
        tools: [github('get'), { type: 'node', nodeType: 'messaging.slack', name: 'post_to_slack' }, { type: 'node', nodeType: 'core.messageAgent', name: 'run_an_agent' }, { type: 'agent', agentId: other.id }],
      },
      context('an agent that reviews pull requests on GitHub'),
    );
    expect(config.tools).toHaveLength(1);
    expect(dropped).toEqual([
      'Slack: the request never asks for it (it would change things there)',
      'Run an Agent: the request doesn’t ask to hand over to another agent',
      'the agent “Helper”: the request doesn’t ask to hand over to another agent',
    ]);
  });

  it('keeps a delegation when the request asks to hand over, and Slack when it names Slack', () => {
    const other = agentStore.create({ name: 'Escalations', description: 'Takes over', instructions: 'Take over.' });
    const { config, dropped } = draftFrom({ name: 'Triage', role: 'Triage', instructions: 'Triage.', tools: [{ type: 'agent', agentId: other.id }, { type: 'node', nodeType: 'messaging.slack', name: 'post_to_slack' }] }, context('triage alerts, hand over the hard ones to another agent, and post a summary to Slack'));
    expect(config.tools).toHaveLength(2);
    expect(nodeTools(config)[1].requireApproval).toBe(true);
    expect(dropped).toEqual([]);
  });

  it('drops a knowledge base a request about practices or pull requests never asked for, and keeps one about docs', () => {
    const tools = [{ type: 'knowledge', collection: 'practices' }];
    const embeddings = { provider: 'ollama' as const, model: 'nomic-embed-text:latest' };
    const resources = { models: [], knowledge: [], embeddings };
    const asked = draftFrom({ name: 'Reviewer', role: 'Reviewer', instructions: 'Review.', tools }, context(REVIEWER, { resources }));
    expect(asked.config.tools?.some((t) => t.type === 'knowledge')).toBe(false);
    expect(asked.dropped).toEqual([expect.stringContaining('“practices”: the request doesn’t say what it answers from')]);
    const docs = draftFrom({ name: 'Answerer', role: 'Answerer', instructions: 'Answer.', tools }, context('answers customer questions from our docs', { resources }));
    expect(docs.config.tools?.some((t) => t.type === 'knowledge')).toBe(true);
  });

  it('shares one write heuristic with the session', () => {
    expect(writesOutside({ type: 'core.httpRequest', parameters: { method: 'POST' } })).toBe(true);
    expect(writesOutside({ type: 'core.httpRequest', parameters: { method: 'GET' } })).toBe(false);
    expect(writesOutside({ type: 'github.github', parameters: { operation: 'comment' } })).toBe(true);
    expect(writesOutside({ type: 'github.github', parameters: { operation: 'listFiles' } })).toBe(false);
  });
});

describe('guardrail defaults', () => {
  it('masks secrets in messages, and guards tool results only when the agent has a tool', () => {
    const none = draftFrom({ name: 'Plain', role: 'Helper', instructions: 'Help.', tools: [] }, context(undefined)).config;
    expect(none.guardrails).toEqual({ input: DEFAULT_BRIEF_GUARDRAILS.input });
    expect(none.guardrails?.input).toEqual({ enabled: true, action: 'sanitize', checks: { secrets: { permissiveness: 'balanced' } }, reply: '' });
    const withTool = draftFrom({ name: 'Reader', role: 'Helper', instructions: 'Read.', tools: [{ type: 'node', nodeType: 'core.httpRequest', name: 'fetch' }] }, context(undefined)).config;
    expect(withTool.guardrails?.toolResult).toEqual({ enabled: true, action: 'block', checks: { jailbreak: { useModel: false } }, reply: 'A tool returned text that looked like instructions; I ignored it.' });
    expect(guardrailWords(withTool.guardrails)).toEqual(['Masks secrets in messages', 'Ignores instructions inside tool results']);
    // The import accepts what the brief drafts.
    expect(agentConfigSchema.safeParse({ ...withTool, skills: [], schedules: [], channels: [], memory: { crossSession: false }, settings: {} }).success).toBe(true);
  });

  it('keeps the guardrails a draft already has', () => {
    const own = { input: { enabled: true, action: 'block' as const, checks: { pii: {} }, reply: 'No personal data, please.' } };
    const { config } = draftFrom({ name: 'Plain', role: 'Helper', instructions: 'Help.', tools: [{ type: 'node', nodeType: 'core.httpRequest', name: 'fetch' }] }, context(undefined, { keep: { guardrails: own } }));
    expect(config.guardrails?.input).toEqual(own.input);
    expect(config.guardrails?.toolResult?.action).toBe('block');
  });
});

describe('test cases', () => {
  it('reads "input => expected" lines, at most 5, each input under 4 000 characters', () => {
    expect(parseCases('- A question => An answer\n2) Another one\nno\n=> only an answer')).toEqual([{ input: 'A question', expected: 'An answer' }, { input: 'Another one' }]);
    expect(parseCases(Array.from({ length: 8 }, (_, i) => `Question ${i} => Answer ${i}`))).toHaveLength(5);
    expect(parseCases(`${'x'.repeat(5000)} => ok`)[0].input).toHaveLength(4000);
  });

  it('three lines become three cases on the draft event, with no follow-up call', async () => {
    const { draft, calls } = await architect(REVIEWER, [propose({ cases: THREE }), { text: 'Done.' }]);
    expect(draft.cases).toEqual<AgentCaseDraft[]>([
      { input: 'Review pull request 12', expected: 'Names the practices it breaks' },
      { input: 'Is pull request 7 fine?', expected: 'Answers from the check' },
      { input: 'Merge pull request 3', expected: 'Says it only reviews' },
    ]);
    expect(calls).toHaveLength(2);
    expect(draft.needs.some((n) => n.text.includes('test cases'))).toBe(false);
  });

  it('asks once more for cases when the proposal has fewer than 3', async () => {
    const { draft, calls } = await architect(REVIEWER, [propose({ cases: 'Only one => Just this' }), { text: THREE }, { text: 'Done.' }]);
    expect(calls).toHaveLength(3);
    expect(calls[1].system).toContain('You write test cases');
    expect(calls[1].tools).toEqual([]);
    expect(draft.cases).toHaveLength(3);
    expect(draft.needs.some((n) => n.text.includes('test cases'))).toBe(false);
  });

  it('says so in needs, and invents nothing, when the follow-up gives none either', async () => {
    const { draft, calls } = await architect(REVIEWER, [propose({}), { text: 'I cannot think of any.' }, { text: 'Done.' }]);
    expect(calls).toHaveLength(3);
    expect(draft.cases).toEqual([]);
    expect(draft.needs).toContainEqual({ tool: 'test cases', kind: 'parameter', text: 'Add test cases on the Evaluations tab' });
  });

  it('cuts more than 5 to 5', async () => {
    const eight = Array.from({ length: 8 }, (_, i) => `Question ${i} => Answer ${i}`);
    const { draft } = await architect(REVIEWER, [propose({ cases: eight }), { text: 'Done.' }]);
    expect(draft.cases).toHaveLength(5);
  });

  it('asks for cases, the four parts and the fewest tools in both proposal tools', async () => {
    const { calls } = await architect(REVIEWER, [{ text: 'Which repository?' }]);
    expect(calls[0].system).toContain('"Input:"');
    expect(calls[0].system).toContain('fewest tools');
  });
});

describe('Spotlight’s design', () => {
  const spec = { name: 'Docs Hana', description: 'Answers questions', instructions: 'Answer from the docs.', tools: ['Linear: read issues'] };

  it('no longer says "without asking me anything"; it designs from what is written', () => {
    const request = designRequest(spec);
    expect(request).not.toContain('without asking');
    expect(request).toContain('from what is written here');
    expect(request).toContain('a repository, a channel');
  });

  it('brings back a tool it named that the model left out, from the top hit; else names it in missing', async () => {
    const { model } = scripted([propose({ name: 'Docs Hana', role: 'Docs answerer', instructions: 'Answer.' }), { text: 'Done.' }]);
    const done = await actual.designAgent({ ...spec, tools: ['Linear: read issues', 'Grafana: read firing alerts'] }, { model: { ...model, provider: 'anthropic' } as LanguageModel, types, actor: TEST_OWNER });
    const tools = nodeTools(done.config);
    expect(tools).toHaveLength(1);
    expect(tools[0].nodeType).toBe('linear.linear');
    expect(tools[0].parameters.operation).not.toBe('create');
    expect(tools[0].requireApproval).toBeUndefined();
    expect(done.missing).toContainEqual({ capability: 'read firing alerts', system: 'Grafana' });
    expect(done.config.guardrails?.toolResult).toBeDefined();
  });
});

describe('the design route and the dialog', () => {
  it('saves the design’s cases on the new agent and answers them', async () => {
    const response = await designRoute.POST(new Request('http://localhost/api/agents/design', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Reviewer', description: REVIEWER }) }));
    expect(response.status).toBe(201);
    const body = (await response.json()) as { agent: { id: string }; cases: AgentCaseDraft[]; needs: unknown[] };
    expect(body.cases).toHaveLength(3);
    expect(listCases(body.agent.id).map((c) => c.input).sort()).toEqual(['Is pull request 2 fine?', 'Merge it', 'Review pull request 1']);
  });

  it('Create posts each case to the eval gate after the import; a failed one is a line, not an error', async () => {
    const posted: Array<[string, unknown]> = [];
    const failed = await postCases('ag_1', [{ input: 'One', expected: 'A' }, { input: ' ' }, { input: 'Two' }, { input: 'Three', expected: ' ' }], async (url, json) => {
      posted.push([url, json]);
      if (json.input === 'Two') throw new Error('An agent keeps at most 50 test cases');
    });
    expect(posted).toEqual([
      ['/api/agents/ag_1/eval-gate', { input: 'One', expected: 'A' }],
      ['/api/agents/ag_1/eval-gate', { input: 'Two' }],
      ['/api/agents/ag_1/eval-gate', { input: 'Three' }],
    ]);
    expect(failed).toEqual(['“Two”: An agent keeps at most 50 test cases']);
  });
});

describe('the dialog starts fresh', () => {
  const latest = { id: 'cv_1', title: 'A PR reviewer' };
  it('offers the last conversation under Earlier only before anything is said', () => {
    expect(showEarlier(latest, 0, false)).toBe(true);
    expect(showEarlier(latest, 1, false)).toBe(false);
    expect(showEarlier(latest, 0, true)).toBe(false);
    expect(showEarlier(undefined, 0, false)).toBe(false);
    const html = renderToStaticMarkup(createElement(EarlierLine, { latest, onContinue: () => {} }));
    expect(html).toContain('Earlier:');
    expect(html).toContain('A PR reviewer');
    expect(html).toContain('Continue');
  });
  it('Continue opens the kept conversation', async () => {
    const open = vi.fn(async () => {});
    await continueLatest(latest, open);
    expect(open).toHaveBeenCalledWith('cv_1');
  });
});

describe('least privilege on the design path', () => {
  const spec = { name: 'Reviewer', description: 'reviews pull requests against our practices' };
  it('reads only the person’s words, not the fixed sentences', () => {
    expect(designWords(spec)).not.toMatch(/channel|repository|knowledge base/i);
  });
  it('drops a Slack read and an unasked knowledge base on a design', () => {
    const slack = types.find((t) => t.pluginId === 'messaging')!;
    const out = draftFrom(
      { name: 'Reviewer', role: 'Reviewer', instructions: 'Review.', tools: [{ type: 'node', nodeType: slack.type, name: 'slack', parameters: { operation: 'getAll' } }, { type: 'knowledge', collection: 'docs' }] },
      context(designWords(spec), { resources: { models: [], knowledge: [], embeddings: { provider: 'ollama' as const, model: 'nomic-embed-text:latest' } } }),
    );
    expect(nodeTools(out.config).some((t) => t.nodeType === slack.type)).toBe(false);
    expect(out.dropped.join(' ')).toMatch(/Slack: the request never asks for it/);
    expect(out.dropped.join(' ')).toMatch(/knowledge base/);
  });
});
