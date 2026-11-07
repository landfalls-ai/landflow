import { NodeOperationError, defineNode, type IWebhookContext, type IWebhookMethodContext, type JsonObject } from '@landflow/sdk';
import { CloudEventError, deliveryKey, matchesType, parseCloudEvents, parsePatterns, secretMatches } from '../cloudevents';
import type { EventCredential } from '../credentials';

export const MIN_SECRET_LENGTH = 16;
export const DEFAULT_SECRET_HEADER = 'x-sap-event-secret';

const NOTICE =
  'S/4HANA Cloud does not call a webhook itself: it publishes business events to SAP Event Mesh, Advanced Event Mesh or Cloud Application Event Hub (paid BTP services; see docs/sap.md). ' +
  'Publish the workflow, copy this node\'s Request URL from the editor\'s Publish menu (App webhooks) into a REST/webhook delivery point of your broker, and have the broker send the secret of the credential in its header. ' +
  'This node only checks the secret and reads CloudEvents (JSON, binary or batch); it does not register anything at SAP. An event is thin: it carries the key of the changed object, so follow it with an SAP Get. Whether your broker can send this way is unverified.';

interface TriggerStatic extends JsonObject {
  url: string;
}

const credentialOf = (ctx: IWebhookContext | IWebhookMethodContext) => ctx.getCredentials<EventCredential & JsonObject>('sapEventApi');

export const sapEvent = defineNode({
  description: {
    name: 'sapEvent',
    displayName: 'SAP Event Trigger',
    description: 'Starts the workflow on a business event that an SAP event broker delivers to a webhook (CloudEvents), for example BusinessPartner.Changed or SalesOrder.Created',
    version: 1,
    kind: 'trigger',
    triggerSource: 'appWebhook',
    categories: ['SAP', 'Data'],
    icon: 'file:sap.svg',
    color: '#0a6ed1',
    subtitle: '{{eventTypes}}',
    keywords: ['sap', 's/4hana', 'event', 'webhook', 'cloudevents', 'event mesh', 'trigger'],
    inputs: [],
    outputs: [{ type: 'main' }],
    credentials: [{ name: 'sapEventApi', required: true }],
    properties: [
      { name: 'notice', displayName: NOTICE, type: 'notice', default: '' },
      {
        name: 'eventTypes',
        displayName: 'Event Types',
        type: 'string',
        default: '*',
        placeholder: 'sap.s4.beh.businesspartner.v1.BusinessPartner.Changed.v1, *SalesOrder.Created*',
        description: 'Comma separated event types (or topics) that start a run; * matches any text. Empty or * is every event the broker delivers',
      },
    ],
  },
  execute(ctx) {
    ctx.logger.info('SAP events arrive at the published workflow; a manual run has no event to output');
    return [];
  },
  webhookMethods: {
    /** Nothing is registered at SAP: "exists" means this node registered itself for the current URL. */
    checkExists(ctx) {
      const data = ctx.getStaticData<TriggerStatic>();
      return Boolean(data.url) && data.url === ctx.getWebhookUrl();
    },
    create(ctx) {
      const credential = credentialOf(ctx);
      if (String(credential.secret ?? '').length < MIN_SECRET_LENGTH) {
        throw new NodeOperationError(`The SAP event secret needs at least ${MIN_SECRET_LENGTH} characters`, { description: 'Save a long random secret in the credential and enter the same one in the broker\'s delivery point.' });
      }
      ctx.setStaticData({ url: ctx.getWebhookUrl() } satisfies TriggerStatic);
      ctx.logger.info('SAP Event Trigger ready: point the broker delivery point at the Request URL and send the secret in the credential\'s header', { url: ctx.getWebhookUrl() });
      return true;
    },
    delete(ctx) {
      ctx.setStaticData({});
      return true;
    },
  },
  webhook(ctx: IWebhookContext) {
    const request = ctx.getRequest();
    if (request.method.toUpperCase() !== 'POST') return { response: { status: 405, headers: { allow: 'POST' }, json: { error: 'POST only' } } };
    const credential = credentialOf(ctx);
    const expected = String(credential.secret ?? '');
    const header = String(credential.headerName || DEFAULT_SECRET_HEADER).toLowerCase();
    if (expected.length < MIN_SECRET_LENGTH || !secretMatches(ctx.getHeader(header), expected)) {
      ctx.logger.warn(expected.length < MIN_SECRET_LENGTH ? 'rejected a delivery: the credential has no usable secret' : 'rejected a delivery with a missing or wrong secret');
      return { response: { status: 401, json: { error: 'invalid secret' } } };
    }
    let events;
    try {
      events = parseCloudEvents(request.headers, request.rawBody);
    } catch (error) {
      if (error instanceof CloudEventError) return { response: { status: 400, json: { error: error.message } } };
      throw error;
    }
    const patterns = parsePatterns(ctx.getNodeParameter('eventTypes', '*'));
    const wanted = events.filter((event) => matchesType(event.type, patterns.includes('*') ? [] : patterns));
    if (wanted.length === 0) return { response: { status: 200, json: { ignored: events.map((e) => e.type).slice(0, 5) } } };
    return { items: wanted.map((event) => ({ json: event as unknown as JsonObject })), idempotencyKey: deliveryKey(wanted) };
  },
});
