/** Telegram files: photos, documents, audio and video uploaded from item files (multipart), and Get File downloading into item.binary. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runNode, type BinaryDataClient, type JsonObject } from '@landflow/sdk';
import type { BinaryRef } from '@landflow/protocol';
import { Telegram } from '../src/nodes/telegram';
import { plugin } from '../src/main';
import { executeRequest, startFakeApi, type FakeApi, type FakeRequest } from './helpers';

const TOKEN = '123456:test-token-abc';
const PDF = Buffer.from('%PDF-1.4 a small report');

let api: FakeApi;
const credentials = () => ({ telegramApi: { accessToken: TOKEN, baseUrl: api.url } });

/** The Bot API's send methods echo what they got; getFile and /file/ serve one document. */
function handle(req: FakeRequest) {
  if (req.path === `/file/bot${TOKEN}/documents/file_7.pdf`) return { body: PDF.toString('latin1'), headers: { 'content-type': 'application/pdf' } };
  if (req.path.startsWith('/file/')) return { status: 404, body: { ok: false, error_code: 404, description: 'Not Found' } };
  const method = /^\/bot[^/]+\/(\w+)$/.exec(req.path)?.[1];
  if (method === 'getFile') {
    if (req.body?.file_id === 'gone') return { body: { ok: true, result: { file_id: 'gone', file_unique_id: 'u0', file_size: 3, file_path: 'documents/missing.pdf' } } };
    return { body: { ok: true, result: { file_id: req.body?.file_id, file_unique_id: 'u7', file_size: PDF.length, file_path: 'documents/file_7.pdf' } } };
  }
  if (method?.startsWith('send')) return { body: { ok: true, result: { message_id: 9, chat: { id: 42 }, document: { file_id: 'new-file' } } } };
  return { status: 404, body: { ok: false, error_code: 404, description: 'Not Found: method not found' } };
}

/** The multipart form of the last request. */
const lastForm = async () => {
  const request = api.requests.at(-1)!;
  return new Response(new Uint8Array(request.raw), { headers: { 'content-type': String(request.headers['content-type']) } }).formData();
};

const inline = (bytes: Buffer, fileName: string, mimeType: string): BinaryRef => ({ mimeType, fileName, fileSize: bytes.length, data: bytes.toString('base64') });

/** Run with input items that carry files, and optionally a binary client (as the host gives plugins). */
function run(parameters: JsonObject, items: Array<{ json: JsonObject; binary?: Record<string, BinaryRef> }> = [{ json: {} }], binary?: BinaryDataClient) {
  const request = { ...executeRequest('telegram', parameters, { credentials: credentials(), items: items.map((i) => i.json) }) };
  request.inputs = [items.map((item) => ({ json: item.json, ...(item.binary && { binary: item.binary }) }))];
  return runNode(Telegram, request, { credentialTypes: plugin.credentialTypes, pluginId: 'messaging', ...(binary && { binary }) });
}

beforeAll(async () => {
  api = await startFakeApi(handle);
});
afterAll(() => api.close());
beforeEach(() => {
  api.handle(handle);
  api.requests.length = 0;
});

