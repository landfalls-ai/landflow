/** Slack files: uploading item files (getUploadURLExternal → upload URL → completeUploadExternal) and Get downloading into item.binary. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runNode, type JsonObject } from '@landflow/sdk';
import type { BinaryRef } from '@landflow/protocol';
import { Slack } from '../src/nodes/slack';
import { plugin } from '../src/main';
import { executeRequest, startFakeApi, type FakeApi, type FakeRequest } from './helpers';

const TOKEN = 'xoxb-test-token-123';
const PDF = Buffer.from('%PDF-1.4 a small report');

let api: FakeApi;
const credentials = () => ({ slackApi: { accessToken: TOKEN, baseUrl: api.url, signingSecret: '' } });

/** The Web API methods of the upload flow, the upload URL, files.info and a private download URL. */
function handle(req: FakeRequest) {
  if (req.path === '/upload/F123') return { body: 'OK - 23', headers: { 'content-type': 'text/plain' } };
  if (req.path === '/download/F7/report.pdf') {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return { body: '<html>Sign in to Slack</html>', headers: { 'content-type': 'text/html' } };
    return { body: PDF.toString('latin1'), headers: { 'content-type': 'application/octet-stream' } };
  }
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return { body: { ok: false, error: 'invalid_auth' } };
  switch (req.path.slice(1)) {
    case 'files.getUploadURLExternal':
      return { body: { ok: true, upload_url: `${api.url}/upload/F123`, file_id: 'F123' } };
    case 'files.completeUploadExternal': {
      const body = req.body as { files: Array<{ id: string; title: string }>; channel_id?: string };
      if (body.channel_id === 'C404') return { body: { ok: false, error: 'channel_not_found' } };
      return { body: { ok: true, files: body.files.map((f) => ({ id: f.id, title: f.title, name: 'report.pdf' })) } };
    }
    case 'files.info': {
      const id = req.query.get('file');
      if (id === 'Fext') return { body: { ok: true, file: { id, name: 'doc', mimetype: 'application/vnd.google-apps.document', is_external: true } } };
      return { body: { ok: true, file: { id, name: 'report.pdf', mimetype: 'application/pdf', size: PDF.length, url_private_download: `${api.url}/download/F7/report.pdf` } } };
    }
    default:
      return { body: { ok: false, error: 'unknown_method' } };
  }
}

const inline = (bytes: Buffer, fileName: string, mimeType: string): BinaryRef => ({ mimeType, fileName, fileSize: bytes.length, data: bytes.toString('base64') });

function run(parameters: JsonObject, items: Array<{ json: JsonObject; binary?: Record<string, BinaryRef> }> = [{ json: {} }]) {
  const request = executeRequest('slack', parameters, { credentials: credentials() });
  request.inputs = [items.map((item) => ({ json: item.json, ...(item.binary && { binary: item.binary }) }))];
  return runNode(Slack, request, { credentialTypes: plugin.credentialTypes, pluginId: 'messaging' });
}

beforeAll(async () => {
  api = await startFakeApi(handle);
});
afterAll(() => api.close());
beforeEach(() => {
  api.handle(handle);
  api.requests.length = 0;
});

describe('Slack file upload', () => {
  it('gets an upload URL, sends the bytes there and shares the file in a thread', async () => {
    const response = await run(
      { resource: 'file', operation: 'upload', channelId: 'C001', binaryPropertyName: 'report', fileOptions: { title: 'Q3', initial_comment: 'Numbers attached', thread_ts: '1700000000.000100' } },
      [{ json: {}, binary: { report: inline(PDF, 'report.pdf', 'application/pdf') } }],
    );
    expect(response.error).toBeUndefined();
    expect(api.requests.map((r) => `${r.method} ${r.path}`)).toEqual(['GET /files.getUploadURLExternal', 'POST /upload/F123', 'POST /files.completeUploadExternal']);
    const [target, upload, complete] = api.requests;
    expect(Object.fromEntries(target.query)).toEqual({ filename: 'report.pdf', length: String(PDF.length) });
    expect(upload.headers.authorization).toBeUndefined();
    expect(upload.headers['content-type']).toBe('application/pdf');
    expect(upload.raw.equals(PDF)).toBe(true);
    expect(complete.body).toEqual({ files: [{ id: 'F123', title: 'Q3' }], channel_id: 'C001', initial_comment: 'Numbers attached', thread_ts: '1700000000.000100' });
    expect(response.outputs[0][0].json).toEqual({ id: 'F123', title: 'Q3', name: 'report.pdf' });
  });

  it('names the missing item file and explains Slack errors', async () => {
    const missing = await run({ resource: 'file', operation: 'upload', channelId: 'C001', binaryPropertyName: 'data' }, [{ json: {}, binary: { other: inline(PDF, 'a.pdf', 'application/pdf') } }]);
    expect(missing.error).toMatchObject({ message: 'Item 0 has no binary file “data”', description: 'Its files: other' });
    const notFound = await run({ resource: 'file', operation: 'upload', channelId: 'C404', binaryPropertyName: 'data' }, [{ json: {}, binary: { data: inline(PDF, 'a.pdf', 'application/pdf') } }]);
    expect(notFound.error?.message).toMatch(/channel_not_found/);
    expect(notFound.error?.description).toMatch(/invite the bot/);
  });
});

describe('Slack Get File', () => {
  it('downloads the file into item.binary with the token', async () => {
    const response = await run({ resource: 'file', operation: 'get', fileId: 'F7', binaryPropertyName: 'doc' });
    expect(response.error).toBeUndefined();
    expect(api.requests.map((r) => r.path)).toEqual(['/files.info', '/download/F7/report.pdf']);
    const [item] = response.outputs[0];
    expect(item.json).toMatchObject({ id: 'F7', name: 'report.pdf' });
    expect(item.binary?.doc).toMatchObject({ fileName: 'report.pdf', mimeType: 'application/pdf', fileSize: PDF.length });
    expect(Buffer.from(item.binary!.doc.data!, 'base64').equals(PDF)).toBe(true);
  });

  it('returns only the details without Download, and explains files with no Slack copy', async () => {
    const details = await run({ resource: 'file', operation: 'get', fileId: 'F7', download: false });
    expect(details.outputs[0][0].binary).toBeUndefined();
    expect(api.requests).toHaveLength(1);
    const external = await run({ resource: 'file', operation: 'get', fileId: 'Fext' });
    expect(external.error?.message).toBe('Slack gave no download URL for this file');
  });

  it('reports Slack’s sign-in page instead of saving it as the file', async () => {
    api.handle((req) => (req.path === '/files.info' ? handle(req) : { body: '<html>Sign in to Slack</html>', headers: { 'content-type': 'text/html' } }));
    const response = await run({ resource: 'file', operation: 'get', fileId: 'F7' });
    expect(response.error?.message).toBe('Slack API error 200: the file download returned a sign-in page');
    expect(response.error?.description).toMatch(/files:read/);
  });
});
