/** Telegram node, Telegram Trigger and the telegramApi credential against a fake Bot API. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { JsonObject } from '@landflow/sdk';
import { Telegram } from '../src/nodes/telegram';
import { TelegramTrigger } from '../src/nodes/telegram-trigger';
import { jsonOf, run, startFakeApi, testCredentials, type FakeApi, type FakeRequest } from './helpers';

const TOKEN = '123456:test-token-abc';

/** A tiny Bot API: a queue of updates with Telegram's offset semantics, plus the send methods. */
class FakeTelegram {
  updates: JsonObject[] = [];
  nextId = 1000;
  webhook = false;

  push(kind: string, payload: JsonObject) {
    this.updates.push({ update_id: this.nextId++, [kind]: payload });
  }

  message(text: string, chatId = 42) {
    this.push('message', { message_id: this.nextId, date: 1, chat: { id: chatId, type: 'private' }, from: { id: 7, first_name: 'Ann' }, text });
  }

  handle = (req: FakeRequest) => {
    const match = /^\/bot([^/]+)\/(\w+)$/.exec(req.path);
    if (!match) return { status: 404, body: { ok: false, error_code: 404, description: 'Not Found' } };
    if (match[1] !== TOKEN) return { status: 401, body: { ok: false, error_code: 401, description: 'Unauthorized' } };
    const params = (req.body ?? {}) as JsonObject;
    const ok = (result: unknown) => ({ body: { ok: true, result } });
    switch (match[2]) {
      case 'getMe':
        return ok({ id: 1, is_bot: true, first_name: 'Test', username: 'landflow_test_bot' });
      case 'sendMessage':
      case 'sendPhoto':
        if (params.chat_id === 'missing') return { status: 400, body: { ok: false, error_code: 400, description: 'Bad Request: chat not found' } };
        return ok({
          message_id: 77,
          chat: { id: Number(params.chat_id) },
          date: 1,
          ...(params.text ? { text: params.text } : { photo: [{ file_id: 'f1' }], caption: params.caption }),
        });
      case 'editMessageText':
        return ok({ message_id: params.message_id, chat: { id: Number(params.chat_id) }, text: params.text, edit_date: 2 });
      case 'deleteMessage':
      case 'sendChatAction':
        return ok(true);
      case 'getChat':
        return ok({ id: Number(params.chat_id), type: 'group', title: 'Team' });
      case 'getUpdates':
        return this.getUpdates(params);
      default:
        return { status: 404, body: { ok: false, error_code: 404, description: 'Not Found: method not found' } };
    }
  };

  private getUpdates(params: JsonObject) {
    if (this.webhook) {
      return {
        status: 409,
        body: {
          ok: false,
          error_code: 409,
          description: "Conflict: can't use getUpdates method while webhook is active; use deleteWebhook to delete the webhook first",
        },
      };
    }
    const offset = Number(params.offset ?? 0);
    const limit = Number(params.limit ?? 100);
    if (offset < 0) {
      // Negative offset: the last -offset updates; everything before is forgotten.
      this.updates = this.updates.slice(offset);
    } else if (offset > 0) {
      this.updates = this.updates.filter((u) => Number(u.update_id) >= offset);
    }
    return { body: { ok: true, result: this.updates.slice(0, limit) } };
  }
}

let api: FakeApi;
let telegram: FakeTelegram;
const credentials = () => ({ telegramApi: { accessToken: TOKEN, baseUrl: api.url } });
const lastBody = () => api.requests.at(-1)!.body;

beforeAll(async () => {
  api = await startFakeApi();
});
afterAll(() => api.close());
beforeEach(() => {
  telegram = new FakeTelegram();
  api.handle(telegram.handle);
  api.requests.length = 0;
});

