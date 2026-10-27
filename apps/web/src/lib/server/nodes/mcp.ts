/**
 * MCP (Model Context Protocol) nodes, after n8n's: the MCP Client Tool gives an AI Agent the tools
 * of an MCP server, the MCP Client calls one tool in the main flow, and the MCP Server Trigger
 * serves the tools attached to it at /mcp/<path> (lib/server/mcp/trigger.ts). Parameter and
 * credential names follow n8n's (`endpointUrl`, `serverTransport`, `authentication`, `include`,
 * `includeTools`, `excludeTools`; httpBearerAuth, httpHeaderAuth), so n8n's mcpClientTool and
 * mcpTrigger can map onto these one to one.
 */
import { defineNode, NodeOperationError, type IBaseContext, type IExecuteContext, type ILoadOptionsContext, type JsonObject, type NodeItem, type PropertyDescriptor } from '@landflow/sdk';
import { ExpressionResolver, type AgentTool } from '@landflow/engine';
import { variables } from '../variables';
import {
  agentToolsFrom,
  callMcpTool,
  compactContent,
  endpointFrom,
  getMcpPrompt,
  promptText,
  listMcpPrompts,
  listMcpResources,
  listMcpResourceTemplates,
  listMcpTools,
  McpClientError,
  readMcpResource,
  resourceAndPromptTools,
  resultText,
  selectTools,
  stringRecord,
  type McpCredentials,
  type McpEndpoint,
} from '../mcp/client';
import { isDynamic, promptDefs, promptMessages, resourceDefs, resourceText } from '../mcp/trigger-content';
import { store } from '../store';
import { workflowForCall } from '../publish';
import { callerAllowed, triggerOf, WORKFLOW_TRIGGER } from './workflows';

const main = [{ type: 'main' as const }];

const credentialRequirements = [
  { name: 'httpBearerAuth', required: true, displayOptions: { show: { authentication: ['bearerAuth'] } } },
  { name: 'httpHeaderAuth', required: true, displayOptions: { show: { authentication: ['headerAuth'] } } },
];

/** The clients also sign in with OAuth (core.mcpOAuth2Api: discovery, registration and PKCE in Connect). */
const clientCredentialRequirements = [...credentialRequirements, { name: 'mcpOAuth2Api', required: true, displayOptions: { show: { authentication: ['mcpOAuth2'] } } }];

const authenticationProperty: PropertyDescriptor = {
  name: 'authentication',
  displayName: 'Authentication',
  type: 'options',
  default: 'none',
  noDataExpression: true,
  options: [
    { name: 'None', value: 'none' },
    { name: 'Bearer Auth', value: 'bearerAuth', description: 'Authorization: Bearer <token>' },
    { name: 'Header Auth', value: 'headerAuth', description: 'A header name and value' },
  ],
};

const clientAuthenticationProperty: PropertyDescriptor = {
  ...authenticationProperty,
  options: [...(authenticationProperty.options ?? []), { name: 'MCP OAuth2', value: 'mcpOAuth2', description: 'The server signs users in with OAuth: Connect the credential once, tokens are renewed for you' }],
};

/** Where the server is: endpoint, transport and auth (shared by the client nodes). */
const serverProperties: PropertyDescriptor[] = [
  {
    name: 'endpointUrl',
    displayName: 'Endpoint URL',
    type: 'string',
    default: '',
    required: true,
    placeholder: 'https://mcp.example.com/mcp',
    description: 'The MCP server’s Streamable HTTP endpoint, or its SSE endpoint for older servers',
  },
  {
    name: 'serverTransport',
    displayName: 'Server Transport',
    type: 'options',
    default: 'httpStreamable',
    noDataExpression: true,
    options: [
      { name: 'HTTP Streamable', value: 'httpStreamable', description: 'The current MCP transport' },
      { name: 'Server-Sent Events (Deprecated)', value: 'sse', description: 'For servers that only speak the older SSE transport' },
    ],
  },
  clientAuthenticationProperty,
];

const timeoutOption: PropertyDescriptor = {
  name: 'timeout',
  displayName: 'Timeout (ms)',
  type: 'number',
  default: 60_000,
  typeOptions: { minValue: 1_000, maxValue: 600_000 },
  description: 'How long to wait for the server to answer a request',
};

