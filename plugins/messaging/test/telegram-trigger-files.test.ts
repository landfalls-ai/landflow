/** Telegram Trigger with Download Files: the photo / document of an incoming message lands in item.binary.data. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { JsonObject } from '@landflow/sdk';
import { TelegramTrigger, fileOf } from '../src/nodes/telegram-trigger';
import { run, startFakeApi, type FakeApi, type FakeRequest } from './helpers';

const TOKEN = '123456:test-token-abc';
const PDF = Buffer.from('%PDF-1.4 inbound');
const JPG = Buffer.from('JFIF-photo-bytes');

const UPDATES: any[] = [
  { update_id: 11, message: { message_id: 1, chat: { id: 5 }, text: 'no file' } },
  { update_id: 12, message: { message_id: 2, chat: { id: 5 }, caption: 'look', photo: [{ file_id: 'small', file_size: 10 }, { file_id: 'big', file_size: JPG.length }] } },
  { update_id: 13, message: { message_id: 3, chat: { id: 5 }, document: { file_id: 'doc1', file_name: 'a.pdf', file_size: PDF.length } } },
  { update_id: 14, message: { message_id: 4, chat: { id: 5 }, video: { file_id: 'huge', file_size: 30 * 1024 * 1024 } } },
  { update_id: 15, message: { message_id: 5, chat: { id: 5 }, voice: { file_id: 'expired', file_size: 5 } } },
];

let api: FakeApi;
function bot(req: FakeRequest) {
  if (req.path === `/file/bot${TOKEN}/photos/big.jpg`) return { body: JPG.toString('latin1'), headers: { 'content-type': 'image/jpeg' } };
  if (req.path === `/file/bot${TOKEN}/documents/a.pdf`) return { body: PDF.toString('latin1'), headers: { 'content-type': 'application/pdf' } };
  const method = /^\/bot[^/]+\/(\w+)$/.exec(req.path)?.[1];
  if (method === 'getUpdates') return { body: { ok: true, result: UPDATES } };
  if (method === 'getFile') {
    const paths: Record<string, string> = { big: 'photos/big.jpg', doc1: 'documents/a.pdf' };
    const file_path = paths[req.body.file_id];
    if (!file_path) return { status: 400, body: { ok: false, error_code: 400, description: 'Bad Request: file is temporarily unavailable' } };
    return { body: { ok: true, result: { file_id: req.body.file_id, file_path } } };
  }
  return { status: 404, body: { ok: false, error_code: 404, description: 'Not Found' } };
}

const poll = (parameters: JsonObject, mode: 'poll' | 'manual' = 'poll') =>
  run(TelegramTrigger, { pollInterval: 10, updates: ['message'], ...parameters }, { credentials: { telegramApi: { accessToken: TOKEN, baseUrl: api.url } }, mode, items: [], ...(mode === 'poll' && { pollState: { offset: 11 } }) });

beforeAll(async () => {
  api = await startFakeApi(bot);
});
afterAll(() => api.close());
beforeEach(() => {
  api.requests.length = 0;
});

describe('Telegram Trigger files', () => {
  it('finds the largest photo and the other file kinds', () => {
    expect(fileOf({ json: { message: UPDATES[1].message } })).toEqual({ kind: 'photo', fileId: 'big', fileSize: JPG.length });
    expect(fileOf({ json: { message: UPDATES[0].message } })).toBeUndefined();
    expect(fileOf({ json: { message: null } })).toBeUndefined();
  });

  it('downloads photos and documents into item.binary.data, leaving the rest alone', async () => {
    const response = await poll({ downloadFiles: true });
    expect(response.error).toBeUndefined();
    const items = response.outputs[0];
    expect(items).toHaveLength(5);
    expect(items[0].binary).toBeUndefined();
    expect(items[1].json).toMatchObject({ update_id: 12, file_type: 'photo', text: 'look' });
    expect(items[1].binary?.data).toMatchObject({ mimeType: 'image/jpeg', fileName: 'big.jpg', fileSize: JPG.length });
    expect(Buffer.from(items[1].binary!.data.data!, 'base64').equals(JPG)).toBe(true);
    expect(items[2].binary?.data).toMatchObject({ mimeType: 'application/pdf', fileName: 'a.pdf' });
  });

  it('keeps the update when a file is too big or unavailable, with file_error', async () => {
    const items = (await poll({ downloadFiles: true })).outputs[0];
    expect(items[3].binary).toBeUndefined();
    expect(items[3].json.file_error).toMatch(/30\.0 MB; the cloud Bot API serves up to 20 MB/);
    expect(items[4].json.file_error).toMatch(/file is temporarily unavailable/);
    expect(items[4].json.update_id).toBe(15);
    expect(JSON.stringify(items)).not.toContain(TOKEN);
  });

  it('downloads nothing by default and works in manual mode', async () => {
    const off = (await poll({})).outputs[0];
    expect(off.every((i) => !i.binary)).toBe(true);
    expect(api.requests.every((r) => r.path.endsWith('/getUpdates'))).toBe(true);
    const manual = (await poll({ downloadFiles: true }, 'manual')).outputs[0];
    expect(manual.filter((i) => i.binary)).toHaveLength(2);
  });
});
