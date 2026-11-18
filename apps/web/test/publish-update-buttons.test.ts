// @vitest-environment happy-dom
/**
 * AG21 (wave ag4 review): "Test and update" in the Publish menu is a button, not plain text (it was the ghost variant: no
 * border, text colour only). Rendered from the real PublishControl with a published workflow and one newer agent version.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(Element.prototype as unknown as { animate: unknown }).animate = () => ({ finished: Promise.resolve(), cancel() {}, finish() {}, onfinish: null, addEventListener() {}, removeEventListener() {} });

vi.mock('@/lib/client/api', async (original) => ({
  ...(await original<typeof import('@/lib/client/api')>()),
  api: vi.fn(async (path: string) => {
    if (path.endsWith('/pins')) return { pins: [{ agentId: 'ag_1', agentName: 'Alert triager', nodeId: 'n1', version: 1 }] };
    if (path.endsWith('/agent-updates')) return { updates: [{ agentId: 'ag_1', agentName: 'Alert triager', pinned: 1, latest: 2 }], offer: { agents: ['ag_1'] } };
    if (path.endsWith('/publication')) return PUBLICATION;
    return { requests: [], schedules: [], fourEyes: { enabled: false } };
  }),
}));

const PUBLICATION = { published: { versionId: 'v_1', versionNumber: 1, publishedAt: new Date().toISOString(), publishedBy: 'u' }, unpublishedChanges: false, appWebhooks: [] };
const { PublishControl, usePublication } = await import('@/components/editor/publish-control');

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

describe('the Publish menu’s agent update buttons', () => {
  it('Test and update has the outline variant (a border), like the Ask Spotlight button beside it', async () => {
    usePublication.setState({ workflowId: 'wf_1', status: PUBLICATION as never });
    await act(async () => root.render(createElement(PublishControl, { workflowId: 'wf_1', onSave: async () => true })));
    await settle();
    await act(async () => (container.querySelector('button[aria-expanded]') as HTMLButtonElement).click());
    await settle();
    const buttons = [...document.querySelectorAll('button')];
    const update = buttons.find((b) => b.textContent?.trim() === 'Test and update')!;
    const ask = buttons.find((b) => /Ask Spotlight to test and update/.test(b.textContent ?? ''))!;
    expect(update, 'the button is in the menu').toBeTruthy();
    expect(update.className).toContain('border-bd');
    expect(ask.className).toContain('border-bd');
  });
});
