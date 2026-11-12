/**
 * Landflow on a phone (docs/mobile.md#the-shell): which pages take the whole screen (no tab bar, a back arrow of their own).
 */
import { describe, expect, it } from 'vitest';
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
