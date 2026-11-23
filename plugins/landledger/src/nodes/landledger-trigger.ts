import { defineNode, NodeOperationError, type IWebhookMethodContext, type JsonObject } from '@landflow/sdk';
import { Landledger } from '../client';
import type { LandledgerCredentials } from '../shared';
import { MAX_TOLERANCE_SECONDS, TOLERANCE_SECONDS, toleranceOf, verifyStandardWebhook } from '../signature';
import { COLOR } from './landledger';

/** The events the trigger offers (Landledger's docs/reference/api.md, "Webhook events"). */
export const EVENTS = [
  'request.step_pending',
  'request.decided',
  'request.applied',
  'budget.at_risk',
  'period.closing',
  'request.created',
  'request.needs_confirmation',
  'decision.relayed',
  'report.exceptions',
  'seat.released',
  'notes.draft_requested',
  'note.accepted',
  'accrual.accepted',
  'period.locked',
  'period.reopened',
  'datarails.uploaded',
] as const;
/** What a new trigger listens to. */
export const DEFAULT_EVENTS = ['request.step_pending', 'request.decided', 'request.applied', 'budget.at_risk', 'period.closing'];

const NOTICE =
  'Give this trigger its own Landledger credential, with a key that holds only webhooks:write: publishing the workflow subscribes it in Landledger (POST /api/webhooks) and keeps the signing secret Landledger returns once, never shown; unpublishing deletes the subscription. ' +
  'Or have a Landledger admin add a webhook for this node\'s URL (Publish menu → App webhooks) with these events, and put its whsec_ secret in the credential\'s Webhook Signing Secret: then nothing is registered. ' +
  'Landledger must reach Landflow at the published URL (LANDFLOW_PUBLIC_URL). Every delivery is checked against its Standard Webhooks signature, at most 5 minutes old.';

interface Stored extends JsonObject {
  id: string;
  secret: string;
  url: string;
  /** The events the subscription was created with, so a changed choice re-creates it. */
  events: string;
}

const credentialsOf = (ctx: { getCredentials<T>(name: string): T }) => ctx.getCredentials<LandledgerCredentials>('landledgerApi');
const manualSecret = (credentials: LandledgerCredentials) => (typeof credentials.webhookSecret === 'string' ? credentials.webhookSecret.trim() : '');

/** The events the node asks for, sorted. */
function eventsOf(ctx: { getNodeParameter<T = unknown>(name: string, fallback?: T): T }): string[] {
  const picked = (ctx.getNodeParameter<string[]>('events', DEFAULT_EVENTS) ?? []).filter((e) => (EVENTS as readonly string[]).includes(e));
  return (picked.length ? picked : [...DEFAULT_EVENTS]).sort();
}

const sameEvents = (a: unknown, b: string[]) => Array.isArray(a) && [...a].map(String).sort().join(',') === b.join(',');

/** A filter parameter as a list (comma-separated), lower-cased; empty: no filter. */
const listOf = (value: unknown) =>
  String(value ?? '')
    .split(',')
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);

/**
 * Landledger's webhooks: one item per delivery, the event's `data` (for request events `request`, a RequestSummary;
 * `request.step_pending` adds `step`, `approvers`, `url`, `evidenceSha256` and `relayable`; `request.decided` adds
 * `outcome`, `decision` and `reservations`; `request.needs_confirmation` adds `person`, `createdBy` and `url`;
 * `decision.relayed` adds `decision`, `person`, `channel` and `url`; `report.exceptions` is the stored report's id,
 * sha256, window, rows and url) plus `type`, `id`, `timestamp`, and `requestId`, `kind` and `costCenter` lifted out of
 * the request, for joining a flow that raised it. The `webhook-id` header (stable across Landledger's retries) is the
 * idempotency key.
 */
