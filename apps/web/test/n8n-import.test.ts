import { describe, expect, it } from 'vitest';
import type { NodeDescriptor } from '@landflow/protocol';
import { convertValue, importWorkflowJson, mappingFor } from '@/lib/server/n8n-import';
import { corePlugin } from '@/lib/server/nodes';
import { workflowSchema } from '@/lib/server/schemas';

const core = new Map<string, NodeDescriptor>(corePlugin.nodes.map((n) => [`core.${n.description.name}`, n.description]));
const resolveType = (type: string) => core.get(type);

/** An n8n 2.x export: a scheduled HTTP → Set → If → Slack / Sheets pipeline, plus a chat agent cluster. */
const n8nWorkflow = {
  name: 'Lead router',
  nodes: [
    {
      parameters: { rule: { interval: [{ field: 'minutes', minutesInterval: 15 }] } },
      id: 'a1',
      name: 'Schedule Trigger',
      type: 'n8n-nodes-base.scheduleTrigger',
      typeVersion: 1.2,
      position: [0, 0],
    },
    {
      parameters: {
        method: 'POST',
        url: 'https://api.example.com/leads',
        authentication: 'genericCredentialType',
        genericAuthType: 'httpHeaderAuth',
        sendQuery: true,
        queryParameters: { parameters: [{ name: 'since', value: '={{ $now.minus(15, "minutes").toISO() }}' }] },
        sendHeaders: true,
        headerParameters: { parameters: [{ name: 'X-Team', value: 'growth' }] },
        sendBody: true,
        specifyBody: 'json',
        jsonBody: '={ "limit": 50 }',
        options: { timeout: 10000 },
      },
      id: 'a2',
      name: 'HTTP Request',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [220, 0],
      credentials: { httpHeaderAuth: { id: '7', name: 'Leads API' } },
      retryOnFail: true,
      maxTries: 4,
      waitBetweenTries: 2000,
    },
    {
      parameters: {
        assignments: {
          assignments: [
            { id: 'x1', name: 'email', value: '={{ $json.contact.email }}', type: 'string' },
            { id: 'x2', name: 'score', value: '={{ $json.score * 2 }}', type: 'number' },
            { id: 'x3', name: 'tags', value: '={{ $json.tags }}', type: 'array' },
          ],
        },
        options: {},
      },
      id: 'a3',
      name: 'Edit Fields',
      type: 'n8n-nodes-base.set',
      typeVersion: 3.4,
      position: [440, 0],
    },
    {
      parameters: {
        conditions: {
          options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
          conditions: [
            { id: 'c1', leftValue: '={{ $json.score }}', rightValue: 50, operator: { type: 'number', operation: 'gte' } },
            { id: 'c2', leftValue: '={{ $json.email }}', rightValue: '', operator: { type: 'string', operation: 'notEmpty', singleValue: true } },
            { id: 'c3', leftValue: '={{ $json.createdAt }}', rightValue: '2026-01-01', operator: { type: 'dateTime', operation: 'after' } },
          ],
          combinator: 'and',
        },
        options: {},
      },
      id: 'a4',
      name: 'Hot lead?',
      type: 'n8n-nodes-base.if',
      typeVersion: 2.2,
      position: [660, 0],
      onError: 'continueRegularOutput',
    },
    {
      parameters: {
        select: 'channel',
        channelId: { __rl: true, value: 'C0123', mode: 'list', cachedResultName: '#sales' },
        text: '=New hot lead: {{ $json.email }}',
        otherOptions: {},
      },
      id: 'a5',
      name: 'Slack',
      type: 'n8n-nodes-base.slack',
      typeVersion: 2.3,
      position: [880, -100],
      credentials: { slackApi: { id: '3', name: 'Slack bot' } },
    },
    {
      parameters: {
        operation: 'append',
        documentId: { __rl: true, value: '1AbC', mode: 'list' },
        sheetName: { __rl: true, value: 'gid=0', mode: 'list' },
        columns: { mappingMode: 'autoMapInputData', value: {} },
        options: {},
      },
      id: 'a6',
      name: 'Google Sheets',
      type: 'n8n-nodes-base.googleSheets',
      typeVersion: 4.5,
      position: [880, 100],
      credentials: { googleSheetsOAuth2Api: { id: '4', name: 'Sheets' } },
    },
    {
      parameters: { graphApiVersion: 'v21.0', node: 'me', options: {} },
      id: 'a7',
      name: 'Facebook Graph API',
      type: 'n8n-nodes-base.facebookGraphApi',
      typeVersion: 1,
      position: [1100, 100],
    },
    {
      parameters: { content: '## Lead router\nRuns every **15 minutes**.', height: 200, width: 320, color: 5 },
      id: 'a8',
      name: 'Sticky Note',
      type: 'n8n-nodes-base.stickyNote',
      typeVersion: 1,
      position: [-40, -260],
    },
    { parameters: { options: {} }, id: 'b1', name: 'When chat message received', type: '@n8n/n8n-nodes-langchain.chatTrigger', typeVersion: 1.1, position: [0, 400], webhookId: 'w1' },
    {
      parameters: { options: { systemMessage: 'You qualify leads.', maxIterations: 5 } },
      id: 'b2',
      name: 'AI Agent',
      type: '@n8n/n8n-nodes-langchain.agent',
      typeVersion: 1.7,
      position: [220, 400],
    },
    {
      parameters: { model: { __rl: true, value: 'gpt-4o-mini', mode: 'list', cachedResultName: 'gpt-4o-mini' }, options: { temperature: 0.3 } },
      id: 'b3',
      name: 'OpenAI Chat Model',
      type: '@n8n/n8n-nodes-langchain.lmChatOpenAi',
      typeVersion: 1.2,
      position: [120, 620],
      credentials: { openAiApi: { id: '1', name: 'OpenAI' } },
    },
    { parameters: { contextWindowLength: 8 }, id: 'b4', name: 'Window Buffer Memory', type: '@n8n/n8n-nodes-langchain.memoryBufferWindow', typeVersion: 1.3, position: [240, 620] },
    { parameters: {}, id: 'b5', name: 'Calculator', type: '@n8n/n8n-nodes-langchain.toolCalculator', typeVersion: 1, position: [360, 620] },
    {
      parameters: { toolDescription: 'Look up a company by domain', url: '=https://api.example.com/company/{{ $fromAI("domain") }}', options: {} },
      id: 'b6',
      name: 'Company lookup',
      type: 'n8n-nodes-base.httpRequestTool',
      typeVersion: 4.2,
      position: [480, 620],
    },
    { parameters: { mode: 'retrieve-as-tool', toolName: 'docs' }, id: 'b7', name: 'Docs store', type: '@n8n/n8n-nodes-langchain.vectorStoreInMemory', typeVersion: 1, position: [600, 620] },
    { parameters: { model: 'text-embedding-3-small' }, id: 'b8', name: 'Embeddings', type: '@n8n/n8n-nodes-langchain.embeddingsOpenAi', typeVersion: 1, position: [600, 800] },
  ],
  connections: {
    'Schedule Trigger': { main: [[{ node: 'HTTP Request', type: 'main', index: 0 }]] },
    'HTTP Request': { main: [[{ node: 'Edit Fields', type: 'main', index: 0 }]] },
    'Edit Fields': { main: [[{ node: 'Hot lead?', type: 'main', index: 0 }]] },
    'Hot lead?': {
      main: [[{ node: 'Slack', type: 'main', index: 0 }], [{ node: 'Google Sheets', type: 'main', index: 0 }]],
    },
    'Google Sheets': { main: [[{ node: 'Facebook Graph API', type: 'main', index: 0 }]] },
    'When chat message received': { main: [[{ node: 'AI Agent', type: 'main', index: 0 }]] },
    'OpenAI Chat Model': { ai_languageModel: [[{ node: 'AI Agent', type: 'ai_languageModel', index: 0 }]] },
    'Window Buffer Memory': { ai_memory: [[{ node: 'AI Agent', type: 'ai_memory', index: 0 }]] },
    Calculator: { ai_tool: [[{ node: 'AI Agent', type: 'ai_tool', index: 0 }]] },
    'Company lookup': { ai_tool: [[{ node: 'AI Agent', type: 'ai_tool', index: 0 }]] },
    'Docs store': { ai_tool: [[{ node: 'AI Agent', type: 'ai_tool', index: 0 }]] },
    Embeddings: { ai_embedding: [[{ node: 'Docs store', type: 'ai_embedding', index: 0 }]] },
  },
  pinData: { 'Schedule Trigger': [{ json: { timestamp: '2026-10-25T10:00:00Z' } }], 'HTTP Request': [{ id: 1, score: 80 }] },
  settings: {
    executionOrder: 'v1',
    timezone: 'Europe/Berlin',
    executionTimeout: 600,
    saveDataSuccessExecution: 'none',
    saveDataErrorExecution: 'all',
    saveManualExecutions: true,
    errorWorkflow: 'xYz123',
    callerPolicy: 'workflowsFromAList',
    callerIds: '14, 18',
  },
  tags: [{ id: 't1', name: 'sales' }, { id: 't2', name: 'ai' }],
  active: true,
  id: 'n8nWf1',
};

