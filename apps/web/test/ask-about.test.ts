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
import { RunLineRow, RunOneLine } from '../src/components/run-trace/run-line';
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

describe('RunOneLine', () => {
  const line = (tone: RunLine['out']['tone'], ms = 1200): RunLine => ({ in: { kind: 'manual', label: 'Manual' }, by: { members: [] }, out: { tone, label: 'Done' }, ms, tokens: 0 }) as RunLine;
  it('is one link with the name, the time it took and when', () => {
    const html = renderToStaticMarkup(createElement(RunOneLine, { line: line('ok'), name: 'Nightly sync', href: '/runs/r1', startedAt: new Date(Date.now() - 120_000).toISOString() }));
    expect(html.match(/<a /g)).toHaveLength(1);
    expect(html).toContain('href="/runs/r1"');
    expect(html).toContain('aria-label="Open the run: Nightly sync"');
    expect(html).toContain('Nightly sync');
    expect(html).toContain('1.2');
    expect(html).not.toContain('<button');
  });
  it('a live run shows no duration', () => {
    const html = renderToStaticMarkup(createElement(RunOneLine, { line: line('live', 5000), name: 'Nightly sync', href: '/runs/r1' }));
    expect(html).not.toContain('5.0');
  });
  it('a failed run puts the Ask button beside the link, not inside it', () => {
    const html = renderToStaticMarkup(createElement(RunOneLine, { line: line('bad'), name: 'Nightly sync', href: '/runs/r1', runId: 'r1', workflowId: 'w1' }));
    expect(html).toMatch(/<\/a><\/div><button[^>]*>.*Ask why it failed<\/button>/);
  });
  it('a run with an agent on it is a card, not one line', () => {
    const withAgent = { ...line('ok'), by: { lead: { id: 'agent:a1', name: 'Helper', type: 'agent' }, members: [] } } as unknown as RunLine;
    const html = renderToStaticMarkup(createElement(RunLineRow, { line: withAgent, name: 'Nightly sync', href: '/runs/r1' }));
    expect(html).toContain('rounded-2xl border border-hair bg-sf p-3');
    expect(html).toContain('Open the run: Manual to Done');
  });
});

describe('the menus', () => {
  // Each surface, the resource type it sends and the id it takes (so an item wired to the wrong resource fails here).
  const files: Array<[string, string, string, string]> = [
    ['workflows', 'components/workflows/workflows-list.tsx', 'workflow', 'workflow.id'],
    ['runs', 'components/runs/runs-list.tsx', 'run', 'execution.id'],
    ['run page', 'components/run-trace/run-page.tsx', 'run', 'executionId'],
    ['agent card', 'components/agents/agent-card.tsx', 'agent', 'agent.id'],
    ['agent page', 'components/agents/builder.tsx', 'agent', 'agentId'],
    ['data table', 'components/data-tables/table-view.tsx', 'dataTable', 'tableId'],
    ['credentials', 'app/credentials/page.tsx', 'credential', 'credential.id'],
    ['brain page', 'components/brain/wiki/page-doc.tsx', 'brainPage', '`${entity.type}/${entity.id}`'],
    ['execution preview', 'components/executions/execution-preview.tsx', 'run', 'record.executionId'],
  ];
  for (const [name, file, type, id] of files) {
    it(`${name} asks about its resource`, () => {
      const text = src(file);
      expect(text).toMatch(/Ask Spotlight|Ask why it failed|Ask about where/);
      const calls = [...text.matchAll(/askAbout\(askDetail\(\{ type: '([A-Za-z]+)', id: ([^,]+),/g)].map((m) => [m[1], m[2]]);
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) expect(call).toEqual([type, id]);
    });
  }
  it('a run names its workflow wherever it is asked about', () => {
    for (const file of ['components/runs/runs-list.tsx', 'components/run-trace/run-page.tsx', 'components/executions/execution-preview.tsx', 'components/run-trace/run-line.tsx']) {
      const text = src(file);
      const calls = [...text.matchAll(/askDetail\(\{ type: 'run'.*$/gm)];
      expect(calls.length, file).toBeGreaterThan(0);
      for (const m of calls) expect(m[0], file).toContain('workflowId');
    }
  });
  it('a credential sends the reference only', () => {
    const text = src('app/credentials/page.tsx');
    expect(text).toMatch(/askDetail\(\{ type: 'credential', id: credential\.id, name: credential\.name \}\)/);
  });
});
