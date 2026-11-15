import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { listenAskAbout, takeAskAbout, ASK_ABOUT_EVENT } from '../src/components/spotlight/ask-about-listener';
import {
  editorWorkflowId,
  getSpotlightState,
  keyAction,
  modeForRoute,
  parseAskAbout,
  resetSpotlightState,
  setBrainFile,
  shellPanelShows,
  spotlightMode,
  toggleResult,
  withAbout,
  withOpen,
  INITIAL_STATE,
} from '../src/components/spotlight/context';
import { chipLabel, ModeChip } from '../src/components/spotlight/mode-chip';
import { SHEET_HEIGHTS, switchFor } from '../src/components/spotlight/shell-spotlight';

const key = (k: string, extra: Partial<{ metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }> = {}) => ({ key: k, metaKey: true, ctrlKey: false, shiftKey: false, altKey: false, ...extra });
const detail = { ref: { type: 'run', id: 'ex-12', name: 'run #12', workflowId: 'wf-1' }, starters: ['Why did it fail?', 'What changed?'] };

beforeEach(() => resetSpotlightState());

describe('modeForRoute', () => {
  it('builds on the editor, asks the brain elsewhere', () => {
    expect(modeForRoute('/workflows/wf-1', { workflowName: 'Ticket router' })).toEqual({ kind: 'build', workflowId: 'wf-1', name: 'Ticket router' });
    expect(modeForRoute('/workflows/wf-1').kind).toBe('build');
    for (const path of ['/', '/runs', '/workflows', '/workflows/wf-1/runs', '/workflows/new', '/brain', '/agents/a-1']) expect(modeForRoute(path).kind).toBe('brain');
  });
  it('names the open brain page on /brain only', () => {
    const file = { ref: 'customer/acme', name: 'Acme', page: true };
    expect(modeForRoute('/brain/customer/acme', { brainFile: file })).toEqual({ kind: 'brain', pageId: 'customer/acme', name: 'Acme' });
    expect(modeForRoute('/runs', { brainFile: file })).toEqual({ kind: 'brain' });
    expect(modeForRoute('/brain', { brainFile: { ref: 'index', name: 'index.md', page: false } })).toEqual({ kind: 'brain' });
  });
  it('finds the editor id', () => {
    expect(editorWorkflowId('/workflows/wf-1')).toBe('wf-1');
    expect(editorWorkflowId('/workflows/wf-1/runs')).toBeUndefined();
  });
});

