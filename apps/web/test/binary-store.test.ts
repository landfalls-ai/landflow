/**
 * Binary data storage: the filesystem store and the S3 store (one contract for both; S3 runs against MinIO with
 * LANDFLOW_INTEGRATION=s3), the tokens plugins get, inline files a node returns, and deletion with the execution
 * (the store.deleteExecution hook and the orphan sweep).
 *
 *   LANDFLOW_INTEGRATION=s3 npx vitest run test/binary-store.test.ts
 *
 * uses http://127.0.0.1:59000 (bucket `landflow`, key `landflow` / `landflow-dev-only`) unless LANDFLOW_S3_* say otherwise.
 */
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, describe, expect, it } from 'vitest';
import type { BinaryRef, NodeItem } from '@landflow/protocol';
import type { ResolvedNodeType } from '@landflow/engine';
import { FilesystemBinaryStore, BinaryTooLargeError, readAll, type BinaryStore } from '@/lib/server/binary/store';
import {
  binaryAccessFor,
  deleteExecutionBinary,
  hostBinaryClient,
  setBinaryStore,
  shareBinaryScope,
  signBinaryToken,
  startBinaryMaintenance,
  storeInlineBinary,
  sweepBinaryData,
  tokenCanRead,
  verifyBinaryToken,
  withBinaryData,
} from '@/lib/server/binary/access';
import { onExecutionDeleted, store } from '@/lib/server/store';

