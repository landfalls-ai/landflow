/**
 * SB16: Agents from Spotlight, anywhere (docs/assistant.md "Agents from Spotlight"): "create an agent" is read on any
 * canvas (`agentAsk`), designed as a card to review and create (the design route's `preview`), created on the person's
 * Create (or alone on a brand-new draft in autonomous mode), and on an empty canvas laid out with a starter flow.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LanguageModel, ModelTurn, Workflow } from '@landflow/engine';
import { agentAsk } from '@/lib/shared/agent-ask';
import { starterFlow, starterSample, type AgentCard } from '@/lib/shared/agent-card';
import { writesOutside } from '@/lib/shared/run-check';
import type { NodeTypeInfo } from '@/lib/shared/types';
import { agentStore } from '@/lib/server/agents/store';
import { corePlugin } from '@/lib/server/nodes';
import { registry } from '@/lib/server/plugins/registry';
import { runChat, type ChatEvent } from '@/lib/server/assistant/chat';
import { startFakeModels } from './fake-ai-services';

// The editor's calls go to a recorder that answers like the routes do; nothing leaves this machine.
const calls: Array<{ path: string; json?: Record<string, unknown> }> = [];
let answers: Record<string, (json?: Record<string, unknown>) => unknown> = {};
vi.mock('@/lib/client/api', () => ({
  api: vi.fn(async (path: string, init: { json?: Record<string, unknown> } = {}) => {
    calls.push({ path, json: init.json });
    const answer = Object.entries(answers).find(([prefix]) => path.startsWith(prefix))?.[1];
    if (!answer) throw new Error(`no answer for ${path}`);
    return answer(init.json);
  }),
}));

const { cardAskFor, createFromCard, designAgentCard } = await import('@/components/editor/spotlight/agent-ask');
const { useAssistant } = await import('@/components/editor/assistant');
const { useEditor } = await import('@/components/editor/store');
const { useAutonomous } = await import('@/components/editor/autonomous');
const { noteOpened } = await import('@/components/editor/spotlight-autonomy');

const SB00_PR = 'create an agent that reviews pull requests against our practices, and run it after Sample PR';
const SB00_DOCS = 'an agent that answers customer questions from the docs knowledge base with a Linear tool';
const SB05 = 'add an agent after Sample question that answers from our docs and can look up Linear issues';
const B_ASKS = [
  'Every weekday at 8, read new Linear issues labelled bug, have an agent triage each into P0–P3 with a reason, post P0s to Slack #oncall and put the rest in a data table',
  'When a webhook receives an order, if the total is over 1000 POST it to http://127.0.0.1:3399/vip as JSON with a field "vip": true, otherwise POST it to http://127.0.0.1:3399/regular; then respond to the webhook with {"ok": true}',
  'When a chat message arrives, have my Support triage agent answer it; if it cannot answer, hand it to a person for approval, then reply in the chat',
];

describe('agentAsk', () => {
  it('reads third-person verbs, a named agent, and tidies names', () => {
    expect(agentAsk('Build an agent that reads Linear issues and creates GitHub issues', [])?.tools).toEqual(['Linear: read issues', 'GitHub: create issues']);
    expect(agentAsk('I want an agent that posts to Slack when a build fails', [])?.tools).toEqual(['Slack: post a message']);
    expect(agentAsk('create an agent that looks up HubSpot records', [])?.tools).toEqual(['HubSpot: look up records']);
    expect(agentAsk('create a new agent named Sales helper that answers pricing questions', [])).toMatchObject({ name: 'Sales helper' });
    expect(agentAsk('create an agent that reviews PRs', [])?.name).toBe('PR reviewer');
    expect(agentAsk('add an agent after “Sample PR” that reviews it', ['Sample PR'])).toMatchObject({ description: 'Reviews it.' });
    expect(agentAsk('add an agent that reviews it', [])?.name).toBeUndefined();
  });

  it('reads the evaluation\'s agent asks, with the tools and knowledge they name', () => {
    expect(agentAsk(SB00_PR, [])).toMatchObject({ placed: false, tools: [], name: 'PR reviewer' });
    expect(agentAsk(SB00_PR, [])?.description).toMatch(/^Reviews pull requests against our practices/);
    expect(agentAsk(SB00_DOCS, [])).toMatchObject({ placed: false, tools: ['Linear: use issues'], knowledge: 'docs', name: 'Docs answerer' });
    expect(agentAsk('make me an agent that triages bugs', [])).toMatchObject({ placed: false, name: 'Bug triager' });
    expect(agentAsk('create an agent that summarises incidents for the on-call channel', ['Start'])).toMatchObject({ placed: false, name: 'Incident summariser' });
  });

  it('knows a placed ask: it names a step that exists, this flow, or "as a step"', () => {
    expect(agentAsk(SB05, ['Start', 'Sample question', 'Reply'])).toMatchObject({ placed: true, tools: ['Linear: look up issues'], knowledge: 'docs' });
    expect(agentAsk(SB00_PR, ['Sample PR'])?.placed).toBe(true);
    expect(agentAsk('create an agent that triages bugs and add it to this flow', ['Start'])?.placed).toBe(true);
    expect(agentAsk('create an agent that triages bugs as a step', ['Start'])?.placed).toBe(true);
    expect(agentAsk(SB05, ['Start'])?.placed).toBe(false);
  });

  it('reads the tools an ask names, at most 8 of 80 characters', () => {
    expect(agentAsk('create an agent that can post to Slack and read GitHub pull requests', [])?.tools).toEqual(['Slack: post a message', 'GitHub: read pull requests']);
    const many = agentAsk('create an agent that can look up Linear issues, read Slack messages, read GitHub pull requests, read Jira issues, read Notion pages, read Gmail emails, read Zendesk tickets, read Stripe payments, read Attio records', [])!;
    expect(many.tools.length).toBeLessThanOrEqual(8);
    expect(many.tools.every((t) => t.length <= 80)).toBe(true);
  });

  it('is not an agent ask: B1-B9, a question, an agent that exists, an AI Agent step', () => {
    for (const ask of B_ASKS) expect(agentAsk(ask, ['Start'])).toBeUndefined();
    expect(agentAsk('have my Support triage agent answer it', ['Start'])).toBeUndefined();
    expect(agentAsk('why did the agent fail?', ['Start'])).toBeUndefined();
    expect(agentAsk('why did the last run fail?', ['Start'])).toBeUndefined();
    expect(agentAsk('add an AI Agent step', ['Start'])).toBeUndefined();
    expect(agentAsk('add an agent step after Start', ['Start'])).toBeUndefined();
    expect(agentAsk('how do I create an agent?', ['Start'])).toBeUndefined();
    expect(agentAsk('', [])).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The design route's preview
// ---------------------------------------------------------------------------

describe('POST /api/agents/design with preview', () => {
  beforeAll(() => registry.registerBuiltin(corePlugin));

  it('answers the design and creates no agent; without preview it saves one (201), as before', async () => {
    const fake = await startFakeModels({
      reply: (_provider, body) => (Array.isArray((body as { messages?: unknown })?.messages) ? { text: '', toolCalls: [{ id: 'c1', name: 'propose_design', arguments: { summary: 'x', name: 'PR reviewer', role: 'Reviewer', instructions: 'Review pull requests.', model: 'ollama/qwen3-coder:30b' } }] } : { text: '', toolCalls: [] }),
    });
    const previous = process.env.OLLAMA_URL;
    process.env.OLLAMA_URL = fake.origin;
    try {
      const { POST } = await import('@/app/api/agents/design/route');
      const request = (body: unknown) => new Request('http://localhost/api/agents/design', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const before = agentStore.list().length;
      const preview = await POST(request({ name: 'PR reviewer', description: 'Reviews pull requests.', preview: true }));
      expect(preview.status).toBe(200);
      const body = (await preview.json()) as { config: { name: string; instructions: string }; cases: unknown[]; agent?: unknown };
      expect(body.config).toMatchObject({ name: 'PR reviewer' });
      expect(body.cases).toEqual([]);
      expect(body.agent).toBeUndefined();
      expect(agentStore.list().length).toBe(before);
      const saved = await POST(request({ name: 'PR reviewer', description: 'Reviews pull requests.' }));
      expect(saved.status).toBe(201);
      expect(agentStore.list().length).toBe(before + 1);
    } finally {
      if (previous === undefined) delete process.env.OLLAMA_URL;
      else process.env.OLLAMA_URL = previous;
      await fake.close();
    }
  });
});

// ---------------------------------------------------------------------------
// The editor: the ask, the card, Create
// ---------------------------------------------------------------------------

const info = (type: string) => ({ type, pluginId: 'core', descriptor: { name: type, displayName: type, version: 1, properties: [], inputs: [], outputs: [] } }) as unknown as NodeTypeInfo;
const node = (id: string, name: string) => ({ id, type: 'lf', position: { x: 0, y: 0 }, data: { wf: { id, name, type: 'core.manualTrigger', typeVersion: 1, parameters: {} } } }) as never;

const preview = (extra: Record<string, unknown> = {}) => ({
  config: { name: 'PR reviewer', description: 'Reviews pull requests against our practices.', instructions: 'Review.', model: { provider: 'ollama', model: 'qwen3-coder:30b' }, tools: [{ id: 't1', type: 'node', name: 'github_pull_request', nodeType: 'github.pullRequest', parameters: { operation: 'get' } }, { id: 't2', type: 'node', name: 'github_comment', nodeType: 'github.pullRequest', parameters: { operation: 'createComment' } }], skills: [], schedules: [], channels: [], memory: { crossSession: false }, settings: {} },
  needs: [{ text: 'Pick a GitHub credential' }],
  missing: [],
  dropped: [],
  designed: true,
  cases: [{ input: 'Review PR 12', expected: 'Mentions the practice' }, { input: 'Review PR 13' }],
  ...extra,
});

const created = { agent: { id: 'ag_new', name: 'PR reviewer' } };
const cardOf = () => {
  for (const item of useAssistant.getState().items) {
    if (item.role !== 'assistant') continue;
    const part = item.parts.find((p) => p.kind === 'agentCard');
    if (part?.kind === 'agentCard') return { id: item.id, card: part.card };
  }
  return undefined;
};

beforeEach(() => {
  calls.length = 0;
  answers = {
    '/api/agents/import': () => created,
    '/api/agents/ag_new/eval-gate': () => ({ case: { id: 'k1' } }),
    // Integration (sb3): Create ends with SB18's smoke test on the starter's pinned item.
    '/api/expressions/preview': () => ({ ok: true, value: 'Review PR 12' }),
    '/api/agents/ag_new/smoke-test': () => ({ smoke: { state: 'passed', reply: 'Looks fine.', ms: 5 } }),
    '/api/agents/ag_new/publish': () => ({ ok: true }),
    '/api/agents/design': () => preview(),
    '/api/ai/build': () => {
      throw new Error('the builder must not be called');
    },
  };
  registry.registerBuiltin(corePlugin);
  useAssistant.getState().reset();
  useEditor.setState({ nodes: [], edges: [], pinData: {}, name: 'Untitled workflow', description: '', workflowId: 'wf_sb16', nodeTypes: { 'core.chatTrigger': { ...info('core.chatTrigger'), descriptor: { ...info('core.chatTrigger').descriptor, kind: 'trigger' } }, 'core.messageAgent': info('core.messageAgent') } as never });
  useAutonomous.setState({ on: false });
});

describe('Spotlight on an agent ask', () => {
  it('an empty canvas gives the PR-review ask the card (the design route, preview) and never the builder', async () => {
    const ask = cardAskFor(SB00_PR);
    expect(ask).toBeDefined();
    await designAgentCard(SB00_PR, ask!, { starter: true });
    expect(calls.map((c) => c.path)).toEqual(['/api/agents/design']);
    expect(calls[0].json).toMatchObject({ preview: true, name: 'PR reviewer' });
    const shown = cardOf()!.card;
    expect(shown).toMatchObject({ name: 'PR reviewer', state: 'designed', starter: true, model: 'ollama/qwen3-coder:30b', needs: ['Pick a GitHub credential'] });
    // A node tool that writes is marked; a read is not.
    expect(shown.tools.map((t) => [t.name, t.writes])).toEqual([['github_pull_request', false], ['github_comment', true]]);
    // Integration (sb3): the card's "writes" is SB17's `writesOutside`, the one heuristic the brief puts behind approval.
    const configTools = (preview().config.tools as Array<{ nodeType: string; parameters: Record<string, unknown> }>).map((t) => writesOutside({ type: t.nodeType, parameters: t.parameters }));
    expect(shown.tools.map((t) => t.writes)).toEqual(configTools);
    expect(useEditor.getState().nodes).toHaveLength(0);
  });

  it('shows the design as an agent being designed, never as a flow being drafted, and clears it after', async () => {
    const seen: Array<{ drafting: boolean; designing: string[] }> = [];
    answers['/api/agents/design'] = (() => {
      const s = useAssistant.getState();
      seen.push({ drafting: s.drafting, designing: s.agents.filter((a) => a.state === 'designing').map((a) => a.name) });
      return preview();
    }) as never;
    await designAgentCard(SB00_PR, cardAskFor(SB00_PR)!, { starter: true });
    expect(seen).toEqual([{ drafting: false, designing: ['PR reviewer'] }]);
    expect(useAssistant.getState().agents.filter((a) => a.state === 'designing')).toEqual([]);
  });

  it('an agent ask stops a plan card that is waiting for Build it', async () => {
    const { draftWholeFlow } = await import('@/components/editor/spotlight/draft-flow');
    const plan = { name: 'Bugs', steps: [{ key: 's1', type: 'core.manualTrigger', name: 'Start', does: 'Start by hand' }], assumptions: [], cannot: [] };
    answers = { '/api/ai/build/plan': () => ({ plan, alternatives: {} }), ...answers }; // before '/api/ai/build', which it would match
    const build = vi.fn(async () => {
      throw new Error('a stopped plan must not be built');
    });
    const waiting = draftWholeFlow('Read bugs from Linear', build as never);
    const planState = () => useAssistant.getState().items.flatMap((i) => (i.role === 'assistant' ? i.parts : [])).find((p) => p.kind === 'plan');
    await vi.waitFor(() => expect(planState()).toMatchObject({ plan: { state: 'waiting' } }));
    await designAgentCard(SB00_PR, cardAskFor(SB00_PR)!, { starter: true });
    await waiting;
    expect(planState()).toMatchObject({ plan: { state: 'stopped' } });
    expect(build).not.toHaveBeenCalled();
    expect(cardOf()?.card.state).toBe('designed');
  });

  it('an ask without a name still gets one before the design', async () => {
    const message = 'create an agent that sends a weekly report';
    await designAgentCard(message, cardAskFor(message)!, { starter: true });
    expect(calls[0].json).toMatchObject({ name: 'Weekly report agent' });
  });

  it('Create after the person opened another workflow adds the agent but no starter flow', async () => {
    useEditor.setState({ workflowId: 'wf_a' });
    await designAgentCard(SB00_PR, cardAskFor(SB00_PR)!, { starter: true });
    const { id, card } = cardOf()!;
    useEditor.setState({ workflowId: 'wf_b' });
    await createFromCard(id, card);
    expect(useEditor.getState().nodes).toHaveLength(0);
    expect(cardOf()!.card.state).toBe('created');
    expect(cardOf()!.card.needs.at(-1)).toMatch(/left the workflow/);
  });

  it('on a canvas with steps an unplaced ask gives the card and the canvas is unchanged; a placed ask stays the chat\'s', async () => {
    useEditor.setState({ nodes: [node('a', 'Start'), node('b', 'Sample PR')] });
    expect(cardAskFor(SB00_PR)).toBeUndefined();
    const ask = cardAskFor('create an agent that summarises incidents for the on-call channel');
    expect(ask).toBeDefined();
    await designAgentCard('create an agent that summarises incidents for the on-call channel', ask!, { starter: false });
    expect(cardOf()!.card.starter).toBeUndefined();
    expect(useEditor.getState().nodes.map((n) => n.id)).toEqual(['a', 'b']);
    expect(calls.some((c) => c.path === '/api/ai/build')).toBe(false);
  });

  it('Create with the starter flow: one import, one eval-gate post per case, Chat message then Run an Agent with a pinned message, one undo', async () => {
    const ask = cardAskFor(SB00_PR)!;
    await designAgentCard(SB00_PR, ask, { starter: true });
    const { id, card } = cardOf()!;
    await createFromCard(id, card);
    expect(calls.filter((c) => c.path === '/api/agents/import')).toHaveLength(1);
    expect(calls.filter((c) => c.path === '/api/agents/ag_new/eval-gate').map((c) => c.json)).toEqual([{ input: 'Review PR 12', expected: 'Mentions the practice' }, { input: 'Review PR 13' }]);
    const { nodes, edges, pinData } = useEditor.getState();
    expect(nodes.map((n) => n.data.wf.type)).toEqual(['core.chatTrigger', 'core.messageAgent']);
    expect(nodes[1].data.wf.parameters.agentId).toBe('ag_new');
    expect(edges).toHaveLength(1);
    expect(pinData[nodes[0].id]?.[0]?.json).toMatchObject({ chatInput: 'Review PR 12' });
    expect(useEditor.getState().name).toBe('Chat with PR reviewer');
    expect(cardOf()!.card).toMatchObject({ state: 'created', agentId: 'ag_new' });
    // Integration (sb3): SB18's smoke test on the pinned item, then (asks-first) the row's Publish, never a publish alone.
    expect(calls.find((c) => c.path === '/api/agents/ag_new/smoke-test')?.json).toEqual({ message: 'Review PR 12' });
    expect(cardOf()!.card.smoke).toMatchObject({ state: 'passed' });
    expect(useAssistant.getState().agents.find((a) => a.agentId === 'ag_new')).toMatchObject({ nodeId: nodes[1].id, state: 'tested' });
    expect(calls.some((c) => c.path === '/api/agents/ag_new/publish')).toBe(false);
    answers['/api/agents/design'] = () => ({ deleted: true });
    useEditor.getState().undo();
    expect(useEditor.getState().nodes).toHaveLength(0);
    // ⌘Z of the starter flow takes the agent back (SB18's DELETE, which keeps one something else uses).
    await vi.waitFor(() => expect(calls.find((c) => c.path === '/api/agents/design' && c.json?.agentId === 'ag_new')?.json).toEqual({ agentId: 'ag_new', workflowId: 'wf_sb16' }));
    await vi.waitFor(() => expect(useAssistant.getState().agents.find((a) => a.agentId === 'ag_new')?.taken).toEqual({ deleted: true }));
  });

  it('repeated Creates share one ⌘Z subscription, and it ends with the last watched step', async () => {
    const { undoWatches } = await import('@/components/editor/spotlight/agent-ask');
    const subscribe = vi.spyOn(useEditor, 'subscribe');
    // Each Create gets its own agent (ag_u1, ag_u2, ag_u3), so three steps are watched, with one subscription.
    let made = 0;
    answers['/api/agents/import'] = () => ({ agent: { id: `ag_u${++made}`, name: 'PR reviewer' } });
    for (let n = 1; n <= 3; n++) {
      answers[`/api/agents/ag_u${n}/eval-gate`] = () => ({ case: { id: 'k1' } });
      answers[`/api/agents/ag_u${n}/smoke-test`] = () => ({ smoke: { state: 'passed', reply: 'Looks fine.', ms: 5 } });
      answers[`/api/agents/ag_u${n}/publish`] = () => ({ ok: true });
    }
    try {
      for (let i = 0; i < 3; i++) {
        await designAgentCard(SB00_PR, cardAskFor(SB00_PR)!, { starter: true });
        const { id, card } = cardOf()!;
        await createFromCard(id, card);
        useAssistant.getState().reset();
      }
      expect(useEditor.getState().nodes.filter((n) => n.data.wf.type === 'core.messageAgent')).toHaveLength(3);
      expect(subscribe).toHaveBeenCalledTimes(1);
      expect(undoWatches()).toEqual({ steps: 3, subscribed: true });
      // Leaving the workflow ends every watch, and the subscription with them.
      useEditor.setState({ workflowId: 'wf_other' });
      expect(undoWatches()).toEqual({ steps: 0, subscribed: false });
    } finally {
      subscribe.mockRestore();
    }
  });

  it('a step deleted by hand (not ⌘Z) keeps the agent; a failed smoke test is never published', async () => {
    answers['/api/agents/ag_new/smoke-test'] = () => ({ smoke: { state: 'failed', reason: 'The run ended with an error: no model' } });
    useAutonomous.setState({ on: true });
    noteOpened('wf_sb16', 0);
    await designAgentCard(SB00_PR, cardAskFor(SB00_PR)!, { starter: true });
    await vi.waitFor(() => expect(cardOf()!.card.smoke?.state).toBe('failed'));
    expect(calls.some((c) => c.path === '/api/agents/ag_new/publish')).toBe(false);
    const step = useEditor.getState().nodes.find((n) => n.data.wf.type === 'core.messageAgent')!;
    useEditor.getState().removeNodes([step.id]);
    expect(useEditor.getState().nodes.some((n) => n.id === step.id)).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls.some((c) => c.path === '/api/agents/design' && c.json?.agentId)).toBe(false);
  });

  it('asks first waits for Create; a failed import leaves the canvas as it was', async () => {
    await designAgentCard(SB00_PR, cardAskFor(SB00_PR)!, { starter: true });
    expect(calls.map((c) => c.path)).toEqual(['/api/agents/design']);
    answers['/api/agents/import'] = () => {
      throw new Error('Import refused');
    };
    const { id, card } = cardOf()!;
    await createFromCard(id, card);
    expect(cardOf()!.card).toMatchObject({ state: 'failed', error: 'Import refused' });
    expect(useEditor.getState().nodes).toHaveLength(0);
  });

  it('autonomous on a brand-new draft creates alone; on a saved flow it waits (D1)', async () => {
    useAutonomous.setState({ on: true });
    noteOpened('wf_sb16', 0);
    await designAgentCard(SB00_PR, cardAskFor(SB00_PR)!, { starter: true });
    await vi.waitFor(() => expect(cardOf()!.card.state).toBe('created'));
    expect(useEditor.getState().nodes).toHaveLength(2);
    // Integration (sb3): created alone, then smoke-tested, then published after the pass, in that order (D3).
    await vi.waitFor(() => expect(useAssistant.getState().agents.find((a) => a.agentId === 'ag_new')?.state).toBe('published'));
    const order = calls.map((c) => c.path).filter((p) => /import|smoke-test|publish/.test(p));
    expect(order).toEqual(['/api/agents/import', '/api/agents/ag_new/smoke-test', '/api/agents/ag_new/publish']);

    // A saved flow (published, with steps): the person decides.
    calls.length = 0;
    useAssistant.getState().reset();
    useEditor.setState({ workflowId: 'wf_saved', nodes: [node('a', 'Start')] });
    noteOpened('wf_saved', 1);
    await designAgentCard('create an agent that triages bugs', cardAskFor('create an agent that triages bugs')!, { starter: false });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(cardOf()!.card.state).toBe('designed');
    expect(calls.some((c) => c.path === '/api/agents/import')).toBe(false);
  });

  it('the starter flow is Chat message then Run an Agent with a pinned sample (the contract)', () => {
    const flow = starterFlow({ id: 'ag_1', name: 'Helper' }, starterSample({ name: 'Helper', cases: [] } as Pick<AgentCard, 'name' | 'cases'>));
    expect(flow.nodes.map((n) => n.type)).toEqual(['core.chatTrigger', 'core.messageAgent']);
    expect(flow.pinData.chat[0].json.chatInput).toBe('Hello Helper, what can you do?');
  });
});

// ---------------------------------------------------------------------------
// The chat's new agent keeps what was asked for
// ---------------------------------------------------------------------------

const sampleFlow = (): Workflow => ({
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

describe('the chat\'s new agent', () => {
  it('"… and can look up Linear issues" reaches the proposal with a Linear tool and the knowledge "docs", though the model left both out', async () => {
    registry.registerBuiltin(corePlugin);
    const types: NodeTypeInfo[] = registry.nodeTypes().filter((t) => t.pluginId === 'core');
    const events: ChatEvent[] = [];
    const agent = { op: 'newAgent', ref: 'docs', name: 'Docs Answerer', description: 'Answers from the docs.', instructions: 'Answer.', after: 'Sample question' };
    await runChat({
      messages: [{ role: 'user', content: SB05 }],
      workflow: sampleFlow(),
      model: scripted([{ toolCalls: [{ id: 'c1', name: 'propose_changes', input: { summary: 'A docs agent', ops: [agent] } }] }, { text: 'Adds the Docs Answerer agent.' }]),
      types,
      onEvent: (e) => events.push(e),
    });
    const proposal = events.find((e): e is Extract<ChatEvent, { type: 'proposal' }> => e.type === 'proposal')!;
    const spec = (proposal.ops[0] as { newAgent?: { tools?: string[]; knowledge?: string } }).newAgent;
    expect(spec?.tools).toEqual(['Linear: look up issues']);
    expect(spec?.knowledge).toBe('docs');
  });

  it('keeps what the model wrote itself and adds nothing the message did not say', async () => {
    registry.registerBuiltin(corePlugin);
    const types: NodeTypeInfo[] = registry.nodeTypes().filter((t) => t.pluginId === 'core');
    const events: ChatEvent[] = [];
    const agent = { op: 'newAgent', ref: 'docs', name: 'Docs Answerer', description: 'Answers.', instructions: 'Answer.', tools: ['Zendesk: read tickets'], after: 'Sample question' };
    await runChat({
      messages: [{ role: 'user', content: 'add an agent after Sample question that answers customers' }],
      workflow: sampleFlow(),
      model: scripted([{ toolCalls: [{ id: 'c1', name: 'propose_changes', input: { summary: 'An agent', ops: [agent] } }] }, { text: 'Adds it.' }]),
      types,
      onEvent: (e) => events.push(e),
    });
    const proposal = events.find((e): e is Extract<ChatEvent, { type: 'proposal' }> => e.type === 'proposal')!;
    const spec = (proposal.ops[0] as { newAgent?: { tools?: string[]; knowledge?: string } }).newAgent;
    expect(spec?.tools).toEqual(['Zendesk: read tickets']);
    expect(spec?.knowledge).toBeUndefined();
  });
});

describe('one wording for the guardrails and practices (the agent card and the Agent architect dialog)', () => {
  it('reads the same for one agent, practices on when the config says nothing and off only when it says off', async () => {
    const { cardFromPreview } = await import('@/components/editor/spotlight/agent-ask');
    const { followsPractices, guardrailWords } = await import('@/lib/shared/agents');
    const { readFileSync } = await import('node:fs');
    const config = {
      name: 'PR reviewer',
      tools: [],
      guardrails: {
        input: { enabled: true, action: 'sanitize', reply: '', checks: { secrets: { permissiveness: 'balanced' }, urls: {} } },
        output: { enabled: true, action: 'block', reply: 'No.', checks: { pii: {} } },
        toolResult: { enabled: true, action: 'block', reply: 'Ignored.', checks: { jailbreak: { useModel: false } } },
      },
    };
    const words = guardrailWords(config.guardrails as never);
    expect(words).toEqual(['Masks secrets in messages', 'Masks links outside the allowed list in messages', 'Blocks personal data in answers', 'Ignores instructions inside tool results']);
    const card = (practices?: 'on' | 'off') => cardFromPreview({ config: { ...config, ...(practices && { practices }) } } as never, { name: 'PR reviewer' } as never, false);
    // The card reads the words the dialog lists: the same helper, so the same text under the same conditions.
    expect(card().guardrails).toEqual(words);
    expect(card().practices).toBe(followsPractices(undefined));
    expect(card().practices).toBe(true);
    expect(card('on').practices).toBe(true);
    expect(card('off').practices).toBe(false);
    expect(followsPractices('off')).toBe(false);
    // The dialog (components/agents/architect.tsx) uses those two helpers and no condition of its own.
    const dialog = readFileSync(new URL('../src/components/agents/architect.tsx', import.meta.url), 'utf8');
    expect(dialog).toContain('followsPractices(c.practices)');
    expect(dialog).toContain('guardrailWords(c.guardrails)');
    expect(dialog).not.toContain("c.practices === 'on'");
  });
});

describe('the bubbles fold after the input loses focus (a click on a card lands)', () => {
  it('stay for the delay, then fold; a focus in between keeps them', async () => {
    const { foldLater, FOLD_DELAY_MS } = await import('@/components/editor/spotlight/composer');
    vi.useFakeTimers();
    try {
      const timer: { current: ReturnType<typeof setTimeout> | undefined } = { current: undefined };
      let focused = true;
      foldLater(timer, () => (focused = false));
      expect(focused).toBe(true); // the click's mousedown and mouseup find the timeline where it was
      vi.advanceTimersByTime(FOLD_DELAY_MS - 1);
      expect(focused).toBe(true);
      vi.advanceTimersByTime(1);
      expect(focused).toBe(false); // desktop still folds
      focused = true;
      foldLater(timer, () => (focused = false));
      clearTimeout(timer.current); // onFocus
      vi.advanceTimersByTime(1000);
      expect(focused).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
