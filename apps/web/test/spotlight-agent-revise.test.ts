/**
 * AG04: Spotlight changes an agent (docs/assistant.md "Changing an agent"). A follow-up under an agent card revises the card
 * instead of becoming a plan; on an existing agent's page a change is a card to review and Apply to its draft; a question is
 * answered, never applied; a publish stays behind the smoke test and the eval gate (no `skipEval`).
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentChangeAsk } from '@/lib/shared/agent-ask';
import { agentChanges } from '@/lib/shared/agent-changes';
import { DEFAULT_BRIEF_GUARDRAILS, type AgentConfig } from '@/lib/shared/agents';
import type { AgentCard } from '@/lib/shared/agent-card';
import { agentStore } from '@/lib/server/agents/store';
import { corePlugin } from '@/lib/server/nodes';
import { registry } from '@/lib/server/plugins/registry';
import { ApiError } from '@/lib/client/api';
import { startFakeModels } from './fake-ai-services';
import { plugin as textToolkit } from '../../../plugins/text-toolkit/src/main';

// The editor's calls go to a recorder that answers like the routes do; nothing leaves this machine.
const calls: Array<{ path: string; method?: string; json?: Record<string, unknown> }> = [];
let answers: Record<string, (json?: Record<string, unknown>) => unknown> = {};
vi.mock('@/lib/client/api', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/client/api')>()),
  api: vi.fn(async (path: string, init: { method?: string; json?: Record<string, unknown> } = {}) => {
    calls.push({ path, method: init.method, json: init.json });
    const answer = Object.entries(answers).find(([prefix]) => path.startsWith(prefix))?.[1];
    if (!answer) throw new Error(`no answer for ${path}`);
    return answer(init.json);
  }),
}));

// An agent the caller cannot edit (another project's): the route says 404.
const foreign = new Set<string>();
vi.mock('@/lib/server/projects/access', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/server/projects/access')>();
  return { ...actual, canResource: (actor: never, kind: never, id: string, action: never) => !foreign.has(id) && actual.canResource(actor, kind, id, action) };
});

const { draftMoved, designChange } = await import('@/lib/client/agent-change');
const { cardAskFor, createFromCard, designAgentCard, reviseCardFor, agentCardQuestion, reviseAgentCard, reviseReply, applyAgentChange, publishAgentChange } = await import('@/components/editor/spotlight/agent-ask');
const { retryReply } = await import('@/components/editor/spotlight/reply');
const { keepUnderCard, cardQuestionFor } = await import('@/components/editor/spotlight/agent-ask');
const { useAssistant } = await import('@/components/editor/assistant');
const { useEditor } = await import('@/components/editor/store');
const { useAutonomous } = await import('@/components/editor/autonomous');
const { modeForRoute, spotlightMode, INITIAL_STATE } = await import('@/components/spotlight/context');
const { switchFor } = await import('@/components/spotlight/shell-spotlight');
const { chipLabel } = await import('@/components/spotlight/mode-chip');

// ---------------------------------------------------------------------------
// agentChangeAsk, agentChanges
// ---------------------------------------------------------------------------

describe('agentChangeAsk', () => {
  it('reads a change in words', () => {
    for (const m of ['add Slugify as a tool', 'also send it to Slack', 'remove the email tool', 'use Haiku', 'make it shorter', 'call it Alert triager', 'Please also let it get one alert’s details', 'it should answer in one sentence'])
      expect(agentChangeAsk(m), m).toBe('change');
  });
  it('reads a question', () => {
    for (const m of ['why does it need the Hash tool?', 'what tools does it have?', 'how does it decide?', 'does it send anything?']) expect(agentChangeAsk(m), m).toBe('question');
  });
  it('is neither for a new agent’s ask or for words that ask nothing', () => {
    expect(agentChangeAsk('create an agent that decodes JWTs')).toBeUndefined();
    expect(agentChangeAsk('an agent that triages bugs')).toBeUndefined();
    expect(agentChangeAsk('thanks')).toBeUndefined();
    expect(agentChangeAsk('')).toBeUndefined();
  });
});

describe('agentChanges', () => {
  const base = { name: 'Utility', description: 'Helps.', instructions: 'a\nb', model: { provider: 'ollama', model: 'q' }, tools: [{ type: 'node', name: 'Hash', nodeType: 'go-crypto.hash', parameters: { operation: 'sha256' } }, { type: 'knowledge', collection: 'docs' }] };
  it('says nothing for the same config', () => expect(agentChanges(base, JSON.parse(JSON.stringify(base)))).toEqual([]));
  it('names tools added and removed, an operation or approval changed', () => {
    const next = { ...base, tools: [{ type: 'node', name: 'Hash', nodeType: 'go-crypto.hash', parameters: { operation: 'md5' }, requireApproval: true }, { type: 'node', name: 'Slugify', nodeType: 'text-toolkit.slugify', parameters: {} }, { type: 'knowledge', collection: 'docs' }] };
    expect(agentChanges(base, next)).toEqual(['Adds the tool Slugify', 'Hash: sha256 becomes md5', 'Hash now asks first']);
    expect(agentChanges(next, base)).toEqual(['Removes the tool Slugify', 'Hash: md5 becomes sha256', 'Hash no longer asks first']);
  });
  it('names the model, name, description, guardrails and the count of instruction lines', () => {
    const next = { ...base, name: 'Alert triager', description: 'Triages.', model: { provider: 'anthropic', model: 'haiku' }, instructions: 'a\nc\nd', guardrails: DEFAULT_BRIEF_GUARDRAILS };
    expect(agentChanges(base, next)).toEqual(['Model: ollama/q becomes anthropic/haiku', 'Renames it to Alert triager', 'Description changed', 'Guardrail on: masking secrets in messages', 'Guardrail on: blocking prompt injection in tool results', 'Instructions rewritten (3 lines changed)']);
  });
});

// ---------------------------------------------------------------------------
// The design route with base and change
// ---------------------------------------------------------------------------

const FOUR_PARTS = 'Input: Each message that reaches it.\nSteps:\n1. Change the case of the text with Change Case.\nOutput: One short line.\nHand over when: It cannot tell.';
const baseConfig = (): Partial<AgentConfig> => ({
  name: 'Text helper',
  description: 'Changes the case of text.',
  instructions: FOUR_PARTS,
  icon: 'bot',
  color: '#6366f1',
  avatar: { kind: 'face', face: 'ada' } as never,
  model: { provider: 'ollama', model: 'qwen3-coder:30b' },
  tools: [{ id: 'tl_1', type: 'node', name: 'Change Case', description: 'Change the case.', nodeType: 'text-toolkit.changeCase', parameters: { mode: 'upper' } } as never],
  skills: [],
  schedules: [],
  channels: [],
  memory: { crossSession: false },
  settings: {} as never,
  guardrails: DEFAULT_BRIEF_GUARDRAILS,
});

const post = (body: unknown) => import('@/app/api/agents/design/route').then(({ POST }) => POST(new Request('http://localhost/api/agents/design', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })));

/** A fake Ollama that proposes the base plus the nodes named, with the base's own words. */
async function proposing(nodeTools: string, extra: Record<string, string> = {}) {
  const fake = await startFakeModels({
    reply: (_provider, body) =>
      Array.isArray((body as { messages?: unknown })?.messages)
        ? { text: '', toolCalls: [{ id: 'c1', name: 'propose_design', arguments: { summary: 'x', role: 'Text helper', instructions: FOUR_PARTS, description: 'Changes the case of text.', model: 'ollama/qwen3-coder:30b', nodeTools, ...extra } }] }
        : { text: '', toolCalls: [] },
  });
  const previous = process.env.OLLAMA_URL;
  process.env.OLLAMA_URL = fake.origin;
  return {
    fake,
    done: async () => {
      if (previous === undefined) delete process.env.OLLAMA_URL;
      else process.env.OLLAMA_URL = previous;
      await fake.close();
    },
  };
}

