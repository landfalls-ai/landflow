import { describe, expect, it } from 'vitest';
import { countLayerEvents } from '@/lib/server/agents/layer-stats';
import type { AgentSession, TimelineEntry } from '@/lib/shared/agents';

const at = '2026-11-05T00:00:00Z';
const session = (timeline: TimelineEntry[]) => ({ timeline }) as unknown as AgentSession;

describe('countLayerEvents', () => {
  it('counts requests, routed requests and cache answers from the sessions\' notices', () => {
    const stats = countLayerEvents([
      session([
        { id: '1', type: 'user', text: 'hi', at },
        { id: '2', type: 'notice', message: 'Routed to qwen3.8: short request', at },
        { id: '3', type: 'user', text: 'again', at },
        { id: '4', type: 'notice', message: 'Answered from the response cache: no model call.', at },
        { id: '5', type: 'notice', message: 'Tool access: refund is not available to you', at },
      ]),
      session([{ id: '6', type: 'user', text: 'long one', at }]),
    ]);
    expect(stats).toEqual({ sessions: 2, requests: 3, routed: 1, cached: 1 });
  });

  it('is all zeros without sessions', () => {
    expect(countLayerEvents([])).toEqual({ sessions: 0, requests: 0, routed: 0, cached: 0 });
  });
});
