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
  tag: 'Workflows' | 'Executions' | 'Data tables' | 'Variables' | 'Templates' | 'Audit' | 'Account' | 'Triggers' | 'Plugins' | 'MCP';
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
  TemplateProblem: object({ kind: { type: 'string', enum: ['missing', 'blocked'] }, nodeType: { type: 'string' }, message: { type: 'string' } }, ['kind', 'nodeType', 'message']),
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
      usable: { type: 'boolean', description: 'False when a node type is missing here or blocked by the governance policy' },
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
      object({ scope: { type: 'string', enum: ['all', 'from', 'only'], default: 'all' }, nodeId: { type: 'string' }, version: { type: 'string', enum: ['current', 'original'], default: 'current' } }),
    ),
    responses: { 202: reply('Started', object({ executionId: { type: 'string' } }, ['executionId'])), 400: invalid, 404: notFound },
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
  add('post', '/api/templates/{id}/use', {
    tag: 'Templates',
    id: 'useTemplate',
    summary: 'Create a workflow from a template',
    description: 'Each credential slot gets the saved credential picked for it (of the slot’s type); missing data tables are created and URL paths made unique. Saved as an inactive draft.',
    body: jsonBody(
      object({
        name: { type: 'string', maxLength: 200 },
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
    body: jsonBody(object({ label: { type: 'string', minLength: 1, maxLength: 100 }, scopes: { ...array(ref('McpTokenScope')), minItems: 1 }, expiresInDays: { type: 'integer', minimum: 1, maximum: 365 } }, ['label'])),
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
      { name: 'Variables', description: 'Instance variables (`$vars`); changing them needs an owner or admin' },
      { name: 'Templates', description: 'The templates library: start workflows from templates, save and share your own' },
      { name: 'Audit', description: 'The audit log (owners and admins; project admins their projects’ events), its hash chain and four-eyes publish requests' },
      { name: 'Account', description: 'Who you are and your API keys' },
      { name: 'Triggers', description: 'Webhook, form and MCP Server Trigger URLs and their test URLs: public, each checked by its trigger’s own authentication' },
      { name: 'Plugins', description: 'Installed plugins, their transports and transport policies, and broker connections (changes need an owner or admin)' },
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
