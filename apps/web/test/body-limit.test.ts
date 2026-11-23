/** parseBody refuses a body over the cap with 413: by Content-Length, or by counting a stream, without buffering it all. */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { parseBody } from '@/lib/server/http';

const schema = z.object({ text: z.string() });
const post = (body: BodyInit, headers: Record<string, string> = {}) => new Request('http://localhost/x', { method: 'POST', body, headers, ...(typeof body !== 'string' && { duplex: 'half' }) } as RequestInit);

describe('parseBody size cap', () => {
  it('accepts a body under the cap', async () => {
    const result = await parseBody(post(JSON.stringify({ text: 'hi' })), schema, { maxBytes: 100 });
    expect(result).toEqual({ ok: true, data: { text: 'hi' } });
  });

  it('refuses a declared length above the cap', async () => {
    const result = await parseBody(post(JSON.stringify({ text: 'x'.repeat(200) })), schema, { maxBytes: 100 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(413);
      expect(await result.response.json()).toEqual({ error: 'Request body too large', limit: 100 });
    }
  });

  it('stops reading a stream without a length at the cap', async () => {
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new TextEncoder().encode('x'.repeat(50)));
        if (pulled > 1000) controller.close();
      },
    });
    const result = await parseBody(post(stream), schema, { maxBytes: 120 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(413);
    expect(pulled).toBeLessThan(10);
  });

  it('refuses even when the body is optional, and the default cap is 16 MiB', async () => {
    const result = await parseBody(post(JSON.stringify({ text: 'x'.repeat(200) })), schema, { maxBytes: 100, optional: true });
    expect(result.ok).toBe(false);
    const { maxBodyBytes } = await import('@/lib/server/http');
    expect(maxBodyBytes()).toBe(16 * 1024 * 1024);
  });

  it('still answers 400 for text that is not JSON', async () => {
    const result = await parseBody(post('nope'), schema);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(400);
  });
});
