import { describe, expect, it } from 'vitest';
import { statusItems, workbenchLayout } from '@/components/brain/wiki/workbench';
import { indexCards, indexOutline } from '@/components/brain/wiki/index-doc';
import { deltaText, change, showLayersCard } from '@/components/insights/format';
import type { InsightsTotals } from '@/lib/shared/platform';

const health = { noOwner: [], quiet: [], staleSummaries: [] };

describe('workbench layout', () => {
  it('shows the index alone while the brain is empty', () => {
    expect(workbenchLayout(0, 'index')).toEqual({ indexOnly: true, explorer: false, tabs: false });
    expect(workbenchLayout(0)).toMatchObject({ indexOnly: true });
  });
  it('shows the Explorer and tabs once pages exist, or while loading', () => {
    expect(workbenchLayout(3, 'index')).toEqual({ indexOnly: false, explorer: true, tabs: true });
    expect(workbenchLayout(undefined, 'index').explorer).toBe(true);
  });
  it('keeps the chrome when an empty brain has another file open', () => {
    expect(workbenchLayout(0, 'log').explorer).toBe(true);
  });
  it('has a two-item status bar', () => {
    expect(statusItems(12, 0)).toEqual(['12 pages', '0 problems']);
    expect(statusItems(1, 1)).toEqual(['1 page', '1 problem']);
  });
});

describe('index cards', () => {
  it('hides the empty ones', () => {
    expect(indexCards({ shared: [], proposals: [], teams: [], health })).toEqual([]);
  });
  it('shows those with something in them', () => {
    const cards = indexCards({ shared: [{}] as never, proposals: [], teams: [{}] as never, health: { ...health, quiet: [{}] as never } });
    expect(cards).toEqual(['shared', 'teams', 'needs']);
  });
});

describe('insights formatting', () => {
  it('gives no delta text for zero', () => {
    expect(deltaText(0)).toBeNull();
    expect(deltaText(5, 0)).toBe('new');
    expect(deltaText(5, 50)).toBe('10%');
    expect(deltaText(-1, 100)).toBe('1%');
    expect(deltaText(0.025, 0, true)).toBe('2.5 pp');
  });
  it('change() has no text when nothing moved', () => {
    const t = (runs: number) => ({ runs, failed: 0, failureRate: 0, timeSavedMinutes: 0, avgDurationMs: 0 }) as InsightsTotals;
    expect(change('runs', t(4), t(4)).text).toBeNull();
    expect(change('runs', t(6), t(4)).text).toBe('50%');
  });
  it('shows the layers card only when the cache or router was used', () => {
    expect(showLayersCard(undefined)).toBe(false);
    expect(showLayersCard({ requests: 9, routed: 0, cached: 0 })).toBe(false);
    expect(showLayersCard({ requests: 9, routed: 2, cached: 0 })).toBe(true);
    expect(showLayersCard({ requests: 9, routed: 0, cached: 1 })).toBe(true);
  });
});

describe('index outline', () => {
  const home = { shared: [], proposals: [], teams: [], health } as never;
  const all = [{ title: 'Shared across teams' }, { title: 'Suggestions' }, { title: 'Teams this week' }, { title: 'Needs a person' }];
  it('drops the sections whose cards are hidden', () => {
    expect(indexOutline(all, home)).toEqual([]);
    expect(indexOutline(all, { ...home, shared: [1] }).map((o) => o.title)).toEqual(['Shared across teams']);
  });
});
