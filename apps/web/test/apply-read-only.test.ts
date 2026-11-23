/**
 * Wave ag4 carryover (the integrator's live pass, asks.md F3): with the workflow open in a second tab, Spotlight's Apply on
 * the read-only one showed "Applied" while the canvas got no filter step (the store's editing actions do nothing there).
 * applyChanges now refuses on a read-only canvas, so no proposal is marked applied.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), warning: vi.fn(), success: vi.fn(), message: vi.fn() }) }));
const { applyChanges } = await import('@/components/editor/assistant');
const { useEditLock } = await import('@/components/editor/edit-lock');
const { useEditor } = await import('@/components/editor/store');
const { toast } = await import('sonner');

afterEach(() => useEditLock.setState({ readOnly: false }));

describe('Apply on a read-only canvas', () => {
  it('refuses and says why; nothing is applied', () => {
    useEditor.getState().load({ id: 'wf_ro', name: 'RO', nodes: [{ id: 'a', name: 'Start', type: 'core.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} }], connections: [] } as never, []);
    useEditLock.setState({ readOnly: true });
    const onApplied = vi.fn();
    expect(applyChanges([{ ops: [{ op: 'setParameters', node: 'Start', parameters: { x: 1 } }] as never, kind: 'proposal' }], 'Change', { onApplied })).toBe(false);
    expect(onApplied).not.toHaveBeenCalled();
    expect(vi.mocked(toast.error).mock.calls[0]?.[1]).toMatchObject({ description: expect.stringContaining('read-only here') });
  });
});
