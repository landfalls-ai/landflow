/** Binary data helpers (docs/protocol.md §11): inline and stored files, the HTTP binary client, and both bindings. */
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HTTP_PATHS, MAX_INLINE_BINARY_BYTES, type BinaryRef, type ExecuteRequest, type ExecuteResponse } from '@landflow/protocol';
import { executeRequestToMsg, executeResponseFromMsg, grpc, loadLandflowProto, type ExecuteResponseMsg } from '@landflow/protocol/grpc';
import { createBinaryHelpers, defineNode, definePlugin, httpBinaryClient, runNode } from '../src';
import { serveGrpc } from '../src/grpc';
import { createFetchHandler } from '../src/http';

const GRPC_PORT = 47341;
const TOKEN = 'lfb1.test-token';

/** A stand-in for the host's /api/binary: GET <id>, POST stores, both need the bearer token. */
interface FakeStore {
  url: string;
  files: Map<string, { bytes: Buffer; mimeType: string; fileName?: string }>;
  close(): Promise<void>;
}

async function startFakeStore(): Promise<FakeStore> {
  const files = new Map<string, { bytes: Buffer; mimeType: string; fileName?: string }>();
  let next = 0;
  const server: Server = createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'bad token' }));
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const path = new URL(req.url ?? '/', 'http://x').pathname;
      if (req.method === 'POST' && path === '/api/binary') {
        const id = `ex_test.file${String(++next).padStart(6, '0')}`;
        const header = req.headers['x-landflow-file-name'];
        const fileName = typeof header === 'string' ? decodeURIComponent(header) : undefined;
        const bytes = Buffer.concat(chunks);
        const mimeType = String(req.headers['content-type']);
        files.set(id, { bytes, mimeType, fileName });
        res.writeHead(201, { 'content-type': 'application/json' }).end(JSON.stringify({ id, mimeType, fileName, fileSize: bytes.length }));
        return;
      }
      const file = files.get(decodeURIComponent(path.replace('/api/binary/', '')));
      if (req.method === 'GET' && file) {
        res.writeHead(200, { 'content-type': file.mimeType }).end(file.bytes);
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'not found' }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}/api/binary`, files, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

/** Reads `data`, uppercases it and writes it back, at the size the item asks for (big ones are uploaded). */
const upper = defineNode({
  description: { name: 'upper', displayName: 'Upper', description: '', version: 1, kind: 'action', inputs: [{ type: 'main' }], outputs: [{ type: 'main' }], properties: [] },
  async execute(ctx) {
    return Promise.all(
      ctx.getInputData().map(async (item, i) => {
        const text = (await ctx.helpers.getBinaryDataBuffer(i)).toString('utf8').toUpperCase().repeat(Number(item.json.repeat ?? 1));
        return { json: { length: text.length }, binary: { data: await ctx.helpers.prepareBinaryData(text, 'upper.txt') } };
      }),
    );
  },
});
const plugin = definePlugin({ info: { id: 'bin', name: 'Bin', version: '1' }, nodes: [upper] });

let store: FakeStore;
let server: grpc.Server;
let client: grpc.Client;

beforeAll(async () => {
  store = await startFakeStore();
  server = await serveGrpc(plugin, { port: GRPC_PORT, host: '127.0.0.1' });
  client = new (loadLandflowProto().PluginService)(`127.0.0.1:${GRPC_PORT}`, grpc.credentials.createInsecure());
});
afterAll(async () => {
  client.close();
  server.forceShutdown();
  await store.close();
});

const inline = (text: string, fileName = 'a.txt'): BinaryRef => ({ mimeType: 'text/plain', fileName, fileSize: text.length, data: Buffer.from(text).toString('base64') });

const request = (items: ExecuteRequest['inputs'][number], access = true): ExecuteRequest => ({
  protocol: 'landflow.plugin/v1', executionId: 'ex_test', mode: 'manual',
  node: { id: 'n1', name: 'Upper', type: 'bin.upper', typeVersion: 1 },
  parameters: {}, itemParameters: items.map(() => ({})), inputs: [items],
  ...(access && { binaryAccess: { url: store.url, token: TOKEN } }),
});

describe('binary helpers', () => {
  it('reads inline files and names the missing property', async () => {
    const helpers = createBinaryHelpers({ inputs: [[{ json: {}, binary: { data: inline('hello') } }, { json: {}, binary: { other: inline('x') } }]] }, undefined);
    expect((await helpers.getBinaryDataBuffer(0)).toString()).toBe('hello');
    expect(() => helpers.assertBinaryData(1)).toThrow('Item 1 has no binary file “data”');
    expect(() => helpers.assertBinaryData(1, 'data')).toThrow(expect.objectContaining({ description: 'Its files: other' }));
  });

  it('returns small files inline, with the MIME type from the file name', async () => {
    const helpers = createBinaryHelpers({ inputs: [] }, httpBinaryClient({ url: store.url, token: TOKEN }));
    const ref = await helpers.prepareBinaryData('a,b\n1,2\n', 'table.csv');
    expect(ref).toMatchObject({ mimeType: 'text/csv', fileName: 'table.csv', fileExtension: 'csv', fileSize: 8, fileType: 'text' });
    expect(Buffer.from(ref.data!, 'base64').toString()).toBe('a,b\n1,2\n');
    expect(ref.id).toBeUndefined();
  });

  it('uploads big files and streams, and reads them back by id', async () => {
    const helpers = createBinaryHelpers({ inputs: [] }, httpBinaryClient({ url: store.url, token: TOKEN }));
    const big = Buffer.alloc(MAX_INLINE_BINARY_BYTES + 1, 7);
    const ref = await helpers.prepareBinaryData(big, 'blob.bin');
    expect(ref.id).toMatch(/^ex_test\./);
    expect(store.files.get(ref.id!)).toMatchObject({ mimeType: 'application/octet-stream', fileName: 'blob.bin' });
    expect((await helpers.binaryToBuffer(ref)).equals(big)).toBe(true);

    const streamed = await helpers.prepareBinaryData(new Blob(['ünï']).stream(), 'ü n.txt');
    expect(store.files.get(streamed.id!)).toMatchObject({ fileName: 'ü n.txt', mimeType: 'text/plain' });
    const reader = createBinaryHelpers({ inputs: [[{ json: {}, binary: { data: streamed } }]] }, httpBinaryClient({ url: store.url, token: TOKEN }));
    const chunks: Uint8Array[] = [];
    for await (const chunk of (await reader.getBinaryStream(0)) as unknown as AsyncIterable<Uint8Array>) chunks.push(chunk);
    expect(Buffer.concat(chunks).toString()).toBe('ünï');
  });

  it('refuses big files without binary access, and reports a rejected token', async () => {
    const helpers = createBinaryHelpers({ inputs: [] }, undefined);
    await expect(helpers.prepareBinaryData(Buffer.alloc(MAX_INLINE_BINARY_BYTES + 1))).rejects.toThrow(/no binary access/);
    const bad = createBinaryHelpers({ inputs: [] }, httpBinaryClient({ url: store.url, token: 'nope' }));
    await expect(bad.prepareBinaryData(Buffer.alloc(MAX_INLINE_BINARY_BYTES + 1))).rejects.toThrow(/401 bad token/);
  });
});

describe('binary over the bindings', () => {
  const handle = createFetchHandler(plugin);
  const transports: Record<'in-process' | 'http' | 'grpc', (request: ExecuteRequest) => Promise<ExecuteResponse>> = {
    'in-process': (req) => runNode(upper, req),
    http: async (req) => (await handle(new Request(`http://plugin${HTTP_PATHS.execute}`, { method: 'POST', body: JSON.stringify(req) }))).json(),
    grpc: (req) =>
      new Promise((resolve, reject) =>
        (client as unknown as Record<string, Function>).Execute(executeRequestToMsg(req), { deadline: Date.now() + 3000 }, (error: Error | null, msg: ExecuteResponseMsg) =>
          error ? reject(error) : resolve(executeResponseFromMsg(msg)),
        ),
      ),
  };

  for (const [name, send] of Object.entries(transports)) {
    it(`carries item files and binaryAccess (${name})`, async () => {
      const response = await send(request([{ json: {}, binary: { data: inline('abc') } }, { json: { repeat: 30_000 }, binary: { data: inline('xyz') } }]));
      expect(response.error).toBeUndefined();
      const [small, big] = response.outputs[0]!;
      expect(Buffer.from(small!.binary!.data!.data!, 'base64').toString()).toBe('ABC');
      expect(big!.binary!.data).toMatchObject({ fileName: 'upper.txt', fileSize: 90_000 });
      expect(store.files.get(big!.binary!.data!.id!)!.bytes.toString()).toBe('XYZ'.repeat(30_000));
    });
  }
});
