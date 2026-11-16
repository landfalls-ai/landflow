/**
 * SB03: a host's outbound-policy block is a reason for "Needs you" (not a fix to try), and a test asks per destination.
 * `needsPerson` reads the block before the credential rules; `destinationsOf` says where each sending step reaches.
 */
import { describe, expect, it } from 'vitest';
import { destinationsOf, hostOf, needsPerson } from '@/lib/shared/run-check';

describe('a blocked run', () => {
  it('is the person’s, whatever the status code says', () => {
    expect(needsPerson('Blocked: localhost resolves to a private address (LANDFLOW_OUTBOUND_ALLOW lists exceptions)')).toBe('blocked');
    expect(needsPerson('403 Blocked: 127.0.0.1 resolves to a private address (LANDFLOW_OUTBOUND_ALLOW lists exceptions)')).toBe('blocked');
    expect(needsPerson('OutboundBlockedError: refused by the outbound policy')).toBe('blocked');
    // A plain 403 is still a credential problem.
    expect(needsPerson('Request failed with status code 403')).toBe('credential');
    expect(needsPerson('HTTP 500 Internal Server Error')).toBeUndefined();
  });
});

describe('destinationsOf', () => {
  const post = (name: string, url: string) => ({ name, type: 'core.httpRequest', parameters: { method: 'POST', url } });

  it('names host:port for HTTP posts, one destination for two nodes', () => {
    const list = destinationsOf([post('Notify VIP', 'http://127.0.0.1:3399/vip'), post('Notify Standard', 'http://127.0.0.1:3399/standard')]);
    expect(list).toEqual([
      { node: 'Notify VIP', destination: '127.0.0.1:3399' },
      { node: 'Notify Standard', destination: '127.0.0.1:3399' },
    ]);
    expect(new Set(list.map((d) => d.destination)).size).toBe(1);
  });

  it('leaves out reads and non-sending steps', () => {
    expect(destinationsOf([{ name: 'Fetch', type: 'core.httpRequest', parameters: { method: 'GET', url: 'https://example.net' } }, { name: 'Shape', type: 'core.set', parameters: {} }])).toEqual([]);
  });

  it('an expression host is "{{ … }}", an expression only in the path is not', () => {
    expect(destinationsOf([post('Dynamic', '={{ $json.url }}/hook')])).toEqual([{ node: 'Dynamic', destination: '{{ … }}' }]);
    expect(hostOf('https://{{ $json.host }}/x')).toBe('{{ … }}');
    expect(hostOf('https://api.example.net/{{ $json.id }}')).toBe('api.example.net');
    expect(hostOf('https://user:pw@Api.Example.net:8443/x?y=1')).toBe('api.example.net:8443');
  });

  it('an app node that writes is its type and operation', () => {
    expect(destinationsOf([{ name: 'Tell the team', type: 'slack.message', parameters: { operation: 'post' } }])).toEqual([{ node: 'Tell the team', destination: 'slack.message post' }]);
  });
});
