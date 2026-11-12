/**
 * The public API as an OpenAPI 3.1 document (GET /api/openapi.json, Settings → API): workflows (and running them),
 * executions, data tables, variables, templates and your account and API keys, plus the trigger URLs (webhooks, forms,
 * MCP Server Triggers and their test URLs: public, `security: []`, each checked by its trigger's own auth). Request
 * bodies of the workflow and row filter come from the routes' own zod schemas, so they can't drift; every other
 * operation names the API key scope the guard wants (`x-landflow-scope`, from lib/server/auth/policy.ts), so the docs
 * and the guard agree.
 *
 * Only routes that exist are listed: test/openapi.test.ts checks each path against app/ and its exported methods.
 */
import { z } from 'zod';
import { API_KEY_SCOPES } from '../shared/auth';
import { SESSION_COOKIE } from '../shared/auth-paths';
import { TEMPLATE_CATEGORIES } from '../shared/templates';
import { rowFilterSchema } from './datatables/http';
import { routePolicy } from './auth/policy';
import { workflowSchema } from './schemas';
import { saveTemplateSchema, updateTemplateSchema } from './templates/schema';
import { connectionCreateSchema, connectionTestSchema, connectionUpdateSchema } from './transports/schema';
import { grantCreateSchema, grantPatchSchema } from './mcp/grants';

type Json = Record<string, unknown>;
type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const array = (items: Json) => ({ type: 'array', items });
const object = (properties: Record<string, Json>, required: string[] = [], extra: Json = {}) => ({ type: 'object', properties, ...(required.length && { required }), ...extra });
const jsonBody = (schema: Json, description?: string, required = true) => ({ required, ...(description && { description }), content: { 'application/json': { schema } } });
const reply = (description: string, schema?: Json, contentType = 'application/json') => ({ description, ...(schema && { content: { [contentType]: { schema } } }) });
const ok = object({ ok: { type: 'boolean', const: true } }, ['ok']);
const errorRef = (description: string) => ({ description, content: { 'application/json': { schema: ref('Error') } } });

/** A zod schema as a JSON Schema (2020-12, the dialect of OpenAPI 3.1), request side. */
function fromZod(schema: z.ZodType): Json {
  const { $schema: _dialect, ...rest } = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Json;
  return rest;
}

/** A sample path for `/api/workflows/{id}`-style templates, to ask the route policy about. */
const samplePath = (path: string) => path.replace(/\{[^}]+\}/g, 'sample');

interface Operation {
  tag: 'Workflows' | 'Executions' | 'Data tables' | 'Variables' | 'Templates' | 'Audit' | 'Account' | 'Settings' | 'Triggers' | 'Plugins' | 'MCP' | 'Second brain' | 'Agents' | 'Agent teams' | 'Runbooks';
  id: string;
  summary: string;
  description?: string;
  /** A trigger URL: no API key or session (lib/shared/auth-paths.ts), the trigger checks its callers itself. */
  public?: boolean;
  /** Descriptions of path parameters. */
  pathParams?: Record<string, string>;
  query?: Array<{ name: string; description: string; schema: Json; required?: boolean }>;
  headers?: Array<{ name: string; description: string; schema: Json }>;
  body?: Json;
  responses: Record<string, Json>;
}

function scopeText(scope: string, sessionOnly?: boolean, action?: string): string {
  if (sessionOnly) return 'Needs a session: API keys are refused.';
  const key = scope === 'any' ? 'Any API key (or a session).' : `API keys need the \`${scope}\` scope.`;
  return action ? `${key} Owners and admins only (\`${action}\`).` : key;
}

const PUBLIC_TEXT = 'Public: no API key or session. The trigger’s own authentication (and IP allow-list) applies.';

function operation(method: Method, path: string, spec: Operation): Json {
  const parameters = [
    ...[...path.matchAll(/\{([^}]+)\}/g)].map(([, name]) => ({ name, in: 'path', required: true, ...(spec.pathParams?.[name] && { description: spec.pathParams[name] }), schema: { type: 'string' } })),
    ...(spec.query ?? []).map((q) => ({ name: q.name, in: 'query', required: q.required ?? false, description: q.description, schema: q.schema })),
    ...(spec.headers ?? []).map((h) => ({ name: h.name, in: 'header', required: false, description: h.description, schema: h.schema })),
  ];
  if (spec.public) {
    return {
      operationId: spec.id,
      tags: [spec.tag],
      summary: spec.summary,
      description: [spec.description, PUBLIC_TEXT].filter(Boolean).join('\n\n'),
      security: [],
      'x-landflow-public': true,
      ...(parameters.length && { parameters }),
      ...(spec.body && { requestBody: spec.body }),
      responses: spec.responses,
    };
  }
  const policy = routePolicy(method.toUpperCase(), samplePath(path));
  return {
    operationId: spec.id,
    tags: [spec.tag],
    summary: spec.summary,
    description: [spec.description, scopeText(policy.scope, policy.sessionOnly, policy.action)].filter(Boolean).join('\n\n'),
    'x-landflow-scope': policy.scope,
    ...(policy.sessionOnly && { 'x-landflow-session-only': true }),
    ...(policy.action && { 'x-landflow-role-action': policy.action }),
    ...(parameters.length && { parameters }),
    ...(spec.body && { requestBody: spec.body }),
    responses: { ...spec.responses, 401: { $ref: '#/components/responses/Unauthorized' }, 403: { $ref: '#/components/responses/Forbidden' } },
  };
}

const idempotencyHeader = { name: 'Idempotency-Key', description: 'Start at most one run per key (within LANDFLOW_IDEMPOTENCY_TTL_HOURS); a repeat names the first execution.', schema: { type: 'string', maxLength: 255 } };
const notFound = errorRef('Not found');
const invalid = errorRef('Invalid request (`issues` lists what is wrong)');

