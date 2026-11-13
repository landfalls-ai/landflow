/**
 * Editor undo / redo for the workflow's name, tags and settings (components/editor/store.ts): one step per rename
 * (typing coalesces until the title's blur or Enter calls commitName()), per tag added or removed and per Save of the
 * settings dialog, in the same history as canvas edits. Undo and redo restore them and set `dirty` against the last
 * save, and a new change clears what could be redone. Canvas groups in that history are covered in groups.test.ts.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Workflow } from '@landflow/engine';

// The store takes two constants from the sticky-note component (TSX, which the test runner doesn't compile).
vi.mock('@/components/canvas/sticky-note', () => ({ STICKY_DEFAULT_CONTENT: '## Note', STICKY_DEFAULT_SIZE: { width: 260, height: 180 } }));

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-editor-history-'));
Object.assign(process.env, { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' });

const { useEditor } = await import('@/components/editor/store');

const node = (id: string, name: string, x: number) => ({ id, name, type: 'core.set', typeVersion: 1, position: [x, 0] as [number, number], parameters: { value: 1 } });
const workflow = (): Workflow => ({
  id: 'wf_history',
  name: 'Orders',
  tags: ['sales'],
  settings: { timezone: 'UTC' },
  nodes: [node('a', 'A', 0), node('b', 'B', 300)],
  connections: [{ id: 'e1', type: 'main', source: 'a', sourceIndex: 0, target: 'b', targetIndex: 0 }],
});

const editor = () => useEditor.getState();
/** Type into the title a key at a time, then leave it (blur or Enter). */
function rename(to: string) {
  for (let i = 1; i <= to.length; i++) editor().setMeta({ name: to.slice(0, i) });
  editor().commitName();
}
const steps = () => editor().history;
const meta = () => ({ name: editor().name, tags: editor().tags, settings: editor().settings });

