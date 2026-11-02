import { defineCredentialType, defineNode, NodeOperationError, type IExecuteContext, type JsonObject, type PropertyDescriptor } from '@landflow/sdk';
import { Org, pingHeartbeat, postTrigger, type HeartbeatCredentials, type LandfallCredentials, type Severity } from '../client';
import { jsonParameter, mapItems, requireString, unsupported, type ApiContext } from '../shared';

const ICON = 'file:landfall.svg';

export const landfallApi = defineCredentialType<LandfallCredentials>({
  name: 'landfallApi',
  displayName: 'Landfall API (lf_key_…)',
  icon: ICON,
  documentationUrl: 'https://landfalls.ai',
  properties: [
    {
      name: 'baseUrl',
      displayName: 'Base URL',
      type: 'string',
      required: true,
      default: '',
      placeholder: 'https://your-landfall-api.example',
      description: 'The Landfall API, without /o/<slug>. Use the fake (http://127.0.0.1:7398) for local runs',
    },
    { name: 'orgSlug', displayName: 'Org Slug', type: 'string', required: true, default: '', description: 'The organization in /o/<slug>/…' },
    {
      name: 'apiKey',
      displayName: 'API Key',
      type: 'string',
      required: true,
      typeOptions: { password: true },
      placeholder: 'lf_key_…',
      description: 'A Landfall API key (lf_key_…); it acts as the member who owns it. This is not a Landflow lf_ key',
    },
    {
      name: 'ingestToken',
      displayName: 'Ingest Token',
      type: 'string',
      typeOptions: { password: true },
      default: '',
      description: 'Only for Open from Alert and Recover (POST /triggers). The token of the organization\'s remote-source connection',
    },
    {
      name: 'connectionId',
      displayName: 'Connection ID',
      type: 'string',
      default: '',
      description: 'The organization\'s remote-source connection id, sent as connectionId by Open from Alert and Recover',
    },
  ],
  async test(data, ctx) {
    try {
      const org = new Org({ http: ctx.http }, data);
      const page = await org.listIncidents({ limit: 1 });
      return { ok: true, message: `Authenticated to ${data.orgSlug} (${page.items.length ? 'has incidents' : 'no incidents yet'})` };
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
  },
});

export const landfallHeartbeatApi = defineCredentialType<HeartbeatCredentials>({
  name: 'landfallHeartbeatApi',
  displayName: 'Landfall Heartbeat',
  icon: ICON,
  documentationUrl: 'https://landfalls.ai',
  properties: [
    { name: 'baseUrl', displayName: 'Base URL', type: 'string', required: true, default: '', placeholder: 'https://your-landfall-api.example' },
    { name: 'orgSlug', displayName: 'Org Slug', type: 'string', required: true, default: '' },
    {
      name: 'token',
      displayName: 'Heartbeat Token',
      type: 'string',
      required: true,
      typeOptions: { password: true },
      description: 'The heartbeat ping token (sent as a bearer token)',
    },
  ],
  // A ping is a write that resets a dead-man timer, so the test only checks that the fields are filled in.
  async test(data) {
    return data.baseUrl && data.orgSlug && data.token ? { ok: true, message: 'Fields are set; the token is checked on the first ping' } : { ok: false, message: 'Base URL, Org Slug and Token are required' };
  },
});

const SEVERITIES = [
  { name: 'Sev1 (critical)', value: 'sev1' },
  { name: 'Sev2 (major)', value: 'sev2' },
  { name: 'Sev3 (minor)', value: 'sev3' },
  { name: 'Sev4 (low)', value: 'sev4' },
];

const show = (resource: string, operation: string[], extra: Record<string, unknown[]> = {}) => ({ show: { resource: [resource], operation, ...extra } });

const incidentId = (resource: string, operation: string[]): PropertyDescriptor => ({
  name: 'incidentId',
  displayName: 'Incident ID',
  type: 'string',
  required: true,
  default: '',
  displayOptions: show(resource, operation),
  description: 'The incident\'s id (the `id` of an incident item, or incidentId of an Open from Alert result)',
});

const alertFields = (withDedup: boolean): PropertyDescriptor[] => [
  ...(withDedup ? [{ name: 'dedupKey', displayName: 'Dedup Key', type: 'string', default: '', description: 'The alert identity. A repeat with the same key while the room is open attaches to it' } as PropertyDescriptor] : []),
  { name: 'entityHints', displayName: 'Entity Hints', type: 'string', default: '', placeholder: 'service:checkout, env:prod', description: 'Comma- or line-separated key:value hints that tell Landfall which entity this is' },
  { name: 'summary', displayName: 'Summary', type: 'string', default: '', typeOptions: { rows: 3 } },
  { name: 'url', displayName: 'URL', type: 'string', default: '', description: 'A link back to the alert' },
  { name: 'occurredAt', displayName: 'Occurred At', type: 'dateTime', default: '', description: 'When the alert fired (default: now, on Landfall\'s side)' },
  { name: 'connectionId', displayName: 'Connection ID', type: 'string', default: '', description: 'Overrides the credential\'s Connection ID' },
];

/** "service:checkout, env:prod" → ["service:checkout", "env:prod"]. */
export function parseHints(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  return String(value ?? '')
    .split(/[,\n]/)
    .map((v) => v.trim())
    .filter(Boolean);
}

function isoDate(value: unknown, itemIndex: number): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) throw new NodeOperationError(`Occurred At "${value}" is not a date`, { itemIndex });
  return date.toISOString();
}

