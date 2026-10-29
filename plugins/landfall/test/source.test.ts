/** The Landfall Source Protocol face: answers /v1/health and /v1/capabilities in the shapes Landfall's schemas require. */
import { afterEach, describe, expect, it } from 'vitest';
import { startSourceFace, startSourceFaceFromEnv, type SourceFace } from '../src/source';

let face: SourceFace | undefined;
afterEach(async () => {
  await face?.close();
  face = undefined;
});

const get = (path: string, headers: Record<string, string> = {}) => fetch(`http://127.0.0.1:${face!.port}${path}`, { headers });

describe('source face', () => {
  it('answers health as { ok, detail? }', async () => {
    face = await startSourceFace({ port: 0 });
    const response = await get('/v1/health');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, detail: 'Landflow Landfall plugin' });
  });

  it('answers capabilities with protocol major 1, a source tag, no kinds and no operations', async () => {
    face = await startSourceFace({ port: 0 });
    const body = (await (await get('/v1/capabilities')).json()) as Record<string, unknown>;
    expect(body).toEqual({ protocolVersion: '1', source: 'landflow', kinds: [], operations: [] });
    // What Landfall's probe checks: strings, and arrays, and the major.
    expect(typeof body.protocolVersion).toBe('string');
    expect(String(body.protocolVersion).split('.')[0]).toBe('1');
  });

  it('404s everything else, including reads', async () => {
    face = await startSourceFace({ port: 0 });
    expect((await get('/v1/invoke')).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${face.port}/v1/metrics/list`, { method: 'POST', body: '{}' })).status).toBe(404);
  });

  it('is open without a token', async () => {
    face = await startSourceFace({ port: 0 });
    expect((await get('/v1/health')).status).toBe(200);
    expect((await get('/v1/health', { authorization: 'Bearer anything' })).status).toBe(200);
  });

  it('requires the bearer token when one is set', async () => {
    face = await startSourceFace({ port: 0, token: 'source-secret-1' });
    expect((await get('/v1/health')).status).toBe(401);
    expect((await get('/v1/capabilities', { authorization: 'Bearer wrong-secret-1' })).status).toBe(401);
    expect((await get('/v1/health', { authorization: 'Bearer source-secret-1' })).status).toBe(200);
    expect((await get('/v1/capabilities', { authorization: 'Bearer source-secret-1' })).status).toBe(200);
  });

  it('starts from the environment only when LANDFALL_SOURCE_PORT is set', async () => {
    expect(await startSourceFaceFromEnv({})).toBeUndefined();
    face = await startSourceFaceFromEnv({ LANDFALL_SOURCE_PORT: '0', LANDFALL_SOURCE_TOKEN: 't-1' });
    expect((await get('/v1/health')).status).toBe(401);
    expect((await get('/v1/health', { authorization: 'Bearer t-1' })).status).toBe(200);
    await expect(startSourceFaceFromEnv({ LANDFALL_SOURCE_PORT: 'abc' })).rejects.toThrow(/must be a port number/);
  });
});
