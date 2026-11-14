/**
 * The editor's chrome (components/editor/chrome.ts): the one right column, autosave, the minimap, the top bar and the ⋯
 * menu, and the Publish button's two states.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AUTOSAVE_MS, chatColumnAfter, chatModelOf, menuItems, MINIMAP_ABOVE, publishLabel, shouldAutosave, showColumnSwitch, showMinimap, topBarControls, visibleColumn, type ChatColumn, type ColumnAction } from '../src/components/editor/chrome';
import { PublishButton } from '../src/components/editor/publish-control';

describe('the right column', () => {
  it('opening the chat selects chat, ⌘I selects Spotlight', () => {
    expect(chatColumnAfter(null, 'open-chat')).toBe('chat');
    expect(chatColumnAfter('spotlight', 'open-chat')).toBe('chat');
    expect(chatColumnAfter('chat', 'show-spotlight')).toBe('spotlight');
    expect(chatColumnAfter(null, 'show-spotlight')).toBe('spotlight');
  });

  it('is one value, so it never holds both', () => {
    const actions: ColumnAction[] = ['open-chat', 'close-chat', 'toggle-chat', 'show-spotlight', 'show-chat'];
    for (const start of ['spotlight', 'chat', null] as ChatColumn[]) {
      for (const action of actions) expect([null, 'spotlight', 'chat']).toContain(chatColumnAfter(start, action));
    }
  });

  it('closing the chat or toggling it off returns to Spotlight; closing leaves Spotlight alone', () => {
    expect(chatColumnAfter('chat', 'close-chat')).toBe('spotlight');
    expect(chatColumnAfter('chat', 'toggle-chat')).toBe('spotlight');
    expect(chatColumnAfter('spotlight', 'toggle-chat')).toBe('chat');
    expect(chatColumnAfter(null, 'close-chat')).toBeNull();
  });

  it('shows the chat only while the workflow has a chat trigger', () => {
    expect(visibleColumn('chat', true)).toBe('chat');
    expect(visibleColumn('chat', false)).toBe('spotlight');
    expect(visibleColumn(null, false)).toBeNull();
  });

  it('shows the Spotlight | Chat strip only with a chat trigger and an open column', () => {
    expect(showColumnSwitch({ hasChat: true, column: null, spotlightFolded: false })).toBe(true);
    expect(showColumnSwitch({ hasChat: true, column: 'chat', spotlightFolded: true })).toBe(true);
    expect(showColumnSwitch({ hasChat: true, column: null, spotlightFolded: true })).toBe(false);
    expect(showColumnSwitch({ hasChat: false, column: 'spotlight', spotlightFolded: false })).toBe(false);
  });
});

describe('autosave', () => {
  const ok = { dirty: true, readOnly: false, governed: false, locked: true };
  it('saves an edited draft this tab can edit', () => expect(shouldAutosave(ok)).toBe(true));
  it('waits for an edit', () => expect(shouldAutosave({ ...ok, dirty: false })).toBe(false));
  it('does not save a read-only workflow, a governed save, or a tab without the edit lock', () => {
    expect(shouldAutosave({ ...ok, readOnly: true })).toBe(false);
    expect(shouldAutosave({ ...ok, governed: true })).toBe(false);
    expect(shouldAutosave({ ...ok, locked: false })).toBe(false);
  });
  it('waits two seconds after the last edit', () => expect(AUTOSAVE_MS).toBe(2000));
});

describe('the minimap', () => {
  it('shows above 25 nodes only', () => {
    expect(showMinimap(6)).toBe(false);
    expect(showMinimap(MINIMAP_ABOVE)).toBe(false);
    expect(showMinimap(MINIMAP_ABOVE + 1)).toBe(true);
    expect(showMinimap(30)).toBe(true);
  });
});

describe('the top bar', () => {
  it('holds seven controls for a draft and for a live workflow (the state is in the Publish button)', () => {
    const draft = topBarControls({ governed: false });
    expect(draft).toEqual(['back', 'name', 'save-state', 'spotlight', 'run', 'publish', 'more']);
    expect(draft).toHaveLength(7);
  });
  it('adds Save only where autosave is off', () => {
    const governed = topBarControls({ governed: true });
    expect(governed).toContain('save');
    expect(governed.indexOf('save')).toBe(governed.indexOf('save-state') + 1);
    expect(governed).toHaveLength(8);
  });
  it('has no tags or history controls: they are in ⋯', () => {
    for (const control of topBarControls({ governed: true })) expect(['tags', 'version-history', 'git-history']).not.toContain(control);
  });
});

describe('the ⋯ menu', () => {
  it('holds Tags, Version history and one Import, and no Git history without source control', () => {
    const items = menuItems({ sourceControl: false, saved: true });
    expect(items).toEqual(expect.arrayContaining(['tags', 'version-history', 'import']));
    expect(items.filter((i) => i === 'import')).toHaveLength(1);
    expect(items).not.toContain('git-history');
  });
  it('adds Git history with source control configured', () => {
    expect(menuItems({ sourceControl: true, saved: true })).toContain('git-history');
  });
  it('leaves Share and Move out for a workflow that is not saved yet', () => {
    const items = menuItems({ sourceControl: false, saved: false });
    expect(items).not.toContain('share');
    expect(items).not.toContain('move');
  });
});

describe('the chat model chip', () => {
  const nodes = [
    { id: 'agent', type: 'core.aiAgent', parameters: {} },
    { id: 'm1', type: 'core.ollamaChatModel', parameters: { model: 'qwen3-coder:30b' } },
    { id: 'm2', type: 'core.anthropicChatModel', parameters: { model: 'claude-example' } },
  ];
  const wire = (...sources: string[]) => sources.map((source) => ({ source, connectionType: 'ai_languageModel' }));
  it('names the model when exactly one is wired', () => {
    expect(chatModelOf(nodes, wire('m1'))).toEqual({ model: 'qwen3-coder:30b', local: true });
    expect(chatModelOf(nodes, wire('m2'))).toEqual({ model: 'claude-example', local: false });
  });
  it('names none for two models, none, or a model set by an expression', () => {
    expect(chatModelOf(nodes, wire('m1', 'm2'))).toBeUndefined();
    expect(chatModelOf(nodes, [])).toBeUndefined();
    expect(chatModelOf([{ id: 'm', type: 'core.ollamaChatModel', parameters: { model: '{{ $json.model }}' } }], wire('m'))).toBeUndefined();
  });
});

describe('the Publish button', () => {
  const render = (props: Partial<Parameters<typeof PublishButton>[0]>) => renderToStaticMarkup(createElement(PublishButton, { published: false, changes: false, ...props }));
  it('says Publish for a draft', () => {
    const html = render({ published: false });
    expect(html).toContain('Publish');
    expect(html).not.toContain('Live');
    expect(publishLabel({ published: false })).toBe('Publish');
  });
  it('says Live v3 once version 3 is live', () => {
    const html = render({ published: true, versionNumber: 3 });
    expect(html).toContain('Live v3');
    expect(html).not.toContain('>Publish<');
    expect(html).toContain('bg-gn');
  });
  it('marks unpublished changes on a live workflow for everyone, including a screen reader', () => {
    const html = render({ published: true, versionNumber: 3, changes: true });
    expect(html).toContain('Live v3');
    expect(html).toContain('bg-warn');
    expect(html).toContain('with unpublished changes');
  });
  it('says Live without a version number when none is known', () => expect(publishLabel({ published: true })).toBe('Live'));
});
