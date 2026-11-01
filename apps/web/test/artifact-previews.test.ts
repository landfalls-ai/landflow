/** Images, CSV tables, HTML pages and PDFs in the Artifacts tab and the detail sheet, and line comments on a diff. */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { JournalEvent, RunActor } from '../src/lib/shared/run-trace';
import { foldJournal } from '../src/lib/shared/run-trace-model';
import { diffHunks, foldChanges } from '../src/lib/shared/run-changes';
import { artifactShape, framedHtml, parseCsv, safeUrl } from '../src/lib/shared/artifact-kinds';
import { commentsOn, lineCommentsNote, type LineComment } from '../src/lib/shared/line-comments';
import { Artifacts } from '../src/components/run-trace/artifacts';
import { ArtifactPreview } from '../src/components/run-trace/artifact-preview';
import { DiffView } from '../src/components/run-trace/diff-view';
import { LineCommentsProvider } from '../src/components/run-trace/line-comments';
import { DetailSheet } from '../src/components/run-trace/sheet';
import { Report } from '../src/components/run-trace/report';
import { buildRunReport } from '../src/lib/shared/run-report';
import { RUN_PROFILES } from '../src/lib/shared/run-profiles';

const PNG = 'data:image/png;base64,iVBORw0KGgo=';

describe('artifactShape', () => {
  it('reads what an artifact is from its type, kind, name and what it carries', () => {
    expect(artifactShape({ name: 'chart', mimeType: 'image/png', url: 'https://cdn.example.com/c' })).toBe('image');
    expect(artifactShape({ name: 'shot.png', url: PNG })).toBe('image');
    expect(artifactShape({ name: 'Screenshot', kind: 'screenshot', url: 'https://example.com/s' })).toBe('image');
    expect(artifactShape({ name: 'report', url: 'https://example.com/r.pdf' })).toBe('pdf');
    expect(artifactShape({ name: 'rows.csv', text: 'a,b\n1,2' })).toBe('csv');
    expect(artifactShape({ name: 'rows', mimeType: 'text/tab-separated-values', text: 'a\tb' })).toBe('csv');
    expect(artifactShape({ name: 'page.html', text: '<p>hi</p>' })).toBe('html');
    expect(artifactShape({ name: 'Summary', kind: 'report', text: '# Hi' })).toBe('markdown');
    expect(artifactShape({ name: 'PR #2', kind: 'pull_request', url: 'https://github.com/a/b/pull/2' })).toBe('link');
    expect(artifactShape({ name: 'Metrics', data: { a: 1 } })).toBe('data');
    expect(artifactShape({ name: 'note', text: 'plain' })).toBe('text');
  });

  it('needs a URL it can load for an image or a PDF, and text for a table or a page', () => {
    expect(artifactShape({ name: 'x.png', url: 'javascript:alert(1)' })).toBe('text');
    expect(artifactShape({ name: 'x.png', mimeType: 'image/png', data: { b: 1 } })).toBe('data');
    expect(artifactShape({ name: 'rows.csv', url: 'https://example.com/rows.csv' })).toBe('link');
  });
});

describe('safeUrl', () => {
  it('lets through http(s), and inline data only for an image or a PDF', () => {
    expect(safeUrl(' https://example.com/a b ')).toBe('https://example.com/a%20b');
    expect(safeUrl('javascript:alert(1)')).toBeUndefined();
    expect(safeUrl('data:text/html,<script>alert(1)</script>', 'image')).toBeUndefined();
    expect(safeUrl(PNG)).toBeUndefined();
    expect(safeUrl(PNG, 'image')).toBe(PNG);
    expect(safeUrl('data:application/pdf;base64,JVBE', 'pdf')).toBe('data:application/pdf;base64,JVBE');
  });
});

describe('parseCsv', () => {
  it('reads quoted fields, doubled quotes, line breaks in quotes and CRLF', () => {
    const table = parseCsv('name,note\r\n"Smith, J","said ""hi""\nthen left"\r\nLee,ok\r\n');
    expect(table.header).toEqual(['name', 'note']);
    expect(table.rows).toEqual([
      ['Smith, J', 'said "hi"\nthen left'],
      ['Lee', 'ok'],
    ]);
    expect(table.total).toBe(2);
  });

  it('takes tabs when the first line has more of them, and counts past the limit', () => {
    const table = parseCsv('a\tb\n1\t2\n3\t4\n5\t6', 2);
    expect(table.header).toEqual(['a', 'b']);
    expect(table.rows).toEqual([
      ['1', '2'],
      ['3', '4'],
    ]);
    expect(table.total).toBe(3);
  });
});

