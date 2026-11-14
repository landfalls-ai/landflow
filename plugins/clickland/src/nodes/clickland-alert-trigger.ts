import { defineNode, NodeOperationError, type IWebhookMethodContext, type JsonObject } from '@landflow/sdk';
import { Clickland } from '../client';
import type { ClicklandCredentials } from '../shared';
import { TOLERANCE_SECONDS, verifyStandardWebhook } from '../signature';
import { COLOR } from './clickland';

export const ALERT_EVENTS = ['alert.firing', 'alert.resolved'] as const;

const NOTICE =
  'Publishing the workflow subscribes it in Clickland (POST /api/webhooks; the API key needs webhooks:write) and keeps the signing secret for you; unpublishing deletes the subscription. ' +
  'Clickland must reach Landflow at the published URL (LANDFLOW_PUBLIC_URL). Every delivery is checked against its Standard Webhooks signature.';

interface Stored extends JsonObject {
  id: string;
  secret: string;
  url: string;
  /** What the subscription was created with (events, alert id), so a changed option re-creates it. */
  flags: string;
}

const credentialsOf = (ctx: { getCredentials<T>(name: string): T }) => ctx.getCredentials<ClicklandCredentials>('clicklandApi');

/** The events and alert filter the node asks for. */
function flagsOf(ctx: { getNodeParameter<T = unknown>(name: string, fallback?: T): T }): { events: string[]; alertId: string | null } {
  const picked = (ctx.getNodeParameter<string[]>('events', [...ALERT_EVENTS]) ?? []).filter((e) => (ALERT_EVENTS as readonly string[]).includes(e));
  const alertId = String(ctx.getNodeParameter('alertId', '') ?? '').trim();
  return { events: (picked.length ? picked : [...ALERT_EVENTS]).sort(), alertId: alertId || null };
}

const sameEvents = (a: unknown, b: string[]) => Array.isArray(a) && [...a].map(String).sort().join(',') === b.join(',');

/**
 * Clickland's alert webhooks: one item per `alert.firing` / `alert.resolved` delivery, with the event's `data`
 * (`alert`, `status`, `groupKey`, `value`, `fingerprint`, `window`, `url`, `searchUrl`, `samples`, and `route: "direct"`
 * when Clickland routed the alert straight to Landfall) plus `type`, `id` and `timestamp`. The `webhook-id` header (stable across Clickland's retries) is the idempotency key.
 */
