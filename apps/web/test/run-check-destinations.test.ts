/**
 * SB03: a host's outbound-policy block is a reason for "Needs you" (not a fix to try), and a test asks per destination.
 * `needsPerson` reads the block before the credential rules; `destinationsOf` says where each sending step reaches.
 */
import { describe, expect, it } from 'vitest';
import { NO_ADDRESS, yesText, destinationsOf, hostOf, isUnreadHost, needsPerson, urlHost } from '@/lib/shared/run-check';

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

  it('an empty URL is "an address not filled in yet", a URL with a backslash or a literal host and an expression is read as unknown', () => {
    expect(hostOf('')).toBe(NO_ADDRESS);
    expect(hostOf('  ')).toBe(NO_ADDRESS);
    expect(hostOf('http://evil.example\\@127.0.0.1:3400/')).toBe('{{ … }}');
    expect(hostOf('https://evil.com\\@good.com/x')).toBe('{{ … }}');
    expect(hostOf('https://evil.com{{ $json.path }}')).toBe('evil.com{{ … }}');
    expect(hostOf('/api/x')).toBe('{{ … }}');
    expect(urlHost('/api/x')).toBeUndefined();
    expect(urlHost('//evil.com/x')).toMatchObject({ hostname: 'evil.com' }); // protocol-relative: a host, not a path
    expect(hostOf('//evil.com/x')).toBe('evil.com');
    expect(hostOf('=https://evil.com/{{ $json.id }}')).toBe('evil.com');
    // An expression in the user name: the host is shown, but it can move at run time, so it asks every run.
    expect(hostOf('https://{{ $json.u }}@evil.com/x')).toBe('evil.com{{ … }}');
    expect(hostOf('https://user:{{ $json.pw }}@evil.com/x')).toBe('evil.com{{ … }}');
    expect(hostOf('https://{{ $json.host }}/x')).toBe('{{ … }}');
    expect(isUnreadHost('evil.com{{ … }}')).toBe(true);
  });

  it('reads the host as a fetch does: after # and ? the host has ended', () => {
    expect(hostOf('https://evil.com#@good.com/x')).toBe('evil.com');
    expect(hostOf('https://evil.com?@good.com/x')).toBe('evil.com');
    expect(hostOf('https://good.com:443/x')).toBe('good.com');
    expect(hostOf('not a url')).toBe('{{ … }}');
  });

  it('an "@" inside an expression is no user-name break, and "=" with spaces is still an expression URL', () => {
    expect(hostOf("https://good.com{{ '@evil.com' }}")).toBe('good.com{{ … }}');
    expect(hostOf("https://good.com{{'@evil.com'}}")).toBe('good.com{{ … }}');
    expect(urlHost("https://good.com{{'@evil.com'}}")).toBe('unreadable');
    expect(hostOf('= https://evil.com/{{ x }}')).toBe('evil.com');
    expect(hostOf('=  https://evil.com/x')).toBe('evil.com');
    expect(urlHost('= https://evil.com/x')).toMatchObject({ hostname: 'evil.com' });
    expect(isUnreadHost(hostOf('https://{{ $json.u }}@good.com/x'))).toBe(true);
  });

  it('a yes on an expression destination says it covers the next run only', () => {
    expect(yesText(['{{ … }}'])).toMatch(/next run only/);
    expect(yesText(['{{ … }}'])).not.toMatch(/^You said yes: tests of this workflow/);
    expect(yesText(['127.0.0.1:3399'])).toBe('You said yes: tests of this workflow run for real to 127.0.0.1:3399.');
  });

  it('an app node that writes is its type and operation', () => {
    expect(destinationsOf([{ name: 'Tell the team', type: 'slack.message', parameters: { operation: 'post' } }])).toEqual([{ node: 'Tell the team', destination: 'slack.message post' }]);
  });
});
