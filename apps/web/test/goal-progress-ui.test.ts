/** The goal progress line: its words, its markup and the indexing of the host's answer (docs/projects-and-goals.md#progress). */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { GoalCard } from '../src/components/goals/goal-card';
import { GoalProgressLine, indexProgress, progressText } from '../src/components/goals/goal-progress';
import type { GoalProgress } from '../src/lib/shared/goal-progress';
import type { GoalNode } from '../src/lib/shared/goals';

const p = (over: Partial<GoalProgress> & { ok?: number; failed?: number } = {}): GoalProgress => {
  const { ok = 0, failed = 0, ...rest } = over;
  return { goalId: 'gol_x', window: 7, runs: { ok, failed }, costUsd: 0, updates: 0, moved: false, ...rest };
};

describe('progressText', () => {
  it('says nothing moved in either window', () => {
    expect(progressText(p())).toBe('No activity this week');
    expect(progressText(p({ window: 30 }))).toBe('No activity in 30 days');
  });
  it('counts runs, failed, updates and cost, leaving zeros out', () => {
    expect(progressText(p({ ok: 5 }))).toBe('5 runs this week');
    expect(progressText(p({ failed: 2 }))).toBe('2 runs · 2 failed this week');
    expect(progressText(p({ updates: 4 }))).toBe('4 updates this week');
    expect(progressText(p({ costUsd: 1.5 }))).toBe('$1.50 this week');
    expect(progressText(p({ costUsd: 0.004 }))).toBe('< $0.01 this week');
  });
  it('puts a thousands separator in money from $1,000', () => {
    expect(progressText(p({ costUsd: 999.5 }))).toBe('$999.50 this week');
    expect(progressText(p({ costUsd: 1234.5 }))).toBe('$1,234.50 this week');
    expect(progressText(p({ ok: 2, costUsd: 1_250_000 }))).toBe('2 runs · $1,250,000.00 this week');
  });
  it('uses singulars', () => {
    expect(progressText(p({ ok: 1, updates: 1 }))).toBe('1 run · 1 update this week');
    expect(progressText(p({ failed: 1 }))).toBe('1 run · 1 failed this week');
  });
  it('words the contract examples', () => {
    expect(progressText(p({ goalId: 'gol_invoices', ok: 12, failed: 1, costUsd: 0.42, updates: 3, moved: true }))).toBe('13 runs · 1 failed · 3 updates · $0.42 this week');
    expect(progressText(p({ window: 30, ok: 40, failed: 2, costUsd: 1.9, moved: true }))).toBe('42 runs · 2 failed · $1.90 in 30 days');
  });
});

describe('GoalProgressLine and GoalCard', () => {
  const goal: GoalNode = { id: 'gol_x', title: 'Close invoices in two days', level: 'company', status: 'active', projects: [], initiatives: [], canEdit: false, children: [] } as unknown as GoalNode;
  it('draws the dot only when the goal moved', () => {
    const moved = renderToStaticMarkup(createElement(GoalProgressLine, { progress: p({ ok: 2, moved: true }) }));
    expect(moved).toContain('aria-label="Moved"');
    expect(moved).toContain('2 runs this week');
    expect(renderToStaticMarkup(createElement(GoalProgressLine, { progress: p() }))).not.toContain('Moved');
  });
  it('truncates the words with a prop, not by a parent reaching in', () => {
    const wrapped = renderToStaticMarkup(createElement(GoalProgressLine, { progress: p({ ok: 1 }) }));
    const cut = renderToStaticMarkup(createElement(GoalProgressLine, { progress: p({ ok: 1 }), truncate: true }));
    expect(wrapped).not.toContain('truncate');
    expect(cut).toContain('min-w-0 truncate');
  });
  it('a card shows the line only with progress', () => {
    const base = { goal, onOpen: () => {} };
    expect(renderToStaticMarkup(createElement(GoalCard, base))).not.toContain('No activity');
    expect(renderToStaticMarkup(createElement(GoalCard, { ...base, progress: p() }))).toContain('No activity this week');
  });
});

describe('indexProgress', () => {
  it('indexes by goal', () => {
    const map = indexProgress({ progress: [p({ goalId: 'a' }), p({ goalId: 'b', ok: 1 })] });
    expect([...map.keys()]).toEqual(['a', 'b']);
    expect(map.get('b')?.runs.ok).toBe(1);
  });
  it('an answer without progress is an empty map', () => {
    expect(indexProgress({}).size).toBe(0);
    expect(indexProgress(undefined).size).toBe(0);
  });
});
