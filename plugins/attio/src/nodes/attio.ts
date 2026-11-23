import { ACTIVITY_ITEM_SCHEMA, defineNode, NodeOperationError, type IExecuteContext, type JsonObject, type PropertyDescriptor } from '@landflow/sdk';
import { activityOptions, AttioLookup, entriesOf, entryItem, isoTime, latestActor, nameOf, OPTION_PROPERTIES, recordItem, valueText, type ActivityOptions } from '../activity';
import { asArray, asObject, asString, attioCall, attioCredentials, mapItems, type AttioCredentials } from '../api';

/** Records or entries read per call, and the most one scan reads before it stops (and says so). */
const PAGE = 200;
const MAX_SCAN = 5000;
const DAY_MS = 24 * 3600 * 1000;

const show = (resource: string, ...operations: string[]) => ({ show: { resource: [resource], ...(operations.length && { operation: operations }) } });
const text = (name: string, displayName: string, extra: Partial<PropertyDescriptor> = {}): PropertyDescriptor => ({ name, displayName, type: 'string', default: '', ...extra }) as PropertyDescriptor;

/** Since: an ISO time or a cursor of an earlier item (also an ISO time); empty is the last 24 hours. */
export function sinceMs(value: unknown): number {
  const raw = String(value ?? '').trim();
  if (!raw) return Date.now() - DAY_MS;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) throw new NodeOperationError(`Since is not a time: ${raw}`, { description: 'Use an ISO time such as 2026-11-12T08:00:00Z, or the cursor of an earlier item.' });
  return ms;
}

type Detect = 'any' | 'stage' | 'created';

interface Found {
  row: JsonObject;
  time: string;
}

/**
 * Attio has no "updated at" on records or entries, only `created_at` and a per-value `active_from` (when each
 * attribute got its current value). So "changed since" is: created (server filter on created_at), stage changed (server
 * filter on the status attribute's active_from) or any value changed (read every row and take its newest active_from).
 * Rows come back oldest first by that time.
 */
async function changedRows(
  ctx: IExecuteContext,
  call: AttioLookup['call'],
  path: string,
  valuesKey: 'values' | 'entry_values',
  since: number,
  detect: Detect,
  stageAttribute: string,
  serverCreatedFilter: boolean,
): Promise<Found[]> {
  const sinceIso = new Date(since).toISOString();
  let filter: JsonObject | undefined;
  if (detect === 'created' && serverCreatedFilter) filter = { created_at: { $gte: sinceIso } };
  if (detect === 'stage') filter = { [stageAttribute]: { active_from: { $gte: sinceIso } } };
  const found: Found[] = [];
  let scanned = 0;
  for (let offset = 0; ; offset += PAGE) {
    const page = asArray((await call('POST', path, { body: { ...(filter && { filter }), limit: PAGE, offset } })).data).map(asObject).filter((r): r is JsonObject => Boolean(r));
    for (const row of page) {
      const time = detect === 'created' ? isoTime(row.created_at) : latestTime(row, valuesKey);
      if (time && Date.parse(time) > since) found.push({ row, time });
    }
    scanned += page.length;
    if (page.length < PAGE) break;
    if (scanned >= MAX_SCAN) {
      ctx.logger.warn(`stopped after ${scanned} rows: narrow the query with Created or Stage Changed detection, or a later Since`);
      break;
    }
  }
  return found.sort((a, b) => Date.parse(a.time) - Date.parse(b.time) || JSON.stringify(a.row.id).localeCompare(JSON.stringify(b.row.id)));
}

function latestTime(row: JsonObject, valuesKey: 'values' | 'entry_values'): string | undefined {
  let latest = Date.parse(String(row.created_at ?? ''));
  for (const entries of Object.values(asObject(row[valuesKey]) ?? {})) {
    for (const entry of asArray(entries)) {
      const from = Date.parse(String(asObject(entry)?.active_from ?? ''));
      if (Number.isFinite(from) && (!Number.isFinite(latest) || from > latest)) latest = from;
    }
  }
  return Number.isFinite(latest) ? new Date(latest).toISOString() : undefined;
}

const limitOf = (ctx: IExecuteContext, i: number) => (ctx.getNodeParameter<boolean>('returnAll', i, false) ? Infinity : Math.max(1, Number(ctx.getNodeParameter('limit', i, 50)) || 50));

