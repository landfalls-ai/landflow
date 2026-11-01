/** The Run Trace's run-it-again and take-over controls, rendered to static HTML from a small failed run. */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { JournalEvent, RunActor } from '../src/lib/shared/run-trace';
import { foldJournal } from '../src/lib/shared/run-trace-model';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {} }) }));
const { RerunFromHere, RerunOfBadge, RerunPanel, RunControlsProvider } = await import('../src/components/run-trace/run-controls');
const { TakeOver } = await import('../src/components/editor/team-pause');

const flow: RunActor = { id: 'workflow', name: 'Flow', type: 'system' };
const lead: RunActor = { id: 'node:team', name: 'Tech Lead', type: 'agent' };
const dev: RunActor = { id: 'remote:Developer', name: 'Developer', type: 'agent' };
let seq = 0;
const ev = (e: Record<string, unknown>) => ({ seq: ++seq, executionId: 'ex_c', at: new Date(Date.UTC(2026, 10, 1, 9, 0, seq)).toISOString(), ...e }) as unknown as JournalEvent;
const events: JournalEvent[] = [
  ev({ type: 'span.started', spanId: 'run', kind: 'run', name: 'Plugin run', actor: flow }),
  ev({ type: 'span.started', spanId: 'node:trigger:0', parentSpanId: 'run', kind: 'step', name: 'Manual Trigger', actor: flow, nodeId: 'trigger' }),
  ev({ type: 'span.ended', spanId: 'node:trigger:0', status: 'success' }),
  ev({ type: 'span.started', spanId: 'node:team:0', parentSpanId: 'run', kind: 'agent', name: 'Tech Lead team', actor: lead, nodeId: 'team', attrs: { nodeType: 'core.runTeam' } }),
  ev({ type: 'span.started', spanId: 'node:team:0/step:c1', parentSpanId: 'node:team:0', kind: 'delegate', name: 'Developer', actor: dev, caller: lead, input: { message: 'Build it' } }),
  ev({ type: 'span.ended', spanId: 'node:team:0/step:c1', status: 'success', output: 'done' }),
  ev({ type: 'span.ended', spanId: 'node:team:0', status: 'success' }),
  ev({ type: 'span.started', spanId: 'node:report:0', parentSpanId: 'run', kind: 'step', name: 'Run Report', actor: flow, nodeId: 'report' }),
  ev({ type: 'span.ended', spanId: 'node:report:0', status: 'error', error: 'typecheck failing' }),
  ev({ type: 'span.ended', spanId: 'run', status: 'error' }),
];
const model = foldJournal(events);
const provided = (child: ReturnType<typeof createElement>, value = { executionId: 'ex_c', workflowId: 'wf_1' } as { executionId: string; workflowId?: string; rerunOf?: { executionId: string; scope: string; nodeId?: string } }) =>
  renderToStaticMarkup(createElement(RunControlsProvider, { value }, child));

describe('run-it-again controls', () => {
  it('shows the steps before as pinned, the failed one as the start, and the three actions on a member’s request', () => {
    const html = provided(createElement(RerunPanel, { model, spanId: 'node:team:0/step:c1' }));
    expect(html).toContain('Run it again');
    expect(html).toContain('pinned');
    expect(html).toContain('Manual Trigger');
    expect(html).toContain('runs again from here');
    expect(html).toContain('runs again');
    expect(html).toContain('Re-run from here');
    expect(html).toContain('Ask Developer again');
    expect(html).toContain('/workflows/wf_1?execution=ex_c&amp;pin=team');
  });

  it('has no Ask again on a plain step, a Re-run on a failed step, and nothing outside a run', () => {
    const html = provided(createElement(RerunPanel, { model, spanId: 'node:report:0' }));
    expect(html).toContain('Re-run from here');
    expect(html).not.toContain('again</button>');
    expect(provided(createElement(RerunFromHere, { model, spanId: 'node:report:0' }))).toContain('Re-run from here');
    expect(renderToStaticMarkup(createElement(RerunPanel, { model, spanId: 'node:report:0' }))).toBe('');
  });

  it('says in the header that the run re-ran another', () => {
    const html = provided(createElement(RerunOfBadge, { model }), { executionId: 'ex_c', rerunOf: { executionId: 'exec_original_1', scope: 'from', nodeId: 'report' } });
    expect(html).toContain('/runs/exec_original_1');
    expect(html).toContain('Re-run from');
    expect(html).toContain('Run Report');
  });
});

describe('take over', () => {
  it('asks for the next instruction of a paused member, and says it was stopped for a remote one', () => {
    const html = renderToStaticMarkup(createElement(TakeOver, { executionId: 'ex_c', member: 'Developer' }));
    expect(html).toContain('Developer is paused');
    expect(html).toContain('What should it do next?');
    expect(html).toContain('Continue as it was');
    expect(renderToStaticMarkup(createElement(TakeOver, { executionId: 'ex_c', member: 'Developer', remote: true }))).toContain('was stopped');
  });
});