const schemas: Record<string, Json> = {
  Error: object({ error: { type: 'string' }, issues: array({ type: 'object' }) }, ['error'], { additionalProperties: true }),
  WorkflowInput: fromZod(workflowSchema),
  Workflow: {
    allOf: [
      ref('WorkflowInput'),
      object(
        {
          id: { type: 'string' },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
          createdBy: { type: 'string', description: 'User id of who created it' },
          updatedBy: { type: 'string', description: 'User id of who saved it last' },
        },
        ['id', 'name', 'nodes', 'connections'],
      ),
    ],
  },
  WorkflowSummary: object(
    {
      id: { type: 'string' },
      name: { type: 'string' },
      description: { type: 'string' },
      active: { type: 'boolean' },
      nodeCount: { type: 'integer' },
      nodeTypes: array({ type: 'string' }),
      tags: array({ type: 'string' }),
      folderId: { type: 'string' },
      createdAt: { type: 'string' },
      updatedAt: { type: 'string' },
    },
    ['id', 'name', 'active', 'nodeCount', 'nodeTypes', 'tags', 'createdAt', 'updatedAt'],
  ),
  WorkflowStats: object({ workflows: { type: 'integer' }, activeWorkflows: { type: 'integer' }, executions24h: { type: 'integer' }, failed24h: { type: 'integer' }, avgDurationMs: { type: 'integer' } }),
  WorkflowVersionSummary: object(
    {
      id: { type: 'string' },
      workflowId: { type: 'string' },
      number: { type: 'integer' },
      createdAt: { type: 'string' },
      name: { type: 'string' },
      nodeCount: { type: 'integer' },
      hash: { type: 'string' },
      summary: { type: 'string', description: 'One line, e.g. "2 nodes added · 1 changed"' },
      restoredFrom: object({ id: { type: 'string' }, number: { type: 'integer' } }),
    },
    ['id', 'workflowId', 'number', 'createdAt', 'name', 'summary'],
    { additionalProperties: true },
  ),
  WorkflowVersion: { allOf: [ref('WorkflowVersionSummary'), object({ workflow: ref('Workflow') }, ['workflow'])] },
  ImportReport: object(
    {
      format: { type: 'string', enum: ['n8n', 'flowise', 'landflow'] },
      mapped: array(object({ name: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' } })),
      placeholders: array(object({ name: { type: 'string' }, type: { type: 'string' } })),
      stickyNotes: { type: 'integer' },
      connections: { type: 'integer' },
      warnings: array({ type: 'string' }),
    },
    [],
    { additionalProperties: true },
  ),
  RunRequest: object({
    workflow: { ...ref('WorkflowInput'), description: 'Run this (unsaved) version instead of the saved one' },
    startNodeId: { type: 'string', description: 'Start here instead of the manual, webhook, chat or schedule trigger' },
    items: { ...array(object({ json: { type: 'object', additionalProperties: true } }, ['json'])), description: 'The start node’s items' },
    chat: object({ message: { type: 'string', minLength: 1 }, sessionId: { type: 'string', default: 'default' } }, ['message']),
    destinationNodeId: { type: 'string', description: 'Run up to this node, then stop' },
    rerun: object({ executionId: { type: 'string' }, scope: { type: 'string', enum: ['all', 'from', 'only'] }, nodeId: { type: 'string' } }, ['executionId', 'scope']),
    debug: object({ breakpoints: array({ type: 'string' }), step: { type: 'boolean' } }),
    idempotencyKey: { type: 'string', minLength: 1, description: 'Same as the Idempotency-Key header' },
  }),
  ExecutionStatus: { type: 'string', enum: ['running', 'queued', 'waiting', 'success', 'error', 'canceled'] },
  ExecutionMode: { type: 'string', enum: ['manual', 'trigger', 'webhook', 'tool', 'chat', 'poll', 'mcp'] },
  ExecutionSummary: object(
    {
      id: { type: 'string' },
      workflowId: { type: 'string' },
      workflowName: { type: 'string' },
      mode: ref('ExecutionMode'),
      status: ref('ExecutionStatus'),
      startedAt: { type: 'string' },
      durationMs: { type: 'integer' },
      nodesRun: { type: 'integer' },
      error: object({ message: { type: 'string' }, nodeId: { type: 'string' } }, ['message'], { additionalProperties: true }),
      versionId: { type: 'string' },
      parentExecutionId: { type: 'string' },
      retryOf: { type: 'string' },
      retryAttempt: { type: 'integer' },
      retriedBy: { type: 'string' },
      wait: object({ nodeName: { type: 'string' }, resume: { type: 'string' }, until: { type: 'string' } }, [], { additionalProperties: true }),
    },
    ['id', 'workflowId', 'workflowName', 'mode', 'status', 'startedAt', 'durationMs'],
    { additionalProperties: true },
  ),
  ExecutionRecord: object(
    {
      executionId: { type: 'string' },
      workflowId: { type: 'string' },
      workflowName: { type: 'string' },
      mode: ref('ExecutionMode'),
      status: ref('ExecutionStatus'),
      startedAt: { type: 'string' },
      finishedAt: { type: 'string' },
      durationMs: { type: 'integer' },
      runData: { type: 'object', description: 'Node id → its runs (inputs, outputs, timing, errors)', additionalProperties: true },
      executionOrder: array({ type: 'string' }),
      lastNodeId: { type: 'string' },
      error: object({ message: { type: 'string' } }, ['message'], { additionalProperties: true }),
      startedBy: { type: 'string', description: 'User id of who started a manual run' },
    },
    ['executionId', 'workflowId', 'status', 'startedAt'],
    { additionalProperties: true },
  ),
  RunStarted: object(
    { executionId: { type: 'string' }, workflowId: { type: 'string' }, status: ref('ExecutionStatus'), duplicate: { type: 'boolean', description: 'The idempotency key ran before: this is the first execution' } },
    ['executionId', 'workflowId', 'status'],
  ),
  DataTableColumn: object({ name: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_]{0,62}$' }, type: { type: 'string', enum: ['string', 'number', 'boolean', 'date'] } }, ['name', 'type']),
  DataTable: object(
    { id: { type: 'string' }, name: { type: 'string' }, columns: array(ref('DataTableColumn')), createdAt: { type: 'string' }, updatedAt: { type: 'string' }, rowCount: { type: 'integer' } },
    ['id', 'name', 'columns', 'createdAt', 'updatedAt'],
  ),
  DataTableRow: object({ id: { type: 'integer' }, createdAt: { type: 'string' }, updatedAt: { type: 'string' } }, ['id', 'createdAt', 'updatedAt'], {
    additionalProperties: { type: ['string', 'number', 'boolean', 'null'] },
    description: 'System columns plus one property per column (dates are ISO strings, empty cells null)',
  }),
  RowValues: { type: 'object', description: 'Column → value (coerced to the column type)', additionalProperties: true },
  RowFilter: fromZod(rowFilterSchema),
  Variable: object({ key: { type: 'string', pattern: '^[A-Za-z_][A-Za-z0-9_]*$', maxLength: 64 }, value: { type: 'string', maxLength: 10_000 } }, ['key', 'value']),
  TemplateCredentialSlot: object(
    {
      id: { type: 'string', description: 'What the template’s nodes reference as `credentials[key].id`' },
      type: { type: 'string', description: 'Qualified credential type, e.g. `messaging.slackApi`' },
      name: { type: 'string' },
      description: { type: 'string' },
      optional: { type: 'boolean' },
      nodes: { ...array({ type: 'string' }), description: 'Names of the nodes that use it' },
    },
    ['id', 'type', 'name'],
  ),
  TemplateProblem: object(
    {
      kind: { type: 'string', enum: ['missing', 'blocked', 'contract'], description: '`contract`: a composite frame to fix before publishing (doesn’t stop using the template); `nodeType` is the composite type' },
      nodeType: { type: 'string' },
      message: { type: 'string' },
    },
    ['kind', 'nodeType', 'message'],
  ),
  TemplateSummary: object(
    {
      id: { type: 'string', description: 'Built-in ids are slugs, saved ones `tpl_…`, remote ones `n8n-<number>`' },
      source: { type: 'string', enum: ['builtin', 'local', 'remote'] },
      name: { type: 'string' },
      description: { type: 'string', description: 'Markdown' },
      categories: array({ type: 'string', enum: TEMPLATE_CATEGORIES.map((c) => c.id) }),
      nodeTypes: { ...array({ type: 'string' }), description: 'Distinct node types, triggers first' },
      nodeCount: { type: 'integer' },
      credentials: array(ref('TemplateCredentialSlot')),
      author: { type: 'string' },
      createdAt: { type: 'string' },
      updatedAt: { type: 'string' },
      usable: { type: 'boolean', description: 'False when a node type is missing here or blocked by the governance policy (`contract` problems don’t count)' },
      problems: array(ref('TemplateProblem')),
      projectId: { type: 'string', description: 'Saved templates: the project it belongs to (left out: instance-wide)' },
      projectName: { type: 'string' },
      canEdit: { type: 'boolean', description: 'Saved templates: whether the caller may edit or delete it' },
    },
    ['id', 'source', 'name', 'description', 'categories', 'nodeTypes', 'nodeCount', 'credentials', 'usable', 'problems'],
  ),
  Template: {
    allOf: [
      ref('TemplateSummary'),
      object(
        {
          workflow: { ...ref('WorkflowInput'), description: 'Credentials point at slots; no pinned data or ids of an instance' },
          setup: { ...array({ type: 'string' }), description: 'Setup steps, Markdown' },
          dataTables: array(object({ name: { type: 'string' }, columns: array(object({ name: { type: 'string' }, type: { type: 'string' } }, ['name', 'type'])) }, ['name', 'columns'])),
          report: { ...ref('ImportReport'), description: 'Remote templates: what the n8n importer did' },
        },
        ['workflow', 'setup', 'dataTables'],
      ),
    ],
  },
  TemplateFile: object(
    { kind: { type: 'string', const: 'landflow/template' }, version: { type: 'integer', const: 1 }, template: { type: 'object', description: 'name, description, categories, credentials, setup, dataTables, workflow', additionalProperties: true } },
    ['kind', 'version', 'template'],
  ),
  Viewer: object(
    {
      id: { type: 'string' },
      name: { type: 'string' },
      email: { type: 'string' },
      role: { type: 'string', enum: ['owner', 'admin', 'member'] },
      sso: { type: 'boolean' },
      hasPassword: { type: 'boolean' },
    },
    ['id', 'name', 'email', 'role'],
  ),
  ApiKeyScope: { type: 'string', enum: [...API_KEY_SCOPES] },
  McpTokenScope: { type: 'string', enum: ['tools:list', 'tools:call', 'registry:read'] },
  McpToken: object(
    {
      id: { type: 'string', description: 'The token’s `jti`' },
      label: { type: 'string' },
      hint: { type: 'string', description: 'The token’s last characters' },
      scopes: array(ref('McpTokenScope')),
      createdAt: { type: 'string', format: 'date-time' },
      expiresAt: { type: 'string', format: 'date-time' },
      revokedAt: { type: 'string', format: 'date-time' },
      lastUsedAt: { type: 'string', format: 'date-time' },
      userId: { type: 'string' },
      userName: { type: 'string' },
      projectId: { type: 'string', description: 'Set when the token is scoped to a project: the instance MCP server then lists and changes only that project’s workflows' },
      projectName: { type: 'string' },
    },
    ['id', 'label', 'hint', 'scopes', 'createdAt', 'expiresAt', 'userId'],
  ),
  McpToolGrant: object(
    {
      id: { type: 'string' },
      subject: object({ kind: { type: 'string', enum: ['user', 'group', 'project', 'role', 'token'] }, id: { type: 'string' }, name: { type: 'string' } }, ['kind', 'id']),
      pluginId: { type: 'string', description: 'A plugin id, or `core`' },
      tools: { oneOf: [{ type: 'string', const: '*' }, array({ type: 'string' })], description: 'Tool names on the plugin’s endpoint, `!name` excludes, or `*`' },
      credentials: { type: 'object', additionalProperties: { type: 'string' }, description: 'credentialType → credential id' },
      approval: { type: 'string', enum: ['always', 'destructive', 'never'], description: 'When the grant’s tools need a person’s OK: always, for destructive tools (the default), or never. Absent: the instance default' },
      requireApproval: { type: 'boolean', description: 'Older form of `approval`: true = destructive, false = never' },
      createdBy: { type: 'string' },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
    },
    ['id', 'subject', 'pluginId', 'tools', 'credentials', 'createdAt', 'updatedAt'],
  ),
  McpServerJson: object(
    {
      $schema: { type: 'string' },
      name: { type: 'string', description: '`<LANDFLOW_MCP_NAMESPACE>/<pluginId>`' },
      description: { type: 'string' },
      title: { type: 'string' },
      version: { type: 'string' },
      websiteUrl: { type: 'string' },
      remotes: array(object({ type: { type: 'string', enum: ['streamable-http', 'sse'] }, url: { type: 'string' } }, ['type', 'url'])),
      _meta: { type: 'object' },
    },
    ['name', 'description', 'version', 'remotes'],
    { description: 'The MCP Registry server.json schema (2025-12-11)' },
  ),
  McpServerResponse: object(
    {
      server: ref('McpServerJson'),
      _meta: object({ 'io.modelcontextprotocol.registry/official': object({ status: { type: 'string', enum: ['active', 'deprecated', 'deleted'] }, publishedAt: { type: 'string', format: 'date-time' }, updatedAt: { type: 'string', format: 'date-time' }, isLatest: { type: 'boolean' } }) }),
    },
    ['server', '_meta'],
  ),
  McpServerList: object({ servers: array(ref('McpServerResponse')), metadata: object({ count: { type: 'integer' }, nextCursor: { type: 'string' } }, ['count']) }, ['servers', 'metadata']),
  ApiKey: object(
    {
      id: { type: 'string' },
      label: { type: 'string' },
      hint: { type: 'string', description: 'The key’s last characters' },
      scopes: array(ref('ApiKeyScope')),
      createdAt: { type: 'string' },
      expiresAt: { type: 'string' },
      lastUsedAt: { type: 'string' },
    },
    ['id', 'label', 'hint', 'scopes', 'createdAt'],
  ),
  // Plugins and transports (docs/transports.md; lib/shared/transports.ts).
  TransportPolicy: object(
    {
      mode: { type: 'string', enum: ['auto', 'pinned'] },
      pinned: { type: 'string', description: 'With `mode: pinned`: the kind every call uses' },
      allowed: { ...array({ type: 'string' }), description: 'Kinds the selector may use; absent = every kind' },
      objective: { type: 'string', enum: ['balanced', 'latency', 'throughput'] },
    },
    ['mode', 'objective'],
  ),
  TransportChoice: object(
    {
      endpoint: { type: 'string' },
      kind: { type: 'string' },
      reason: { type: 'string', enum: ['pinned', 'only', 'auto.latency', 'auto.spillover', 'auto.failover', 'auto.breaker', 'auto.size'] },
    },
    ['endpoint', 'kind', 'reason'],
  ),
  BrokerQueueStats: object(
    {
      depth: { type: 'number', description: 'Events waiting on the request channel' },
      consumers: { type: 'number' },
      lag: { type: 'number', description: 'Consumer-group lag, when the broker distinguishes it from depth' },
      instances: { type: 'number', description: 'Announced, unexpired plugin instances' },
      maxConcurrency: { type: 'number', description: 'The instances’ maxConcurrency summed' },
      sampledAt: { type: 'string' },
    },
    [],
  ),
  PluginTransport: object(
    {
      kind: { type: 'string' },
      endpoints: array({ type: 'string' }),
      online: { type: 'boolean' },
      excluded: { type: 'boolean', description: 'The policy keeps this kind out' },
      declared: { type: 'boolean', description: 'The manifest names this face but no endpoint on it has been found' },
      stats: ref('BrokerQueueStats'),
    },
    ['kind', 'endpoints', 'online'],
  ),
  Plugin: object(
    {
      id: { type: 'string' },
      info: { type: 'object', description: 'The manifest’s plugin section (name, version, language, icon…)' },
      status: { type: 'string', enum: ['online', 'offline', 'error'] },
      transport: { type: 'string', description: 'The transport the next call takes (`in-process` for built-in plugins)' },
      activeEndpoint: { type: 'string' },
      transports: array(ref('PluginTransport')),
      policy: ref('TransportPolicy'),
      choice: ref('TransportChoice'),
      choiceError: { type: 'string', description: 'Why no transport can be chosen now' },
      endpoints: array({ type: 'object' }),
      source: { type: 'string' },
      nodes: array({ type: 'object' }),
      mcp: object({ exposed: { type: 'boolean', description: '"Expose to agents"' }, tools: { type: 'integer', description: 'MCP tools the manifest maps to' }, path: { type: 'string', description: 'The plugin’s MCP endpoint on this host' } }, ['exposed', 'tools', 'path']),
    },
    ['id', 'info', 'status', 'transport', 'endpoints', 'source', 'nodes'],
  ),
  TransportCapabilities: object(
    {
      maxMessageBytes: { type: 'number' },
      delivery: array({ type: 'string', enum: ['at-most-once', 'at-least-once'] }),
      latency: { type: 'string', enum: ['low', 'medium', 'high'] },
      buffering: { type: 'boolean' },
    },
    ['maxMessageBytes', 'delivery', 'latency', 'buffering'],
  ),
  TransportKind: object(
    {
      kind: { type: 'string' },
      label: { type: 'string' },
      direct: { type: 'boolean', description: 'The host connects to the plugin; brokers are reached through connections' },
      installed: { type: 'boolean', description: 'A driver for the kind is registered in this host' },
      health: object({ ok: { type: 'boolean' }, message: { type: 'string' } }, ['ok']),
      capabilities: ref('TransportCapabilities'),
      fields: array({ type: 'object', description: 'The connection form’s fields (name, label, type, required…)' }),
    },
    ['kind', 'label', 'direct', 'installed', 'fields'],
  ),
  TransportConnectionCheck: object({ ok: { type: 'boolean' }, at: { type: 'string' }, message: { type: 'string' }, latencyMs: { type: 'number' }, version: { type: 'string' } }, ['ok', 'at', 'message']),
  TransportConnectionHealth: object(
    {
      state: { type: 'string', enum: ['connecting', 'connected', 'reconnecting', 'error'] },
      message: { type: 'string' },
      since: { type: 'string' },
      roundTripMs: { type: 'number' },
      checkedAt: { type: 'string' },
      version: { type: 'string', description: 'The broker’s version, when the driver can tell' },
      hostInstanceId: { type: 'string' },
      announced: { type: 'number', description: 'Plugins announced on this connection' },
    },
    ['state', 'since'],
  ),
  TransportConnection: object(
    {
      id: { type: 'string' },
      name: { type: 'string' },
      kind: { type: 'string' },
      enabled: { type: 'boolean' },
      config: { type: 'object', description: 'Non-secret fields' },
      secretsSet: { ...array({ type: 'string' }), description: 'Secret fields that hold a value (never the values)' },
      source: { type: 'string', enum: ['database', 'env'] },
      lastCheck: ref('TransportConnectionCheck'),
      health: ref('TransportConnectionHealth'),
      plugins: { ...array({ type: 'string' }), description: 'Plugins with an endpoint on this connection' },
      createdAt: { type: 'string' },
      updatedAt: { type: 'string' },
    },
    ['id', 'name', 'kind', 'enabled', 'config', 'secretsSet', 'source', 'plugins', 'createdAt', 'updatedAt'],
  ),
};

/** path → method → operation. */
function paths(): Record<string, Record<string, Json>> {
  const out: Record<string, Record<string, Json>> = {};
  const add = (method: Method, path: string, spec: Operation) => {
    (out[path] ??= {})[method] = operation(method, path, spec);
  };
  const workflowReply = (description: string) => reply(description, object({ workflow: ref('Workflow') }, ['workflow']));

  // ---- workflows ----
  add('get', '/api/workflows', {
    tag: 'Workflows',
    id: 'listWorkflows',
    summary: 'List workflows',
    responses: { 200: reply('Every workflow (summaries, newest change first) and 24-hour stats', object({ workflows: array(ref('WorkflowSummary')), stats: ref('WorkflowStats') }, ['workflows'])) },
  });
  add('post', '/api/workflows', {
    tag: 'Workflows',
    id: 'createWorkflow',
    summary: 'Create a workflow',
    description: 'An `id` that is free is kept; otherwise one is made (`wf_…`). Saving records a version.',
    body: jsonBody(ref('WorkflowInput')),
    responses: { 201: workflowReply('The saved workflow'), 400: invalid },
  });
  add('get', '/api/workflows/{id}', { tag: 'Workflows', id: 'getWorkflow', summary: 'Get a workflow', responses: { 200: workflowReply('The workflow'), 404: notFound } });
  add('put', '/api/workflows/{id}', {
    tag: 'Workflows',
    id: 'updateWorkflow',
    summary: 'Replace a workflow',
    description: 'Fields left out keep their saved values. A change of nodes, connections or settings records a new version.',
    body: jsonBody(ref('WorkflowInput')),
    responses: { 200: workflowReply('The saved workflow'), 400: invalid, 404: notFound, 423: errorRef('Someone else has the workflow open in the editor (only for saves from an editor tab)') },
  });
  add('delete', '/api/workflows/{id}', { tag: 'Workflows', id: 'deleteWorkflow', summary: 'Delete a workflow', description: 'Its versions go too.', responses: { 200: reply('Deleted', ok), 404: notFound } });
  add('post', '/api/workflows/import', {
    tag: 'Workflows',
    id: 'importWorkflow',
    summary: 'Import Landflow or n8n workflow JSON',
    description: 'Converts n8n workflows (and n8n clipboard JSON); nodes without a Landflow equivalent become disabled placeholders. `create: false` converts without saving.',
    body: jsonBody(
      object(
        {
          data: { description: 'The workflow JSON, parsed or as text' },
          name: { type: 'string', minLength: 1, maxLength: 200 },
          folderId: { type: 'string' },
          create: { type: 'boolean', default: true },
        },
        ['data'],
      ),
    ),
    responses: {
      201: reply('Imported and saved', object({ workflow: ref('Workflow'), report: ref('ImportReport') }, ['workflow', 'report'])),
      200: reply('Converted only (`create: false`; `id` is empty)', object({ workflow: ref('Workflow'), report: ref('ImportReport') }, ['workflow', 'report'])),
      400: invalid,
    },
  });
  add('post', '/api/workflows/{id}/run', {
    tag: 'Workflows',
    id: 'runWorkflow',
    summary: 'Run a workflow and stream its events',
    description:
      'Runs the workflow (or the unsaved `workflow` in the body) and streams Server-Sent Events: `started` `{ executionId, duplicate? }`, `execution` (one per engine event: node started, finished, items…) and a last `result` `{ executionId, status, error?, lastNodeId?, duplicate? }`. The `traceparent` response header names the run’s trace. For a run that answers at once, use POST /api/workflows/{id}/execute.',
    headers: [idempotencyHeader],
    body: jsonBody(ref('RunRequest'), undefined, false),
    responses: {
      200: reply('The run’s events, until it finishes', { type: 'string', description: '`event: <name>` and `data: <JSON>` lines' }, 'text/event-stream'),
      400: invalid,
      404: notFound,
    },
  });
  add('post', '/api/workflows/{id}/execute', {
    tag: 'Workflows',
    id: 'executeWorkflow',
    summary: 'Start a workflow in the background',
    description: 'Starts the saved workflow and answers at once; follow it with GET /api/executions/{id}. The input becomes the start node’s items. Runs are manual runs.',
    headers: [idempotencyHeader],
    body: jsonBody(
      object({
        input: { oneOf: [{ type: 'object', additionalProperties: true }, array({ type: 'object', additionalProperties: true })], description: 'One item or a list of items' },
        startNode: { type: 'string', description: 'Node name or id (default: the manual, webhook, chat or schedule trigger)' },
        idempotencyKey: { type: 'string', minLength: 1 },
      }),
      undefined,
      false,
    ),
    responses: { 202: reply('Started', ref('RunStarted')), 200: reply('The idempotency key ran before (`duplicate: true`)', ref('RunStarted')), 400: invalid, 404: notFound },
  });
  add('post', '/api/workflows/{id}/move', {
    tag: 'Workflows',
    id: 'moveWorkflow',
    summary: 'Move a workflow to a folder',
    body: jsonBody(object({ folderId: { type: ['string', 'null'], description: 'null = top level' } }, ['folderId'])),
    responses: { 200: workflowReply('The moved workflow'), 404: notFound },
  });
  add('get', '/api/workflows/{id}/versions', {
    tag: 'Workflows',
    id: 'listWorkflowVersions',
    summary: 'List a workflow’s versions',
    description: 'Every save that changed the workflow, newest first.',
    responses: { 200: reply('The versions', object({ versions: array(ref('WorkflowVersionSummary')) }, ['versions'])), 404: notFound },
  });
  add('get', '/api/workflows/{id}/versions/{versionId}', {
    tag: 'Workflows',
    id: 'getWorkflowVersion',
    summary: 'Get a version with its workflow snapshot',
    responses: { 200: reply('The version', object({ version: ref('WorkflowVersion') }, ['version'])), 404: notFound },
  });
  add('post', '/api/workflows/{id}/versions/{versionId}/restore', {
    tag: 'Workflows',
    id: 'restoreWorkflowVersion',
    summary: 'Restore an older version',
    description: 'Puts the version’s nodes, connections, settings, sticky notes and pin data back (name, tags, folder and active state stay) and saves.',
    responses: { 200: reply('The restored workflow and the version the restore created', object({ workflow: ref('Workflow'), version: ref('WorkflowVersionSummary') }, ['workflow'])), 404: notFound },
  });

  // ---- executions ----
  add('get', '/api/executions', {
    tag: 'Executions',
    id: 'listExecutions',
    summary: 'List executions',
    description: 'Running executions first, then saved ones, newest first.',
    query: [
      { name: 'workflowId', description: 'Only this workflow’s', schema: { type: 'string' } },
      { name: 'limit', description: 'At most this many (default 100)', schema: { type: 'integer', minimum: 1, default: 100 } },
    ],
    responses: { 200: reply('The executions', object({ executions: array(ref('ExecutionSummary')) }, ['executions'])) },
  });
  add('get', '/api/executions/{id}', {
    tag: 'Executions',
    id: 'getExecution',
    summary: 'Get an execution with its run data',
    responses: { 200: reply('The execution (and a trace link when LANDFLOW_TRACE_URL is set)', object({ execution: ref('ExecutionRecord'), traceUrl: { type: 'string' } }, ['execution'])), 404: notFound },
  });
  add('get', '/api/executions/{id}/events', {
    tag: 'Executions',
    id: 'getExecutionEvents',
    summary: 'Read the Run Trace journal of an execution',
    description: 'The events of the run (spans, messages, artifacts, checks) in order, after a sequence number. `last` is the highest seq of the page; `more` says another page follows. The live stream sends new events as `journal` events.',
    pathParams: { id: 'The execution id' },
    query: [
      { name: 'after', description: 'Only events with a higher seq (default 0)', schema: { type: 'integer', minimum: 0, default: 0 } },
      { name: 'limit', description: 'At most this many (default 500, at most 2000)', schema: { type: 'integer', minimum: 1, maximum: 2000, default: 500 } },
    ],
    responses: { 200: reply('The events', object({ events: array({ type: 'object' }), last: { type: 'integer' }, more: { type: 'boolean' } }, ['events', 'last', 'more'])), 404: notFound },
  });
  add('get', '/api/executions/{id}/changes', {
    tag: 'Executions',
    id: 'getExecutionChanges',
    summary: 'Read the branch of a run as GitHub sees it',
    description:
      'Compares the branch the run worked on with its base, through the GitHub plugin’s Repository → Compare and the flow’s own GitHub credential. The repository and branch come from the run’s GitHub steps and journal. `available: false` with a `reason` when the run names no repository or branch, has no GitHub credential to read it with, or GitHub refuses. Files carry GitHub’s patch unless it is large or binary, up to 300 files (`truncated`). Kept per run for 10 minutes (15 seconds while live).',
    pathParams: { id: 'The execution id' },
    responses: {
      200: reply(
        'The comparison, or why there is none',
        object({ available: { type: 'boolean' }, reason: { type: 'string' }, repository: object({ owner: { type: 'string' }, repo: { type: 'string' }, url: { type: 'string' } }, ['owner', 'repo', 'url']), branch: { type: 'object' }, fetchedAt: { type: 'string' } }, ['available']),
      ),
      404: notFound,
    },
  });
  add('post', '/api/executions/{id}/checks', {
    tag: 'Executions',
    id: 'decideExecutionCheck',
    summary: 'Settle a failed check of a run',
    description: 'A person accepts a failed check as it is, or sends it back for a fix. Written to the journal as a check event with a `resolution`.',
    pathParams: { id: 'The execution id' },
    body: jsonBody(object({ spanId: { type: 'string' }, name: { type: 'string' }, subject: { type: 'string', description: "Which of the span's checks of that name, when there are several (a team's Budget for each member)" }, decision: { type: 'string', enum: ['accepted', 'sent_back'] }, note: { type: 'string' } }, ['spanId', 'name', 'decision'])),
    responses: { 200: reply('The check with its resolution', object({ check: { type: 'object' } }, ['check'])), 404: notFound, 409: errorRef('The check already has a decision, or did not fail') },
  });
  add('post', '/api/executions/{id}/gate', {
    tag: 'Executions',
    id: 'decideRunReportGate',
    summary: 'Answer a Run report waiting on its failed checks',
    description: 'For a Run report node whose gate asks a person: accept the failed checks as they are, or send the work back. The decision goes into the journal, settles each failed check, and the run resumes out of Passed or Send back.',
    pathParams: { id: 'The execution id' },
    body: jsonBody(object({ decision: { type: 'string', enum: ['accepted', 'sent_back'] }, note: { type: 'string' } }, ['decision'])),
    responses: { 200: reply('The run after it went on', object({ status: { type: 'string' } }, ['status'])), 404: notFound, 409: errorRef('The run is not waiting on a Run report') },
  });
  add('get', '/api/executions/{id}/approvals', {
    tag: 'Executions',
    id: 'getExecutionApprovals',
    summary: 'The tool calls a waiting run asks a person to approve',
    description: 'An AI Agent node’s, or a team member’s, tool calls waiting for approval, with the decisions so far (`calls: [{ id, tool, input }]`, `decisions`). `approval` is null when the run waits for nothing of the kind.',
    pathParams: { id: 'The execution id' },
    responses: { 200: reply('The approval', object({ approval: { type: 'object', nullable: true, additionalProperties: true } }, ['approval'])), 404: notFound },
  });
  add('post', '/api/executions/{id}/approvals', {
    tag: 'Executions',
    id: 'decideExecutionApproval',
    summary: 'Approve or reject one waiting tool call, optionally with an edited input',
    description: 'Streams `decision` (`{ status: \'waiting\' | \'resumed\', approval }`), then, once every call has a decision, the resumed run’s `execution` events and a `result`. `input` (only with `approved: true`) is the tool’s input as a person changed it: the tool runs with it instead of the call’s own, and the run’s journal marks the wait `edited` (`editedBy`) and says “Approved … with changes”. It must be a JSON object (up to 200 KB). An Ask a Person node’s request (`approval.confirm`, call id `confirm`) takes `text` (with `approved: true`, only when the node allows editing) and `comment` instead. Errors before anything is decided are JSON: 400 (a bad edit), 403 (not one of the people who may answer, or editing is not allowed), 404, 409 (already decided, or nothing to approve).',
    pathParams: { id: 'The execution id' },
    body: jsonBody(object({ callId: { type: 'string' }, approved: { type: 'boolean' }, input: { type: 'object', additionalProperties: true, description: 'The tool’s input as edited; replaces the call’s own input. Approvals only.' }, text: { type: 'string', description: 'Ask a Person: the draft as edited. Approvals only.' }, comment: { type: 'string', description: 'Ask a Person: a note left with the decision' } }, ['callId', 'approved'])),
    responses: { 200: reply('The decision, then the resumed run', { type: 'string', description: '`event: <name>` and `data: <JSON>` lines' }, 'text/event-stream'), 400: invalid, 403: errorRef('Not one of the people who may answer'), 404: notFound, 409: errorRef('Already decided, or the run is not waiting for a tool approval') },
  });
  add('get', '/api/runs/needs-you', {
    tag: 'Executions',
    id: 'listRunsNeedingYou',
    summary: 'What waits for a person across runs',
    description: 'Waiting runs that ask for an approval, a form, an answer or a Run report decision, and failed checks of the last 7 days nobody settled. Each item: executionId, workflowId, workflowName, kind (approval, form, question, gate, check), title, detail, actor, member (the team member a tool approval or a guard’s ask is for), spanId, since.',
    responses: { 200: reply('The items, newest first', object({ items: array({ type: 'object' }) }, ['items'])) },
  });
  add('get', '/api/runs/lines', {
    tag: 'Executions',
    id: 'runLines',
    summary: 'What runs did, in one line each',
    description: 'By execution id: `in` (what came in: label, detail, kind), `by` (the lead or agent, the members who worked, the team), `out` (what came out: label, detail, url, tone ok, warn, bad or live), status, ms and tokens. Runs the caller cannot read, and runs without a journal, are left out.',
    query: [{ name: 'ids', description: 'Execution ids, comma-separated (at most 20)', required: true, schema: { type: 'string' } }],
    responses: { 200: reply('The lines, by execution id', object({ lines: { type: 'object' } }, ['lines'])), 400: errorRef('No ids, or too many') },
  });
  add('get', '/api/runs/search', {
    tag: 'Executions',
    id: 'searchRuns',
    summary: 'Search saved runs',
    description: 'Saved runs of the workflows the caller sees, newest first, matching every filter given. `text` looks in span names, inputs and outputs, messages, artifacts and checks; a run without a journal matches only the filters that need none. Each item: executionId, workflowId, workflowName, status, startedAt, durationMs, matches (where the words were found) and, with a journal filter, failedSteps and failedChecks. `truncated` says the search stopped at the most runs it reads per request.',
    query: [
      { name: 'text', description: 'Words to find', schema: { type: 'string' } },
      { name: 'workflowId', description: 'Only this workflow’s', schema: { type: 'string' } },
      { name: 'actor', description: 'An agent, model or person, by name or id', schema: { type: 'string' } },
      { name: 'tool', description: 'A tool call, by name', schema: { type: 'string' } },
      { name: 'status', description: 'success, error, waiting, canceled…', schema: { type: 'string' } },
      { name: 'failedSteps', description: 'Some step failed', schema: { type: 'boolean' } },
      { name: 'failedCheck', description: 'A check failed: by name, empty for any', schema: { type: 'string' } },
      { name: 'from', description: 'Started on or after (ISO or YYYY-MM-DD)', schema: { type: 'string' } },
      { name: 'to', description: 'Started on or before (ISO or YYYY-MM-DD)', schema: { type: 'string' } },
      { name: 'limit', description: 'At most this many (default 20, at most 100)', schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
      { name: 'offset', description: 'Skip this many matches', schema: { type: 'integer', minimum: 0, default: 0 } },
    ],
    responses: { 200: reply('The matches', object({ items: array({ type: 'object' }), more: { type: 'boolean' }, truncated: { type: 'boolean' } }, ['items', 'more'])) },
  });
  add('get', '/api/runs/compare', {
    tag: 'Executions',
    id: 'compareRuns',
    summary: 'Compare two runs',
    description: 'Each run folded from its journal: duration, tokens in and out, cost, model calls, steps, failed steps, checks (pass, fail, warn), failed checks, artifacts and the same numbers per actor. `delta` is b minus a; `actors` has one entry per actor of either run with both sides and the difference.',
    query: [
      { name: 'a', description: 'The first execution id', required: true, schema: { type: 'string' } },
      { name: 'b', description: 'The second execution id', required: true, schema: { type: 'string' } },
    ],
    responses: { 200: reply('The comparison', object({ a: { type: 'object' }, b: { type: 'object' }, delta: { type: 'object' }, actors: array({ type: 'object' }) }, ['a', 'b', 'delta', 'actors'])), 400: errorRef('A run is missing'), 404: notFound },
  });
  add('get', '/api/runs/measures', {
    tag: 'Executions',
    id: 'runMeasures',
    summary: 'A workflow’s runs as measures over time',
    description: 'The latest saved runs of a workflow, oldest first: executionId, startedAt, status, durationMs, tokensIn, tokensOut, costUsd, failedSteps and checksFailed.',
    query: [
      { name: 'workflowId', description: 'The workflow', required: true, schema: { type: 'string' } },
      { name: 'limit', description: 'At most this many runs (default 30, at most 100)', schema: { type: 'integer', minimum: 1, maximum: 100, default: 30 } },
    ],
    responses: { 200: reply('The points', object({ workflowId: { type: 'string' }, workflowName: { type: 'string' }, runs: array({ type: 'object' }) }, ['workflowId', 'runs'])), 400: errorRef('workflowId is missing'), 404: notFound },
  });
  add('get', '/api/executions/{id}/feedback', {
    tag: 'Executions',
    id: 'getExecutionFeedback',
    summary: 'The thumbs up/down a chat answer got',
    responses: { 200: reply('The feedback, or null when unrated', object({ feedback: { type: 'object', nullable: true, additionalProperties: true } }, ['feedback'])), 404: notFound },
  });
  add('put', '/api/executions/{id}/feedback', {
    tag: 'Executions',
    id: 'rateExecution',
    summary: 'Rate a chat answer (thumbs up or down, optional comment)',
    description: 'The same rating the hosted chat and the widget give (POST /chat/<key>/feedback). `rating: null` takes it back. Online evaluations grade answers rated down and show the rating next to their score.',
    body: jsonBody(object({ rating: { type: 'string', enum: ['up', 'down'], nullable: true }, comment: { type: 'string', maxLength: 2000 } }, ['rating'])),
    responses: { 200: reply('The feedback now on the answer', object({ feedback: { type: 'object', nullable: true, additionalProperties: true } }, ['feedback'])), 404: notFound },
  });
  add('get', '/api/workflows/{id}/chat-feedback', {
    tag: 'Executions',
    id: 'listChatFeedback',
    summary: 'A workflow’s chat feedback',
    description: 'Thumbs up/down and comments on the answers of its hosted chat, widget and editor, newest first, with the totals. Filters: `rating`, `sessionId`, `limit` (up to 500).',
    responses: { 200: reply('The feedback', object({ feedback: array({ type: 'object', additionalProperties: true }), up: { type: 'integer' }, down: { type: 'integer' } }, ['feedback', 'up', 'down'])), 404: notFound },
  });
  add('get', '/api/agents/{id}/sessions/{sid}/feedback', {
    tag: 'Executions',
    id: 'getAgentSessionFeedback',
    summary: 'Ratings of an agent session’s replies',
    responses: { 200: reply('The ratings', object({ feedback: array({ type: 'object', additionalProperties: true }) }, ['feedback'])), 404: notFound },
  });
  add('put', '/api/agents/{id}/sessions/{sid}/feedback', {
    tag: 'Executions',
    id: 'rateAgentReply',
    summary: 'Rate an agent reply (thumbs up or down, optional comment)',
    body: jsonBody(object({ entryId: { type: 'string', description: 'The id of an assistant entry of the session’s timeline' }, rating: { type: 'string', enum: ['up', 'down'], nullable: true }, comment: { type: 'string', maxLength: 2000 } }, ['entryId', 'rating'])),
    responses: { 200: reply('The feedback now on the reply', object({ feedback: { type: 'object', nullable: true, additionalProperties: true } }, ['feedback'])), 404: notFound },
  });
  const teamBody = jsonBody(object({ name: { type: 'string' }, goal: { type: 'string' }, description: { type: 'string' }, members: array({ type: 'object', additionalProperties: true }) }), 'The draft: members are `{ id, kind: agent | a2a, title, role, reportsTo, reviews, consults, budgetTokens, questionsTo, agentId | parameters, credentials }`', false);
  const teamReply = (description: string) => reply(description, object({ team: { type: 'object', additionalProperties: true }, issues: array({ type: 'string' }) }, ['team']));
  add('get', '/api/agent-teams', {
    tag: 'Agent teams',
    id: 'listAgentTeams',
    summary: 'The agent teams you can see',
    description: 'Teams of agents with standing relations (docs/agent-teams.md): name, goal, lead, member count, published version and `issues` (what stops the draft from being published). `projectId` limits them to a project.',
    responses: { 200: reply('The teams', object({ teams: array({ type: 'object', additionalProperties: true }) }, ['teams'])) },
  });
  add('post', '/api/agent-teams', {
    tag: 'Agent teams',
    id: 'createAgentTeam',
    summary: 'Create an agent team',
    body: teamBody,
    responses: { 201: teamReply('The new team'), 400: invalid },
  });
  add('get', '/api/agent-teams/{id}', { tag: 'Agent teams', id: 'getAgentTeam', summary: 'An agent team, with the issues that stop it from being published', responses: { 200: teamReply('The team'), 404: notFound } });
  add('put', '/api/agent-teams/{id}', {
    tag: 'Agent teams',
    id: 'saveAgentTeam',
    summary: 'Save the team’s draft',
    description: 'Replaces the draft; the published version stays as it is. A draft with issues saves anyway: they only stop publishing.',
    body: teamBody,
    responses: { 200: teamReply('The saved team'), 400: invalid, 404: notFound },
  });
  add('delete', '/api/agent-teams/{id}', { tag: 'Agent teams', id: 'deleteAgentTeam', summary: 'Delete an agent team', responses: { 200: reply('Deleted'), 404: notFound } });
  add('post', '/api/agent-teams/{id}/publish', {
    tag: 'Agent teams',
    id: 'publishAgentTeam',
    summary: 'Publish the draft as the next version',
    responses: { 200: teamReply('The team, published'), 400: errorRef('The draft has issues (`issues` lists them)'), 404: notFound },
  });
  add('get', '/api/agent-teams/{id}/last-run', {
    tag: 'Agent teams',
    id: 'getAgentTeamLastRun',
    summary: 'The team’s latest run in a flow, with each member’s tokens against its budget',
    description: 'The newest execution whose Run a Team node ran this team: `run` has `executionId`, `workflowName`, `status`, `startedAt`, `nodeName`, `members` (`title`, `tokens`, `budgetTokens`, `estimated`, `overBudget`, `costUsd`), and the run’s `durationMs` and last few `moments`. Empty when the team has not run.',
    responses: { 200: reply('The latest run, or nothing'), 404: notFound },
  });
  add('get', '/api/agent-teams/{id}/notes', {
    tag: 'Agent teams',
    id: 'listTeamNotes',
    summary: 'The team’s notebook: notes, counts and search by meaning',
    description: 'Notes the team’s members wrote while working (docs/team-notebook.md). Query: `scope` (run, team, project), `kind`, `status`, `run` (an execution id), `expired=1` to include expired notes, `q` to rank by meaning (`via` says whether embeddings or keywords did it). Returns `notes`, `counts` and `via`.',
    responses: { 200: reply('The notes'), 404: notFound },
  });
  add('post', '/api/agent-teams/{id}/notes', {
    tag: 'Agent teams',
    id: 'addTeamNote',
    summary: 'Add a note as a person',
    description: 'A person’s note lands in the team scope, verified. Body: `text` and optional `kind`.',
    responses: { 201: reply('The note'), 400: invalid, 404: notFound },
  });
  add('post', '/api/agent-teams/{id}/notes/{noteId}', {
    tag: 'Agent teams',
    id: 'actOnTeamNote',
    summary: 'Verify, answer, reopen, dispute, resolve, promote or edit a note',
    description: 'Body `{ action }` with `verify`; `answer` and `dispute` and `edit` (`text`); `reopen`; `resolve` (`keep`: the id of the note that holds); `promote` (`to`: team or project; a project note becomes a suggestion in the second brain’s inbox).',
    responses: { 200: reply('The note, or the pair, or the promotion'), 201: reply('The disputing note'), 400: invalid, 404: notFound },
  });
  add('delete', '/api/agent-teams/{id}/notes/{noteId}', { tag: 'Agent teams', id: 'deleteTeamNote', summary: 'Forget a note', responses: { 200: reply('Deleted'), 404: notFound } });
  add('post', '/api/agent-teams/{id}/unpublish', { tag: 'Agent teams', id: 'unpublishAgentTeam', summary: 'Stop flows from running the team', responses: { 200: teamReply('The team, unpublished'), 404: notFound } });
  const exportQuery = [
    { name: 'format', description: '`claude-plugin` (the only format, and the default)', schema: { type: 'string', enum: ['claude-plugin'] } },
    { name: 'marketplace', description: '`1`: also write `.claude-plugin/marketplace.json`, so the folder is a one-plugin marketplace', schema: { type: 'string' } },
    { name: 'preview', description: '`1`: answer with the list of files (`{ name, files: [{ path, bytes }] }`) instead of the zip', schema: { type: 'string' } },
  ];
  const zipReply = { description: 'The plugin as a zip (`Content-Disposition: attachment; filename="<name>.zip"`), or the file list with `preview=1`', content: { 'application/zip': { schema: { type: 'string', format: 'binary' } }, 'application/json': { schema: object({ name: { type: 'string' }, files: array(object({ path: { type: 'string' }, bytes: { type: 'integer' } }, ['path', 'bytes'])) }, ['name', 'files']) } } };
  add('get', '/api/agents/{id}/export', {
    tag: 'Agent teams',
    id: 'exportAgentPlugin',
    summary: 'Export an agent as a Claude Code plugin',
    description: 'A zip in Anthropic’s plugin format (docs/marketplace.md#export-agents-as-plugins): `.claude-plugin/plugin.json`, `agents/<slug>.md` (name, description, tools, model, color; the prompt as the body), `skills/<slug>/SKILL.md`, and `.landflow/agents/<slug>.json` with what only Landflow uses (persona parts, tools, avatar, model provider), which Claude Code ignores and installing the plugin in Landflow reads back. Credentials, schedules and channels are left out.',
    query: exportQuery,
    responses: { 200: zipReply, 400: invalid, 404: notFound },
  });
  add('get', '/api/agent-teams/{id}/export', {
    tag: 'Agent teams',
    id: 'exportAgentTeamPlugin',
    summary: 'Export a team as a Claude Code plugin',
    description: 'Like an agent’s export, with a file per Landflow agent in the team, the skills they use, and `.landflow/team.json` with the members, who reports to whom and who reviews (remote A2A members are there only, without credentials).',
    query: exportQuery,
    responses: { 200: zipReply, 400: invalid, 404: notFound },
  });
  add('get', '/api/agent-teams/{id}/flows', {
    tag: 'Agent teams',
    id: 'listAgentTeamFlows',
    summary: 'The workflows you can see that run the team',
    description: 'Workflows with a Run a Team node set to this team: the ones “Save as template” can take along.',
    responses: { 200: reply('The flows', object({ flows: array(object({ id: { type: 'string' }, name: { type: 'string' }, active: { type: 'boolean' }, nodes: { type: 'integer' } }, ['id', 'name', 'active', 'nodes'])) }, ['flows'])), 404: notFound },
  });
  add('post', '/api/agent-teams/{id}/template', {
    tag: 'Agent teams',
    id: 'saveAgentTeamAsTemplate',
    summary: 'Save the team as a template',
    description: 'A template holding the team, every Landflow agent in it (published config, the draft while unpublished), the remote members’ A2A addresses and, with `workflowId`, that workflow (it must have a Run a Team node set to this team). Credentials the agents, remote members and workflow name become slots; no secret leaves. Using the template (`POST /api/templates/{id}/use`) creates all of it with fresh ids. `projectId`: where it is saved (`null`: instance-wide, owners and admins).',
    body: jsonBody(
      object(
        {
          name: { type: 'string', maxLength: 200 },
          description: { type: 'string', maxLength: 2000 },
          categories: array({ type: 'string' }),
          setup: array({ type: 'string' }),
          workflowId: { type: 'string', description: 'A workflow you can see that runs this team' },
          projectId: { type: ['string', 'null'] },
        },
        ['name'],
      ),
    ),
    responses: { 201: reply('The template', object({ template: { type: 'object', additionalProperties: true } }, ['template'])), 400: invalid, 403: errorRef('You can’t add templates there'), 404: notFound },
  });
  add('delete', '/api/executions/{id}', {
    tag: 'Executions',
    id: 'deleteExecution',
    summary: 'Cancel or delete an execution',
    description: 'Cancels a running, waiting or queued execution; removes a finished one from history.',
    responses: { 200: reply('`canceled` or `deleted`', object({ canceled: { type: 'boolean' }, deleted: { type: 'boolean' } })), 404: notFound },
  });
  add('post', '/api/executions/{id}/stop', {
    tag: 'Executions',
    id: 'stopExecution',
    summary: 'Stop an execution',
    description: 'Cancels a running, waiting or queued execution; never deletes. One that already ended answers 409.',
    responses: {
      200: reply('Stopped (`status`: what it was)', object({ executionId: { type: 'string' }, stopped: { type: 'boolean' }, status: ref('ExecutionStatus') }, ['executionId', 'stopped', 'status'])),
      404: notFound,
      409: errorRef('The execution already ended'),
    },
  });
  add('get', '/api/executions/{id}/debug-tokens', {
    tag: 'Executions',
    id: 'listDebugTokens',
    summary: 'List the debug tokens of an execution',
    description: 'Yours for this execution (owners and admins: everyone’s), live, expired and revoked; never the token itself.',
    responses: { 200: reply('The tokens', object({ tokens: array({ type: 'object' }) }, ['tokens'])), 404: notFound },
  });
  add('post', '/api/executions/{id}/debug-tokens', {
    tag: 'Executions',
    id: 'createDebugToken',
    summary: 'Mint a debug token for an execution',
    description:
      'A short-lived read-only token bound to this execution, for an agent that explains a failed run: it opens `explain_failure`, `get_run_trace` and `get_execution` at `/api/mcp` for this execution and nothing else, redacted of credentials and `$vars`, audited per call. The token is returned once. See docs/specs/19-debug-token.md.',
    body: jsonBody(
      object({ ttlSeconds: { type: 'integer', minimum: 60, maximum: 86400, default: 3600 }, scopes: array({ type: 'string', enum: ['executions:read', 'trace:read'] }), label: { type: 'string', maxLength: 100 } }),
      undefined,
      false,
    ),
    responses: {
      201: reply('The token (shown once) and its record', object({ token: { type: 'string' }, record: { type: 'object' }, mcp: object({ enabled: { type: 'boolean' }, path: { type: 'string' } }) }, ['token', 'record'])),
      400: invalid,
      404: notFound,
      409: errorRef('The execution already has too many live debug tokens'),
    },
  });
  add('delete', '/api/executions/{id}/debug-tokens/{tokenId}', {
    tag: 'Executions',
    id: 'revokeDebugToken',
    summary: 'Revoke a debug token',
    description: 'Its minter, owners and admins. The token stops working on its next call.',
    responses: { 200: reply('Revoked', object({ ok: { type: 'boolean' }, revoked: { type: 'boolean' }, record: { type: 'object' } }, ['ok', 'revoked'])), 404: notFound },
  });
  add('post', '/api/executions/{id}/retry', {
    tag: 'Executions',
    id: 'retryExecution',
    summary: 'Retry a failed execution',
    description: 'A new execution linked to this one. `from: failed` continues from the failed node, reusing what ran before; `start` runs it all again with the same input. `version: original` runs the version that failed.',
    body: jsonBody(object({ from: { type: 'string', enum: ['failed', 'start'], default: 'failed' }, version: { type: 'string', enum: ['original', 'current'], default: 'original' } }), undefined, false),
    responses: { 202: reply('Started', object({ executionId: { type: 'string' } }, ['executionId'])), 400: invalid, 404: notFound, 409: errorRef('This execution can’t be retried') },
  });
  add('post', '/api/executions/{id}/rerun', {
    tag: 'Executions',
    id: 'rerunExecution',
    summary: 'Re-run an execution',
    description: 'All of it with the same input, from one node (reusing everything before it) or just one node, in the background.',
    body: jsonBody(
      object({ scope: { type: 'string', enum: ['all', 'from', 'only'], default: 'all' }, nodeId: { type: 'string' }, version: { type: 'string', enum: ['current', 'original'], default: 'current' }, askMember: object({ member: { type: 'string' }, message: { type: 'string' } }, ['member', 'message']) }),
    ),
    responses: { 202: reply('Started', object({ executionId: { type: 'string' } }, ['executionId'])), 400: invalid, 404: notFound },
  });
  add('get', '/api/executions/{id}/agents', {
    tag: 'Executions',
    id: 'listExecutionAgents',
    summary: 'Team members at work',
    description: 'The team members of a running execution that can be paused, and their state (`working`, `pausing`, `paused`). Held in memory by the server that runs it.',
    responses: { 200: reply('Members', object({ members: { type: 'array', items: object({ member: { type: 'string' }, kind: { type: 'string', enum: ['agent', 'remote'] }, state: { type: 'string', enum: ['working', 'pausing', 'paused'] }, since: { type: 'string' } }) } }, ['members'])) },
  });
  add('post', '/api/executions/{id}/agents/{member}/pause', {
    tag: 'Executions',
    id: 'pauseExecutionAgent',
    summary: 'Pause a team member',
    description: 'A Landflow agent member (the lead too) stops at its next step boundary and waits; a remote (A2A) member is stopped at once (its task is canceled) so it can be redirected. `member` is its title in the team. Answers 404 when it isn’t working in this execution.',
    responses: { 200: reply('Pausing or paused', object({ member: { type: 'string' }, kind: { type: 'string' }, state: { type: 'string', enum: ['working', 'pausing', 'paused'] } })), 404: notFound, 502: errorRef('The remote agent could not be stopped') },
  });
  add('post', '/api/executions/{id}/agents/{member}/continue', {
    tag: 'Executions',
    id: 'continueExecutionAgent',
    summary: 'Take over a paused team member',
    description: 'Sends the next instruction (a message from the person) to a paused member, which goes on with it. Without `message` it goes on as it was. Answers 409 when the member is not paused.',
    body: jsonBody(object({ message: { type: 'string', maxLength: 8000 } }), undefined, false),
    responses: { 200: reply('Going on', object({ member: { type: 'string' }, kind: { type: 'string' }, state: { type: 'string' } })), 404: notFound, 409: errorRef('The member is not paused') },
  });
  add('post', '/api/executions/stop-all', {
    tag: 'Executions',
    id: 'stopAllExecutions',
    summary: 'Stop every execution',
    description: 'Aborts running executions, cancels waiting and queued ones and drops pending automatic retries.',
    responses: { 200: reply('How many of each', object({ running: { type: 'integer' }, waiting: { type: 'integer' }, queued: { type: 'integer' }, retries: { type: 'integer' } })) },
  });

  // ---- data tables ----
  const tableReply = (description: string) => reply(description, object({ table: ref('DataTable') }, ['table']));
  add('get', '/api/data-tables', {
    tag: 'Data tables',
    id: 'listDataTables',
    summary: 'List data tables',
    responses: { 200: reply('Every table with its columns and row count', object({ tables: array(ref('DataTable')) }, ['tables'])) },
  });
  add('post', '/api/data-tables', {
    tag: 'Data tables',
    id: 'createDataTable',
    summary: 'Create a data table',
    body: jsonBody(object({ name: { type: 'string' }, columns: { ...array(ref('DataTableColumn')), maxItems: 100 } }, ['name'])),
    responses: { 201: tableReply('The table'), 400: invalid },
  });
  add('get', '/api/data-tables/{id}', { tag: 'Data tables', id: 'getDataTable', summary: 'Get a data table', responses: { 200: tableReply('The table with its row count'), 404: notFound } });
  add('patch', '/api/data-tables/{id}', {
    tag: 'Data tables',
    id: 'renameDataTable',
    summary: 'Rename a data table',
    body: jsonBody(object({ name: { type: 'string' } }, ['name'])),
    responses: { 200: tableReply('The table'), 400: invalid, 404: notFound },
  });
  add('delete', '/api/data-tables/{id}', { tag: 'Data tables', id: 'deleteDataTable', summary: 'Delete a data table and its rows', responses: { 200: reply('Deleted', ok), 404: notFound } });
  add('post', '/api/data-tables/{id}/columns', {
    tag: 'Data tables',
    id: 'addDataTableColumn',
    summary: 'Add a column',
    description: 'Existing rows read it as empty.',
    body: jsonBody(ref('DataTableColumn')),
    responses: { 201: tableReply('The table'), 400: invalid, 404: notFound },
  });
  add('patch', '/api/data-tables/{id}/columns/{column}', {
    tag: 'Data tables',
    id: 'renameDataTableColumn',
    summary: 'Rename a column',
    body: jsonBody(object({ name: { type: 'string' } }, ['name'])),
    responses: { 200: tableReply('The table'), 400: invalid, 404: notFound },
  });
  add('delete', '/api/data-tables/{id}/columns/{column}', { tag: 'Data tables', id: 'deleteDataTableColumn', summary: 'Delete a column and its values', responses: { 200: tableReply('The table'), 404: notFound } });
  add('get', '/api/data-tables/{id}/rows', {
    tag: 'Data tables',
    id: 'listDataTableRows',
    summary: 'Query rows',
    query: [
      { name: 'offset', description: 'Rows to skip', schema: { type: 'integer', minimum: 0, default: 0 } },
      { name: 'limit', description: 'Rows to return (at most 1000)', schema: { type: 'integer', minimum: 1, maximum: 1000, default: 50 } },
      { name: 'sortBy', description: 'A column, or id / createdAt / updatedAt', schema: { type: 'string' } },
      { name: 'sortDirection', description: 'Sort order', schema: { type: 'string', enum: ['asc', 'desc'] } },
      { name: 'search', description: 'Case-insensitive text over every column', schema: { type: 'string' } },
      { name: 'filter', description: 'A RowFilter as JSON: `{ "type": "and", "conditions": [{ "column": "status", "operator": "eq", "value": "open" }] }`', schema: { type: 'string' } },
    ],
    responses: {
      200: reply('A page of rows', object({ rows: array(ref('DataTableRow')), total: { type: 'integer' }, offset: { type: 'integer' }, limit: { type: 'integer' } }, ['rows', 'total'])),
      400: invalid,
      404: notFound,
    },
  });
  add('post', '/api/data-tables/{id}/rows', {
    tag: 'Data tables',
    id: 'insertDataTableRows',
    summary: 'Insert rows',
    body: jsonBody(object({ rows: { ...array(ref('RowValues')), minItems: 1, maxItems: 10_000 } }, ['rows'])),
    responses: { 201: reply('The inserted rows', object({ rows: array(ref('DataTableRow')) }, ['rows'])), 400: invalid, 404: notFound },
  });
  add('patch', '/api/data-tables/{id}/rows', {
    tag: 'Data tables',
    id: 'updateDataTableRows',
    summary: 'Update the rows a filter matches',
    body: jsonBody(object({ filter: ref('RowFilter'), values: ref('RowValues') }, ['filter', 'values'])),
    responses: { 200: reply('The updated rows', object({ rows: array(ref('DataTableRow')) }, ['rows'])), 400: invalid, 404: notFound },
  });
  add('delete', '/api/data-tables/{id}/rows', {
    tag: 'Data tables',
    id: 'deleteDataTableRows',
    summary: 'Delete rows by id or filter',
    body: jsonBody(object({ ids: array({ type: 'integer' }), filter: ref('RowFilter') })),
    responses: { 200: reply('How many went', object({ deleted: { type: 'integer' }, ids: array({ type: 'integer' }) }, ['deleted', 'ids'])), 400: invalid, 404: notFound },
  });
  add('patch', '/api/data-tables/{id}/rows/{rowId}', {
    tag: 'Data tables',
    id: 'updateDataTableRow',
    summary: 'Update one row',
    body: jsonBody(object({ values: ref('RowValues') }, ['values'])),
    responses: { 200: reply('The row', object({ row: ref('DataTableRow') }, ['row'])), 400: invalid, 404: notFound },
  });
  add('delete', '/api/data-tables/{id}/rows/{rowId}', { tag: 'Data tables', id: 'deleteDataTableRow', summary: 'Delete one row', responses: { 200: reply('Deleted', ok), 404: notFound } });
  add('post', '/api/data-tables/{id}/rows/upsert', {
    tag: 'Data tables',
    id: 'upsertDataTableRows',
    summary: 'Insert or update rows',
    description: 'Rows matching an existing row on `matchColumns` update it; the others are inserted.',
    body: jsonBody(object({ matchColumns: { ...array({ type: 'string' }), minItems: 1, maxItems: 20 }, rows: { ...array(ref('RowValues')), minItems: 1, maxItems: 10_000 } }, ['matchColumns', 'rows'])),
    responses: { 200: reply('The rows written', object({ rows: array(ref('DataTableRow')), inserted: { type: 'integer' }, updated: { type: 'integer' } }, ['rows', 'inserted', 'updated'])), 400: invalid, 404: notFound },
  });
  add('post', '/api/data-tables/{id}/import', {
    tag: 'Data tables',
    id: 'importDataTableCsv',
    summary: 'Import a CSV',
    description: 'The first line names the columns. Unknown headers become new columns unless `createColumns=false`; id, createdAt and updatedAt are skipped. At most 32 MB.',
    query: [{ name: 'createColumns', description: '`false`: skip headers the table doesn’t have', schema: { type: 'string', enum: ['true', 'false'] } }],
    body: {
      required: true,
      content: {
        'text/csv': { schema: { type: 'string' } },
        'application/json': { schema: object({ csv: { type: 'string' }, createColumns: { type: 'boolean' } }, ['csv']) },
      },
    },
    responses: {
      200: reply('What was imported', object({ inserted: { type: 'integer' }, columnsAdded: array(ref('DataTableColumn')), skipped: array({ type: 'string' }) }, ['inserted', 'columnsAdded', 'skipped'])),
      400: invalid,
      404: notFound,
      413: errorRef('The CSV is larger than 32 MB'),
    },
  });
  add('get', '/api/data-tables/{id}/export', {
    tag: 'Data tables',
    id: 'exportDataTableCsv',
    summary: 'Export as CSV',
    responses: { 200: reply('Every row (id, the columns, createdAt, updatedAt) as a download', { type: 'string' }, 'text/csv'), 404: notFound },
  });

  // ---- variables ----
  add('get', '/api/variables', { tag: 'Variables', id: 'listVariables', summary: 'List variables', description: 'Read in expressions as `{{ $vars.KEY }}`, sorted by key.', responses: { 200: reply('The variables', array(ref('Variable'))) } });
  add('post', '/api/variables', { tag: 'Variables', id: 'createVariable', summary: 'Create a variable', body: jsonBody(ref('Variable')), responses: { 201: reply('The variable', ref('Variable')), 400: invalid, 409: errorRef('The key exists') } });
  add('get', '/api/variables/{key}', { tag: 'Variables', id: 'getVariable', summary: 'Get a variable', responses: { 200: reply('The variable', ref('Variable')), 404: notFound } });
  add('patch', '/api/variables/{key}', {
    tag: 'Variables',
    id: 'updateVariable',
    summary: 'Change or rename a variable',
    description: 'A new `key` renames it.',
    body: jsonBody(object({ key: { type: 'string' }, value: { type: 'string' } })),
    responses: { 200: reply('The variable', ref('Variable')), 400: invalid, 404: notFound, 409: errorRef('The new key exists') },
  });
  add('delete', '/api/variables/{key}', { tag: 'Variables', id: 'deleteVariable', summary: 'Delete a variable', responses: { 200: reply('Deleted', ok), 404: notFound } });

  // ---- settings ----
  const settingsDoc = object({
    timezone: { type: 'string' },
    executions: object({ maxCount: { type: 'integer' }, maxAgeDays: { type: 'integer' } }),
    jsonRender: { type: 'boolean', description: 'Saved json-render choice; absent while the LANDFLOW_JSON_RENDER default applies' },
  });
  add('get', '/api/settings', {
    tag: 'Settings',
    id: 'getSettings',
    summary: 'Get the instance settings',
    description: '`jsonRender` is the json-render flag as it stands: the saved choice, else the `LANDFLOW_JSON_RENDER` default.',
    responses: { 200: reply('The settings', object({ settings: settingsDoc, jsonRender: { type: 'boolean' }, hostTimezone: { type: 'string' }, executions: object({ stored: { type: 'integer' }, prunable: { type: 'integer' } }) })) },
  });
  add('patch', '/api/settings', {
    tag: 'Settings',
    id: 'updateSettings',
    summary: 'Change the instance settings',
    description: 'Any subset. `jsonRender` (`true`, `false`, or `null` for the environment default) is the owner’s: an admin gets 403.',
    body: jsonBody(object({ timezone: { type: 'string' }, executions: object({ maxCount: { type: 'integer' }, maxAgeDays: { type: 'integer' } }), jsonRender: { type: ['boolean', 'null'] } })),
    responses: { 200: reply('The settings', object({ settings: settingsDoc, jsonRender: { type: 'boolean' } })), 400: invalid, 403: errorRef('Not the owner (json-render)') },
  });

  // ---- templates ----
  const templateReply = (description: string) => reply(description, object({ template: ref('Template') }, ['template']));
  add('get', '/api/templates', {
    tag: 'Templates',
    id: 'listTemplates',
    summary: 'List templates',
    description:
      'Saved on this instance (the caller’s projects’ and the instance-wide ones), then built-in ones; remote ones (LANDFLOW_TEMPLATES_URL) when searching or with `source=remote`, 30 per page.',
    query: [
      { name: 'search', description: 'Matches name, description and node types', schema: { type: 'string' } },
      { name: 'projectId', description: 'Saved templates of this project and the instance-wide ones only', schema: { type: 'string' } },
      { name: 'page', description: 'The page of remote results (1-based)', schema: { type: 'integer', minimum: 1 } },
      { name: 'category', description: 'One category', schema: { type: 'string', enum: TEMPLATE_CATEGORIES.map((c) => c.id) } },
      { name: 'source', description: 'Only templates from here', schema: { type: 'string', enum: ['builtin', 'local', 'remote'] } },
    ],
    responses: {
      200: reply(
        'The matches, and whether remote templates are on',
        object(
          {
            templates: array(ref('TemplateSummary')),
            remote: object(
              { enabled: { type: 'boolean' }, label: { type: 'string' }, error: { type: 'string' }, page: { type: 'integer' }, total: { type: 'integer' }, hasMore: { type: 'boolean' } },
              ['enabled'],
            ),
          },
          ['templates', 'remote'],
        ),
      ),
      400: invalid,
      404: notFound,
    },
  });
  add('post', '/api/templates', {
    tag: 'Templates',
    id: 'saveTemplate',
    summary: 'Save a workflow as a template, or import a template file',
    description:
      'Credentials become slots (never their ids) and pinned data, publication state, folder and tags are left out. `{ data }` imports what `?format=file` exported. `projectId`: the project it belongs to (the caller edits there); `null`: instance-wide (owners and admins).',
    body: jsonBody({ oneOf: [fromZod(saveTemplateSchema), object({ data: ref('TemplateFile'), projectId: { type: ['string', 'null'] } }, ['data'])] }),
    responses: { 201: templateReply('The saved template'), 400: invalid, 403: errorRef('The caller can’t save templates there') },
  });
  add('get', '/api/templates/{id}', {
    tag: 'Templates',
    id: 'getTemplate',
    summary: 'Get a template',
    query: [{ name: 'format', description: '`file`: download it as a template file to import elsewhere', schema: { type: 'string', enum: ['file'] } }],
    responses: { 200: templateReply('The template (or, with `format=file`, a TemplateFile)'), 404: notFound, 502: errorRef('The remote templates API failed') },
  });
  add('patch', '/api/templates/{id}', {
    tag: 'Templates',
    id: 'updateTemplate',
    summary: 'Edit a saved template',
    description: 'Name, description, categories, setup steps or project; `workflowId` replaces its workflow with that saved workflow’s (credentials become slots, pinned data is left out).',
    body: jsonBody(fromZod(updateTemplateSchema)),
    responses: { 200: templateReply('The template'), 400: invalid, 403: errorRef('The caller can’t edit it'), 404: notFound },
  });
  add('delete', '/api/templates/{id}', {
    tag: 'Templates',
    id: 'deleteTemplate',
    summary: 'Delete a saved template',
    description: 'Built-in and remote templates can’t be deleted.',
    responses: { 200: reply('Deleted', ok), 400: invalid, 404: notFound },
  });
  // ---- runbooks from Landfall rooms (docs/runbooks.md) ----
  const runbookStep = object({ title: { type: 'string' }, approval: { type: 'boolean' }, reason: { type: 'string' }, notes: array({ type: 'string' }), source: { type: 'object' } }, ['title', 'approval', 'notes']);
  const runbook = object({ id: { type: 'string' }, name: { type: 'string' }, alertKind: { type: 'string' }, room: { type: 'string' }, steps: { type: 'integer' }, approvals: { type: 'integer' }, published: { type: 'boolean' }, updatedAt: { type: 'string' }, url: { type: 'string' }, match: { type: 'string', enum: ['exact', 'similar', 'all'] } }, ['id', 'name', 'alertKind', 'url']);
  add('get', '/api/runbooks', {
    tag: 'Runbooks',
    id: 'listRunbooks',
    summary: 'List runbooks',
    description: 'Workflows tagged `runbook` that you can see. With `kind` (an alert title, alertname or kind slug): the ones for that kind, exact before similar, published before draft.',
    query: [{ name: 'kind', description: 'An alert kind', schema: { type: 'string' } }, { name: 'projectId', description: 'Only this project', schema: { type: 'string' } }],
    responses: { 200: reply('The runbooks', object({ runbooks: array(runbook) }, ['runbooks'])) },
  });
  add('post', '/api/runbooks', {
    tag: 'Runbooks',
    id: 'saveRunbook',
    summary: 'Save reviewed steps as a draft runbook',
    description: 'Makes a workflow (not active) in `?projectId=` or your personal project: a form wait per step, and an approval form, If and Stop and Error before a step with `approval: true`. Tagged `runbook` and `alert-kind:<slug>`.',
    body: jsonBody(object({ name: { type: 'string' }, alertKind: { type: 'string' }, description: { type: 'string' }, room: { type: 'string' }, steps: array(runbookStep), background: { type: 'object' }, folderId: { type: 'string' } }, ['name', 'alertKind', 'steps'])),
    responses: { 201: reply('The draft workflow', object({ workflow: ref('Workflow'), runbook }, ['workflow', 'runbook'])), 400: invalid },
  });
  add('post', '/api/runbooks/draft', {
    tag: 'Runbooks',
    id: 'draftRunbook',
    summary: 'Fold a closed Landfall room into runbook steps',
    description: 'Nothing is saved. `room` is `{ incident, events, outcome? }` (the Landfall node’s Get Room output, plus a Room outcomes row). One step per applied remediation, in order; a step needs approval when the responders marked it risky, it names production, or it uses a changing word. 422 when there is nothing to fold.',
    body: jsonBody(object({ room: { type: 'object' }, alertKind: { type: 'string' }, name: { type: 'string' } }, ['room'])),
    responses: { 200: reply('The draft', object({ draft: object({ name: { type: 'string' }, alertKind: { type: 'string' }, description: { type: 'string' }, room: { type: 'string' }, steps: array(runbookStep), skipped: array({ type: 'string' }), background: { type: 'object' } }, ['name', 'alertKind', 'steps']), existing: array(runbook) }, ['draft'])), 400: invalid, 422: errorRef('Nothing to fold') },
  });
  // ---- composite types (docs/composites.md) ----
  const compositeInfo = object(
    {
      type: { type: 'string', description: 'Fully qualified: `triage.aiTriage`, or `local.<name>` for the library saved here' },
      source: { type: 'object', description: '`{ kind: "plugin", pluginId, pluginName }` or `{ kind: "local", createdBy?, updatedAt }`' },
      descriptor: { type: 'object', description: 'The newest version: a CompositeTypeDescriptor (docs/protocol.md)' },
      versions: array({ type: 'integer' }),
      all: array({ type: 'object' }),
      available: { type: 'boolean', description: 'Plugin types: the plugin is online' },
    },
    ['type', 'source', 'descriptor', 'versions', 'available'],
  );
  add('get', '/api/composites', {
    tag: 'Templates',
    id: 'listComposites',
    summary: 'List composite types',
    description: 'The plugins’ (core’s included) and the library saved on this instance. `all` holds every version’s descriptor when there are several.',
    responses: { 200: reply('The composite types', object({ composites: array(compositeInfo) }, ['composites'])) },
  });
  add('post', '/api/composites', {
    tag: 'Templates',
    id: 'saveComposite',
    summary: 'Save a composite type to the library',
    description: 'Saved as `local.<name>`; a name already saved gets the next version, so frames built for the older one keep it.',
    body: jsonBody(object({ descriptor: { type: 'object', description: 'A CompositeTypeDescriptor' } }, ['descriptor'])),
    responses: { 201: reply('The saved type', object({ composite: compositeInfo }, ['composite'])), 400: invalid },
  });
  add('delete', '/api/composites/{type}', {
    tag: 'Templates',
    id: 'deleteComposite',
    summary: 'Delete a library composite type',
    description: 'Every version of a `local.<name>` type: whoever saved it, or an owner or admin. Frames typed by it keep their nodes.',
    responses: { 200: reply('Deleted', ok), 400: invalid, 403: errorRef('Someone else saved it'), 404: notFound },
  });
  add('post', '/api/templates/{id}/use', {
    tag: 'Templates',
    id: 'useTemplate',
    summary: 'Create a workflow from a template',
    description: 'Each credential slot gets the saved credential picked for it (of the slot’s type); missing data tables are created and URL paths made unique. Saved as an inactive draft. A team template (`team` in its summary) first creates its agents and its team in the same project with fresh ids (published again if they were), rewrites the member, Run a Team and Run an Agent references, then creates the workflow if it has one; the answer then has `team` and `agents` and `workflow` may be absent.',
    body: jsonBody(
      object({
        name: { type: 'string', maxLength: 200 },
        teamName: { type: 'string', maxLength: 200, description: 'A team template: the new team’s name' },
        folderId: { type: 'string' },
        credentials: { type: 'object', description: 'Slot id → credential id (null or left out: none yet)', additionalProperties: { type: ['string', 'null'] } },
      }),
      undefined,
      false,
    ),
    responses: {
      201: reply(
        'The new workflow',
        object({ workflow: ref('Workflow'), createdTables: array({ type: 'string' }), warnings: array({ type: 'string' }), report: ref('ImportReport') }, ['workflow', 'createdTables', 'warnings']),
      ),
      400: invalid,
      404: notFound,
      409: errorRef('The template uses node types that are missing or blocked here (`problems`)'),
    },
  });

  // ---- audit and publish requests ----
  const auditQuery = [
    { name: 'actor', description: 'A user id, or part of a name or email', schema: { type: 'string' } },
    { name: 'action', description: 'Comma-separated actions (`workflow.publish`); `workflow.*` for a category', schema: { type: 'string' } },
    { name: 'targetType', description: 'workflow, credential, user, api_key, settings, execution…', schema: { type: 'string' } },
    { name: 'targetId', description: 'The target’s id', schema: { type: 'string' } },
    { name: 'projectId', description: 'The project of the event’s target (a workflow, credential, data table or agent’s home project, or the project itself)', schema: { type: 'string' } },
    { name: 'outcome', description: 'success, failure or denied', schema: { type: 'string', enum: ['success', 'failure', 'denied'] } },
    { name: 'from', description: 'From this time (ISO time or date), inclusive', schema: { type: 'string' } },
    { name: 'to', description: 'Up to this time (ISO time or date), inclusive', schema: { type: 'string' } },
    { name: 'q', description: 'Text in the summary or the target’s name', schema: { type: 'string' } },
  ];
  const auditEvent = object(
    {
      id: { type: 'string' },
      at: { type: 'string', format: 'date-time' },
      action: { type: 'string' },
      category: { type: 'string' },
      outcome: { type: 'string', enum: ['success', 'failure', 'denied'] },
      actor: object({ type: { type: 'string', enum: ['user', 'api_key', 'system', 'anonymous'] }, id: { type: 'string' }, name: { type: 'string' }, email: { type: 'string' } }, ['type']),
      apiKeyId: { type: 'string' },
      ip: { type: 'string' },
      userAgent: { type: 'string' },
      requestId: { type: 'string' },
      method: { type: 'string' },
      route: { type: 'string', description: 'The route pattern, never the raw URL' },
      status: { type: 'integer' },
      target: object({ type: { type: 'string' }, id: { type: 'string' }, name: { type: 'string' } }, ['type']),
      projectId: { type: 'string', description: 'The project of the target; none for instance-wide targets (users, API keys, settings)' },
      summary: { type: 'string' },
      details: { type: 'object', description: 'Flat ids, names, counts and flags; never secrets', additionalProperties: true },
      chain: object(
        {
          seq: { type: 'integer', description: 'Position in the hash chain' },
          prevHash: { type: 'string', description: 'The hash of the event before (SHA-256, hex)' },
          hash: { type: 'string', description: 'SHA-256 over the event’s canonical stored fields and `prevHash`' },
        },
        ['seq', 'prevHash', 'hash'],
      ),
    },
    ['id', 'at', 'action', 'category', 'outcome', 'actor', 'summary'],
  );
  const chainPoint = object({ seq: { type: 'integer' }, hash: { type: 'string' }, eventId: { type: 'string' }, at: { type: 'string', format: 'date-time' } }, ['seq', 'hash']);
  const chainProblem = object({ seq: { type: 'integer' }, eventId: { type: 'string' }, at: { type: 'string', format: 'date-time' }, reason: { type: 'string' } }, ['reason']);
  add('get', '/api/audit', {
    tag: 'Audit',
    id: 'listAuditEvents',
    summary: 'List audit events',
    description: 'Newest first; page with `cursor` (the previous page’s `nextCursor`). Owners and admins read every event; anyone else the events of the projects they are an admin of (403 for `projectId` of another project).',
    query: [
      ...auditQuery,
      { name: 'limit', description: 'At most this many (default 50)', schema: { type: 'integer', minimum: 1, maximum: 500, default: 50 } },
      { name: 'cursor', description: 'The previous page’s `nextCursor`', schema: { type: 'string' } },
    ],
    responses: { 200: reply('A page of events', object({ events: array(auditEvent), nextCursor: { type: 'string' } }, ['events'])) },
  });
  add('get', '/api/audit/export', {
    tag: 'Audit',
    id: 'exportAuditEvents',
    summary: 'Export audit events',
    description: 'The events matching the same filters, newest first, as a CSV or JSON download (at most 100,000). The export is audited too.',
    query: [...auditQuery, { name: 'format', description: 'csv (default) or json', schema: { type: 'string', enum: ['csv', 'json'], default: 'csv' } }],
    responses: { 200: { description: 'The download', content: { 'text/csv': { schema: { type: 'string' } }, 'application/json': { schema: array(auditEvent) } } } },
  });
  add('get', '/api/audit/verify', {
    tag: 'Audit',
    id: 'verifyAuditChain',
    summary: 'Verify the audit log’s hash chain',
    description:
      'Recomputes every event’s hash from its stored fields and checks each link to the event before it, that none is missing and that the newest matches the head record. Pruned events leave an anchor (the hash of the last one pruned), so the rest still verifies. The check is audited (`audit.verify`, a failure when the chain is broken).',
    responses: {
      200: reply(
        'The report',
        object(
          {
            ok: { type: 'boolean' },
            checked: { type: 'integer', description: 'Events checked' },
            firstSeq: { type: 'integer' },
            lastSeq: { type: 'integer' },
            head: { ...chainPoint, description: 'The newest chained event, as the chain’s head record has it' },
            anchor: { ...chainPoint, description: 'The last event retention pruned: the chain goes on from its hash' },
            pending: { type: 'integer', description: 'Events not chained yet (queue mode on Postgres chains them within seconds)' },
            legacy: { type: 'integer', description: 'Events recorded before the chain existed (not covered)' },
            brokenAt: chainProblem,
            problems: array(chainProblem),
            verifiedAt: { type: 'string', format: 'date-time' },
          },
          ['ok', 'checked', 'problems', 'verifiedAt'],
        ),
      ),
    },
  });
  const signedHead = object(
    {
      format: { type: 'string', enum: ['landflow.audit.head/1'] },
      payload: { type: 'string', description: 'The exact JSON text that was signed: `{ format, seq, hash, eventId?, at?, signedAt, keyId, instance? }`' },
      algorithm: { type: 'string', enum: ['Ed25519'] },
      keyId: { type: 'string', description: 'First 16 hex characters of the SHA-256 of the public key (SPKI DER)' },
      signature: { type: 'string', description: 'Base64 Ed25519 signature of the payload’s UTF-8 bytes' },
      publicKey: { type: 'string', description: 'SPKI PEM; verifiers pin the key they trust instead of relying on this one' },
    },
    ['format', 'payload', 'algorithm', 'keyId', 'signature', 'publicKey'],
  );
  add('get', '/api/audit/head', {
    tag: 'Audit',
    id: 'getAuditHead',
    summary: 'The audit chain’s newest signed head',
    description:
      'The chain’s newest link (sequence number and hash) signed with an Ed25519 key, and the public keys that ever signed. The leader signs on a schedule (Settings → Audit log → Integrity) after verifying the whole chain; copies are anchored to an S3 bucket or a webhook. `landflow audit verify --head <file> --public-key <pem>` checks the signature offline. `head` is null before the first signature.',
    responses: {
      200: reply(
        'The head and keys',
        object({ head: { ...signedHead, nullable: true }, signedAt: { type: 'string', format: 'date-time' }, anchoredAt: { type: 'string', format: 'date-time' }, keys: array(object({ keyId: { type: 'string' }, publicKey: { type: 'string' }, createdAt: { type: 'string', format: 'date-time' } }, ['keyId', 'publicKey', 'createdAt'])) }, ['head', 'keys']),
      ),
    },
  });
  add('post', '/api/settings/audit/anchoring/run', {
    tag: 'Audit',
    id: 'signAuditHead',
    summary: 'Sign the audit chain’s head now and anchor it',
    description: 'Verifies the whole chain, signs its newest link (a new signature only when the chain moved) and copies unanchored heads to the configured S3 bucket and webhook. 409 when the chain is broken (nothing is signed) or has no events. Audited as `audit.sign_head`.',
    responses: { 200: reply('The signed head', object({ head: signedHead, signedAt: { type: 'string', format: 'date-time' }, created: { type: 'boolean' }, anchored: { type: 'boolean' }, anchoredAt: { type: 'string', nullable: true }, anchorError: { type: 'string', nullable: true } }, ['head', 'created'])) },
  });
  const publishRequest = object(
    {
      id: { type: 'string' },
      workflowId: { type: 'string' },
      workflowName: { type: 'string' },
      kind: { type: 'string', enum: ['publish', 'rollback', 'unpublish'] },
      status: { type: 'string', enum: ['pending', 'approved', 'rejected', 'canceled', 'stale', 'failed'] },
      versionId: { type: 'string' },
      versionNumber: { type: 'integer' },
      note: { type: 'string' },
      requestedBy: { type: 'string' },
      requestedAt: { type: 'string', format: 'date-time' },
      decidedBy: { type: 'string' },
      decidedAt: { type: 'string', format: 'date-time' },
      reason: { type: 'string' },
      canApprove: { type: 'boolean' },
      canCancel: { type: 'boolean' },
    },
    ['id', 'workflowId', 'kind', 'status', 'requestedBy', 'requestedAt'],
  );
  add('get', '/api/publish-requests', {
    tag: 'Audit',
    id: 'listPublishRequests',
    summary: 'List four-eyes publish requests',
    description: 'With four-eyes publishing on (Settings → Governance), publish, rollback and unpublish answer 202 `{ approvalRequired: true, request }` and someone else approves.',
    query: [
      { name: 'workflowId', description: 'Only this workflow’s', schema: { type: 'string' } },
      { name: 'status', description: 'Comma-separated statuses, or `all` (default: pending)', schema: { type: 'string' } },
    ],
    responses: { 200: reply('The requests', object({ requests: array(publishRequest), approvable: { type: 'integer' } }, ['requests'])) },
  });
  add('post', '/api/publish-requests/{id}/approve', {
    tag: 'Audit',
    id: 'approvePublishRequest',
    summary: 'Approve a publish request',
    description: 'Publishes (or unpublishes) it. Not the requester’s own; 409 when it went stale or was decided.',
    body: jsonBody(object({ comment: { type: 'string', maxLength: 2000 } }), undefined, false),
    responses: { 200: reply('The request and the publication', object({ request: publishRequest, result: { type: 'object' } }, ['request'])), 404: notFound, 409: errorRef('Out of date or already decided') },
  });
  add('post', '/api/publish-requests/{id}/reject', {
    tag: 'Audit',
    id: 'rejectPublishRequest',
    summary: 'Reject a publish request',
    body: jsonBody(object({ comment: { type: 'string', maxLength: 2000 } }), undefined, false),
    responses: { 200: reply('The request', object({ request: publishRequest }, ['request'])), 404: notFound, 409: errorRef('Already decided') },
  });
  const scheduledPublish = object(
    {
      id: { type: 'string' },
      workflowId: { type: 'string' },
      action: { type: 'string', enum: ['publish', 'unpublish'] },
      versionId: { type: 'string' },
      versionNumber: { type: 'integer' },
      runAt: { type: 'string', format: 'date-time' },
      status: { type: 'string', enum: ['awaiting_approval', 'pending', 'running', 'done', 'requested', 'failed', 'canceled'] },
      note: { type: 'string' },
      requestId: { type: 'string', description: 'The four-eyes publish request that approves it' },
      result: { type: 'string' },
    },
    ['id', 'workflowId', 'action', 'runAt', 'status'],
  );
  add('get', '/api/workflows/{id}/schedules', {
    tag: 'Workflows',
    id: 'listScheduledPublishes',
    summary: 'List a workflow’s scheduled publishes',
    description: 'Waiting ones first, then the recent ones that ran, failed or were canceled.',
    responses: { 200: reply('The schedules', object({ schedules: array(scheduledPublish) }, ['schedules'])), 404: notFound },
  });
  add('post', '/api/workflows/{id}/schedules', {
    tag: 'Workflows',
    id: 'schedulePublish',
    summary: 'Publish or unpublish at a chosen time',
    description:
      'Same as `at` on `POST /api/workflows/{id}/publish` and `/unpublish`. The leader (queue mode) or the host runs it through the one publish code, so governance and the audit log apply. With four-eyes publishing on, a publish request is filed and its approval releases the schedule, which goes live at `at`.',
    body: jsonBody(
      object({ action: { type: 'string', enum: ['publish', 'unpublish'] }, at: { type: 'string', format: 'date-time', description: 'ISO 8601, in the future (at most a year ahead)' }, versionId: { type: 'string', description: 'The saved version to publish (default: the saved draft)' }, note: { type: 'string', maxLength: 2000 } }, ['action', 'at']),
    ),
    responses: { 201: reply('The schedule', object({ scheduled: scheduledPublish }, ['scheduled'])), 404: notFound, 422: errorRef('Nodes the governance policy does not allow') },
  });
  add('get', '/api/workflows/{id}/git-history', {
    tag: 'Workflows',
    id: 'workflowGitHistory',
    summary: 'The Git commits that touched a workflow’s file',
    description: 'Settings → Source control’s branch, fetched first. `GET …/git-history/{commit}?path=` is one commit’s diff; `POST …/git-history/{commit}/restore { path }` saves that version as a new draft (nothing is published).',
    responses: { 200: reply('The commits, newest first', object({ branch: { type: 'string' }, path: { type: 'string' }, commits: array(object({ commit: { type: 'string' }, author: { type: 'string' }, at: { type: 'string' }, subject: { type: 'string' }, path: { type: 'string' } })) }, ['branch', 'commits'])), 404: notFound, 409: errorRef('Source control is not set up') },
  });
  add('post', '/api/source-control/host-keys', {
    tag: 'Workflows',
    id: 'scanSshHostKeys',
    summary: 'Fetch an SSH server’s host keys to pin',
    body: jsonBody(object({ repository: { type: 'string' } }, ['repository'])),
    responses: { 200: reply('Keys with SHA256 fingerprints and the known_hosts text', object({ host: { type: 'string' }, port: { type: 'integer' }, knownHosts: { type: 'string' }, keys: array(object({ type: { type: 'string' }, fingerprint: { type: 'string' } })) }, ['knownHosts'])) },
  });
  add('delete', '/api/workflows/{id}/schedules/{scheduleId}', {
    tag: 'Workflows',
    id: 'cancelScheduledPublish',
    summary: 'Cancel a scheduled publish',
    description: 'Who scheduled it, or an owner or admin. Withdraws its approval request. 409 once it ran.',
    responses: { 200: reply('The canceled schedule', object({ scheduled: scheduledPublish }, ['scheduled'])), 403: errorRef('Not allowed'), 404: notFound, 409: errorRef('Already ran or canceled') },
  });

  // ---- trigger URLs (public: each trigger checks its callers) and listening for test events ----
  const triggerPath = { path: 'The trigger’s path, as set on the node (it may contain slashes)' };
  const anyBody = (description: string) => ({
    required: false,
    description,
    content: { 'application/json': { schema: {} }, 'application/x-www-form-urlencoded': { schema: {} }, 'multipart/form-data': { schema: {} }, '*/*': { schema: {} } },
  });
  const anyReply = (description: string) => ({ description, content: { 'application/json': { schema: {} }, '*/*': { schema: {} } } });
  const triggerRefused = { 401: errorRef('The trigger’s authentication failed (`WWW-Authenticate` says how to send it)'), 403: errorRef('Not allowed: wrong Header Auth secret, an address outside the IP allow-list, or the trigger’s credential isn’t available to its workflow’s project') };
  const webhookResponses = (miss: string) => ({
    200: anyReply('The Respond setting’s answer: the last node’s output, a Respond to Webhook reply, `{ status: "waiting" }`, or a stream (SSE or NDJSON)'),
    202: reply('Started (Respond: Immediately), or held by debounce or batching', object({ status: { type: 'string' }, workflowId: { type: 'string' }, executionId: { type: 'string' } }, [], { additionalProperties: true })),
    ...triggerRefused,
    404: errorRef(miss),
    413: errorRef('An upload is larger than LANDFLOW_BINARY_MAX_BYTES'),
    500: errorRef('The run failed, or the trigger isn’t set up correctly'),
  });
  const webhookMethods: Array<[Method, string]> = [
    ['get', 'Get'],
    ['post', 'Post'],
    ['put', 'Put'],
    ['patch', 'Patch'],
    ['delete', 'Delete'],
  ];
  for (const [method, name] of webhookMethods) {
    add(method, '/api/webhook/{path}', {
      tag: 'Triggers',
      id: `callWebhook${name}`,
      summary: `Call a Webhook trigger (${method.toUpperCase()})`,
      description: 'Runs the published version of the workflow whose Webhook trigger has this path and method. Headers, query and body (JSON, form fields, files as `binary`) become the trigger’s item. An `Idempotency-Key` header makes a retry safe.',
      public: true,
      pathParams: triggerPath,
      headers: [idempotencyHeader],
      ...(method !== 'get' && { body: anyBody('Any body: JSON, form fields, multipart files, or raw bytes') }),
      responses: { ...webhookResponses('No published workflow listens on this method and path'), 429: errorRef('The workflow is at its concurrency limit and skips runs') },
    });
    add(method, '/api/webhook-test/{path}', {
      tag: 'Triggers',
      id: `callTestWebhook${name}`,
      summary: `Call a Webhook trigger’s test URL (${method.toUpperCase()})`,
      description: 'Answers one call while the editor listens for the trigger (POST /api/workflows/{id}/listen) and runs the workflow the editor sent, as a manual run the editor shows live.',
      public: true,
      pathParams: triggerPath,
      ...(method !== 'get' && { body: anyBody('Any body, as on the production URL') }),
      responses: webhookResponses('No editor is listening on this method and path (`hint` says how to start)'),
    });
  }
  const formPage = (description: string) => ({ description, content: { 'text/html': { schema: { type: 'string' } } } });
  const formBody = {
    required: true,
    description: 'The form’s fields (`f0`, `f1`, … in field order); files as multipart parts',
    content: { 'application/x-www-form-urlencoded': { schema: { type: 'object', additionalProperties: true } }, 'multipart/form-data': { schema: { type: 'object', additionalProperties: true } } },
  };
  const formResponses = {
    200: formPage('The end screen, or the form again with what is wrong (400)'),
    303: { description: 'The next page of a multi-page form (`Location: /form/waiting/<executionId>`)' },
    400: formPage('Some fields are missing or invalid: the form again, with the errors'),
    401: formPage('Sign-in required (Basic Auth, with `WWW-Authenticate`)'),
    403: formPage('Not allowed (Header or JWT Auth, the IP allow-list, or a credential outside the workflow’s project)'),
    404: formPage('No such form'),
    413: formPage('An upload is too large'),
  };
  for (const [prefix, test] of [
    ['/form', false],
    ['/form-test', true],
  ] as const) {
    const where = test ? 'while the editor listens for the trigger (the workflow as the editor sent it, as a manual run)' : 'of the published workflow whose On Form Submission trigger has this path';
    add('get', `${prefix}/{path}`, {
      tag: 'Triggers',
      id: test ? 'showTestForm' : 'showForm',
      summary: test ? 'Show a test form' : 'Show a hosted form',
      description: `The HTML form ${where}.`,
      public: true,
      pathParams: triggerPath,
      responses: { 200: formPage('The form'), 401: formResponses[401], 403: formResponses[403], 404: formResponses[404] },
    });
    add('post', `${prefix}/{path}`, {
      tag: 'Triggers',
      id: test ? 'submitTestForm' : 'submitForm',
      summary: test ? 'Submit a test form' : 'Submit a hosted form',
      description: `Submits the form ${where}: the fields become the trigger’s item (\`formMode\`: \`${test ? 'test' : 'production'}\`).`,
      public: true,
      pathParams: triggerPath,
      ...(!test && { headers: [idempotencyHeader] }),
      body: formBody,
      responses: { ...formResponses, ...(test ? { 409: formPage('Already submitted: its test run is going on') } : { 429: formPage('The workflow is at its concurrency limit and skips runs') }) },
    });
  }
  const jsonRpc = { type: 'object', description: 'A JSON-RPC 2.0 message (initialize, tools/list, tools/call, …)', additionalProperties: true };
  for (const [prefix, test] of [
    ['/mcp', false],
    ['/mcp-test', true],
  ] as const) {
    add('post', `${prefix}/{path}`, {
      tag: 'Triggers',
      id: test ? 'callTestMcpTrigger' : 'callMcpTrigger',
      summary: test ? 'Talk to an MCP Server Trigger’s test URL' : 'Talk to an MCP Server Trigger',
      description: test
        ? 'MCP over Streamable HTTP (stateless, JSON responses) while the editor listens for the trigger: the tools of the workflow the editor sent; each tools/call is a manual run the editor shows live. Each request keeps it listening 120 s longer.'
        : 'MCP over Streamable HTTP (stateless, JSON responses): the tools attached to the published workflow’s MCP Server Trigger. tools/list isn’t recorded; each tools/call is an execution with mode `mcp`.',
      public: true,
      pathParams: triggerPath,
      body: jsonBody(jsonRpc),
      responses: {
        200: reply('The JSON-RPC response', jsonRpc),
        401: reply('The trigger’s Bearer or Header Auth failed', jsonRpc),
        403: reply('The trigger’s credential isn’t available to its workflow’s project', jsonRpc),
        404: reply(test ? 'No editor is listening on this path' : 'No published workflow serves this path', jsonRpc),
      },
    });
  }
  add('post', '/api/workflows/{id}/listen', {
    tag: 'Workflows',
    id: 'listenForTestEvent',
    summary: 'Listen for a test event on a trigger’s test URL',
    description:
      'Makes the test URL of a Webhook, On Form Submission or MCP Server trigger (/api/webhook-test/{path}, /form-test/{path}, /mcp-test/{path}) answer for 120 s, running `workflow` (unsaved changes included; default: the saved one) as manual runs. Server-Sent Events: `listening` `{ listenerId, nodeId, kind, method?, path, executionId, expiresAt, timeoutMs }`, then the test run’s `execution` events and its `result` `{ executionId, status, error? }`; or `timeout`, or `stopped` when the trigger listens again elsewhere. An MCP listener takes many calls (a `result` per tool call, `listening` again with the pushed-on deadline). Closing the request stops listening and stops a run that is still going.',
    body: jsonBody(object({ nodeId: { type: 'string', minLength: 1, description: 'The trigger node’s id' }, workflow: { ...ref('WorkflowInput'), description: 'Listen with this (unsaved) version' } }, ['nodeId'])),
    responses: {
      200: reply('The listening stream', { type: 'string', description: '`event: <name>` and `data: <JSON>` lines' }, 'text/event-stream'),
      400: errorRef('That node has no test URL (not such a trigger, disabled, or without a path)'),
      404: notFound,
      409: errorRef('Another workflow is listening on that test URL'),
    },
  });

  // ---- account ----
  add('get', '/api/auth/me', {
    tag: 'Account',
    id: 'whoAmI',
    summary: 'Who is calling',
    description: 'The user, and whether the call came with a session or an API key (with its scopes).',
    responses: {
      200: reply(
        'The caller',
        object({ user: ref('Viewer'), via: { type: 'string', enum: ['session', 'api-key'] }, apiKey: object({ id: { type: 'string' }, scopes: array(ref('ApiKeyScope')) }) }, ['user', 'via']),
      ),
    },
  });
  add('patch', '/api/auth/me', {
    tag: 'Account',
    id: 'updateMe',
    summary: 'Rename yourself or change your password',
    body: jsonBody(object({ name: { type: 'string', minLength: 1, maxLength: 120 }, currentPassword: { type: 'string' }, newPassword: { type: 'string', minLength: 8, maxLength: 256 } })),
    responses: { 200: reply('You', object({ user: ref('Viewer') }, ['user'])), 400: invalid },
  });
  add('get', '/api/api-keys', { tag: 'Account', id: 'listApiKeys', summary: 'List your API keys', responses: { 200: reply('Your keys (never the keys themselves)', object({ keys: array(ref('ApiKey')) }, ['keys'])) } });
  add('post', '/api/api-keys', {
    tag: 'Account',
    id: 'createApiKey',
    summary: 'Create an API key',
    description: 'The key (`lf_…`) comes back once, as `token`. Only owners and admins create keys with the `admin` scope.',
    body: jsonBody(
      object(
        { label: { type: 'string', minLength: 1, maxLength: 100 }, scopes: { ...array(ref('ApiKeyScope')), minItems: 1 }, expiresInDays: { type: 'integer', minimum: 1, maximum: 3650, description: 'None: never expires' } },
        ['label', 'scopes'],
      ),
    ),
    responses: { 201: reply('The key, shown once', object({ key: ref('ApiKey'), token: { type: 'string', description: 'lf_…' } }, ['key', 'token'])), 400: invalid },
  });
  add('delete', '/api/api-keys/{id}', { tag: 'Account', id: 'deleteApiKey', summary: 'Revoke an API key', description: 'It stops working at once.', responses: { 200: reply('Revoked', ok), 404: notFound } });

  // ---- plugins and transports (docs/transports.md) ----
  const pluginsReply = reply('Every plugin: its endpoints by transport, its transport policy, and the transport the next call takes with the reason', object({ plugins: array(ref('Plugin')) }, ['plugins']));
  add('get', '/api/plugins', { tag: 'Plugins', id: 'listPlugins', summary: 'List plugins', responses: { 200: pluginsReply } });
  add('patch', '/api/plugins/{id}', {
    tag: 'Plugins',
    id: 'updatePluginTransport',
    summary: 'Set a plugin’s transport policy',
    description:
      'Auto (the host chooses per call), pinned to one transport, or limited to an allow-list; `objective` is Auto’s goal. The older `preferredTransport` body still works: a transport pins the policy to it, `null` is Auto. `mcp.exposed` is "Expose to agents": whether the plugin’s tools are served at /api/mcp/plugins/{id} and registered in the MCP gateway (on by default).',
    body: jsonBody(
      object({
        policy: ref('TransportPolicy'),
        preferredTransport: { type: ['string', 'null'], description: 'Older clients: `http`, `grpc` or a broker kind; null for Auto' },
        mcp: object({ exposed: { type: 'boolean' } }, ['exposed']),
      }),
    ),
    responses: { 200: pluginsReply, 400: invalid, 404: notFound },
  });
  // ---- MCP: the per-plugin endpoints and the tool browser (docs/protocol.md §15.3; lib/server/mcp/plugin-servers.ts) ----
  add('post', '/api/mcp/plugins/{id}', {
    tag: 'MCP',
    id: 'callPluginMcp',
    summary: 'Talk to a plugin’s MCP endpoint',
    description:
      'MCP over Streamable HTTP, stateless, for 2026-07-28 clients (`server/discover`, the `_meta` envelope, `subscriptions/listen`) and 2025-xx clients (`initialize`; JSON responses; GET and DELETE answer 405). `core` is the host’s built-in nodes. One tool per node operation, from the plugin’s manifest; `tools/list` is filtered by the caller’s grants, each `tools/call` runs as an execution with mode `mcp` and is audited (`mcp.tool.call`). Callers: the bundled gateway (`x-landflow-gateway` plus the caller headers it sets), a Landflow MCP token, an identity provider token, an API key or a session.',
    public: true,
    pathParams: { id: 'The plugin id, or `core`' },
    body: jsonBody(jsonRpc),
    responses: {
      200: reply('The JSON-RPC response', jsonRpc),
      401: reply('No acceptable credential (`WWW-Authenticate` names the protected resource metadata)', jsonRpc),
      404: reply('The plugin is not installed or not exposed to agents', jsonRpc),
    },
  });
  add('post', '/api/mcp/projects/{id}', {
    tag: 'MCP',
    id: 'callProjectMcp',
    summary: 'Talk to one project’s MCP server',
    description:
      'The instance MCP server (`/api/mcp`: build, validate and run workflows) scoped to one project: it lists, reads, changes and runs only that project’s workflows and creates new ones in it. Off while the instance server is off (Settings → MCP). Callers: the instance access token, a Landflow MCP token (one scoped to another project gets 403), an identity provider token, an API key, or the bundled gateway.',
    public: true,
    pathParams: { id: 'The project id' },
    body: jsonBody(jsonRpc),
    responses: {
      200: reply('The JSON-RPC response', jsonRpc),
      401: reply('No acceptable credential', jsonRpc),
      403: reply('The server is off, or the token is scoped to another project', jsonRpc),
      404: reply('No such project', jsonRpc),
    },
  });
  add('get', '/api/projects/{id}/mcp', { tag: 'MCP', id: 'getProjectMcp', summary: 'A project’s MCP server', description: 'Where the project’s scoped instance MCP server is served and whether its gateway route is registered.', pathParams: { id: 'The project id' }, responses: { 200: reply('The state', { type: 'object', additionalProperties: true }), 404: notFound } });
  add('patch', '/api/projects/{id}/mcp', { tag: 'MCP', id: 'updateProjectMcp', summary: 'Register a project’s MCP server on the gateway', description: 'Project admins (and instance owners and admins). `gateway: true` makes the gateway sync add `/mcp/projects/<name>` (while the instance server is on).', pathParams: { id: 'The project id' }, body: jsonBody(object({ gateway: { type: 'boolean' } }, ['gateway'])), responses: { 200: reply('The state', { type: 'object', additionalProperties: true }), 400: invalid, 403: errorRef('Not a project admin'), 404: notFound } });
  add('get', '/api/mcp/tools', {
    tag: 'MCP',
    id: 'listMcpTools',
    summary: 'Every MCP tool of the exposed plugins',
    description: 'The tool browser: per tool its plugin, its name on the plugin’s endpoint and on the gateway, title, description, annotations, input and output schema, the node behind it and its credential types. Grants are not applied.',
    responses: { 200: reply('The tools and the exposed plugins', object({ tools: array({ type: 'object' }), plugins: array({ type: 'object' }) }, ['tools', 'plugins'])) },
  });
  // ---- MCP: tokens, grants, the catalog (docs/transports.md "The bundled MCP gateway") ----
  add('get', '/api/mcp/tokens', { tag: 'MCP', id: 'listMcpTokens', summary: 'List your MCP tokens', description: 'Never the tokens themselves. Owners and admins: `?all=1` lists everyone’s.', query: [{ name: 'all', description: '`1`: every user’s tokens (owners and admins)', schema: { type: 'string' } }], responses: { 200: reply('Your tokens', object({ tokens: array(ref('McpToken')) }, ['tokens'])) } });
  add('post', '/api/mcp/tokens', {
    tag: 'MCP',
    id: 'issueMcpToken',
    summary: 'Issue an MCP token',
    description: 'A signed JWT for MCP clients (the gateway or the host’s MCP endpoints), returned once as `token`. Default scopes: all; default expiry: 30 days.',
    body: jsonBody(object({ label: { type: 'string', minLength: 1, maxLength: 100 }, scopes: { ...array(ref('McpTokenScope')), minItems: 1 }, expiresInDays: { type: 'integer', minimum: 1, maximum: 365 }, projectId: { type: 'string', description: 'Scope the token to this project (the instance MCP server)' } }, ['label'])),
    responses: { 201: reply('The token, shown once', object({ token: { type: 'string' }, record: ref('McpToken') }, ['token', 'record'])), 400: invalid },
  });
  add('get', '/api/mcp/tokens/{id}', { tag: 'MCP', id: 'getMcpToken', summary: 'One of your MCP tokens', responses: { 200: reply('The token’s record', object({ record: ref('McpToken') }, ['record'])), 404: notFound } });
  add('delete', '/api/mcp/tokens/{id}', { tag: 'MCP', id: 'revokeMcpToken', summary: 'Revoke an MCP token', description: 'It stops working on the next call (the host checks the `jti`). On a token that is already revoked or expired, deletes its row instead (`purged: true`); rows revoked or expired more than 30 days ago are purged on their own.', responses: { 200: reply('Revoked, or purged', object({ ok: { type: 'boolean' }, purged: { type: 'boolean' }, record: ref('McpToken') }, ['ok', 'purged'])), 404: notFound } });
  add('get', '/api/mcp/gateway', { tag: 'MCP', id: 'getMcpGatewayStatus', summary: 'The MCP gateway sync’s status', description: 'Mode (`bundled`, `file`, `off`), adapter and its location, the gateway’s health, every target and per-plugin route Landflow wants or owns with its state (`in-step`, `drift`, `missing`, `stale`, `unknown`), the last sync and error (lib/server/mcp/gateway-sync.ts).', responses: { 200: reply('The status', { type: 'object', additionalProperties: true }) } });
  add('post', '/api/mcp/gateway/sync', { tag: 'MCP', id: 'syncMcpGateway', summary: 'Resync the MCP gateway now', description: 'Owners and admins. Reconciles the gateway’s targets and routes with the plugin registry at once and answers the status plus `result` `{ changed, upserted, removed, skipped? }`; 409 when the gateway is off, 502 when the gateway could not be written.', responses: { 200: reply('Synced', { type: 'object', additionalProperties: true }), 409: errorRef('The gateway is off'), 502: reply('The gateway could not be written', { type: 'object', additionalProperties: true }) } });
  add('get', '/api/mcp/grants', { tag: 'MCP', id: 'listMcpGrants', summary: 'List tool grants', query: [{ name: 'pluginId', description: 'Only this plugin’s grants', schema: { type: 'string' } }], responses: { 200: reply('The grants', object({ grants: array(ref('McpToolGrant')) }, ['grants'])) } });
  add('post', '/api/mcp/grants', { tag: 'MCP', id: 'createMcpGrant', summary: 'Create a tool grant', description: 'Who (a user, SCIM group, project, role or MCP token) may use which tools of a plugin, and which credential each credential type binds.', body: jsonBody(fromZod(grantCreateSchema)), responses: { 201: reply('Created', object({ grant: ref('McpToolGrant') }, ['grant'])), 400: invalid, 404: notFound } });
  add('get', '/api/mcp/grants/{id}', { tag: 'MCP', id: 'getMcpGrant', summary: 'One tool grant', responses: { 200: reply('The grant', object({ grant: ref('McpToolGrant') }, ['grant'])), 404: notFound } });
  add('patch', '/api/mcp/grants/{id}', { tag: 'MCP', id: 'updateMcpGrant', summary: 'Change a tool grant', body: jsonBody(fromZod(grantPatchSchema)), responses: { 200: reply('Changed', object({ grant: ref('McpToolGrant') }, ['grant'])), 400: invalid, 404: notFound } });
  add('delete', '/api/mcp/grants/{id}', { tag: 'MCP', id: 'deleteMcpGrant', summary: 'Remove a tool grant', responses: { 200: reply('Removed', ok), 404: notFound } });
  add('get', '/api/mcp/approvals', { tag: 'MCP', id: 'listMcpApprovals', summary: 'MCP tool calls waiting for a person', description: 'The approvals of destructive (or, per grant, every) MCP tool calls that the signed-in user may answer: pending ones and the last day’s answers. Calls from clients that support MCP elicitation are asked through the client instead (lib/server/mcp/approvals.ts).', responses: { 200: reply('The approvals', object({ approvals: array({ type: 'object', additionalProperties: true }) }, ['approvals'])) } });
  add('post', '/api/mcp/approvals/{id}', { tag: 'MCP', id: 'decideMcpApproval', summary: 'Approve or deny an MCP tool call', description: 'Owners, admins, the user the agent acts for and members of a project they share. An approval is good for one repeat of the same call (same tool, same arguments, same caller) for ten minutes.', body: jsonBody(object({ approve: { type: 'boolean' } }, ['approve'])), responses: { 200: reply('Answered', object({ approval: { type: 'object', additionalProperties: true } }, ['approval'])), 403: errorRef('Not yours to answer'), 404: notFound, 409: errorRef('Already answered'), 410: errorRef('Expired') } });
  add('get', '/api/mcp/files/{id}', { tag: 'MCP', id: 'downloadMcpFile', summary: 'A file of an MCP tool result', description: 'The target of a `resource_link` in a tool result: a URL the host signed (`exp`, `t`, `c`, `sig` query parameters), valid until `exp` (LANDFLOW_MCP_FILE_URL_TTL_SECONDS, default 900). No session; 403 for a wrong signature, 410 once expired.', public: true, responses: { 200: { description: 'The bytes', content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } }, 403: errorRef('Invalid signature'), 404: notFound, 410: errorRef('Expired') } });
  add('post', '/api/agent-trace/{id}', {
    tag: 'Agents',
    id: 'postAgentTrace',
    summary: 'Report what a remote agent did for one call',
    description: 'Posted by Landflow’s landflow-harness mod inside a Claude Code agent on kagent (docs/a2a.md, “The landflow-harness mod”): each model request’s tokens, model and time, each tool call’s time and outcome, the subagents it started, what the guardrails stopped and the secrets it masked. The id Landflow sent with that call (in the request’s first line) is the only credential. Up to 500 events per post and 5,000 per call; events that don’t parse are skipped.',
    public: true,
    pathParams: { id: 'The trace id from the request’s `<!-- landflow-trace … -->` line' },
    body: jsonBody(object({ events: array({ type: 'object', additionalProperties: true }) }, ['events'])),
    responses: { 202: { description: 'Passed on to the queue-mode process that holds the trace' }, 204: { description: 'Taken' }, 400: invalid, 404: notFound, 410: errorRef('The call has ended: stop posting here'), 413: errorRef('The trace holds all it may') },
  });
  add('get', '/api/agent-trace/{id}/asks/{askId}', {
    tag: 'Agents',
    id: 'getAgentTraceAsk',
    summary: 'A person’s answer to a command a remote agent asked about',
    description: 'Polled by the landflow-harness mod after it posted an `ask` event (a push to main, a force push, deleting a remote branch; docs/a2a.md). `wait` holds the request up to 30 seconds until a person decides. `denied` with `expired` means nobody answered in time or the call ended. The trace id is the only credential.',
    public: true,
    pathParams: { id: 'The trace id from the request’s `<!-- landflow-trace … -->` line', askId: 'The id the mod gave the ask' },
    query: [{ name: 'wait', description: 'Seconds to hold the request while the ask is pending (at most 30)', schema: { type: 'integer', minimum: 0, maximum: 30, default: 0 } }],
    responses: { 200: reply('The answer', object({ decision: { type: 'string', enum: ['pending', 'approved', 'denied'] }, by: { type: 'string' }, at: { type: 'string' }, command: { type: 'string', description: 'Approved with a command a person changed: the mod runs this one instead' }, expired: { type: 'boolean' } }, ['decision'])), 404: notFound },
  });
  add('get', '/api/executions/{id}/asks', {
    tag: 'Executions',
    id: 'listExecutionAsks',
    summary: 'Commands a Claude Code member of the run asks a person about',
    description: 'The open asks of the run: a command its guard lets a person allow (docs/a2a.md). The run is not paused while they wait.',
    pathParams: { id: 'The execution id' },
    responses: { 200: reply('The open asks', object({ asks: array({ type: 'object', additionalProperties: true }) }, ['asks'])), 404: notFound },
  });
  add('post', '/api/executions/{id}/asks/{askId}', {
    tag: 'Executions',
    id: 'decideExecutionAsk',
    summary: 'Approve or reject a command a Claude Code member asked about',
    description: 'Needs the access to the run that deciding its tool approvals needs. The member’s mod polls the decision and runs the command or tells Claude Code a person denied it; the run’s journal gets an Approval check.',
    pathParams: { id: 'The execution id', askId: 'The ask id (`attrs.ask` of the wait, or from the list)' },
    body: jsonBody(object({ approved: { type: 'boolean' }, command: { type: 'string', description: 'The command as a person changed it before allowing it (approvals only): the mod runs it instead, and the journal says it was edited' } }, ['approved'])),
    responses: { 200: reply('Decided', object({ ask: { type: 'object', additionalProperties: true } }, ['ask'])), 400: invalid, 404: notFound, 409: errorRef('Already answered, or nobody answered in time') },
  });
  add('get', '/api/binary/{id}', { tag: 'Executions', id: 'getBinary', summary: 'The bytes of a stored file', description: 'A file of an execution (`item.binary.<name>.id`) with its Content-Type, size and name; `?download=1` makes it an attachment. Plugins send their `binaryAccess` token as a Bearer token. Answers single HTTP `Range` requests (`bytes=a-b`, `a-`, `-n`) with 206 and `Content-Range`, so video and audio can seek; 416 with `Content-Range: bytes */<size>` when unsatisfiable. Multi-range or malformed headers (and any `If-Range`) get the whole file as 200. Every response carries `Accept-Ranges: bytes`. `HEAD` answers the same headers.', query: [{ name: 'download', description: '`1`: Content-Disposition attachment', schema: { type: 'string' } }], headers: [{ name: 'Range', description: 'One byte range: `bytes=0-99`, `bytes=100-`, `bytes=-500`', schema: { type: 'string' } }], responses: { 200: { description: 'The whole file', content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } }, 206: { description: 'The requested part (`Content-Range: bytes a-b/size`)', content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } }, 403: errorRef('The token can’t read that file'), 404: notFound, 416: errorRef('Range not satisfiable (`Content-Range: bytes */size`)') } });
  add('get', '/api/mcp/status', { tag: 'MCP', id: 'mcpStatus', summary: 'The MCP gateway and identity configuration', description: 'What Settings → MCP shows: the gateway mode and URL, whether the gateway secret is set, the identity provider, the registry namespace.', responses: { 200: reply('The configuration', { type: 'object' }) } });
  add('get', '/api/mcp/jwks', { tag: 'MCP', id: 'mcpJwks', summary: 'The JWKS of Landflow-issued MCP tokens', description: 'Public. The gateway (agentgateway) validates Landflow-issued tokens against it.', public: true, responses: { 200: reply('RFC 7517 key set', object({ keys: array({ type: 'object' }) }, ['keys'])) } });
  add('get', '/api/mcp/registry/v0.1/servers', {
    tag: 'MCP',
    id: 'listMcpServers',
    summary: 'The plugin catalog (MCP Registry API v0.1)',
    description: 'Every exposed plugin as an MCP server (server.json). Read-only; for signed-in users, Landflow MCP tokens, identity provider tokens, API keys and the gateway (the route checks them itself).',
    public: true,
    query: [
      { name: 'limit', description: '1–100 (default 30)', schema: { type: 'integer' } },
      { name: 'cursor', description: 'From `metadata.nextCursor`', schema: { type: 'string' } },
      { name: 'search', description: 'Part of a name', schema: { type: 'string' } },
      { name: 'version', description: '`latest`: only the newest version of each server', schema: { type: 'string' } },
      { name: 'updated_since', description: 'ISO time', schema: { type: 'string', format: 'date-time' } },
    ],
    responses: { 200: reply('A page of servers', ref('McpServerList')) },
  });
  add('get', '/api/mcp/registry/v0.1/servers/{name}/versions', { tag: 'MCP', id: 'listMcpServerVersions', summary: 'Every version of one server', public: true, pathParams: { name: 'URL-encoded, e.g. `local.landflow%2Ftwilio`' }, responses: { 200: reply('The versions, newest first', ref('McpServerList')), 404: notFound } });
  add('get', '/api/mcp/registry/v0.1/servers/{name}/versions/{version}', { tag: 'MCP', id: 'getMcpServerVersion', summary: 'One version of a server', public: true, pathParams: { name: 'URL-encoded', version: 'A version, or `latest`' }, responses: { 200: reply('The server', ref('McpServerResponse')), 404: notFound } });

  add('get', '/api/transports', {
    tag: 'Plugins',
    id: 'listTransports',
    summary: 'List transport kinds and broker connections',
    description: 'The kinds this host knows (installed providers with their capabilities, and broker kinds whose driver has not landed yet) and the broker connections with the plugins on each.',
    responses: { 200: reply('Kinds and connections', object({ kinds: array(ref('TransportKind')), connections: array(ref('TransportConnection')), claimStore: object({ configured: { type: 'boolean' }, description: { type: 'string' }, error: { type: 'string' } }, ['configured']) }, ['kinds', 'connections'])) },
  });
  add('get', '/api/transports/connections', { tag: 'Plugins', id: 'listTransportConnections', summary: 'List broker connections', responses: { 200: reply('The connections (no secret values)', object({ connections: array(ref('TransportConnection')) }, ['connections'])) } });
  add('post', '/api/transports/connections', {
    tag: 'Plugins',
    id: 'createTransportConnection',
    summary: 'Add a broker connection',
    description: 'Secret fields (`secrets`) are stored encrypted like credentials and never returned.',
    body: jsonBody(fromZod(connectionCreateSchema)),
    responses: { 201: reply('The connection', ref('TransportConnection')), 400: invalid, 409: errorRef('A connection with that id or name exists') },
  });
  add('get', '/api/transports/connections/{id}', { tag: 'Plugins', id: 'getTransportConnection', summary: 'Get a broker connection', responses: { 200: reply('The connection', ref('TransportConnection')), 404: notFound } });
  add('patch', '/api/transports/connections/{id}', {
    tag: 'Plugins',
    id: 'updateTransportConnection',
    summary: 'Change a broker connection',
    description: 'A secret left empty keeps its value; `null` clears it. Connections from `LANDFLOW_TRANSPORT_<KIND>_URL` are read-only (409).',
    body: jsonBody(fromZod(connectionUpdateSchema)),
    responses: { 200: reply('The connection', ref('TransportConnection')), 400: invalid, 404: notFound, 409: errorRef('Read-only, or the name is taken') },
  });
  add('delete', '/api/transports/connections/{id}', { tag: 'Plugins', id: 'deleteTransportConnection', summary: 'Delete a broker connection', responses: { 200: reply('Deleted', ok), 404: notFound, 409: errorRef('Read-only (from the environment)') } });
  add('post', '/api/transports/connections/{id}/test', {
    tag: 'Plugins',
    id: 'testTransportConnection',
    summary: 'Test a broker connection',
    description: 'A round trip through the kind’s driver. With a body it tests the given values before they are saved. A kind without a driver answers `ok: false`, "No driver for <kind> yet".',
    body: jsonBody(fromZod(connectionTestSchema), 'Values to test instead of the saved ones', false),
    responses: { 200: reply('The result', ref('TransportConnectionCheck')), 404: notFound },
  });

  // The second brain (docs/second-brain.md).
  const text = (name: string, description: string) => ({ name, description, schema: { type: 'string' } });
  const usageQuery = [
    text('kinds', 'Comma-separated kinds, such as node.failed,ai.call (empty: all)'),
    text('from', 'ISO time or YYYY-MM-DD (default 7 days ago)'),
    text('to', 'ISO time or YYYY-MM-DD (default now)'),
    text('workflowId', 'One workflow'),
    text('agentId', 'One agent'),
    text('nodeType', 'One node type'),
    text('signature', 'One failure signature'),
    text('limit', 'At most this many rows'),
  ];
  const proposal = { type: 'object', description: 'A Proposal (lib/shared/brain.ts): target, title, why, evidence, effect, actions (buttons a flow added), decision (the latest), ops or a draft or persona rules, risk, confidence, score, status' };
  add('get', '/api/usage', {
    tag: 'Second brain',
    id: 'usageReport',
    summary: 'A grouped report of the usage ledger',
    description: '`groupBy`: day, kind, workflow, nodeType, signature, agent, model or attr (default kind; attr needs `groupAttr`, and reads the raw events). `kinds` takes custom kinds too (work.ticket_moved). Counts, failures, durations, items, tokens and cost per group; windows past USAGE_RETENTION_DAYS read the daily rollups. Members see the workflows and agents they can open.',
    query: [{ name: 'groupBy', description: 'What to group by', schema: { type: 'string', enum: ['day', 'kind', 'workflow', 'nodeType', 'signature', 'agent', 'model', 'attr'] } }, text('groupAttr', 'For groupBy=attr: the attribute to group by, such as team'), text('attr.<name>', 'Only events whose attribute <name> equals the value, such as attr.team=billing'), ...usageQuery],
    responses: { 200: reply('The report', object({ from: { type: 'string' }, to: { type: 'string' }, groupBy: { type: 'string' }, rows: array({ type: 'object' }), totals: { type: 'object' } }, ['rows', 'totals'])) },
  });
  add('get', '/api/usage/events', {
    tag: 'Second brain',
    id: 'listUsageEvents',
    summary: 'Usage events, newest first',
    query: usageQuery,
    responses: { 200: reply('The events', object({ events: array({ type: 'object' }) }, ['events'])) },
  });
  const usageKind = { type: 'object', description: 'A declared custom kind: kind, description, fields [{ name, type: string|number|boolean, required, description }], projectId, createdBy, createdAt, updatedAt' };
  const kindBody = object({ kind: { type: 'string', description: '<namespace>.<name>, such as work.ticket_moved; not a built-in namespace (run, node, ai, workflow, credential, assistant, spotlight, search, agent, feedback, template, plugin, proposal, tool)' }, description: { type: 'string' }, fields: array({ type: 'object' }) }, ['kind']);
  add('get', '/api/usage/kinds', {
    tag: 'Second brain',
    id: 'listUsageKinds',
    summary: 'List the custom event kinds',
    description: 'The kinds flows record with the Record Event node, with the attributes each declares.',
    responses: { 200: reply('The kinds', object({ kinds: array(usageKind) }, ['kinds'])) },
  });
  add('post', '/api/usage/kinds', {
    tag: 'Second brain',
    id: 'declareUsageKind',
    summary: 'Declare a custom event kind, or update its fields',
    body: jsonBody(kindBody, 'The kind and its attributes'),
    responses: { 200: reply('Updated', object({ kind: usageKind }, ['kind'])), 201: reply('Declared', object({ kind: usageKind }, ['kind'])), 400: invalid },
  });
  add('delete', '/api/usage/kinds/{kind}', {
    tag: 'Second brain',
    id: 'deleteUsageKind',
    summary: 'Forget a custom event kind’s declaration',
    description: 'Events already recorded stay in the ledger.',
    responses: { 200: reply('Forgotten', object({ ok: { type: 'boolean' } }, ['ok'])), 404: notFound },
  });
  add('get', '/api/proposals', {
    tag: 'Second brain',
    id: 'listProposals',
    summary: 'List suggestions',
    description: 'Best first. `status`: open (default), applied, dismissed, snoozed, expired or all. Members see suggestions about the workflows and agents they can open, and the ones addressed to them (`audience`).',
    query: [text('status', 'open (default), applied, dismissed, snoozed, expired or all'), text('workflowId', 'About one workflow'), text('agentId', 'About one agent'), text('detector', 'From one detector'), text('for', '`me`: only suggestions addressed to the caller'), text('limit', 'At most this many (200)')],
    responses: { 200: reply('The suggestions', object({ proposals: array(proposal) }, ['proposals'])) },
  });
  add('post', '/api/proposals', {
    tag: 'Second brain',
    id: 'createProposal',
    summary: 'Add a suggestion',
    description: 'Source `analyst`. Its ops are checked against the workflow; the same fingerprint refreshes the open suggestion. Needs edit access to the workflow or agent. `proposal: null` when it is held back (dismissed or applied recently, or the weekly cap is full).',
    body: jsonBody(object({ title: { type: 'string' }, why: { type: 'string' }, workflowId: { type: 'string' }, agentId: { type: 'string' }, entity: object({ type: { type: 'string', enum: ['initiative', 'person', 'customer', 'system'] }, id: { type: 'string' } }, ['type', 'id']), nodeName: { type: 'string' }, effect: { type: 'string' }, ops: array({ type: 'object' }), risk: { type: 'string', enum: ['low', 'medium', 'high'] }, confidence: { type: 'number' }, fingerprint: { type: 'string' }, actions: array(object({ id: { type: 'string' }, label: { type: 'string' }, style: { type: 'string', enum: ['primary', 'default'] }, confirm: { type: 'string' } }, ['id', 'label'])), audience: array(object({ userId: { type: 'string' }, email: { type: 'string' }, slackUserId: { type: 'string' }, name: { type: 'string' } })) }, ['title', 'why'])),
    responses: { 200: reply('Held back', object({ proposal: { type: 'null' }, reason: { type: 'string' } })), 201: reply('The suggestion', object({ proposal }, ['proposal'])), 400: invalid, 404: notFound },
  });
  add('get', '/api/proposals/{id}', { tag: 'Second brain', id: 'getProposal', summary: 'Get a suggestion', responses: { 200: reply('The suggestion', object({ proposal }, ['proposal'])), 404: notFound } });
  add('patch', '/api/proposals/{id}', {
    tag: 'Second brain',
    id: 'decideProposal',
    summary: 'Dismiss or snooze a suggestion',
    description: '`{ action: "dismiss", reason: intended|not-relevant|wrong|done, note? }` or `{ action: "snooze", days }`. Dismissed as intended, it becomes a fact and isn’t suggested again.',
    body: jsonBody({ type: 'object', properties: { action: { type: 'string', enum: ['dismiss', 'snooze'] }, reason: { type: 'string', enum: ['intended', 'not-relevant', 'wrong', 'done'] }, note: { type: 'string' }, days: { type: 'integer' } }, required: ['action'] }),
    responses: { 200: reply('The suggestion', object({ proposal }, ['proposal'])), 400: invalid, 404: notFound, 409: errorRef('Already applied or dismissed') },
  });
  add('post', '/api/proposals/{id}/apply', {
    tag: 'Second brain',
    id: 'applyProposal',
    summary: 'Apply a suggestion',
    description: 'Ops are checked against the workflow as it is now and saved through governance; a draft becomes a new workflow (`?projectId=`); persona rules go to the agent’s draft.',
    responses: { 200: reply('Applied', object({ proposal, workflow: ref('Workflow'), warnings: array({ type: 'string' }) }, ['proposal', 'warnings'])), 400: errorRef('Advice only: nothing to apply'), 404: notFound, 409: errorRef('The changes no longer fit, or it is already decided') },
  });
  add('post', '/api/proposals/{id}/act', {
    tag: 'Second brain',
    id: 'actOnProposal',
    summary: 'Take one of a suggestion’s actions',
    description:
      'The buttons a flow put on the suggestion (`actions`). Records `decision: { action, label, by, at, note }`, counts it as applied and starts the workflows on On Suggestion Decided. `started` names them; `warnings` says when none listens.',
    body: jsonBody(object({ action: { type: 'string' }, note: { type: 'string' } }, ['action'])),
    responses: { 200: reply('Done', object({ proposal, warnings: array({ type: 'string' }), started: array(object({ id: { type: 'string' }, name: { type: 'string' } })) }, ['proposal', 'warnings'])), 400: errorRef('No such action'), 404: notFound, 409: errorRef('Already decided') },
  });
  add('get', '/api/brain/facts', {
    tag: 'Second brain',
    id: 'listBrainFacts',
    summary: 'What the second brain learned',
    description: '`q` searches (keywords fused with the vector index); otherwise lists by subjectType, subjectId, kind and status.',
    query: [text('q', 'Search'), text('subjectType', 'workflow, agent, nodeType, credential, instance or entity (subjectId is then <type>/<id>)'), text('subjectId', 'One subject'), text('kind', 'purpose, health, cost, failure, slow, change, dependency, usage, quality or intended'), text('status', 'active (default), stale or all'), text('limit', 'At most this many (100)')],
    responses: { 200: reply('The facts', object({ facts: array({ type: 'object' }) }, ['facts'])) },
  });
  const entity = { type: 'object', description: 'A BrainEntity (lib/shared/brain.ts): type (initiative, person, customer, system), id, name, description, owner, ownerName, projectId, attrs, source, createdAt, updatedAt' };
  const entityBody = (required: string[]) =>
    jsonBody(object({ type: { type: 'string', enum: ['initiative', 'person', 'customer', 'system'] }, id: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' }, owner: { type: 'string', description: 'A user id or a free name' }, projectId: { type: 'string' }, attrs: { type: 'object', description: 'Flat values; null removes one' } }, required));
  add('get', '/api/entities', {
    tag: 'Second brain',
    id: 'listEntities',
    summary: 'List entities',
    description: 'Initiatives, people, customers and systems the second brain reasons about, by name. Members see those in projects they can open.',
    query: [text('type', 'initiative, person, customer or system'), text('owner', 'A user id or name'), text('q', 'Words in the name, description, owner or attributes'), text('projectId', 'One project'), text('limit', 'At most this many (500)')],
    responses: { 200: reply('The entities', object({ entities: array(entity) }, ['entities'])), 400: invalid },
  });
  add('post', '/api/entities', {
    tag: 'Second brain',
    id: 'upsertEntity',
    summary: 'Add an entity, or update the one with this id',
    description: 'Needs editor access to the project (`projectId`, else your personal project). With an `id` that exists it updates (fields left out stay).',
    body: entityBody(['type']),
    responses: { 200: reply('Updated', object({ entity }, ['entity'])), 201: reply('Added', object({ entity }, ['entity'])), 400: invalid, 403: errorRef('Not an editor of the project'), 404: notFound },
  });
  add('get', '/api/entities/{type}/{id}', { tag: 'Second brain', id: 'getEntity', summary: 'An entity with what the brain knows', description: 'The entity, its profile, the facts about it and its open suggestions.', responses: { 200: reply('The entity', object({ entity, profile: { type: 'object' }, facts: array({ type: 'object' }), proposals: array(proposal) }, ['entity', 'facts', 'proposals'])), 404: notFound } });
  add('patch', '/api/entities/{type}/{id}', { tag: 'Second brain', id: 'updateEntity', summary: 'Change an entity', body: entityBody([]), responses: { 200: reply('The entity', object({ entity }, ['entity'])), 400: invalid, 403: errorRef('Not an editor of the project'), 404: notFound } });
  add('delete', '/api/entities/{type}/{id}', { tag: 'Second brain', id: 'deleteEntity', summary: 'Delete an entity', description: 'Its facts and profile go with it and its open suggestions expire.', responses: { 200: reply('Deleted', object({ ok: { type: 'boolean' } }, ['ok'])), 403: errorRef('Not an editor of the project'), 404: notFound } });
  add('post', '/api/entities/{type}/{id}/facts', {
    tag: 'Second brain',
    id: 'addEntityFact',
    summary: 'Add a fact about an entity',
    description: 'A statement the brain keeps and searches. `kind` is purpose, health, cost, failure, slow, change, dependency, usage, quality or intended.',
    body: jsonBody(object({ kind: { type: 'string' }, statement: { type: 'string' }, confidence: { type: 'number' } }, ['kind', 'statement'])),
    responses: { 201: reply('The fact', object({ fact: { type: 'object' } }, ['fact'])), 400: invalid, 403: errorRef('Not an editor of the project'), 404: notFound },
  });
  add('post', '/api/brain/backtest', {
    tag: 'Second brain',
    id: 'backtestDetector',
    summary: 'Backtest a detector against past decisions',
    description: 'Reruns the detector as of past points (`days` back, 30 by default, one point every `step` days) without suggesting anything, and scores its findings against how people decided the same suggestions: precision, recall, hits, false alarms, misses. `quiet` tests another threshold multiplier; a precision under `threshold` (0.5) fails the gate. Owners and admins; waits for the run.',
    body: jsonBody(object({ detector: { type: 'string', description: 'A built-in detector id or flow:<workflowId> (published)' }, days: { type: 'integer' }, step: { type: 'integer' }, quiet: { type: 'number' }, threshold: { type: 'number' } }, ['detector'])),
    responses: { 200: reply('The result', object({ backtest: { type: 'object' } }, ['backtest'])), 400: errorRef('Bad window or detector'), 404: notFound, 409: errorRef('The flow is not published') },
  });
  add('get', '/api/brain/backtest', {
    tag: 'Second brain',
    id: 'listBacktests',
    summary: 'Past backtests, newest first',
    query: [text('detector', 'One detector'), text('limit', 'At most this many (10)')],
    responses: { 200: reply('The results', object({ backtests: array({ type: 'object' }) }, ['backtests'])) },
  });
  add('get', '/api/brain/status', { tag: 'Second brain', id: 'brainStatus', summary: 'What the second brain holds and when it last looked', responses: { 200: reply('The status', { type: 'object' }) } });
  return out;
}

export function openApiDocument(origin?: string): Record<string, unknown> {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Landflow API',
      version: '1',
      description: [
        'Build, run and inspect Landflow workflows from scripts, CI and coding agents.',
        'Authenticate with a personal API key from Settings → API keys, sent as `Authorization: Bearer lf_…` or `X-Landflow-API-Key: lf_…`. A key acts as its user, limited to its scopes (`admin` includes every scope); the user’s role still applies. The web app’s session cookie works too.',
        'Errors are JSON `{ "error": "…" }` (400s from validation add `issues`).',
      ].join('\n\n'),
    },
    servers: [{ url: origin ?? '/' }],
    tags: [
      { name: 'Workflows', description: 'Workflows, their versions, and running them' },
      { name: 'Executions', description: 'Runs: history, run data, stop, retry and re-run' },
      { name: 'Data tables', description: 'Built-in tables workflows read and write' },
      { name: 'Settings', description: 'Instance settings: time zone, execution retention and the json-render switch' },
      { name: 'Variables', description: 'Instance variables (`$vars`); changing them needs an owner or admin' },
      { name: 'Templates', description: 'The templates library: start workflows from templates, save and share your own' },
      { name: 'Audit', description: 'The audit log (owners and admins; project admins their projects’ events), its hash chain and four-eyes publish requests' },
      { name: 'Account', description: 'Who you are and your API keys' },
      { name: 'Triggers', description: 'Webhook, form and MCP Server Trigger URLs and their test URLs: public, each checked by its trigger’s own authentication' },
      { name: 'Plugins', description: 'Installed plugins, their transports and transport policies, and broker connections (changes need an owner or admin)' },
      { name: 'Second brain', description: 'The usage ledger, suggestions and what Landflow learned from how it is used (docs/second-brain.md)' },
      { name: 'Runbooks', description: 'Runbook workflows made from closed Landfall war rooms, found by alert kind (docs/runbooks.md)' },
      { name: 'Agents', description: 'Agents that run elsewhere (kagent) reporting what they did back to the run that asked them (docs/a2a.md)' },
      { name: 'Agent teams', description: 'Teams of agents with standing relations: who leads, who reports to whom, who reviews (docs/agent-teams.md)' },
      { name: 'MCP', description: 'Agents and MCP (docs/transports.md): Landflow-issued MCP tokens, tool grants, the JWKS, the plugin catalog (server.json, the registry API) and protected resource metadata' },
    ],
    security: [{ bearerAuth: [] }, { apiKeyHeader: [] }, { sessionCookie: [] }],
    paths: paths(),
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', description: 'A personal API key: `Authorization: Bearer lf_…`' },
        apiKeyHeader: { type: 'apiKey', in: 'header', name: 'X-Landflow-API-Key', description: 'The same API key in its own header' },
        sessionCookie: { type: 'apiKey', in: 'cookie', name: SESSION_COOKIE, description: 'The web app’s session (sign in at /login)' },
      },
      responses: {
        Unauthorized: errorRef('No valid session or API key'),
        Forbidden: errorRef('The API key lacks the scope, or the user’s role can’t do this'),
      },
      schemas,
    },
  };
}
