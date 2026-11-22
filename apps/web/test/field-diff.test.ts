/** FieldDiff and the history sheet's list (components/ui), and the Apply diff's markup that must not change when it adopts FieldDiff. */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { NodeDescriptor, Workflow } from '@landflow/engine';
import { FieldDiff, isLong, type FieldChange } from '../src/components/ui/field-diff';
import { compareSelected, HistoryList, toggleSelected, type HistoryEntry } from '../src/components/ui/history-sheet';
import { agentHistoryEntries } from '../src/components/agents/agent-history';
import { diffAgentConfigs } from '../src/lib/shared/agent-diff';
import { DEFAULT_AGENT_SETTINGS, type AgentConfig } from '../src/lib/shared/agents';
import { corePlugin } from '../src/lib/server/nodes';
import { registry } from '../src/lib/server/plugins/registry';
import type { NodeTypeInfo } from '../src/lib/shared/types';

const changed = (field: string, before: string, after: string): FieldChange => ({ field, label: field, kind: 'changed', before, after });

describe('FieldDiff', () => {
  it('shows the old value struck and the new one plain', () => {
    const html = renderToStaticMarkup(createElement(FieldDiff, { changes: [changed('Model', 'ollama · qwen3', 'anthropic · claude')], unchanged: 0 }));
    expect(html).toMatch(/line-through[^>]*>ollama · qwen3</);
    expect(html).toMatch(/text-t1[^>]*>anthropic · claude</);
    expect(html).not.toMatch(/line-through[^>]*>anthropic/);
  });

  it('shows an added field by its new value and a removed one by its old', () => {
    const html = renderToStaticMarkup(
      createElement(FieldDiff, {
        changes: [
          { field: 'tool:a', label: 'Tool “Send”', kind: 'added', after: 'posts to Slack' },
          { field: 'tool:b', label: 'Tool “Old”', kind: 'removed', before: 'did a thing' },
        ],
        unchanged: 0,
      }),
    );
    expect(html).toContain('posts to Slack');
    expect(html).toContain('added');
    expect(html).toMatch(/line-through[^>]*>did a thing</);
    expect(html).toContain('removed');
    expect(html).not.toContain('Show all');
  });

  it('folds a 600-character value to two lines with Show all', () => {
    const text = 'x'.repeat(600);
    expect(isLong(text)).toBe(true);
    const html = renderToStaticMarkup(createElement(FieldDiff, { changes: [changed('Instructions', text, `${text}!`)], unchanged: 0 }));
    expect(html).toContain('line-clamp-2');
    expect(html).toContain('Show all');
    expect(html).toContain('aria-expanded="false"');
  });

  it('treats a value with a line break as long, and a short one as not', () => {
    expect(isLong('one\ntwo')).toBe(true);
    expect(isLong('short')).toBe(false);
    expect(isLong(undefined)).toBe(false);
  });

  it('counts the fields that stay, with a plural and a custom label', () => {
    expect(renderToStaticMarkup(createElement(FieldDiff, { changes: [changed('A', 'a', 'b')], unchanged: 3 }))).toContain('3 unchanged');
    expect(renderToStaticMarkup(createElement(FieldDiff, { changes: [], unchanged: 0 }))).toContain('No changes');
    expect(renderToStaticMarkup(createElement(FieldDiff, { changes: [], unchanged: 2, unchangedLabel: (n: number) => `${n} untouched` }))).toContain('2 untouched');
  });
});

describe('tone and title', () => {
  it('a change can carry a tone for its new value and a title with the full list (the workflow version history keeps its colours and tooltip)', () => {
    const html = renderToStaticMarkup(
      createElement(FieldDiff, {
        changes: [
          { field: 'Added', label: 'Added', kind: 'changed', after: 'A, B +2', tone: 'good', title: 'A, B, C, D, E, F' },
          { field: 'Removed', label: 'Removed', kind: 'changed', after: 'X', tone: 'bad' },
          { field: 'Moved', label: 'Moved', kind: 'changed', after: 'Y', tone: 'muted' },
          { field: 'Changed', label: 'Changed', kind: 'changed', after: 'Z' },
        ],
        unchanged: 0,
      }),
    );
    expect(html).toMatch(/text-gn[^>]*>A, B \+2</);
    expect(html).toMatch(/text-rd[^>]*>X</);
    expect(html).toMatch(/text-t3[^>]*>Y</);
    expect(html).toMatch(/text-t1[^>]*>Z</);
    expect(html).toContain('title="A, B, C, D, E, F"');
  });
});