export const LandledgerTrigger = defineNode({
  description: {
    name: 'landledgerTrigger',
    displayName: 'Landledger Trigger',
    description: 'Starts the workflow when a Landledger request waits on its approvers or on a person\'s confirmation, is decided (also through a relay) or applied, a seat is released, a budget is at risk, a month starts closing, its notes are to be drafted or it is locked, or the exceptions report is stored (a signed webhook)',
    version: 1,
    kind: 'trigger',
    triggerSource: 'appWebhook',
    categories: ['Finance', 'Productivity'],
    icon: 'file:landledger-trigger.svg',
    color: COLOR,
    subtitle: '{{events}}',
    documentationUrl: 'https://github.com/landfalls-ai/landflow/blob/main/plugins/landledger/README.md',
    keywords: ['landledger', 'approval', 'request', 'decided', 'budget', 'webhook', 'finance', 'trigger'],
    inputs: [],
    outputs: [{ type: 'main' }],
    credentials: [{ name: 'landledgerApi', required: true }],
    properties: [
      { name: 'notice', displayName: NOTICE, type: 'notice', default: '' },
      {
        name: 'events',
        displayName: 'Trigger On',
        type: 'multiOptions',
        default: [...DEFAULT_EVENTS],
        options: [
          { name: 'Request Step Pending', value: 'request.step_pending', description: 'A step starts waiting on its approvers (or escalates): who they are, the evidence hash to relay with' },
          { name: 'Request Decided', value: 'request.decided', description: 'A request ended: approved, rejected, cancelled or expired' },
          { name: 'Request Applied', value: 'request.applied', description: 'The approved change is in place' },
          { name: 'Budget at Risk', value: 'budget.at_risk', description: 'A cost center crossed into at risk or over in a month' },
          { name: 'Period Closing', value: 'period.closing', description: 'A month starts closing' },
          { name: 'Request Created', value: 'request.created', description: 'A request was submitted' },
          {
            name: 'Request Needs Confirmation',
            value: 'request.needs_confirmation',
            description: 'A key raised a request naming a person (requester or sponsor): they confirm it in Landledger before it goes to approvers',
          },
          { name: 'Decision Relayed', value: 'decision.relayed', description: 'A person\'s press in a relay channel (Slack) was recorded as their decision' },
          { name: 'Exceptions Report', value: 'report.exceptions', description: 'The weekly exceptions report was stored, with its sha256' },
          { name: 'Seat Released', value: 'seat.released', description: 'A seat request\'s seats went back to its contract (released, or expired unapplied after 30 days)' },
          { name: 'Notes Draft Requested', value: 'notes.draft_requested', description: 'The close reached the notes step (the accrual accepted, the snapshot frozen): the notes needed, with the figures each may cite' },
          { name: 'Note Accepted', value: 'note.accepted', description: 'An analyst accepted a variance note' },
          { name: 'Accrual Accepted', value: 'accrual.accepted', description: 'A controller accepted the month\'s accrual proposal' },
          { name: 'Period Locked', value: 'period.locked', description: 'The second signature locked a month' },
          { name: 'Period Reopened', value: 'period.reopened', description: 'The CFO approved reopening a locked month' },
          { name: 'Datarails Uploaded', value: 'datarails.uploaded', description: 'The month\'s snapshot and notes were uploaded to Datarails (or the upload failed)' },
        ],
      },
      { name: 'kinds', displayName: 'Request Kinds', type: 'string', default: '', placeholder: 'infra_change, ai_budget', description: 'Only requests of these kinds (comma-separated; empty: every kind). Events without a request pass' },
      { name: 'costCenters', displayName: 'Cost Centers', type: 'string', default: '', placeholder: 'ENG-PLATFORM', description: 'Only these cost centers (comma-separated codes; empty: every one)' },
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
            typeOptions: { minValue: 0, maxValue: MAX_TOLERANCE_SECONDS },
            description: `How far the signed webhook-timestamp may be from now before the call is rejected as a replay (at most ${MAX_TOLERANCE_SECONDS} s)`,
          },
        ],
      },
    ],
  },
  execute(ctx) {
    ctx.logger.info('Landledger sends its events to the published workflow; a manual run has no event to output');
    return [];
  },
  webhookMethods: {
    async checkExists(ctx) {
      // A subscription an admin made: nothing of ours to check.
      if (manualSecret(credentialsOf(ctx))) return true;
      const data = ctx.getStaticData<Stored>();
      const events = eventsOf(ctx);
      if (!data.id || !data.secret || data.url !== ctx.getWebhookUrl() || data.events !== events.join(',')) return false;
      const { webhooks } = await new Landledger({ http: ctx.http }, credentialsOf(ctx)).webhooks();
      const hook = (webhooks ?? []).find((w) => w.id === data.id);
      return Boolean(hook) && hook!.url === ctx.getWebhookUrl() && sameEvents(hook!.events, events);
    },
    async create(ctx) {
      const credentials = credentialsOf(ctx);
      if (manualSecret(credentials)) {
        ctx.setStaticData({});
        ctx.logger.info('Landledger webhook made by an admin: deliveries are checked with the credential\'s signing secret', { url: ctx.getWebhookUrl() });
        return true;
      }
      const client = new Landledger({ http: ctx.http }, credentials);
      const previous = ctx.getStaticData<Stored>();
      // A subscription from an earlier registration that checkExists could not confirm: remove it first, so deliveries don't double.
      if (previous.id) await removeQuietly(ctx, client, previous.id);
      const events = eventsOf(ctx);
      const hook = await ctx.span('landledger.webhook.create', {}, () =>
        client.createWebhook({ url: ctx.getWebhookUrl(), events, description: `Landflow workflow ${ctx.getWorkflowId()} (${ctx.getNode().name})`.slice(0, 500) }),
      );
      if (typeof hook.id !== 'string' || typeof hook.secret !== 'string') throw new NodeOperationError('Landledger did not return a webhook id and secret');
      ctx.setStaticData({ id: hook.id, secret: hook.secret, url: ctx.getWebhookUrl(), events: events.join(',') } satisfies Stored);
      ctx.logger.info('Landledger webhook created', { id: hook.id });
      return true;
    },
    async delete(ctx) {
      const data = ctx.getStaticData<Stored>();
      // Already gone in Landledger (404) is fine; any other failure throws and keeps the record so the delete is retried.
      if (data.id) await new Landledger({ http: ctx.http }, credentialsOf(ctx)).deleteWebhook(data.id);
      ctx.setStaticData({});
      return true;
    },
  },
  async webhook(ctx) {
    const credentials = credentialsOf(ctx);
    const data = ctx.getStaticData<Stored>();
    const secret = manualSecret(credentials) || String(data.secret ?? '');
    const options = (ctx.getNodeParameter<JsonObject>('options', {}) ?? {}) as JsonObject;
    const id = ctx.getHeader('webhook-id');
    const valid = verifyStandardWebhook(
      secret,
      ctx.getRawBody(),
      { id, timestamp: ctx.getHeader('webhook-timestamp'), signature: ctx.getHeader('webhook-signature') },
      { toleranceSeconds: toleranceOf(options.tolerance) },
    );
    if (!valid) {
      ctx.logger.warn('rejected a call with a missing, invalid or stale Landledger signature');
      return { response: { status: 401, json: { error: 'invalid signature' } } };
    }
    const event = ctx.getBody<JsonObject>();
    if (!event || typeof event !== 'object' || typeof event.type !== 'string' || !event.data || typeof event.data !== 'object') {
      return { response: { status: 200, json: { ignored: 'not a Landledger event' } } };
    }
    const ignored = (reason: string) => ({ response: { status: 200, json: { ignored: reason } } });
    if (!eventsOf(ctx).includes(event.type)) return ignored(`event ${event.type} not selected`);
    const payload = event.data as JsonObject;
    const request = (payload.request && typeof payload.request === 'object' ? payload.request : undefined) as JsonObject | undefined;
    const kind = typeof request?.kind === 'string' ? request.kind : null;
    const costCenter = costCenterOf(request, payload);
    const kinds = listOf(ctx.getNodeParameter('kinds', ''));
    if (kinds.length && kind && !kinds.includes(kind.toLowerCase())) return ignored('another kind');
    const centers = listOf(ctx.getNodeParameter('costCenters', ''));
    if (centers.length && (!costCenter || !centers.includes(costCenter.toLowerCase()))) return ignored('another cost center');
    const item: JsonObject = {
      ...payload,
      type: event.type,
      id: String(id ?? ''),
      ...(event.timestamp !== undefined && { timestamp: event.timestamp }),
      requestId: typeof request?.id === 'string' ? request.id : typeof payload.requestId === 'string' ? payload.requestId : null,
      kind,
      costCenter,
    };
    return { items: [{ json: item }], ...(id && { idempotencyKey: id }) };
  },
});

/** A request's cost center code (`{ code, name, owner }` in a RequestSummary), or the event's own (`budget.at_risk`). */
function costCenterOf(request: JsonObject | undefined, payload: JsonObject): string | null {
  const cc = request?.costCenter;
  if (cc && typeof cc === 'object' && typeof (cc as JsonObject).code === 'string') return (cc as JsonObject).code as string;
  if (typeof cc === 'string') return cc;
  return typeof payload.costCenter === 'string' ? payload.costCenter : null;
}

async function removeQuietly(ctx: IWebhookMethodContext, client: Landledger, id: string) {
  try {
    await client.deleteWebhook(id);
  } catch (error) {
    ctx.logger.warn('could not remove the earlier Landledger webhook before creating a new one', { id, error: (error as Error).message });
  }
}
