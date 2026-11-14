/**
 * The node panel's details: one Run step in the header, three settings before More, view switches only with data,
 * three workflow settings before Advanced, and a four-button node toolbar that the right-click menu matches.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { moreSettings, RunStepButton, visibleSettings } from '../src/components/editor/node-panel';
import { showViewSwitch } from '../src/components/run/data-view';
import { BASIC_SETTINGS } from '../src/components/editor/settings-dialog';
import { nodeActions } from '../src/components/editor/flow-node';
import { useEditor, type FlowNode } from '../src/components/editor/store';

describe('node panel header', () => {
  it('has one Run step and no Breakpoint or Run from here', () => {
    const html = renderToStaticMarkup(createElement(RunStepButton, { running: false, onRun: () => {} }));
    expect(html.match(/Run step/g)).toHaveLength(1);
    expect(html).not.toMatch(/Breakpoint|Run from here/);
  });
});

describe('node settings', () => {
  it('shows three settings and puts the rest under More', () => {
    expect(visibleSettings()).toEqual(['On error', 'Retry on fail', 'Notes']);
    expect(moreSettings(false)).toEqual(['Disabled', 'Timeout', 'Rate limit', 'Always output data', 'Execute once']);
    expect(moreSettings(true)).toContain('Debounce');
    for (const name of visibleSettings()) expect(moreSettings(true)).not.toContain(name);
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
  it('has exactly three fields before Advanced', () => {
    expect(BASIC_SETTINGS).toEqual(['Error workflow', 'Notify on failure', 'Time zone']);
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
