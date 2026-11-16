/** The made-up values guard (lib/server/assistant/guards.ts `withoutInventedIds`) beyond ids: channels, tables and URL hosts. */
import { describe, expect, it } from 'vitest';
import { withoutInventedIds } from '@/lib/server/assistant/guards';

const set = (parameters: Record<string, unknown>) => [{ op: 'setParameters', node: 'Notify VIP', parameters }];
const parametersOf = (r: ReturnType<typeof withoutInventedIds>) => (r.ops as Array<{ parameters: Record<string, unknown> }>)[0].parameters;
const known = 'POST to http://127.0.0.1:3403/vip';

describe('made-up destinations', () => {
  it('clears a URL whose host nobody gave and says so', () => {
    const r = withoutInventedIds(set({ url: 'https://httpbin.org/post', method: 'POST' }), known);
    expect(parametersOf(r)).toEqual({ method: 'POST' });
    expect(r.invented).toEqual(['url of “Notify VIP”: a host nobody gave (httpbin.org), left for the user to fill in']);
    expect(r.values).toEqual(['https://httpbin.org/post']);
  });

  it('keeps another path on a host somebody gave, and expressions', () => {
    expect(parametersOf(withoutInventedIds(set({ url: 'http://127.0.0.1:3403/standard' }), known))).toEqual({ url: 'http://127.0.0.1:3403/standard' });
    expect(parametersOf(withoutInventedIds(set({ url: '{{ $json.url }}' }), known))).toEqual({ url: '{{ $json.url }}' });
  });

  it('judges the literal host of a URL with an expression in it', () => {
    const k = known;
    expect(parametersOf(withoutInventedIds(set({ url: 'https://httpbin.org/post?id={{ $json.id }}' }), k))).toEqual({});
    expect(parametersOf(withoutInventedIds(set({ url: 'https://api.made-up.com/users/{{ $json.id }}' }), k))).toEqual({});
    expect(parametersOf(withoutInventedIds(set({ url: 'http://127.0.0.1:3403/users/{{ $json.id }}' }), k))).toEqual({ url: 'http://127.0.0.1:3403/users/{{ $json.id }}' });
    expect(parametersOf(withoutInventedIds(set({ url: '{{ $json.url }}' }), k))).toEqual({ url: '{{ $json.url }}' });
    expect(parametersOf(withoutInventedIds(set({ url: 'https://{{ $json.host }}/x' }), k))).toEqual({ url: 'https://{{ $json.host }}/x' });
  });

  it('matches a host as a whole and a channel without regard to case', () => {
    expect(parametersOf(withoutInventedIds(set({ url: 'https://example.com/x' }), 'use myexample.com'))).toEqual({});
    expect(parametersOf(withoutInventedIds(set({ url: 'https://example.com/x' }), 'use example.com.'))).toEqual({ url: 'https://example.com/x' });
    expect(parametersOf(withoutInventedIds(set({ channel: '#triage' }), 'post to #Triage'))).toEqual({ channel: '#triage' });
  });

  it('keeps a host the node type’s defaults name', () => {
    const typeText = () => JSON.stringify([{ name: 'url', default: 'https://api.example.com/v1' }]);
    expect(withoutInventedIds(set({ url: 'https://api.example.com/v2' }), '', typeText).invented).toEqual([]);
  });

  it('clears a channel nobody said, and keeps one the message did', () => {
    expect(parametersOf(withoutInventedIds(set({ channel: '#bugs' }), 'post a summary'))).toEqual({});
    expect(parametersOf(withoutInventedIds(set({ channel: '#bugs' }), 'post it to #bugs'))).toEqual({ channel: '#bugs' });
  });

  it('clears a table, a team and an address nobody gave', () => {
    const r = withoutInventedIds(set({ table: 'bugs', team: 'ENG', email: 'a@b.co', n: 'x' }), 'save them');
    expect(parametersOf(r)).toEqual({ n: 'x' });
    expect(r.invented).toHaveLength(3);
  });
});
