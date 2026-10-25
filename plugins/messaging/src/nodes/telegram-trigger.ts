import { defineNode, pollIntervalProperty, type JsonObject, type NodeItem } from '@landflow/sdk';
import { METRICS, type ApiContext } from '../shared';
import { telegramCall, type TelegramCredentials } from './telegram';

interface Update extends JsonObject {
  update_id: number;
}

interface PollState extends JsonObject {
  /** The next update_id to fetch: last seen + 1 (0 = nothing seen yet). */
  offset: number;
}

/** getUpdates returns at most 100 updates; one poll reads up to this many pages before handing over. */
const PAGE_SIZE = 100;
const MAX_PAGES = 10;
const MANUAL_ITEMS = 5;

/** Update types that carry a Message object. */
const MESSAGE_KEYS = ['message', 'edited_message', 'channel_post', 'edited_channel_post', 'business_message', 'edited_business_message'];

/** The raw update plus the fields most flows need: update_type, message, chat, from and text. */
export function updateToItem(update: Update): NodeItem {
  const type = Object.keys(update).find((key) => key !== 'update_id') ?? 'unknown';
  const callback = update.callback_query as JsonObject | undefined;
  const message = (MESSAGE_KEYS.map((key) => update[key]).find(Boolean) ?? callback?.message ?? null) as JsonObject | null;
  // A callback query's text is the button's data; the message it hangs off stays in `message`.
  const text = callback ? (callback.data ?? null) : (message?.text ?? message?.caption ?? null);
  return {
    json: {
      ...update,
      update_id: update.update_id,
      update_type: type,
      message,
      chat: message?.chat ?? null,
      from: callback?.from ?? message?.from ?? null,
      text,
    },
  };
}

export const TelegramTrigger = defineNode({
  description: {
    name: 'telegramTrigger',
    displayName: 'Telegram Trigger',
    description: 'Starts the workflow when the bot receives Telegram updates (polls getUpdates, no public URL needed)',
    version: 1,
    kind: 'trigger',
    triggerSource: 'poll',
    categories: ['Communication'],
    icon: 'file:telegram-trigger.svg',
    color: '#229ED9',
    subtitle: 'every {{pollInterval}}s',
    documentationUrl: 'https://core.telegram.org/bots/api#getupdates',
    keywords: ['telegram', 'bot', 'trigger', 'updates', 'getUpdates'],
    inputs: [],
    outputs: [{ type: 'main' }],
    credentials: [{ name: 'telegramApi', required: true }],
    properties: [
      pollIntervalProperty(30),
      {
        name: 'updates',
        displayName: 'Trigger On',
        type: 'multiOptions',
        default: ['message'],
        options: [
          { name: '*', value: '*', description: 'All update types Telegram sends by default' },
          { name: 'Message', value: 'message', description: 'New incoming message of any kind: text, photo, sticker…' },
          { name: 'Edited Message', value: 'edited_message' },
          { name: 'Channel Post', value: 'channel_post', description: 'New post in a channel the bot is an admin of' },
          { name: 'Callback Query', value: 'callback_query', description: 'A user pressed an inline keyboard button' },
        ],
      },
      {
        name: 'notice',
        displayName:
          'Polls getUpdates, so the bot must have no webhook (Telegram answers 409 otherwise: call deleteWebhook first). Only one poller per bot. Execute in the editor shows up to 5 recent updates without consuming them.',
        type: 'notice',
      },
    ],
  },
  async execute(ctx) {
    const credentials = ctx.getCredentials<TelegramCredentials>('telegramApi');
    const api: ApiContext = { http: ctx.http, metrics: ctx.metrics };
    const selected = ctx.getNodeParameter<string[]>('updates', 0, ['message']) ?? [];
    const all = selected.length === 0 || selected.includes('*');
    const matches = (update: Update) => all || Object.keys(update).some((key) => key !== 'update_id' && selected.includes(key));
    // Telegram filters server-side too; [] means "the default set". Not sent in manual mode, which must not change anything.
    const allowed_updates = all ? [] : selected;
    const getUpdates = (params: JsonObject) => telegramCall<Update[]>(api, credentials, 'getUpdates', { timeout: 0, ...params });

    if (ctx.mode === 'manual') {
      // No offset: nothing is confirmed, so the next scheduled poll still sees these updates.
      const recent = await getUpdates({ limit: PAGE_SIZE });
      return recent.filter(matches).slice(-MANUAL_ITEMS).map(updateToItem);
    }

    if (ctx.isFirstPoll()) {
      // offset -1 returns only the newest update; that is the baseline, nothing is emitted.
      const [newest] = await getUpdates({ offset: -1, limit: 1, allowed_updates });
      ctx.setPollState({ offset: newest ? newest.update_id + 1 : 0 } satisfies PollState);
      ctx.logger.info(`telegram trigger baseline at update ${newest?.update_id ?? 'none'}`);
      return [];
    }

    const previous = ctx.getPollState<PollState>();
    let offset = typeof previous?.offset === 'number' ? previous.offset : 0;
    const found: Update[] = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      // Passing offset confirms every update before it, so Telegram won't send them again.
      const batch = await getUpdates({ limit: PAGE_SIZE, allowed_updates, ...(offset > 0 && { offset }) });
      if (!batch.length) break;
      offset = batch[batch.length - 1].update_id + 1;
      found.push(...batch.filter(matches));
      if (batch.length < PAGE_SIZE) break;
    }
    ctx.setPollState({ offset } satisfies PollState);
    if (found.length) {
      ctx.metrics
        .counter(METRICS.pollUpdates, { description: 'New updates found by polling triggers', unit: '{update}' })
        .add(found.length, { service: 'telegram' });
      ctx.logger.info(`telegram trigger found ${found.length} new update(s)`, { 'landflow.poll.items': found.length });
    }
    return found.map(updateToItem);
  },
});
