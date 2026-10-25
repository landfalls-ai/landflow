/**
 * The public API as an OpenAPI 3.1 document (GET /api/openapi.json, Settings → API): workflows (and running them),
 * executions, data tables, variables and your account and API keys. Request bodies of the workflow and row filter
 * come from the routes' own zod schemas, so they can't drift; every operation names the API key scope the guard
 * wants (`x-landflow-scope`, from lib/server/auth/policy.ts), so the docs and the guard agree.
 *
 * Only routes that exist are listed: test/openapi.test.ts checks each path against app/api and its exported methods.
 */
import { z } from 'zod';
import { API_KEY_SCOPES } from '../shared/auth';
import { SESSION_COOKIE } from '../shared/auth-paths';
import { rowFilterSchema } from './datatables/http';
import { routePolicy } from './auth/policy';
import { workflowSchema } from './schemas';

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
  tag: 'Workflows' | 'Executions' | 'Data tables' | 'Variables' | 'Account';
  id: string;
  summary: string;
  description?: string;
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

function operation(method: Method, path: string, spec: Operation): Json {
  const policy = routePolicy(method.toUpperCase(), samplePath(path));
  const parameters = [
    ...[...path.matchAll(/\{([^}]+)\}/g)].map(([, name]) => ({ name, in: 'path', required: true, schema: { type: 'string' } })),
    ...(spec.query ?? []).map((q) => ({ name: q.name, in: 'query', required: q.required ?? false, description: q.description, schema: q.schema })),
    ...(spec.headers ?? []).map((h) => ({ name: h.name, in: 'header', required: false, description: h.description, schema: h.schema })),
  ];
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
      { name: 'Account', description: 'Who you are and your API keys' },
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