describe('Telegram file uploads', () => {
  it('uploads an item file as a document, with caption and file name', async () => {
    const response = await run(
      { resource: 'message', operation: 'sendDocument', chatId: '42', binaryData: true, binaryPropertyName: 'report', additionalFields: { caption: 'Q3 <b>numbers</b>', parse_mode: 'HTML', fileName: 'q3.pdf', reply_to_message_id: 3 } },
      [{ json: {}, binary: { report: inline(PDF, 'report.pdf', 'application/pdf') } }],
    );
    expect(response.error).toBeUndefined();
    expect(api.requests[0].path).toBe(`/bot${TOKEN}/sendDocument`);
    expect(String(api.requests[0].headers['content-type'])).toMatch(/^multipart\/form-data; boundary=/);
    const form = await lastForm();
    expect(form.get('chat_id')).toBe('42');
    expect(form.get('caption')).toBe('Q3 <b>numbers</b>');
    expect(form.get('parse_mode')).toBe('HTML');
    expect(JSON.parse(String(form.get('reply_parameters')))).toEqual({ message_id: 3, allow_sending_without_reply: true });
    const file = form.get('document') as File;
    expect([file.name, file.type, Buffer.from(await file.arrayBuffer()).equals(PDF)]).toEqual(['q3.pdf', 'application/pdf', true]);
    expect(response.outputs[0][0].json).toMatchObject({ message_id: 9 });
  });

  it('streams a stored file through the binary client for photos, audio and video', async () => {
    const stored: BinaryRef = { id: 'ex_test.storedfile01', mimeType: 'image/png', fileName: 'chart.png', fileSize: 4 };
    const client: BinaryDataClient = {
      read: async (ref) => (ref.id === stored.id ? new Uint8Array([0x89, 0x50, 0x4e, 0x47]) : Promise.reject(new Error('unknown'))),
      stream: async () => new Blob([]).stream(),
      write: async () => stored,
    };
    for (const [operation, field] of [
      ['sendPhoto', 'photo'],
      ['sendAudio', 'audio'],
      ['sendVideo', 'video'],
    ]) {
      const response = await run({ resource: 'message', operation, chatId: '42', binaryData: true, binaryPropertyName: 'data' }, [{ json: {}, binary: { data: stored } }], client);
      expect(response.error, operation).toBeUndefined();
      const file = (await lastForm()).get(field) as File;
      expect([file.name, file.size]).toEqual(['chart.png', 4]);
    }
  });

  it('still sends URLs and file_ids as JSON', async () => {
    const response = await run({ resource: 'message', operation: 'sendDocument', chatId: '42', file: 'https://example.com/a.pdf' });
    expect(response.error).toBeUndefined();
    expect(api.requests[0].body).toEqual({ chat_id: '42', document: 'https://example.com/a.pdf' });
  });

  it('names the missing file and refuses files over the Bot API limit', async () => {
    const missing = await run({ resource: 'message', operation: 'sendDocument', chatId: '42', binaryData: true, binaryPropertyName: 'data' }, [{ json: {}, binary: { other: inline(PDF, 'a.pdf', 'application/pdf') } }]);
    expect(missing.error).toMatchObject({ message: 'Item 0 has no binary file “data”', description: 'Its files: other' });

    const huge: BinaryRef = { id: 'ex_test.hugefile0001', mimeType: 'image/jpeg', fileName: 'huge.jpg', fileSize: 11 * 1024 * 1024 };
    const tooBig = await runNode(
      Telegram,
      (() => {
        const request = executeRequest('telegram', { resource: 'message', operation: 'sendPhoto', chatId: '42', binaryData: true, binaryPropertyName: 'data' }, { credentials: { telegramApi: { accessToken: TOKEN, baseUrl: '' } } });
        request.inputs = [[{ json: {}, binary: { data: huge } }]];
        return request;
      })(),
      { credentialTypes: plugin.credentialTypes, pluginId: 'messaging' },
    );
    expect(tooBig.error?.message).toBe('huge.jpg is too big for Telegram (11.0 MB)');
    expect(tooBig.error?.description).toMatch(/up to 10 MB/);
  });
});

describe('Telegram Get File', () => {
  it('downloads the file into item.binary', async () => {
    const response = await run({ resource: 'file', operation: 'get', fileId: 'abc', binaryPropertyName: 'doc' });
    expect(response.error).toBeUndefined();
    expect(api.requests.map((r) => r.path)).toEqual([`/bot${TOKEN}/getFile`, `/file/bot${TOKEN}/documents/file_7.pdf`]);
    const [item] = response.outputs[0];
    expect(item.json).toEqual({ file_id: 'abc', file_unique_id: 'u7', file_size: PDF.length, file_path: 'documents/file_7.pdf' });
    expect(item.binary?.doc).toMatchObject({ fileName: 'file_7.pdf', mimeType: 'application/pdf', fileSize: PDF.length, fileType: 'pdf' });
    expect(Buffer.from(item.binary!.doc.data!, 'base64').equals(PDF)).toBe(true);
  });

  it('returns only the details without Download, and explains a vanished file', async () => {
    const details = await run({ resource: 'file', operation: 'get', fileId: 'abc', download: false });
    expect(details.outputs[0][0]).toEqual({ json: expect.objectContaining({ file_path: 'documents/file_7.pdf' }), pairedItem: { item: 0 } });
    const gone = await run({ resource: 'file', operation: 'get', fileId: 'gone' });
    expect(gone.error).toMatchObject({ message: 'Telegram API error 404: the file download failed', description: 'The file is no longer available; get a fresh file_id.' });
  });
});
