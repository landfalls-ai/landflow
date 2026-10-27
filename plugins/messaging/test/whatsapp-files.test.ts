/** WhatsApp media: upload an item file to /media and send by ID; download received media into item.binary. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runNode, type JsonObject } from '@landflow/sdk';
import type { BinaryRef } from '@landflow/protocol';
import { WhatsApp } from '../src/nodes/whatsapp';
import { plugin } from '../src/main';
import { executeRequest, startFakeApi, type FakeApi, type FakeRequest } from './helpers';

const TOKEN = 'test-wa-token-123';
const PDF = Buffer.from('%PDF-1.4 invoice');
const JPG = Buffer.from('JFIF-image-bytes\x01\x02', 'latin1');

function graph(req: FakeRequest) {
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return { status: 401, body: { error: { message: 'Invalid OAuth access token', code: 190 } } };
  if (req.path === '/v21.0/1111/media' && req.method === 'POST') return { body: { id: 'media-777' } };
  if (req.path === '/v21.0/1111/messages') return { body: { messaging_product: 'whatsapp', messages: [{ id: 'wamid.X1' }] } };
  if (req.path === '/v21.0/media-42') return { body: { messaging_product: 'whatsapp', url: `${api.url}/lookaside/photo`, mime_type: 'image/jpeg', sha256: 'abc', file_size: JPG.length, id: 'media-42' } };
  if (req.path === '/v21.0/media-gone') return { status: 404, body: { error: { message: 'Media not found', code: 100 } } };
  if (req.path === '/v21.0/media-dead') return { body: { url: `${api.url}/lookaside/dead`, mime_type: 'image/jpeg', id: 'media-dead' } };
  if (req.path === '/lookaside/photo') return { body: JPG.toString('latin1'), headers: { 'content-type': 'image/jpeg' } };
  return { status: 404, body: { error: { message: 'Not found' } } };
}

let api: FakeApi;
const credentials = () => ({ whatsAppApi: { accessToken: TOKEN, businessAccountId: '1029', baseUrl: `${api.url}/v21.0` } });
const inline = (bytes: Buffer, fileName: string, mimeType: string): BinaryRef => ({ mimeType, fileName, fileSize: bytes.length, data: bytes.toString('base64') });

function run(parameters: JsonObject, binary?: Record<string, BinaryRef>) {
  const request = executeRequest('whatsApp', parameters, { credentials: credentials() });
  if (binary) request.inputs = [[{ json: {}, binary }]];
  return runNode(WhatsApp, request, { credentialTypes: plugin.credentialTypes, pluginId: 'messaging' });
}

beforeAll(async () => {
  api = await startFakeApi(graph);
});
afterAll(() => api.close());
beforeEach(() => {
  api.requests.length = 0;
  api.handle(graph);
});

describe('WhatsApp media upload and send', () => {
  it('uploads the item file to /media, then sends the document by ID with the file name', async () => {
    const response = await run(
      { resource: 'message', operation: 'send', phoneNumberId: '1111', recipientPhoneNumber: '+1 555 123 4567', messageType: 'document', mediaSource: 'binary', binaryPropertyName: 'invoice', mediaCaption: 'Your invoice' },
      { invoice: inline(PDF, 'invoice.pdf', 'application/pdf') },
    );
    expect(response.error).toBeUndefined();
    const [upload, message] = api.requests;
    expect(upload.path).toBe('/v21.0/1111/media');
    expect(String(upload.headers['content-type'])).toMatch(/^multipart\/form-data; boundary=/);
    const form = await new Response(new Uint8Array(upload.raw), { headers: { 'content-type': String(upload.headers['content-type']) } }).formData();
    expect([form.get('messaging_product'), form.get('type')]).toEqual(['whatsapp', 'application/pdf']);
    const file = form.get('file') as File;
    expect([file.name, Buffer.from(await file.arrayBuffer()).equals(PDF)]).toEqual(['invoice.pdf', true]);
    expect(message.body).toMatchObject({ type: 'document', to: '+15551234567', document: { id: 'media-777', caption: 'Your invoice', filename: 'invoice.pdf' } });
    expect(response.outputs[0][0].json).toMatchObject({ messageId: 'wamid.X1' });
  });

  it('sends by an existing media ID, and Upload returns the ID without sending', async () => {
    await run({ resource: 'message', operation: 'send', phoneNumberId: '1111', recipientPhoneNumber: '1555', messageType: 'image', mediaSource: 'id', mediaId: 'media-5' });
    expect(api.requests[0].body).toMatchObject({ type: 'image', image: { id: 'media-5' } });
    api.requests.length = 0;
    const response = await run({ resource: 'media', operation: 'upload', phoneNumberId: '1111', binaryPropertyName: 'p' }, { p: inline(JPG, 'p.jpg', 'image/jpeg') });
    expect(api.requests.map((r) => r.path)).toEqual(['/v21.0/1111/media']);
    expect(response.outputs[0][0].json).toEqual({ mediaId: 'media-777', fileName: 'p.jpg', mimeType: 'image/jpeg' });
  });

  it('keeps the URL source and reports a missing file', async () => {
    await run({ resource: 'message', operation: 'send', phoneNumberId: '1111', recipientPhoneNumber: '1555', messageType: 'image', mediaLink: 'https://example.com/a.png' });
    expect(api.requests[0].body.image).toEqual({ link: 'https://example.com/a.png' });
    const missing = await run({ resource: 'message', operation: 'send', phoneNumberId: '1111', recipientPhoneNumber: '1555', messageType: 'image', mediaSource: 'binary', binaryPropertyName: 'nope' }, { p: inline(JPG, 'p.jpg', 'image/jpeg') });
    expect(missing.error?.message).toMatch(/no binary file “nope”/);
    expect(api.requests).toHaveLength(1);
  });
});

describe('WhatsApp media download', () => {
  it('gets the media URL, downloads it with the token and puts the file in item.binary', async () => {
    const response = await run({ resource: 'media', operation: 'get', mediaId: 'media-42', binaryPropertyName: 'photo' });
    expect(response.error).toBeUndefined();
    expect(api.requests.map((r) => r.path)).toEqual(['/v21.0/media-42', '/lookaside/photo']);
    expect(api.requests[1].headers.authorization).toBe(`Bearer ${TOKEN}`);
    const [item] = response.outputs[0];
    expect(item.json).toMatchObject({ id: 'media-42', mime_type: 'image/jpeg', file_size: JPG.length });
    expect(item.binary?.photo).toMatchObject({ mimeType: 'image/jpeg', fileName: 'media-42.jpg', fileSize: JPG.length });
    expect(Buffer.from(item.binary!.photo.data!, 'base64').equals(JPG)).toBe(true);
  });

  it('returns only the details with Download File off, and maps errors', async () => {
    const info = await run({ resource: 'media', operation: 'get', mediaId: 'media-42', download: false });
    expect(api.requests).toHaveLength(1);
    expect(info.outputs[0][0].binary).toBeUndefined();
    const gone = await run({ resource: 'media', operation: 'get', mediaId: 'media-gone' });
    expect(gone.error?.message).toMatch(/WhatsApp API error 404: Media not found/);
    const dead = await run({ resource: 'media', operation: 'get', mediaId: 'media-dead' });
    expect(dead.error?.message).toMatch(/WhatsApp API error 404: the media download failed/);
    expect(dead.error?.description).toMatch(/expired/);
  });
});