describe('telegramApi credential', () => {
  it('reports the bot username on success', async () => {
    expect(await testCredentials('telegramApi', { accessToken: TOKEN, baseUrl: api.url })).toEqual({
      ok: true,
      message: 'Authenticated as @landflow_test_bot',
    });
    expect(api.requests[0].path).toBe(`/bot${TOKEN}/getMe`);
  });

  it("returns Telegram's reason on failure, without the token", async () => {
    const result = await testCredentials('messaging.telegramApi', { accessToken: 'wrong-token-999', baseUrl: api.url });
    expect(result).toEqual({ ok: false, message: 'Telegram API error 401: Unauthorized' });
  });

  it('reports an unreachable server', async () => {
    const result = await testCredentials('telegramApi', { accessToken: TOKEN, baseUrl: 'http://127.0.0.1:1' });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/Telegram API request failed: fetch failed/);
  });
});

describe('Telegram node', () => {
  it('sends a message with the additional fields mapped to Bot API parameters', async () => {
    const response = await run(
      Telegram,
      {
        resource: 'message',
        operation: 'sendMessage',
        chatId: '42',
        text: 'Hello <b>team</b>',
        additionalFields: { parse_mode: 'HTML', disable_notification: true, disable_web_page_preview: true, reply_to_message_id: 5 },
      },
      { credentials: credentials() },
    );
    expect(response.error).toBeUndefined();
    expect(api.requests[0].method).toBe('POST');
    expect(api.requests[0].path).toBe(`/bot${TOKEN}/sendMessage`);
    expect(lastBody()).toEqual({
      chat_id: '42',
      text: 'Hello <b>team</b>',
      parse_mode: 'HTML',
      disable_notification: true,
      link_preview_options: { is_disabled: true },
      reply_parameters: { message_id: 5, allow_sending_without_reply: true },
    });
    expect(response.outputs[0]).toEqual([{ json: { message_id: 77, chat: { id: 42 }, date: 1, text: 'Hello <b>team</b>' }, pairedItem: { item: 0 } }]);
  });

  it('reads parameters per item and pairs every output with its input', async () => {
    const response = await run(
      Telegram,
      { resource: 'message', operation: 'sendMessage', chatId: '1', text: 'x' },
      {
        credentials: credentials(),
        items: [{ n: 1 }, { n: 2 }],
        perItem: [
          { chatId: '1', text: 'first' },
          { chatId: '2', text: 'second' },
        ],
      },
    );
    expect(api.requests.map((r) => [r.body.chat_id, r.body.text])).toEqual([
      ['1', 'first'],
      ['2', 'second'],
    ]);
    expect(response.outputs[0].map((i) => i.pairedItem)).toEqual([{ item: 0 }, { item: 1 }]);
  });

  it('sends a photo by URL with a caption', async () => {
    const response = await run(
      Telegram,
      { resource: 'message', operation: 'sendPhoto', chatId: '42', file: 'https://example.com/cat.jpg', additionalFields: { caption: 'A cat' } },
      { credentials: credentials() },
    );
    expect(lastBody()).toEqual({ chat_id: '42', photo: 'https://example.com/cat.jpg', caption: 'A cat' });
    expect(jsonOf(response)[0]).toMatchObject({ message_id: 77, caption: 'A cat' });
  });

  it('edits message text', async () => {
    const response = await run(
      Telegram,
      { resource: 'message', operation: 'editMessageText', chatId: '42', messageId: '77', text: 'edited', additionalFields: { parse_mode: 'MarkdownV2' } },
      { credentials: credentials() },
    );
    expect(lastBody()).toEqual({ chat_id: '42', message_id: 77, text: 'edited', parse_mode: 'MarkdownV2' });
    expect(jsonOf(response)[0]).toMatchObject({ message_id: 77, text: 'edited' });
  });

  it('deletes a message and sends a chat action', async () => {
    const deleted = await run(Telegram, { resource: 'message', operation: 'deleteMessage', chatId: '42', messageId: '77' }, { credentials: credentials() });
    expect(api.requests[0].path).toBe(`/bot${TOKEN}/deleteMessage`);
    expect(api.requests[0].body).toEqual({ chat_id: '42', message_id: 77 });
    expect(jsonOf(deleted)).toEqual([{ success: true }]);
    const action = await run(
      Telegram,
      { resource: 'message', operation: 'sendChatAction', chatId: '42', action: 'upload_photo' },
      { credentials: credentials() },
    );
    expect(lastBody()).toEqual({ chat_id: '42', action: 'upload_photo' });
    expect(jsonOf(action)).toEqual([{ success: true }]);
  });

  it('gets a chat', async () => {
    const response = await run(Telegram, { resource: 'chat', operation: 'get', chatId: '-100' }, { credentials: credentials() });
    expect(api.requests[0].path).toBe(`/bot${TOKEN}/getChat`);
    expect(jsonOf(response)).toEqual([{ id: -100, type: 'group', title: 'Team' }]);
  });

  it("puts Telegram's error and a hint in the node error, never the token", async () => {
    const response = await run(Telegram, { resource: 'message', operation: 'sendMessage', chatId: 'missing', text: 'x' }, { credentials: credentials() });
    expect(response.error).toMatchObject({ message: 'Telegram API error 400: Bad Request: chat not found', itemIndex: 0 });
    expect(response.error?.description).toMatch(/message the bot first/);
    const unauthorized = await run(
      Telegram,
      { resource: 'chat', operation: 'get', chatId: '1' },
      { credentials: { telegramApi: { accessToken: 'bad-token-0000', baseUrl: api.url } } },
    );
    expect(unauthorized.error?.message).toBe('Telegram API error 401: Unauthorized');
    expect(JSON.stringify(unauthorized)).not.toContain('bad-token-0000');
  });

  it('turns a failing item into { error } and goes on when the node continues on fail', async () => {
    const response = await run(
      Telegram,
      { resource: 'message', operation: 'sendMessage', text: 'x' },
      { credentials: credentials(), items: [{}, {}], perItem: [{ chatId: 'missing' }, { chatId: '42' }], continueOnFail: true },
    );
    expect(response.error).toBeUndefined();
    const [failed, sent] = response.outputs[0];
    expect(failed).toMatchObject({ json: { error: 'Telegram API error 400: Bad Request: chat not found' }, pairedItem: { item: 0 } });
    expect(sent.pairedItem).toEqual({ item: 1 });
    expect(sent.json.error).toBeUndefined();
  });

  it('validates required parameters and resource/operation combinations', async () => {
    expect((await run(Telegram, { resource: 'message', operation: 'sendMessage', chatId: '', text: 'x' }, { credentials: credentials() })).error?.message).toBe(
      'Chat ID is required',
    );
    expect((await run(Telegram, { resource: 'chat', operation: 'sendMessage', chatId: '1' }, { credentials: credentials() })).error?.message).toBe(
      'Operation "sendMessage" is not available for resource "chat"',
    );
    expect((await run(Telegram, { resource: 'message', operation: 'sendMessage', chatId: '1', text: 'x' })).error?.message).toBe(
      'No "telegramApi" credentials were provided',
    );
  });

  it('uses the defaults when parameters are not set', async () => {
    // The descriptor's last "operation" property (message resource) provides the default: sendMessage.
    await run(Telegram, { chatId: '42', text: 'defaults' }, { credentials: credentials() });
    expect(api.requests[0].path).toBe(`/bot${TOKEN}/sendMessage`);
  });
});

