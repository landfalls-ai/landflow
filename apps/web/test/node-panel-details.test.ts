/**
 * The node panel's details: one Run step in the header, three settings before More, view switches only with data,
 * three workflow settings before Advanced, and a four-button node toolbar that the right-click menu matches.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { NodeHeaderActions } from '../src/components/editor/node-panel';
import { NodeSettingsPane } from '../src/components/editor/node-settings';
import { showViewSwitch } from '../src/components/run/data-view';
import { BasicWorkflowSettings } from '../src/components/editor/settings-dialog';
import { nodeActions } from '../src/components/editor/flow-node';
import { useEditor, type FlowNode } from '../src/components/editor/store';

const noop = () => {};
const header = (over: Partial<Parameters<typeof NodeHeaderActions>[0]> = {}) =>
  renderToStaticMarkup(createElement(NodeHeaderActions, { docsUrl: 'https://docs.test', isSubnode: false, running: false, onRun: noop, onClose: noop, ...over }));

describe('node panel header', () => {
  it('has Docs, one Run step and Close, with no Breakpoint or Run from here', () => {
    const html = header();
    expect(html.match(/Run step/g)).toHaveLength(1);
    expect(html).toContain('Docs');
    expect(html).toContain('aria-label="Close"');
    expect(html).not.toMatch(/Breakpoint|Run from here/);
  });
  it('has no Run step for a sub-node', () => {
    expect(header({ isSubnode: true })).not.toContain('Run step');
  });
});

describe('node settings', () => {
  const wf = { id: 'n1', name: 'A', type: 'x.step', parameters: {} };
  const pane = (more: boolean, isTrigger = false, isSubnode = false) =>
    renderToStaticMarkup(
      createElement(NodeSettingsPane, { wf, update: noop, isTrigger, isSubnode, breakpoint: false, running: false, more, onToggleMore: noop, onToggleBreakpoint: noop, onRunFrom: noop }),
    );
  it('shows On error, Retry on fail and Notes, and nothing else before More', () => {
    const html = pane(false, true);
    for (const name of ['On error', 'Retry on fail', 'Notes']) expect(html).toContain(name);
    for (const name of ['Disabled', 'Timeout', 'Rate limit', 'Debounce', 'Batch', 'Always output data', 'Execute once']) expect(html).not.toContain(name);
    expect(html).toContain('aria-expanded="false"');
  });
  it('puts the rest under More, with Timeout after it and trigger buffering only for triggers', () => {
    const html = pane(true);
    for (const name of ['Disabled', 'Timeout', 'Rate limit', 'Always output data', 'Execute once']) expect(html.indexOf(name)).toBeGreaterThan(html.indexOf('More'));
    expect(html).not.toContain('Debounce');
    expect(pane(true, true)).toContain('Debounce');
  });
  it('leads with Breakpoint and Run from here, except for a sub-node', () => {
    expect(pane(false)).toMatch(/Breakpoint[\s\S]*Run from here/);
    expect(pane(false, false, true)).not.toMatch(/Breakpoint|Run from here/);
  });
});

describe('data views', () => {
  it('shows the view switch only when there is data', () => {
    expect(showViewSwitch(undefined)).toBe(false);
    expect(showViewSwitch([])).toBe(false);
    expect(showViewSwitch([{ json: { a: 1 } }])).toBe(true);
  });
});

describe('workflow settings', () => {
  it('has exactly three fields before the Advanced button', () => {
    const html = renderToStaticMarkup(createElement(BasicWorkflowSettings, { draft: {}, patch: noop, showAdvanced: false, onToggleAdvanced: noop }));
    const advanced = html.indexOf('Advanced');
    expect(advanced).toBeGreaterThan(0);
    const before = html.slice(0, advanced);
    expect(before.match(/<(select|input|textarea)\b/g)).toHaveLength(2);
    for (const label of ['Error workflow', 'Notify on failure', 'Time zone']) expect(before).toContain(label);
    for (const label of ['Timeout', 'Concurrency', 'Retries', 'Governance']) expect(before).not.toContain(label);
    expect(html).toContain('aria-expanded="false"');
  });
});

describe('node toolbar and right-click menu', () => {
  const put = (type: string, id = 'n1') => {
    const node = { id, type: 'flow', position: { x: 0, y: 0 }, data: { wf: { id, name: 'A', type, parameters: {}, position: [0, 0] } } } as unknown as FlowNode;
    useEditor.setState({ nodes: [node], edges: [], nodeTypes: {}, breakpoints: [], running: false });
  };
  it('has Run, Disable, Delete and a ⋯ that holds the other actions', () => {
    put('x.step');
    const actions = nodeActions('n1')!;
    expect(actions.main.map((a) => a.id)).toEqual(['run', 'disable', 'delete']);
    expect(actions.more.map((a) => a.id)).toEqual(['open', 'runFrom', 'breakpoint', 'duplicate']);
  });
  it('names Enable for a disabled node and Remove breakpoint for one with a breakpoint', () => {
    put('x.step');
    useEditor.setState((s) => ({ breakpoints: ['n1'], nodes: s.nodes.map((n) => ({ ...n, data: { ...n.data, wf: { ...n.data.wf, disabled: true } } })) }));
    const actions = nodeActions('n1')!;
    expect(actions.main[1]!.label).toBe('Enable');
    expect(actions.more.find((a) => a.id === 'breakpoint')!.label).toBe('Remove breakpoint');
  });
  it('knows no node that is not there', () => {
    put('x.step');
    expect(nodeActions('missing')).toBeUndefined();
  });
});
