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

  it('keeps a plain-word destination the person gave in the usual wordings', () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ table: 'bugs' }, 'save each bug to the bugs table'],
      [{ channel: 'general' }, 'post it in the general channel'],
      [{ repository: 'landflow' }, 'open an issue in landfalls-ai/landflow'],
      [{ repo: 'landflow' }, 'on the landflow repo'],
      [{ project: 'Website' }, 'to our Website project'],
      [{ team: 'Platform' }, 'assign it to the Platform team'],
      [{ sheet: 'Leads' }, 'add a row to my Leads sheet'],
      [{ table: 'Bug Triage' }, 'save to the Bug Triage table'],
      [{ channel: 'general' }, 'post to #general'],
    ];
    for (const [parameters, text] of cases) expect(parametersOf(withoutInventedIds(set(parameters), text)), text).toEqual(parameters);
  });

  it('still clears a plain word that only appears in the ask', () => {
    expect(parametersOf(withoutInventedIds(set({ table: 'bugs' }), 'get the new bugs and save each bug to a table'))).toEqual({});
  });

  it('does not treat a date window end as an address', () => {
    const typeText = () => JSON.stringify([{ name: 'from', type: 'dateTime' }, { name: 'to', type: 'dateTime' }]);
    const r = withoutInventedIds(set({ to: '2026-11-01' }), 'get last week of spend', typeText);
    expect(parametersOf(r)).toEqual({ to: '2026-11-01' });
    expect(r.invented).toEqual([]);
  });
});

describe('a URL is judged by the host a fetch would reach (review fixes)', () => {
  const k = 'send it to https://good.com and http://127.0.0.1:3400/ (the local one)';
  const cleared = (url: string) => parametersOf(withoutInventedIds(set({ url }), k)).url === undefined;

  it.each([
    'https://evil.com\\@good.com/x',
    'https://evil.com#@good.com/x',
    'https://evil.com?@good.com/x',
    'http://evil.example\\@127.0.0.1:3400/',
    'https://evil.com{{ $json.path }}',
    'https://user@evil.com{{ $json.path }}',
    'https://evil.com:8443{{ $json.path }}',
  ])('clears %s', (url) => {
    expect(cleared(url)).toBe(true);
  });

  it('says a backslash URL cannot be read, and an evil.com one names its host', () => {
    expect(withoutInventedIds(set({ url: 'https://evil.com\\@good.com/x' }), k).invented[0]).toContain('an address that cannot be read');
    expect(withoutInventedIds(set({ url: 'https://evil.com#@good.com/x' }), k).invented[0]).toContain('a host nobody gave (evil.com)');
  });

  it('keeps the hosts somebody gave, with userinfo, a port and an expression after them', () => {
    expect(cleared('https://good.com/x?y=1#z')).toBe(false);
    expect(cleared('http://127.0.0.1:3400/hook')).toBe(false);
    expect(cleared('https://good.com{{ $json.path }}')).toBe(false);
    expect(cleared('https://api.{{ $json.env }}.com/x')).toBe(false);
  });
});

describe('namedAs cues and the kind or app word (review fixes)', () => {
  const add = (parameters: Record<string, unknown>, type = 'messaging.slack') => [{ op: 'addNode', type, name: 'Tell', parameters }];
  const kept = (parameters: Record<string, unknown>, text: string, type?: string) => (withoutInventedIds(add(parameters, type), text).ops as Array<{ parameters: Record<string, unknown> }>)[0].parameters;

  it('"for" and "from" are no naming cue', () => {
    expect(kept({ channel: 'leads' }, 'post a summary for leads')).toEqual({});
    expect(kept({ channel: 'alerts' }, 'read from alerts every day')).toEqual({});
    expect(kept({ channel: 'alerts' }, 'post it with alerts')).toEqual({ channel: 'alerts' });
    expect(kept({ channel: 'ops' }, 'post it as ops')).toEqual({ channel: 'ops' });
    expect(kept({ channel: 'ops' }, 'handled by ops')).toEqual({ channel: 'ops' });
  });

  it('the app\'s name or the kind word is no channel', () => {
    expect(kept({ channel: 'slack' }, 'post a summary to Slack')).toEqual({});
    expect(kept({ channel: 'channel' }, 'post to the channel')).toEqual({});
    expect(kept({ channel: 'triage' }, 'post a summary to triage')).toEqual({ channel: 'triage' });
  });
});

describe('propertyType looks at the top-level property first (review fixes)', () => {
  it('a text "to" on the node is judged although a collection inside has a "to" that is a dateTime', () => {
    const typeText = () => JSON.stringify([{ name: 'filters', type: 'collection', values: [{ name: 'to', type: 'dateTime' }] }, { name: 'to', type: 'string' }]);
    const r = withoutInventedIds([{ op: 'setParameters', node: 'Mail', parameters: { to: 'made.up@nowhere.test' } }], 'send a mail', typeText);
    expect(r.invented).toHaveLength(1);
  });
});