describe('the history sheet', () => {
  const entries: HistoryEntry[] = [
    { id: 'v1', label: 'v1', by: 'dana', at: '2026-11-01T10:00:00.000Z' },
    { id: 'v3', label: 'v3', by: 'sam', at: '2026-11-03T10:00:00.000Z', note: 'live' },
    { id: 'v2', label: 'v2', at: '2026-11-02T10:00:00.000Z' },
  ];

  it('lists entries newest first with who and when', () => {
    const html = renderToStaticMarkup(createElement(HistoryList, { entries, selected: [], onToggle: () => {} }));
    expect(html.indexOf('v3')).toBeLessThan(html.indexOf('v2'));
    expect(html.indexOf('v2')).toBeLessThan(html.indexOf('v1'));
    expect(html).toContain('sam');
    expect(html).toContain('Nov 3');
    expect(html).toContain('live');
  });

  it('two entries with the same time keep the list order: the one listed first is the newer', async () => {
    const same = '2026-11-22T10:52:35.000Z';
    const tied: HistoryEntry[] = [
      { id: 'v3', label: 'v3', at: same },
      { id: 'v2', label: 'v2', at: same },
      { id: 'v1', label: 'v1', at: same },
    ];
    const compare = vi.fn(async () => ({ changes: [], unchanged: 0 }));
    await compareSelected(tied, ['v1', 'v3'], compare);
    expect(compare).toHaveBeenLastCalledWith('v1', 'v3');
    await compareSelected(tied, ['v3', 'v2'], compare);
    expect(compare).toHaveBeenLastCalledWith('v2', 'v3');
    const html = renderToStaticMarkup(createElement(HistoryList, { entries: tied, selected: [], onToggle: () => {} }));
    expect(html.indexOf('v3')).toBeLessThan(html.indexOf('v2'));
    expect(html.indexOf('v2')).toBeLessThan(html.indexOf('v1'));
  });

  it('keeps at most two picked, the newest pick replacing the oldest', () => {
    expect(toggleSelected([], 'v1')).toEqual(['v1']);
    expect(toggleSelected(['v1'], 'v3')).toEqual(['v1', 'v3']);
    expect(toggleSelected(['v1', 'v3'], 'v2')).toEqual(['v3', 'v2']);
    expect(toggleSelected(['v1', 'v3'], 'v1')).toEqual(['v3']);
  });

  it('Compare calls compare(a, b) with the older version first', async () => {
    const compare = vi.fn(async () => ({ changes: [changed('Model', 'a', 'b')], unchanged: 4 }));
    expect(await compareSelected(entries, ['v3', 'v1'], compare)).toEqual({ changes: [changed('Model', 'a', 'b')], unchanged: 4 });
    expect(compare).toHaveBeenCalledWith('v1', 'v3');
    expect(await compareSelected(entries, ['v3'], compare)).toBeUndefined();
    expect(compare).toHaveBeenCalledTimes(1);
  });

  it('offers Compare only when two are picked', () => {
    const one = renderToStaticMarkup(createElement(HistoryList, { entries, selected: ['v1'], onToggle: () => {} }));
    expect(one).toContain('Pick one more to compare');
    const two = renderToStaticMarkup(createElement(HistoryList, { entries, selected: ['v1', 'v3'], onToggle: () => {} }));
    expect(two).toContain('Compare v1 and v3');
  });
});