describe('previews', () => {
  const render = (props: Parameters<typeof ArtifactPreview>[0]) => renderToStaticMarkup(createElement(ArtifactPreview, props));

  it('loads another server’s image only when asked, an inline one at once', () => {
    const remote = render({ shape: 'image', name: 'chart', url: 'https://cdn.example.com/c.png' });
    expect(remote).not.toContain('<img');
    expect(remote).toContain('Load the image from cdn.example.com');
    const inline = render({ shape: 'image', name: 'chart', url: PNG });
    expect(inline).toContain(`<img src="${PNG}"`);
    expect(inline).toContain('referrerPolicy="no-referrer"');
  });

  it('shows a table as one card per row, each column a label', () => {
    const html = render({ shape: 'csv', name: 'rows.csv', text: 'name,score\nAda,3\nLin,5' });
    expect(html).toContain('2 rows · 2 columns');
    expect(html.match(/<li/g)).toHaveLength(2);
    expect(html).toContain('<dt class="truncate text-t3" title="name">name</dt>');
    expect(html).toContain('Ada');
  });

  it('puts a page in a frame with no permissions and a policy that loads nothing', () => {
    const html = render({ shape: 'html', name: 'page.html', text: '<h1>Hi</h1><script>alert(1)</script>' });
    expect(html).toContain('sandbox=""');
    expect(html).toContain('srcDoc=');
    expect(html).toContain('default-src &#x27;none&#x27;');
    expect(framedHtml('<p>x</p>')).toMatch(/^<meta http-equiv="Content-Security-Policy"[^>]*><base target="_blank"><style>[^<]*<\/style><p>x<\/p>$/);
  });

  it('opens a PDF from its link, and inside the page when asked', () => {
    const html = render({ shape: 'pdf', name: 'report', url: 'https://example.com/r.pdf' });
    expect(html).not.toContain('<object');
    expect(html).toContain('Show it here (loads from example.com)');
    expect(html).toContain('href="https://example.com/r.pdf"');
  });
});

