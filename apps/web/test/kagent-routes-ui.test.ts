// @vitest-environment happy-dom
/**
 * C26: the route editor on the kagent card in happy-dom: the credential choices are the two static-header types, a route
 * shows its credential and hosts, a bad host or header is explained under the route as the person types (the server's rules),
 * the placeholder hint has its copyable example, and the manifest preview says what Landflow will write without a value.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CredentialSummary } from '../src/lib/shared/types';
import type { KagentRouteDraft } from '../src/lib/shared/kagent-routes';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { KagentRoutes, routeCredentials, routePreview } = await import('../src/components/agents/kagent-routes');
const { draftProblem, draftsProblem } = await import('../src/lib/shared/kagent-routes');

let root: Root | undefined;
let host: HTMLElement | undefined;
const mount = (node: Parameters<Root['render']>[0]) => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(node));
  return host;
};
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  document.body.innerHTML = '';
  root = host = undefined;
});

const summary = (id: string, name: string, type: string): CredentialSummary => ({ id, name, type, createdAt: '2026-11-22T00:00:00Z', updatedAt: '2026-11-22T00:00:00Z', usedBy: [] });
const CREDENTIALS = [summary('c1', 'Linear', 'core.httpBearerAuth'), summary('c2', 'Acme key', 'core.httpHeaderAuth'), summary('c3', 'Google', 'core.oAuth2Api'), summary('c4', 'OpenAI', 'core.openAiApi')];
const linear = (over: Partial<KagentRouteDraft> = {}): KagentRouteDraft => ({ credential: { id: 'c1', name: 'Linear' }, hosts: ['https://api.linear.app'], header: 'Authorization', prefix: 'Bearer ', ...over });
const editor = (routes: KagentRouteDraft[], onChange = vi.fn()) => mount(createElement(KagentRoutes, { name: 'router', routes, onChange, credentials: CREDENTIALS, onCreate: vi.fn() }));

describe('the credentials offered', () => {
  it('are Bearer Auth and Header Auth only (AS-4)', () => {
    expect(routeCredentials(CREDENTIALS).map((c) => c.name)).toEqual(['Linear', 'Acme key']);
  });
  it('says which types work', () => {
    expect(editor([]).textContent).toContain('Bearer Auth and Header Auth');
  });
});

describe('a route', () => {
  it('shows its credential, host, header and prefix', () => {
    const dom = editor([linear()]);
    expect(dom.textContent).toContain('Linear');
    expect(dom.textContent).toContain('https://api.linear.app');
    expect((dom.querySelector('input[aria-label="Header for route 1"]') as HTMLInputElement).value).toBe('Authorization');
    expect((dom.querySelector('input[aria-label="Prefix for route 1"]') as HTMLInputElement).value).toBe('Bearer ');
  });

  it('explains a host the server would refuse, under the route (AS-7)', () => {
    const dom = editor([linear({ hosts: ['http://10.0.0.5', 'https://*.example.com'] })]);
    const alert = dom.querySelector('[role="alert"]');
    expect(alert?.textContent).toMatch(/^Route 1: .*http:\/\/10\.0\.0\.5/);
  });

  it('adds and removes a route through onChange', () => {
    const onChange = vi.fn();
    const dom = editor([linear()], onChange);
    act(() => (dom.querySelector('button[aria-label="Remove route 1"]') as HTMLButtonElement).click());
    expect(onChange).toHaveBeenLastCalledWith([]);
    act(() => [...dom.querySelectorAll('button')].find((b) => b.textContent?.includes('Add route'))!.click());
    expect(onChange).toHaveBeenLastCalledWith([linear(), { hosts: [] }]);
  });

  it('takes a typed host on Enter and a header on change', () => {
    const onChange = vi.fn();
    const dom = editor([linear()], onChange);
    const input = dom.querySelector('input[aria-label="Add a host to route 1"]') as HTMLInputElement;
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => {
      set.call(input, 'https://uploads.linear.app');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => void input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(onChange).toHaveBeenLastCalledWith([linear({ hosts: ['https://api.linear.app', 'https://uploads.linear.app'] })]);
  });
});

describe('the guidance and the preview', () => {
  it('has the placeholder hint with a copy button for the example (FR-8)', () => {
    const dom = editor([linear()]);
    expect(dom.textContent).toContain('sends the header with any value');
    expect(dom.textContent).toContain("curl -H 'Authorization: x'");
    expect(dom.querySelector('button[aria-label="Copy the example"]')).not.toBeNull();
  });

  it('previews the objects Landflow writes, with the credential’s name and never a value', () => {
    const lines = routePreview('router', [linear(), { credential: { id: 'c2', name: 'Acme key' }, hosts: ['https://api.acme.test'] }]);
    expect(lines).toEqual([
      'Secret router-routes: r0 ← Linear, r1 ← Acme key (the values stay in the vault and in this Secret)',
      'EgressPolicy router-routes:',
      '  https://api.linear.app → Authorization: Bearer <Linear>',
      '  https://api.acme.test → <Acme key’s header>: <Acme key>',
    ]);
    expect(editor([linear()]).textContent).toContain('router-routes');
  });
});

describe('a draft that is not ready', () => {
  it('needs a credential and a host, and says which route', () => {
    expect(draftProblem({ hosts: ['https://api.linear.app'] }, 1)).toBe('Route 2: choose a credential');
    expect(draftProblem(linear({ hosts: [] }), 0)).toMatch(/Route 1: .*host/);
    expect(draftProblem(linear(), 0)).toBeUndefined();
    expect(draftsProblem([linear(), linear()])).toMatch(/Route 2: .*already in Route 1/);
  });
});
