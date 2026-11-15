/**
 * "Ask about it": the starters per kind of resource, the event askAbout fires, the failed-run button and the menus that
 * carry the item (docs/spotlight.md#ask-about-it).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ASK_ABOUT_EVENT, askAbout, askDetail } from '../src/lib/client/ask-about';
import { startersFor } from '../src/lib/shared/ask-starters';
import { MENTION_TYPES } from '../src/lib/shared/mentions';
import { RunLineRow } from '../src/components/run-trace/run-line';
import type { RunLine } from '../src/lib/shared/run-line';

const src = (...parts: string[]) => readFileSync(join(import.meta.dirname, '..', 'src', ...parts), 'utf8');

describe('startersFor', () => {
  it('gives three questions for every kind', () => {
    for (const type of MENTION_TYPES) expect(startersFor(type)).toHaveLength(3);
  });
  it('asks the workflow questions', () => {
    expect(startersFor('workflow')).toEqual(['What does this flow do?', 'Why did its last run fail?', 'How can I make it faster?']);
  });
  it('a failed run asks why first', () => {
    expect(startersFor('run', { failed: true })).toEqual(['Why did this fail?', 'How do I fix it?', 'Has this happened before?']);
    expect(startersFor('run')[0]).not.toBe('Why did this fail?');
  });
  it('a credential starter never names a value', () => {
    expect(startersFor('credential').join(' ')).not.toMatch(/secret|token|password/i);
  });
});

describe('askAbout', () => {
  it('dispatches landflow:ask-about with the detail', () => {
    const dispatchEvent = vi.fn(() => true);
    const detail = askDetail({ type: 'run', id: 'r1', name: 'Nightly sync', workflowId: 'w1' }, { failed: true });
    askAbout(detail, { dispatchEvent });
    const event = (dispatchEvent.mock.calls[0] as unknown as [CustomEvent])[0];
    expect(event.type).toBe(ASK_ABOUT_EVENT);
    expect(event.type).toBe('landflow:ask-about');
    expect(event.detail).toEqual({ ref: { type: 'run', id: 'r1', name: 'Nightly sync', workflowId: 'w1' }, starters: startersFor('run', { failed: true }) });
  });
  it('does nothing without a window', () => {
    expect(() => askAbout(askDetail({ type: 'workflow', id: 'w', name: 'W' }), undefined)).not.toThrow();
  });
});

describe('the failed-run button', () => {
  const line = (tone: RunLine['out']['tone']): RunLine => ({
    in: { kind: 'manual', label: 'Manual' },
    by: { members: [] },
    out: { tone, label: tone === 'bad' ? 'Failed' : 'Done' },
    ms: 1200,
    tokens: 0,
  }) as RunLine;
  it('a failed run line offers Ask why it failed', () => {
    const html = renderToStaticMarkup(createElement(RunLineRow, { line: line('bad'), name: 'Nightly sync', href: '/runs/r1', runId: 'r1' }));
    expect(html).toContain('Ask why it failed');
  });
  it('a finished run line does not', () => {
    const html = renderToStaticMarkup(createElement(RunLineRow, { line: line('ok'), name: 'Nightly sync', href: '/runs/r1', runId: 'r1' }));
    expect(html).not.toContain('Ask why it failed');
  });
});

describe('the menus', () => {
  const files: Array<[string, string]> = [
    ['workflows', 'components/workflows/workflows-list.tsx'],
    ['runs', 'components/runs/runs-list.tsx'],
    ['run page', 'components/run-trace/run-page.tsx'],
    ['agent card', 'components/agents/agent-card.tsx'],
    ['agent page', 'components/agents/builder.tsx'],
    ['data table', 'components/data-tables/table-view.tsx'],
    ['credentials', 'app/credentials/page.tsx'],
    ['brain page', 'components/brain/wiki/page-doc.tsx'],
    ['execution preview', 'components/executions/execution-preview.tsx'],
  ];
  for (const [name, file] of files) {
    it(`${name} asks about its resource`, () => {
      const text = src(file);
      expect(text).toContain('askAbout(');
      expect(text).toMatch(/Ask Spotlight|Ask why it failed|Ask about where/);
    });
  }
  it('a credential sends the reference only', () => {
    const text = src('app/credentials/page.tsx');
    expect(text).toMatch(/askDetail\(\{ type: 'credential', id: credential\.id, name: credential\.name \}\)/);
  });
});
