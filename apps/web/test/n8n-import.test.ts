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
    for (const name of ['Facebook Graph API']) {
      const placeholder = node(name);
      expect(placeholder.type).toBe('core.noOp');
      expect(placeholder.disabled).toBe(true);
      expect(placeholder.notes).toContain('Placeholder for the n8n node');
    }
    expect(node('Facebook Graph API').notes).toContain('n8n-nodes-base.facebookGraphApi');
    expect(node('Facebook Graph API').notes).toContain('graphApiVersion');
    expect(report.placeholders).toEqual([{ name: 'Facebook Graph API', type: 'n8n-nodes-base.facebookGraphApi' }]);
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
    // RAG sub-nodes: the vector store is the agent's tool, fed by the embeddings.
    expect(edge('Docs store', 'AI Agent')).toMatchObject([{ type: 'ai_tool' }]);
    expect(edge('Embeddings', 'Docs store')).toMatchObject([{ type: 'ai_embedding' }]);
    expect(node('Docs store')).toMatchObject({ type: 'core.vectorStoreInMemory', parameters: { mode: 'retrieve-as-tool', toolName: 'docs', collection: 'vector_store_key' } });
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
    expect(node('Schedule Trigger').parameters).toEqual({ unit: 'rules', rule: { interval: [{ field: 'minutes', minutesInterval: 15 }] } });
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

