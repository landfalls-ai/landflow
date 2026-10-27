/** Twilio files: call recordings and received MMS media downloaded into item.binary. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { JsonObject } from '@landflow/sdk';
import { Twilio } from '../src/nodes/twilio';
import { run, startFakeApi, type FakeApi, type FakeReply, type FakeRequest } from './helpers';

const SID = 'AC' + '1'.repeat(32);
const TOKEN = 'test-twilio-token';
const MP3 = Buffer.from('ID3-fake-mp3-audio');
const JPG = Buffer.from('JFIF-fake-image');
const base = `/2010-04-01/Accounts/${SID}`;
const auth = `Basic ${Buffer.from(`${SID}:${TOKEN}`).toString('base64')}`;

let api: FakeApi;
function twilio(req: FakeRequest): FakeReply {
  if (req.path.startsWith('/cdn/')) return req.headers.authorization ? { status: 400, body: 'credentials leaked to the CDN' } : { body: JPG.toString('latin1'), headers: { 'content-type': 'image/jpeg' } };
  if (req.headers.authorization !== auth) return { status: 401, body: { code: 20003, message: 'Authenticate', status: 401 } };
  if (req.path === `${base}/Recordings/RE1.mp3`) return { body: MP3.toString('latin1'), headers: { 'content-type': 'audio/mpeg' } };
  if (req.path === `${base}/Recordings/RE1.wav`) return { body: 'RIFF', headers: { 'content-type': 'audio/x-wav' } };
  if (req.path === `${base}/Recordings/REnone.mp3`) return { status: 404, body: { code: 20404, message: 'The requested resource was not found', status: 404 } };
  if (req.path === `${base}/Recordings.json`) return { body: { recordings: [{ sid: 'RE1', call_sid: req.query.get('CallSid') ?? 'CAx' }], next_page_uri: null } };
  if (req.path === `${base}/Messages/MM1/Media.json`) {
    return {
      body: {
        media_list: [
          { sid: 'ME1', content_type: 'image/jpeg', uri: `${base}/Messages/MM1/Media/ME1.json` },
          { sid: 'ME2', content_type: 'image/jpeg', uri: `${base}/Messages/MM1/Media/ME2.json` },
        ],
        next_page_uri: null,
      },
    };
  }
  // Twilio answers a media URL with a redirect to a CDN on another origin.
  if (/\/Media\/ME\d$/.test(req.path)) return { status: 302, headers: { location: `${api.url.replace('127.0.0.1', 'localhost')}/cdn/${req.path.split('/').pop()}` } };
  return { status: 404, body: { code: 20404, message: 'not found', status: 404 } };
}

const credentials = () => ({ twilioApi: { authType: 'authToken', accountSid: SID, authToken: TOKEN, baseUrl: api.url } });
const call = (parameters: JsonObject) => run(Twilio, parameters, { credentials: credentials() });

beforeAll(async () => {
  api = await startFakeApi(twilio);
});
afterAll(() => api.close());
beforeEach(() => {
  api.requests.length = 0;
});

describe('Twilio recordings', () => {
  it('downloads a recording as MP3 into item.binary', async () => {
    const response = await call({ resource: 'recording', operation: 'download', recordingSid: 'RE1', binaryPropertyName: 'audio' });
    expect(response.error).toBeUndefined();
    const [item] = response.outputs[0];
    expect(item.json).toEqual({ sid: 'RE1', format: 'mp3' });
    expect(item.binary?.audio).toMatchObject({ mimeType: 'audio/mpeg', fileName: 'RE1.mp3', fileSize: MP3.length });
    expect(Buffer.from(item.binary!.audio.data!, 'base64').equals(MP3)).toBe(true);
  });

  it('asks for WAV, lists by call and maps a missing recording to the Twilio error', async () => {
    const wav = await call({ resource: 'recording', operation: 'download', recordingSid: 'RE1', recordingFormat: 'wav' });
    expect(wav.outputs[0][0].binary?.data).toMatchObject({ fileName: 'RE1.wav' });
    const list = await call({ resource: 'recording', operation: 'list', recordingCallSid: 'CA9', returnAll: true });
    expect(list.outputs[0].map((i) => i.json)).toEqual([{ sid: 'RE1', call_sid: 'CA9' }]);
    const missing = await call({ resource: 'recording', operation: 'download', recordingSid: 'REnone' });
    expect(missing.error?.message).toBe('Twilio API error 404 (code 20404): The requested resource was not found');
  });
});

describe('Twilio message media', () => {
  it('downloads each media file of a message as its own item, following the CDN redirect without credentials', async () => {
    const response = await call({ resource: 'message', operation: 'getMedia', messageSid: 'MM1' });
    expect(response.error).toBeUndefined();
    const items = response.outputs[0];
    expect(items.map((i) => i.json.sid)).toEqual(['ME1', 'ME2']);
    for (const item of items) {
      expect(item.binary?.data).toMatchObject({ mimeType: 'image/jpeg', fileSize: JPG.length });
      expect(Buffer.from(item.binary!.data.data!, 'base64').equals(JPG)).toBe(true);
    }
    expect(api.requests.filter((r) => r.path.startsWith('/cdn/'))).toHaveLength(2);
  });
});