const MAX_ACTION = 500;
const MAX_NOTE = 1000;
const PAGE = 200;

export const Landfall = defineNode({
  description: {
    name: 'landfall',
    displayName: 'Landfall',
    description: 'Open, attach and recover Landfall incidents from alerts, read rooms and timelines, add events and notes, record fixes applied outside Landfall and ping heartbeats',
    version: 1,
    kind: 'action',
    categories: ['Development', 'Communication'],
    icon: ICON,
    color: '#3B5B7A',
    subtitle: '{{operation}}: {{resource}}',
    documentationUrl: 'https://landfalls.ai',
    keywords: ['landfall', 'incident', 'war room', 'alert', 'oncall', 'runbook', 'heartbeat'],
    usableAsTool: true,
    // Opening, writing and pinging are at most once over a broker; read operations opt back in with `idempotent: true`.
    idempotent: false,
    toolDescription:
      'Landfall incident response: open an incident from an alert (deduplicated by dedupKey) or recover it, declare an incident, read an incident\'s state, list incidents, read or append timeline events and notes, record that a suggested remediation was applied outside Landfall, and ping a heartbeat.',
    inputs: [{ type: 'main' }],
    outputs: [{ type: 'main' }],
    credentials: [
      { name: 'landfallApi', required: true, displayOptions: { hide: { resource: ['heartbeat'] } } },
      { name: 'landfallHeartbeatApi', required: true, displayOptions: { show: { resource: ['heartbeat'] } } },
    ],
    properties: [
      {
        name: 'resource',
        displayName: 'Resource',
        type: 'options',
        noDataExpression: true,
        default: 'incident',
        options: [
          { name: 'Heartbeat', value: 'heartbeat' },
          { name: 'Incident', value: 'incident' },
          { name: 'Remediation', value: 'remediation' },
          { name: 'Timeline', value: 'timeline' },
        ],
      },
      {
        name: 'operation',
        displayName: 'Operation',
        type: 'options',
        noDataExpression: true,
        default: 'openFromAlert',
        displayOptions: { show: { resource: ['incident'] } },
        options: [
          { name: 'Declare', value: 'declare', description: 'Declare an incident (POST /incidents)', action: 'Declare an incident' },
          { name: 'Get', value: 'get', description: 'Get the folded state of an incident', action: 'Get an incident', idempotent: true },
          { name: 'Get Room', value: 'getRoom', description: 'The incident and its whole timeline in one item: the input of Landflow\'s "Make a runbook" (POST /api/runbooks/draft)', action: 'Get a room with its timeline', idempotent: true },
          { name: 'Get Many', value: 'getAll', description: 'List incidents', action: 'Get many incidents', idempotent: true },
          { name: 'Open Manually', value: 'openManually', description: 'Open a room through the manual trigger route (never suppressed, no dedup)', action: 'Open an incident manually' },
          { name: 'Open From Alert', value: 'openFromAlert', description: 'Send an alert to Landfall; it opens a room, attaches to an open one with the same dedup key, or ignores it', action: 'Open an incident from an alert' },
          { name: 'Recover', value: 'recover', description: 'Send the recovery of an alert; Landfall records it but never closes the room', action: 'Send an alert recovery' },
        ],
      },
      {
        name: 'operation',
        displayName: 'Operation',
        type: 'options',
        noDataExpression: true,
        default: 'getEvents',
        displayOptions: { show: { resource: ['timeline'] } },
        options: [
          { name: 'Add Event', value: 'addEvent', description: 'Append an event; expectedSeq is read for you and retried once on a conflict', action: 'Add a timeline event' },
          { name: 'Add Note', value: 'addNote', description: 'Post a chat message in the room', action: 'Add a note' },
          { name: 'Add Runbook Link', value: 'addRunbookLink', description: 'Post a note in the room that names a Landflow runbook and links to it (Landfall has no field for a link on an alert, so it goes on the timeline)', action: 'Add a runbook link' },
          { name: 'Get Events', value: 'getEvents', description: 'Read timeline events', action: 'Get timeline events', idempotent: true },
        ],
      },
      {
        name: 'operation',
        displayName: 'Operation',
        type: 'options',
        noDataExpression: true,
        default: 'recordAppliedExternally',
        displayOptions: { show: { resource: ['remediation'] } },
        options: [
          { name: 'Record Applied Externally', value: 'recordAppliedExternally', description: 'Record that a suggested fix was applied outside Landfall', action: 'Record a fix applied outside Landfall' },
        ],
      },
      {
        name: 'operation',
        displayName: 'Operation',
        type: 'options',
        noDataExpression: true,
        default: 'ping',
        displayOptions: { show: { resource: ['heartbeat'] } },
        options: [{ name: 'Ping', value: 'ping', description: 'Ping a heartbeat so Landfall knows the job is alive', action: 'Ping a heartbeat' }],
      },

      // Incident: open / recover / manual
      { name: 'title', displayName: 'Title', type: 'string', required: true, default: '', displayOptions: show('incident', ['openFromAlert', 'recover', 'openManually']) },
      { name: 'title', displayName: 'Title', type: 'string', default: '', displayOptions: show('incident', ['declare']), description: 'Optional; Landfall names the room when empty' },
      {
        name: 'severity',
        displayName: 'Severity',
        type: 'options',
        default: 'sev3',
        options: SEVERITIES,
        displayOptions: show('incident', ['openFromAlert', 'recover']),
        description: 'Landfall proposes this severity; a person confirms it in the room',
      },
      {
        name: 'severity',
        displayName: 'Severity',
        type: 'options',
        default: '',
        options: [{ name: 'Not Set', value: '' }, ...SEVERITIES],
        displayOptions: show('incident', ['declare', 'openManually']),
      },
      { name: 'dedupKey', displayName: 'Dedup Key', type: 'string', required: true, default: '', displayOptions: show('incident', ['recover']), description: 'The dedupKey the alert was opened with' },
      { name: 'description', displayName: 'Description', type: 'string', default: '', typeOptions: { rows: 3 }, displayOptions: show('incident', ['declare']) },
      { name: 'entityHint', displayName: 'Entity Hint', type: 'string', default: '', placeholder: 'service:checkout', displayOptions: show('incident', ['openManually']) },
      {
        name: 'additionalFields',
        displayName: 'Additional Fields',
        type: 'collection',
        default: {},
        placeholder: 'Add Field',
        displayOptions: show('incident', ['openFromAlert']),
        values: alertFields(true),
      },
      {
        name: 'additionalFields',
        displayName: 'Additional Fields',
        type: 'collection',
        default: {},
        placeholder: 'Add Field',
        displayOptions: show('incident', ['recover']),
        values: alertFields(false),
      },

      // Incident: get / getAll
      incidentId('incident', ['get']),
      { name: 'throughSeq', displayName: 'Through Seq', type: 'number', default: -1, typeOptions: { minValue: -1, numberPrecision: 0 }, displayOptions: show('incident', ['get']), description: 'State as of this timeline seq (-1: the latest)' },
      { name: 'returnAll', displayName: 'Return All', type: 'boolean', default: false, displayOptions: show('incident', ['getAll']), description: 'Whether to return all results or only up to a limit' },
      {
        name: 'limit',
        displayName: 'Limit',
        type: 'number',
        default: 50,
        typeOptions: { minValue: 1, maxValue: 200, numberPrecision: 0 },
        displayOptions: show('incident', ['getAll'], { returnAll: [false] }),
        description: 'Max number of results to return',
      },
      {
        name: 'filters',
        displayName: 'Filters',
        type: 'collection',
        default: {},
        placeholder: 'Add Filter',
        displayOptions: show('incident', ['getAll']),
        values: [
          {
            name: 'status',
            displayName: 'Status',
            type: 'options',
            default: 'open',
            options: [
              { name: 'Open', value: 'open' },
              { name: 'Closed', value: 'closed' },
              { name: 'All', value: 'all' },
            ],
          },
          { name: 'q', displayName: 'Search', type: 'string', default: '', description: 'Free-text search over incidents' },
        ],
      },

      // Timeline
      incidentId('timeline', ['getEvents', 'addEvent', 'addNote', 'addRunbookLink']),
      {
        name: 'returnAll',
        displayName: 'Return All',
        type: 'boolean',
        default: false,
        displayOptions: show('timeline', ['getEvents']),
        description: 'Whether to return every event after Since Seq or only up to a limit',
      },
      {
        name: 'limit',
        displayName: 'Limit',
        type: 'number',
        default: 50,
        typeOptions: { minValue: 1, maxValue: 500, numberPrecision: 0 },
        displayOptions: show('timeline', ['getEvents'], { returnAll: [false] }),
        description: 'Max number of events. Landfall returns the newest ones, in ascending order',
      },
      {
        name: 'eventOptions',
        displayName: 'Options',
        type: 'collection',
        default: {},
        placeholder: 'Add Option',
        displayOptions: show('timeline', ['getEvents']),
        values: [
          { name: 'sinceSeq', displayName: 'Since Seq', type: 'number', default: 0, typeOptions: { minValue: 0, numberPrecision: 0 }, description: 'Only events with a seq greater than this' },
          { name: 'beforeSeq', displayName: 'Before Seq', type: 'number', default: 0, typeOptions: { minValue: 0, numberPrecision: 0 }, description: 'Only events with a seq below this (page backwards)' },
        ],
      },
      { name: 'eventType', displayName: 'Event Type', type: 'string', required: true, default: '', placeholder: 'chat.message', displayOptions: show('timeline', ['addEvent']), description: 'Landfall refuses agent.step, incident.triggered, severity.proposed and a few other server-owned types' },
      { name: 'payload', displayName: 'Payload (JSON)', type: 'json', default: '{}', typeOptions: { rows: 6 }, displayOptions: show('timeline', ['addEvent']) },
      { name: 'text', displayName: 'Text', type: 'string', required: true, default: '', typeOptions: { rows: 3 }, displayOptions: show('timeline', ['addNote']), description: 'Posted as a chat.message event, as the member who owns the API key' },

      { name: 'runbookName', displayName: 'Runbook Name', type: 'string', default: '', displayOptions: show('timeline', ['addRunbookLink']), description: 'The runbook\'s name (the Find Runbook node\'s runbook.name)' },
      { name: 'runbookUrl', displayName: 'Runbook URL', type: 'string', required: true, default: '', displayOptions: show('timeline', ['addRunbookLink']), description: 'Where responders open it (the Find Runbook node\'s runbook.url, made absolute)' },

      // Remediation
      incidentId('remediation', ['recordAppliedExternally']),
      {
        name: 'sourceSeq',
        displayName: 'Source Seq',
        type: 'number',
        required: true,
        default: 0,
        typeOptions: { minValue: 0, numberPrecision: 0 },
        displayOptions: show('remediation', ['recordAppliedExternally']),
        description: 'The seq of the remediation.proposed (or edge.action.proposed) event that was applied',
      },
      {
        name: 'additionalFields',
        displayName: 'Additional Fields',
        type: 'collection',
        default: {},
        placeholder: 'Add Field',
        displayOptions: show('remediation', ['recordAppliedExternally']),
        values: [
          { name: 'remediationId', displayName: 'Remediation ID', type: 'string', default: '', description: 'Landfall fills it in from the suggestion when empty' },
          { name: 'action', displayName: 'Action', type: 'string', default: '', description: `What was done, one line (up to ${MAX_ACTION} characters)` },
          { name: 'note', displayName: 'Note', type: 'string', default: '', typeOptions: { rows: 3 }, description: `A note or ticket link (up to ${MAX_NOTE} characters)` },
        ],
      },

      // Heartbeat
      { name: 'heartbeatName', displayName: 'Heartbeat Name', type: 'string', required: true, default: '', displayOptions: show('heartbeat', ['ping']) },
    ],
  },
  async execute(ctx) {
    const api: ApiContext = { http: ctx.http, ...(ctx.signal && { signal: ctx.signal }) };
    return mapItems(ctx, async (i) => {
      const resource = ctx.getNodeParameter<string>('resource', i);
      const operation = ctx.getNodeParameter<string>('operation', i);
      if (resource === 'heartbeat') {
        if (operation !== 'ping') throw unsupported(resource, operation);
        const name = requireString(ctx, 'heartbeatName', 'Heartbeat Name', i);
        await pingHeartbeat(api, ctx.getCredentials<HeartbeatCredentials>('landfallHeartbeatApi'), name);
        return { ok: true, heartbeat: name };
      }
      const credentials = ctx.getCredentials<LandfallCredentials>('landfallApi');
      if (resource === 'incident') return incidentOperation(ctx, api, credentials, operation, i);
      const org = new Org(api, credentials);
      if (resource === 'timeline') return timelineOperation(ctx, org, operation, i);
      if (resource === 'remediation' && operation === 'recordAppliedExternally') {
        const fields = ctx.getNodeParameter<JsonObject>('additionalFields', i, {}) ?? {};
        const payload: JsonObject = { sourceSeq: Number(ctx.getNodeParameter('sourceSeq', i)) };
        if (!Number.isInteger(payload.sourceSeq) || (payload.sourceSeq as number) < 0) throw new NodeOperationError('Source Seq must be a whole number of 0 or more', { itemIndex: i });
        for (const [key, max] of [['action', MAX_ACTION], ['note', MAX_NOTE]] as const) {
          const text = String(fields[key] ?? '').trim();
          if (text.length > max) throw new NodeOperationError(`${key === 'action' ? 'Action' : 'Note'} is ${text.length} characters; Landfall accepts up to ${max}`, { itemIndex: i });
          if (text) payload[key] = text;
        }
        if (String(fields.remediationId ?? '').trim()) payload.remediationId = String(fields.remediationId).trim();
        return await org.addEvent(requireString(ctx, 'incidentId', 'Incident ID', i), 'remediation.applied-externally', payload);
      }
      throw unsupported(resource, operation);
    });
  },
});

