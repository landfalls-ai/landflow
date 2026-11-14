import { defineCredentialType, defineNode, NodeOperationError, type IExecuteContext, type JsonObject, type PropertyDescriptor } from '@landflow/sdk';
import { Clickland, type Signal } from '../client';
import { DEFAULT_BASE_URL, isoOrUndefined, jsonParameter, mapItems, optionalString, rangeOf, requireString, unsupported, type ApiContext, type ClicklandCredentials } from '../shared';

const ICON = 'file:clickland.svg';
export const COLOR = '#E8833A';
const DOCS = 'https://github.com/landfalls-ai/landflow/blob/main/plugins/clickland/README.md';

export const clicklandApi = defineCredentialType<ClicklandCredentials>({
  name: 'clicklandApi',
  displayName: 'Clickland API (ck_…)',
  icon: ICON,
  documentationUrl: DOCS,
  properties: [
    {
      name: 'baseUrl',
      displayName: 'Base URL',
      type: 'string',
      required: true,
      default: DEFAULT_BASE_URL,
      placeholder: 'http://127.0.0.1:4710',
      description: 'Clickland\'s API. On the OrbStack cluster the default; on this machine http://127.0.0.1:4710',
    },
    {
      name: 'apiKey',
      displayName: 'API Key',
      type: 'string',
      required: true,
      typeOptions: { password: true },
      default: '',
      placeholder: 'ck_…',
      description: 'A Clickland API key (ck_…). Scopes: read for searches; alerts:write, webhooks:write (the Alert Trigger) and notes:write for the writes',
    },
  ],
  async test(data, ctx) {
    try {
      const client = new Clickland({ http: ctx.http }, data);
      const health = await client.health();
      const { alerts } = await client.alerts();
      return { ok: true, message: `Connected to Clickland${health.version ? ` ${health.version}` : ''}: ${alerts?.length ?? 0} alert${alerts?.length === 1 ? '' : 's'}` };
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
  },
});

const show = (resource: string, operation: string[], extra: Record<string, unknown[]> = {}) => ({ show: { resource: [resource], operation, ...extra } });

/** Last N Minutes / From / To for the operations that read a window. */
function rangeProperties(resource: string, operation: string[], minutes = 60): PropertyDescriptor[] {
  return [
    {
      name: 'lastMinutes',
      displayName: 'Last Minutes',
      type: 'number',
      default: minutes,
      typeOptions: { minValue: 1, numberPrecision: 0 },
      displayOptions: show(resource, operation),
      description: 'How far back to look, ending at To (default: now). Ignored when From is set',
    },
    { name: 'from', displayName: 'From', type: 'dateTime', default: '', displayOptions: show(resource, operation), description: 'Start of the window (ISO 8601). Empty: Last Minutes before To' },
    { name: 'to', displayName: 'To', type: 'dateTime', default: '', displayOptions: show(resource, operation), description: 'End of the window (ISO 8601). Empty: now' },
  ];
}

const QUERY_HINT = 'Clickland\'s search language: field:value terms, free text, quotes for phrases, comparisons like duration:>500 (e.g. "service:api level:error timeout"). Empty matches everything';

function searchProperties(resource: 'logs' | 'traces'): PropertyDescriptor[] {
  return [
    { name: 'query', displayName: 'Query', type: 'string', default: '', displayOptions: show(resource, ['search', 'getHistogram', 'getPatterns']), description: QUERY_HINT },
    ...rangeProperties(resource, ['search', 'getHistogram', 'getPatterns']),
    {
      name: 'limit',
      displayName: 'Limit',
      type: 'number',
      default: 100,
      typeOptions: { minValue: 1, maxValue: 500, numberPrecision: 0 },
      displayOptions: show(resource, ['search']),
      description: 'Rows to return, newest first (1-500)',
    },
    { name: 'before', displayName: 'Before (Cursor)', type: 'string', default: '', displayOptions: show(resource, ['search']), description: 'The nextCursor of a previous page, for the next (older) page' },
    {
      name: 'output',
      displayName: 'Output',
      type: 'options',
      default: 'rows',
      displayOptions: show(resource, ['search']),
      options: [
        { name: 'One Item per Row', value: 'rows' },
        { name: 'One Item With Rows, Cursor and Stats', value: 'response' },
      ],
    },
  ];
}

/** The panel types of a view, for the model that composes one (Clickland's api.md, "Views (MCP UI)"). */
export const VIEW_SPEC_HELP = [
  'A Clickland view as JSON: { title, description?, range, panels } with up to 12 panels.',
  'range: { "lastMinutes": n } (relative, refreshes) or { "from", "to" } (ISO 8601).',
  'Every panel has type, title and optional width "half" (default) or "full". Panel types:',
  'timeseries { signal: "logs"|"traces", query, groupBy? } counts over time;',
  'metric { metric, metricType: "gauge"|"sum"|"histogram", aggregation: "avg"|"min"|"max"|"sum"|"rate"|"p50"|"p95"|"p99", service?, groupBy? };',
  'stat { signal, query } one count;',
  'logs { query, limit? } matching log rows;',
  'spans { query, limit? } matching spans;',
  'trace { traceId } one trace as a waterfall;',
  'services {} request rate, errors and latency per service;',
  'patterns { query } log templates (Drain);',
  'markdown { text } a finding in words.',
  'Example: {"title":"Checkout latency","description":"p95 went up at 14:05","range":{"lastMinutes":60},"panels":[',
  '{"type":"timeseries","title":"Errors by service","signal":"logs","query":"level:error","groupBy":"service"},',
  '{"type":"metric","title":"p95 latency","metric":"http.server.duration","metricType":"histogram","aggregation":"p95","service":"checkout"},',
  '{"type":"stat","title":"Error spans","signal":"traces","query":"status:error service:checkout"},',
  '{"type":"logs","title":"Latest errors","query":"service:checkout level:error","limit":20,"width":"full"},',
  '{"type":"spans","title":"Slow spans","query":"service:checkout duration:>500"},',
  '{"type":"trace","title":"A slow trace","traceId":"4bf92f3577b34da6a3ce929d0e0e4736","width":"full"},',
  '{"type":"services","title":"Services"},{"type":"patterns","title":"Error patterns","query":"level:error"},',
  '{"type":"markdown","title":"Finding","text":"Timeouts to **payments** since 14:05."}]}',
].join(' ');

const ALERT_FIELDS = (required: boolean): PropertyDescriptor[] => [
  { name: 'signal', displayName: 'Signal', type: 'options', default: 'logs', options: [{ name: 'Logs', value: 'logs' }, { name: 'Traces', value: 'traces' }] },
  { name: 'query', displayName: 'Query', type: 'string', default: '', required, description: 'The rows the alert counts. ' + QUERY_HINT },
  { name: 'groupBy', displayName: 'Group By', type: 'string', default: '', description: 'A field to count per value of (one state per group); empty: one count' },
  { name: 'thresholdType', displayName: 'Threshold Type', type: 'options', default: 'above', options: [{ name: 'Above', value: 'above' }, { name: 'Below', value: 'below' }] },
  { name: 'threshold', displayName: 'Threshold', type: 'number', default: 10, required },
  { name: 'windowMinutes', displayName: 'Window (Minutes)', type: 'number', default: 5, typeOptions: { minValue: 1, numberPrecision: 0 }, description: 'The sliding window the rows are counted in' },
  { name: 'intervalMinutes', displayName: 'Check Every (Minutes)', type: 'number', default: 1, typeOptions: { minValue: 1, numberPrecision: 0 } },
  { name: 'enabled', displayName: 'Enabled', type: 'boolean', default: true },
];

const alertId = (operation: string[]): PropertyDescriptor => ({
  name: 'alertId',
  displayName: 'Alert ID',
  type: 'string',
  required: true,
  default: '',
  displayOptions: show('alerts', operation),
  description: 'The alert\'s id (al_…)',
});

const viewId = (operation: string[]): PropertyDescriptor => ({ name: 'viewId', displayName: 'View ID', type: 'string', required: true, default: '', displayOptions: show('views', operation), description: 'The view\'s id (vw_…)' });

export const ClicklandNode = defineNode({
  description: {
    name: 'clickland',
    displayName: 'Clickland',
    description: 'Search logs and traces, read services, metrics and log patterns, manage alerts, add and search notes, ask the knowledge search and render views in Clickland',
    version: 1,
    kind: 'action',
    categories: ['Development', 'Analytics'],
    icon: ICON,
    color: COLOR,
    subtitle: '{{operation}}: {{resource}}',
    documentationUrl: DOCS,
    keywords: ['clickland', 'observability', 'logs', 'traces', 'metrics', 'alerts', 'monitoring', 'apm', 'otel', 'opentelemetry', 'dashboard'],
    usableAsTool: true,
    // Writes are at most once over a broker; reads opt back in with `idempotent: true`.
    idempotent: false,
    toolDescription:
      'Clickland observability: search logs and traces with Clickland\'s query language, read one trace, list services with their error rate and latency, list and query metrics, find log patterns, list alerts and their events, create or change alerts, add and search notes, search Clickland\'s knowledge (notes, alert events, patterns, services) and render views (charts, tables, traces) that show inline in Clickland\'s console.',
    inputs: [{ type: 'main' }],
    outputs: [{ type: 'main' }],
    credentials: [{ name: 'clicklandApi', required: true }],
    properties: [
      {
        name: 'resource',
        displayName: 'Resource',
        type: 'options',
        noDataExpression: true,
        default: 'logs',
        options: [
          { name: 'Alert', value: 'alerts' },
          { name: 'Knowledge', value: 'knowledge' },
          { name: 'Log', value: 'logs' },
          { name: 'Metric', value: 'metrics' },
          { name: 'Note', value: 'notes' },
          { name: 'Service', value: 'services' },
          { name: 'Trace', value: 'traces' },
          { name: 'View', value: 'views' },
        ],
      },
      {
        name: 'operation',
        displayName: 'Operation',
        type: 'options',
        noDataExpression: true,
        default: 'search',
        displayOptions: { show: { resource: ['logs'] } },
        options: [
          { name: 'Search', value: 'search', description: 'Log rows matching a query, newest first', action: 'Search logs', idempotent: true },
          { name: 'Histogram', value: 'getHistogram', description: 'Matching rows counted per time bucket, optionally per value of a field (at most 10 series)', action: 'Count logs over time', idempotent: true },
          { name: 'Patterns', value: 'getPatterns', description: 'The templates the matching log lines follow (Drain over a sample), with counts and an example', action: 'Find log patterns', idempotent: true },
        ],
      },
      {
        name: 'operation',
        displayName: 'Operation',
        type: 'options',
        noDataExpression: true,
        default: 'search',
        displayOptions: { show: { resource: ['traces'] } },
        options: [
          { name: 'Search', value: 'search', description: 'Spans matching a query, newest first', action: 'Search spans', idempotent: true },
          { name: 'Get', value: 'get', description: 'Every span of one trace, sorted by start time', action: 'Get a trace', idempotent: true },
        ],
      },
      {
        name: 'operation',
        displayName: 'Operation',
        type: 'options',
        noDataExpression: true,
        default: 'list',
        displayOptions: { show: { resource: ['services'] } },
        options: [{ name: 'List', value: 'list', description: 'Services with requests, errors, error rate and p50/p95/p99 latency in a window', action: 'List services', idempotent: true }],
      },
      {
        name: 'operation',
        displayName: 'Operation',
        type: 'options',
        noDataExpression: true,
        default: 'list',
        displayOptions: { show: { resource: ['metrics'] } },
        options: [
          { name: 'List', value: 'list', description: 'Metric names with type, unit and the services that send them', action: 'List metrics', idempotent: true },
          { name: 'Query', value: 'getSeries', description: 'One metric aggregated over time (avg, sum, rate, p95…), optionally per service or attribute', action: 'Query a metric', idempotent: true },
        ],
      },
      {
        name: 'operation',
        displayName: 'Operation',
        type: 'options',
        noDataExpression: true,
        default: 'list',
        displayOptions: { show: { resource: ['alerts'] } },
        options: [
          { name: 'Create', value: 'create', description: 'Alert when the rows matching a query in a window cross a threshold', action: 'Create an alert' },
          { name: 'Delete', value: 'delete', description: 'Delete an alert', action: 'Delete an alert' },
          { name: 'Events', value: 'getEvents', description: 'When the alert fired and resolved, newest first', action: 'Get alert events', idempotent: true },
          { name: 'Get', value: 'get', description: 'One alert with its states per group', action: 'Get an alert', idempotent: true },
          { name: 'List', value: 'list', description: 'Every alert with its states', action: 'List alerts', idempotent: true },
          { name: 'Update', value: 'update', description: 'Change some fields of an alert (the rest stay)', action: 'Update an alert' },
        ],
      },
      {
        name: 'operation',
        displayName: 'Operation',
        type: 'options',
        noDataExpression: true,
        default: 'create',
        displayOptions: { show: { resource: ['notes'] } },
        options: [
          { name: 'Create', value: 'create', description: 'Write down what was learned about an incident or a service (Clickland\'s long-term knowledge)', action: 'Add a note' },
          { name: 'List', value: 'list', description: 'Notes, optionally of one service or matching words', action: 'List notes', idempotent: true },
        ],
      },
      {
        name: 'operation',
        displayName: 'Operation',
        type: 'options',
        noDataExpression: true,
        default: 'search',
        displayOptions: { show: { resource: ['knowledge'] } },
        options: [
          {
            name: 'Search',
            value: 'search',
            description: 'Passages from notes, recent alert events, log patterns and services that help answer a question ({ results: [{ pageContent, metadata, score }] })',
            action: 'Search Clickland knowledge',
            idempotent: true,
          },
        ],
      },
      {
        name: 'operation',
        displayName: 'Operation',
        type: 'options',
        noDataExpression: true,
        default: 'render',
        displayOptions: { show: { resource: ['views'] } },
        options: [
          {
            name: 'Render',
            value: 'render',
            description: 'Build a view (charts, tables, a trace) from a spec; answers with its id, url and the marker [[clickland:view:<id>]] that Clickland\'s console shows inline as a live view',
            action: 'Render a view (charts, tables, a trace) and get its [[clickland:view:<id>]] marker',
          },
          { name: 'Add Panel', value: 'addPanel', description: 'Add one panel to a view or dashboard (appended, or at a position) without resending the rest', action: 'Add a panel to a view' },
          { name: 'Get', value: 'get', description: 'One view or dashboard with its spec and version', action: 'Get a view', idempotent: true },
          { name: 'List', value: 'list', description: 'Dashboards (pinned views) with id, title and when they were made; or every view', action: 'List dashboards', idempotent: true },
          { name: 'Pin', value: 'pin', description: 'Save a view as a dashboard, optionally renaming it (or unpin it)', action: 'Save a view as a dashboard' },
          { name: 'Remove Panel', value: 'removePanel', description: 'Remove the panel at an index (0 = the first) from a view or dashboard', action: 'Remove a panel from a view' },
          { name: 'Update', value: 'update', description: 'Replace a view\'s spec, rename it or pin it; with Version set, fails with 409 when someone saved in between', action: 'Update a view' },
        ],
      },

      // Logs and traces
      ...searchProperties('logs'),
      ...searchProperties('traces'),
      { name: 'groupBy', displayName: 'Group By', type: 'string', default: '', displayOptions: show('logs', ['getHistogram']), description: 'A field to count per value of (service, level…); empty: one series' },
      {
        name: 'sample',
        displayName: 'Sample',
        type: 'number',
        default: 5000,
        typeOptions: { minValue: 100, maxValue: 20000, numberPrecision: 0 },
        displayOptions: show('logs', ['getPatterns']),
        description: 'How many of the newest matching rows to read (up to 20000)',
      },
      { name: 'traceId', displayName: 'Trace ID', type: 'string', required: true, default: '', displayOptions: show('traces', ['get']), description: 'The trace\'s id (32 hex characters)' },

      // Services
      ...rangeProperties('services', ['list']),

      // Metrics
      ...rangeProperties('metrics', ['list', 'getSeries']),
      { name: 'metric', displayName: 'Metric', type: 'string', required: true, default: '', placeholder: 'http.server.duration', displayOptions: show('metrics', ['getSeries']) },
      {
        name: 'metricType',
        displayName: 'Metric Type',
        type: 'options',
        default: 'gauge',
        options: [
          { name: 'Gauge', value: 'gauge' },
          { name: 'Sum', value: 'sum' },
          { name: 'Histogram', value: 'histogram' },
        ],
        displayOptions: show('metrics', ['getSeries']),
        description: 'The type Metrics → List gives for it',
      },
      {
        name: 'aggregation',
        displayName: 'Aggregation',
        type: 'options',
        default: 'avg',
        options: ['avg', 'min', 'max', 'sum', 'rate', 'p50', 'p95', 'p99'].map((value) => ({ name: value, value })),
        displayOptions: show('metrics', ['getSeries']),
      },
      { name: 'service', displayName: 'Service', type: 'string', default: '', displayOptions: show('metrics', ['getSeries']), description: 'Only this service (empty: all)' },
      { name: 'groupBy', displayName: 'Group By', type: 'string', default: '', displayOptions: show('metrics', ['getSeries']), description: 'An attribute key to split the series by' },

      // Alerts
      alertId(['get', 'update', 'delete', 'getEvents']),
      { name: 'name', displayName: 'Name', type: 'string', required: true, default: '', displayOptions: show('alerts', ['create']) },
      ...ALERT_FIELDS(true).map((p) => ({ ...p, displayOptions: show('alerts', ['create']) })),
      {
        name: 'updateFields',
        displayName: 'Update Fields',
        type: 'collection',
        default: {},
        placeholder: 'Add Field',
        displayOptions: show('alerts', ['update']),
        values: [{ name: 'name', displayName: 'Name', type: 'string', default: '' }, ...ALERT_FIELDS(false)],
      },
      {
        name: 'limit',
        displayName: 'Limit',
        type: 'number',
        default: 20,
        typeOptions: { minValue: 1, maxValue: 500, numberPrecision: 0 },
        displayOptions: show('alerts', ['getEvents']),
        description: 'Events to return, newest first',
      },

      // Notes
      { name: 'title', displayName: 'Title', type: 'string', required: true, default: '', displayOptions: show('notes', ['create']) },
      { name: 'body', displayName: 'Body', type: 'string', required: true, default: '', typeOptions: { rows: 5 }, displayOptions: show('notes', ['create']), description: 'Markdown: what was found, the evidence and what fixed it' },
      {
        name: 'noteFields',
        displayName: 'Additional Fields',
        type: 'collection',
        default: {},
        placeholder: 'Add Field',
        displayOptions: show('notes', ['create']),
        values: [
          { name: 'service', displayName: 'Service', type: 'string', default: '' },
          { name: 'tags', displayName: 'Tags', type: 'string', default: '', description: 'Comma-separated' },
          { name: 'traceIds', displayName: 'Trace IDs', type: 'string', default: '', description: 'Comma-separated trace ids the note is about' },
          { name: 'alertEventId', displayName: 'Alert Event ID', type: 'string', default: '' },
          { name: 'author', displayName: 'Author', type: 'string', default: '', description: 'Who wrote it (default: the API key\'s name)' },
        ],
      },
      { name: 'service', displayName: 'Service', type: 'string', default: '', displayOptions: show('notes', ['list']), description: 'Only notes about this service' },
      { name: 'q', displayName: 'Search', type: 'string', default: '', displayOptions: show('notes', ['list']), description: 'Words the notes contain' },
      { name: 'limit', displayName: 'Limit', type: 'number', default: 20, typeOptions: { minValue: 1, maxValue: 200, numberPrecision: 0 }, displayOptions: show('notes', ['list']) },

      // Knowledge
      { name: 'query', displayName: 'Question', type: 'string', required: true, default: '', displayOptions: show('knowledge', ['search']), description: 'What to look for, in natural language ("why does checkout time out?")' },
      { name: 'limit', displayName: 'Limit', type: 'number', default: 8, typeOptions: { minValue: 1, maxValue: 25, numberPrecision: 0 }, displayOptions: show('knowledge', ['search']) },
      { name: 'from', displayName: 'From', type: 'dateTime', default: '', displayOptions: show('knowledge', ['search']), description: 'Start of the window (empty: the last 24 hours)' },
      { name: 'to', displayName: 'To', type: 'dateTime', default: '', displayOptions: show('knowledge', ['search']) },

      // Views
      { name: 'spec', displayName: 'View Spec (JSON)', type: 'json', required: true, default: '{\n  "title": "",\n  "range": { "lastMinutes": 60 },\n  "panels": []\n}', typeOptions: { rows: 10 }, displayOptions: show('views', ['render']), description: VIEW_SPEC_HELP },
      { name: 'pinned', displayName: 'Pin as Dashboard', type: 'boolean', default: false, displayOptions: show('views', ['render']), description: 'Whether to keep it as a dashboard (otherwise an ad-hoc view)' },
      viewId(['get', 'pin', 'update', 'addPanel', 'removePanel']),
      { name: 'pinned', displayName: 'Pinned', type: 'boolean', default: true, displayOptions: show('views', ['pin']), description: 'Whether it is a dashboard (off: unpin)' },
      { name: 'title', displayName: 'Title', type: 'string', default: '', displayOptions: show('views', ['pin']), description: 'The dashboard\'s name (empty: keep the view\'s title)' },
      { name: 'pinnedOnly', displayName: 'Dashboards Only', type: 'boolean', default: true, displayOptions: show('views', ['list']), description: 'Whether to list only dashboards (pinned views)' },
      {
        name: 'viewFields',
        displayName: 'Update Fields',
        type: 'collection',
        default: {},
        placeholder: 'Add Field',
        displayOptions: show('views', ['update']),
        values: [
          { name: 'spec', displayName: 'View Spec (JSON)', type: 'json', default: '', typeOptions: { rows: 10 }, description: `The whole new spec (Get the view first and change it). ${VIEW_SPEC_HELP}` },
          { name: 'title', displayName: 'Title', type: 'string', default: '' },
          { name: 'pinned', displayName: 'Pinned', type: 'boolean', default: true },
          { name: 'version', displayName: 'Version', type: 'number', default: 0, typeOptions: { minValue: 0, numberPrecision: 0 }, description: 'The version Get returned: the save fails (409) if someone saved since. 0: no check' },
        ],
      },
      {
        name: 'panel',
        displayName: 'Panel (JSON)',
        type: 'json',
        required: true,
        default: '{\n  "type": "timeseries",\n  "title": "",\n  "signal": "logs",\n  "query": ""\n}',
        typeOptions: { rows: 6 },
        displayOptions: show('views', ['addPanel']),
        description: `One panel object, as in a view spec's panels. ${VIEW_SPEC_HELP}`,
      },
      { name: 'position', displayName: 'Position', type: 'number', default: -1, typeOptions: { minValue: -1, numberPrecision: 0 }, displayOptions: show('views', ['addPanel']), description: 'Where to insert it (0 = first); -1 appends' },
      { name: 'index', displayName: 'Panel Index', type: 'number', required: true, default: 0, typeOptions: { minValue: 0, numberPrecision: 0 }, displayOptions: show('views', ['removePanel']), description: 'The panel\'s place in the spec\'s panels (0 = the first; Get the view to see them)' },
    ],
  },
  async execute(ctx) {
    const api: ApiContext = { http: ctx.http, ...(ctx.signal && { signal: ctx.signal }) };
    const client = new Clickland(api, ctx.getCredentials<ClicklandCredentials>('clicklandApi'));
    return mapItems(ctx, async (i) => {
      const resource = ctx.getNodeParameter<string>('resource', i);
      const operation = ctx.getNodeParameter<string>('operation', i);
      switch (resource) {
        case 'logs':
        case 'traces':
          return signalOperation(ctx, client, resource, operation, i);
        case 'services':
          if (operation !== 'list') throw unsupported(resource, operation);
          return (await client.services(rangeOf(ctx, i))).services ?? [];
        case 'metrics':
          return metricOperation(ctx, client, operation, i);
        case 'alerts':
          return alertOperation(ctx, client, operation, i);
        case 'notes':
          return noteOperation(ctx, client, operation, i);
        case 'knowledge': {
          if (operation !== 'search') throw unsupported(resource, operation);
          const from = isoOrUndefined(ctx.getNodeParameter('from', i, ''), 'From', i);
          const to = isoOrUndefined(ctx.getNodeParameter('to', i, ''), 'To', i);
          const limit = clamp(ctx.getNodeParameter('limit', i, 8), 1, 25, 8);
          const answer = await client.knowledge({ query: requireString(ctx, 'query', 'Question', i), ...(from && { from }), ...(to && { to }), limit });
          return { results: answer.results ?? [] };
        }
        case 'views':
          return viewOperation(ctx, client, operation, i);
        default:
          throw unsupported(resource, operation);
      }
    });
  },
});

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

const list = (value: unknown): string[] =>
  (Array.isArray(value) ? value.map(String) : String(value ?? '').split(','))
    .map((v) => v.trim())
    .filter(Boolean);

async function signalOperation(ctx: IExecuteContext, client: Clickland, signal: Signal, operation: string, i: number): Promise<JsonObject | JsonObject[]> {
  if (signal === 'traces' && operation === 'get') return client.trace(requireString(ctx, 'traceId', 'Trace ID', i));
  const query = optionalString(ctx, 'query', i);
  const range = rangeOf(ctx, i);
  switch (operation) {
    case 'search': {
      const before = optionalString(ctx, 'before', i);
      const answer = await client.search({ signal, query, ...range, limit: clamp(ctx.getNodeParameter('limit', i, 100), 1, 500, 100), ...(before && { before }) });
      if (ctx.getNodeParameter<string>('output', i, 'rows') === 'response') return { rows: answer.rows ?? [], nextCursor: answer.nextCursor ?? null, ...(answer.stats && { stats: answer.stats }) };
      return answer.rows ?? [];
    }
    case 'getHistogram':
      if (signal !== 'logs') break;
      {
        const groupBy = optionalString(ctx, 'groupBy', i);
        return client.histogram({ signal, query, ...range, ...(groupBy && { groupBy }) });
      }
    case 'getPatterns':
      if (signal !== 'logs') break;
      return client.patterns({ signal, query, ...range, sample: clamp(ctx.getNodeParameter('sample', i, 5000), 100, 20000, 5000) });
  }
  throw unsupported(signal, operation);
}

async function metricOperation(ctx: IExecuteContext, client: Clickland, operation: string, i: number): Promise<JsonObject | JsonObject[]> {
  const range = rangeOf(ctx, i);
  if (operation === 'list') return (await client.metricNames(range)).metrics ?? [];
  if (operation !== 'getSeries') throw unsupported('metrics', operation);
  const service = optionalString(ctx, 'service', i);
  const groupBy = optionalString(ctx, 'groupBy', i);
  return client.metricQuery({
    metric: requireString(ctx, 'metric', 'Metric', i),
    type: ctx.getNodeParameter<string>('metricType', i, 'gauge'),
    aggregation: ctx.getNodeParameter<string>('aggregation', i, 'avg'),
    ...range,
    ...(service && { service }),
    ...(groupBy && { groupBy }),
  });
}

/** The writable fields of an alert, from a parameter source (the node's top level or Update Fields). */
function alertBody(get: (name: string) => unknown, itemIndex: number, partial: boolean): JsonObject {
  const body: JsonObject = {};
  const has = (name: string) => {
    const v = get(name);
    return v !== undefined && v !== null && v !== '';
  };
  for (const name of ['name', 'signal', 'query', 'thresholdType']) if (has(name)) body[name] = String(get(name)).trim();
  if (has('groupBy')) body.groupBy = String(get('groupBy')).trim() || null;
  else if (!partial) body.groupBy = null;
  for (const name of ['threshold', 'windowMinutes', 'intervalMinutes']) {
    if (!has(name)) continue;
    const n = Number(get(name));
    if (!Number.isFinite(n)) throw new NodeOperationError(`${name} must be a number`, { itemIndex });
    body[name] = n;
  }
  if (get('enabled') !== undefined && get('enabled') !== '') body.enabled = get('enabled') === true || get('enabled') === 'true';
  return body;
}

/** The fields Clickland's alert body takes (what a PUT sends back from a GET). */
const ALERT_KEYS = ['name', 'signal', 'query', 'groupBy', 'thresholdType', 'threshold', 'windowMinutes', 'intervalMinutes', 'enabled'];

async function alertOperation(ctx: IExecuteContext, client: Clickland, operation: string, i: number): Promise<JsonObject | JsonObject[]> {
  switch (operation) {
    case 'list':
      return (await client.alerts()).alerts ?? [];
    case 'get':
      return client.alert(requireString(ctx, 'alertId', 'Alert ID', i));
    case 'getEvents':
      return (await client.alertEvents(requireString(ctx, 'alertId', 'Alert ID', i), clamp(ctx.getNodeParameter('limit', i, 20), 1, 500, 20))).events ?? [];
    case 'create': {
      const body = alertBody((name) => ctx.getNodeParameter(name, i, undefined), i, false);
      if (!body.name) throw new NodeOperationError('Name is required', { itemIndex: i });
      return client.createAlert(body);
    }
    case 'update': {
      const id = requireString(ctx, 'alertId', 'Alert ID', i);
      const fields = ctx.getNodeParameter<JsonObject>('updateFields', i, {}) ?? {};
      const changes = alertBody((name) => fields[name], i, true);
      if (!Object.keys(changes).length) throw new NodeOperationError('Pick at least one field under Update Fields', { itemIndex: i });
      // PUT takes the whole alert: read it, change what was asked, send it back.
      const current = await client.alert(id);
      const body: JsonObject = Object.fromEntries(ALERT_KEYS.filter((k) => current[k] !== undefined).map((k) => [k, current[k]]));
      return client.updateAlert(id, { ...body, ...changes });
    }
    case 'delete': {
      const id = requireString(ctx, 'alertId', 'Alert ID', i);
      await client.deleteAlert(id);
      return { deleted: true, id };
    }
  }
  throw unsupported('alerts', operation);
}

async function noteOperation(ctx: IExecuteContext, client: Clickland, operation: string, i: number): Promise<JsonObject | JsonObject[]> {
  if (operation === 'list') {
    const service = optionalString(ctx, 'service', i);
    const q = optionalString(ctx, 'q', i);
    return (await client.notes({ ...(service && { service }), ...(q && { q }), limit: clamp(ctx.getNodeParameter('limit', i, 20), 1, 200, 20) })).notes ?? [];
  }
  if (operation !== 'create') throw unsupported('notes', operation);
  const fields = ctx.getNodeParameter<JsonObject>('noteFields', i, {}) ?? {};
  const text = (key: string) => String(fields[key] ?? '').trim();
  return client.createNote({
    title: requireString(ctx, 'title', 'Title', i),
    body: requireString(ctx, 'body', 'Body', i),
    tags: list(fields.tags),
    traceIds: list(fields.traceIds),
    ...(text('service') && { service: text('service') }),
    ...(text('alertEventId') && { alertEventId: text('alertEventId') }),
    ...(text('author') && { author: text('author') }),
  });
}

async function viewOperation(ctx: IExecuteContext, client: Clickland, operation: string, i: number): Promise<JsonObject | JsonObject[]> {
  switch (operation) {
    case 'render':
      return client.renderView(specOf(ctx.getNodeParameter('spec', i, ''), i), ctx.getNodeParameter<boolean>('pinned', i, false) === true);
    case 'get':
      return client.view(requireString(ctx, 'viewId', 'View ID', i));
    case 'list':
      return (await client.views(ctx.getNodeParameter<boolean>('pinnedOnly', i, true) ? { pinned: true } : {})).views ?? [];
    case 'pin': {
      const id = requireString(ctx, 'viewId', 'View ID', i);
      const title = optionalString(ctx, 'title', i);
      return client.updateView(id, { pinned: ctx.getNodeParameter<boolean>('pinned', i, true) !== false, ...(title && { title }) });
    }
    case 'update': {
      const id = requireString(ctx, 'viewId', 'View ID', i);
      const fields = ctx.getNodeParameter<JsonObject>('viewFields', i, {}) ?? {};
      const body: JsonObject = {};
      if (fields.spec !== undefined && fields.spec !== '') body.spec = specOf(fields.spec, i);
      if (typeof fields.title === 'string' && fields.title.trim()) body.title = fields.title.trim();
      if (typeof fields.pinned === 'boolean') body.pinned = fields.pinned;
      if (Number(fields.version) > 0) body.version = Number(fields.version);
      if (!('spec' in body) && !('title' in body) && !('pinned' in body)) throw new NodeOperationError('Pick at least one of Spec, Title or Pinned under Update Fields', { itemIndex: i });
      return client.updateView(id, body);
    }
    case 'addPanel': {
      const id = requireString(ctx, 'viewId', 'View ID', i);
      const panel = jsonParameter(ctx.getNodeParameter('panel', i, ''), 'Panel');
      if (!panel || typeof panel !== 'object' || Array.isArray(panel) || typeof (panel as JsonObject).type !== 'string') {
        throw new NodeOperationError('Panel must be a JSON object with a type', { itemIndex: i, description: VIEW_SPEC_HELP });
      }
      const position = Number(ctx.getNodeParameter('position', i, -1));
      return client.addPanel(id, panel as JsonObject, Number.isInteger(position) && position >= 0 ? position : undefined);
    }
    case 'removePanel': {
      const id = requireString(ctx, 'viewId', 'View ID', i);
      const index = Number(ctx.getNodeParameter('index', i, 0));
      if (!Number.isInteger(index) || index < 0) throw new NodeOperationError('Panel Index must be a whole number of 0 or more', { itemIndex: i });
      return (await client.removePanel(id, index)) ?? { removed: true, id, index };
    }
  }
  throw unsupported('views', operation);
}

/** A view spec parameter: a JSON object with at least one panel. */
function specOf(value: unknown, i: number): JsonObject {
  const spec = jsonParameter(value, 'View Spec');
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new NodeOperationError('View Spec must be a JSON object { title, range, panels }', { itemIndex: i, description: VIEW_SPEC_HELP });
  if (!Array.isArray((spec as JsonObject).panels) || !((spec as JsonObject).panels as unknown[]).length) {
    throw new NodeOperationError('View Spec needs at least one panel', { itemIndex: i, description: VIEW_SPEC_HELP });
  }
  return spec as JsonObject;
}