function credentialsOf(ctx: Pick<IBaseContext, 'getCredentials'> | Pick<ILoadOptionsContext, 'getCredentials'>): McpCredentials {
  return {
    httpBearerAuth: ctx.getCredentials('httpBearerAuth', { optional: true }),
    httpHeaderAuth: ctx.getCredentials('httpHeaderAuth', { optional: true }),
    mcpOAuth2Api: ctx.getCredentials('mcpOAuth2Api', { optional: true }),
  };
}

function endpointOf(ctx: IBaseContext, itemIndex = 0): McpEndpoint {
  try {
    return endpointFrom(
      {
        endpointUrl: ctx.getNodeParameter('endpointUrl', itemIndex),
        serverTransport: ctx.getNodeParameter('serverTransport', itemIndex),
        authentication: ctx.getNodeParameter('authentication', itemIndex),
        options: ctx.getNodeParameter('options', itemIndex, {}),
      },
      credentialsOf(ctx),
    );
  } catch (error) {
    throw new NodeOperationError((error as Error).message, { itemIndex });
  }
}

/** The tool list for the pickers (loadOptions): the server's tools with their descriptions. */
async function toolOptions(ctx: ILoadOptionsContext) {
  const endpoint = endpointFrom(ctx.getCurrentParameters(), credentialsOf(ctx));
  const tools = await listMcpTools(endpoint);
  return tools.map((tool) => ({ name: tool.title || tool.name, value: tool.name, ...(tool.description && { description: tool.description.slice(0, 200) }) }));
}

/** The resource and prompt lists for the pickers. */
async function resourceOptions(ctx: ILoadOptionsContext) {
  const resources = await listMcpResources(endpointFrom(ctx.getCurrentParameters(), credentialsOf(ctx)));
  return resources.map((resource) => ({ name: String(resource.title || resource.name || resource.uri), value: String(resource.uri), ...(typeof resource.description === 'string' && { description: resource.description.slice(0, 200) }) }));
}

async function promptOptions(ctx: ILoadOptionsContext) {
  const prompts = await listMcpPrompts(endpointFrom(ctx.getCurrentParameters(), credentialsOf(ctx)));
  return prompts.map((prompt) => ({ name: String(prompt.title || prompt.name), value: String(prompt.name), ...(typeof prompt.description === 'string' && { description: prompt.description.slice(0, 200) }) }));
}

const toolsDependOn = ['endpointUrl', 'serverTransport', 'authentication'];

// ---------------------------------------------------------------------------
// MCP Client Tool (sub-node)
// ---------------------------------------------------------------------------