const root = mkdtempSync(join(tmpdir(), 'landflow-binary-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const bytes = (text: string) => new TextEncoder().encode(text);
const text = async (binary: BinaryStore, id: string) => (await readAll((await binary.open(id))!.stream)).toString('utf8');

/** The behaviour every store has. */
function contract(name: string, make: () => BinaryStore, scopeOf: (label: string) => string = (label) => label) {
  describe(name, () => {
    const binary = make();

    it('stores buffers and streams, with metadata, under their scope', async () => {
      const scope = scopeOf('ex_store');
      const ref = await binary.put(scope, bytes('hello'), { mimeType: 'text/plain', fileName: 'hello.txt' });
      expect(ref).toMatchObject({ mimeType: 'text/plain', fileName: 'hello.txt', fileExtension: 'txt', fileSize: 5, fileType: 'text' });
      expect(ref.id).toMatch(new RegExp(`^${scope}\\.`));
      expect(ref.data).toBeUndefined();
      expect(await text(binary, ref.id!)).toBe('hello');
      expect(await binary.head(ref.id!)).toMatchObject({ mimeType: 'text/plain', fileName: 'hello.txt', fileSize: 5 });

      const web = await binary.put(scope, new Blob(['web ', 'stream']).stream(), { fileName: 'w.json' });
      expect(web).toMatchObject({ fileSize: 10, mimeType: 'application/json' });
      const node = await binary.put(scope, Readable.from([Buffer.from('a'), Buffer.from('b')]), {});
      expect(node).toMatchObject({ fileSize: 2, mimeType: 'application/octet-stream' });
      async function* chunks() {
        yield bytes('x');
        yield bytes('yz');
      }
      expect(await text(binary, (await binary.put(scope, chunks(), {})).id!)).toBe('xyz');
      expect((await binary.scopes()).map((s) => s.scope)).toContain(scope);
    });

    it('refuses files past maxBytes and keeps nothing of them', async () => {
      const scope = scopeOf('ex_big');
      await expect(binary.put(scope, Readable.from([Buffer.alloc(600), Buffer.alloc(600)]), {}, { maxBytes: 1000 })).rejects.toBeInstanceOf(BinaryTooLargeError);
      await expect(binary.put(scope, Buffer.alloc(1001), {}, { maxBytes: 1000 })).rejects.toBeInstanceOf(BinaryTooLargeError);
      expect(await binary.deleteScope(scope)).toBe(0);
    });

    it('answers undefined for unknown and malformed ids', async () => {
      expect(await binary.head(`${scopeOf('ex_none')}.abcdefghijkl`)).toBeUndefined();
      expect(await binary.open(`${scopeOf('ex_none')}.abcdefghijkl`)).toBeUndefined();
      for (const bad of ['../etc.passwd00', 'ex_a/../b.cdefghijkl', 'nodot', '']) expect(await binary.head(bad)).toBeUndefined();
      await expect(binary.put('../escape', bytes('x'), {})).rejects.toThrow();
    });

    it('deletes a whole scope', async () => {
      const scope = scopeOf('ex_gone');
      const a = await binary.put(scope, bytes('1'), {});
      const b = await binary.put(scope, bytes('2'), {});
      const other = await binary.put(scopeOf('ex_kept'), bytes('3'), {});
      expect(await binary.deleteScope(scope)).toBe(2);
      expect(await binary.head(a.id!)).toBeUndefined();
      expect(await binary.head(b.id!)).toBeUndefined();
      expect(await text(binary, other.id!)).toBe('3');
      await binary.deleteScope(scopeOf('ex_kept'));
      await binary.deleteScope(scopeOf('ex_store'));
    });
  });
}

contract('Filesystem binary store', () => new FilesystemBinaryStore(join(root, 'fs')));

const s3 = process.env.LANDFLOW_INTEGRATION?.split(',').includes('s3');
describe.skipIf(!s3)('S3 binary store (MinIO)', async () => {
  const { S3BinaryStore } = await import('@/lib/server/binary/s3');
  const options = {
    bucket: process.env.LANDFLOW_S3_BUCKET ?? 'landflow',
    endpoint: process.env.LANDFLOW_S3_ENDPOINT ?? 'http://127.0.0.1:59000',
    accessKeyId: process.env.LANDFLOW_S3_ACCESS_KEY_ID ?? 'landflow',
    secretAccessKey: process.env.LANDFLOW_S3_SECRET_ACCESS_KEY ?? 'landflow-dev-only',
    prefix: `landflow-test-${process.pid}/`,
  };
  const make = () => new S3BinaryStore(options);
  // A unique scope per run: the bucket may be shared.
  const run = Math.random().toString(36).slice(2, 8);
  contract('contract', make, (label) => `${label}_${run}`);

  it('spools files bigger than its memory buffer to disk and streams them back', async () => {
    const binary = make();
    const scope = `ex_large_${run}`;
    const size = 9 * 1024 * 1024;
    const chunk = Buffer.alloc(1024 * 1024, 7);
    const ref = await binary.put(scope, Readable.from(Array.from({ length: 9 }, () => chunk)), { fileName: 'big.bin' }, { maxBytes: 10 * 1024 * 1024 });
    expect(ref.fileSize).toBe(size);
    const back = await readAll((await binary.open(ref.id!))!.stream);
    expect(back.length).toBe(size);
    expect(back[size - 1]).toBe(7);
    expect(await binary.deleteScope(scope)).toBe(1);
    binary.destroy();
  });
});

describe('Binary tokens', () => {
  const later = Math.floor(Date.now() / 1000) + 60;

  it('verify their signature and expiry', () => {
    const token = signBinaryToken({ w: 'ex_a', r: ['ex_b'], x: later });
    expect(verifyBinaryToken(token)).toEqual({ w: 'ex_a', r: ['ex_b'], x: later });
    const [v, payload, signature] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ w: 'ex_other', r: [], x: later })).toString('base64url');
    expect(verifyBinaryToken(`${v}.${forged}.${signature}`)).toBeUndefined();
    expect(verifyBinaryToken(`${v}.${payload}.${signature.slice(0, -2)}xx`)).toBeUndefined();
    expect(verifyBinaryToken(signBinaryToken({ w: 'ex_a', r: [], x: Math.floor(Date.now() / 1000) - 1 }))).toBeUndefined();
    expect(verifyBinaryToken(undefined)).toBeUndefined();
    expect(verifyBinaryToken('Bearer nonsense')).toBeUndefined();
  });

  it('read their own scope and the scopes of the call’s input files', () => {
    const claims = { w: 'ex_a', r: ['ex_b'], x: later };
    expect(tokenCanRead(claims, 'ex_a.abcdefghij')).toBe(true);
    expect(tokenCanRead(claims, 'ex_b.abcdefghij')).toBe(true);
    expect(tokenCanRead(claims, 'ex_c.abcdefghij')).toBe(false);
    const inputs: NodeItem[][] = [[{ json: {}, binary: { a: { id: 'ex_b.abcdefghij', mimeType: 'text/plain', fileSize: 1 }, b: { id: 'ex_a.zzzzzzzzzz', mimeType: 'text/plain', fileSize: 1 } } }]];
    const access = binaryAccessFor('ex_a', inputs);
    expect(access.url).toMatch(/\/api\/binary$/);
    expect(verifyBinaryToken(access.token)).toMatchObject({ w: 'ex_a', r: ['ex_b'] });
  });

  it('write into the parent’s scope while a sub-workflow shares it', () => {
    shareBinaryScope('ex_child', 'ex_parent');
    expect(verifyBinaryToken(binaryAccessFor('ex_child', []).token)?.w).toBe('ex_parent');
    shareBinaryScope('ex_child', undefined);
    expect(verifyBinaryToken(binaryAccessFor('ex_child', []).token)?.w).toBe('ex_child');
  });
});

