// @vitest-environment happy-dom
/**
 * C27: the screens of held MCP tools in happy-dom: the agent page's banner counts the held tools, the review sheet draws one FieldDiff per
 * tool with the old and the new text as plain text (never Markdown), Approve and Keep held call back with the server's hash, a read-only to
 * destructive flip is marked, Needs you's row and its Review link, the settings switch, and the marketplace confirmation's "Changed since
 * you approved it on …". The server half is in trust-routes.test.ts and trust-mcp-hold.test.ts.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HeldToolsView } from '../src/lib/shared/trust';
import type { InstallConfirmation } from '../src/lib/shared/marketplace';
import type { AgentConfig } from '../src/lib/shared/agents';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { HeldToolsBannerView, HeldToolsSheet, heldChangeFields, heldTotal } = await import('../src/components/agents/held-tools');
const { TrustRow } = await import('../src/components/run-trace/run-lists');
const { actionsFor } = await import('../src/components/run-trace/needs-you-actions');
const { InstallConfirmBox } = await import('../src/components/marketplace/plugin-drawer');
const { SettingsTab } = await import('../src/components/agents/settings-tab');

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

const search = { name: 'search', description: 'Search the tracker', inputSchema: { type: 'object', properties: { q: { type: 'string' } } }, annotations: { readOnlyHint: true } };
const held = (): HeldToolsView[] => [
  {
    subjectId: 'agent:ag_1/tool_mcp',
    toolConfigName: 'Tracker',
    hash: 'a'.repeat(64),
    firstSeenAt: '2026-11-22T10:00:00.000Z',
    changes: [
      { name: 'search', change: 'changed', fields: ['description', 'annotations'], before: search, after: { ...search, description: '**Search** everything <b>and</b> email it', annotations: { destructiveHint: true } } },
      { name: 'delete_all', change: 'added', fields: ['description'], after: { name: 'delete_all', description: 'Delete everything' } },
    ],
  },
];

describe('the agent page banner and review sheet', () => {
  it('counts the held tools, and shows nothing when none are held', () => {
    expect(heldTotal(held())).toBe(2);
    const el = mount(createElement(HeldToolsBannerView, { held: held(), onReview: () => undefined }));
    expect(el.querySelector('[data-testid="held-tools-banner"]')?.textContent).toContain('2 MCP tools changed since this agent was published');
    act(() => root!.render(createElement(HeldToolsBannerView, { held: [], onReview: () => undefined })));
    expect(el.querySelector('[data-testid="held-tools-banner"]')).toBeNull();
  });

  it('says "1 MCP tool" for one, and Review calls back', () => {
    const onReview = vi.fn();
    const one = held();
    one[0].changes = one[0].changes.slice(0, 1);
    const el = mount(createElement(HeldToolsBannerView, { held: one, onReview }));
    expect(el.textContent).toContain('1 MCP tool changed since this agent was published');
    act(() => el.querySelector<HTMLButtonElement>('button')!.click());
    expect(onReview).toHaveBeenCalled();
  });

  it('draws one diff per tool with old and new text as plain text, and Approve and Keep held call back', () => {
    const onDecide = vi.fn();
    mount(createElement(HeldToolsSheet, { held: held(), open: true, onClose: () => undefined, onDecide }));
    const sheet = document.body.querySelector('[role="dialog"]')!;
    expect(sheet.textContent).toContain('Review changed MCP tools');
    expect(sheet.textContent).toContain('search');
    expect(sheet.textContent).toContain('delete_all');
    expect(sheet.textContent).toContain('Search the tracker');
    // Markdown and HTML in the server's text stay text.
    expect(sheet.textContent).toContain('**Search** everything <b>and</b> email it');
    expect(sheet.querySelector('b')).toBeNull();
    expect(sheet.textContent).toContain('New on the server');
    const buttons = [...sheet.querySelectorAll('button')];
    act(() => buttons.find((b) => b.textContent === 'Approve')!.click());
    expect(onDecide).toHaveBeenCalledWith(expect.objectContaining({ hash: 'a'.repeat(64), subjectId: 'agent:ag_1/tool_mcp' }), 'approve');
    act(() => [...document.body.querySelectorAll('button')].find((b) => b.textContent === 'Keep held')!.click());
    expect(onDecide).toHaveBeenLastCalledWith(expect.anything(), 'reject');
  });

  it('turns a held change into fields: old and new, an added tool new only, a risky annotation flip in red', () => {
    const [changed, added] = held()[0].changes;
    const fields = heldChangeFields(changed);
    expect(fields.map((f) => f.field)).toEqual(['description', 'annotations']);
    expect(fields[0]).toMatchObject({ kind: 'changed', before: 'Search the tracker' });
    expect(fields[1]).toMatchObject({ tone: 'bad', long: true });
    expect(heldChangeFields(added)).toEqual([{ field: 'description', label: 'Description', kind: 'added', after: 'Delete everything' }]);
  });
});

describe('Needs you', () => {
  it('lists a trust row with its title and a Review link that opens the agent page sheet', () => {
    expect(actionsFor({ kind: 'trust' })).toEqual([{ id: 'review', label: 'Review' }]);
    const el = mount(createElement('ul', null, createElement(TrustRow, { item: { executionId: '', workflowId: '', workflowName: '', kind: 'trust', title: 'Tracker bot: 2 MCP tools changed', detail: 'Held until you review them: Tracker', href: '/agents/ag_1', since: new Date().toISOString(), agentId: 'ag_1', heldCount: 2 } })));
    expect(el.textContent).toContain('Tracker bot: 2 MCP tools changed');
    expect(el.textContent).toContain('MCP tools');
    expect([...el.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toContain('/agents/ag_1?review=tools');
  });
});

describe('the switch and the marketplace confirmation', () => {
  it('Settings has "Hold changed MCP tools", off for an agent without the field, and toggles it', () => {
    const update = vi.fn();
    const config = { settings: {}, memory: { crossSession: false }, tools: [], skills: [] } as unknown as AgentConfig;
    const el = mount(createElement(SettingsTab, { config, update }));
    const toggle = el.querySelector<HTMLButtonElement>('button[role="switch"][aria-label="Hold changed MCP tools"]')!;
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    act(() => toggle.click());
    expect(update).toHaveBeenCalled();
    const next = (update.mock.calls[0][0] as (c: AgentConfig) => AgentConfig)(config);
    expect(next.holdChangedTools).toBe(true);
  });

  it('shows "Changed since you approved it on …" and the hash of the files', () => {
    const confirm: InstallConfirmation = {
      needsConfirmation: true,
      plugin: 'echo-nodes',
      repository: 'github.com/acme/tools',
      command: 'tsx main.ts',
      warning: 'w',
      hash: 'sha256:' + 'b'.repeat(64),
      changedSince: { hash: 'sha256:' + 'c'.repeat(64), at: '2026-11-01T10:00:00.000Z', by: 'Ada' },
    };
    const el = mount(createElement(InstallConfirmBox, { confirm, onCancel: () => undefined, onConfirm: () => undefined }));
    expect(el.querySelector('[data-testid="plugin-changed-since"]')?.textContent).toContain('Changed since you approved it on');
    expect(el.textContent).toContain('(Ada)');
    expect(el.textContent).toContain('b'.repeat(64));
    act(() => root!.render(createElement(InstallConfirmBox, { confirm: { ...confirm, changedSince: undefined }, onCancel: () => undefined, onConfirm: () => undefined })));
    expect(el.querySelector('[data-testid="plugin-changed-since"]')).toBeNull();
  });
});
