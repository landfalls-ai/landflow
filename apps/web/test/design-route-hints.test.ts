/** SB05: POST /api/agents/design hands `tools` and `knowledge` to the architect's spec, within their limits. */
import { describe, expect, it, vi } from 'vitest';

const seen: Array<Record<string, unknown>> = [];
vi.mock('@/lib/server/assistant/architect', () => ({
  designAgent: vi.fn(async (spec: Record<string, unknown>) => {
    seen.push(spec);
    return { config: { name: String(spec.name), description: '', instructions: '', skills: [], tools: [], schedules: [], channels: [], memory: { crossSession: false }, settings: {} }, needs: [], missing: [], dropped: [], designed: true };
  }),
}));

const { POST } = await import('@/app/api/agents/design/route');

const post = (body: unknown) => POST(new Request('http://localhost/api/agents/design', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));

describe('the design route', () => {
  it('passes the tools and knowledge hints on', async () => {
    const res = await post({ name: 'Docs Answerer', description: 'd', instructions: 'i', after: 'Sample question', tools: ['Linear: read issues'], knowledge: 'our docs' });
    expect(res.status).toBe(201);
    expect(seen.at(-1)).toMatchObject({ after: 'Sample question', tools: ['Linear: read issues'], knowledge: 'our docs' });
  });
  it('refuses more than 8 tools', async () => {
    const res = await post({ name: 'A', tools: Array.from({ length: 9 }, (_, i) => `t${i}`) });
    expect(res.status).toBe(400);
  });
});