describe('n8n import', () => {
  const { workflow, report } = importWorkflowJson(n8nWorkflow, { resolveType });
  const node = (name: string) => {
    const found = workflow.nodes.find((n) => n.name === name);
    if (!found) throw new Error(`no node ${name}`);
    return found;
  };
  const edge = (from: string, to: string) => workflow.connections.filter((c) => c.source === node(from).id && c.target === node(to).id);

  it('produces a workflow the save schema accepts', () => {
    const parsed = workflowSchema.safeParse(workflow);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    expect(report.format).toBe('n8n');
    expect(workflow.name).toBe('Lead router');
    expect(workflow.tags).toEqual(['sales', 'ai']);
    expect(workflow).not.toHaveProperty('active');
  });

  it('maps core, integration and AI node types', () => {
    const types = Object.fromEntries(workflow.nodes.map((n) => [n.name, n.type]));
    expect(types).toMatchObject({
      'Schedule Trigger': 'core.schedule',
      'HTTP Request': 'core.httpRequest',
      'Edit Fields': 'core.set',
      'Hot lead?': 'core.if',
      Slack: 'messaging.slack',
      'Google Sheets': 'google.googleSheets',
      'When chat message received': 'core.chatTrigger',
      'AI Agent': 'core.aiAgent',
      'OpenAI Chat Model': 'core.openAiChatModel',
      'Window Buffer Memory': 'core.simpleMemory',
      Calculator: 'core.calculatorTool',
      'Company lookup': 'core.httpRequest',
    });
    expect(report.mapped).toContainEqual({ name: 'Slack', from: 'n8n-nodes-base.slack', to: 'messaging.slack' });
    expect(new Set(workflow.nodes.map((n) => n.id)).size).toBe(workflow.nodes.length);
    expect(workflow.nodes.every((n) => /^n_/.test(n.id))).toBe(true);
    expect(node('HTTP Request').position).toEqual([220, 0]);
  });

  it('turns unknown nodes into disabled No Operation placeholders', () => {
    for (const name of ['Facebook Graph API', 'Docs store', 'Embeddings']) {
      const placeholder = node(name);
      expect(placeholder.type).toBe('core.noOp');
      expect(placeholder.disabled).toBe(true);
      expect(placeholder.notes).toContain('Placeholder for the n8n node');
    }
    expect(node('Facebook Graph API').notes).toContain('n8n-nodes-base.facebookGraphApi');
    expect(node('Facebook Graph API').notes).toContain('graphApiVersion');
    expect(report.placeholders).toEqual([
      { name: 'Facebook Graph API', type: 'n8n-nodes-base.facebookGraphApi' },
      { name: 'Docs store', type: '@n8n/n8n-nodes-langchain.vectorStoreInMemory' },
      { name: 'Embeddings', type: '@n8n/n8n-nodes-langchain.embeddingsOpenAi' },
    ]);
    // A placeholder in the main flow keeps its connection.
    expect(edge('Google Sheets', 'Facebook Graph API')).toHaveLength(1);
  });

  it('puts sticky notes in stickyNotes, never in nodes', () => {
    expect(workflow.nodes.some((n) => n.name === 'Sticky Note')).toBe(false);
    expect(workflow.stickyNotes).toEqual([{ id: expect.stringMatching(/^s_/), content: '## Lead router\nRuns every **15 minutes**.', position: [-40, -260], width: 320, height: 200, color: 5 }]);
    expect(report.stickyNotes).toBe(1);
  });

  it('converts main and ai_* connections, dropping what Landflow cannot wire', () => {
    expect(edge('Hot lead?', 'Slack')).toMatchObject([{ type: 'main', sourceIndex: 0, targetIndex: 0 }]);
    expect(edge('Hot lead?', 'Google Sheets')).toMatchObject([{ type: 'main', sourceIndex: 1, targetIndex: 0 }]);
    expect(edge('OpenAI Chat Model', 'AI Agent')).toMatchObject([{ type: 'ai_languageModel', sourceIndex: 0, targetIndex: 0 }]);
    expect(edge('Window Buffer Memory', 'AI Agent')).toMatchObject([{ type: 'ai_memory' }]);
    expect(edge('Calculator', 'AI Agent')).toMatchObject([{ type: 'ai_tool' }]);
    expect(edge('Company lookup', 'AI Agent')).toMatchObject([{ type: 'ai_tool' }]);
    expect(edge('Docs store', 'AI Agent')).toHaveLength(0);
    expect(edge('Embeddings', 'Docs store')).toHaveLength(0);
    expect(report.warnings).toContain('Connection Docs store → AI Agent (ai_tool) dropped: placeholders can\'t be sub-nodes.');
    expect(report.warnings).toContain('Connection Embeddings → Docs store (ai_embedding) dropped: Landflow has no embedding sub-nodes yet.');
    expect(report.connections).toBe(workflow.connections.length);
    expect(workflow.connections.every((c) => /^e_/.test(c.id))).toBe(true);
  });

  it('strips n8n expression markers, flattens resource locators and drops credentials', () => {
    expect(node('Slack').parameters).toMatchObject({ channelId: 'C0123', text: 'New hot lead: {{ $json.email }}' });
    expect(node('Slack').credentials).toBeUndefined();
    expect(node('Google Sheets').parameters).toMatchObject({ operation: 'append', documentId: '1AbC', sheetName: 'gid=0' });
    expect(node('OpenAI Chat Model').parameters).toMatchObject({ model: 'gpt-4o-mini', options: { temperature: 0.3 } });
    expect(report.warnings).toContain('Slack: credential slackApi dropped — pick a saved credential in the node.');
    expect(report.warnings).toContain('HTTP Request: credential httpHeaderAuth dropped — pick a saved credential in the node.');
    expect(report.warnings.some((w) => w.startsWith('HTTP Request: authentication'))).toBe(true);
    expect(convertValue({ a: '=x {{ 1 }}', b: [{ __rl: true, value: '={{ $json.id }}' }], c: 'plain' })).toEqual({ a: 'x {{ 1 }}', b: ['{{ $json.id }}'], c: 'plain' });
  });

  it('fixes the parameters that differ from n8n', () => {
    expect(node('Schedule Trigger').parameters).toMatchObject({ every: 15, unit: 'minutes', rule: { interval: [{ field: 'minutes', minutesInterval: 15 }] } });
    expect(node('HTTP Request').parameters).toMatchObject({
      method: 'POST',
      url: 'https://api.example.com/leads',
      query: { parameter: [{ name: 'since', value: '{{ $now.minus(15, "minutes").toISO() }}' }] },
      headers: { header: [{ name: 'X-Team', value: 'growth' }] },
      body: '{ "limit": 50 }',
      options: { timeoutMs: 10000 },
    });
    expect(node('HTTP Request')).toMatchObject({ retryOnFail: true, maxTries: 4, waitBetweenTriesMs: 2000 });
    expect(node('Edit Fields').parameters).toMatchObject({
      mode: 'manual',
      includeOtherFields: false,
      fields: {
        values: [
          { name: 'email', type: 'string', value: '{{ $json.contact.email }}' },
          { name: 'score', type: 'number', value: '{{ $json.score * 2 }}' },
          { name: 'tags', type: 'json', value: '{{ $json.tags }}' },
        ],
      },
    });
    expect(node('Hot lead?').parameters).toEqual({
      conditions: {
        condition: [
          { left: '{{ $json.score }}', operator: 'gte', right: 50 },
          { left: '{{ $json.email }}', operator: 'isNotEmpty', right: '' },
          { left: '{{ new Date($json.createdAt).getTime() }}', operator: 'gt', right: '{{ new Date("2026-01-01").getTime() }}' },
        ],
      },
      combinator: 'and',
    });
    expect(node('Hot lead?').onError).toBe('continue');
    expect(node('AI Agent').parameters).toMatchObject({ prompt: '{{ $json.chatInput }}', systemMessage: 'You qualify leads.', options: { maxIterations: 5 } });
    expect(node('Window Buffer Memory').parameters).toEqual({ turns: 8 });
    expect(node('Company lookup').notes).toBe('Look up a company by domain');
    expect(node('Company lookup').parameters).toMatchObject({ url: 'https://api.example.com/company/{{ $fromAI("domain") }}', method: 'GET' });
  });

  it('remaps pin data to the new node ids and maps the settings', () => {
    expect(workflow.pinData).toEqual({
      [node('Schedule Trigger').id]: [{ json: { timestamp: '2026-10-25T10:00:00Z' } }],
      [node('HTTP Request').id]: [{ json: { id: 1, score: 80 } }],
    });
    expect(workflow.settings).toEqual({
      timezone: 'Europe/Berlin',
      timeoutSeconds: 600,
      saveSuccessfulExecutions: false,
      saveFailedExecutions: true,
      saveManualExecutions: true,
      callerPolicy: 'list',
      callerIds: ['14', '18'],
    });
    expect(report.warnings.some((w) => w.startsWith('Settings: the error workflow'))).toBe(true);
  });

  it('accepts n8n clipboard JSON and a JSON string', () => {
    const clipboard = JSON.stringify({
      nodes: [
        { parameters: {}, name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0] },
        { parameters: { errorMessage: '=Bad {{ $json.x }}' }, name: 'Fail', type: 'n8n-nodes-base.stopAndError', typeVersion: 1, position: [200, 0] },
      ],
      connections: { Start: { main: [[{ node: 'Fail', type: 'main', index: 0 }]] } },
      pinData: {},
      meta: { instanceId: 'abc' },
    });
    const result = importWorkflowJson(clipboard, { resolveType });
    expect(result.workflow.name).toBe('Imported workflow');
    expect(result.workflow.nodes.map((n) => [n.type, n.parameters])).toEqual([
      ['core.manualTrigger', {}],
      ['core.stopAndError', { message: 'Bad {{ $json.x }}' }],
    ]);
    expect(result.workflow.connections).toHaveLength(1);
  });
});