async function incidentOperation(ctx: IExecuteContext, api: ApiContext, credentials: LandfallCredentials, operation: string, i: number): Promise<JsonObject | JsonObject[]> {
  switch (operation) {
    case 'openFromAlert':
    case 'recover': {
      const fields = ctx.getNodeParameter<JsonObject>('additionalFields', i, {}) ?? {};
      const connectionId = String(fields.connectionId || credentials.connectionId || '').trim();
      if (!connectionId) throw new NodeOperationError('A Connection ID is required: set it in the credential or under Additional Fields', { itemIndex: i });
      const recovery = operation === 'recover';
      const dedupKey = recovery ? requireString(ctx, 'dedupKey', 'Dedup Key', i) : String(fields.dedupKey ?? '').trim();
      const hints = parseHints(fields.entityHints);
      const occurredAt = isoDate(fields.occurredAt, i);
      const body: JsonObject = {
        landfallSource: 'remote',
        connectionId,
        title: requireString(ctx, 'title', 'Title', i),
        severity: ctx.getNodeParameter<Severity>('severity', i, 'sev3'),
        kind: recovery ? 'recovery' : 'trigger',
        ...(occurredAt && { occurredAt }),
        ...(hints.length && { entityHints: hints }),
        ...(dedupKey && { dedupKey }),
        ...(String(fields.summary ?? '').trim() && { summary: String(fields.summary) }),
        ...(String(fields.url ?? '').trim() && { url: String(fields.url).trim() }),
      };
      const result = await postTrigger(api, credentials, body);
      return { ...result, opened: result.outcome === 'opened' };
    }
    case 'openManually': {
      const severity = String(ctx.getNodeParameter('severity', i, '') ?? '');
      const hint = String(ctx.getNodeParameter('entityHint', i, '') ?? '').trim();
      const result = await new Org(api, credentials).declareTrigger({
        title: requireString(ctx, 'title', 'Title', i),
        ...(hint && { entityHint: hint }),
        ...(severity && { severity }),
      });
      return { ...result, opened: result.outcome === 'opened' };
    }
    case 'declare': {
      const title = String(ctx.getNodeParameter('title', i, '') ?? '').trim();
      const severity = String(ctx.getNodeParameter('severity', i, '') ?? '');
      const description = String(ctx.getNodeParameter('description', i, '') ?? '').trim();
      return await new Org(api, credentials).declareIncident({ ...(title && { title }), ...(severity && { severity }), ...(description && { description }) });
    }
    case 'get': {
      const through = Number(ctx.getNodeParameter('throughSeq', i, -1));
      return await new Org(api, credentials).getState(requireString(ctx, 'incidentId', 'Incident ID', i), through >= 0 ? through : undefined);
    }
    case 'getRoom': {
      const org = new Org(api, credentials);
      const id = requireString(ctx, 'incidentId', 'Incident ID', i);
      const { state } = await org.getState(id);
      // Without a limit Landfall returns every event.
      const events = await org.getEvents(id);
      return { incident: { id, ...(state as JsonObject) }, events };
    }
    case 'getAll': {
      const org = new Org(api, credentials);
      const returnAll = ctx.getNodeParameter<boolean>('returnAll', i, false);
      const max = returnAll ? Infinity : Math.max(1, Number(ctx.getNodeParameter('limit', i, 50)) || 50);
      const filters = ctx.getNodeParameter<JsonObject>('filters', i, {}) ?? {};
      const status = filters.status ? String(filters.status) : undefined;
      const q = filters.q ? String(filters.q) : undefined;
      const items: JsonObject[] = [];
      let cursor: string | undefined;
      do {
        const page = await org.listIncidents({ limit: Math.min(PAGE, max - items.length), ...(cursor && { cursor }), ...(status && { status }), ...(q && { q }) });
        items.push(...page.items);
        cursor = page.nextCursor ?? undefined;
      } while (cursor && items.length < max);
      return items.slice(0, max);
    }
    default:
      throw unsupported('incident', operation);
  }
}

