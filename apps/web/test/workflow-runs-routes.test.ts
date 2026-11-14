/**
 * A workflow's tabs are Editor | Runs | Tests (docs/run-trace.md, docs/features/editor.md): the old executions and
 * evaluations links redirect with their query, the run header has no id, hash or mode chip, the Re-run menu holds
 * Debug in editor, and the run list's live updates wait while the person reads it.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useRouter: () => ({ push: () => {}, replace: () => {} }),
}));

const { workflowTabPath, WorkflowTabs } = await import('../src/components/shell/workflow-tabs');
const { RerunMenu, RunHeaderMain } = await import('../src/components/executions/execution-preview');
const { shouldPauseLiveUpdates } = await import('../src/components/executions/executions-shell');
const legacyRuns = (await import('../src/app/workflows/[id]/executions/[[...executionId]]/page')).default;
const legacyTests = (await import('../src/app/workflows/[id]/evaluations/page')).default;

/** What a page's redirect() throws: its digest is `NEXT_REDIRECT;<type>;<url>;<status>;`. */
async function target(run: () => Promise<unknown>) {
  try {
    await run();
  } catch (e) {
    const digest = (e as { digest?: string }).digest ?? '';
    if (digest.startsWith('NEXT_REDIRECT')) return digest.split(';')[2];
    throw e;
  }
  throw new Error('no redirect');
}

describe('old links redirect', () => {
  it('executions go to runs, keeping the run id and the query', async () => {
    expect(await target(() => legacyRuns({ params: Promise.resolve({ id: 'w', executionId: ['e'] }), searchParams: Promise.resolve({ x: '1' }) }))).toBe('/workflows/w/runs/e?x=1');
    expect(await target(() => legacyRuns({ params: Promise.resolve({ id: 'w' }), searchParams: Promise.resolve({}) }))).toBe('/workflows/w/runs');
  });
  it('evaluations go to tests', async () => {
    expect(await target(() => legacyTests({ params: Promise.resolve({ id: 'w' }), searchParams: Promise.resolve({ a: 'b' }) }))).toBe('/workflows/w/tests?a=b');
    expect(await target(() => legacyTests({ params: Promise.resolve({ id: 'w' }), searchParams: Promise.resolve({}) }))).toBe('/workflows/w/tests');
  });
  it('encodes the workflow id as it encodes the run id', async () => {
    expect(await target(() => legacyRuns({ params: Promise.resolve({ id: 'a/b?c', executionId: ['e/1'] }), searchParams: Promise.resolve({}) }))).toBe('/workflows/a%2Fb%3Fc/runs/e%2F1');
    expect(await target(() => legacyTests({ params: Promise.resolve({ id: 'a/b?c' }), searchParams: Promise.resolve({}) }))).toBe('/workflows/a%2Fb%3Fc/tests');
  });
});

describe('WorkflowTabs', () => {
  it('lives at the editor, /runs and /tests', () => {
    expect(workflowTabPath('w', 'editor')).toBe('/workflows/w');
    expect(workflowTabPath('w', 'runs')).toBe('/workflows/w/runs');
    expect(workflowTabPath('w', 'tests')).toBe('/workflows/w/tests');
  });
  it('is labelled Editor | Runs | Tests', () => {
    const html = renderToStaticMarkup(createElement(WorkflowTabs, { workflowId: 'w', active: 'runs' }));
    const labels = [...html.matchAll(/>(Editor|Runs|Tests|Executions|Evaluations)</g)].map((m) => m[1]);
    expect(labels).toEqual(['Editor', 'Runs', 'Tests']);
  });
});

describe('the run header', () => {
  it('shows time, status, duration and workflow, with no id, hash or mode', () => {
    const html = renderToStaticMarkup(createElement(RunHeaderMain, { startedAt: '2026-01-02T03:04:05.000Z', state: 'success', statusLabel: 'Succeeded in 1.2s', workflowName: 'Nightly sync' }));
    expect(html).toContain('Succeeded in 1.2s');
    expect(html).toContain('Nightly sync');
    expect(html).not.toMatch(/ID#|trace|manual|webhook|Full screen|Canvas/i);
  });
});

describe('the Re-run menu', () => {
  const props = { hasSnapshot: true, hasVersion: true, onRetry: () => {}, onRerun: () => {}, onDebug: () => {} };
  it('has Debug in editor, Re-run and, for a failed run, Retry from failed step', () => {
    const failed = renderToStaticMarkup(createElement(RerunMenu, { ...props, retryable: true, errorNodeName: 'Send mail' }));
    expect(failed).toContain('Debug in editor');
    expect(failed).toContain('Retry from failed step');
    expect(failed).toContain('Send mail');
    expect(failed).toContain('>Re-run<');
    const ok = renderToStaticMarkup(createElement(RerunMenu, { ...props, retryable: false }));
    expect(ok).toContain('Debug in editor');
    expect(ok).not.toContain('Retry from failed step');
  });
});

describe('live updates in the run list', () => {
  it('wait while the pointer is over the list or it is scrolled away from the top', () => {
    expect(shouldPauseLiveUpdates({ pointerOver: false, scrollTop: 0 })).toBe(false);
    expect(shouldPauseLiveUpdates({ pointerOver: true, scrollTop: 0 })).toBe(true);
    expect(shouldPauseLiveUpdates({ pointerOver: false, scrollTop: 120 })).toBe(true);
    expect(shouldPauseLiveUpdates({ pointerOver: false, scrollTop: 4 })).toBe(false);
  });
});