export const ClicklandAlertTrigger = defineNode({
  description: {
    name: 'clicklandAlertTrigger',
    displayName: 'Clickland Alert Trigger',
    description: 'Starts the workflow when a Clickland alert fires or resolves (a signed webhook Clickland sends; registered on publish)',
    version: 1,
    kind: 'trigger',
    triggerSource: 'appWebhook',
    categories: ['Development', 'Analytics'],
    icon: 'file:clickland-trigger.svg',
    color: COLOR,
    subtitle: '{{events}}',
    documentationUrl: 'https://github.com/landfalls-ai/landflow/blob/main/plugins/clickland/README.md',
    keywords: ['clickland', 'alert', 'webhook', 'firing', 'resolved', 'observability', 'trigger'],
    inputs: [],
    outputs: [{ type: 'main' }],
    credentials: [{ name: 'clicklandApi', required: true }],
    properties: [
      { name: 'notice', displayName: NOTICE, type: 'notice', default: '' },
      {
        name: 'events',
        displayName: 'Trigger On',
        type: 'multiOptions',
        default: [...ALERT_EVENTS],
        options: [
          { name: 'Alert Firing', value: 'alert.firing', description: 'A group of an alert went from ok to firing' },
          { name: 'Alert Resolved', value: 'alert.resolved', description: 'A firing group went back to ok' },
        ],
      },
      { name: 'alertId', displayName: 'Alert ID', type: 'string', default: '', placeholder: 'al_…', description: 'Only this alert (empty: every alert)' },
      {
        name: 'options',
        displayName: 'Options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        values: [
          {
            name: 'tolerance',
            displayName: 'Signature Tolerance (s)',
            type: 'number',
            default: TOLERANCE_SECONDS,
            typeOptions: { minValue: 0 },
            description: 'How far the signed webhook-timestamp may be from now before the call is rejected as a replay',
          },
        ],
      },
    ],
  },
  execute(ctx) {
    ctx.logger.info('Clickland sends alert events to the published workflow; a manual run has no event to output (Clickland → Alert → Events lists recent ones)');
    return [];
  },
  webhookMethods: {
    async checkExists(ctx) {
      const data = ctx.getStaticData<Stored>();
      const flags = flagsOf(ctx);
      if (!data.id || !data.secret || data.url !== ctx.getWebhookUrl() || data.flags !== JSON.stringify(flags)) return false;
      const hook = await new Clickland({ http: ctx.http }, credentialsOf(ctx)).webhook(data.id);
      if (!hook) return false;
      return hook.url === ctx.getWebhookUrl() && sameEvents(hook.events, flags.events) && (hook.alertId ?? null) === flags.alertId;
    },
    async create(ctx) {
      const client = new Clickland({ http: ctx.http }, credentialsOf(ctx));
      const previous = ctx.getStaticData<Stored>();
      // A subscription from an earlier registration that checkExists could not confirm: remove it first, so deliveries don't double.
      if (previous.id) await removeQuietly(ctx, client, previous.id);
      const flags = flagsOf(ctx);
      const hook = await ctx.span('clickland.webhook.create', {}, () =>
        client.createWebhook({ url: ctx.getWebhookUrl(), events: flags.events, alertId: flags.alertId, description: `Landflow workflow ${ctx.getWorkflowId()} (${ctx.getNode().name})` }),
      );
      if (typeof hook.id !== 'string' || typeof hook.secret !== 'string') throw new NodeOperationError('Clickland did not return a webhook id and secret');
      ctx.setStaticData({ id: hook.id, secret: hook.secret, url: ctx.getWebhookUrl(), flags: JSON.stringify(flags) } satisfies Stored);
      ctx.logger.info('Clickland webhook created', { id: hook.id });
      return true;
    },
    async delete(ctx) {
      const data = ctx.getStaticData<Stored>();
      // Already gone in Clickland (404) is fine; any other failure throws and keeps the record so the delete is retried.
      if (data.id) await new Clickland({ http: ctx.http }, credentialsOf(ctx)).deleteWebhook(data.id);
      ctx.setStaticData({});
      return true;
    },
  },
  async webhook(ctx) {
    const data = ctx.getStaticData<Stored>();
    const options = (ctx.getNodeParameter<JsonObject>('options', {}) ?? {}) as JsonObject;
    const tolerance = Number(options.tolerance ?? TOLERANCE_SECONDS);
    const id = ctx.getHeader('webhook-id');
    const valid = verifyStandardWebhook(
      String(data.secret ?? ''),
      ctx.getRawBody(),
      { id, timestamp: ctx.getHeader('webhook-timestamp'), signature: ctx.getHeader('webhook-signature') },
      { toleranceSeconds: Number.isFinite(tolerance) && tolerance >= 0 ? tolerance : TOLERANCE_SECONDS },
    );
    if (!valid) {
      ctx.logger.warn('rejected a call with a missing, invalid or stale Clickland signature');
      return { response: { status: 401, json: { error: 'invalid signature' } } };
    }
    const event = ctx.getBody<JsonObject>();
    if (!event || typeof event !== 'object' || typeof event.type !== 'string' || !event.data || typeof event.data !== 'object') {
      return { response: { status: 200, json: { ignored: 'not a Clickland event' } } };
    }
    const flags = flagsOf(ctx);
    if (!flags.events.includes(event.type)) return { response: { status: 200, json: { ignored: `event ${event.type} not selected` } } };
    const payload = event.data as JsonObject;
    const alert = (payload.alert ?? {}) as JsonObject;
    if (flags.alertId && alert.id !== flags.alertId) return { response: { status: 200, json: { ignored: 'another alert' } } };
    const item: JsonObject = { ...payload, type: event.type, id: String(event.id ?? id ?? ''), ...(event.timestamp !== undefined && { timestamp: event.timestamp }) };
    return { items: [{ json: item }], ...(id && { idempotencyKey: id }) };
  },
});

async function removeQuietly(ctx: IWebhookMethodContext, client: Clickland, id: string) {
  try {
    await client.deleteWebhook(id);
  } catch (error) {
    ctx.logger.warn('could not remove the earlier Clickland webhook before creating a new one', { id, error: (error as Error).message });
  }
}
