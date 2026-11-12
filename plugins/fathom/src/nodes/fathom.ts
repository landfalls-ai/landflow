import { ACTIVITY_ITEM_SCHEMA, defineCredentialType, defineNode, NodeOperationError, type IExecuteContext, type JsonObject, type PropertyDescriptor } from '@landflow/sdk';
import {
  DEFAULT_BASE_URL,
  fathomCall,
  fathomPages,
  meetingItems,
  meetingQuery,
  meetingsSince,
  meetingText,
  sinceIso,
  transcriptText,
  type Api,
  type FathomCredentials,
  type MappingOptions,
} from '../fathom';

export const fathomApi = defineCredentialType<FathomCredentials>({
  name: 'fathomApi',
  displayName: 'Fathom API',
  icon: 'file:fathom.svg',
  documentationUrl: 'https://developers.fathom.ai/quickstart',
  description:
    'An API key from Fathom (Settings → API Access), sent as the X-Api-Key header. Fathom also offers OAuth for public apps, but publishes no authorize URL, so there is no OAuth2 credential here. ' +
    'The key sees your own meetings and those shared with you.',
  properties: [
    { name: 'apiKey', displayName: 'API Key', type: 'string', required: true, typeOptions: { password: true }, description: 'Created in Fathom under Settings → API Access' },
    { name: 'baseUrl', displayName: 'Base URL', type: 'string', default: DEFAULT_BASE_URL, description: 'Change it only for a proxy or a test double' },
  ],
  async test(data, ctx) {
    try {
      await fathomCall({ http: ctx.http }, data, 'GET', '/teams', { retries: 0 });
      return { ok: true, message: 'Fathom accepted the API key' };
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
  },
});

export const credentialsOf = (ctx: { getCredentials: IExecuteContext['getCredentials'] }) => ctx.getCredentials<FathomCredentials>('fathomApi');

/** The options the meeting operations and the trigger share. */
export const MAPPING_OPTIONS: PropertyDescriptor[] = [
  {
    name: 'internalDomains',
    displayName: 'Internal Domains',
    type: 'string',
    default: '',
    placeholder: 'acme.com, acme.io',
    description: 'Email domains that are your own. The customerHint is the first invitee outside them. Empty: the recorder\'s own domain.',
  },
  {
    name: 'actionItemItems',
    displayName: 'Also Output One Item per Action Item',
    type: 'boolean',
    default: false,
    description: 'Whether each action item becomes its own activity item (kind work.action_item, assignee as actorEmail) after its meeting\'s item',
  },
];

export const mappingOf = (options: JsonObject, extra: Partial<MappingOptions> = {}): MappingOptions => ({
  internalDomains: String(options.internalDomains ?? ''),
  actionItemItems: options.actionItemItems === true,
  transcript: options.includeTranscript === true,
  ...extra,
});

const ACTIVITY_WITH_TEXT_SCHEMA: JsonObject = {
  ...ACTIVITY_ITEM_SCHEMA,
  properties: { ...(ACTIVITY_ITEM_SCHEMA.properties as JsonObject), text: { type: 'string', description: 'Summary, action items and (with Include Transcript) the transcript' } },
};

const only = (resource: string, ...operation: string[]) => ({ show: { resource: [resource], ...(operation.length && { operation }) } });
const listOps = (resource: string) => ({ show: { resource: [resource], operation: ['getAll'] } });

const asArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const csv = (v: unknown) => String(v ?? '').split(/[,\n]+/).map((s) => s.trim()).filter(Boolean);

/** Fathom: meetings as activity items, summaries and transcripts, teams, team members and users. Everything the API offers is a read. */
export const Fathom = defineNode({
  description: {
    name: 'fathom',
    displayName: 'Fathom',
    description: 'Read Fathom meetings (summary, action items, opt-in transcript) as activity items, plus teams, team members and users',
    version: 1,
    kind: 'action',
    categories: ['Productivity'],
    icon: 'file:fathom.svg',
    color: '#00b386',
    subtitle: '{{resource}}: {{operation}}',
    documentationUrl: 'https://developers.fathom.ai/api-overview',
    keywords: ['fathom', 'meeting', 'notes', 'transcript', 'summary', 'action items', 'recorder', 'activity'],
    usableAsTool: true,
    inputs: [{ type: 'main' }],
    outputs: [{ type: 'main' }],
    credentials: [{ name: 'fathomApi', required: true }],
    properties: [
      {
        name: 'resource',
        displayName: 'Resource',
        type: 'options',
        noDataExpression: true,
        default: 'meeting',
        options: [
          { name: 'Meeting', value: 'meeting' },
          { name: 'Meeting Type', value: 'meetingType' },
          { name: 'Recording', value: 'recording' },
          { name: 'Team', value: 'team' },
          { name: 'Team Member', value: 'teamMember' },
          { name: 'User', value: 'user' },
        ],
      },
      {
        name: 'operation',
        displayName: 'Operation',
        type: 'options',
        noDataExpression: true,
        default: 'getAll',
        displayOptions: only('meetingType'),
        options: [{ name: 'Get Many', value: 'getAll', action: 'Get many meeting types', idempotent: true }],
      },
      {
        name: 'operation',
        displayName: 'Operation',
        type: 'options',
        noDataExpression: true,
        default: 'getSummary',
        displayOptions: only('recording'),
        options: [
          { name: 'Get Summary', value: 'getSummary', description: 'The summary of one recording', action: 'Get a recording summary', idempotent: true },
          { name: 'Get Transcript', value: 'getTranscript', description: 'The transcript of one recording (needs Include Transcript on)', action: 'Get a recording transcript', idempotent: true },
        ],
      },
      {
        name: 'operation',
        displayName: 'Operation',
        type: 'options',
        noDataExpression: true,
        default: 'getAll',
        displayOptions: only('team'),
        options: [{ name: 'Get Many', value: 'getAll', action: 'Get many teams', idempotent: true }],
      },
      {
        name: 'operation',
        displayName: 'Operation',
        type: 'options',
        noDataExpression: true,
        default: 'getAll',
        displayOptions: only('teamMember'),
        options: [{ name: 'Get Many', value: 'getAll', description: 'Members of your teams, with their email addresses', action: 'Get many team members', idempotent: true }],
      },
      {
        name: 'operation',
        displayName: 'Operation',
        type: 'options',
        noDataExpression: true,
        default: 'getAll',
        displayOptions: only('user'),
        options: [{ name: 'Get Many', value: 'getAll', description: 'The account\'s users (admin API keys only)', action: 'Get many users', idempotent: true }],
      },
      // The default resource's operation comes last: parameter defaults are keyed by name, last one wins.
      {
        name: 'operation',
        displayName: 'Operation',
        type: 'options',
        noDataExpression: true,
        default: 'getManySince',
        displayOptions: only('meeting'),
        options: [
          {
            name: 'Get',
            value: 'get',
            description: 'One meeting as an activity item, with its text (summary, action items, transcript only on request). Fathom has no get-by-id endpoint: the meeting is found in the list.',
            action: 'Get a meeting',
            idempotent: true,
            outputSchema: ACTIVITY_WITH_TEXT_SCHEMA,
          },
          {
            name: 'Get Many Changed Since',
            value: 'getManySince',
            description: 'Meetings created after a time or cursor, as activity items, oldest first',
            action: 'Get meetings since a time',
            idempotent: true,
            outputSchema: ACTIVITY_ITEM_SCHEMA,
          },
        ],
      },
      {
        name: 'recordingId',
        displayName: 'Recording ID',
        type: 'string',
        required: true,
        default: '',
        displayOptions: { show: { resource: ['meeting', 'recording'], operation: ['get', 'getSummary', 'getTranscript'] } },
        description: 'The meeting\'s recording_id (the number in fathom:meeting:<id>)',
      },
      {
        name: 'includeTranscript',
        displayName: 'Include Transcript',
        type: 'boolean',
        default: false,
        displayOptions: { show: { resource: ['recording'], operation: ['getTranscript'] } },
        description: 'Transcripts are private by default: turn this on to read it',
      },
      {
        name: 'since',
        displayName: 'Since',
        type: 'string',
        default: '',
        placeholder: '2026-11-12T08:00:00Z',
        displayOptions: only('meeting', 'getManySince'),
        description: 'Meetings created after this ISO time or a cursor from an earlier item. Empty: the last 24 hours.',
      },
      {
        name: 'returnAll',
        displayName: 'Return All',
        type: 'boolean',
        default: false,
        displayOptions: { show: { resource: ['meeting', 'meetingType', 'team', 'teamMember', 'user'], operation: ['getAll', 'getManySince'] } },
      },
      {
        name: 'limit',
        displayName: 'Limit',
        type: 'number',
        default: 50,
        typeOptions: { minValue: 1 },
        displayOptions: { show: { resource: ['meeting', 'meetingType', 'team', 'teamMember', 'user'], operation: ['getAll', 'getManySince'], returnAll: [false] } },
      },
      {
        name: 'meetingOptions',
        displayName: 'Options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        displayOptions: only('meeting', 'getManySince', 'get'),
        values: [
          {
            name: 'includeTranscript',
            displayName: 'Include Transcript',
            type: 'boolean',
            default: false,
            description: 'Whether the transcript is read and added (to Get\'s text and to raw). Off by default: transcripts are private and Fathom rate-limits them harder.',
          },
          { name: 'includeSummary', displayName: 'Include Summary', type: 'boolean', default: true, description: 'Whether summaries are read (they count as heavy calls: 30 a minute)' },
          { name: 'recordedBy', displayName: 'Recorded By', type: 'string', default: '', placeholder: 'dana@acme.com', description: 'Only meetings recorded by these emails (comma-separated)' },
          { name: 'teams', displayName: 'Teams', type: 'string', default: '', description: 'Only meetings of these teams (comma-separated names)' },
          { name: 'createdBefore', displayName: 'Created Before', type: 'string', default: '', description: 'Only meetings created before this ISO time (Get: narrows the search)' },
          ...MAPPING_OPTIONS,
        ],
      },
      {
        name: 'teamName',
        displayName: 'Team',
        type: 'string',
        default: '',
        displayOptions: { show: { resource: ['teamMember'], operation: ['getAll'] } },
        description: 'Only members of this team (name). Empty: all.',
      },
    ],
  },
  async execute(ctx) {
    const credentials = credentialsOf(ctx);
    const api: Api = { http: ctx.http };
    const out: Array<{ json: JsonObject; pairedItem: { item: number } }> = [];
    const items = ctx.getInputData();
    for (let i = 0; i < items.length; i++) {
      try {
        for (const json of await runOne(ctx, api, credentials, i)) out.push({ json, pairedItem: { item: i } });
      } catch (error) {
        if (!ctx.continueOnFail()) throw error;
        out.push({ json: { error: (error as Error).message }, pairedItem: { item: i } });
      }
    }
    return out;
  },
});

async function runOne(ctx: IExecuteContext, api: Api, credentials: FathomCredentials, i: number): Promise<JsonObject[]> {
  const resource = ctx.getNodeParameter<string>('resource', i);
  const operation = ctx.getNodeParameter<string>('operation', i);
  const options = (ctx.getNodeParameter<JsonObject>('meetingOptions', i, {}) ?? {}) as JsonObject;
  const max = () => (ctx.getNodeParameter<boolean>('returnAll', i, false) ? Infinity : Math.max(1, Number(ctx.getNodeParameter('limit', i, 50)) || 50));
  const recordingId = () => {
    const id = String(ctx.getNodeParameter('recordingId', i, '') ?? '').trim().replace(/^fathom:meeting:/, '');
    if (!/^\d+$/.test(id)) throw new NodeOperationError('Recording ID must be the numeric recording_id', { itemIndex: i });
    return id;
  };
  const flags = () => ({ summary: options.includeSummary !== false, actionItems: true, transcript: options.includeTranscript === true });
  const filters = () => ({ 'recorded_by[]': csv(options.recordedBy), 'teams[]': csv(options.teams), created_before: String(options.createdBefore ?? '').trim() });

  if (resource === 'meeting' && operation === 'getManySince') {
    const meetings = await meetingsSince(api, credentials, sinceIso(ctx.getNodeParameter('since', i, '')), filters(), flags(), max());
    return meetings.flatMap((m) => meetingItems(m, mappingOf(options, { cursor: true })));
  }
  if (resource === 'meeting' && operation === 'get') {
    const id = recordingId();
    const wanted = flags();
    const query = { ...filters(), ...meetingQuery(wanted) };
    // No get-by-id endpoint: read the list (narrowed by Created Before) until the recording shows.
    let cursor: string | null = null;
    for (let page = 0; page < 100; page++) {
      const body: JsonObject = await fathomCall<JsonObject>(api, credentials, 'GET', '/meetings', { query: { ...query, cursor } });
      const found = asArr(body.items).find((m) => String((m as JsonObject).recording_id) === id) as JsonObject | undefined;
      if (found) {
        const [item] = meetingItems(found, mappingOf(options));
        return [{ ...item, text: meetingText(found, wanted.transcript) }];
      }
      cursor = typeof body.next_cursor === 'string' && body.next_cursor ? body.next_cursor : null;
      if (!cursor) break;
    }
    throw new NodeOperationError(`No meeting with recording ID ${id} in the meetings this API key can see`, { itemIndex: i, description: 'Set Created Before (and Recorded By or Teams) in Options to narrow the search, or check the key\'s access.' });
  }
  if (resource === 'recording' && operation === 'getSummary') {
    const id = recordingId();
    const body = await fathomCall<JsonObject>(api, credentials, 'GET', `/recordings/${id}/summary`);
    return [{ recording_id: Number(id), ...(body.summary as JsonObject) }];
  }
  if (resource === 'recording' && operation === 'getTranscript') {
    if (ctx.getNodeParameter<boolean>('includeTranscript', i, false) !== true) {
      throw new NodeOperationError('Transcripts are off', { itemIndex: i, description: 'Turn on Include Transcript to read this recording\'s transcript.' });
    }
    const id = recordingId();
    const body = await fathomCall<JsonObject>(api, credentials, 'GET', `/recordings/${id}/transcript`);
    return [{ recording_id: Number(id), transcript: body.transcript ?? [], text: transcriptText(body.transcript) }];
  }
  if (operation === 'getAll') {
    const paths: Record<string, string> = { meetingType: '/meeting_types', team: '/teams', teamMember: '/team_members', user: '/users' };
    const path = paths[resource];
    if (!path) throw new NodeOperationError(`Unsupported: ${resource} → ${operation}`, { itemIndex: i });
    const team = resource === 'teamMember' ? String(ctx.getNodeParameter('teamName', i, '') ?? '').trim() : '';
    const rows = await fathomPages(api, credentials, path, { ...(team && { team }) }, max());
    const sliced = rows.slice(0, max());
    // Users and team members are people: lowercase email as the key, in a stable shape.
    return resource === 'user' || resource === 'teamMember'
      ? sliced.map((u) => ({ ...u, email: typeof u.email === 'string' ? u.email.toLowerCase() : null }))
      : sliced;
  }
  throw new NodeOperationError(`Unsupported: ${resource} → ${operation}`, { itemIndex: i });
}