describe('n8n import: triggers, waits, forms and sub-workflows', () => {
  /** One n8n node imported on its own, checked against the save schema. */
  const importNode = (type: string, parameters: Record<string, unknown>, extra: Record<string, unknown> = {}, resolve = resolveType) => {
    const { workflow, report } = importWorkflowJson(
      { nodes: [{ parameters, name: 'Node', type: `n8n-nodes-base.${type}`, typeVersion: 1, position: [0, 0], ...extra }], connections: {} },
      { resolveType: resolve },
    );
    expect(workflowSchema.safeParse(workflow).success).toBe(true);
    return { node: workflow.nodes[0], warnings: report.warnings, report };
  };

  it('maps every Schedule Trigger rule onto Trigger Rules, with n8n’s defaults', () => {
    const { node, warnings } = importNode(
      'scheduleTrigger',
      {
        rule: {
          interval: [
            { field: 'seconds', secondsInterval: 10 },
            { field: 'hours', hoursInterval: 2, triggerAtMinute: 30 },
            {},
            { field: 'weeks', weeksInterval: 2, triggerAtDay: [5, 1], triggerAtHour: 8 },
            { field: 'weeks' },
            { field: 'months', triggerAtDayOfMonth: 15, triggerAtHour: 18, triggerAtMinute: 45 },
            { field: 'cronExpression', expression: '0 15 * 1 sun' },
          ],
        },
      },
      { typeVersion: 1.2 },
    );
    expect(node.type).toBe('core.schedule');
    expect(node.parameters).toEqual({
      unit: 'rules',
      rule: {
        interval: [
          { field: 'seconds', secondsInterval: 10 },
          { field: 'hours', hoursInterval: 2, triggerAtMinute: 30 },
          // n8n triggers at midnight, and on every weekday when none is picked.
          { field: 'days', daysInterval: 1, triggerAtHour: 0, triggerAtMinute: 0 },
          { field: 'weeks', weeksInterval: 2, triggerAtDay: [1, 5], triggerAtHour: 8, triggerAtMinute: 0 },
          { field: 'weeks', weeksInterval: 1, triggerAtDay: [0, 1, 2, 3, 4, 5, 6], triggerAtHour: 0, triggerAtMinute: 0 },
          { field: 'months', monthsInterval: 1, triggerAtDayOfMonth: 15, triggerAtHour: 18, triggerAtMinute: 45 },
          { field: 'cronExpression', expression: '0 15 * 1 sun' },
        ],
      },
    });
    expect(warnings).toEqual([]);
  });

  it('warns about cron expressions Landflow can’t run and drops unknown intervals', () => {
    const { node, warnings } = importNode('scheduleTrigger', { rule: { interval: [{ field: 'cronExpression', expression: '0 0 * * * * *' }, { field: 'fortnights' }] } });
    expect(node.parameters.rule).toEqual({ interval: [{ field: 'cronExpression', expression: '0 0 * * * * *' }] });
    expect(warnings.some((w) => w.startsWith('Node: the cron expression “0 0 * * * * *” isn\'t valid in Landflow'))).toBe(true);
    expect(warnings).toContain('Node: the trigger interval “fortnights” isn\'t available; that rule was dropped.');
    expect(importNode('scheduleTrigger', {}).node.parameters).toEqual({ unit: 'rules', rule: { interval: [{ field: 'days', daysInterval: 1, triggerAtHour: 0, triggerAtMinute: 0 }] } });
  });

  it('maps the Webhook’s response modes and warns about response settings it lacks', () => {
    const responseNode = importNode('webhook', { httpMethod: 'POST', path: 'orders', responseMode: 'responseNode', options: {} }, { typeVersion: 2 });
    expect(responseNode.node.parameters).toEqual({ path: 'orders', authentication: 'none', method: 'POST', respond: 'responseNode', options: {} });
    expect(responseNode.warnings).toEqual([]);
    expect(importNode('webhook', { path: 'ping' }).node.parameters).toEqual({ path: 'ping', authentication: 'none', method: 'GET', respond: 'immediately', options: {} });
    const lastNode = importNode('webhook', {
      path: 'report',
      httpMethod: 'HEAD',
      responseMode: 'lastNode',
      responseCode: 201,
      responseData: 'allEntries',
      authentication: 'basicAuth',
      options: { rawBody: true, ipWhitelist: '10.0.0.1' },
    });
    // Basic Auth and the IP allow-list come along (the credential is chosen again).
    expect(lastNode.node.parameters).toEqual({ path: 'report', authentication: 'basicAuth', method: 'GET', respond: 'lastNode', options: { rawBody: true, ipWhitelist: '10.0.0.1' } });
    expect(lastNode.warnings).toEqual([
      'Node: Landflow webhooks don\'t take HEAD requests; it listens for GET.',
      'Node: the response code 201 isn\'t available here; use a Respond to Webhook node to set it.',
      'Node: responding with “allEntries” isn\'t available; the last node\'s output is sent as JSON (one item as an object, several as an array).',
    ]);
    // Without Respond to Webhook the caller would wait for the whole run.
    const withoutRespond = (type: string) => (type === 'core.respondToWebhook' ? undefined : resolveType(type));
    expect(importNode('webhook', { path: 'x', responseMode: 'responseNode' }, {}, withoutRespond).node.parameters.respond).toBe('lastNode');
  });

  it('maps Respond to Webhook with its options, without binary and JWT responses', () => {
    const json = importNode(
      'respondToWebhook',
      {
        respondWith: 'json',
        responseBody: '={{ { "id": $json.id } }}',
        options: { responseCode: 201, responseHeaders: { entries: [{ name: 'X-Id', value: '={{ $json.id }}' }] }, enableStreaming: false },
      },
      { typeVersion: 1.4 },
    );
    expect(json.node).toMatchObject({
      type: 'core.respondToWebhook',
      parameters: { respondWith: 'json', responseBody: '{{ { "id": $json.id } }}', options: { responseCode: 201, responseHeaders: { entries: [{ name: 'X-Id', value: '{{ $json.id }}' }] } } },
    });
    expect(json.warnings).toEqual(['Node: the option “enableStreaming” has no Landflow equivalent and was dropped.']);
    expect(importNode('respondToWebhook', { respondWith: 'redirect', redirectURL: 'https://example.com/done' }).node.parameters).toMatchObject({ respondWith: 'redirect', redirectURL: 'https://example.com/done' });
    expect(importNode('respondToWebhook', { respondWith: 'allIncomingItems', options: { responseKey: 'data' } }).node.parameters).toEqual({ respondWith: 'allIncomingItems', options: { responseKey: 'data' } });
    const jwt = importNode('respondToWebhook', { respondWith: 'jwt', payload: '{ "sub": "42" }' });
    expect(jwt.node.parameters).toMatchObject({ respondWith: 'json', responseBody: '{ "sub": "42" }' });
    expect(jwt.warnings[0]).toContain('JWT responses aren\'t available');
    const binary = importNode('respondToWebhook', { respondWith: 'binary' });
    expect(binary.node.parameters.respondWith).toBe('firstIncomingItem');
    expect(binary.warnings).toEqual(['Node: responding with “binary” isn\'t available; it responds with the first incoming item.']);
  });

  it('maps the Execute Workflow Trigger’s input modes', () => {
    expect(importNode('executeWorkflowTrigger', { inputSource: 'passthrough' }, { typeVersion: 1.1 }).node).toMatchObject({ type: 'core.workflowTrigger', parameters: { inputSource: 'passthrough' } });
    // v1 triggers took whatever the caller sent.
    expect(importNode('executeWorkflowTrigger', { events: 'worklfow_call' }).node.parameters).toEqual({ inputSource: 'passthrough' });
    const defined = importNode(
      'executeWorkflowTrigger',
      { workflowInputs: { values: [{ name: 'email' }, { name: 'count', type: 'number' }, { name: 'payload', type: 'any' }, { name: 'tags', type: 'array' }] } },
      { typeVersion: 1.1 },
    );
    expect(defined.node.parameters).toEqual({
      inputSource: 'workflowInputs',
      inputs: {
        fields: [
          { name: 'email', type: 'string', description: '', required: false },
          { name: 'count', type: 'number', description: '', required: false },
          { name: 'payload', type: 'json', description: '', required: false },
          { name: 'tags', type: 'json', description: '', required: false },
        ],
      },
    });
    const example = importNode('executeWorkflowTrigger', { inputSource: 'jsonExample', jsonExample: '{ "name": "Ada", "age": 36, "vip": true, "address": {} }' }, { typeVersion: 1.1 });
    expect((example.node.parameters.inputs as { fields: Array<{ name: string; type: string }> }).fields.map((f) => [f.name, f.type])).toEqual([
      ['name', 'string'],
      ['age', 'number'],
      ['vip', 'boolean'],
      ['address', 'json'],
    ]);
    expect(example.warnings).toEqual([]);
  });

  it('maps Execute Workflow’s inputs, mode and wait option, leaving the workflow to choose', () => {
    const mapped = importNode(
      'executeWorkflow',
      {
        workflowId: { __rl: true, value: 'aBc123', mode: 'list', cachedResultName: 'Enrich lead' },
        workflowInputs: { mappingMode: 'defineBelow', value: { email: '={{ $json.email }}', limit: 5, unused: null }, matchingColumns: [], schema: [] },
        mode: 'each',
        options: { waitForSubWorkflow: false },
      },
      { typeVersion: 1.2 },
    );
    expect(mapped.node).toMatchObject({
      type: 'core.executeWorkflow',
      parameters: {
        workflowId: '',
        inputSource: 'map',
        workflowInputs: {
          values: [
            { name: 'email', value: '{{ $json.email }}' },
            { name: 'limit', value: '5' },
          ],
        },
        mode: 'each',
        options: { waitForSubWorkflow: false },
      },
    });
    expect(mapped.warnings).toEqual(['Node: choose the workflow to run; in n8n it ran “Enrich lead” (aBc123), which has to be imported first.']);
    const passthrough = importNode('executeWorkflow', { workflowId: 'xYz' });
    expect(passthrough.node.parameters).toEqual({ workflowId: '', inputSource: 'passthrough', mode: 'once', options: {} });
    expect(passthrough.warnings).toEqual(['Node: choose the workflow to run; in n8n it ran xYz, which has to be imported first.']);
    expect(importNode('executeWorkflow', { source: 'parameter', workflowJson: '{}' }).warnings[0]).toContain('came from JSON in the node');
  });

  it('maps Wait onto Wait v2, with n8n’s resume modes and limits', () => {
    // Exports leave defaults out: 5 seconds in Wait 1.1, 1 hour in 1.0.
    const short = importNode('wait', {}, { typeVersion: 1.1 });
    expect(short.node).toMatchObject({ type: 'core.wait', typeVersion: 2, parameters: { resume: 'timeInterval', amount: 5, unit: 'seconds' } });
    expect(short.node.parameters).not.toHaveProperty('seconds');
    expect(importNode('wait', { amount: 2 }).node.parameters).toEqual({ resume: 'timeInterval', amount: 2, unit: 'hours' });
    const long = importNode('wait', { amount: 3, unit: 'days' }, { typeVersion: 1.1 });
    expect(long.node.parameters).toEqual({ resume: 'timeInterval', amount: 3, unit: 'days' });
    expect(long.warnings).toEqual([]);
    expect(importNode('wait', { resume: 'specificTime', dateTime: '2026-12-24T18:00:00' }, { typeVersion: 1.1 }).node.parameters).toEqual({ resume: 'specificTime', dateTime: '2026-12-24T18:00:00' });
    const webhook = importNode(
      'wait',
      { resume: 'webhook', httpMethod: 'POST', responseMode: 'responseNode', limitWaitTime: true, resumeAmount: 2, resumeUnit: 'days', options: { webhookSuffix: 'approve' } },
      { typeVersion: 1.1 },
    );
    expect(webhook.node.parameters).toEqual({ resume: 'webhook', httpMethod: 'POST', responseMode: 'responseNode', limitWaitTime: true, limitType: 'afterTimeInterval', resumeAmount: 2, resumeUnit: 'days' });
    expect(webhook.warnings).toEqual(['Node: the option “webhookSuffix” has no Landflow equivalent and was dropped.']);
    const form = importNode(
      'wait',
      {
        resume: 'form',
        formTitle: 'Approve?',
        formFields: { values: [{ fieldLabel: 'Decision', fieldType: 'radio', fieldOptions: { values: [{ option: 'Yes' }, { option: 'No' }] }, requiredField: true }] },
        limitWaitTime: true,
        limitType: 'atSpecifiedTime',
        maxDateAndTime: '2026-12-31T00:00:00',
        options: { buttonLabel: 'Send' },
      },
      { typeVersion: 1.1 },
    );
    expect(form.node.parameters).toEqual({
      resume: 'form',
      formTitle: 'Approve?',
      formDescription: '',
      formFields: { values: [{ fieldLabel: 'Decision', fieldType: 'radio', requiredField: true, fieldOptions: 'Yes\nNo' }] },
      buttonLabel: 'Send',
      limitWaitTime: true,
      limitType: 'atSpecifiedTime',
      maxDateAndTime: '2026-12-31T00:00:00',
    });
    expect(form.warnings).toEqual([]);
  });

  it('maps Loop Over Items, and Split in Batches v1/v2 onto its loop output', () => {
    const doc = (typeVersion: number, parameters: Record<string, unknown>) => ({
      nodes: [
        { parameters: {}, name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0] },
        { parameters, name: 'Loop', type: 'n8n-nodes-base.splitInBatches', typeVersion, position: [200, 0] },
        { parameters: {}, name: 'Done', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [400, -100] },
        { parameters: {}, name: 'Each', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [400, 100] },
      ],
      connections: {
        Start: { main: [[{ node: 'Loop', type: 'main', index: 0 }]] },
        Loop: { main: typeVersion >= 3 ? [[{ node: 'Done', type: 'main', index: 0 }], [{ node: 'Each', type: 'main', index: 0 }]] : [[{ node: 'Each', type: 'main', index: 0 }]] },
        Each: { main: [[{ node: 'Loop', type: 'main', index: 0 }]] },
      },
    });
    const outputs = ({ workflow }: ReturnType<typeof importWorkflowJson>) => {
      const loop = workflow.nodes.find((n) => n.name === 'Loop')!;
      return Object.fromEntries(workflow.connections.filter((c) => c.source === loop.id).map((c) => [workflow.nodes.find((n) => n.id === c.target)!.name, c.sourceIndex]));
    };
    const v3 = importWorkflowJson(doc(3, { batchSize: 5, options: { reset: false } }), { resolveType });
    expect(v3.workflow.nodes[1]).toMatchObject({ type: 'core.splitInBatches', typeVersion: 3, parameters: { batchSize: 5, options: { reset: false } } });
    expect(outputs(v3)).toEqual({ Done: 0, Each: 1 });
    expect(v3.report.warnings).toEqual([]);
    const v2 = importWorkflowJson(doc(2, {}), { resolveType });
    expect(v2.workflow.nodes[1].parameters).toMatchObject({ batchSize: 10 });
    expect(outputs(v2)).toEqual({ Each: 1 });
    expect(v2.report.warnings.some((w) => w.startsWith('Loop: Split in Batches v2 became Loop Over Items'))).toBe(true);
  });

  it('maps the Error Trigger', () => {
    const { node, report } = importNode('errorTrigger', {});
    expect(node).toMatchObject({ type: 'core.errorTrigger', parameters: {} });
    expect(report.placeholders).toEqual([]);
  });

  it('maps the Form Trigger: path, fields, button label, end screen and response mode', () => {
    const v22 = importNode(
      'formTrigger',
      {
        formTitle: 'Contact us',
        formDescription: 'We answer within a day',
        formFields: {
          values: [
            { fieldLabel: 'Name', requiredField: true, placeholder: 'Ada Lovelace' },
            { fieldLabel: 'Email', fieldType: 'email', requiredField: true },
            { fieldLabel: 'Topics', fieldType: 'dropdown', fieldOptions: { values: [{ option: 'Sales' }, { option: 'Support' }] }, multiselect: true },
            { fieldLabel: 'Attachment', fieldType: 'file', multipleFiles: true, acceptFileTypes: '.pdf' },
            { fieldName: 'utm', fieldType: 'hiddenField' },
          ],
        },
        responseMode: 'lastNode',
        options: { path: 'contact', buttonLabel: 'Send', respondWithOptions: { values: { respondWith: 'text', formSubmittedText: 'Thanks!' } }, appendAttribution: false },
      },
      { typeVersion: 2.2, webhookId: 'f6a2' },
    );
    expect(v22.node).toMatchObject({
      type: 'core.formTrigger',
      parameters: {
        path: 'contact',
        formTitle: 'Contact us',
        formDescription: 'We answer within a day',
        responseMode: 'lastNode',
        formFields: {
          values: [
            { fieldLabel: 'Name', fieldType: 'text', requiredField: true, placeholder: 'Ada Lovelace' },
            { fieldLabel: 'Email', fieldType: 'email', requiredField: true },
            { fieldLabel: 'Topics', fieldType: 'dropdown', requiredField: false, fieldOptions: 'Sales\nSupport', multiselect: true },
            { fieldLabel: 'Attachment', fieldType: 'file', requiredField: false, multipleFiles: true, acceptFileTypes: '.pdf' },
          ],
        },
        options: { buttonLabel: 'Send', formSubmittedText: 'Thanks!' },
      },
    });
    expect(v22.warnings).toEqual(['Node: Landflow forms can\'t show “utm” (hiddenField); it was dropped.']);
    // From v2.2 a form without a path is served at its webhook id; before, the path was a parameter.
    expect(importNode('formTrigger', { formTitle: 'T' }, { typeVersion: 2.2, webhookId: 'f6a2' }).node.parameters.path).toBe('f6a2');
    const v1 = importNode('formTrigger', { path: '/signup', formTitle: 'Sign up', responseMode: 'responseNode', options: { formSubmittedText: 'Done' } });
    expect(v1.node.parameters).toMatchObject({ path: 'signup', responseMode: 'lastNode', options: { formSubmittedText: 'Done' } });
    expect(v1.warnings[0]).toContain('a Respond to Webhook node can\'t answer a form');
  });

  it('maps Form pages and endings', () => {
    const page = importNode('form', {
      formFields: { values: [{ fieldLabel: 'Rating', fieldType: 'number', requiredField: true }] },
      options: { formTitle: 'Step 2', formDescription: 'Almost done', buttonLabel: 'Next' },
    });
    expect(page.node).toMatchObject({
      type: 'core.form',
      parameters: { operation: 'page', formTitle: 'Step 2', formDescription: 'Almost done', buttonLabel: 'Next', formFields: { values: [{ fieldLabel: 'Rating', fieldType: 'number', requiredField: true }] } },
    });
    const json = importNode('form', { defineForm: 'json', jsonOutput: '[{ "fieldLabel": "Color", "fieldType": "radio", "fieldOptions": { "values": [{ "option": "Red" }, { "option": "Blue" }] } }]' });
    expect(json.node.parameters.formFields).toEqual({ values: [{ fieldLabel: 'Color', fieldType: 'radio', requiredField: false, fieldOptions: 'Red\nBlue' }] });
    expect(importNode('form', { operation: 'completion', completionTitle: 'Thanks', completionMessage: 'We got it' }).node.parameters).toEqual({
      operation: 'completion',
      respondWith: 'text',
      completionTitle: 'Thanks',
      completionMessage: 'We got it',
    });
    expect(importNode('form', { operation: 'completion', respondWith: 'redirect', redirectUrl: 'https://example.com' }).node.parameters).toEqual({
      operation: 'completion',
      respondWith: 'redirect',
      redirectUrl: 'https://example.com',
    });
  });

  it('keeps the registered-only types as placeholders when they aren’t registered', () => {
    const types = ['formTrigger', 'form', 'respondToWebhook', 'executeWorkflow', 'splitInBatches', 'errorTrigger'];
    const resolve = (type: string) => (types.some((t) => type === `core.${t}`) ? undefined : resolveType(type));
    for (const type of types) {
      const { node, report } = importNode(type, {}, { typeVersion: 3 }, resolve);
      expect(node).toMatchObject({ type: 'core.noOp', disabled: true });
      expect(report.placeholders).toEqual([{ name: 'Node', type: `n8n-nodes-base.${type}` }]);
    }
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

describe('n8n import: MCP nodes', () => {
  it('maps the MCP Client Tool, including v1 SSE endpoints', () => {
    const doc = {
      nodes: [
        { parameters: { sseEndpoint: 'http://localhost:9000/sse', include: 'selected', includeTools: ['search'] }, name: 'MCP', type: '@n8n/n8n-nodes-langchain.mcpClientTool', typeVersion: 1, position: [0, 0] },
        { parameters: { endpointUrl: 'http://localhost:9000/mcp', serverTransport: 'httpStreamable' }, name: 'MCP 2', type: '@n8n/n8n-nodes-langchain.mcpClientTool', typeVersion: 1.1, position: [0, 200] },
        { parameters: { path: 'tools', authentication: 'bearerAuth' }, name: 'Serve', type: '@n8n/n8n-nodes-langchain.mcpTrigger', typeVersion: 2, position: [0, 400] },
      ],
      connections: {},
    };
    const [v1, v11, trigger] = importWorkflowJson(doc, { resolveType }).workflow.nodes;
    expect(v1).toMatchObject({ type: 'core.mcpClientTool', parameters: { endpointUrl: 'http://localhost:9000/sse', serverTransport: 'sse', include: 'selected', includeTools: ['search'] } });
    expect(v1.parameters).not.toHaveProperty('sseEndpoint');
    expect(v11).toMatchObject({ type: 'core.mcpClientTool', parameters: { endpointUrl: 'http://localhost:9000/mcp', serverTransport: 'httpStreamable' } });
    expect(trigger).toMatchObject({ type: 'core.mcpTrigger', parameters: { path: 'tools', authentication: 'bearerAuth' } });
  });
});

describe('n8n import: RAG, guardrails, Python, Cron, workflow tools and evaluations', () => {
  const L = '@n8n/n8n-nodes-langchain.';
  /** n8n nodes ([name, type, parameters, typeVersion]) and connections ([from, to, type]) imported against the core descriptors. */
  const importDoc = (nodes: Array<[string, string, Record<string, unknown>, number?]>, edges: Array<[string, string, string]> = []) => {
    const connections: Record<string, Record<string, Array<Array<{ node: string; type: string; index: number }>>>> = {};
    for (const [from, to, type] of edges) ((connections[from] ??= {})[type] ??= [[]])[0].push({ node: to, type, index: 0 });
    const { workflow, report } = importWorkflowJson(
      { nodes: nodes.map(([name, type, parameters, typeVersion], i) => ({ name, type, parameters, typeVersion: typeVersion ?? 1, position: [i * 200, 0] })), connections },
      { resolveType },
    );
    const parsed = workflowSchema.safeParse(workflow);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    const node = (name: string) => workflow.nodes.find((n) => n.name === name)!;
    const edge = (from: string, to: string) => workflow.connections.filter((c) => c.source === node(from)?.id && c.target === node(to)?.id);
    return { workflow, report, node, edge };
  };

  it('maps a RAG ingestion pipeline: loader, splitters, embeddings and the in-memory store', () => {
    const { node, edge, report } = importDoc(
      [
        ['Start', 'n8n-nodes-base.manualTrigger', {}],
        ['Store', `${L}vectorStoreInMemory`, { mode: 'insert', memoryKey: { __rl: true, value: 'kb', mode: 'list' }, clearStore: true }, 1.1],
        ['Loader', `${L}documentDefaultDataLoader`, { jsonMode: 'expressionData', jsonData: '={{ $json.text }}', textSplittingMode: 'custom', options: { metadata: { metadataValues: [{ name: 'source', value: '={{ $json.url }}' }] } } }, 1.1],
        ['Splitter', `${L}textSplitterRecursiveCharacterTextSplitter`, { chunkSize: 400, chunkOverlap: 40, options: { splitCode: 'markdown' } }],
        ['Embeddings', `${L}embeddingsOllama`, { model: 'mxbai-embed-large' }],
      ],
      [
        ['Start', 'Store', 'main'],
        ['Loader', 'Store', 'ai_document'],
        ['Splitter', 'Loader', 'ai_textSplitter'],
        ['Embeddings', 'Store', 'ai_embedding'],
      ],
    );
    expect(node('Store')).toMatchObject({ type: 'core.vectorStoreInMemory', parameters: { mode: 'insert', collection: 'kb', clearStore: true } });
    expect(node('Loader')).toMatchObject({
      type: 'core.documentDefaultDataLoader',
      parameters: { jsonMode: 'expressionData', jsonData: '{{ $json.text }}', textSplittingMode: 'custom', options: { metadata: { metadataValues: [{ name: 'source', value: '{{ $json.url }}' }] } } },
    });
    expect(node('Splitter')).toMatchObject({ type: 'core.textSplitterRecursiveCharacterTextSplitter', parameters: { chunkSize: 400, chunkOverlap: 40, options: { splitCode: 'markdown' } } });
    expect(node('Embeddings')).toMatchObject({ type: 'core.embeddingsOllama', parameters: { model: 'mxbai-embed-large' } });
    expect(edge('Loader', 'Store')).toMatchObject([{ type: 'ai_document' }]);
    expect(edge('Splitter', 'Loader')).toMatchObject([{ type: 'ai_textSplitter' }]);
    expect(edge('Embeddings', 'Store')).toMatchObject([{ type: 'ai_embedding' }]);
    expect(edge('Start', 'Store')).toMatchObject([{ type: 'main' }]);
    expect(report.placeholders).toEqual([]);
    expect(report.warnings).toContain('Embeddings: set the Ollama base URL on the node; n8n kept it in the Ollama credential.');
  });

  it('maps token and character splitters, OpenAI embeddings and a v1 loader (which always took a splitter)', () => {
    const { node } = importDoc([
      ['Tokens', `${L}textSplitterTokenSplitter`, { chunkSize: 256 }],
      ['Chars', `${L}textSplitterCharacterTextSplitter`, { separator: '\n---\n', chunkSize: 500 }],
      ['OpenAI', `${L}embeddingsOpenAi`, { model: 'text-embedding-3-large', options: { dimensions: 1024, stripNewLines: true } }],
      ['Loader v1', `${L}documentDefaultDataLoader`, {}, 1],
      ['Loader binary', `${L}documentDefaultDataLoader`, { dataType: 'binary' }, 1.1],
    ]);
    expect(node('Tokens')).toMatchObject({ type: 'core.textSplitterTokenSplitter', parameters: { chunkSize: 256, chunkOverlap: 0 } });
    expect(node('Chars')).toMatchObject({ type: 'core.textSplitterRecursiveCharacterTextSplitter', parameters: { chunkSize: 500, options: { separators: '["\\n---\\n",""]' } } });
    expect(node('OpenAI').parameters).toMatchObject({ model: 'text-embedding-3-large', options: { dimensions: 1024 } });
    expect(node('OpenAI').parameters.options).not.toHaveProperty('stripNewLines');
    expect(node('Loader v1').parameters).toMatchObject({ jsonMode: 'allInputData', textSplittingMode: 'custom' });
    expect(node('Loader binary').parameters).toMatchObject({ textSplittingMode: 'simple' });
  });

  it('maps PGVector in its modes, and the retrieval QA chain on a retriever', () => {
    const { node, edge, report } = importDoc(
      [
        ['Chat', `${L}chatTrigger`, {}],
        ['QA', `${L}chainRetrievalQa`, { promptType: 'define', text: '={{ $json.chatInput }} (answer briefly)', options: { systemPromptTemplate: 'Use {context}' } }, 1.5],
        ['Model', `${L}lmChatOllama`, { model: 'qwen3-coder:30b' }],
        ['PG', `${L}vectorStorePGVector`, { mode: 'retrieve', tableName: 'docs', topK: 6, options: { collection: { values: { useCollection: true, collectionName: 'handbook' } }, distanceStrategy: 'innerProduct' } }, 1.1],
        ['Embed', `${L}embeddingsOpenAi`, {}],
        ['PG load', `${L}vectorStorePGVector`, { mode: 'load', prompt: '={{ $json.q }}' }, 1.1],
        ['PG update', `${L}vectorStorePGVector`, { mode: 'update' }, 1.1],
      ],
      [
        ['Chat', 'QA', 'main'],
        ['Model', 'QA', 'ai_languageModel'],
        ['PG', 'QA', 'ai_retriever'],
        ['Embed', 'PG', 'ai_embedding'],
      ],
    );
    expect(node('QA')).toMatchObject({ type: 'core.chainRetrievalQa', parameters: { query: '{{ $json.chatInput }} (answer briefly)', options: { systemPromptTemplate: 'Use {context}' } } });
    expect(node('PG')).toMatchObject({ type: 'core.vectorStorePGVector', parameters: { mode: 'retrieve', tableName: 'docs', collection: 'handbook', topK: 6 } });
    expect(edge('PG', 'QA')).toMatchObject([{ type: 'ai_retriever' }]);
    expect(edge('Model', 'QA')).toMatchObject([{ type: 'ai_languageModel' }]);
    expect(node('PG load').parameters).toMatchObject({ mode: 'load', prompt: '{{ $json.q }}', tableName: 'n8n_vectors', collection: 'landflow' });
    expect(node('PG update').parameters).toMatchObject({ mode: 'insert' });
    expect(report.warnings).toContain('PG: Landflow searches by cosine distance (n8n used innerProduct).');
    expect(report.warnings.some((w) => w.startsWith('PG update: “Update Documents” isn\'t available'))).toBe(true);
  });

  it('merges the Vector Store Tool and Retriever into their stores (tool and retriever modes)', () => {
    const { workflow, node, edge, report } = importDoc(
      [
        ['Agent', `${L}agent`, {}, 1.7],
        ['Agent model', `${L}lmChatOpenAi`, { model: 'gpt-5-mini' }],
        ['Answer docs', `${L}toolVectorStore`, { name: 'company docs', description: 'Questions about the company', topK: 3 }, 1],
        ['QA model', `${L}lmChatOpenAi`, {}],
        ['Docs', `${L}vectorStoreInMemory`, { memoryKey: 'company' }],
        ['Embed', `${L}embeddingsOpenAi`, {}],
        ['QA', `${L}chainRetrievalQa`, {}],
        ['Retriever', `${L}retrieverVectorStore`, { topK: 2 }],
        ['Handbook', `${L}vectorStorePGVector`, { tableName: 'handbook' }],
      ],
      [
        ['Agent model', 'Agent', 'ai_languageModel'],
        ['Answer docs', 'Agent', 'ai_tool'],
        ['QA model', 'Answer docs', 'ai_languageModel'],
        ['Docs', 'Answer docs', 'ai_vectorStore'],
        ['Embed', 'Docs', 'ai_embedding'],
        ['Retriever', 'QA', 'ai_retriever'],
        ['Handbook', 'Retriever', 'ai_vectorStore'],
        ['Embed', 'Handbook', 'ai_embedding'],
      ],
    );
    expect(workflow.nodes.map((n) => n.name)).not.toContain('Answer docs');
    expect(workflow.nodes.map((n) => n.name)).not.toContain('Retriever');
    expect(node('Docs')).toMatchObject({ type: 'core.vectorStoreInMemory', parameters: { mode: 'retrieve-as-tool', toolName: 'company_docs', toolDescription: 'Questions about the company', topK: 3, collection: 'company' } });
    expect(edge('Docs', 'Agent')).toMatchObject([{ type: 'ai_tool' }]);
    expect(node('Handbook')).toMatchObject({ type: 'core.vectorStorePGVector', parameters: { mode: 'retrieve', topK: 2, tableName: 'handbook' } });
    expect(edge('Handbook', 'QA')).toMatchObject([{ type: 'ai_retriever' }]);
    expect(edge('Embed', 'Handbook')).toHaveLength(1);
    expect(report.mapped).toContainEqual({ name: 'Answer docs', from: `${L}toolVectorStore`, to: 'core.vectorStoreInMemory' });
    expect(report.mapped).toContainEqual({ name: 'Retriever', from: `${L}retrieverVectorStore`, to: 'core.vectorStorePGVector' });
    expect(report.warnings).toContain('Answer docs: merged into “Docs”, which is now the agent’s tool itself.');
    expect(report.warnings).toContain('Connection QA model → Answer docs (ai_languageModel) dropped: Landflow’s vector store hands the documents to the agent, which answers itself.');
    expect(report.placeholders).toEqual([]);
  });

  it('maps Guardrails, writing every switch out', () => {
    const { node } = importDoc([
      [
        'Check',
        `${L}guardrails`,
        {
          operation: 'classify',
          text: '={{ $json.chatInput }}',
          guardrails: {
            pii: { value: { type: 'selected', entities: ['EMAIL_ADDRESS', 'PERSON'] } },
            keywords: 'refund, lawsuit',
            urls: { value: { allowedUrls: 'example.com', allowedSchemes: ['https', 'http'], allowSubdomains: true } },
            jailbreak: { value: { threshold: 0.8 } },
            topicalAlignment: { value: { prompt: 'Bike shop questions only', threshold: 0.6 } },
            custom: { guardrail: [{ name: 'Competitors', prompt: 'mentions a competitor', threshold: 0.5 }] },
            customRegex: { regex: [{ name: 'ORDER', value: 'ORD-\\d+' }] },
          },
        },
      ],
      ['Clean', `${L}guardrails`, { operation: 'sanitize', guardrails: { secretKeys: { value: { permissiveness: 'strict' } } } }],
    ]);
    expect(node('Check').parameters).toMatchObject({
      operation: 'check',
      text: '{{ $json.chatInput }}',
      pii: true,
      piiEntities: ['EMAIL_ADDRESS'],
      secrets: false,
      keywords: true,
      keywordList: 'refund, lawsuit',
      urls: true,
      allowedUrls: 'example.com',
      allowedSchemes: ['https', 'http'],
      allowSubdomains: true,
      jailbreak: true,
      jailbreakUseModel: true,
      jailbreakThreshold: 0.8,
      topical: true,
      topicalPrompt: 'Bike shop questions only',
      topicalThreshold: 0.6,
      nsfw: false,
      customChecks: { checks: [{ name: 'Competitors', prompt: 'mentions a competitor', threshold: 0.5 }] },
      customRegex: { rules: [{ name: 'ORDER', pattern: 'ORD-\\d+' }] },
    });
    expect(node('Clean').parameters).toMatchObject({ operation: 'sanitize', secrets: true, secretsPermissiveness: 'strict', pii: false, jailbreak: false });
  });

  it('keeps Python Code nodes as Python', () => {
    const { node, report } = importDoc([
      ['All', 'n8n-nodes-base.code', { language: 'python', pythonCode: 'return [{"json": {"n": len(_input.all())}}]' }, 2],
      ['Each', 'n8n-nodes-base.code', { language: 'python', mode: 'runOnceForEachItem', pythonCode: '_json["seen"] = True\nreturn _input.item' }, 2],
      ['Native', 'n8n-nodes-base.code', { language: 'pythonNative', pythonCode: 'return _items' }, 2],
    ]);
    expect(node('All')).toMatchObject({ type: 'core.code', parameters: { language: 'python', mode: 'all', pythonCode: 'return [{"json": {"n": len(_input.all())}}]' } });
    expect(node('All').disabled).toBeUndefined();
    expect(node('Each').parameters).toMatchObject({ language: 'python', mode: 'each', pythonCodeEach: '_json["seen"] = True\nreturn _input.item' });
    expect(node('Native').parameters.pythonCode).toBe('_items = [{"json": item.json} for item in _input.all()]\nreturn _items');
    expect(report.warnings).toContain('All: Python runs in the code runner sandbox (LANDFLOW_CODE_RUNNER_URL); the node fails while none is configured.');
  });

  it('maps every legacy Cron trigger time onto Schedule rules, with the Cron node’s defaults', () => {
    const { node, report } = importDoc([
      [
        'Cron',
        'n8n-nodes-base.cron',
        {
          triggerTimes: {
            item: [
              { mode: 'everyMinute' },
              { mode: 'everyHour', minute: 15 },
              { mode: 'everyDay' },
              { mode: 'everyWeek', hour: 9, weekday: '5' },
              { mode: 'everyMonth', hour: 6, minute: 30, dayOfMonth: 15 },
              { mode: 'everyX', value: 10, unit: 'minutes' },
              { mode: 'everyX', value: 120, unit: 'minutes' },
              { mode: 'everyX', value: 48, unit: 'hours' },
              { mode: 'everyX', value: 90, unit: 'minutes' },
              { mode: 'custom', cronExpression: '0 */5 * * * *' },
            ],
          },
        },
      ],
    ]);
    expect(node('Cron')).toMatchObject({ type: 'core.schedule' });
    expect(node('Cron').parameters).toEqual({
      unit: 'rules',
      rule: {
        interval: [
          { field: 'minutes', minutesInterval: 1 },
          { field: 'hours', hoursInterval: 1, triggerAtMinute: 15 },
          { field: 'days', daysInterval: 1, triggerAtHour: 14, triggerAtMinute: 0 },
          { field: 'weeks', weeksInterval: 1, triggerAtDay: [5], triggerAtHour: 9, triggerAtMinute: 0 },
          { field: 'months', monthsInterval: 1, triggerAtDayOfMonth: 15, triggerAtHour: 6, triggerAtMinute: 30 },
          { field: 'minutes', minutesInterval: 10 },
          { field: 'hours', hoursInterval: 2, triggerAtMinute: 0 },
          { field: 'days', daysInterval: 2, triggerAtHour: 0, triggerAtMinute: 0 },
          { field: 'hours', hoursInterval: 2, triggerAtMinute: 0 },
          { field: 'cronExpression', expression: '0 */5 * * * *' },
        ],
      },
    });
    expect(report.warnings).toContain('Cron: “every 90 minutes” has no Trigger Rule; it now runs every 2 hours.');
    // No trigger times: n8n's default, every day at 14:00.
    expect(importDoc([['Cron', 'n8n-nodes-base.cron', {}]]).node('Cron').parameters).toEqual({ unit: 'rules', rule: { interval: [{ field: 'days', daysInterval: 1, triggerAtHour: 14, triggerAtMinute: 0 }] } });
  });

  it('maps the Call n8n Workflow Tool onto an Execute Workflow tool', () => {
    const { node, edge, report } = importDoc(
      [
        ['Agent', `${L}agent`, {}, 1.7],
        [
          'Lookup',
          `${L}toolWorkflow`,
          { description: 'Look up a customer', workflowId: { __rl: true, value: 'abc', mode: 'list', cachedResultName: 'CRM lookup' }, workflowInputs: { value: { email: '={{ $fromAI("email") }}' } } },
          2,
        ],
        ['Legacy', `${L}toolWorkflow`, { name: 'legacy', description: 'Old tool', source: 'database', workflowId: 'x1', fields: { values: [{ name: 'q', stringValue: '={{ $fromAI("q") }}' }] } }, 1.3],
      ],
      [
        ['Lookup', 'Agent', 'ai_tool'],
        ['Legacy', 'Agent', 'ai_tool'],
      ],
    );
    expect(node('Lookup')).toMatchObject({ type: 'core.executeWorkflow', notes: 'Look up a customer', parameters: { workflowId: '', inputSource: 'map', workflowInputs: { values: [{ name: 'email', value: '{{ $fromAI("email") }}' }] } } });
    expect(node('Legacy').parameters).toMatchObject({ inputSource: 'map', workflowInputs: { values: [{ name: 'q', value: '{{ $fromAI("q") }}' }] } });
    expect(edge('Lookup', 'Agent')).toMatchObject([{ type: 'ai_tool' }]);
    expect(edge('Legacy', 'Agent')).toMatchObject([{ type: 'ai_tool' }]);
    expect(report.warnings).toContain('Lookup: choose the workflow to run; in n8n it ran “CRM lookup” (abc), which has to be imported first.');
  });

  it('maps the n8n Evaluation Trigger and Evaluation node operations onto Landflow’s', () => {
    const { node, edge, report } = importDoc(
      [
        ['When fetching a dataset row', 'n8n-nodes-base.evaluationTrigger', { source: 'dataTable', dataTableId: { __rl: true, value: 'n8nTbl1', mode: 'list', cachedResultName: 'qa_cases' }, limitRows: true, maxRows: 5 }, 4.7],
        ['Evaluating?', 'n8n-nodes-base.evaluation', { operation: 'checkIfEvaluating' }, 4.7],
        ['Set outputs', 'n8n-nodes-base.evaluation', { outputs: { assignments: [{ id: 'a', name: 'answer', value: '={{ $json.output }}', type: 'string' }] } }, 4.7],
        ['Correctness', 'n8n-nodes-base.evaluation', { operation: 'setMetrics', expectedAnswer: "={{ $('When fetching a dataset row').item.json.expected }}", actualAnswer: '={{ $json.output }}', userQuery: '={{ $json.q }}' }, 4.7],
        ['Category', 'n8n-nodes-base.evaluation', { operation: 'setMetrics', metric: 'categorization', expectedAnswer: 'a', actualAnswer: 'b' }, 4.7],
        ['Tools', 'n8n-nodes-base.evaluation', { operation: 'setMetrics', metric: 'toolsUsed', expectedTools: 'calculator', intermediateSteps: '={{ $json.intermediateSteps }}' }, 4.7],
        ['Custom', 'n8n-nodes-base.evaluation', { operation: 'setMetrics', metric: 'customMetrics', metrics: { assignments: [{ name: 'length', value: '={{ $json.output.length }}', type: 'number' }] } }, 4.7],
        ['Sheet trigger', 'n8n-nodes-base.evaluationTrigger', { documentId: { __rl: true, value: 'sheet' }, sheetName: 'Sheet1' }, 4.6],
      ],
      [
        ['When fetching a dataset row', 'Evaluating?', 'main'],
        ['Evaluating?', 'Set outputs', 'main'],
      ],
    );
    expect(node('When fetching a dataset row')).toMatchObject({ type: 'core.evaluationTrigger', parameters: { dataTableId: 'qa_cases', limitRows: true, maxRows: 5 } });
    expect(node('Evaluating?')).toMatchObject({ type: 'core.evaluation', parameters: { operation: 'checkIfEvaluating' } });
    expect(edge('Evaluating?', 'Set outputs')).toMatchObject([{ sourceIndex: 0 }]);
    expect(node('Set outputs').parameters).toMatchObject({ operation: 'setOutputs', outputs: { values: [{ name: 'answer', value: '{{ $json.output }}' }] }, destination: 'row' });
    expect(node('Correctness').parameters).toMatchObject({ operation: 'setMetrics', metric: 'correctness', actualAnswer: '{{ $json.output }}', userQuery: '{{ $json.q }}' });
    expect(node('Category').parameters).toMatchObject({ metric: 'exactMatch', metricName: 'categorization' });
    expect(node('Tools').parameters).toMatchObject({ metric: 'toolsUsed', expectedTools: 'calculator', toolsSource: 'expression', actualTools: '{{ $json.intermediateSteps }}' });
    expect(node('Custom').parameters).toMatchObject({ metric: 'customMetrics', metrics: { values: [{ name: 'length', value: '{{ $json.output.length }}' }] } });
    expect(node('Sheet trigger').parameters).toMatchObject({ dataTableId: '' });
    expect(report.warnings).toContain('Sheet trigger: Landflow reads test cases from a Data Table; import the Google Sheet as one (CSV), then choose it.');
    expect(report.placeholders).toEqual([]);
  });
});