export const mcpClientToolNode = defineNode({
  description: {
    name: 'mcpClientTool',
    displayName: 'MCP Client Tool',
    description: 'Give the agent the tools of an MCP server (Streamable HTTP or SSE)',
    version: 1,
    kind: 'subnode',
    supplies: 'ai_tool',
    categories: ['AI', 'Tools'],
    icon: 'lucide:plug',
    color: '#f472b6',
    subtitle: '{{endpointUrl}}',
    keywords: ['mcp', 'model context protocol', 'mcp client', 'tools', 'server', 'connector'],
    credentials: clientCredentialRequirements,
    inputs: [],
    outputs: [{ type: 'ai_tool', displayName: 'Tools' }],
    properties: [
      ...serverProperties,
      {
        name: 'include',
        displayName: 'Tools to Include',
        type: 'options',
        default: 'all',
        noDataExpression: true,
        options: [
          { name: 'All', value: 'all', description: 'Every tool the server lists' },
          { name: 'Selected', value: 'selected', description: 'Only the tools picked below' },
          { name: 'All Except', value: 'except', description: 'Every tool except the ones picked below' },
        ],
      },
      {
        name: 'includeTools',
        displayName: 'Tools to Include',
        type: 'multiOptions',
        default: [],
        noDataExpression: true,
        typeOptions: { loadOptionsMethod: 'tools', loadOptionsDependsOn: toolsDependOn },
        displayOptions: { show: { include: ['selected'] } },
      },
      {
        name: 'excludeTools',
        displayName: 'Tools to Exclude',
        type: 'multiOptions',
        default: [],
        noDataExpression: true,
        typeOptions: { loadOptionsMethod: 'tools', loadOptionsDependsOn: toolsDependOn },
        displayOptions: { show: { include: ['except'] } },
      },
      {
        name: 'extras',
        displayName: 'Also Offer',
        type: 'multiOptions',
        default: [],
        noDataExpression: true,
        options: [
          { name: 'Resources', value: 'resources', description: 'Adds list_resources and read_resource: the documents and data the server offers' },
          { name: 'Prompts', value: 'prompts', description: 'Adds list_prompts and get_prompt: the prompt templates the server offers' },
        ],
      },
      { name: 'options', displayName: 'Options', type: 'collection', default: {}, placeholder: 'Add option', values: [timeoutOption] },
      {
        name: 'notice',
        displayName: 'Each MCP tool becomes a tool of the agent, with the server’s name, description and JSON schema.',
        type: 'notice',
      },
    ],
  },
  async supplyData(ctx): Promise<AgentTool[]> {
    const endpoint = endpointOf(ctx);
    let tools;
    try {
      tools = await listMcpTools(endpoint);
    } catch (error) {
      throw new NodeOperationError((error as Error).message, { description: 'Check the endpoint URL, the transport and the credential.' });
    }
    const selected = selectTools(tools, ctx.getNodeParameter('include'), ctx.getNodeParameter('includeTools', 0, []), ctx.getNodeParameter('excludeTools', 0, []));
    const extras = ctx.getNodeParameter('extras', 0, []);
    return [...agentToolsFrom(endpoint, selected), ...resourceAndPromptTools(endpoint, Array.isArray(extras) ? extras.map(String) : [])];
  },
  methods: { loadOptions: { tools: toolOptions } },
});

// ---------------------------------------------------------------------------
// MCP Client (action)
// ---------------------------------------------------------------------------

