import { randomBytes } from 'node:crypto';
import { ACTIVITY_ITEM_SCHEMA, defineNode, NodeOperationError, verifyHmacSha256, type IWebhookContext, type JsonObject, type PropertyOption } from '@landflow/sdk';
import {
  commentActivity,
  completionActivity,
  COMMENT_FIELDS,
  hintsOf,
  issueActivity,
  issueFields,
  labelNames,
  PROJECT_UPDATE_FIELDS,
  projectUpdateActivity,
  type EventInfo,
} from '../activity';
import { graphql, pickCredentials, type ApiContext, type LinearCredentials } from '../client';
import { HINT_OPTIONS } from './linear';

/** Linear: "within a minute" of the request's `webhookTimestamp`. */
export const DEFAULT_TOLERANCE_SECONDS = 60;
/** Linear drops a delivery that takes over 5 s to answer; enrichment reads give up well before. */
const ENRICH_TIMEOUT_MS = 2500;

const NOTICE =
  'Publishing the workflow registers a webhook in Linear (webhookCreate) with a signing secret Landflow generates; unpublishing removes it. ' +
  'Registering needs a workspace admin\'s API key or an OAuth token with the admin scope, and a public HTTPS Landflow URL. ' +
  'Linear signs every delivery and Landflow verifies it with that secret.';

interface TriggerStatic extends JsonObject {
  url: string;
  webhookId: string;
  secret: string;
}

const RESOURCE_TYPES: PropertyOption[] = [
  { name: 'Comment', value: 'Comment', description: 'work.discussion' },
  { name: 'Cycle', value: 'Cycle', description: 'work.release when a cycle completes' },
  { name: 'Issue', value: 'Issue', description: 'work.bug_reported, work.feature_request or work.ticket_moved' },
  { name: 'Project', value: 'Project', description: 'work.release when a project completes' },
  { name: 'Project Update', value: 'ProjectUpdate', description: 'work.self_update' },
];

const asObject = (value: unknown): JsonObject | undefined => (value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : undefined);
const ignored = (reason: string) => ({ response: { status: 200, json: { ignored: reason } } });

const credentialsOf = (ctx: { getCredentials: IWebhookContext['getCredentials']; getNodeParameter: IWebhookContext['getNodeParameter'] }): LinearCredentials =>
  pickCredentials(ctx, ctx.getNodeParameter('authentication', 'apiKey'));

/** Checks Linear-Signature (hex HMAC-SHA256 of the raw body) and `webhookTimestamp`; undefined when valid, else the 401 to answer. */
function rejectUnsigned(ctx: IWebhookContext, secret: string, now = Date.now()): { response: { status: number; json: JsonObject } } | undefined {
  const reject = (why: string) => {
    ctx.logger.warn(`rejected a call: ${why}`);
    return { response: { status: 401, json: { error: 'invalid signature' } } };
  };
  if (!secret) return reject('no signing secret stored (publish the workflow again)');
  const raw = ctx.getRawBody();
  if (!verifyHmacSha256({ secret, payload: raw, signature: ctx.getHeader('linear-signature') })) return reject('missing or invalid Linear-Signature');
  const options = (ctx.getNodeParameter<JsonObject>('options', {}) ?? {}) as JsonObject;
  const tolerance = Number(options.tolerance ?? DEFAULT_TOLERANCE_SECONDS);
  const allowed = (Number.isFinite(tolerance) && tolerance >= 0 ? tolerance : DEFAULT_TOLERANCE_SECONDS) * 1000;
  let timestamp = NaN;
  try {
    timestamp = Number(asObject(JSON.parse(Buffer.from(raw).toString('utf8')))?.webhookTimestamp);
  } catch {
    // not JSON: handled below as a missing timestamp
  }
  if (!Number.isFinite(timestamp) || Math.abs(now - timestamp) > allowed) return reject('webhookTimestamp missing or outside the tolerance (replay?)');
  return undefined;
}

/**
 * Linear events as activity items (docs/protocol.md §16), from Linear's webhooks: Issue, Comment, Project Update,
 * Project and Cycle. The webhook is registered through the API when the workflow is published, with a secret this
 * node makes up and keeps in its static data; every delivery is checked against it.
 */