describe('n8n import: Switch, ports and registered-only types', () => {
  const rule = (value: string) => ({ conditions: { conditions: [{ leftValue: '={{ $json.kind }}', rightValue: value, operator: { type: 'string', operation: 'equals' } }], combinator: 'and' } });
  const flow = (rules: number, extraTargets: number) => ({
    nodes: [
      { parameters: {}, name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0] },
      {
        parameters: { rules: { values: Array.from({ length: rules }, (_, i) => rule(`k${i}`)) }, options: { fallbackOutput: 'extra' } },
        name: 'Route',
        type: 'n8n-nodes-base.switch',
        typeVersion: 3.2,
        position: [200, 0],
      },
      ...Array.from({ length: extraTargets }, (_, i) => ({ parameters: {}, name: `Out ${i}`, type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [400, i * 100] })),
    ],
    connections: {
      Start: { main: [[{ node: 'Route', type: 'main', index: 0 }]] },
      Route: { main: Array.from({ length: extraTargets }, (_, i) => [{ node: `Out ${i}`, type: 'main', index: 0 }]) },
    },
  });

  it('remaps the fallback output to Landflow’s Fallback port', () => {
    const { workflow } = importWorkflowJson(flow(2, 3), { resolveType });
    const route = workflow.nodes.find((n) => n.name === 'Route')!;
    expect(route.parameters).toMatchObject({
      mode: 'rules',
      rules: { values: [{ conditions: { condition: [{ left: '{{ $json.kind }}', operator: 'equals', right: 'k0' }] }, combinator: 'and' }, expect.anything()] },
      options: { fallbackOutput: 'extra' },
    });
    const indexOf = (name: string) => workflow.connections.find((c) => c.source === route.id && c.target === workflow.nodes.find((n) => n.name === name)!.id)?.sourceIndex;
    expect([indexOf('Out 0'), indexOf('Out 1'), indexOf('Out 2')]).toEqual([0, 1, 4]);
  });

  it('drops rules beyond Landflow’s four outputs, with their connections', () => {
    const { workflow, report } = importWorkflowJson(flow(6, 7), { resolveType });
    const route = workflow.nodes.find((n) => n.name === 'Route')!;
    expect((route.parameters.rules as { values: unknown[] }).values).toHaveLength(4);
    expect(workflow.connections.filter((c) => c.source === route.id).map((c) => c.sourceIndex)).toEqual([0, 1, 2, 3, 4]);
    expect(report.warnings.some((w) => w.includes('rules 5–6 were dropped'))).toBe(true);
    expect(report.warnings.filter((w) => w.startsWith('Connection Route → Out'))).toHaveLength(2);
  });

  it('checks ports against the registered descriptors', () => {
    const doc = {
      nodes: [
        { parameters: {}, name: 'A', type: 'n8n-nodes-base.noOp', position: [0, 0] },
        { parameters: {}, name: 'B', type: 'n8n-nodes-base.noOp', position: [200, 0] },
        { parameters: { mode: 'append', numberInputs: 3 }, name: 'Merge', type: 'n8n-nodes-base.merge', typeVersion: 3, position: [400, 0] },
      ],
      connections: {
        A: { main: [[{ node: 'Merge', type: 'main', index: 1 }]] },
        B: { main: [[{ node: 'Merge', type: 'main', index: 2 }]] },
      },
    };
    const checked = importWorkflowJson(doc, { resolveType });
    expect(checked.workflow.connections.map((c) => c.targetIndex)).toEqual([1]);
    expect(checked.report.warnings).toContain('Connection B → Merge dropped: “Merge” has no input 3 in Landflow.');
    // Without descriptors nothing is checked.
    expect(importWorkflowJson(doc).workflow.connections).toHaveLength(2);
  });

  it('maps registered-only types only when they are registered', () => {
    const doc = { nodes: [{ parameters: {}, name: 'On error', type: 'n8n-nodes-base.errorTrigger', typeVersion: 1, position: [0, 0] }], connections: {} };
    const withoutErrorTrigger = (type: string) => (type === 'core.errorTrigger' ? undefined : resolveType(type));
    expect(importWorkflowJson(doc, { resolveType: withoutErrorTrigger }).workflow.nodes[0]).toMatchObject({ type: 'core.noOp', disabled: true });
    const withErrorTrigger = (type: string) => (type === 'core.errorTrigger' ? ({ ...core.get('core.manualTrigger')!, name: 'errorTrigger' } as NodeDescriptor) : resolveType(type));
    const mapped = importWorkflowJson(doc, { resolveType: withErrorTrigger });
    expect(mapped.workflow.nodes[0].type).toBe('core.errorTrigger');
    expect(mapped.report.placeholders).toEqual([]);
  });

  it('maps <name>Tool variants like the node itself', () => {
    expect(mappingFor('n8n-nodes-base.slackTool')).toMatchObject({ mapping: { to: 'messaging.slack' }, asTool: true });
    expect(mappingFor('n8n-nodes-base.somethingTool')).toBeUndefined();
  });
});

