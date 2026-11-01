/** The Artifacts tab, the step sheet's diff and the Markdown viewer, rendered to static HTML from a small run. */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { JournalEvent, RunActor } from '../src/lib/shared/run-trace';
import { foldJournal } from '../src/lib/shared/run-trace-model';
import { foldChanges } from '../src/lib/shared/run-changes';
import { githubOf } from '../src/lib/shared/run-repo';
import { Artifacts } from '../src/components/run-trace/artifacts';
import { DiffView } from '../src/components/run-trace/diff-view';
import { Markdown } from '../src/components/run-trace/doc-markdown';
import { DetailSheet } from '../src/components/run-trace/sheet';
import { diffHunks } from '../src/lib/shared/run-changes';

const dev: RunActor = { id: 'remote:Developer', name: 'Developer', type: 'agent' };
const flow: RunActor = { id: 'workflow', name: 'Flow', type: 'system' };
let seq = 0;
const at = () => new Date(Date.UTC(2026, 9, 31, 15, 0, seq)).toISOString();
const ev = (e: Record<string, unknown>) => ({ seq: ++seq, executionId: 'ex_v', at: at(), ...e }) as unknown as JournalEvent;
const step = (spanId: string, name: string, input: unknown) => [
  ev({ type: 'span.started', spanId, parentSpanId: 'node:dev:0', kind: 'tool', name, actor: dev, input }),
  ev({ type: 'span.ended', spanId, status: 'success', output: { result: 'ok' } }),
];
const events: JournalEvent[] = [
  ev({ type: 'span.started', spanId: 'run', kind: 'run', name: 'Build', actor: flow }),
  ev({ type: 'span.started', spanId: 'node:dev:0', parentSpanId: 'run', kind: 'agent', name: 'Developer', actor: dev }),
  ...step('node:dev:0/step:1', 'Bash', { command: 'git clone https://github.com/acme/widgets /tmp/work' }),
  ...step('node:dev:0/step:2', 'Write', { file_path: '/tmp/work/src/a.ts', content: 'one\ntwo\n' }),
  ...step('node:dev:0/step:3', 'Edit', { file_path: '/tmp/work/src/a.ts', old_string: 'two', new_string: 'TWO' }),
  ...step('node:dev:0/step:4', 'Write', { file_path: '/tmp/work/PLAN.md', content: '# Plan\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n<script>alert(1)</script>' }),
  ev({ type: 'artifact', spanId: 'node:dev:0', artifact: { name: 'PR #2', kind: 'pull_request', url: 'https://github.com/acme/widgets/pull/2' } }),
  ev({ type: 'artifact', spanId: 'node:dev:0', artifact: { name: 'Metrics', kind: 'data', data: { tests: { passed: 3 } } } }),
  ev({ type: 'span.ended', spanId: 'node:dev:0', status: 'success', output: 'Pushed 0039ded to agents/x-1 (PR #2)' }),
  ev({ type: 'span.ended', spanId: 'run', status: 'success' }),
];
const model = foldJournal(events);
const changes = foldChanges(events);
const repo = githubOf(events);
const noop = () => {};

describe('Artifacts tab', () => {
  const html = renderToStaticMarkup(createElement(Artifacts, { executionId: 'ex_v', model, changes, repo, open: noop, replay: false }));

  it('summarises, then lists code changes, documents, links and data', () => {
    expect(html).toContain('2 files');
    expect(html).toContain('1 agent');
    expect(html).toContain('3 changes never pushed');
    expect(html.indexOf('Code changes')).toBeLessThan(html.indexOf('Documents'));
    expect(html.indexOf('Documents')).toBeLessThan(html.indexOf('Links'));
    expect(html.indexOf('Links')).toBeLessThan(html.indexOf('Data'));
    expect(html).toContain('src/a.ts');
    expect(html).toContain('wrote it, then edited it');
    expect(html).toContain('never pushed');
    expect(html).toContain('href="https://github.com/acme/widgets/pull/2"');
  });

  it('leaves out pushed and never pushed when no agent used git', () => {
    const plain = events.filter((e) => !(e.type === 'span.started' && e.spanId.endsWith('step:1')) && !(e.type === 'span.ended' && e.spanId.endsWith('step:1')));
    const html = renderToStaticMarkup(createElement(Artifacts, { executionId: 'ex_v', model: foldJournal(plain), changes: foldChanges(plain), open: noop, replay: false }));
    expect(html).toContain('wrote it, then edited it');
    expect(html).not.toContain('pushed');
  });

  it('says nothing is made for a run without artifacts', () => {
    const empty = renderToStaticMarkup(createElement(Artifacts, { executionId: 'ex_v', model: foldJournal([]), changes: foldChanges([]), open: noop, replay: false }));
    expect(empty).toContain('Nothing made yet');
    expect(empty).not.toContain('Code changes');
  });
});

describe('detail sheet', () => {
  const sheet = (id: string, extra: Record<string, unknown> = {}) =>
    renderToStaticMarkup(createElement(DetailSheet, { target: { kind: 'span', id }, model, onClose: noop, open: noop, onJump: noop, changes, repo, ...extra }));

  it('shows a Write or Edit as a line diff, not JSON', () => {
    const html = sheet('node:dev:0/step:3');
    expect(html).toContain('src/a.ts');
    expect(html).toContain('TWO');
    expect(html).toContain('never pushed');
    expect(html).not.toContain('old_string');
  });

  it('keeps the tool JSON when there is no change to show', () => {
    expect(sheet('node:dev:0/step:3', { changes: foldChanges([]) })).toContain('Asked');
  });

  it('links a commit, a branch and a pull request in a reply when the run names a repository', () => {
    const html = sheet('node:dev:0');
    expect(html).toContain('href="https://github.com/acme/widgets/commit/0039ded"');
    expect(html).not.toContain('href="https://github.com/acme/widgets/tree/');
    const linked = sheet('node:dev:0', { repo: { ...repo!, branch: 'agents/x-1' } });
    expect(linked).toContain('href="https://github.com/acme/widgets/tree/agents/x-1"');
    expect(linked).toContain('href="https://github.com/acme/widgets/pull/2"');
    expect(sheet('node:dev:0', { repo: undefined })).not.toContain('github.com/acme/widgets/commit');
  });
});

describe('DiffView', () => {
  it('draws added and removed lines in a box that scrolls by itself', () => {
    const html = renderToStaticMarkup(createElement(DiffView, { hunks: diffHunks('a\nb\n', 'a\nB\n'), label: 'x' }));
    expect(html).toContain('overflow-x-auto');
    expect(html).toContain('bg-gndim');
    expect(html).toContain('bg-rddim');
    expect(html).toContain('@@ -1,2 +1,2 @@');
  });
});

describe('Markdown', () => {
  it('formats GitHub-flavoured Markdown and drops raw HTML, scripts, other schemes and images', () => {
    const html = renderToStaticMarkup(
      createElement(Markdown, { text: '# Title\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n[ok](https://example.com) [bad](javascript:alert(1))\n\n<script>alert(1)</script><b onclick="x()">raw</b>\n\n![pic](https://evil.test/p.png)' }),
    );
    expect(html).toContain('<h1');
    expect(html).toContain('<table');
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('target="_blank"');
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('onclick');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('evil.test');
  });
});