export const LinearTrigger = defineNode({
  description: {
    name: 'linearTrigger',
    displayName: 'Linear Trigger',
    description: 'Starts the workflow when something changes in Linear (issues, comments, project updates, completed projects and cycles), with the change as an activity item',
    version: 1,
    kind: 'trigger',
    triggerSource: 'appWebhook',
    categories: ['Productivity', 'Development'],
    icon: 'file:linear.svg',
    color: '#5E6AD2',
    subtitle: '{{resourceTypes}}',
    documentationUrl: 'https://linear.app/developers/webhooks',
    keywords: ['linear', 'trigger', 'webhook', 'issue', 'comment', 'project', 'cycle', 'activity'],
    inputs: [],
    outputs: [{ type: 'main' }],
    outputSchema: ACTIVITY_ITEM_SCHEMA,
    credentials: [
      { name: 'linearApi', required: true, displayOptions: { show: { authentication: ['apiKey'] } } },
      { name: 'linearOAuth2Api', required: true, displayOptions: { show: { authentication: ['oAuth2'] } } },
    ],
    properties: [
      {
        name: 'authentication',
        displayName: 'Authentication',
        type: 'options',
        noDataExpression: true,
        default: 'apiKey',
        options: [
          { name: 'API Key', value: 'apiKey', description: 'A workspace admin\'s personal API key' },
          { name: 'OAuth2', value: 'oAuth2', description: 'Connect with Linear; needs the admin scope to register the webhook' },
        ],
      },
      { name: 'notice', displayName: NOTICE, type: 'notice', default: '' },
      {
        name: 'teamId',
        displayName: 'Team',
        type: 'options',
        default: '',
        typeOptions: { loadOptionsMethod: 'getTeams' },
        description: 'Only events of this team. Empty: every public team, including teams created later',
      },
      {
        name: 'resourceTypes',
        displayName: 'Resources',
        type: 'multiOptions',
        required: true,
        default: ['Issue', 'Comment', 'ProjectUpdate'],
        options: RESOURCE_TYPES,
        description: 'The Linear resource types to subscribe the webhook to',
      },
      {
        name: 'options',
        displayName: 'Options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        values: [
          ...HINT_OPTIONS,
          {
            name: 'tolerance',
            displayName: 'Signature Tolerance (s)',
            type: 'number',
            default: DEFAULT_TOLERANCE_SECONDS,
            typeOptions: { minValue: 0 },
            description: 'How far the payload\'s webhookTimestamp may be from now before the call is rejected as a replay (Linear recommends one minute)',
          },
        ],
      },
    ],
  },
  methods: {
    loadOptions: {
      async getTeams(ctx): Promise<PropertyOption[]> {
        const data = await graphql<{ teams: { nodes: Array<{ id: string; key: string; name: string }> } }>({ http: ctx.http }, pickCredentials(ctx), '{ teams(first: 100) { nodes { id key name } } }');
        return data.teams.nodes.map((t) => ({ name: `${t.name} (${t.key})`, value: t.id })).sort((a, b) => a.name.localeCompare(b.name));
      },
    },
  },
  execute(ctx) {
    ctx.logger.info('Linear sends events to the published workflow; a manual run has no event to output (Issue → Get Many Changed Since on the Linear node reads recent changes)');
    return [];
  },
  webhookMethods: {
    async checkExists(ctx) {
      const data = ctx.getStaticData<TriggerStatic>();
      if (!data.webhookId || !data.secret || data.url !== ctx.getWebhookUrl()) return false;
      try {
        const result = await graphql<{ webhook: { enabled: boolean; url: string | null } | null }>({ http: ctx.http }, credentialsOf(ctx), 'query($id: String!) { webhook(id: $id) { id enabled url } }', { id: data.webhookId }, { retries: 0 });
        return Boolean(result.webhook?.enabled) && result.webhook?.url === data.url;
      } catch {
        // Linear answers "Entity not found" for a webhook that was deleted there.
        return false;
      }
    },
    async create(ctx) {
      const types = (ctx.getNodeParameter<string[]>('resourceTypes', []) ?? []).filter(Boolean);
      if (types.length === 0) throw new NodeOperationError('Pick at least one resource');
      const teamId = String(ctx.getNodeParameter('teamId', '') ?? '').trim();
      const secret = randomBytes(32).toString('hex');
      const input: JsonObject = {
        url: ctx.getWebhookUrl(),
        resourceTypes: types,
        secret,
        label: 'Landflow',
        ...(teamId ? { teamId } : { allPublicTeams: true }),
      };
      const result = await ctx.span('linear.webhookCreate', {}, () =>
        graphql<{ webhookCreate: { success: boolean; webhook: { id: string; secret?: string | null } | null } }>(
          { http: ctx.http },
          credentialsOf(ctx),
          'mutation($input: WebhookCreateInput!) { webhookCreate(input: $input) { success webhook { id enabled secret } } }',
          { input },
        ),
      );
      const webhook = result.webhookCreate.webhook;
      if (!result.webhookCreate.success || !webhook) throw new NodeOperationError('Linear did not create the webhook');
      ctx.setStaticData({ url: ctx.getWebhookUrl(), webhookId: webhook.id, secret: webhook.secret || secret } satisfies TriggerStatic);
      ctx.logger.info(`Linear webhook ${webhook.id} registered for ${types.join(', ')}`);
      return true;
    },
    async delete(ctx) {
      const data = ctx.getStaticData<TriggerStatic>();
      if (data.webhookId) {
        try {
          await graphql<{ webhookDelete: { success: boolean } }>({ http: ctx.http }, credentialsOf(ctx), 'mutation($id: String!) { webhookDelete(id: $id) { success } }', { id: data.webhookId }, { retries: 1 });
        } catch (error) {
          // A webhook already gone is not a failure.
          if (!/not found|does not exist|no such/i.test((error as Error).message)) throw error;
        }
      }
      ctx.setStaticData({});
      return true;
    },
  },
  async webhook(ctx) {
    const stored = ctx.getStaticData<TriggerStatic>();
    const rejected = rejectUnsigned(ctx, String(stored.secret ?? ''));
    if (rejected) return rejected;

    const body = ctx.getBody<JsonObject>();
    const type = String(body?.type ?? '');
    const action = String(body?.action ?? '');
    const data = asObject(body?.data);
    if (!data) return ignored(type || 'no data');
    const selected = ctx.getNodeParameter<string[]>('resourceTypes', ['Issue', 'Comment', 'ProjectUpdate']) ?? [];
    if (!selected.includes(type)) return ignored(type || 'unknown');
    if (action === 'remove') return ignored('remove');

    const options = (ctx.getNodeParameter<JsonObject>('options', {}) ?? {}) as JsonObject;
    const hints = hintsOf(options);
    const actor = asObject(body?.actor);
    const event: EventInfo = {
      action,
      actorEmail: typeof actor?.email === 'string' && actor.email ? actor.email.toLowerCase() : null,
      updatedFrom: asObject(body?.updatedFrom),
      url: typeof body?.url === 'string' ? body.url : null,
    };

    const api: ApiContext = { http: ctx.http };
    let credentials: LinearCredentials | undefined;
    // Payload data can lack the team, project and label names the hints need: one short read fills them in, and a failed one leaves the payload as is.
    const enrich = async (query: string, field: string, id: unknown): Promise<JsonObject | undefined> => {
      try {
        credentials ??= credentialsOf(ctx);
        const result = await graphql<Record<string, JsonObject | null>>(api, credentials, query, { id: String(id) }, { retries: 0, timeoutMs: ENRICH_TIMEOUT_MS });
        return result[field] ?? undefined;
      } catch (error) {
        ctx.logger.warn(`could not read ${field} ${id} from Linear (hints may be empty): ${(error as Error).message}`);
        return undefined;
      }
    };

    let item;
    switch (type) {
      case 'Issue': {
        const needsLookup = !asObject(data.team)?.name || (action === 'create' && !labelNames(data).length && Array.isArray(data.labelIds) && data.labelIds.length > 0);
        const full = needsLookup ? await enrich(`query($id: String!) { issue(id: $id) { ${issueFields(options.customerNeeds !== false)} } }`, 'issue', data.id) : undefined;
        item = issueActivity({ ...data, ...(full ?? {}), updatedAt: data.updatedAt ?? full?.updatedAt ?? new Date().toISOString() }, { hints, event });
        break;
      }
      case 'Comment': {
        const needsLookup = !asObject(data.issue)?.team;
        const full = needsLookup ? await enrich(`query($id: String!) { comment(id: $id) { ${COMMENT_FIELDS} } }`, 'comment', data.id) : undefined;
        item = commentActivity({ ...data, ...(full ?? {}), updatedAt: data.updatedAt ?? full?.updatedAt ?? new Date().toISOString() }, { hints, event });
        break;
      }
      case 'ProjectUpdate': {
        const full = asObject(data.project)?.name ? undefined : await enrich(`query($id: String!) { projectUpdate(id: $id) { ${PROJECT_UPDATE_FIELDS} } }`, 'projectUpdate', data.id);
        item = projectUpdateActivity({ ...data, ...(full ?? {}), updatedAt: data.updatedAt ?? full?.updatedAt ?? new Date().toISOString() }, { hints, event });
        break;
      }
      case 'Project':
      case 'Cycle': {
        item = completionActivity(type === 'Project' ? 'project' : 'cycle', data, { hints, event });
        if (!item) return ignored('not completed');
        break;
      }
      default:
        return ignored(type);
    }
    // Linear gives up on a delivery after 5 s and redelivers on failure; the delivery id (and the item's stable sourceId) keep it to one run.
    const delivery = ctx.getHeader('linear-delivery');
    return { items: [item], ...(delivery && { idempotencyKey: delivery }) };
  },
});