describe('Landflow JSON import', () => {
  const exported = {
    id: 'wf_old',
    name: 'Round trip',
    active: true,
    folderId: 'f_1',
    createdAt: '2026-01-01T00:00:00Z',
    nodes: [
      { id: 'n_a', name: 'Start', type: 'core.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
      { id: 'n_b', name: 'Set', type: 'core.set', typeVersion: 1, position: [200, 0], parameters: { mode: 'json', json: '{}' } },
    ],
    connections: [
      { id: 'e_1', type: 'main', source: 'n_a', sourceIndex: 0, target: 'n_b', targetIndex: 0 },
      { id: 'e_2', type: 'main', source: 'n_a', sourceIndex: 0, target: 'n_gone', targetIndex: 0 },
    ],
    stickyNotes: [{ id: 's_1', content: 'hi', position: [0, -200], width: 200, height: 120, color: 2 }],
    pinData: { n_a: [{ json: { x: 1 } }], n_gone: [{ json: {} }] },
    settings: { timezone: 'UTC' },
  };

  it('keeps ids and drops server-owned fields', () => {
    const { workflow, report } = importWorkflowJson({ workflow: exported });
    expect(report.format).toBe('landflow');
    expect(workflow.nodes.map((n) => n.id)).toEqual(['n_a', 'n_b']);
    expect(workflow.connections).toEqual([exported.connections[0]]);
    expect(workflow.stickyNotes).toEqual(exported.stickyNotes);
    expect(workflow.pinData).toEqual({ n_a: [{ json: { x: 1 } }] });
    expect(workflow.settings).toEqual({ timezone: 'UTC' });
    for (const key of ['id', 'active', 'folderId', 'createdAt']) expect(workflow).not.toHaveProperty(key);
    expect(report.mapped).toEqual([
      { name: 'Start', from: 'core.manualTrigger', to: 'core.manualTrigger' },
      { name: 'Set', from: 'core.set', to: 'core.set' },
    ]);
    expect(report.warnings).toEqual(['A connection to a missing node was dropped.']);
    expect(workflowSchema.safeParse(workflow).success).toBe(true);
  });

  it('accepts a one-element array', () => {
    expect(importWorkflowJson([exported]).workflow.name).toBe('Round trip');
  });
});

describe('invalid input', () => {
  it('throws readable errors', () => {
    expect(() => importWorkflowJson('{ nope')).toThrow(/isn't valid JSON/);
    expect(() => importWorkflowJson({ hello: 'world' })).toThrow(/expected JSON with a "nodes" list/);
    expect(() => importWorkflowJson([])).toThrow(/empty list/);
    expect(() => importWorkflowJson([{ nodes: [] }, { nodes: [] }])).toThrow(/2 workflows/);
    expect(() => importWorkflowJson({ nodes: [{ name: 'x' }], connections: [] })).toThrow(/needs a "type" and a "position"/);
    expect(() => importWorkflowJson({ nodes: [], connections: 'x' })).toThrow(/"connections" must be/);
  });
});