async function recordsChangedSince(ctx: IExecuteContext, lookup: AttioLookup, i: number, options: ActivityOptions): Promise<JsonObject[]> {
  const object = required(ctx, 'object', 'Object', i);
  const detect = ctx.getNodeParameter<Detect>('detect', i, 'any');
  const rows = (await changedRows(ctx, lookup.call.bind(lookup), `/objects/${object}/records/query`, 'values', sinceMs(ctx.getNodeParameter('since', i, '')), detect, options.stageAttribute, true)).slice(0, limitOf(ctx, i));
  const items: JsonObject[] = [];
  for (const { row, time } of rows) {
    items.push(
      recordItem({
        record: row,
        objectSlug: object,
        customer: await lookup.customerOf(object, row),
        actorEmail: await lookup.actorEmail(latestActor(row, 'values')),
        options,
        cursor: true,
        time,
      }),
    );
  }
  return items;
}

async function entriesChangedSince(ctx: IExecuteContext, lookup: AttioLookup, i: number, options: ActivityOptions): Promise<JsonObject[]> {
  const listId = required(ctx, 'list', 'List', i);
  const detect = ctx.getNodeParameter<Detect>('detect', i, 'any');
  const list = await lookup.list(listId);
  const rows = (await changedRows(ctx, lookup.call.bind(lookup), `/lists/${listId}/entries/query`, 'entry_values', sinceMs(ctx.getNodeParameter('since', i, '')), detect, options.stageAttribute, false)).slice(0, limitOf(ctx, i));
  const items: JsonObject[] = [];
  for (const { row, time } of rows) {
    const parentSlug = await lookup.objectSlug(String(row.parent_object ?? ''));
    const parent = await lookup.record(parentSlug, String(row.parent_record_id ?? ''));
    items.push(
      entryItem({
        entry: row,
        list,
        parent,
        parentSlug,
        customer: await lookup.customerOf(parentSlug, parent),
        actorEmail: await lookup.actorEmail(latestActor(row, 'entry_values')),
        options,
        cursor: true,
        time,
      }),
    );
  }
  return items;
}

/** Record → Get: the record as an activity item plus `text`, its attribute values and recent notes. */
async function getRecord(ctx: IExecuteContext, lookup: AttioLookup, i: number, options: ActivityOptions): Promise<JsonObject> {
  const object = required(ctx, 'object', 'Object', i);
  const id = required(ctx, 'recordId', 'Record ID', i);
  const record = await lookup.record(object, id);
  if (!record) throw new NodeOperationError(`No ${object} record ${id}`, { itemIndex: i });
  const values = asObject(record.values);
  const lines = [`${nameOf(record) ?? id} (${object})`];
  for (const slug of Object.keys(values ?? {})) {
    const value = entriesOf(values, slug).map(valueText).filter(Boolean).join(', ');
    if (value) lines.push(`${slug}: ${value}`);
  }
  try {
    const notes = asArray((await lookup.call('GET', '/notes', { query: { parent_object: object, parent_record_id: id, limit: 50 } })).data)
      .map(asObject)
      .filter((n): n is JsonObject => Boolean(n))
      .sort((a, b) => Date.parse(String(b.created_at)) - Date.parse(String(a.created_at)))
      .slice(0, 5);
    if (notes.length) {
      lines.push('', 'Recent notes:');
      for (const note of notes) lines.push(`- ${String(note.title ?? 'Note')} (${String(isoTime(note.created_at) ?? '')}): ${String(note.content_plaintext ?? '').trim()}`);
    }
  } catch (error) {
    ctx.logger.warn(`could not read the notes (note:read?): ${(error as Error).message}`);
  }
  const item = recordItem({
    record,
    objectSlug: object,
    customer: await lookup.customerOf(object, record),
    actorEmail: await lookup.actorEmail(latestActor(record, 'values')),
    options,
  });
  return { ...item, text: lines.join('\n') };
}

function required(ctx: IExecuteContext, name: string, label: string, i: number): string {
  const value = String(ctx.getNodeParameter(name, i, '') ?? '').trim();
  if (!value) throw new NodeOperationError(`Set ${label}`, { itemIndex: i });
  return value;
}

const csv = (value: unknown) => String(value ?? '').split(/[,\n]+/).map((s) => s.trim()).filter(Boolean);

function jsonObjectParameter(value: unknown, label: string): JsonObject | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'object') return value as JsonObject;
  try {
    const parsed = JSON.parse(String(value));
    if (asObject(parsed)) return parsed as JsonObject;
  } catch {
    // fall through to the error
  }
  throw new NodeOperationError(`${label} is not a JSON object`);
}

const changedSinceOps = ['getManyChangedSince'];