describe('Telegram Trigger', () => {
  const poll = (pollState?: JsonObject, updates: string[] = ['message']) =>
    run(TelegramTrigger, { pollInterval: 10, updates }, { credentials: credentials(), mode: 'poll', items: [], ...(pollState && { pollState }) });

  it('first poll: records the newest update as baseline and emits nothing', async () => {
    telegram.message('old 1');
    telegram.message('old 2');
    const first = await poll();
    expect(first.outputs).toEqual([[]]);
    expect(first.pollState).toEqual({ offset: 1002 });
    expect(api.requests[0].body).toMatchObject({ offset: -1, limit: 1, timeout: 0, allowed_updates: ['message'] });
  });

  it('first poll on an empty queue starts from offset 0', async () => {
    const first = await poll();
    expect(first.pollState).toEqual({ offset: 0 });
  });

  it('later polls emit only new updates, oldest first, with convenience fields, and advance the offset', async () => {
    telegram.message('old');
    const first = await poll();
    telegram.message('new 1');
    telegram.push('edited_message', { message_id: 9, chat: { id: 42 }, text: 'edited' });
    telegram.message('new 2', 43);
    const second = await poll(first.pollState);
    expect(api.requests.at(-1)!.body).toMatchObject({ offset: 1001, timeout: 0 });
    const items = jsonOf(second);
    expect(items.map((i) => i.text)).toEqual(['new 1', 'new 2']); // edited_message filtered out
    expect(items[0]).toMatchObject({
      update_id: 1001,
      update_type: 'message',
      chat: { id: 42, type: 'private' },
      from: { id: 7, first_name: 'Ann' },
      text: 'new 1',
    });
    expect(items[0].message).toEqual({ message_id: 1001, date: 1, chat: { id: 42, type: 'private' }, from: { id: 7, first_name: 'Ann' }, text: 'new 1' });
    expect(second.pollState).toEqual({ offset: 1004 }); // past the filtered update too
    const third = await poll(second.pollState);
    expect(third.outputs).toEqual([[]]);
    expect(third.pollState).toEqual({ offset: 1004 });
  });

  it('"*" emits every update type; callback queries get from/text from the query', async () => {
    const first = await poll(undefined, ['*']);
    telegram.push('callback_query', { id: 'cb1', from: { id: 8 }, data: 'yes', message: { message_id: 3, chat: { id: 42 }, text: 'Proceed?' } });
    telegram.push('channel_post', { message_id: 4, chat: { id: -100, type: 'channel' }, text: 'news' });
    const second = await poll(first.pollState, ['*']);
    expect(api.requests.at(-1)!.body.allowed_updates).toEqual([]);
    expect(jsonOf(second).map((i) => [i.update_type, i.text, (i.from as JsonObject | null)?.id ?? null, (i.chat as JsonObject).id])).toEqual([
      ['callback_query', 'yes', 8, 42],
      ['channel_post', 'news', null, -100],
    ]);
  });

  it('pages through more than 100 pending updates in one poll', async () => {
    const first = await poll();
    for (let i = 0; i < 150; i++) telegram.message(`m${i}`);
    const second = await poll(first.pollState);
    expect(second.outputs[0]).toHaveLength(150);
    expect(api.requests.filter((r) => r.path.endsWith('/getUpdates'))).toHaveLength(3); // baseline + 100 + 50
    expect(second.pollState).toEqual({ offset: 1150 });
  });

  it('manual mode returns up to 5 recent matching updates without an offset and leaves state alone', async () => {
    for (let i = 0; i < 7; i++) telegram.message(`m${i}`);
    telegram.push('edited_message', { message_id: 1, chat: { id: 1 }, text: 'e' });
    const manual = await run(TelegramTrigger, { updates: ['message'] }, { credentials: credentials(), mode: 'manual', items: [] });
    expect(jsonOf(manual).map((i) => i.text)).toEqual(['m2', 'm3', 'm4', 'm5', 'm6']);
    expect(manual.pollState).toBeUndefined();
    expect(api.requests[0].body).toEqual({ timeout: 0, limit: 100 });
    expect(telegram.updates).toHaveLength(8); // nothing confirmed
  });

  it('maps the 409 webhook conflict to a clear error, and keeps the old state', async () => {
    telegram.webhook = true;
    const response = await poll({ offset: 5 });
    expect(response.error?.message).toBe('Telegram API error 409: this bot has a webhook set, so getUpdates is unavailable');
    expect(response.error?.description).toMatch(/deleteWebhook/);
    expect(response.pollState).toBeUndefined();
  });
});
