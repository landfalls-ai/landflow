/**
 * Binary data over HTTP, through the route handlers: the binary API plugins use (tokens, scopes, limits), webhook
 * uploads (multipart, raw bodies, "Raw Body"), Respond to Webhook sending a file, hosted form File fields (the
 * trigger's form and a Form page), and the files going with their execution.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { BinaryRef } from '@landflow/protocol';
import type { Workflow } from '@landflow/engine';
import type { ExecutionRecord } from '@/lib/shared/types';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-binary-routes-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_PUBLIC_URL: 'http://binary.test' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { store } = await import('@/lib/server/store');
const { waits } = await import('@/lib/server/waits');
const { binaryStore, signBinaryToken } = await import('@/lib/server/binary/access');
const { readAll } = await import('@/lib/server/binary/store');
const uploadRoute = await import('@/app/api/binary/route');
const fileRoute = await import('@/app/api/binary/[id]/route');
const webhookRoute = await import('@/app/api/webhook/[...path]/route');
const formRoute = await import('@/app/form/[...path]/route');
const formWaitingRoute = await import('@/app/form/waiting/[id]/route');

registry.registerBuiltin(corePlugin);

afterAll(() => {
  waits.stop();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

interface N {
  name: string;
  type: string;
  parameters?: Record<string, unknown>;
}

function save(id: string, nodes: N[], edges: Array<[string, string]>, extra: Partial<Workflow> = { active: true }): Workflow {
  return store.saveWorkflow({
    id,
    name: id,
    nodes: nodes.map((n, i) => ({ id: n.name, name: n.name, type: n.type, typeVersion: 1, position: [i * 200, 0], parameters: n.parameters ?? {} })),
    connections: edges.map(([source, target], i) => ({ id: `e${i}`, type: 'main', source, target, sourceIndex: 0, targetIndex: 0 })),
    ...extra,
  } as Workflow);
}

const request = (url: string, init: RequestInit = {}) => new Request(`http://binary.test${url}`, init);
const params = <T>(value: T) => ({ params: Promise.resolve(value) });
const stored = (id: string) => store.getExecution(id);
const executionsOf = (workflowId: string) => store.listExecutions({ workflowId, limit: 100 });
const binaryOf = (record: ExecutionRecord | undefined, node: string) => record?.runData[node]?.at(-1)?.outputs[0]?.map((item) => item.binary);
const read = async (id: string) => (await readAll((await (await binaryStore()).open(id))!.stream)).toString('utf8');
const later = () => Math.floor(Date.now() / 1000) + 600;
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

describe('The binary API', () => {
  it('stores a plugin’s upload in its token’s scope', async () => {
    const token = signBinaryToken({ w: 'ex_api', r: [], x: later() });
    expect((await uploadRoute.POST(request('/api/binary', { method: 'POST', body: 'x' }))).status).toBe(401);
    expect((await uploadRoute.POST(request('/api/binary', { method: 'POST', body: 'x', headers: bearer('lfb1.bad.token') }))).status).toBe(401);

    const created = await uploadRoute.POST(
      request('/api/binary', { method: 'POST', body: 'id,name\n1,Ada\n', headers: { ...bearer(token), 'content-type': 'text/csv', 'x-landflow-file-name': encodeURIComponent('liste é.csv') } }),
    );
    expect(created.status).toBe(201);
    const ref = (await created.json()) as BinaryRef;
    expect(ref).toMatchObject({ id: expect.stringMatching(/^ex_api\./), mimeType: 'text/csv', fileName: 'liste é.csv', fileExtension: 'csv', fileSize: 14, fileType: 'text' });
    expect(await read(ref.id!)).toBe('id,name\n1,Ada\n');

    const named = await uploadRoute.POST(request('/api/binary?fileName=..%2F..%2Fphoto.png', { method: 'POST', body: new Uint8Array([1, 2, 3]), headers: bearer(token) }));
    expect(await named.json()).toMatchObject({ fileName: 'photo.png', mimeType: 'image/png', fileSize: 3 });
  });

  it('refuses uploads past LANDFLOW_BINARY_MAX_BYTES with 413', async () => {
    process.env.LANDFLOW_BINARY_MAX_BYTES = '10';
    try {
      const token = signBinaryToken({ w: 'ex_api_big', r: [], x: later() });
      const declared = await uploadRoute.POST(request('/api/binary', { method: 'POST', body: 'x'.repeat(20), headers: { ...bearer(token), 'content-length': '20' } }));
      expect(declared.status).toBe(413);
      const streamed = await uploadRoute.POST(
        request('/api/binary', { method: 'POST', body: new Blob(['x'.repeat(20)]).stream(), headers: bearer(token), duplex: 'half' } as RequestInit),
      );
      expect(streamed.status).toBe(413);
      expect(await (await binaryStore()).deleteScope('ex_api_big')).toBe(0);
    } finally {
      delete process.env.LANDFLOW_BINARY_MAX_BYTES;
    }
  });

  it('serves files to tokens that may read them, and to the editor', async () => {
    const ref = await (await binaryStore()).put('ex_serve', new TextEncoder().encode('<h1>hi</h1>'), { mimeType: 'text/html', fileName: 'page.html' });
    const get = (headers: Record<string, string> = {}, query = '') => fileRoute.GET(request(`/api/binary/${ref.id}${query}`, { headers }), params({ id: ref.id! }));

    const own = await get(bearer(signBinaryToken({ w: 'ex_serve', r: [], x: later() })));
    expect(own.status).toBe(200);
    expect(await own.text()).toBe('<h1>hi</h1>');
    expect(own.headers.get('content-type')).toBe('text/html');
    expect(own.headers.get('content-length')).toBe('11');
    expect(own.headers.get('content-disposition')).toBe(`inline; filename="page.html"; filename*=UTF-8''page.html`);
    expect(own.headers.get('x-content-type-options')).toBe('nosniff');
    // HTML could run script on the host's origin: sandboxed.
    expect(own.headers.get('content-security-policy')).toContain('sandbox');

    expect((await get(bearer(signBinaryToken({ w: 'ex_other', r: ['ex_serve'], x: later() })))).status).toBe(200);
    expect((await get(bearer(signBinaryToken({ w: 'ex_other', r: [], x: later() })))).status).toBe(403);
    expect((await get(bearer('lfb1.x.y'))).status).toBe(401);
    expect((await get()).status).toBe(200);
    expect((await get({}, '?download=1')).headers.get('content-disposition')).toMatch(/^attachment;/);
    const missing = await fileRoute.GET(request('/api/binary/ex_serve.doesnotexist'), params({ id: 'ex_serve.doesnotexist' }));
    expect(missing.status).toBe(404);

    const head = await fileRoute.HEAD(request(`/api/binary/${ref.id}`, { method: 'HEAD' }), params({ id: ref.id! }));
    expect([head.status, head.headers.get('content-length'), await head.text()]).toEqual([200, '11', '']);
  });
});

describe('Webhook uploads', () => {
  const hook = (path: string, options: Record<string, unknown> = {}): N => ({ name: 'Hook', type: 'core.webhook', parameters: { path, method: 'POST', respond: 'lastNode', options } });
  const call = (path: string, init: RequestInit) => webhookRoute.POST(request(`/api/webhook/${path}`, { method: 'POST', ...init }), params({ path: path.split('/') }));

  it('stores multipart files as item.binary and keeps the text fields in body', async () => {
    const workflow = save('wf_upload', [hook('bin-upload'), { name: 'After', type: 'core.noOp' }], [['Hook', 'After']]);
    const form = new FormData();
    form.append('title', 'Report');
    form.append('files[]', new File(['a,b\n1,2\n'], 'one.csv', { type: 'text/csv' }));
    form.append('files[]', new File(['%PDF-1.4'], 'two.pdf', { type: 'application/pdf' }));
    form.append('avatar', new File([new Uint8Array([0x89, 0x50])], 'me.png', { type: '' }));
    const response = await call('bin-upload', { body: form });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ body: { title: 'Report' } });

    const record = stored(executionsOf(workflow.id)[0].id)!;
    const [binary] = binaryOf(record, 'After')!;
    expect(Object.keys(binary!)).toEqual(['files0', 'files1', 'avatar']);
    expect(binary!.files0).toMatchObject({ fileName: 'one.csv', mimeType: 'text/csv', fileSize: 8 });
    expect(binary!.files1).toMatchObject({ fileName: 'two.pdf', mimeType: 'application/pdf', fileType: 'pdf' });
    // No type from the browser: guessed from the name.
    expect(binary!.avatar).toMatchObject({ fileName: 'me.png', mimeType: 'image/png', fileType: 'image', fileSize: 2 });
    expect(binary!.files0.id).toMatch(new RegExp(`^${record.executionId}\\.`));
    expect(await read(binary!.files0.id!)).toBe('a,b\n1,2\n');

    // The files go with the execution.
    store.deleteExecution(record.executionId);
    await vi.waitFor(async () => expect(await (await binaryStore()).head(binary!.files0.id!)).toBeUndefined());
  });

  it('stores a non-text body as one file, and any body with “Raw Body”', async () => {
    const pdf = save('wf_raw_pdf', [hook('bin-raw'), { name: 'After', type: 'core.noOp' }], [['Hook', 'After']]);
    await call('bin-raw', { body: '%PDF-1.7 bytes', headers: { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="in.pdf"' } });
    const [file] = binaryOf(stored(executionsOf(pdf.id)[0].id), 'After')!;
    expect(file!.data).toMatchObject({ mimeType: 'application/pdf', fileName: 'in.pdf', fileSize: 14 });

    const raw = save('wf_raw_json', [hook('bin-raw-json', { rawBody: true, binaryPropertyName: 'payload' }), { name: 'After', type: 'core.noOp' }], [['Hook', 'After']]);
    const response = await call('bin-raw-json', { body: '{"a":1}', headers: { 'content-type': 'application/json' } });
    expect(await response.json()).toMatchObject({ body: {} });
    const [json] = binaryOf(stored(executionsOf(raw.id)[0].id), 'After')!;
    expect(json!.payload).toMatchObject({ mimeType: 'application/json', fileSize: 7 });
    expect(await read(json!.payload.id!)).toBe('{"a":1}');

    // JSON stays JSON without the option.
    save('wf_plain_json', [hook('bin-plain'), { name: 'After', type: 'core.noOp' }], [['Hook', 'After']]);
    expect(await (await call('bin-plain', { body: '{"a":1}', headers: { 'content-type': 'application/json' } })).json()).toMatchObject({ body: { a: 1 } });
  });

  it('answers 413 past LANDFLOW_BINARY_MAX_BYTES and starts no run', async () => {
    const workflow = save('wf_upload_big', [hook('bin-big'), { name: 'After', type: 'core.noOp' }], [['Hook', 'After']]);
    process.env.LANDFLOW_BINARY_MAX_BYTES = '16';
    try {
      const response = await call('bin-big', { body: new Blob(['x'.repeat(64)]).stream(), headers: { 'content-type': 'application/octet-stream' }, duplex: 'half' } as RequestInit);
      expect(response.status).toBe(413);
    } finally {
      delete process.env.LANDFLOW_BINARY_MAX_BYTES;
    }
    expect(executionsOf(workflow.id)).toHaveLength(0);
  });

  it('extracts an uploaded CSV and answers with a file from Respond to Webhook', async () => {
    save(
      'wf_csv_roundtrip',
      [
        { name: 'Hook', type: 'core.webhook', parameters: { path: 'bin-roundtrip', method: 'POST', respond: 'responseNode' } },
        { name: 'Extract', type: 'core.extractFromFile', parameters: { operation: 'csv', binaryPropertyName: 'sheet' } },
        { name: 'Convert', type: 'core.convertToFile', parameters: { operation: 'toJson', options: { fileName: 'rows.json' } } },
        { name: 'Respond', type: 'core.respondToWebhook', parameters: { respondWith: 'binary', binaryPropertyName: 'data' } },
      ],
      [
        ['Hook', 'Extract'],
        ['Extract', 'Convert'],
        ['Convert', 'Respond'],
      ],
    );
    const form = new FormData();
    form.append('sheet', new File(['name,age\nAda,36\nAlan,41\n'], 'people.csv', { type: 'text/csv' }));
    const response = await call('bin-roundtrip', { body: form });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(response.headers.get('content-disposition')).toContain('filename="rows.json"');
    expect(await response.json()).toEqual([
      { name: 'Ada', age: '36' },
      { name: 'Alan', age: '41' },
    ]);
  });
});

describe('Form file fields', () => {
  const fields = {
    values: [
      { fieldLabel: 'Name', fieldType: 'text', requiredField: true },
      { fieldLabel: 'CV', fieldName: 'cv', fieldType: 'file', requiredField: true, acceptFileTypes: '.pdf,.txt' },
      { fieldLabel: 'Photos', fieldName: 'photos', fieldType: 'file', multipleFiles: true },
    ],
  };

  it('serve a multipart form and store the uploads with the run', async () => {
    const workflow = save(
      'wf_form_files',
      [{ name: 'Form', type: 'core.formTrigger', parameters: { path: 'bin-form', formTitle: 'Apply', formFields: fields } }, { name: 'After', type: 'core.noOp' }],
      [['Form', 'After']],
    );
    const html = await (await formRoute.GET(request('/form/bin-form'), params({ path: ['bin-form'] }))).text();
    expect(html).toContain('enctype="multipart/form-data"');
    expect(html).toMatch(/<input id="f1" name="f1" type="file" accept="\.pdf,\.txt" required/);
    expect(html).toMatch(/<input id="f2" name="f2" type="file" multiple>/);

    const missing = new FormData();
    missing.append('f0', 'Ada');
    missing.append('f1', new File([], '', { type: 'application/octet-stream' }));
    const invalid = await formRoute.POST(request('/form/bin-form', { method: 'POST', body: missing }), params({ path: ['bin-form'] }));
    expect(invalid.status).toBe(400);
    expect(await invalid.text()).toContain('Choose a file');

    const body = new FormData();
    body.append('f0', 'Ada');
    body.append('f1', new File(['my cv'], 'cv.txt', { type: 'text/plain' }));
    body.append('f2', new File([new Uint8Array([1])], 'a.jpg', { type: 'image/jpeg' }));
    body.append('f2', new File([new Uint8Array([2, 2])], 'b.jpg', { type: 'image/jpeg' }));
    const done = await formRoute.POST(request('/form/bin-form', { method: 'POST', body }), params({ path: ['bin-form'] }));
    expect(done.status).toBe(200);
    await vi.waitFor(() => expect(executionsOf(workflow.id)[0]?.status).toBe('success'));
    const record = stored(executionsOf(workflow.id)[0].id)!;
    const item = record.runData.After.at(-1)!.outputs[0][0];
    expect(item.json).toMatchObject({ Name: 'Ada', cv: 'cv.txt', photos: ['a.jpg', 'b.jpg'], formMode: 'production' });
    expect(Object.keys(item.binary!)).toEqual(['cv', 'photos0', 'photos1']);
    expect(item.binary!.photos1).toMatchObject({ fileName: 'b.jpg', mimeType: 'image/jpeg', fileSize: 2 });
    expect(await read(item.binary!.cv.id!)).toBe('my cv');
    expect(item.binary!.cv.id).toMatch(new RegExp(`^${record.executionId}\\.`));
  });

  it('work on Form pages of a waiting run', async () => {
    save(
      'wf_form_page_files',
      [
        { name: 'Form', type: 'core.formTrigger', parameters: { path: 'bin-pages', formTitle: 'Start', responseMode: 'lastNode', formFields: { values: [{ fieldLabel: 'Name', fieldType: 'text' }] } } },
        { name: 'Upload', type: 'core.form', parameters: { operation: 'page', formTitle: 'Upload', formFields: { values: [{ fieldLabel: 'Doc', fieldName: 'doc', fieldType: 'file', requiredField: true }] } } },
        { name: 'After', type: 'core.noOp' },
      ],
      [
        ['Form', 'Upload'],
        ['Upload', 'After'],
      ],
    );
    const first = await formRoute.POST(request('/form/bin-pages', { method: 'POST', body: new URLSearchParams({ f0: 'Ada' }) }), params({ path: ['bin-pages'] }));
    const id = first.headers.get('location')!.split('/').at(-1)!;
    expect(await (await formWaitingRoute.GET(request(`/form/waiting/${id}`), params({ id }))).text()).toContain('enctype="multipart/form-data"');
    const body = new FormData();
    body.append('f0', new File(['page file'], 'doc.md', { type: '' }));
    const end = await formWaitingRoute.POST(request(`/form/waiting/${id}`, { method: 'POST', body }), params({ id }));
    expect(end.status).toBe(200);
    await vi.waitFor(() => expect(stored(id)?.status).toBe('success'));
    const item = stored(id)!.runData.After.at(-1)!.outputs[0][0];
    expect(item.json).toMatchObject({ doc: 'doc.md' });
    expect(item.binary!.doc).toMatchObject({ fileName: 'doc.md', mimeType: 'text/markdown', fileSize: 9 });
    expect(item.binary!.doc.id).toMatch(new RegExp(`^${id}\\.`));
  });
});
