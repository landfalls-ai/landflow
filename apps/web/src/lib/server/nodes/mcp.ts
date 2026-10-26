/**
 * MCP (Model Context Protocol) nodes, after n8n's: the MCP Client Tool gives an AI Agent the tools
 * of an MCP server, the MCP Client calls one tool in the main flow, and the MCP Server Trigger
 * serves the tools attached to it at /mcp/<path> (lib/server/mcp/trigger.ts). Parameter and
 * credential names follow n8n's (`endpointUrl`, `serverTransport`, `authentication`, `include`,
 * `includeTools`, `excludeTools`; httpBearerAuth, httpHeaderAuth), so n8n's mcpClientTool and
 * mcpTrigger can map onto these one to one.
 */
import { defineNode, NodeOperationError, type IBaseContext, type ILoadOptionsContext, type JsonObject, type NodeItem, type PropertyDescriptor } from '@landflow/sdk';
import type { AgentTool } from '@landflow/engine';
import { agentToolsFrom, callMcpTool, compactContent, endpointFrom, listMcpTools, McpClientError, resultText, selectTools, type McpEndpoint } from '../mcp/client';

const main = [{ type: 'main' as const }];

const credentialRequirements = [
  { name: 'httpBearerAuth', required: true, displayOptions: { show: { authentication: ['bearerAuth'] } } },
  { name: 'httpHeaderAuth', required: true, displayOptions: { show: { authentication: ['headerAuth'] } } },
];

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
  authenticationProperty,
];

const timeoutOption: PropertyDescriptor = {
  name: 'timeout',
  displayName: 'Timeout (ms)',
  type: 'number',
  default: 60_000,
  typeOptions: { minValue: 1_000, maxValue: 600_000 },
  description: 'How long to wait for the server to answer a request',
};

type Credentials = { httpBearerAuth?: JsonObject; httpHeaderAuth?: JsonObject };

function credentialsOf(ctx: Pick<IBaseContext, 'getCredentials'> | Pick<ILoadOptionsContext, 'getCredentials'>): Credentials {
  return {
    httpBearerAuth: ctx.getCredentials('httpBearerAuth', { optional: true }),
    httpHeaderAuth: ctx.getCredentials('httpHeaderAuth', { optional: true }),
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
    credentials: credentialRequirements,
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
    return agentToolsFrom(endpoint, selected);
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

export const mcpClientNode = defineNode({
  description: {
    name: 'mcpClient',
    displayName: 'MCP Client',
    description: 'Call one tool of an MCP server and output its result',
    version: 1,
    kind: 'action',
    categories: ['AI'],
    icon: 'lucide:plug',
    color: '#a855f7',
    subtitle: '{{tool}}',
    keywords: ['mcp', 'model context protocol', 'mcp client', 'call tool', 'server'],
    credentials: credentialRequirements,
    inputs: main,
    outputs: main,
    properties: [
      ...serverProperties,
      {
        name: 'tool',
        displayName: 'Tool',
        type: 'options',
        default: '',
        required: true,
        typeOptions: { loadOptionsMethod: 'tools', loadOptionsDependsOn: toolsDependOn },
        description: 'Loaded from the server',
      },
      {
        name: 'arguments',
        displayName: 'Arguments',
        type: 'json',
        default: '{}',
        description: 'A JSON object with the tool’s arguments; expressions such as {{ $json.query }} work inside it',
      },
      { name: 'options', displayName: 'Options', type: 'collection', default: {}, placeholder: 'Add option', values: [timeoutOption] },
      {
        name: 'notice',
        displayName: 'Each item calls the tool once and becomes { tool, text, content, structuredContent? }. An error result fails the node (or becomes { error } with “Continue on error”).',
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
  methods: { loadOptions: { tools: toolOptions } },
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
        name: 'notice',
        displayName:
          'Attach tools below (any tool sub-node, or a node used as a tool such as Execute Workflow). The production URL answers once the workflow is published; the test URL while the editor listens. Each tool call is an execution; listing the tools is not.',
        type: 'notice',
      },
    ],
  },
  async execute(ctx) {
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