describe('POST /api/agents/design with base and change', () => {
  beforeAll(() => {
    registry.registerBuiltin(corePlugin);
    registry.registerBuiltin(textToolkit);
  });

  it('a pending card’s config plus “add Slugify as a tool”: the base’s tools and Slugify, the change named, nothing saved', async () => {
    const run = await proposing('text-toolkit.changeCase, text-toolkit.slugify');
    try {
      const before = agentStore.list().length;
      const res = await post({ name: 'Text helper', preview: true, base: { config: baseConfig() }, change: 'add Slugify as a tool' });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { config: AgentConfig; changes: string[]; agent?: unknown };
      expect(body.config.tools.map((t) => ('name' in t ? t.name : t.type))).toEqual(['Change Case', 'slugify']);
      expect(body.changes).toEqual(['Adds the tool Slugify']);
      expect(body.config.avatar).toEqual({ kind: 'face', face: 'ada' });
      expect(body.config.guardrails).toEqual(DEFAULT_BRIEF_GUARDRAILS);
      expect(body.agent).toBeUndefined();
      expect(agentStore.list().length).toBe(before);
    } finally {
      await run.done();
    }
  });

  it('ag1-int: a proposal that leaves out the tool the change names: the tool is added all the same; one no plugin has is said, not dropped', async () => {
    const run = await proposing('text-toolkit.changeCase');
    try {
      const body = (await (await post({ name: 'Text helper', preview: true, base: { config: baseConfig() }, change: 'add Slugify as a tool' })).json()) as { config: AgentConfig; changes: string[]; notAdded: unknown[] };
      expect(body.config.tools.some((t) => t.type === 'node' && t.nodeType === 'text-toolkit.slugify')).toBe(true);
      expect(body.changes).toEqual(['Adds the tool Slugify']);
      expect(body.notAdded).toEqual([]);
      expect(body.config.guardrails).toEqual(DEFAULT_BRIEF_GUARDRAILS);
      const slack = (await (await post({ name: 'Text helper', preview: true, base: { config: baseConfig() }, change: 'also post the result to Slack' })).json()) as { changes: string[]; notAdded: unknown[] };
      expect(slack.changes).toEqual([]);
      expect(slack.notAdded).toEqual([{ name: 'Slack', reason: 'no plugin online has it' }]);
      // A tool the change removes or refuses is never added back.
      const refused = (await (await post({ name: 'Text helper', preview: true, base: { config: baseConfig() }, change: 'make it shorter, do not use Slugify' })).json()) as { config: AgentConfig; notAdded: unknown[] };
      expect(refused.config.tools.map((t) => ('name' in t ? t.name : t.type))).toEqual(['Change Case']);
      expect(refused.notAdded).toEqual([]);
    } finally {
      await run.done();
    }
  });

  it('ag1-int: the reply says what was not added, and “already has what you asked” only when nothing was left out', () => {
    expect(reviseReply('Text helper', [], [], false)).toBe('No change: the card above already has what you asked.');
    expect(reviseReply('Text helper', [], [{ name: 'Slack', reason: 'no plugin online has it' }], false)).toBe('No change to the card above. Not added: Slack (no plugin online has it).');
    expect(reviseReply('Text helper', ['Adds the tool Slugify'], [{ name: 'Slack', reason: 'no plugin online has it' }], true)).toBe('Here is the change to “Text helper”: adds the tool Slugify. Not added: Slack (no plugin online has it). Review it, then apply it to its draft.');
    expect(reviseReply('Text helper', [], [], true)).toBe('No change: “Text helper” already has what you asked.');
  });

  it('keeps a base tool the proposal left out, and a change that names nothing new changes nothing', async () => {
    const run = await proposing('text-toolkit.slugify');
    try {
      const res = await post({ name: 'Text helper', preview: true, base: { config: baseConfig() }, change: 'keep it polite' });
      const body = (await res.json()) as { config: AgentConfig; changes: string[] };
      // The proposal added Slugify unasked: the change doesn’t name it, so it is left out (and said), and the base’s tool stays.
      expect(body.config.tools.map((t) => ('name' in t ? t.name : t.type))).toEqual(['Change Case']);
      expect(body.changes).toEqual([]);
    } finally {
      await run.done();
    }
  });

  it('a model that proposes nothing answers designed: false with no changes, and “without the footer” removes no tool', async () => {
    const none = await startFakeModels({ reply: () => ({ text: '', toolCalls: [] }) });
    const previous = process.env.OLLAMA_URL;
    process.env.OLLAMA_URL = none.origin;
    try {
      const body = (await (await post({ name: 'Text helper', preview: true, base: { config: baseConfig() }, change: 'add Slugify as a tool' })).json()) as { designed: boolean; changes: string[] };
      expect(body).toMatchObject({ designed: false, changes: [] });
    } finally {
      if (previous === undefined) delete process.env.OLLAMA_URL;
      else process.env.OLLAMA_URL = previous;
      await none.close();
    }
    const run = await proposing('text-toolkit.changeCase');
    try {
      const res = await post({ name: 'Text helper', preview: true, base: { config: baseConfig() }, change: 'also do the case change without the footer' });
      const out = (await res.json()) as { config: AgentConfig };
      expect(out.config.tools.map((t) => ('name' in t ? t.name : t.type))).toEqual(['Change Case']);
    } finally {
      await run.done();
    }
  });

  it('removes a tool only when the change says so', async () => {
    const run = await proposing('');
    try {
      const res = await post({ name: 'Text helper', preview: true, base: { config: baseConfig() }, change: 'remove the case tool' });
      const body = (await res.json()) as { changes: string[] };
      expect(body.changes).toEqual(['Removes the tool Change Case']);
    } finally {
      await run.done();
    }
  });

  it('an existing agent: its draft is the base, a rename is the change’s, and guardrails it never had are not added', async () => {
    const agent = agentStore.create({ ...baseConfig(), guardrails: undefined } as AgentConfig);
    const run = await proposing('text-toolkit.changeCase');
    try {
      const before = JSON.stringify(agentStore.get(agent.id));
      const res = await post({ name: 'Text helper', preview: true, base: { agentId: agent.id }, change: 'call it Alert triager' });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { config: AgentConfig; changes: string[] };
      expect(body.config.name).toBe('Alert triager');
      expect(body.changes).toEqual(['Renames it to Alert triager']);
      // The base’s schedules, channels and the rest stay, and nothing was saved.
      expect(body.config.memory).toEqual({ crossSession: false });
      expect(body.config.guardrails).toBeUndefined();
      expect(JSON.stringify(agentStore.get(agent.id))).toBe(before);
    } finally {
      await run.done();
    }
  });

  it('an agent the caller cannot edit is 404; one that does not exist too', async () => {
    const other = agentStore.create(baseConfig() as AgentConfig);
    foreign.add(other.id);
    try {
      expect((await post({ name: 'x', preview: true, base: { agentId: other.id }, change: 'use Haiku' })).status).toBe(404);
      expect((await post({ name: 'x', preview: true, base: { agentId: 'ag_missing' }, change: 'use Haiku' })).status).toBe(404);
    } finally {
      foreign.delete(other.id);
    }
  });

  it('a change without preview, and base without change (or the reverse), is 400', async () => {
    expect((await post({ name: 'x', base: { config: baseConfig() }, change: 'add Slugify as a tool' })).status).toBe(400);
    expect((await post({ name: 'x', preview: true, base: { config: baseConfig() } })).status).toBe(400);
    expect((await post({ name: 'x', preview: true, change: 'add Slugify as a tool' })).status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// The editor: the follow-up, the change card, Apply, Publish
// ---------------------------------------------------------------------------

const UTILITY = 'Create an agent that decodes JWTs, hashes strings and makes UUIDs';
const tool = (name: string, nodeType: string, extra: Record<string, unknown> = {}) => ({ id: `t_${name}`, type: 'node', name, description: name, nodeType, parameters: {}, ...extra });
const cardConfig = () => ({ name: 'Utility agent', description: 'Decodes JWTs, hashes strings and makes UUIDs.', instructions: 'Use the tools.', model: { provider: 'ollama', model: 'qwen3-coder:30b' }, tools: [tool('Hash', 'go-crypto.hash'), tool('UUID', 'go-crypto.uuid')], skills: [], schedules: [], channels: [], memory: { crossSession: false }, settings: {} });
const withSlugify = () => ({ ...cardConfig(), tools: [...cardConfig().tools, tool('Slugify', 'text-toolkit.slugify')] });
const preview = (config: Record<string, unknown> = cardConfig(), extra: Record<string, unknown> = {}) => ({ config, needs: [], missing: [], dropped: [], designed: true, cases: [{ input: 'Hash hello' }], ...extra });

const cardOf = () => {
  for (const item of [...useAssistant.getState().items].reverse()) {
    if (item.role !== 'assistant') continue;
    const part = item.parts.find((p) => p.kind === 'agentCard');
    if (part?.kind === 'agentCard') return { id: item.id, card: part.card };
  }
  return undefined;
};
const cardCount = () => useAssistant.getState().items.filter((i) => i.role === 'assistant' && i.parts.some((p) => p.kind === 'agentCard')).length;

beforeEach(() => {
  calls.length = 0;
  answers = {
    '/api/agents/import': () => ({ agent: { id: 'ag_new', name: 'Utility agent' } }),
    '/api/agents/ag_new/eval-gate': () => ({ case: { id: 'k1' } }),
    '/api/expressions/preview': () => ({ ok: true, value: 'Hash hello' }),
    '/api/agents/ag_new/smoke-test': () => ({ smoke: { state: 'passed', reply: 'ok', ms: 5 } }),
    '/api/agents/ag_new/publish': () => ({ ok: true }),
    '/api/agents/ag_new': () => ({ agent: { id: 'ag_new', ...cardConfig() } }),
    '/api/agents/design': () => preview(),
    '/api/ai/build': () => {
      throw new Error('the builder must not be called');
    },
  };
  registry.registerBuiltin(corePlugin);
  useAssistant.getState().reset();
  useEditor.setState({ nodes: [], edges: [], pinData: {}, name: 'Untitled workflow', description: '', workflowId: 'wf_ag04', nodeTypes: {} as never });
  useAutonomous.setState({ on: false });
});

/** The card the utility ask made, waiting for Create. */
async function pending() {
  await designAgentCard(UTILITY, cardAskFor(UTILITY)!, { starter: true });
  calls.length = 0;
  return cardOf()!;
}

describe('a follow-up under a pending card', () => {
  it('"add Slugify as a tool" on an empty canvas revises the card: the design route with base and change, never the builder or a plan', async () => {
    const { id } = await pending();
    const before = cardCount();
    answers['/api/agents/design'] = () => ({ ...preview(withSlugify()), changes: ['Adds the tool Slugify'] });
    const target = reviseCardFor('add Slugify as a tool');
    expect(target?.itemId).toBe(id);
    await reviseAgentCard(target!.itemId, target!.card, 'add Slugify as a tool');
    expect(calls.map((c) => c.path)).toEqual(['/api/agents/design']);
    expect(calls[0].json).toMatchObject({ preview: true, change: 'add Slugify as a tool', base: { config: expect.objectContaining({ name: 'Utility agent' }) } });
    expect(calls.some((c) => c.path.startsWith('/api/ai/build'))).toBe(false);
    // Replaced in place: the same reply item, no second card, still waiting for Create.
    expect(cardCount()).toBe(before);
    expect(cardOf()).toMatchObject({ id, card: { state: 'designed', starter: true, changes: ['Adds the tool Slugify'] } });
    expect(cardOf()!.card.tools.map((t) => t.name)).toEqual(['Hash', 'UUID', 'Slugify']);
    expect(calls.some((c) => c.path === '/api/agents/import')).toBe(false);
    expect(useEditor.getState().nodes).toHaveLength(0);
  });

  it('a change that changes nothing says so and keeps the card', async () => {
    const { id } = await pending();
    answers['/api/agents/design'] = () => ({ ...preview(), changes: [] });
    await reviseAgentCard(id, cardOf()!.card, 'keep it polite');
    expect(cardOf()!.card.changes).toEqual([]);
    expect(cardOf()!.card.tools.map((t) => t.name)).toEqual(['Hash', 'UUID']);
  });

  it('a question under the card is the chat’s: answered, not a revise and not a plan; the card stays', async () => {
    await pending();
    expect(reviseCardFor('why does it need the Hash tool?')).toBeUndefined();
    expect(agentCardQuestion('why does it need the Hash tool?')).toBe(true);
    expect(agentCardQuestion('add Slugify as a tool')).toBe(false);
    expect(calls).toEqual([]);
    expect(cardOf()!.card).toMatchObject({ state: 'designed' });
  });

  it('"create an agent that …" still makes a new card, and a change with no card is nobody’s', async () => {
    expect(reviseCardFor('add Slugify as a tool')).toBeUndefined();
    await pending();
    expect(reviseCardFor('create an agent that summarises incidents for the on-call channel')).toBeUndefined();
    expect(agentCardQuestion('what tools does it have?')).toBe(true);
  });
});

describe('a second follow-up on an empty canvas', () => {
  const asChat = (since: number, text: string) => {
    useAssistant.setState((st) => ({ items: [...st.items, { id: `c${st.items.length}`, role: 'user' as const, text: 'why?' }, { id: `a${st.items.length}`, role: 'assistant' as const, parts: [{ kind: 'text' as const, text }] }] }));
    return since;
  };

  it('two changes in a row both target the same card', async () => {
    const { id } = await pending();
    answers['/api/agents/design'] = () => ({ ...preview(withSlugify()), changes: ['Adds the tool Slugify'] });
    const t1 = reviseCardFor('add Slugify as a tool');
    await reviseAgentCard(t1!.itemId, t1!.card, 'add Slugify as a tool');
    const t2 = reviseCardFor('also make it shorter');
    expect(t2?.itemId).toBe(id);
    expect(t2?.card.tools.map((t) => t.name)).toContain('Slugify');
  });

  it('a question after a revise is still the chat’s, never a plan or a build', async () => {
    await pending();
    answers['/api/agents/design'] = () => ({ ...preview(withSlugify()), changes: ['Adds the tool Slugify'] });
    const t1 = reviseCardFor('add Slugify as a tool');
    await reviseAgentCard(t1!.itemId, t1!.card, 'add Slugify as a tool');
    expect(agentCardQuestion('why does it need the Hash tool?')).toBe(true);
    expect(reviseCardFor('why does it need the Hash tool?')).toBeUndefined();
    expect(calls.some((c) => c.path.startsWith('/api/ai/build'))).toBe(false);
  });

  it('the chat’s answer to a question keeps the card the newest; an untagged chat reply blocks the revise', async () => {
    const { id } = await pending();
    const since = useAssistant.getState().items.length;
    const under = cardQuestionFor('why does it need the Hash tool?');
    expect(under).toBe(id);
    asChat(since, 'Because it hashes.');
    keepUnderCard(since, under!);
    expect(reviseCardFor('add Slugify as a tool')?.itemId).toBe(id);
    asChat(useAssistant.getState().items.length, 'An unrelated chat reply.');
    expect(reviseCardFor('add Slugify as a tool')).toBeUndefined();
    expect(agentCardQuestion('why does it need the Hash tool?')).toBe(false);
  });

  it('Try again on a failed revise revises again: same base and change, never the chat or the builder', async () => {
    const { id } = await pending();
    let fail = true;
    answers['/api/agents/design'] = () => {
      if (fail) throw new Error('the model is down');
      return { ...preview(withSlugify()), changes: ['Adds the tool Slugify'] };
    };
    const send = vi.spyOn(useAssistant.getState(), 'send');
    await reviseAgentCard(id, cardOf()!.card, 'add Slugify as a tool');
    const failed = useAssistant.getState().items.at(-1)!;
    expect(failed).toMatchObject({ role: 'assistant', retry: { kind: 'agentRevise', itemId: id } });
    fail = false;
    calls.length = 0;
    retryReply(failed.id);
    await vi.waitFor(() => expect(cardOf()!.card.tools.map((t) => t.name)).toContain('Slugify'));
    expect(calls.map((c) => c.path)).toEqual(['/api/agents/design']);
    expect(calls[0].json).toMatchObject({ change: 'add Slugify as a tool', base: { config: expect.objectContaining({ name: 'Utility agent' }) } });
    expect(send).not.toHaveBeenCalled();
    expect(calls.some((c) => c.path.startsWith('/api/ai/build'))).toBe(false);
  });
});

describe('a workflow edit after an agent card', () => {
  const step = (id: string, name: string) => ({ id, type: 'lf', position: { x: 0, y: 0 }, data: { wf: { id, name, type: 'core.webhook' } } });

  it('with a starter flow on the canvas, workflow-shaped asks are the builder’s and never revise the card', async () => {
    const { id, card } = await pending();
    await createFromCard(id, card);
    useEditor.setState({ nodes: [step('n1', 'Webhook'), step('n2', 'Run an Agent')] as never });
    for (const m of ['add an HTTP Request step after the trigger', 'add a Slack node after the agent', 'change the schedule to every hour', 'remove the email node', 'connect the trigger to the agent', 'set the cron to 9am', 'make the webhook POST only', 'add a delay after Webhook'])
      expect(reviseCardFor(m), m).toBeUndefined();
    // A change to the agent itself still revises.
    expect(reviseCardFor('use Haiku')?.itemId).toBe(id);
  });

  it('a change typed after a later reply that has no card does not revise the old card', async () => {
    await pending();
    expect(reviseCardFor('add Slugify as a tool')).toBeDefined();
    useAssistant.getState().append([{ id: 'u9', role: 'user', text: 'what is this?' }, { id: 'a9', role: 'assistant', parts: [{ kind: 'text', text: 'A flow.' }] } as never]);
    expect(reviseCardFor('add Slugify as a tool')).toBeUndefined();
    expect(agentCardQuestion('why does it need the Hash tool?')).toBe(false);
  });

  it('a design the model never proposed is a failure, not “No change”', async () => {
    const { id } = await pending();
    answers['/api/agents/design'] = () => ({ ...preview(), changes: [], designed: false });
    await reviseAgentCard(id, cardOf()!.card, 'add Slugify as a tool');
    const last = [...useAssistant.getState().items].reverse().find((i) => i.role === 'assistant');
    expect(JSON.stringify(last)).toContain('Nothing was changed');
    expect(JSON.stringify(last)).toContain('the model proposed nothing');
    expect(JSON.stringify(last)).not.toContain('No change: the card above');
  });
});

describe('Apply on an agent’s page against a draft that moved', () => {
  const draftOf = (config: Record<string, unknown>) => ({ id: 'ag_p', ...config });
  it('card 2, designed without Slugify, says it removes Slugify once card 1 was applied, and saves nothing', async () => {
    const d0 = cardConfig();
    const snapshot = JSON.stringify(draftOf(d0)); // both cards were designed from this draft
    answers = { '/api/agents/ag_p': () => ({ agent: draftOf(withSlugify()) }) }; // card 1 (Slugify) was applied since
    expect(await draftMoved('ag_p', snapshot, { ...d0, description: 'Shorter.' })).toMatchObject({ changes: expect.arrayContaining(['Removes the tool Slugify']) });
    // An unchanged draft: Apply goes ahead.
    answers = { '/api/agents/ag_p': () => ({ agent: draftOf(d0) }) };
    expect(await draftMoved('ag_p', snapshot, d0)).toBeUndefined();
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  it('designChange fails when the model proposed nothing', async () => {
    answers = { '/api/agents/design': () => ({ config: cardConfig(), changes: [], designed: false }) };
    await expect(designChange({ name: 'x', base: { agentId: 'ag_p' }, change: 'add Slugify as a tool' })).rejects.toThrow('the model proposed nothing');
  });
});

describe('a change to a created agent', () => {
  it('is a new card with Apply to its draft; nothing is saved until it is clicked, also with autonomy on', async () => {
    const { id, card } = await pending();
    useAutonomous.setState({ on: true });
    await createFromCard(id, card);
    calls.length = 0;
    answers['/api/agents/design'] = () => ({ ...preview(withSlugify()), changes: ['Adds the tool Slugify'] });
    const target = reviseCardFor('add Slugify as a tool')!;
    expect(target.card.state).toBe('created');
    const before = cardCount();
    await reviseAgentCard(target.itemId, target.card, 'add Slugify as a tool');
    expect(calls[0]).toMatchObject({ path: '/api/agents/design', json: { base: { agentId: 'ag_new' }, change: 'add Slugify as a tool', preview: true } });
    expect(calls.filter((c) => c.method === 'PUT' || c.path.includes('smoke-test') || c.path.includes('publish') || c.path === '/api/agents/import')).toEqual([]);
    expect(cardCount()).toBe(before + 1);
    expect(cardOf()!.card).toMatchObject({ state: 'designed', base: { agentId: 'ag_new', name: 'Utility agent' }, changes: ['Adds the tool Slugify'] });
    // The created card is as it was.
    expect(useAssistant.getState().items.flatMap((i) => (i.role === 'assistant' ? i.parts : [])).filter((p) => p.kind === 'agentCard' && p.card.state === 'created')).toHaveLength(1);
  });
});

describe('Apply to its draft', () => {
  const changeCard = (): AgentCard => ({ name: 'Grafana observer', description: 'Watches alerts.', tools: [], practices: true, guardrails: [], cases: [], needs: [], missing: [], config: { name: 'Grafana observer', tools: [] }, state: 'designed', base: { agentId: 'ag_g', name: 'Grafana observer' }, changes: ['Adds the tool Get Alert Details'] });
  const shown = async (card: AgentCard) => {
    useAssistant.getState().append([{ id: 'r1', role: 'assistant', parts: [{ kind: 'agentCard', card }] } as never]);
    calls.length = 0;
  };
  beforeEach(() => {
    answers = {
      '/api/agents/ag_g/smoke-test': () => ({ smoke: { state: 'passed', reply: 'ok', ms: 3 } }),
      '/api/agents/ag_g/publish': () => ({ agent: {} }),
      '/api/agents/ag_g': () => ({ agent: {} }),
    };
  });

  it('saves the draft (PUT), then the smoke test; publishes nothing', async () => {
    await shown(changeCard());
    await applyAgentChange('r1', cardOf()!.card);
    expect(calls.map((c) => [c.method ?? 'GET', c.path])).toEqual([['PUT', '/api/agents/ag_g'], ['POST', '/api/agents/ag_g/smoke-test']]);
    expect(calls[0].json).toEqual({ name: 'Grafana observer', tools: [] });
    expect(cardOf()!.card).toMatchObject({ state: 'created', agentId: 'ag_g', smoke: { state: 'passed' } });
    expect(calls.some((c) => c.path.endsWith('/publish'))).toBe(false);
  });

  it('Publish only after a pass, with no skipEval; a failed test offers none', async () => {
    await shown(changeCard());
    await applyAgentChange('r1', cardOf()!.card);
    calls.length = 0;
    await publishAgentChange('r1', cardOf()!.card);
    expect(calls).toEqual([{ path: '/api/agents/ag_g/publish', method: 'POST', json: undefined }]);
    expect(cardOf()!.card.publish).toEqual({ state: 'published' });
    // A test that failed: Publish does nothing.
    useAssistant.getState().reset();
    answers['/api/agents/ag_g/smoke-test'] = () => ({ smoke: { state: 'failed', reason: 'no reply' } });
    await shown(changeCard());
    await applyAgentChange('r1', cardOf()!.card);
    calls.length = 0;
    await publishAgentChange('r1', cardOf()!.card);
    expect(calls).toEqual([]);
  });

  it('the eval gate’s hold is shown on the card: held, with the score and why; nothing else is sent', async () => {
    await shown(changeCard());
    await applyAgentChange('r1', cardOf()!.card);
    answers['/api/agents/ag_g/publish'] = () => {
      throw new ApiError('held', 409, { gate: { verdict: { ok: false, average: 2.3, reason: 'Below 3 / 5' } } });
    };
    calls.length = 0;
    await publishAgentChange('r1', cardOf()!.card);
    expect(cardOf()!.card.publish).toEqual({ state: 'held', score: 2.3, reason: 'Below 3 / 5' });
    expect(calls).toHaveLength(1);
    expect(calls[0].json).toBeUndefined();
  });

  it('a failed save is the card’s error and Try again, with no test and no publish', async () => {
    await shown(changeCard());
    answers['/api/agents/ag_g'] = () => {
      throw new Error('Agent not found');
    };
    await applyAgentChange('r1', cardOf()!.card);
    expect(cardOf()!.card).toMatchObject({ state: 'failed', error: 'Agent not found' });
    expect(calls.filter((c) => c.path.includes('smoke') || c.path.includes('publish'))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The shell
// ---------------------------------------------------------------------------

describe('the shell Spotlight on an agent’s page', () => {
  it('an agent’s page is the agent mode; new, teams and a team’s page are not', () => {
    expect(modeForRoute('/agents/ag_1')).toEqual({ kind: 'agent', agentId: 'ag_1', name: 'this agent' });
    expect(modeForRoute('/agents/ag_1', { agentName: 'Alert triager' })).toEqual({ kind: 'agent', agentId: 'ag_1', name: 'Alert triager' });
    expect(modeForRoute('/agents/new').kind).toBe('brain');
    expect(modeForRoute('/agents/teams').kind).toBe('brain');
    expect(modeForRoute('/agents/teams/t_1').kind).toBe('brain');
    expect(modeForRoute('/agents').kind).toBe('brain');
  });

  it('the chip reads “Changing <name>”; about wins; “Ask the brain instead” gives the brain', () => {
    const mode = spotlightMode('/agents/ag_1', INITIAL_STATE, undefined, 'Alert triager');
    expect(mode).toEqual({ kind: 'agent', agentId: 'ag_1', name: 'Alert triager' });
    expect(chipLabel(mode)).toBe('Changing Alert triager');
    expect(spotlightMode('/agents/ag_1', { ...INITIAL_STATE, about: { ref: { type: 'run', id: 'r', name: 'run' }, starters: [] } }).kind).toBe('about');
    expect(spotlightMode('/agents/ag_1', { ...INITIAL_STATE, askInstead: true }, undefined, 'Alert triager').kind).toBe('brain');
  });

  it('switchFor offers the brain from the agent mode, and the change panel from the brain', () => {
    expect(switchFor({ kind: 'agent', agentId: 'ag_1', name: 'Alert triager' }, false, { id: 'ag_1', name: 'Alert triager' })?.label).toBe('Ask the brain instead');
    expect(switchFor({ kind: 'brain' }, false, { id: 'ag_1', name: 'Alert triager' })?.label).toBe('Change Alert triager instead');
    expect(switchFor({ kind: 'brain' }, false)).toBeUndefined();
  });
});
