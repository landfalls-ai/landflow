/**
 * The Agent architect (docs/agents.md#agent-architect): drafts are whole agents checked against what the instance has,
 * the chat reads the plugins online and proposes, and marketplace installs show on the roster with a face and a team.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { LanguageModel, ModelTurn } from '@landflow/engine';
import type { AgentSummary, NodeToolConfig } from '@/lib/shared/agents';
import { missingSystem, type ArchitectEvent } from '@/lib/shared/agent-architect';
import type { NodeTypeInfo } from '@/lib/shared/types';
import type { GenerateInput } from '@/lib/server/nodes/models';

const { corePlugin } = await import('@/lib/server/nodes');
const { registry } = await import('@/lib/server/plugins/registry');
const { draftFrom, parsed, runArchitect, toolName, usableAsTool } = await import('@/lib/server/assistant/architect');
const { agentStore } = await import('@/lib/server/agents/store');
const { store } = await import('@/lib/server/store');
const { marketplaceStore } = await import('@/lib/server/marketplace/store');
const { agentFromClaude } = await import('@/lib/server/marketplace/map');
const { TEST_OWNER } = await import('@/lib/server/auth/test-bypass');
const { listUsageEvents } = await import('@/lib/server/usage/query');
const agentsRoute = await import('@/app/api/agents/route');
const architectRoute = await import('@/app/api/assistant/agent/route');

let types: NodeTypeInfo[];
beforeAll(() => {
  registry.registerBuiltin(corePlugin);
  types = registry.nodeTypes().filter((t) => t.pluginId === 'core');
});

const context = (extra: Partial<Parameters<typeof draftFrom>[1]> = {}) => ({ types, actor: TEST_OWNER, known: '', ...extra });

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

describe('drafts', () => {
  it('keeps node tools to the plugins online and usable as tools, with the node’s own parameters over its defaults', () => {
    const { config, dropped, needs } = draftFrom(
      {
        name: 'Page reader',
        role: 'Researcher',
        instructions: 'Fetch the page, then summarise it.',
        tools: [
          { type: 'node', nodeType: 'core.httpRequest', name: 'Fetch page', description: 'Fetch a web page', parameters: { url: "{{ $fromAI('url', 'The page', 'string') }}", bogus: 1 } },
          { type: 'node', nodeType: 'core.manualTrigger' },
          { type: 'node', nodeType: 'acme.teleport' },
        ],
      },
      context(),
    );
    expect(config.tools).toHaveLength(1);
    const tool = config.tools![0] as NodeToolConfig;
    expect(tool).toMatchObject({ type: 'node', name: 'fetch_page', description: 'Fetch a web page', nodeType: 'core.httpRequest' });
    expect(tool.parameters.url).toBe("{{ $fromAI('url', 'The page', 'string') }}");
    // Defaults fill what the model didn't set.
    expect(tool.parameters.method).toBe('GET');
    expect(dropped).toEqual(['“bogus” of fetch_page: not a parameter of HTTP Request', 'core.manualTrigger: not usable as a tool', 'acme.teleport: not a node type online here']);
    expect(needs).toEqual([]);
    expect(config).toMatchObject({ name: 'Page reader', persona: { role: 'Researcher' }, instructions: 'Fetch the page, then summarise it.', avatar: { kind: 'face' } });
  });

  it('never sets credentials or ids nobody gave: they become what the user still has to do', () => {
    const { config, dropped, needs } = draftFrom(
      {
        name: 'Tables',
        role: 'Clerk',
        instructions: 'Look rows up.',
        tools: [
          { type: 'node', nodeType: 'core.dataTable', name: 'rows', parameters: { dataTableId: 'dt_8f3k2m9q' } },
          { type: 'node', nodeType: 'core.openAi', name: 'rows' },
        ],
      },
      context(),
    );
    const [table, openAi] = config.tools as NodeToolConfig[];
    expect(table.parameters.dataTableId).toBeFalsy();
    expect(dropped.some((d) => d.includes('dataTableId'))).toBe(true);
    // Same names get a suffix; no credentials are set.
    expect([table.name, openAi.name]).toEqual(['rows', 'rows_2']);
    expect(openAi.credentials).toBeUndefined();
    expect(needs).toEqual(
      expect.arrayContaining([
        { tool: 'rows', kind: 'parameter', text: expect.stringContaining('rows: fill in') },
        // Other test files may have made an OpenAI credential: the text then names it instead of "none yet".
        { tool: 'rows_2', kind: 'credential', text: expect.stringMatching(/^rows_2: pick a openAiApi credential \((none yet|you have)/) },
      ]),
    );
  });

  it('calls only workflows that start with the workflow trigger and agents that exist', () => {
    const callable = store.saveWorkflow({ id: 'wf_arch_callable', name: 'Open a ticket', description: 'Opens a ticket', nodes: [{ id: 'a', name: 'When called', type: 'core.workflowTrigger', typeVersion: 1, position: [0, 0], parameters: {} }], connections: [] } as never);
    const manual = store.saveWorkflow({ id: 'wf_arch_manual', name: 'Manual', nodes: [{ id: 'a', name: 'Start', type: 'core.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} }], connections: [] } as never);
    const helper = agentStore.create({ name: 'Formatter' });
    const { config, dropped } = draftFrom(
      {
        name: 'Support',
        role: 'Support lead',
        instructions: 'Answer, then open a ticket.',
        tools: [
          { type: 'workflow', workflowId: callable.id },
          { type: 'workflow', workflowId: manual.id },
          { type: 'agent', agentId: helper.id, useWhen: 'To tidy an answer' },
          { type: 'agent', agentId: helper.id },
          { type: 'agent', agentId: 'ag_nope' },
        ],
      },
      context(),
    );
    expect(config.tools).toEqual([
      { id: expect.any(String), type: 'workflow', workflowId: callable.id, name: 'open_a_ticket', description: 'Opens a ticket' },
      { id: expect.any(String), type: 'agent', agentId: helper.id, useWhen: 'To tidy an answer' },
    ]);
    expect(dropped).toEqual([`the workflow ${manual.id}: not one an agent can call`, 'the agent ag_nope: not on this instance']);
  });

  it('starts from a template under the fields given, and keeps the avatar, colour and team of the draft so far', () => {
    const avatar = { kind: 'initials' as const, initials: 'HD' };
    const { config } = draftFrom({ templateId: 'support-lead', name: 'Helpdesk', role: 'Tier-1 support', tools: [] }, context({ keep: { avatar, color: '#22c55e', team: 'Support' } }));
    expect(config).toMatchObject({ name: 'Helpdesk', avatar, color: '#22c55e', team: 'Support', icon: 'headset', persona: { role: 'Tier-1 support', tones: ['Empathetic', 'Friendly', 'Patient'] } });
    expect(config.tools).toEqual([]);
    expect(draftFrom({ templateId: 'nope', name: 'X', role: 'Y', tools: [] }, context()).dropped).toEqual(['the template “nope”, which doesn’t exist']);
  });

  it('reads tools and rules sent as JSON strings, and makes provider-safe tool names', () => {
    const { config } = draftFrom({ name: 'X', role: 'Y', tones: '["Calm","Direct"]', tools: JSON.stringify([{ type: 'node', nodeType: 'core.httpRequest', name: 'Get the page!' }]) }, context());
    expect(config.persona?.tones).toEqual(['Calm', 'Direct']);
    expect((config.tools![0] as NodeToolConfig).name).toBe('get_the_page');
    expect(toolName('***')).toBe('tool');
  });
});

describe('the architect chat', () => {
  it('researches the plugins online, then proposes a whole agent as a draft', async () => {
    const { model, calls } = scripted([
      { toolCalls: [{ id: 'c1', name: 'search_nodes', input: { query: 'http request' } }, { id: 'c2', name: 'list_templates', input: {} }] },
      {
        text: 'Here is a first version.',
        toolCalls: [{ id: 'c3', name: 'propose_agent', input: { summary: 'A page reader', name: 'Reader', role: 'Researcher', instructions: 'Fetch, then summarise.', tools: [{ type: 'node', nodeType: 'core.httpRequest', name: 'fetch_page' }] } }],
      },
      { text: 'Pick a model on its page, then try it.' },
    ]);
    const events: ArchitectEvent[] = [];
    await runArchitect({ messages: [{ role: 'user', content: 'An agent that reads web pages for me' }], model, types, actor: TEST_OWNER, onEvent: (e) => events.push(e) });

    // The catalog of plugins online, usable as tools, is in the system prompt.
    expect(calls[0].system).toContain('Plugins online and the nodes an agent can use');
    expect(calls[0].system).toContain('HTTP Request');
    expect(calls[0].system).not.toContain('Manual Trigger');
    expect(events.filter((e) => e.type === 'tool').map((e) => (e as { label: string }).label)).toEqual(['Searched plugins for “http request”', 'Listed 7 templates', 'Proposed “Reader” with 1 tools']);
    const draft = events.find((e) => e.type === 'draft') as Extract<ArchitectEvent, { type: 'draft' }>;
    expect(draft).toMatchObject({ summary: 'A page reader', config: { name: 'Reader', persona: { role: 'Researcher' } }, needs: [], dropped: [] });
    expect(events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text)).toEqual(['Here is a first version.', 'Pick a model on its page, then try it.']);
    expect(events.at(-1)).toMatchObject({ type: 'done', model: 'test/scripted', steps: 3 });
  });

  it('builds on the draft it is given, and reads a tool call written as text', async () => {
    const keep = { name: 'Reader', avatar: { kind: 'initials' as const, initials: 'RD' }, team: 'Research' };
    const { model, calls } = scripted([
      { text: '<function=propose_agent><parameter=name>Reader</parameter><parameter=role>Researcher</parameter><parameter=summary>Shorter answers</parameter><parameter=length>sentence</parameter><parameter=instructions>Fetch.</parameter><parameter=tools>[]</parameter></function>' },
      { text: 'Done: it now answers in one sentence.' },
    ]);
    const events: ArchitectEvent[] = [];
    await runArchitect({ messages: [{ role: 'user', content: 'Make it shorter' }], draft: keep, model, types, actor: TEST_OWNER, onEvent: (e) => events.push(e) });
    expect(calls[0].system).toContain('The draft so far');
    const draft = events.find((e) => e.type === 'draft') as Extract<ArchitectEvent, { type: 'draft' }>;
    expect(draft.config).toMatchObject({ avatar: keep.avatar, team: 'Research', persona: { length: 'sentence' } });
  });

  it('skips a proposal it already made, splits tones sent as one string, and finds a node by its short name', async () => {
    const propose = { id: 'p', name: 'propose_agent', input: { summary: 'v1', name: 'Guard', role: 'Triage', tones: 'Precise, Calm, Direct', always: '- Parse the alert\n- Post a summary', instructions: 'Triage.', tools: [] } };
    const { model } = scripted([
      { toolCalls: [{ id: 'd', name: 'get_node_docs', input: { type: 'http.request' } }] },
      { toolCalls: [propose] },
      { toolCalls: [{ ...propose, id: 'p2', input: { ...propose.input, summary: 'v1 again' } }] },
      { text: 'Ready to create.' },
    ]);
    const events: ArchitectEvent[] = [];
    await runArchitect({ messages: [{ role: 'user', content: 'Triage alerts' }], model, types, actor: TEST_OWNER, onEvent: (e) => events.push(e) });
    expect(events.filter((e) => e.type === 'tool').map((e) => (e as { label: string }).label)).toEqual(['Read HTTP Request docs', 'Proposed “Guard” with 0 tools', 'Skipped a repeated proposal']);
    const drafts = events.filter((e) => e.type === 'draft') as Array<Extract<ArchitectEvent, { type: 'draft' }>>;
    expect(drafts).toHaveLength(1);
    expect(drafts[0].config.persona).toMatchObject({ tones: ['Precise', 'Calm', 'Direct'], always: ['Parse the alert', 'Post a summary'] });
  });

  it('notes what no plugin online can do, from the model or from a node type it made up, for the second brain', async () => {
    const { model } = scripted([
      {
        toolCalls: [
          {
            id: 'p',
            name: 'propose_agent',
            input: { summary: 'v1', name: 'Grafana Guardian', role: 'Triage', instructions: 'Triage.', missing: ['Grafana: Read firing Grafana alerts'], tools: [{ type: 'node', nodeType: 'pagerduty.createIncident', description: 'Open a PagerDuty incident' }] },
          },
        ],
      },
      { text: 'There is no Grafana node here yet.' },
    ]);
    const events: ArchitectEvent[] = [];
    await runArchitect({ messages: [{ role: 'user', content: 'Triage Grafana alerts' }], model, types, actor: TEST_OWNER, onEvent: (e) => events.push(e) });
    const draft = events.find((e) => e.type === 'draft') as Extract<ArchitectEvent, { type: 'draft' }>;
    expect(draft.missing).toEqual([
      { capability: 'Read firing Grafana alerts', system: 'Grafana' },
      { capability: 'Open a PagerDuty incident', system: 'Pagerduty' },
    ]);
    const recorded = listUsageEvents({ kinds: ['tool.missing'] }, { limit: 50 }).filter((e) => e.attrs?.agent === 'Grafana Guardian');
    expect(recorded.map((e) => [e.message, e.attrs?.system, e.attrs?.source])).toEqual(
      expect.arrayContaining([
        ['Read firing Grafana alerts', 'Grafana', 'architect'],
        ['Open a PagerDuty incident', 'Pagerduty', 'architect'],
      ]),
    );
  });

  it('finds the app in the capability when the model copies the format’s placeholder', () => {
    expect(missingSystem('Read Grafana alerts from a webhook or API endpoint', 'App')).toBe('Grafana');
    expect(missingSystem('Read firing alerts', 'Grafana')).toBe('Grafana');
    expect(missingSystem('Call the HTTP API of “Opsgenie”.')).toBe('Opsgenie');
    expect(missingSystem('read firing alerts', 'system')).toBeUndefined();
    const result = draftFrom({ name: 'Grafana Guardian', missing: ['App: Read Grafana alerts from a webhook'], tools: [] }, context());
    expect(result.missing).toEqual([{ capability: 'Read Grafana alerts from a webhook', system: 'Grafana' }]);
  });

  it('doesn’t count a plugin that is online as missing', () => {
    const toolkit = { ...types[0], type: 'text-toolkit.template', pluginId: 'text-toolkit', pluginName: 'Text Toolkit' };
    const result = draftFrom({ name: 'Grafana Triage Bot', missing: ['TextToolkit: format the summary for Slack', 'Grafana: read firing alerts'], tools: [] }, context({ types: [...types, toolkit] }));
    expect(result.missing).toEqual([{ capability: 'read firing alerts', system: 'Grafana' }]);
    expect(result.dropped).toContain('“format the summary for Slack” as missing: Text Toolkit is online');
  });

  it('doesn’t count an app that an online node is named after as missing', () => {
    const slack = { ...types[0], type: 'messaging.slack', pluginId: 'messaging', pluginName: 'Messaging', descriptor: { ...types[0].descriptor, displayName: 'Slack' } };
    const result = draftFrom({ name: 'SRE On-Call Agent', missing: [{ capability: 'post to a channel', system: 'Slack' }, 'Grafana: read firing alerts'], tools: [] }, context({ types: [...types, slack] }));
    expect(result.missing).toEqual([{ capability: 'read firing alerts', system: 'Grafana' }]);
    expect(result.dropped).toContain('“post to a channel” as missing: Messaging’s Slack node is online');
  });

  it('reads lists a model sends in brackets without quotes', () => {
    expect(parsed('[Calm, Direct, Brief]')).toEqual(['Calm', 'Direct', 'Brief']);
    expect(parsed('[Always use the HTTP Request node, when it fits, Always post to Slack]')).toEqual(['Always use the HTTP Request node, when it fits', 'Always post to Slack']);
    expect(parsed('["Precise", "Calm"]')).toEqual(['Precise', 'Calm']);
    expect(parsed('Calm, Direct')).toBe('Calm, Direct');
    const result = draftFrom({ name: 'Grafana Triage Bot', tones: '[Calm, Direct, Brief]', never: '[Never make up alert details, Never include secrets]', missing: '[Grafana: read firing alerts]', tools: [] }, context());
    expect(result.config.persona).toMatchObject({ tones: ['Calm', 'Direct', 'Brief'], never: ['Never make up alert details', 'Never include secrets'] });
    expect(result.missing).toEqual([{ capability: 'read firing alerts', system: 'Grafana' }]);
  });

  it('asks once more when Ollama can’t parse the tool call the model wrote', async () => {
    let calls = 0;
    const model: LanguageModel = {
      provider: 'test',
      model: 'flaky',
      async generate() {
        calls++;
        if (calls === 1) throw new Error('Ollama error 500: {"error":"XML syntax error on line 41: element <parameter> closed by </function>"}');
        return { text: 'Which app do the alerts come from?', toolCalls: [], stopReason: 'stop' };
      },
    };
    const events: ArchitectEvent[] = [];
    await runArchitect({ messages: [{ role: 'user', content: 'Triage alerts' }], model, types, actor: TEST_OWNER, onEvent: (e) => events.push(e) });
    expect(calls).toBe(2);
    expect(events.map((e) => e.type)).toEqual(['text', 'done']);
  });

  it('turns away a conversation that doesn’t end with the user', async () => {
    const response = await architectRoute.POST(new Request('http://localhost/api/assistant/agent', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'assistant', content: 'Hi' }] }) }));
    expect(response.status).toBe(400);
  });
});

describe('marketplace agents on the roster', () => {
  it('gives an installed agent a face and the plugin as its team', () => {
    const config = agentFromClaude({ name: 'code-reviewer', description: 'Reviews code', tools: [], body: 'Review it.' } as never, { pluginId: 'review@acme', skills: [], team: 'Review kit' });
    expect(config).toMatchObject({ name: 'Code Reviewer', team: 'Review kit', avatar: { kind: 'face' } });
    expect(config.avatar).toEqual(agentFromClaude({ name: 'code-reviewer', description: 'x', tools: [], body: '' } as never, { pluginId: 'review@acme', skills: [] }).avatar);
  });

  it('marks the agents a marketplace install created', async () => {
    const installed = agentStore.create({ name: 'Code Reviewer', team: 'Review kit' });
    const own = agentStore.create({ name: 'Mine' });
    marketplaceStore.saveInstalled({ id: 'review@acme', plugin: 'review', marketplaceId: 'mk_1', marketplaceName: 'acme', source: {} as never, installedAt: new Date().toISOString(), agents: [{ id: installed.id, name: installed.name }], skills: [], unsupported: [] });
    try {
      const response = await agentsRoute.GET(new Request('http://localhost/api/agents'));
      const { agents } = (await response.json()) as { agents: AgentSummary[] };
      expect(agents.find((a) => a.id === installed.id)?.marketplace).toEqual({ installedId: 'review@acme', plugin: 'review', marketplace: 'acme' });
      expect(agents.find((a) => a.id === own.id)?.marketplace).toBeUndefined();
    } finally {
      marketplaceStore.removeInstalled('review@acme');
    }
  });
});

it('offers as tools only actions an agent can call', () => {
  expect(types.filter(usableAsTool).some((t) => t.type === 'core.httpRequest')).toBe(true);
  expect(types.filter(usableAsTool).some((t) => t.descriptor.kind === 'trigger')).toBe(false);
});
