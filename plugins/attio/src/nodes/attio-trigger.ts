import { ACTIVITY_ITEM_SCHEMA, defineNode, hmacSha256, NodeOperationError, verifyHmacSha256, type IWebhookContext, type IWebhookMethodContext, type JsonObject } from '@landflow/sdk';
import { activityOptions, AttioLookup, cacheOf, eventItem, OPTION_PROPERTIES, SUPPORTED_EVENTS } from '../activity';
import { asArray, asObject, asString, attioCall, attioCredentials, isNotFound } from '../api';

interface TriggerStatic extends JsonObject {
  webhookId: string;
  url: string;
  /** The signing secret Attio returns once, when it creates the webhook. */
  secret: string;
  lookups: JsonObject;
}

const EVENT_OPTIONS = [
  { name: 'Record Created', value: 'record.created' },
  { name: 'Record Updated', value: 'record.updated', description: 'A value of the record changed (a deal moved stage)' },
  { name: 'List Entry Created', value: 'list-entry.created', description: 'A record was added to a list (a deal to a pipeline)' },
  { name: 'List Entry Updated', value: 'list-entry.updated', description: 'A value of a list entry changed (a pipeline stage moved)' },
  { name: 'Note Created', value: 'note.created' },
  { name: 'Task Created', value: 'task.created' },
];

const credentialsOf = (ctx: IWebhookContext | IWebhookMethodContext) => attioCredentials(ctx, ctx.getNodeParameter('authentication', 'accessToken'));
const ignored = (reason: string) => ({ response: { status: 200, json: { ignored: reason } } });

/**
 * CRM changes as activity items (docs/protocol.md §16), from Attio webhooks the node registers itself when the
 * workflow is published (POST /v2/webhooks) and removes when it is unpublished. Attio's payloads carry ids only, so each
 * event is turned into an item by fetching the record, entry, note or task.
 */
