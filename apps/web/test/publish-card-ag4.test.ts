// @vitest-environment happy-dom
/**
 * AG21: Spotlight's publish card in happy-dom (the real card and stores; the routes are a stubbed fetch with made-up data).
 * An update card enables Publish only after a passing Test, and publishes through `update` with the test run's id; a draft card
 * with an agent whose draft differs shows the block and "Publish <agent> first", which sends `agents: 'publish-first'`.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublishOffer } from '../src/lib/shared/agent-versions';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { PublishCardView } = await import('../src/components/editor/spotlight/publish-card');
const { useAssistant } = await import('../src/components/editor/assistant');
const { useEditor } = await import('../src/components/editor/store');

const updateOffer: PublishOffer = {
  workflowId: 'wf1',
  kind: 'update',
  nextVersion: 9,
  pins: [{ nodeId: 'n1', agentId: 'a1', agentName: 'Alert triager', version: 2 }],
  updates: [{ workflowId: 'wf1', workflowName: 'Alert intake', workflowVersion: 8, agentId: 'a1', agentName: 'Alert triager', pinned: 1, latest: 2, nodes: ['Agent'] }],
};
const draftOffer: PublishOffer = {
  workflowId: 'wf1',
  kind: 'draft',
  nextVersion: 7,
  pins: [{ nodeId: 'n1', agentId: 'a1', agentName: 'Alert triager', version: 1 }],
  blocks: [{ agentId: 'a1', name: 'Alert triager', published: 1, changes: ['Instructions'] }],
};

let root: Root;
let host: HTMLElement;
let posts: Array<{ url: string; body: Record<string, unknown> }>;
let testStatus: string;
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  posts = [];
  testStatus = 'success';
  useEditor.setState({ workflowId: 'wf1', dirty: false } as never);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = String(url);
      if (init?.method === 'POST') posts.push({ url: path, body: JSON.parse(String(init.body ?? '{}')) });
      if (path.endsWith('/test-update')) return ok({ executionId: 'ex1', status: testStatus });
      if (path.includes('/api/executions/ex1'))
        return ok({ execution: { status: testStatus, versions: { workflow: { number: 8, production: true }, agents: [{ nodeId: 'n1', agentId: 'a1', agentName: 'Alert triager', version: 2, source: 'pinned' }] } } });
      if (path.endsWith('/publish')) return ok({ published: { versionNumber: 9 }, unpublishedChanges: false, log: [], appWebhooks: [], triggerErrors: [] });
      return ok({});
    }),
  );
  host = document.body.appendChild(document.createElement('div'));
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  useAssistant.setState({ items: [] } as never);
});

function Card() {
  const part = useAssistant((s) => s.items.find((i) => i.id === 'i1')?.parts[0]);
  return part?.kind === 'publishOffer' ? createElement(PublishCardView, { itemId: 'i1', offer: part.offer, card: part.card }) : null;
}
const mount = async (offer: PublishOffer) => {
  useAssistant.getState().append([{ id: 'i1', role: 'assistant', parts: [{ kind: 'publishOffer', offer }] }]);
  await act(async () => root.render(createElement(Card)));
};
const button = (label: RegExp) => [...host.querySelectorAll('button')].find((b) => label.test((b.textContent ?? '').trim()));
const click = async (label: RegExp) => {
  const target = button(label);
  expect(target, String(label)).toBeTruthy();
  await act(async () => {
    target!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
};

describe('the update card', () => {
  it('titles itself, enables Publish only after a passing Test, then publishes with the test run', async () => {
    await mount(updateOffer);
    expect(host.textContent).toContain('Publish v9: Alert triager v1 → v2 (test first)');
    expect(host.textContent).toContain('Alert triager v2 is available (production runs v1)');
    expect((button(/^Publish v9/) as HTMLButtonElement).disabled).toBe(true);
    await click(/^Test$/);
    expect(posts.find((p) => p.url.endsWith('/test-update'))?.body).toEqual({ agents: ['a1'] });
    expect(host.textContent).toContain('The test passed');
    expect(host.textContent).toContain('workflow v8 · Alert triager v2');
    expect((button(/^Publish v9/) as HTMLButtonElement).disabled).toBe(false);
    expect(posts.some((p) => p.url.endsWith('/publish'))).toBe(false);
    await click(/^Publish v9/);
    expect(posts.find((p) => p.url.endsWith('/publish'))?.body).toEqual({ update: { agents: ['a1'] }, testedExecutionId: 'ex1' });
    expect(host.textContent).toContain('Published v9');
  });

  it('a failed test keeps Publish off and links to the run', async () => {
    testStatus = 'error';
    await mount(updateOffer);
    await click(/^Test$/);
    expect(host.textContent).toContain('The test failed');
    expect((button(/^Publish v9/) as HTMLButtonElement).disabled).toBe(true);
    expect(host.querySelector('a[href="/workflows/wf1/runs/ex1"]')).toBeTruthy();
  });
});

describe('the draft card', () => {
  it('shows the block and Publish <agent> first, which sends publish-first; nothing publishes before the click', async () => {
    await mount(draftOffer);
    expect(host.textContent).toContain('Publish v7: runs Alert triager v1');
    expect(host.textContent).toContain('Alert triager v1 is published; the draft changed: Instructions');
    expect(button(/^Publish$/)).toBeUndefined();
    expect(posts).toEqual([]);
    expect(button(/Publish with Alert triager v1 as published/)).toBeTruthy();
    await click(/Publish Alert triager first/);
    expect(posts.find((p) => p.url.endsWith('/publish'))?.body).toEqual({ agents: 'publish-first' });
  });

  it('the long button texts wrap inside the card (at any width) instead of running past its edge', async () => {
    await mount({ ...draftOffer, blocks: [{ agentId: 'a1', name: 'Alert triager with a very long name for the card', published: 1, changes: ['Instructions'] }] });
    for (const label of [/as published$/, /first$/]) {
      const classes = (button(label)?.className ?? '').split(/\s+/);
      expect(classes, String(label)).toContain('whitespace-normal');
      expect(classes, String(label)).toContain('max-w-full');
      expect(classes, String(label)).not.toContain('whitespace-nowrap');
    }
  });

  it('without a block the card has Publish', async () => {
    await mount({ ...draftOffer, blocks: undefined });
    await click(/^Publish$/);
    expect(posts.find((p) => p.url.endsWith('/publish'))?.body).toEqual({});
  });
});