/** The tool's arguments: a JSON object, written as JSON text (expressions allowed) or set as an object. */
function argumentsOf(value: unknown, itemIndex: number): Record<string, unknown> {
  if (value === undefined || value === null || value === '') return {};
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch (error) {
      throw new NodeOperationError('“Arguments” is not valid JSON', { itemIndex, description: (error as Error).message });
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new NodeOperationError('“Arguments” must be a JSON object', { itemIndex });
  return parsed as Record<string, unknown>;
}

/** The resources and prompts operations of the MCP Client: the output items for one input item. */
async function resourceOrPrompt(ctx: IBaseContext, endpoint: McpEndpoint, operation: string, i: number): Promise<NodeItem[]> {
  const paired = { pairedItem: { item: i } };
  const fail = (error: Error): never => {
    throw new NodeOperationError(error.message, { itemIndex: i });
  };
  switch (operation) {
    case 'listResources': {
      const resources = await listMcpResources(endpoint).catch(fail);
      const templates = await listMcpResourceTemplates(endpoint).catch(() => []);
      return [...resources.map((json) => ({ json: { kind: 'resource', ...json }, ...paired })), ...templates.map((json) => ({ json: { kind: 'template', ...json }, ...paired }))];
    }
    case 'readResource': {
      const uri = String(ctx.getNodeParameter('resourceUri', i) ?? '').trim();
      if (!uri) throw new NodeOperationError('Choose a resource', { itemIndex: i });
      const contents = await readMcpResource(endpoint, uri).catch(fail);
      return contents.map((json) => ({ json, ...paired }));
    }
    case 'listPrompts':
      return (await listMcpPrompts(endpoint).catch(fail)).map((json) => ({ json, ...paired }));
    case 'getPrompt': {
      const name = String(ctx.getNodeParameter('promptName', i) ?? '').trim();
      if (!name) throw new NodeOperationError('Choose a prompt', { itemIndex: i });
      const prompt = await getMcpPrompt(endpoint, name, stringRecord(argumentsOf(ctx.getNodeParameter('promptArguments', i, '{}'), i))).catch(fail);
      return [{ json: { name, ...prompt, text: promptText(prompt) }, ...paired }];
    }
    default:
      throw new NodeOperationError(`Unknown operation “${operation}”`, { itemIndex: i });
  }
}

export const mcpClientNode = defineNode({
  description: {
    name: 'mcpClient',
    displayName: 'MCP Client',
    description: 'Call a tool of an MCP server, or list and read its resources and prompts',
    version: 1,
    kind: 'action',
    categories: ['AI'],
    icon: 'lucide:plug',
    color: '#a855f7',
    subtitle: '{{operation === "callTool" || !operation ? tool : operation}}',
    keywords: ['mcp', 'model context protocol', 'mcp client', 'call tool', 'server', 'resources', 'prompts'],
    credentials: clientCredentialRequirements,
    inputs: main,
    outputs: main,
    properties: [
      ...serverProperties,
      {
        name: 'operation',
        displayName: 'Operation',
        type: 'options',
        default: 'callTool',
        noDataExpression: true,
        options: [
          { name: 'Call Tool', value: 'callTool', description: 'Call one tool and output its result' },
          { name: 'List Resources', value: 'listResources', description: 'The documents and data the server offers (and its resource templates)' },
          { name: 'Read Resource', value: 'readResource', description: 'The contents of one resource' },
          { name: 'List Prompts', value: 'listPrompts', description: 'The prompt templates the server offers' },
          { name: 'Get Prompt', value: 'getPrompt', description: 'A prompt template with its arguments filled in' },
        ],
      },
      {
        name: 'resourceUri',
        displayName: 'Resource',
        type: 'options',
        default: '',
        required: true,
        typeOptions: { loadOptionsMethod: 'resources', loadOptionsDependsOn: toolsDependOn },
        description: 'Loaded from the server; an expression can build a URI from a resource template',
        displayOptions: { show: { operation: ['readResource'] } },
      },
      {
        name: 'promptName',
        displayName: 'Prompt',
        type: 'options',
        default: '',
        required: true,
        typeOptions: { loadOptionsMethod: 'prompts', loadOptionsDependsOn: toolsDependOn },
        description: 'Loaded from the server',
        displayOptions: { show: { operation: ['getPrompt'] } },
      },
      {
        name: 'promptArguments',
        displayName: 'Prompt Arguments',
        type: 'json',
        default: '{}',
        description: 'A JSON object with the prompt’s arguments (strings); expressions work inside it',
        displayOptions: { show: { operation: ['getPrompt'] } },
      },
      {
        name: 'tool',
        displayName: 'Tool',
        type: 'options',
        default: '',
        required: true,
        typeOptions: { loadOptionsMethod: 'tools', loadOptionsDependsOn: toolsDependOn },
        description: 'Loaded from the server',
        displayOptions: { show: { operation: ['callTool'] } },
      },
      {
        name: 'arguments',
        displayName: 'Arguments',
        type: 'json',
        default: '{}',
        description: 'A JSON object with the tool’s arguments; expressions such as {{ $json.query }} work inside it',
        displayOptions: { show: { operation: ['callTool'] } },
      },
      { name: 'options', displayName: 'Options', type: 'collection', default: {}, placeholder: 'Add option', values: [timeoutOption] },
      {
        name: 'notice',
        displayName:
          'Call Tool: each item calls the tool once and becomes { tool, text, content, structuredContent? }. List Resources / List Prompts: one item per resource, template or prompt. Read Resource: one item per content part { uri, mimeType, text }. Get Prompt: { name, description, messages, text }. An error fails the node (or becomes { error } with “Continue on error”).',
        type: 'notice',
      },
    ],
  },
  async execute(ctx) {
    const items = ctx.getInputData();
    const out: NodeItem[] = [];
    for (let i = 0; i < Math.max(items.length, 1); i++) {
      try {
        const endpoint = endpointOf(ctx, i);
        const operation = String(ctx.getNodeParameter('operation', i, 'callTool') ?? 'callTool');
        if (operation !== 'callTool') {
          out.push(...(await resourceOrPrompt(ctx, endpoint, operation, i)));
          continue;
        }
        const tool = String(ctx.getNodeParameter('tool', i) ?? '').trim();
        if (!tool) throw new NodeOperationError('Choose a tool', { itemIndex: i });
        const args = argumentsOf(ctx.getNodeParameter('arguments', i), i);
        const result = await callMcpTool(endpoint, tool, args, ctx.signal).catch((error: Error) => {
          throw new NodeOperationError(error.message, { itemIndex: i });
        });
        const text = resultText(result);
        if (result.isError) throw new NodeOperationError(`${tool} returned an error: ${text || 'no details'}`, { itemIndex: i });
        out.push({
          json: { tool, text, content: compactContent(result), ...(result.structuredContent !== undefined && { structuredContent: result.structuredContent as JsonObject }) },
          pairedItem: { item: i },
        });
      } catch (error) {
        if (!ctx.continueOnFail()) throw error;
        out.push({ json: { error: (error as Error).message }, pairedItem: { item: i } });
      }
    }
    return [out];
  },
  methods: { loadOptions: { tools: toolOptions, resources: resourceOptions, prompts: promptOptions } },
});

// ---------------------------------------------------------------------------
// MCP Server Trigger
// ---------------------------------------------------------------------------

/** Tool names must be unique on a server: a repeated name gets _2, _3 (as in the AI Agent). */
function uniqueNames(tools: AgentTool[]): AgentTool[] {
  const seen = new Map<string, number>();
  return tools.map((tool) => {
    const count = seen.get(tool.name) ?? 0;
    seen.set(tool.name, count + 1);
    return count ? { ...tool, name: `${tool.name.slice(0, 60)}_${count + 1}` } : tool;
  });
}

/** Where a resource's or prompt's content comes from (shared by both lists). */
function contentSource(label: string, hint: string): PropertyDescriptor[] {
  return [
    {
      name: 'source',
      displayName: 'Content From',
      type: 'options',
      default: 'text',
      noDataExpression: true,
      options: [
        { name: 'Text', value: 'text', description: 'Written here; an expression makes it dynamic' },
        { name: 'Sub-Workflow', value: 'workflow', description: 'A workflow whose last output is the content' },
      ],
    },
    { name: 'text', displayName: label, type: 'string', default: '', typeOptions: { rows: 4 }, description: hint, displayOptions: { show: { source: ['text'] } } },
    {
      name: 'workflowId',
      displayName: 'Workflow',
      type: 'options',
      default: '',
      noDataExpression: true,
      typeOptions: { loadOptionsMethod: 'workflows' },
      description: 'It gets { uri } or { name, arguments } and answers with { text } (or { messages } for a prompt)',
      displayOptions: { show: { source: ['workflow'] } },
    },
  ];
}

/** Run the sub-workflow behind a resource or prompt with the request as its trigger item; its last output item. */
async function runContentWorkflow(ctx: IExecuteContext, workflowId: string, request: JsonObject): Promise<JsonObject> {
  if (!workflowId) throw new NodeOperationError('Choose the sub-workflow that provides the content');
  const workflow = workflowForCall(workflowId, ctx.mode);
  if (!workflow) throw new NodeOperationError(`Workflow ${workflowId} not found`);
  const trigger = triggerOf(workflow);
  if (!trigger) throw new NodeOperationError(`“${workflow.name}” has no “When Executed by Another Workflow” trigger (${WORKFLOW_TRIGGER})`);
  if (!callerAllowed(workflow, ctx.getWorkflowId())) throw new NodeOperationError(`“${workflow.name}” doesn’t allow this workflow to call it`);
  const { runWorkflow, lastNodeItems } = await import('../runner');
  const child = await runWorkflow({
    workflow,
    mode: ctx.mode === 'poll' ? 'trigger' : ctx.mode,
    startNodeId: trigger.id,
    triggerItems: [{ json: request }],
    parent: { executionId: ctx.getExecutionId(), nodeId: ctx.getNode().id },
    ...(ctx.signal && { signal: ctx.signal }),
  }).catch((error: Error) => {
    throw new NodeOperationError(error.message);
  });
  if (child.status !== 'success') throw new NodeOperationError(child.error?.message ?? `The sub-workflow ended as ${child.status} (execution ${child.executionId})`);
  return lastNodeItems(child)[0]?.json ?? {};
}

/** A text with its `{{ }}` expressions evaluated against the request (`$json`); other parameters of the node are not touched. */
function evaluate(ctx: IExecuteContext, text: string, request: JsonObject): string {
  if (!text.includes('{{')) return text;
  const workflowId = ctx.getWorkflowId();
  const resolver = new ExpressionResolver({
    items: [{ json: request }],
    nodeOutputs: {},
    workflow: { id: workflowId ?? '', name: workflowId ?? '' },
    execution: { id: ctx.getExecutionId(), mode: ctx.mode },
    parameters: {},
    variables: variables.forWorkflow(workflowId ?? ''),
  });
  try {
    return String(resolver.resolveParameters({ text }, 0).text ?? '');
  } catch (error) {
    throw new NodeOperationError((error as Error).message, { description: 'Expressions in a resource or prompt see the request as $json: { resource } or { prompt, arguments }.' });
  }
}

async function readResourceContent(ctx: IExecuteContext, uri: string): Promise<JsonObject> {
  const defs = resourceDefs({ resources: ctx.getNodeParameter('resources', 0, {}) });
  const def = defs.find((candidate) => candidate.uri === uri);
  if (!def) throw new NodeOperationError(`Unknown resource "${uri}"`, { description: `This server offers: ${defs.map((d) => d.uri).join(', ') || 'no resources'}` });
  const text = def.source === 'workflow' ? resourceText(await runContentWorkflow(ctx, def.workflowId, { uri })) : evaluate(ctx, def.text, { resource: uri });
  return { uri, mimeType: def.mimeType, text };
}

async function getPromptContent(ctx: IExecuteContext, name: string, args: unknown): Promise<JsonObject> {
  const defs = promptDefs({ prompts: ctx.getNodeParameter('prompts', 0, {}) });
  const def = defs.find((candidate) => candidate.name === name);
  if (!def) throw new NodeOperationError(`Unknown prompt "${name}"`, { description: `This server offers: ${defs.map((d) => d.name).join(', ') || 'no prompts'}` });
  const given = args && typeof args === 'object' && !Array.isArray(args) ? (args as JsonObject) : {};
  const missing = def.arguments.filter((a) => a.required && (given[a.name] === undefined || given[a.name] === '')).map((a) => a.name);
  if (missing.length) throw new NodeOperationError(`The prompt "${name}" needs the argument${missing.length > 1 ? 's' : ''} ${missing.join(', ')}`);
  const output: JsonObject = def.source === 'workflow' ? await runContentWorkflow(ctx, def.workflowId, { name, arguments: given }) : { text: evaluate(ctx, def.text, { prompt: name, arguments: given }) };
  return { ...(def.description && { description: def.description }), messages: promptMessages(output) };
}

export const mcpTrigger = defineNode({
  description: {
    name: 'mcpTrigger',
    displayName: 'MCP Server Trigger',
    description: 'Serve the tools attached to this trigger to MCP clients (Claude, Cursor…) at /mcp/<path>',
    version: 1,
    kind: 'trigger',
    // Served over HTTP while the workflow is active, like a webhook.
    triggerSource: 'webhook',
    categories: ['Triggers', 'AI'],
    icon: 'lucide:server',
    color: '#f97316',
    subtitle: '/mcp/{{path}}',
    keywords: ['mcp', 'model context protocol', 'mcp server', 'tools', 'claude', 'cursor', 'expose'],
    credentials: [
      { name: 'httpBearerAuth', required: true, displayOptions: { show: { authentication: ['bearerAuth'] } } },
      { name: 'httpHeaderAuth', required: true, displayOptions: { show: { authentication: ['headerAuth'] } } },
    ],
    inputs: [{ type: 'ai_tool', displayName: 'Tools' }],
    outputs: [],
    properties: [
      { name: 'path', displayName: 'Path', type: 'string', default: 'tools', required: true, noDataExpression: true, description: 'Served at /mcp/<path>' },
      authenticationProperty,
      {
        name: 'instructions',
        displayName: 'Server Instructions',
        type: 'string',
        default: '',
        noDataExpression: true,
        typeOptions: { rows: 3 },
        description: 'Sent to clients when they connect: what the tools are for and how to use them',
      },
      {
        name: 'resources',
        displayName: 'Resources',
        type: 'fixedCollection',
        // Kept as written: only the text of the resource being read is evaluated (a broken expression elsewhere can't fail it).
        noDataExpression: true,
        typeOptions: { multipleValues: true },
        default: {},
        placeholder: 'Add resource',
        description: 'Documents and data clients can read (MCP resources). Static text is served as it is; an expression or a sub-workflow runs on each read.',
        groups: [
          {
            name: 'items',
            displayName: 'Resource',
            values: [
              { name: 'uri', displayName: 'URI', type: 'string', default: '', noDataExpression: true, placeholder: 'doc://handbook', description: 'What clients read it by' },
              { name: 'name', displayName: 'Name', type: 'string', default: '', noDataExpression: true },
              { name: 'description', displayName: 'Description', type: 'string', default: '', noDataExpression: true },
              { name: 'mimeType', displayName: 'MIME Type', type: 'string', default: 'text/plain', noDataExpression: true },
              ...contentSource('The content', 'Available as {{ $json.resource }} (the URI).'),
            ],
          },
        ],
      },
      {
        name: 'prompts',
        displayName: 'Prompts',
        type: 'fixedCollection',
        noDataExpression: true,
        typeOptions: { multipleValues: true },
        default: {},
        placeholder: 'Add prompt',
        description: 'Prompt templates clients can offer their users (MCP prompts). Static text is served as it is; an expression or a sub-workflow runs on each use.',
        groups: [
          {
            name: 'items',
            displayName: 'Prompt',
            values: [
              { name: 'name', displayName: 'Name', type: 'string', default: '', noDataExpression: true, placeholder: 'review' },
              { name: 'description', displayName: 'Description', type: 'string', default: '', noDataExpression: true },
              { name: 'arguments', displayName: 'Arguments', type: 'string', default: '', noDataExpression: true, placeholder: 'language, topic?', description: 'Comma-separated names; add ? to make one optional' },
              ...contentSource('The prompt', 'The arguments are {{ $json.arguments.language }}. The text is the user message; a sub-workflow may output { messages: [{ role, text }] }.'),
            ],
          },
        ],
      },
      {
        name: 'notice',
        displayName:
          'Attach tools below (any tool sub-node, or a node used as a tool such as Execute Workflow). The production URL answers once the workflow is published; the test URL while the editor listens. Each tool call is an execution; listing the tools, resources and prompts is not, and neither is reading static text.',
        type: 'notice',
      },
    ],
  },
  methods: {
    loadOptions: {
      workflows: () =>
        store
          .listWorkflows()
          .map((w) => ({ name: w.name, value: w.id, ...(!triggerOf(w) && { description: 'Needs a “When Executed by Another Workflow” trigger' }) }))
          .sort((a, b) => a.name.localeCompare(b.name)),
    },
  },
  async execute(ctx) {
    const asked = ctx.getInputData()[0]?.json ?? {};
    if (typeof asked.resource === 'string') return [[{ json: { resource: await readResourceContent(ctx, asked.resource) } }]];
    if (typeof asked.prompt === 'string') return [[{ json: { prompt: await getPromptContent(ctx, asked.prompt, asked.arguments) } }]];
    if (!ctx.getInputConnectionData) throw new NodeOperationError('The MCP Server Trigger must run in-process');
    const tools = uniqueNames(await ctx.getInputConnectionData<AgentTool>('ai_tool'));
    const request = ctx.getInputData()[0]?.json ?? {};
    const name = typeof request.tool === 'string' ? request.tool : '';
    // tools/list, or "Run" in the editor: the tools this server offers.
    if (!name) return [tools.map((tool) => ({ json: { name: tool.name, description: tool.description, inputSchema: tool.inputSchema } }))];
    const tool = tools.find((candidate) => candidate.name === name);
    if (!tool) throw new NodeOperationError(`Unknown tool "${name}"`, { description: `This server offers: ${tools.map((t) => t.name).join(', ') || 'no tools'}` });
    const args = request.arguments && typeof request.arguments === 'object' && !Array.isArray(request.arguments) ? (request.arguments as Record<string, unknown>) : {};
    ctx.logger.info(`MCP tools/call ${name}`);
    try {
      const result = await tool.invoke(args, ctx.signal);
      return [[{ json: { tool: name, arguments: args as JsonObject, result: (result ?? null) as JsonObject[string] } }]];
    } catch (error) {
      const message = error instanceof McpClientError || error instanceof Error ? error.message : String(error);
      throw new NodeOperationError(`${name} failed: ${message}`);
    }
  },
});