export const Attio = defineNode({
  description: {
    name: 'attio',
    displayName: 'Attio',
    description: 'Read Attio records and pipeline entries as activity items (get one, or list what changed since a time), list workspace members, and create notes, tasks and list entries',
    version: 1,
    kind: 'action',
    categories: ['Sales'],
    icon: 'file:attio.svg',
    color: '#4f5bd5',
    subtitle: '{{operation}}: {{resource}}',
    documentationUrl: 'https://docs.attio.com/rest-api/overview',
    keywords: ['attio', 'crm', 'deal', 'pipeline', 'company', 'person', 'note', 'task', 'activity', 'sales'],
    usableAsTool: true,
    // Creating notes, tasks and entries is at most once over a broker; reads opt back in with `idempotent: true`.
    idempotent: false,
    toolDescription:
      'Read an Attio CRM record with its values and recent notes, list the records or pipeline entries that changed since a time, list workspace members with email, add a note to a record, create a task, or add a record to a list. It cannot delete or merge anything.',
    inputs: [{ type: 'main' }],
    outputs: [{ type: 'main' }],
    credentials: [
      { name: 'attioApi', required: true, displayOptions: { show: { authentication: ['accessToken'] } } },
      { name: 'attioOAuth2Api', required: true, displayOptions: { show: { authentication: ['oAuth2'] } } },
    ],
    properties: [
      {
        name: 'authentication',
        displayName: 'Authentication',
        type: 'options',
        noDataExpression: true,
        default: 'accessToken',
        options: [
          { name: 'Access Token', value: 'accessToken', description: 'A workspace access token (API key) pasted from Attio' },
          { name: 'OAuth2', value: 'oAuth2', description: 'Connect with Attio' },
        ],
      },
      {
        name: 'resource',
        displayName: 'Resource',
        type: 'options',
        noDataExpression: true,
        default: 'record',
        options: [
          { name: 'List Entry', value: 'listEntry' },
          { name: 'Note', value: 'note' },
          { name: 'Record', value: 'record' },
          { name: 'Task', value: 'task' },
          { name: 'Workspace Member', value: 'workspaceMember' },
        ],
      },
      {
        name: 'operation',
        displayName: 'Operation',
        type: 'options',
        noDataExpression: true,
        default: 'get',
        displayOptions: show('record'),
        options: [
          { name: 'Add to List', value: 'addToList', action: 'Add a record to a list', description: 'Add a record to a list (a deal to a pipeline) as a new entry' },
          { name: 'Get', value: 'get', action: 'Get a record', description: 'A record as an activity item, plus text with its values and recent notes', idempotent: true, outputSchema: ACTIVITY_ITEM_SCHEMA },
          {
            name: 'Get Many Changed Since',
            value: 'getManyChangedSince',
            action: 'Get records changed since a time',
            description: 'Records of an object that were created or changed since a time, as activity items (oldest first)',
            idempotent: true,
            outputSchema: ACTIVITY_ITEM_SCHEMA,
          },
        ],
      },
      {
        name: 'operation',
        displayName: 'Operation',
        type: 'options',
        noDataExpression: true,
        default: 'getManyChangedSince',
        displayOptions: show('listEntry'),
        options: [
          {
            name: 'Get Many Changed Since',
            value: 'getManyChangedSince',
            action: 'Get list entries changed since a time',
            description: 'Entries of a list (a sales pipeline) that were created or changed since a time, as activity items (oldest first)',
            idempotent: true,
            outputSchema: ACTIVITY_ITEM_SCHEMA,
          },
        ],
      },
      { name: 'operation', displayName: 'Operation', type: 'options', noDataExpression: true, default: 'create', displayOptions: show('note'), options: [{ name: 'Create', value: 'create', action: 'Create a note', description: 'Add a note to a record' }] },
      { name: 'operation', displayName: 'Operation', type: 'options', noDataExpression: true, default: 'create', displayOptions: show('task'), options: [{ name: 'Create', value: 'create', action: 'Create a task', description: 'Create a task, optionally linked to a record' }] },
      {
        name: 'operation',
        displayName: 'Operation',
        type: 'options',
        noDataExpression: true,
        default: 'getAll',
        displayOptions: show('workspaceMember'),
        options: [{ name: 'Get Many', value: 'getAll', action: 'Get workspace members', description: 'The members of the workspace, with email', idempotent: true }],
      },
      text('object', 'Object', {
        default: 'companies',
        required: true,
        placeholder: 'companies, people or deals',
        displayOptions: { show: { resource: ['record', 'note'], operation: ['get', 'getManyChangedSince', 'addToList', 'create'] } },
        description: 'The object\'s API slug (companies, people, deals or a custom object) or ID',
      }),
      text('recordId', 'Record ID', { required: true, displayOptions: { show: { resource: ['record', 'note'], operation: ['get', 'addToList', 'create'] } }, description: 'The record\'s UUID' }),
      text('list', 'List', {
        required: true,
        placeholder: 'sales_pipeline',
        displayOptions: show('listEntry', ...changedSinceOps),
        description: 'The list\'s API slug or ID, such as a sales pipeline',
      }),
      text('list', 'List', {
        required: true,
        placeholder: 'sales_pipeline',
        displayOptions: show('record', 'addToList'),
        description: 'The list\'s API slug or ID to add the record to',
      }),
      text('since', 'Since', {
        placeholder: '2026-11-12T08:00:00Z',
        displayOptions: show('record', ...changedSinceOps),
        description: 'Rows changed after this ISO time or the cursor of an earlier item. Empty: the last 24 hours.',
      }),
      text('since', 'Since', {
        placeholder: '2026-11-12T08:00:00Z',
        displayOptions: show('listEntry', ...changedSinceOps),
        description: 'Rows changed after this ISO time or the cursor of an earlier item. Empty: the last 24 hours.',
      }),
      {
        name: 'detect',
        displayName: 'Changes To Look For',
        type: 'options',
        default: 'any',
        displayOptions: { show: { resource: ['record', 'listEntry'], operation: changedSinceOps } },
        description: 'Attio has no updated-at timestamp on records and entries, so this picks how a change is found',
        options: [
          { name: 'Any Value Changed (Reads Every Row)', value: 'any', description: 'Reads all rows and takes the newest time any value was set. Complete, but one call per 200 rows.' },
          { name: 'Stage Changed (Server Filter)', value: 'stage', description: 'Only rows whose stage (the Stage Attribute) changed since: a deal moved. One filtered query.' },
          { name: 'Created (Server Filter)', value: 'created', description: 'Only rows created since. Cheapest; misses edits of older rows.' },
        ],
      },
      {
        name: 'returnAll',
        displayName: 'Return All',
        type: 'boolean',
        default: false,
        displayOptions: { show: { resource: ['record', 'listEntry'], operation: changedSinceOps } },
        description: 'Whether to return all results or only up to a limit',
      },
      {
        name: 'limit',
        displayName: 'Limit',
        type: 'number',
        default: 50,
        typeOptions: { minValue: 1, numberPrecision: 0 },
        displayOptions: { show: { resource: ['record', 'listEntry'], operation: changedSinceOps, returnAll: [false] } },
        description: 'Max number of results to return (the oldest first; pass the last cursor back as Since for the next batch)',
      },
      {
        name: 'activityOptions',
        displayName: 'Options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        displayOptions: { show: { resource: ['record', 'listEntry'], operation: ['get', ...changedSinceOps] } },
        values: [...OPTION_PROPERTIES],
      },
      text('title', 'Title', { required: true, displayOptions: show('note', 'create'), description: 'The note\'s title (plain text)' }),
      { name: 'content', displayName: 'Content', type: 'string', default: '', typeOptions: { rows: 4 }, displayOptions: show('note', 'create'), description: 'The note\'s text' },
      {
        name: 'format',
        displayName: 'Format',
        type: 'options',
        default: 'plaintext',
        displayOptions: show('note', 'create'),
        options: [
          { name: 'Plain Text', value: 'plaintext' },
          { name: 'Markdown', value: 'markdown' },
        ],
      },
      { name: 'taskContent', displayName: 'Task', type: 'string', default: '', required: true, typeOptions: { rows: 2 }, displayOptions: show('task', 'create'), description: 'What to do (plain text, up to 2000 characters)' },
      text('deadline', 'Deadline', { placeholder: '2026-11-20T09:00:00Z', displayOptions: show('task', 'create'), description: 'ISO time the task is due. Empty: no deadline.' }),
      text('linkedObject', 'Linked Object', { placeholder: 'companies', displayOptions: show('task', 'create'), description: 'The object of the record to link (with Linked Record ID). Empty: no link.' }),
      text('linkedRecordId', 'Linked Record ID', { displayOptions: show('task', 'create') }),
      text('assignees', 'Assignee Emails', { placeholder: 'ana@example.com, ben@example.com', displayOptions: show('task', 'create'), description: 'Workspace members to assign, by email (comma-separated)' }),
      {
        name: 'entryValues',
        displayName: 'Entry Values (JSON)',
        type: 'json',
        default: '',
        displayOptions: show('record', 'addToList'),
        description: 'Attribute values of the new entry, keyed by API slug, e.g. {"stage": "Lead"}. Empty: none.',
      },
    ],
  },
  async execute(ctx) {
    const credentials: AttioCredentials = attioCredentials(ctx, ctx.getNodeParameter('authentication', 0, 'accessToken'));
    const lookup = new AttioLookup(ctx.http, credentials, undefined, (m) => ctx.logger.warn(m));
    const call = (method: string, path: string, options = {}) => attioCall(ctx.http, credentials, method, path, options);
    return mapItems(ctx, async (i) => {
      const resource = ctx.getNodeParameter<string>('resource', i);
      const operation = ctx.getNodeParameter<string>('operation', i);
      const options = activityOptions(asObject(ctx.getNodeParameter<JsonObject>('activityOptions', i, {})));
      const key = `${resource}.${operation}`;
      switch (key) {
        case 'record.get':
          return getRecord(ctx, lookup, i, options);
        case 'record.getManyChangedSince':
          return recordsChangedSince(ctx, lookup, i, options);
        case 'listEntry.getManyChangedSince':
          return entriesChangedSince(ctx, lookup, i, options);
        case 'workspaceMember.getAll':
          return asArray((await call('GET', '/workspace_members')).data)
            .map(asObject)
            .filter((m): m is JsonObject => Boolean(m))
            .map((m) => ({
              id: asString(asObject(m.id)?.workspace_member_id) ?? null,
              email: asString(m.email_address) ?? null,
              firstName: asString(m.first_name) ?? '',
              lastName: asString(m.last_name) ?? '',
              accessLevel: asString(m.access_level) ?? null,
              createdAt: asString(m.created_at) ?? null,
            }));
        case 'note.create': {
          const content = String(ctx.getNodeParameter('content', i, '') ?? '');
          const created = asObject((await call('POST', '/notes', {
            body: { data: { parent_object: required(ctx, 'object', 'Object', i), parent_record_id: required(ctx, 'recordId', 'Record ID', i), title: required(ctx, 'title', 'Title', i), format: ctx.getNodeParameter('format', i, 'plaintext'), content } },
          })).data);
          return { id: asString(asObject(created?.id)?.note_id) ?? null, parentObject: created?.parent_object ?? null, parentRecordId: created?.parent_record_id ?? null, title: created?.title ?? null, createdAt: created?.created_at ?? null };
        }
        case 'task.create': {
          const content = required(ctx, 'taskContent', 'Task', i);
          const object = String(ctx.getNodeParameter('linkedObject', i, '') ?? '').trim();
          const target = String(ctx.getNodeParameter('linkedRecordId', i, '') ?? '').trim();
          if (Boolean(object) !== Boolean(target)) throw new NodeOperationError('Set both Linked Object and Linked Record ID, or neither', { itemIndex: i });
          const deadline = String(ctx.getNodeParameter('deadline', i, '') ?? '').trim();
          const created = asObject((await call('POST', '/tasks', {
            body: {
              data: {
                content,
                format: 'plaintext',
                deadline_at: deadline ? new Date(sinceMs(deadline)).toISOString() : null,
                is_completed: false,
                linked_records: object ? [{ target_object: object, target_record_id: target }] : [],
                assignees: csv(ctx.getNodeParameter('assignees', i, '')).map((workspace_member_email_address) => ({ workspace_member_email_address })),
              },
            },
          })).data);
          return { id: asString(asObject(created?.id)?.task_id) ?? null, content: created?.content_plaintext ?? content, deadlineAt: created?.deadline_at ?? null, isCompleted: created?.is_completed ?? false, createdAt: created?.created_at ?? null };
        }
        case 'record.addToList': {
          const entryValues = jsonObjectParameter(ctx.getNodeParameter('entryValues', i, ''), 'Entry Values') ?? {};
          const created = asObject((await call('POST', `/lists/${required(ctx, 'list', 'List', i)}/entries`, {
            body: { data: { parent_record_id: required(ctx, 'recordId', 'Record ID', i), parent_object: required(ctx, 'object', 'Object', i), entry_values: entryValues } },
          })).data);
          return { entryId: asString(asObject(created?.id)?.entry_id) ?? null, listId: asString(asObject(created?.id)?.list_id) ?? null, parentRecordId: created?.parent_record_id ?? null, createdAt: created?.created_at ?? null };
        }
        default:
          throw new NodeOperationError(`Operation "${operation}" is not available for resource "${resource}"`, { itemIndex: i, description: 'Pick an operation from the list after changing the resource.' });
      }
    });
  },
});
