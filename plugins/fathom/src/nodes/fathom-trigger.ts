import { ACTIVITY_ITEM_SCHEMA, defineNode, NodeOperationError, type JsonObject } from '@landflow/sdk';
import { fathomCall, meetingItems, TOLERANCE_SECONDS, verifyFathomSignature, type FathomCredentials } from '../fathom';
import { credentialsOf, MAPPING_OPTIONS, mappingOf } from './fathom';

const NOTICE =
  'Fathom\'s API registers the webhook for you: publishing the workflow creates it (the signing secret is kept for you) and unpublishing deletes it. ' +
  'Landflow must be reachable from the internet at the published URL. Transcripts stay out unless Include Transcript is on.';

const TRIGGERED_FOR = ['my_recordings', 'shared_external_recordings', 'my_shared_with_team_recordings', 'shared_team_recordings'];

interface Stored extends JsonObject {
  url: string;
  id: string;
  secret: string;
  flags: string;
}

/** What the webhook was created with, so a changed option re-creates it. */
function flagsOf(ctx: { getNodeParameter<T = unknown>(name: string, fallback?: T): T }) {
  const options = (ctx.getNodeParameter<JsonObject>('options', {}) ?? {}) as JsonObject;
  const actionItemItems = options.actionItemItems === true;
  const include = {
    include_summary: options.includeSummary !== false,
    include_action_items: options.includeActionItems !== false || actionItemItems,
    include_transcript: options.includeTranscript === true,
  };
  if (!include.include_summary && !include.include_action_items && !include.include_transcript) include.include_summary = true;
  const triggeredFor = (ctx.getNodeParameter<string[]>('triggeredFor', ['my_recordings']) ?? []).filter((v) => TRIGGERED_FOR.includes(v));
  return { include, triggeredFor: triggeredFor.length ? triggeredFor : ['my_recordings'], options };
}

/**
 * New meetings from Fathom's "new meeting content ready" webhook, as activity items (docs/protocol.md §16): one item
 * per meeting (kind work.meeting_notes with a summary, work.meeting_held without), optionally one per action item.
 * Landflow creates and deletes the webhook through Fathom's API and verifies each call's webhook-signature.
 */
export const FathomTrigger = defineNode({
  description: {
    name: 'fathomTrigger',
    displayName: 'Fathom Trigger',
    description: 'Starts the workflow when a Fathom meeting\'s content is ready, with the meeting (and optionally its action items) as activity items',
    version: 1,
    kind: 'trigger',
    triggerSource: 'appWebhook',
    categories: ['Productivity'],
    icon: 'file:fathom.svg',
    color: '#00b386',
    subtitle: '{{triggeredFor}}',
    documentationUrl: 'https://developers.fathom.ai/webhooks',
    keywords: ['fathom', 'trigger', 'webhook', 'meeting', 'notes', 'action items', 'activity'],
    inputs: [],
    outputs: [{ type: 'main' }],
    outputSchema: ACTIVITY_ITEM_SCHEMA,
    credentials: [{ name: 'fathomApi', required: true }],
    properties: [
      { name: 'notice', displayName: NOTICE, type: 'notice', default: '' },
      {
        name: 'triggeredFor',
        displayName: 'Triggered For',
        type: 'multiOptions',
        default: ['my_recordings'],
        options: [
          { name: 'My Recordings', value: 'my_recordings' },
          { name: 'Shared External Recordings', value: 'shared_external_recordings' },
          { name: 'My Recordings Shared With Team', value: 'my_shared_with_team_recordings' },
          { name: 'Shared Team Recordings', value: 'shared_team_recordings' },
        ],
        description: 'Which meetings send a webhook',
      },
      {
        name: 'options',
        displayName: 'Options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        values: [
          { name: 'includeSummary', displayName: 'Include Summary', type: 'boolean', default: true },
          { name: 'includeActionItems', displayName: 'Include Action Items', type: 'boolean', default: true },
          { name: 'includeTranscript', displayName: 'Include Transcript', type: 'boolean', default: false, description: 'Whether the transcript is requested from Fathom and added to each item\'s raw data. Off by default: transcripts are private.' },
          ...MAPPING_OPTIONS,
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
    ctx.logger.info('Fathom sends meetings to the published workflow; a manual run has no event to output (Meeting → Get Many Changed Since on the Fathom node lists recent meetings)');
    return [];
  },
  webhookMethods: {
    checkExists(ctx) {
      const data = ctx.getStaticData<Stored>();
      const { include, triggeredFor } = flagsOf(ctx);
      return Boolean(data.id && data.secret) && data.url === ctx.getWebhookUrl() && data.flags === JSON.stringify({ include, triggeredFor });
    },
    async create(ctx) {
      const credentials: FathomCredentials = credentialsOf(ctx);
      const { include, triggeredFor } = flagsOf(ctx);
      const hook = await ctx.span('fathom.webhook.create', {}, () =>
        fathomCall<JsonObject>({ http: ctx.http }, credentials, 'POST', '/webhooks', { body: { destination_url: ctx.getWebhookUrl(), triggered_for: triggeredFor, ...include } }),
      );
      if (typeof hook.id !== 'string' || typeof hook.secret !== 'string') throw new NodeOperationError('Fathom did not return a webhook id and secret');
      ctx.setStaticData({ url: ctx.getWebhookUrl(), id: hook.id, secret: hook.secret, flags: JSON.stringify({ include, triggeredFor }) } satisfies Stored);
      ctx.logger.info('Fathom webhook created', { id: hook.id });
      return true;
    },
    async delete(ctx) {
      const data = ctx.getStaticData<Stored>();
      if (data.id) {
        try {
          await fathomCall({ http: ctx.http }, credentialsOf(ctx), 'DELETE', `/webhooks/${encodeURIComponent(data.id)}`, { retries: 1 });
        } catch (error) {
          // Already gone on Fathom's side is fine; anything else keeps the record so the delete can be retried.
          if (!/\(404\)/.test((error as Error).message)) throw error;
        }
      }
      ctx.setStaticData({});
      return true;
    },
  },
  async webhook(ctx) {
    const data = ctx.getStaticData<Stored>();
    const options = (ctx.getNodeParameter<JsonObject>('options', {}) ?? {}) as JsonObject;
    const tolerance = Number(options.tolerance ?? TOLERANCE_SECONDS);
    const valid = verifyFathomSignature(
      String(data.secret ?? ''),
      ctx.getRawBody(),
      { id: ctx.getHeader('webhook-id'), timestamp: ctx.getHeader('webhook-timestamp'), signature: ctx.getHeader('webhook-signature') },
      { toleranceSeconds: Number.isFinite(tolerance) && tolerance >= 0 ? tolerance : TOLERANCE_SECONDS },
    );
    if (!valid) {
      ctx.logger.warn('rejected a call with a missing, invalid or stale Fathom signature');
      return { response: { status: 401, json: { error: 'invalid signature' } } };
    }
    const meeting = ctx.getBody<JsonObject>();
    if (!meeting || typeof meeting !== 'object' || meeting.recording_id === undefined) return { response: { status: 200, json: { ignored: 'not a meeting' } } };
    const items = meetingItems(meeting, mappingOf(options));
    // webhook-id is stable across Fathom's resends, so a redelivery is one run.
    const id = ctx.getHeader('webhook-id');
    return { items, ...(id && { idempotencyKey: id }) };
  },
});
