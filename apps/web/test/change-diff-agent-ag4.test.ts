// @vitest-environment happy-dom
/** Live re-check (wave ag4): a changeAgent proposal's card says what it changes on the agent, never an empty "No step changes". */
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { ChangeDiff } = await import('@/components/editor/change-diff');

const flow = { id: 'w', name: 'W', nodes: [{ id: 'n1', name: 'Ask sales analyst', type: 'core.messageAgent', typeVersion: 1, position: [0, 0], parameters: { agentId: 'ag_q' } }], connections: [] };
describe('ChangeDiff with a changeAgent op', () => {
  it('names the agent change, not "No step changes"', async () => {
    const el = document.createElement('div');
    document.body.append(el);
    await act(async () => createRoot(el).render(createElement(ChangeDiff, { before: flow as never, ops: [{ op: 'changeAgent', node: 'Ask sales analyst', agentId: 'ag_q', change: 'give it the SQLite tool' }] as never })));
    expect(el.textContent).not.toContain('No step changes');
    expect(el.textContent).toContain('Changes the agent of “Ask sales analyst”: give it the SQLite tool');
  });
  it('a mixed proposal still shows its step changes', async () => {
    const el = document.createElement('div');
    document.body.append(el);
    await act(async () => createRoot(el).render(createElement(ChangeDiff, { before: flow as never, ops: [{ op: 'renameNode', node: 'Ask sales analyst', name: 'Ask' }, { op: 'changeAgent', node: 'Ask', change: 'x' }] as never })));
    expect(el.textContent).toMatch(/1 change/);
  });
});
