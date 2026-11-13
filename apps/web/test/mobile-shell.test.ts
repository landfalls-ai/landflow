/**
 * Landflow on a phone (docs/mobile.md#the-shell): which pages take the whole screen (no tab bar, a back arrow of their own).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fullScreen } from '@/components/shell/sidebar';

describe('full-screen pages on a phone', () => {
  it('are the editor and its tabs, an agent or team, and a run’s trace', () => {
    for (const path of ['/workflows/wf_1', '/workflows/wf_1/executions', '/workflows/wf_1/evaluations', '/agents/ag_1', '/agents/teams/t_1', '/runs/ex_1']) expect(fullScreen(path), path).toBe(true);
  });
  it('are not the lists, Home, or comparing runs', () => {
    for (const path of ['/', '/workflows', '/agents', '/executions', '/runs', '/runs/compare', '/credentials', '/settings']) expect(fullScreen(path), path).toBe(false);
  });
});

describe('the phone check outside React', () => {
  it('is false off a browser, so a desktop or the server never takes a tap as a phone’s', async () => {
    const { isPhone } = await import('@/lib/client/use-phone');
    expect(isPhone()).toBe(false);
  });
});

describe('Spotlight’s dock on a phone', () => {
  it('goes between the bar, peek and half, and unfolds to the height it had', async () => {
    const { useAssistant } = await import('@/components/editor/assistant');
    const { setDock } = useAssistant.getState();
    setDock('peek');
    expect(useAssistant.getState()).toMatchObject({ collapsed: false, phoneHeight: 'peek' });
    setDock('bar');
    expect(useAssistant.getState()).toMatchObject({ collapsed: true, phoneHeight: 'peek' });
    setDock('half');
    expect(useAssistant.getState()).toMatchObject({ collapsed: false, phoneHeight: 'half' });
  });
});

describe('“Are you sure?” before a step that can’t be taken back', () => {
  const screen = (phone: boolean, confirm: (message: string) => boolean) =>
    vi.stubGlobal('window', { matchMedia: () => ({ matches: phone }), confirm });
  afterEach(() => vi.unstubAllGlobals());

  it('is the browser’s own confirm on a desktop, as before', async () => {
    const { confirmAction } = await import('@/components/ui/confirm');
    const asked: string[] = [];
    screen(false, (message) => (asked.push(message), true));
    await expect(confirmAction('Delete it?', { action: 'Delete', danger: true })).resolves.toBe(true);
    expect(asked).toEqual(['Delete it?']);
  });

  it('is a sheet on a phone that says yes only to its action, and one question at a time', async () => {
    const { answerConfirm, confirmAction, pendingConfirm } = await import('@/components/ui/confirm');
    screen(true, () => {
      throw new Error('the browser’s confirm on a phone');
    });
    const first = confirmAction('Replace the token?', { action: 'Replace', danger: true });
    expect(pendingConfirm()).toMatchObject({ message: 'Replace the token?', action: 'Replace', danger: true });
    const second = confirmAction('Allow $secrets?', { action: 'Allow' });
    await expect(first).resolves.toBe(false);
    answerConfirm(true);
    await expect(second).resolves.toBe(true);
    expect(pendingConfirm()).toBeUndefined();
    const third = confirmAction('Delete it?');
    answerConfirm(false);
    await expect(third).resolves.toBe(false);
  });
});
