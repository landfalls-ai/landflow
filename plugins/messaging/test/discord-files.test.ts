/** Discord: item files uploaded with a message (multipart/form-data: payload_json + files[n]), bot and webhook. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runNode, type JsonObject } from '@landflow/sdk';
import type { BinaryRef } from '@landflow/protocol';
import { Discord } from '../src/nodes/discord';
import { plugin } from '../src/main';
import { executeRequest, startFakeApi, type FakeApi, type FakeRequest } from './helpers';

const BOT_TOKEN = 'test-bot-token-123';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 8, 9]);
const CSV = Buffer.from('a,b\n1,2\n');

let api: FakeApi;
const handle = (req: FakeRequest) => ({ body: { id: '5001', channel_id: 'CH1', attachments: [{ id: '1', filename: 'chart.png' }] } });
const bot = () => ({ discordBotApi: { botToken: BOT_TOKEN, baseUrl: `${api.url}/api/v10` } });
const webhook = () => ({ discordWebhookApi: { webhookUrl: `${api.url}/api/webhooks/111/hook-secret-1` } });
const inline = (bytes: Buffer, fileName: string, mimeType: string): BinaryRef => ({ mimeType, fileName, fileSize: bytes.length, data: bytes.toString('base64') });
const files = { chart: inline(PNG, 'chart.png', 'image/png'), table: inline(CSV, 'table.csv', 'text/csv') };

function send(parameters: JsonObject, credentials: Record<string, JsonObject>, binary: Record<string, BinaryRef> = files) {
  const request = executeRequest('discord', parameters, { credentials });
  request.inputs = [[{ json: {}, binary }]];
  return runNode(Discord, request, { credentialTypes: plugin.credentialTypes, pluginId: 'messaging' });
}

const lastForm = () => {
  const request = api.requests.at(-1)!;
  return new Response(new Uint8Array(request.raw), { headers: { 'content-type': String(request.headers['content-type']) } }).formData();
};

beforeAll(async () => {
  api = await startFakeApi(handle);
});
afterAll(() => api.close());
beforeEach(() => {
  api.requests.length = 0;
});

describe('Discord file uploads', () => {
  it('posts a bot message with files as multipart payload_json and files[n]', async () => {
    const response = await send(
      { authentication: 'botToken', resource: 'message', operation: 'send', channelId: 'CH1', content: 'Report', options: { attachments: 'chart, table', tts: true } },
      bot(),
    );
    expect(response.error).toBeUndefined();
    expect(api.requests[0].path).toBe('/api/v10/channels/CH1/messages');
    expect(api.requests[0].headers.authorization).toBe(`Bot ${BOT_TOKEN}`);
    expect(String(api.requests[0].headers['content-type'])).toMatch(/^multipart\/form-data; boundary=/);
    const form = await lastForm();
    expect(JSON.parse(String(form.get('payload_json')))).toEqual({
      content: 'Report',
      tts: true,
      attachments: [
        { id: 0, filename: 'chart.png' },
        { id: 1, filename: 'table.csv' },
      ],
    });
    const first = form.get('files[0]') as File;
    const second = form.get('files[1]') as File;
    expect([first.name, first.type, Buffer.from(await first.arrayBuffer()).equals(PNG)]).toEqual(['chart.png', 'image/png', true]);
    expect([second.name, Buffer.from(await second.arrayBuffer()).equals(CSV)]).toEqual(['table.csv', true]);
    expect(response.outputs[0][0].json).toMatchObject({ id: '5001' });
  });

  it('uploads through a webhook, with no message text', async () => {
    const response = await send({ authentication: 'webhook', resource: 'message', operation: 'send', content: '', options: { attachments: 'chart', username: 'CI' } }, webhook());
    expect(response.error).toBeUndefined();
    expect(api.requests[0].path).toBe('/api/webhooks/111/hook-secret-1');
    expect(api.requests[0].query.get('wait')).toBe('true');
    const form = await lastForm();
    expect(JSON.parse(String(form.get('payload_json')))).toMatchObject({ username: 'CI', attachments: [{ id: 0, filename: 'chart.png' }] });
    expect((form.get('files[0]') as File).name).toBe('chart.png');
  });

  it('still sends JSON without attachments, and names a missing file', async () => {
    await send({ authentication: 'botToken', resource: 'message', operation: 'send', channelId: 'CH1', content: 'plain' }, bot());
    expect(String(api.requests[0].headers['content-type'])).toBe('application/json');
    expect(api.requests[0].body).toEqual({ content: 'plain' });
    const missing = await send({ authentication: 'botToken', resource: 'message', operation: 'send', channelId: 'CH1', content: 'x', options: { attachments: 'nope' } }, bot());
    expect(missing.error?.message).toMatch(/no binary file “nope”/);
    expect(api.requests).toHaveLength(1);
  });
});