async function timelineOperation(ctx: IExecuteContext, org: Org, operation: string, i: number): Promise<JsonObject | JsonObject[]> {
  const id = requireString(ctx, 'incidentId', 'Incident ID', i);
  switch (operation) {
    case 'getEvents': {
      const options = ctx.getNodeParameter<JsonObject>('eventOptions', i, {}) ?? {};
      const returnAll = ctx.getNodeParameter<boolean>('returnAll', i, false);
      const sinceSeq = options.sinceSeq !== undefined && options.sinceSeq !== '' ? Number(options.sinceSeq) : undefined;
      const beforeSeq = options.beforeSeq !== undefined && options.beforeSeq !== '' && Number(options.beforeSeq) > 0 ? Number(options.beforeSeq) : undefined;
      // Without `limit` Landfall returns everything after sinceSeq; with it, the newest `limit` of them.
      const limit = returnAll ? undefined : Math.min(500, Math.max(1, Number(ctx.getNodeParameter('limit', i, 50)) || 50));
      return await org.getEvents(id, { ...(sinceSeq !== undefined && { sinceSeq }), ...(beforeSeq !== undefined && { beforeSeq }), ...(limit && { limit }) });
    }
    case 'addEvent': {
      const type = requireString(ctx, 'eventType', 'Event Type', i);
      const payload = jsonParameter(ctx.getNodeParameter('payload', i, '{}'), 'Payload') ?? {};
      if (typeof payload !== 'object' || Array.isArray(payload) || payload === null) throw new NodeOperationError('Payload must be a JSON object', { itemIndex: i });
      return await org.addEvent(id, type, payload as JsonObject);
    }
    case 'addNote':
      return await org.addEvent(id, 'chat.message', { text: requireString(ctx, 'text', 'Text', i) });
    case 'addRunbookLink': {
      const url = requireString(ctx, 'runbookUrl', 'Runbook URL', i);
      if (!/^https?:\/\//i.test(url)) throw new NodeOperationError('Runbook URL must be an absolute http(s) link', { itemIndex: i });
      const name = String(ctx.getNodeParameter('runbookName', i, '') ?? '').trim();
      return await org.addEvent(id, 'chat.message', { text: `Runbook${name ? `: ${name}` : ''}\n${url}` });
    }
    default:
      throw unsupported('timeline', operation);
  }
}