describe('Files nodes return', () => {
  const binary = new FilesystemBinaryStore(join(root, 'nodes'));
  setBinaryStore(binary);

  it('inline data is stored, stored refs are completed and junk is dropped', async () => {
    const outputs: NodeItem[][] = [
      [
        {
          json: {},
          binary: {
            inline: { mimeType: 'text/csv', fileName: 'a.csv', fileSize: 3, data: Buffer.from('a,b').toString('base64') },
            stored: { id: 'ex_inline.abcdefghijkl', mimeType: 'application/pdf', fileSize: 10 } as BinaryRef,
            bad: { id: '../x', mimeType: 'text/plain', fileSize: 1 } as BinaryRef,
            junk: 'nope' as unknown as BinaryRef,
          },
        },
        { json: {}, binary: 'oops' as never },
      ],
    ];
    await storeInlineBinary(outputs, 'ex_inline');
    const [first, second] = outputs[0];
    expect(first.binary?.inline).toMatchObject({ mimeType: 'text/csv', fileName: 'a.csv', fileSize: 3, fileType: 'text' });
    expect(first.binary?.inline.id).toMatch(/^ex_inline\./);
    expect(first.binary?.inline.data).toBeUndefined();
    expect(await text(binary, first.binary!.inline.id!)).toBe('a,b');
    expect(first.binary?.stored).toMatchObject({ fileType: 'pdf', fileExtension: 'pdf' });
    expect(Object.keys(first.binary!)).toEqual(['inline', 'stored']);
    expect(second.binary).toBeUndefined();
  });

  it('inline data past LANDFLOW_BINARY_MAX_INLINE_BYTES fails the node', async () => {
    process.env.LANDFLOW_BINARY_MAX_INLINE_BYTES = '10';
    try {
      const outputs: NodeItem[][] = [[{ json: {}, binary: { data: { mimeType: 'text/plain', fileSize: 30, data: Buffer.alloc(30).toString('base64') } } }]];
      await expect(storeInlineBinary(outputs, 'ex_inline')).rejects.toThrow(/larger than 10 bytes/);
    } finally {
      delete process.env.LANDFLOW_BINARY_MAX_INLINE_BYTES;
    }
  });

  it('in-process nodes get a direct client; remote ones a token', async () => {
    const seen: unknown[] = [];
    const resolved = (transport: ResolvedNodeType['transport']): ResolvedNodeType =>
      ({
        transport,
        description: {} as never,
        execute: async (request: { binaryAccess?: unknown }, extras?: { binary?: unknown }) => {
          seen.push({ access: request.binaryAccess, client: extras?.binary });
          return { outputs: [[{ json: {}, binary: { data: { mimeType: 'text/plain', fileSize: 2, data: Buffer.from('hi').toString('base64') } } }]] };
        },
      }) as unknown as ResolvedNodeType;
    const request = { executionId: 'ex_wrap', inputs: [[]] } as never;
    const local = await withBinaryData(resolved('in-process')).execute(request, {});
    const remote = await withBinaryData(resolved('grpc')).execute(request, {});
    expect(seen[0]).toMatchObject({ access: undefined, client: expect.objectContaining({ read: expect.any(Function), write: expect.any(Function) }) });
    expect(seen[1]).toMatchObject({ access: { url: expect.stringMatching(/\/api\/binary$/), token: expect.stringMatching(/^lfb1\./) }, client: undefined });
    for (const response of [local, remote]) expect(response.outputs[0][0].binary?.data.id).toMatch(/^ex_wrap\./);
  });

  it('the host client reads any file and writes into the execution’s scope', async () => {
    const client = hostBinaryClient('ex_client');
    const ref = await client.write(bytes('written'), { fileName: 'w.txt' });
    expect(ref.id).toMatch(/^ex_client\./);
    expect(Buffer.from(await client.read(ref)).toString()).toBe('written');
    await expect(client.read({ id: 'ex_client.missingfile', mimeType: 'text/plain', fileSize: 1 })).rejects.toThrow(/no longer stored/);
  });
});

describe('Deleting an execution', () => {
  const binary = new FilesystemBinaryStore(join(root, 'deletion'));

  it('deletes its files through the store hook', async () => {
    setBinaryStore(binary);
    startBinaryMaintenance();
    const deleted: string[] = [];
    const stop = onExecutionDeleted((id) => deleted.push(id));
    const ref = await binary.put('ex_deleted', bytes('bye'), {});
    store.deleteExecution('ex_deleted');
    stop();
    expect(deleted).toEqual(['ex_deleted']);
    await expect.poll(async () => binary.head(ref.id!)).toBeUndefined();
    expect(existsSync(join(root, 'deletion', 'ex_deleted'))).toBe(false);
  });

  it('removes a sub-workflow’s sharing with it', async () => {
    setBinaryStore(binary);
    shareBinaryScope('ex_sub', 'ex_top');
    await deleteExecutionBinary('ex_top');
    expect(verifyBinaryToken(binaryAccessFor('ex_sub', []).token)?.w).toBe('ex_sub');
  });

  it('sweeps scopes whose execution is gone, after a grace period', async () => {
    setBinaryStore(binary);
    const orphan = await binary.put('ex_orphan', bytes('o'), {});
    const kept = await binary.put('ex_alive', bytes('k'), {});
    expect(await sweepBinaryData((scope) => scope === 'ex_alive', 60_000)).toBe(0); // too fresh
    expect(await sweepBinaryData((scope) => scope === 'ex_alive', 0, Date.now() + 1000)).toBe(1);
    expect(await binary.head(orphan.id!)).toBeUndefined();
    expect(await binary.head(kept.id!)).toBeDefined();
  });
});
