import { afterEach, describe, expect, it, vi } from 'vitest';
import { POST } from '@/app/api/assistant/transcribe/route';

const audio = (body: BodyInit | null = new Uint8Array([1, 2, 3]), type = 'audio/webm') =>
  new Request('http://localhost/api/assistant/transcribe', { method: 'POST', headers: { 'content-type': type }, body });

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.LANDFLOW_STT_URL;
  delete process.env.LANDFLOW_STT_API_KEY;
});

describe('POST /api/assistant/transcribe', () => {
  it('sends the clip to the transcription endpoint and returns the text', async () => {
    process.env.LANDFLOW_STT_URL = 'http://stt.local/v1/';
    process.env.LANDFLOW_STT_API_KEY = 'k';
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ text: ' add a Slack node ' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const res = await POST(audio());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: 'add a Slack node' });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://stt.local/v1/audio/transcriptions');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer k');
    expect((init.body as FormData).get('model')).toBe('whisper-1');
  });

  it('refuses a body that is not audio, or empty', async () => {
    expect((await POST(audio('hi', 'text/plain'))).status).toBe(415);
    expect((await POST(audio(new Uint8Array()))).status).toBe(400);
  });

  it('says so when the speech-to-text server is unreachable or fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    const down = await POST(audio());
    expect(down.status).toBe(502);
    expect(((await down.json()) as { error: string }).error).toContain('LANDFLOW_STT_URL');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('bad model', { status: 500 })));
    const failed = await POST(audio());
    expect(((await failed.json()) as { error: string }).error).toContain('500');
  });
});