describe('Artifacts tab with previews', () => {
  const dev: RunActor = { id: 'remote:Developer', name: 'Developer', type: 'agent' };
  let seq = 0;
  const ev = (e: Record<string, unknown>) => ({ seq: ++seq, executionId: 'ex_p', at: new Date(Date.UTC(2026, 10, 1, 9, 0, seq)).toISOString(), ...e }) as unknown as JournalEvent;
  const events: JournalEvent[] = [
    ev({ type: 'span.started', spanId: 'run', kind: 'run', name: 'Build', actor: { id: 'workflow', name: 'Flow', type: 'system' } }),
    ev({ type: 'span.started', spanId: 'node:dev:0', parentSpanId: 'run', kind: 'agent', name: 'Developer', actor: dev }),
    ev({ type: 'span.started', spanId: 'node:dev:0/step:1', parentSpanId: 'node:dev:0', kind: 'tool', name: 'Write', actor: dev, input: { file_path: '/w/out/report.html', content: '<h1>Done</h1>' } }),
    ev({ type: 'span.ended', spanId: 'node:dev:0/step:1', status: 'success' }),
    ev({ type: 'artifact', spanId: 'node:dev:0', artifact: { name: 'Screenshot', kind: 'screenshot', url: PNG } }),
    ev({ type: 'artifact', spanId: 'node:dev:0', artifact: { name: 'scores.csv', text: 'name,score\nAda,3' } }),
    ev({ type: 'artifact', spanId: 'node:dev:0', artifact: { name: 'Spec', url: 'https://example.com/spec.pdf' } }),
    ev({ type: 'artifact', spanId: 'node:dev:0', artifact: { name: 'Sneaky', kind: 'link', url: 'javascript:alert(1)' } }),
    ev({ type: 'span.ended', spanId: 'node:dev:0', status: 'success' }),
    ev({ type: 'span.ended', spanId: 'run', status: 'success' }),
  ];
  const model = foldJournal(events);
  const html = renderToStaticMarkup(createElement(Artifacts, { executionId: 'ex_p', model, changes: foldChanges(events), open: () => {}, replay: false }));

  it('groups images, tables, pages and PDFs, a page an agent wrote included', () => {
    expect(html).toContain('1 image · 1 table · 1 page · 1 PDF');
    for (const title of ['Images · 1', 'Tables · 1', 'Pages · 1', 'PDFs · 1']) expect(html).toContain(title);
    expect(html.indexOf('Images')).toBeLessThan(html.indexOf('Tables'));
    expect(html).toContain('out/report.html');
  });

  it('leaves out a link that is not http(s), and an image’s or a PDF’s link from Links', () => {
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('Links ·');
  });

  it('counts the files agents wrote as made in the report, on the Report tab and in its Markdown', () => {
    const report = buildRunReport(model, RUN_PROFILES.generic, { changes: foldChanges(events) });
    expect(report.files).toEqual([{ path: '/w/out/report.html', created: true, additions: 1, deletions: 0, by: ['Developer'], spanId: 'node:dev:0/step:1' }]);
    expect(report.markdown).toContain('### Files written\n\n- `/w/out/report.html` · new · +1 −0 · Developer');
    const tab = renderToStaticMarkup(createElement(Report, { model, report, open: () => {} }));
    expect(tab).toContain('Artifacts · 5');
    expect(tab).toContain('file written · Developer · +1 −0');
    expect(tab).not.toContain('Nothing was made');
  });

  it('shows a table in the detail sheet as cards, not its raw text', () => {
    const item = model.artifacts.find((a) => a.artifact.name === 'scores.csv')!;
    const sheet = renderToStaticMarkup(createElement(DetailSheet, { target: { kind: 'artifact', id: item.id }, model, onClose: () => {}, open: () => {}, onJump: () => {} }));
    expect(sheet).toContain('1 row · 2 columns');
    expect(sheet).toContain('<dd class="min-w-0 break-words text-t1">Ada</dd>');
  });
});

describe('line comments', () => {
  const comment = (over: Partial<LineComment>): LineComment => ({ id: 'c', path: 'src/a.ts', side: 'new', line: 2, quote: 'const a = 1;', text: 'Use b', at: '2026-11-01T09:00:00Z', ...over });

  it('collect into a note by file and line, with the line quoted', () => {
    expect(
      lineCommentsNote([
        comment({ path: 'src/b.ts', line: 9, quote: 'x', text: 'Drop this ' }),
        comment({ side: 'old', line: 4, quote: 'let `old`', text: 'Keep it' }),
        comment({}),
      ]),
    ).toBe(["Line comments:", "- src/a.ts line 2 (`const a = 1;`): Use b", "- src/a.ts removed line 4 (`let 'old'`): Keep it", "- src/b.ts line 9 (`x`): Drop this"].join('\n'));
    expect(lineCommentsNote([])).toBe('');
  });

  it('belong on a line by file, side, number and text', () => {
    const c = comment({});
    expect(commentsOn([c], 'src/a.ts', 'new', 2, 'const a = 1;')).toEqual([c]);
    expect(commentsOn([c], 'src/a.ts', 'new', 2, 'const a = 2;')).toEqual([]);
    expect(commentsOn([c], 'src/a.ts', 'old', 2, 'const a = 1;')).toEqual([]);
  });

  it('can be added on each line of a diff inside a Run Trace view, and not outside one', () => {
    const hunks = diffHunks('one\ntwo\n', 'one\nTWO\n');
    const inside = renderToStaticMarkup(createElement(LineCommentsProvider, { executionId: 'ex_c' }, createElement(DiffView, { hunks, label: 'a', path: 'src/a.ts' })));
    expect(inside).toContain('aria-label="Comment on line 1"');
    expect(inside).toContain('aria-label="Comment on removed line 2"');
    expect(inside).toContain('aria-label="Comment on line 2"');
    const outside = renderToStaticMarkup(createElement(DiffView, { hunks, label: 'a', path: 'src/a.ts' }));
    expect(outside).not.toContain('Comment on');
  });
});