describe('the ask-about event', () => {
  it('parses what is shaped like a detail and nothing else', () => {
    expect(parseAskAbout(detail)).toEqual(detail);
    expect(parseAskAbout({ ref: { type: 'run' }, starters: [] })).toBeUndefined();
    expect(parseAskAbout(null)).toBeUndefined();
    expect(parseAskAbout({ ref: detail.ref, starters: ['a', 3, ' '] })?.starters).toEqual(['a']);
  });
  it('switches the panel to about mode with the chip and the starters', () => {
    const target = new EventTarget();
    const stop = listenAskAbout(target, takeAskAbout);
    const event = new Event(ASK_ABOUT_EVENT) as Event & { detail?: unknown };
    event.detail = detail;
    target.dispatchEvent(event);
    const state = getSpotlightState();
    expect(state.open).toBe(true);
    expect(state.about?.starters).toEqual(detail.starters);
    expect(spotlightMode('/runs', state)).toEqual({ kind: 'about', ref: detail.ref });
    expect(chipLabel(spotlightMode('/runs', state))).toBe('About run #12');
    stop();
    const spy = vi.fn();
    listenAskAbout(target, spy)();
    target.dispatchEvent(event);
    expect(spy).not.toHaveBeenCalled();
  });
  it('ignores a malformed detail', () => {
    const target = new EventTarget();
    const spy = vi.fn();
    listenAskAbout(target, spy);
    const event = new Event(ASK_ABOUT_EVENT) as Event & { detail?: unknown };
    event.detail = { ref: 1 };
    target.dispatchEvent(event);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('keys', () => {
  it('opens on ⌘K and ⌘I, with Ctrl too', () => {
    expect(keyAction(key('k'), { brain: false })).toBe('toggle');
    expect(keyAction(key('K'), { brain: true })).toBe('toggle');
    expect(keyAction(key('i'), { brain: false })).toBe('toggle');
    expect(keyAction(key('k', { metaKey: false, ctrlKey: true }), { brain: false })).toBe('toggle');
    expect(keyAction(key('k', { metaKey: false }), { brain: false })).toBe('none');
    expect(keyAction(key('k', { shiftKey: true }), { brain: false })).toBe('none');
  });
  it('makes ⌘P QuickOpen on the brain page only', () => {
    expect(keyAction(key('p'), { brain: true })).toBe('quick');
    expect(keyAction(key('p'), { brain: false })).toBe('none');
  });
  it('opens, focuses, then closes from the box', () => {
    expect(toggleResult(false, false)).toBe('open');
    expect(toggleResult(true, false)).toBe('focus');
    expect(toggleResult(true, true)).toBe('close');
  });
});

describe('one panel', () => {
  it('is not the shell panel on the editor', () => {
    const open = withOpen(INITIAL_STATE, true);
    expect(shellPanelShows('/workflows/wf-1', open)).toBe(false);
    expect(shellPanelShows('/runs', open)).toBe(true);
    expect(shellPanelShows('/runs', INITIAL_STATE)).toBe(false);
  });
  it('shows on the editor only when the brain was asked for there', () => {
    expect(shellPanelShows('/workflows/wf-1', { ...INITIAL_STATE, open: true, askInstead: true })).toBe(true);
    expect(shellPanelShows('/workflows/wf-1', withAbout(INITIAL_STATE, detail))).toBe(true);
    expect(spotlightMode('/workflows/wf-1', { askInstead: true })).toEqual({ kind: 'brain' });
  });
  it('keeps the brain file in the store for the chip', () => {
    setBrainFile({ ref: 'customer/acme', name: 'Acme', page: true });
    expect(spotlightMode('/brain/customer/acme', getSpotlightState())).toEqual({ kind: 'brain', pageId: 'customer/acme', name: 'Acme' });
    setBrainFile(undefined);
    expect(getSpotlightState().brainFile).toBeUndefined();
  });
  it('has three phone heights', () => {
    expect(SHEET_HEIGHTS.map((h) => h.id)).toEqual(['peek', 'half', 'tall']);
  });
  it('offers the other mode where there is one', () => {
    expect(switchFor({ kind: 'brain' }, false)).toBeUndefined();
    expect(switchFor({ kind: 'brain' }, true)?.label).toBe('Build here instead');
    expect(switchFor({ kind: 'about', ref: detail.ref }, false)?.label).toBe('Ask the brain instead');
  });
});

describe('the mode chip', () => {
  const html = (mode: Parameters<typeof ModeChip>[0]['mode'], switchTo?: Parameters<typeof ModeChip>[0]['switchTo']) => renderToStaticMarkup(createElement(ModeChip, { mode, ...(switchTo && { switchTo }) }));
  it('says what Spotlight does for each mode', () => {
    expect(html({ kind: 'build', workflowId: 'wf-1', name: 'Ticket router' })).toContain('Building Ticket router');
    expect(html({ kind: 'brain' })).toContain('Asking the brain');
    expect(html({ kind: 'about', ref: detail.ref })).toContain('About run #12');
  });
  it('is a button only when it offers the other mode', () => {
    expect(html({ kind: 'brain' })).not.toContain('<button');
    const withSwitch = html({ kind: 'build', workflowId: 'wf-1', name: 'Ticket router' }, { label: 'Ask the brain instead', run: () => undefined });
    expect(withSwitch).toContain('<button');
    expect(withSwitch).toContain('aria-haspopup="menu"');
  });
});