describe('undo / redo of the name, tags and settings', () => {
  beforeEach(() => editor().load(workflow(), []));

  it('makes one step per rename, committed on blur or Enter', () => {
    rename('Orders v2');
    expect(editor().name).toBe('Orders v2');
    expect(steps()).toEqual({ past: 1, future: 0 });
    expect(editor().dirty).toBe(true);
    // A second rename is a second step; leaving the field again without typing adds none.
    rename('Invoices');
    editor().commitName();
    expect(steps()).toEqual({ past: 2, future: 0 });

    editor().undo();
    expect(editor().name).toBe('Orders v2');
    editor().undo();
    expect(editor().name).toBe('Orders');
    // Back at the loaded (saved) workflow: nothing to save.
    expect(editor().dirty).toBe(false);
    expect(steps()).toEqual({ past: 0, future: 2 });
    editor().redo();
    editor().redo();
    expect(editor().name).toBe('Invoices');
    expect(editor().dirty).toBe(true);
    expect(steps()).toEqual({ past: 2, future: 0 });
  });

  it('leaves no step for a name typed back to what it was', () => {
    editor().setMeta({ name: 'Orders!' });
    editor().setMeta({ name: 'Orders' });
    editor().commitName();
    expect(steps()).toEqual({ past: 0, future: 0 });
    expect(editor().dirty).toBe(false);
  });

  it('makes one step per tag added or removed', () => {
    editor().setMeta({ tags: ['sales', 'eu'] });
    editor().setMeta({ tags: ['sales', 'eu', 'daily'] });
    editor().setMeta({ tags: ['eu', 'daily'] });
    expect(steps().past).toBe(3);
    editor().undo();
    expect(editor().tags).toEqual(['sales', 'eu', 'daily']);
    editor().undo();
    expect(editor().tags).toEqual(['sales', 'eu']);
    editor().undo();
    expect(editor().tags).toEqual(['sales']);
    expect(editor().dirty).toBe(false);
    editor().redo();
    expect(editor().tags).toEqual(['sales', 'eu']);
    expect(editor().dirty).toBe(true);
  });

  it('makes one step per Save of the settings dialog, none when nothing changed', () => {
    editor().setSettings({ timezone: 'Europe/Berlin', timeoutSeconds: 60 });
    editor().setSettings({ timezone: 'Europe/Berlin', timeoutSeconds: 60 });
    expect(steps().past).toBe(1);
    editor().setSettings({ timezone: 'Europe/Berlin' });
    expect(steps().past).toBe(2);
    editor().undo();
    expect(editor().settings).toEqual({ timezone: 'Europe/Berlin', timeoutSeconds: 60 });
    editor().undo();
    expect(editor().settings).toEqual({ timezone: 'UTC' });
    expect(editor().toWorkflow().settings).toEqual({ timezone: 'UTC' });
    editor().redo();
    expect(editor().toWorkflow().settings).toEqual({ timezone: 'Europe/Berlin', timeoutSeconds: 60 });
  });

  it('shares one history with canvas edits, each step restoring only what it changed', () => {
    rename('Orders v2');
    editor().updateNode('a', { parameters: { value: 2 } });
    editor().setMeta({ tags: ['sales', 'eu'] });
    const sticky = editor().addSticky({ x: 0, y: 300 });
    editor().setSettings({ timezone: 'Asia/Tokyo' });
    editor().removeNodes(['b']);
    expect(steps().past).toBe(6);

    const param = () => editor().nodes.find((n) => n.id === 'a')!.data.wf.parameters.value;
    editor().undo(); // node removal
    expect(editor().nodes.map((n) => n.id)).toEqual(['a', 'b']);
    expect(meta()).toEqual({ name: 'Orders v2', tags: ['sales', 'eu'], settings: { timezone: 'Asia/Tokyo' } });
    editor().undo(); // settings
    expect(editor().settings).toEqual({ timezone: 'UTC' });
    expect(editor().stickies.map((s) => s.id)).toEqual([sticky]);
    editor().undo(); // sticky note
    expect(editor().stickies).toEqual([]);
    expect(editor().tags).toEqual(['sales', 'eu']);
    editor().undo(); // tag
    expect(editor().tags).toEqual(['sales']);
    expect(param()).toBe(2);
    editor().undo(); // parameter
    expect(param()).toBe(1);
    expect(editor().name).toBe('Orders v2');
    editor().undo(); // rename
    expect(meta()).toEqual({ name: 'Orders', tags: ['sales'], settings: { timezone: 'UTC' } });
    expect(editor().dirty).toBe(false);

    for (let i = 0; i < 6; i++) editor().redo();
    expect(meta()).toEqual({ name: 'Orders v2', tags: ['sales', 'eu'], settings: { timezone: 'Asia/Tokyo' } });
    expect(editor().nodes.map((n) => n.id)).toEqual(['a']);
    expect(param()).toBe(2);
    expect(editor().toWorkflow()).toMatchObject({ name: 'Orders v2', tags: ['sales', 'eu'], settings: { timezone: 'Asia/Tokyo' } });
  });

  it('compares with the last save, not the load, to set dirty', () => {
    rename('Orders v2');
    editor().markSaved(); // the save went through
    expect(editor().dirty).toBe(false);
    editor().undo();
    expect(editor().name).toBe('Orders');
    expect(editor().dirty).toBe(true);
    editor().redo();
    expect(editor().dirty).toBe(false);
    // A canvas step undone back to the saved state is "Saved" too, a tag step undone past it is not.
    editor().setMeta({ tags: [] });
    editor().updateNode('a', { parameters: { value: 3 } });
    editor().undo();
    expect(editor().dirty).toBe(true);
    editor().undo();
    expect(editor().dirty).toBe(false);
    editor().undo();
    expect(editor().name).toBe('Orders');
    expect(editor().dirty).toBe(true);
  });

  it('clears what could be redone on a new change: rename, tag, settings or canvas', () => {
    const undone = () => {
      editor().undo();
      expect(steps().future).toBe(1);
    };
    rename('One');
    undone();
    editor().setMeta({ tags: ['sales', 'new'] });
    expect(steps()).toEqual({ past: 1, future: 0 });
    editor().redo();
    expect(editor().name).toBe('Orders');
    expect(editor().tags).toEqual(['sales', 'new']);

    undone();
    editor().setMeta({ name: 'T' }); // the first key of a rename already counts
    expect(steps().future).toBe(0);
    editor().commitName();

    undone();
    editor().setSettings({ timezone: 'Europe/Paris' });
    expect(steps().future).toBe(0);
    editor().redo();
    expect(editor().name).toBe('Orders');

    undone();
    editor().updateNode('a', { parameters: { value: 9 } });
    expect(steps().future).toBe(0);
    editor().redo();
    expect(editor().settings).toEqual({ timezone: 'UTC' });
  });

  it('tells a publish-driven version bump from someone else\u2019s edit (the save retries only for the first)', () => {
    editor().markSaved('v1');
    expect(editor().storedMatchesSaved({ ...workflow(), active: true, updatedAt: 'v2' })).toBe(true);
    editor().rebase('v2');
    expect(editor().baseUpdatedAt).toBe('v2');
    expect(editor().storedMatchesSaved({ ...workflow(), name: 'Renamed elsewhere', updatedAt: 'v3' })).toBe(false);
  });
});
