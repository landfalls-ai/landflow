/**
 * HTTP Range requests on GET /api/binary/<id>: 200 with Accept-Ranges, 206 for a-b, a- and -n, 416 when
 * unsatisfiable, whole-file fallbacks for multi-range or malformed headers, tokens still checked. Runs on the
 * filesystem store, and on MinIO (http://127.0.0.1:59000 unless LANDFLOW_S3_* say otherwise) when it answers.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { setBinaryStore, signBinaryToken } from '@/lib/server/binary/access';
import { FilesystemBinaryStore, type BinaryStore } from '@/lib/server/binary/store';

const fileRoute = await import('@/app/api/binary/[id]/route');
const root = mkdtempSync(join(tmpdir(), 'landflow-binary-range-'));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const DATA = Buffer.from('0123456789abcdefghij'); // 20 bytes
const get = async (id: string, headers: Record<string, string> = {}, method: 'GET' | 'HEAD' = 'GET') =>
  fileRoute[method](new Request(`http://binary.test/api/binary/${id}`, { method, headers }), { params: Promise.resolve({ id }) });

function ranges(label: string, make: () => BinaryStore, scope: string) {
  describe(label, () => {
    const binary = make();
    let id = '';
    it('stores a file', async () => {
      setBinaryStore(binary);
      id = (await binary.put(scope, DATA, { mimeType: 'video/mp4', fileName: 'clip.mp4' })).id!;
    });
    afterAll(async () => {
      await binary.deleteScope(scope);
    });
    const part = async (range: string) => {
      setBinaryStore(binary);
      const res = await get(id, { range });
      return { res, body: Buffer.from(await res.arrayBuffer()).toString() };
    };

    it('answers 200 with Accept-Ranges and the whole file', async () => {
      setBinaryStore(binary);
      const res = await get(id);
      expect(res.status).toBe(200);
      expect(res.headers.get('accept-ranges')).toBe('bytes');
      expect(res.headers.get('content-length')).toBe('20');
      expect(Buffer.from(await res.arrayBuffer())).toEqual(DATA);
    });
    it('answers a-b with 206', async () => {
      const { res, body } = await part('bytes=2-5');
      expect(res.status).toBe(206);
      expect(res.headers.get('content-range')).toBe('bytes 2-5/20');
      expect(res.headers.get('content-length')).toBe('4');
      expect(res.headers.get('accept-ranges')).toBe('bytes');
      expect(res.headers.get('content-type')).toBe('video/mp4');
      expect(body).toBe('2345');
    });
    it('answers open-ended and suffix ranges, clamping the end', async () => {
      expect((await part('bytes=15-')).body).toBe('fghij');
      expect((await part('bytes=15-')).res.headers.get('content-range')).toBe('bytes 15-19/20');
      expect((await part('bytes=18-99')).res.headers.get('content-range')).toBe('bytes 18-19/20');
      const suffix = await part('bytes=-4');
      expect(suffix.res.status).toBe(206);
      expect(suffix.res.headers.get('content-range')).toBe('bytes 16-19/20');
      expect(suffix.body).toBe('ghij');
      expect((await part('bytes=-100')).res.headers.get('content-range')).toBe('bytes 0-19/20');
      expect((await part('bytes=0-0')).body).toBe('0');
    });
    it('answers 416 with Content-Range */size when unsatisfiable', async () => {
      for (const range of ['bytes=20-', 'bytes=50-60', 'bytes=-0']) {
        const { res } = await part(range);
        expect(res.status).toBe(416);
        expect(res.headers.get('content-range')).toBe('bytes */20');
        expect(res.headers.get('accept-ranges')).toBe('bytes');
      }
    });
    it('serves the whole file for multi-range, malformed, foreign-unit and If-Range requests', async () => {
      for (const range of ['bytes=0-1,4-5', 'bytes=abc', 'bytes=5-2', 'bytes=-', 'items=0-3', 'bytes']) {
        const { res, body } = await part(range);
        expect(res.status, range).toBe(200);
        expect(res.headers.get('content-range')).toBeNull();
        expect(body).toBe(DATA.toString());
      }
      setBinaryStore(binary);
      const res = await get(id, { range: 'bytes=0-3', 'if-range': '"etag"' });
      expect(res.status).toBe(200);
      await res.arrayBuffer();
    });
    it('answers HEAD with the same headers and no body', async () => {
      setBinaryStore(binary);
      const res = await get(id, { range: 'bytes=2-5' }, 'HEAD');
      expect(res.status).toBe(206);
      expect(res.headers.get('content-range')).toBe('bytes 2-5/20');
      expect(await res.text()).toBe('');
    });
    it('still checks the token, and still 404s', async () => {
      setBinaryStore(binary);
      expect((await get(id, { range: 'bytes=0-1', authorization: 'Bearer nope' })).status).toBe(401);
      const claims = (w: string) => `Bearer ${signBinaryToken({ w, r: [], x: Math.floor(Date.now() / 1000) + 60 })}`;
      expect((await get(id, { range: 'bytes=0-1', authorization: claims('other_scope') })).status).toBe(403);
      const ok = await get(id, { range: 'bytes=0-1', authorization: claims(scope) });
      expect(ok.status).toBe(206);
      await ok.arrayBuffer();
      expect((await get(`${scope}.AAAAAAAAAAAAAAAAAAAAAA`, { range: 'bytes=0-1' })).status).toBe(404);
    });
  });
}

ranges('Range requests (filesystem store)', () => new FilesystemBinaryStore(join(root, 'fs')), 'ex_range_fs');

const s3Options = {
  bucket: process.env.LANDFLOW_S3_BUCKET ?? 'landflow',
  endpoint: process.env.LANDFLOW_S3_ENDPOINT ?? 'http://127.0.0.1:59000',
  accessKeyId: process.env.LANDFLOW_S3_ACCESS_KEY_ID ?? 'landflow',
  secretAccessKey: process.env.LANDFLOW_S3_SECRET_ACCESS_KEY ?? 'landflow-dev-only',
  prefix: `landflow-test-range-${process.pid}/`,
};
const minio = await fetch(`${s3Options.endpoint}/minio/health/live`, { signal: AbortSignal.timeout(1500) }).then((r) => r.ok, () => false);
describe.skipIf(!minio)('Range requests (S3 store, MinIO)', async () => {
  const { S3BinaryStore } = await import('@/lib/server/binary/s3');
  ranges('S3', () => new S3BinaryStore(s3Options), `ex_range_s3_${Math.random().toString(36).slice(2, 8)}`);
});
