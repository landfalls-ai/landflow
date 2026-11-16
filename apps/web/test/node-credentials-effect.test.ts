// @vitest-environment happy-dom
/**
 * The node panel's credential picker with its effects running (a DOM, React's `act`): the unit tests of the pick rule
 * (credential-autopick.test.ts) cannot see wiring. Each test names the regression it catches. Made-up data; the hooks
 * that fetch are stubbed.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement, type ComponentProps } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Cred = { id: string; name: string; type: string };
const HEADER: Cred = { id: 'h1', name: 'Echo header', type: 'core.httpHeaderAuth' };
const BEARER: Cred = { id: 'b1', name: 'Echo bearer', type: 'core.httpBearerAuth' };

let listed: Cred[] = [];
let scopeState: { scope?: { ids: Set<string>; projectId?: string }; failed: boolean } = { failed: false };
let reloadImpl: () => Promise<boolean> = async () => true;
vi.mock('@/components/credentials/use-credentials', async (original) => ({
  ...(await original<typeof import('@/components/credentials/use-credentials')>()),
  useCredentials: () => ({ credentials: listed, types: [] }),
}));
vi.mock('@/components/projects/use-projects', async (original) => ({
  ...(await original<typeof import('@/components/projects/use-projects')>()),
  useCredentialScope: () => ({ ...scopeState, reload: () => reloadImpl() }),
}));

const { NodeCredentials } = await import('@/components/credentials/node-credentials');

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  listed = [HEADER, BEARER];
  scopeState = { failed: false };
  reloadImpl = async () => true;
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

type Props = ComponentProps<typeof NodeCredentials>;
const base = (over: Partial<Props> = {}): Props => ({ nodeType: 'core.httpRequest', workflowId: 'wf_1', requirements: [{ name: 'httpHeaderAuth' }], onChange: () => {}, ...over });
const render = (props: Props) => act(() => root.render(createElement(NodeCredentials, props)));
const scopeOf = (...ids: string[]) => ({ scope: { ids: new Set(ids) }, failed: false });

describe('the effect', () => {
  it('picks nothing while the project’s credentials are unknown, then picks (fails if scopeKnown is forced true or the scope is not waited for)', () => {
    const onChange = vi.fn();
    render(base({ onChange }));
    expect(onChange).not.toHaveBeenCalled();
    scopeState = scopeOf('h1');
    render(base({ onChange }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ httpHeaderAuth: { id: 'h1', name: 'Echo header' } });
  });

  it('picks only from the project’s credentials (fails if the whole list is used once the scope is known)', () => {
    const onChange = vi.fn();
    scopeState = scopeOf('b1');
    render(base({ onChange }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('puts every requirement in one update (fails if each requirement calls onChange with the same stale value)', () => {
    const onChange = vi.fn();
    scopeState = scopeOf('h1', 'b1');
    render(base({ onChange, requirements: [{ name: 'httpHeaderAuth' }, { name: 'httpBearerAuth' }] }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ httpHeaderAuth: { id: 'h1', name: 'Echo header' }, httpBearerAuth: { id: 'b1', name: 'Echo bearer' } });
  });

  it('picks a requirement that appears later with nothing else changed (fails if the requirement names are not an effect dependency)', () => {
    const onChange = vi.fn();
    scopeState = scopeOf('h1', 'b1');
    const requirements = [{ name: 'oAuth2Api' }];
    render(base({ onChange, requirements }));
    expect(onChange).not.toHaveBeenCalled();
    render(base({ onChange, requirements: [{ name: 'oAuth2Api' }, { name: 'httpHeaderAuth' }] }));
    expect(onChange).toHaveBeenCalledWith({ httpHeaderAuth: { id: 'h1', name: 'Echo header' } });
  });

  it('leaves a slot the person cleared while the step was blocked (fails if the value is not an effect dependency, or a blocked step does not settle set slots)', () => {
    const onChange = vi.fn();
    scopeState = { failed: false };
    render(base({ onChange }));
    // The value arrives while the project's scope is unknown, then is cleared, then the scope arrives.
    render(base({ onChange, value: { httpHeaderAuth: { id: 'h1', name: 'Echo header' } } }));
    render(base({ onChange, value: undefined }));
    scopeState = scopeOf('h1');
    render(base({ onChange, value: undefined }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('picks nothing while the tab may not save, or the lock is unknown (readOnly)', () => {
    const onChange = vi.fn();
    scopeState = scopeOf('h1');
    render(base({ onChange, readOnly: true }));
    expect(onChange).not.toHaveBeenCalled();
    render(base({ onChange, readOnly: false }));
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('a new mount (key={openNodeId}) forgets what the last node settled', () => {
    const onChange = vi.fn();
    scopeState = scopeOf('h1');
    render(base({ onChange }));
    expect(onChange).toHaveBeenCalledTimes(1);
    act(() => root.render(createElement(NodeCredentials, { ...base({ onChange }), key: 'node-2' })));
    expect(onChange).toHaveBeenCalledTimes(2);
  });
});

describe('the node panel wires it (source checks: NodePanel is too heavy to render here)', () => {
  const panel = readFileSync(join(process.cwd(), 'src/components/editor/node-panel.tsx'), 'utf8');
  it('remounts the picker per node, waits for the lock, and shows the publish note by the published version', () => {
    expect(panel).toMatch(/<NodeCredentials[^>]*\bkey=\{openNodeId\}/s);
    expect(panel).toMatch(/useEditLock\(\(s\) => s\.readOnly \|\| !s\.known\)/);
    expect(panel).toMatch(/publishPending=\{workflowActive && credentialsNotPublished\}/);
  });
});

describe('the warning when the project’s credentials could not be checked', () => {
  it('is a live region that says every credential is listed, and Retry is busy then moves focus to the picker', async () => {
    scopeState = { failed: true };
    let finish: (ok: boolean) => void = () => {};
    reloadImpl = () => new Promise<boolean>((resolve) => (finish = resolve));
    render(base());
    const status = container.querySelector('[role="status"]');
    expect(status?.getAttribute('aria-live')).toBe('polite');
    expect(status?.textContent).toContain('every credential is listed');
    const retry = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Retry')!;
    await act(async () => retry.click());
    const busy = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Retrying…')!;
    expect(busy.disabled).toBe(true);
    expect(busy.getAttribute('aria-busy')).toBe('true');
    scopeState = scopeOf('h1');
    await act(async () => finish(true));
    render(base());
    expect(document.activeElement?.tagName).toBe('SELECT');
    expect(container.querySelector('[role="status"]')?.textContent).toBe('');
  });
});
