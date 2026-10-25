/** WhatsApp Business Cloud node and the whatsAppApi credential against a fake Graph API. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { JsonObject } from '@landflow/sdk';
import { WhatsApp } from '../src/nodes/whatsapp';
import { jsonOf, loadOptions, run, startFakeApi, testCredentials, type FakeApi, type FakeRequest } from './helpers';

const TOKEN = 'test-wa-token-123';
const WABA = '1029384756';

function graph(req: FakeRequest) {
  if (req.headers.authorization !== `Bearer ${TOKEN}`) {
    return {
      status: 401,
      body: { error: { message: 'Invalid OAuth access token - Cannot parse access token', type: 'OAuthException', code: 190, fbtrace_id: 'Ab1' } },
    };
  }
  const path = req.path.replace(/^\/v21\.0/, '');
  if (path === `/${WABA}/phone_numbers`) {
    return {
      body: {
        data: [
          { id: '1111', display_phone_number: '+1 555-0100', verified_name: 'Acme Support' },
          { id: '2222', display_phone_number: '+1 555-0101' },
        ],
      },
    };
  }
  if (path === '/1111/messages' && req.method === 'POST') {
    if (req.body.to === '15550000000') {
      return {
        status: 400,
        body: {
          error: {
            message: '(#131030) Recipient phone number not in allowed list',
            type: 'OAuthException',
            code: 131030,
            error_data: { details: 'Add it to the allowed list' },
          },
        },
      };
    }
    return { body: { messaging_product: 'whatsapp', contacts: [{ input: req.body.to, wa_id: req.body.to }], messages: [{ id: 'wamid.HBgL123' }] } };
  }
  return { status: 404, body: { error: { message: 'Unknown path', code: 803 } } };
}

let api: FakeApi;
const credentials = () => ({ whatsAppApi: { accessToken: TOKEN, businessAccountId: WABA, baseUrl: `${api.url}/v21.0` } });
const send = (parameters: JsonObject) =>
  run(WhatsApp, { resource: 'message', phoneNumberId: '1111', recipientPhoneNumber: '+1 (555) 123-4567', ...parameters }, { credentials: credentials() });
const sent = () => api.requests.at(-1)!.body;

beforeAll(async () => {
  api = await startFakeApi(graph);
});
afterAll(() => api.close());
beforeEach(() => {
  api.requests.length = 0;
});

describe('whatsAppApi credential', () => {
  it('lists the phone numbers of the business account', async () => {
    expect(await testCredentials('whatsAppApi', { accessToken: TOKEN, businessAccountId: WABA, baseUrl: `${api.url}/v21.0` })).toEqual({
      ok: true,
      message: 'Business account has 2 phone number(s)',
    });
    expect(api.requests[0]).toMatchObject({ method: 'GET', path: `/v21.0/${WABA}/phone_numbers` });
  });

  it("returns the Graph API's reason on failure", async () => {
    const result = await testCredentials('whatsAppApi', { accessToken: 'bad-token-0000', businessAccountId: WABA, baseUrl: `${api.url}/v21.0` });
    expect(result).toEqual({ ok: false, message: 'WhatsApp API error 401: Invalid OAuth access token - Cannot parse access token (code 190)' });
    expect(await testCredentials('whatsAppApi', { accessToken: TOKEN, businessAccountId: '', baseUrl: api.url })).toEqual({
      ok: false,
      message: 'The WhatsApp credential has no Business Account ID',
    });
  });
});

describe('WhatsApp message', () => {
  it('sends text to the normalized recipient', async () => {
    const response = await send({ operation: 'send', messageType: 'text', textBody: 'Hi there', previewUrl: true });
    expect(response.error).toBeUndefined();
    expect(api.requests[0]).toMatchObject({ method: 'POST', path: '/v21.0/1111/messages' });
    expect(sent()).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '+15551234567',
      type: 'text',
      text: { body: 'Hi there', preview_url: true },
    });
    expect(jsonOf(response)).toEqual([
      {
        messageId: 'wamid.HBgL123',
        messaging_product: 'whatsapp',
        contacts: [{ input: '+15551234567', wa_id: '+15551234567' }],
        messages: [{ id: 'wamid.HBgL123' }],
      },
    ]);
  });

  it('sends media by URL: captions where WhatsApp allows them, a filename for documents', async () => {
    await send({ operation: 'send', messageType: 'image', mediaLink: 'https://example.com/a.png', mediaCaption: 'Chart' });
    expect(sent()).toMatchObject({ type: 'image', image: { link: 'https://example.com/a.png', caption: 'Chart' } });
    await send({ operation: 'send', messageType: 'document', mediaLink: 'https://example.com/r.pdf', mediaCaption: 'Report', mediaFilename: 'report.pdf' });
    expect(sent()).toMatchObject({ type: 'document', document: { link: 'https://example.com/r.pdf', caption: 'Report', filename: 'report.pdf' } });
    await send({ operation: 'send', messageType: 'audio', mediaLink: 'https://example.com/v.ogg', mediaCaption: 'ignored' });
    expect(sent()).toMatchObject({ type: 'audio', audio: { link: 'https://example.com/v.ogg' } });
    expect(sent().audio.caption).toBeUndefined();
    await send({ operation: 'send', messageType: 'video', mediaLink: 'https://example.com/v.mp4', mediaCaption: 'Demo' });
    expect(sent()).toMatchObject({ type: 'video', video: { link: 'https://example.com/v.mp4', caption: 'Demo' } });
    expect((await send({ operation: 'send', messageType: 'image', mediaLink: '' })).error?.message).toBe('Media URL is required');
  });

  it('sends a template with components', async () => {
    const components = [{ type: 'body', parameters: [{ type: 'text', text: 'Ann' }] }];
    const response = await send({ operation: 'sendTemplate', templateName: 'order_update', languageCode: 'de', components: JSON.stringify(components) });
    expect(response.error).toBeUndefined();
    expect(sent()).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '+15551234567',
      type: 'template',
      template: { name: 'order_update', language: { code: 'de' }, components },
    });
    expect((await send({ operation: 'sendTemplate', templateName: 'x', components: '{"type":"body"}' })).error?.message).toBe(
      'Components must be a JSON array',
    );
  });

  it('puts the Graph error and its details into the node error', async () => {
    const response = await send({ operation: 'send', messageType: 'text', textBody: 'x', recipientPhoneNumber: '15550000000' });
    expect(response.error).toMatchObject({
      message: 'WhatsApp API error 400: (#131030) Recipient phone number not in allowed list (code 131030)',
      description: 'Add it to the allowed list',
      itemIndex: 0,
    });
  });

  it('lists sender phone numbers for the picker', async () => {
    expect(await loadOptions(WhatsApp, 'getPhoneNumbers', {}, credentials())).toEqual([
      { name: 'Acme Support (+1 555-0100)', value: '1111' },
      { name: '+1 555-0101', value: '2222' },
    ]);
    expect(api.requests[0].query.get('fields')).toBe('id,display_phone_number,verified_name');
  });
});