export const AttioTrigger = defineNode({
  description: {
    name: 'attioTrigger',
    displayName: 'Attio Trigger',
    description: 'Starts the workflow when a record, list entry (pipeline stage), note or task changes in Attio, with the change as an activity item (actor email, link, company and team hints)',
    version: 1,
    kind: 'trigger',
    triggerSource: 'appWebhook',
    categories: ['Sales'],
    icon: 'file:attio-trigger.svg',
    color: '#4f5bd5',
    subtitle: '{{events}}',
    documentationUrl: 'https://docs.attio.com/rest-api/guides/webhooks',
    keywords: ['attio', 'crm', 'trigger', 'webhook', 'deal', 'pipeline', 'activity', 'record', 'note', 'task'],
    inputs: [],
    outputs: [{ type: 'main' }],
    outputSchema: ACTIVITY_ITEM_SCHEMA,
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
        name: 'notice',
        displayName:
          'Publishing registers a webhook in Attio for this node (the token needs webhook:read-write and a workspace-level token). Attio only accepts an HTTPS public URL. Attio shows the webhook secret once, so Landflow keeps it for the signature check; unpublishing removes the webhook.',
        type: 'notice',
        default: '',
      },
      { name: 'events', displayName: 'Events', type: 'multiOptions', required: true, default: [...SUPPORTED_EVENTS], options: EVENT_OPTIONS, description: 'The Attio events that start a run' },
      {
        name: 'objects',
        displayName: 'Objects',
        type: 'string',
        default: 'companies,people,deals',
        placeholder: 'companies,people,deals',
        description: 'Records, list entries and notes of these objects (API slugs, comma-separated) start a run. Empty: every object. Tasks are not tied to an object and always pass.',
      },
      { name: 'options', displayName: 'Options', type: 'collection', default: {}, placeholder: 'Add option', values: [...OPTION_PROPERTIES] },
    ],
  },
  execute(ctx) {
    ctx.logger.info('Attio sends events to the published workflow; a manual run has no event to output (List Changed Since on the Attio node reads recent changes)');
    return [];
  },
  webhookMethods: {
    async checkExists(ctx) {
      const data = ctx.getStaticData<TriggerStatic>();
      if (!data.webhookId || !data.secret || data.url !== ctx.getWebhookUrl()) return false;
      try {
        const hook = asObject((await attioCall(ctx.http, credentialsOf(ctx), 'GET', `/webhooks/${data.webhookId}`)).data);
        return hook?.status !== 'inactive' && hook?.target_url === ctx.getWebhookUrl();
      } catch (error) {
        if (isNotFound(error)) return false;
        throw error;
      }
    },
    async create(ctx) {
      const credentials = credentialsOf(ctx);
      const url = ctx.getWebhookUrl();
      if (!url.startsWith('https://')) {
        throw new NodeOperationError(`Attio only accepts an HTTPS webhook URL (this one is ${url})`, { description: 'Set Landflow\'s public URL to an https address (a tunnel such as ngrok or Cloudflare Tunnel in development).' });
      }
      const events = asArray(ctx.getNodeParameter<unknown[]>('events', [...SUPPORTED_EVENTS])).map(String).filter((e) => (SUPPORTED_EVENTS as readonly string[]).includes(e));
      if (!events.length) throw new NodeOperationError('Pick at least one event');
      const previous = ctx.getStaticData<TriggerStatic>().webhookId;
      if (previous) {
        // A webhook an earlier publish left behind (another URL, or its secret was lost): remove it so the same subscriptions can be registered again.
        await attioCall(ctx.http, credentials, 'DELETE', `/webhooks/${previous}`, { allow: [404] }).catch((e) => ctx.logger.warn(`could not remove the old webhook: ${(e as Error).message}`));
      }
      const created = await ctx.span('attio.webhooks.create', {}, () =>
        attioCall(ctx.http, credentials, 'POST', '/webhooks', { body: { data: { target_url: url, subscriptions: events.map((event_type) => ({ event_type, filter: null })) } } }),
      );
      const data = asObject(created.data);
      const webhookId = asString(asObject(data?.id)?.webhook_id);
      const secret = asString(data?.secret);
      if (!webhookId || !secret) throw new NodeOperationError('Attio did not return the webhook id and secret');
      ctx.setStaticData({ webhookId, url, secret, lookups: {} } satisfies TriggerStatic);
      ctx.logger.info(`Attio webhook ${webhookId} registered for ${events.join(', ')}`);
      return true;
    },
    async delete(ctx) {
      const { webhookId } = ctx.getStaticData<TriggerStatic>();
      if (webhookId) await attioCall(ctx.http, credentialsOf(ctx), 'DELETE', `/webhooks/${webhookId}`, { allow: [404] });
      ctx.setStaticData({});
      return true;
    },
  },
  async webhook(ctx) {
    const stored = ctx.getStaticData<TriggerStatic>();
    const secret = stored.secret?.trim();
    // Attio-Signature: hex HMAC-SHA256 of the raw body, keyed with the webhook secret. X-Attio-Signature is the legacy name.
    const signature = ctx.getHeader('attio-signature') ?? ctx.getHeader('x-attio-signature');
    if (!secret || !verifyHmacSha256({ secret, payload: ctx.getRawBody(), signature })) {
      ctx.logger.warn(secret ? 'rejected a call with a missing or invalid Attio signature' : 'rejected a call: no Attio webhook secret is stored (publish the workflow again)');
      return { response: { status: 401, json: { error: 'invalid signature' } } };
    }
    const body = asObject(ctx.getBody<JsonObject>());
    const events = asArray(body?.events).map(asObject).filter((e): e is JsonObject => Boolean(e));
    if (!events.length) return ignored('no events');
    const wanted = new Set(asArray(ctx.getNodeParameter<unknown[]>('events', [...SUPPORTED_EVENTS])).map(String));
    const objects = String(ctx.getNodeParameter('objects', 'companies,people,deals') ?? '').split(/[,\s]+/).filter(Boolean);
    const options = activityOptions(asObject(ctx.getNodeParameter<JsonObject>('options', {})));
    const lookup = new AttioLookup(ctx.http, attioCredentials(ctx, ctx.getNodeParameter('authentication', 'accessToken')), cacheOf(stored.lookups), (m) => ctx.logger.warn(m));
    const items: JsonObject[] = [];
    for (const event of events) {
      if (!wanted.has(String(event.event_type))) continue;
      const item = await ctx.span('attio.event', { 'attio.event_type': String(event.event_type) }, () => eventItem(lookup, event, options, objects));
      if (item) items.push(item);
    }
    if (lookup.changed) ctx.setStaticData({ ...ctx.getStaticData<TriggerStatic>(), lookups: lookup.cache });
    if (!items.length) return ignored('filtered out');
    // Attio redelivers (at least once, up to 10 times) with the same Idempotency-Key header, which keeps it to one run.
    const key = ctx.getHeader('idempotency-key') ?? hmacSha256('attio', ctx.getRawBody());
    return { items, idempotencyKey: key };
  },
});