describe('the Apply diff keeps its look when it uses FieldDiff', () => {
  let types: NodeTypeInfo[];
  const slack = {
    type: 'messaging.slack',
    displayName: 'Slack',
    properties: [
      { name: 'channel', displayName: 'Channel', type: 'string', default: '' },
      { name: 'text', displayName: 'Message text', type: 'string', default: '' },
    ],
  } as unknown as NodeDescriptor;
  beforeAll(() => {
    registry.registerBuiltin(corePlugin);
    types = registry.nodeTypes().filter((t) => t.pluginId === 'core');
  });
  const triage = JSON.parse(readFileSync(join(import.meta.dirname, 'spotlight-scenarios', 'fixtures', 'bug-triage.json'), 'utf8')) as Workflow;

  it('renders the same HTML as before the change', async () => {
    const { ChangeDiff } = await import('../src/components/editor/change-diff');
    const { useEditor } = await import('../src/components/editor/store');
    useEditor.setState({ nodeTypes: Object.fromEntries([...types.map((t) => [t.type, t]), ['messaging.slack', { type: 'messaging.slack', pluginId: 'messaging', descriptor: slack }]]) as never });
    const long = `${'Line one of the message\n'.repeat(8)}done`;
    const wf: Workflow = { ...triage, nodes: triage.nodes.map((n) => (n.name === 'Post to #oncall' ? { ...n, parameters: { ...n.parameters, text: long } } : n)) };
    const ops = [
      { op: 'setParameters' as const, node: 'Post to #oncall', parameters: { text: `${long}\nhttps://example.test/issue/1` } },
      { op: 'setParameters' as const, node: 'Open status incident', parameters: { url: 'https://httpbin.org/post' } },
      { op: 'setNodeSettings' as const, node: 'Open status incident', settings: { maxTries: 2 } },
    ];
    // The file was written from the markup before ChangeDiff moved to FieldDiff.
    await expect(renderToStaticMarkup(createElement(ChangeDiff, { before: wf, ops }))).toMatchFileSnapshot('./__snapshots__/change-diff.html');
  });
});

describe('the agent history sheet', () => {
  const config = (instructions: string): AgentConfig => ({ name: 'A', description: '', icon: 'bot', color: '#000', instructions, skills: [], tools: [], schedules: [], channels: [], memory: { crossSession: false }, settings: { ...DEFAULT_AGENT_SETTINGS } });
  const v = (version: number, publishedAt: string, instructions = `v${version}`) => ({ version, publishedAt, config: config(instructions) });

  it('lists the published versions: the live one first, then the kept ones, with the workflows that pin them', () => {
    const entries = agentHistoryEntries(v(3, '2026-11-03T10:00:00.000Z'), [v(2, '2026-11-02T10:00:00.000Z'), v(1, '2026-11-01T10:00:00.000Z')], [
      { version: 3, publishedAt: '2026-11-03T10:00:00.000Z', usedBy: [{ workflowId: 'w', name: 'Alert intake', workflowVersion: 4, production: true }] },
      { version: 1, publishedAt: '2026-11-01T10:00:00.000Z', usedBy: [] },
    ]);
    expect(entries.map((e) => e.label)).toEqual(['v3', 'v2', 'v1']);
    expect(entries[0].note).toBe('Live · used by Alert intake v4 (production)');
    expect(entries[1].note).toBeUndefined();
    // Who published each, when the list knows.
    const named = agentHistoryEntries(v(3, '2026-11-03T10:00:00.000Z'), [v(2, '2026-11-02T10:00:00.000Z')], [{ version: 3, publishedAt: '2026-11-03T10:00:00.000Z', publishedBy: 'u1', publishedByName: 'Dana', usedBy: [] }, { version: 2, publishedAt: '2026-11-02T10:00:00.000Z', usedBy: [] }]);
    expect(named[0].by).toBe('Dana');
    expect(named[1].by).toBeUndefined();
    expect(agentHistoryEntries(undefined, [v(2, '2026-11-02T10:00:00.000Z')], []).map((e) => e.label)).toEqual(['v2']);
  });

  it('renders the compare of two versions: what changed, old struck and new plain, and how many fields stay', () => {
    const { changes, unchanged } = diffAgentConfigs(config('Answer briefly.'), config('Answer in one line.'));
    const html = renderToStaticMarkup(createElement(FieldDiff, { changes, unchanged }));
    expect(html).toContain('Instructions');
    expect(html).toMatch(/line-through[^>]*>Answer briefly\.</);
    expect(html).toContain('Answer in one line.');
    expect(html).toContain(`${unchanged} unchanged`);
  });
});
