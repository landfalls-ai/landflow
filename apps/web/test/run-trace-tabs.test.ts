/**
 * The Run Trace's tabs and summary (components/run-trace/run-trace-tabs.ts): a short single-flow run shows Story and
 * Trace only and no time slider; Team and Artifacts appear with something in them; the Story's summary hides zero tiles
 * and the "next" block without a next step; the Debug access dialog speaks without tool names unless developer details
 * are on. Made-up runs.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { JournalEvent, RunActor } from '@/lib/shared/run-trace';
import { buildRunReport } from '@/lib/shared/run-report';
import { foldJournal } from '@/lib/shared/run-trace-model';
import { resolveRunProfile } from '@/lib/shared/run-profiles';
import { nextSteps, showScrubber, summaryTiles, visibleTabs } from '../src/components/run-trace/run-trace-tabs';
import { DebugAccessDialog } from '../src/components/run-trace/debug-access';
import { StorySummary } from '../src/components/run-trace/report';
import { Head } from '../src/components/run-trace/run-trace-view';
import { Story } from '../src/components/run-trace/story';

const T0 = Date.parse('2026-11-01T10:00:00.000Z');
const flow: RunActor = { id: 'workflow', type: 'system', name: 'Notes' };
const manual: RunActor = { id: 'node:m', type: 'system', name: 'When clicked', nodeType: 'core.manualTrigger' };
const lead: RunActor = { id: 'node:team', type: 'agent', name: 'Tech Lead' };
const rev: RunActor = { id: 'member:rev', type: 'agent', name: 'Reviewer' };

function journal(build: (add: (ms: number, e: Record<string, unknown>) => void) => void): JournalEvent[] {
  let seq = 0;
  const list: JournalEvent[] = [];
  build((ms, e) => list.push({ seq: ++seq, executionId: 'x1', at: new Date(T0 + ms).toISOString(), ...e } as JournalEvent));
  return list;
}

/** A 3-node manual run of 9 ms: nobody but the flow's own steps. */
const shortRun = () =>
  foldJournal(
    journal((add) => {
      add(0, { type: 'span.started', spanId: 'run', kind: 'run', name: 'Notes', actor: flow });
      add(1, { type: 'span.started', spanId: 'node:m:0', parentSpanId: 'run', kind: 'step', name: 'When clicked', actor: manual, nodeId: 'm' });
      add(3, { type: 'span.ended', spanId: 'node:m:0', status: 'success' });
      add(9, { type: 'span.ended', spanId: 'run', status: 'success' });
    }),
  );

/** A team run of a minute: a lead and a reviewer, one request, an artifact. */
const teamRun = (artifact: boolean, end = 60_000) =>
  foldJournal(
    journal((add) => {
      add(0, { type: 'span.started', spanId: 'run', kind: 'run', name: 'Review', actor: flow });
      add(1000, { type: 'span.started', spanId: 'node:team:0', parentSpanId: 'run', kind: 'agent', name: 'Team', actor: lead, nodeId: 'team' });
      add(2000, { type: 'span.started', spanId: 'node:team:0/ask:1', parentSpanId: 'node:team:0', kind: 'delegate', name: 'Review #5', actor: rev, caller: lead, input: 'Review #5' });
      if (artifact) add(3000, { type: 'artifact', spanId: 'node:team:0/ask:1', artifact: { name: 'Notes', kind: 'report', text: '# Notes' } });
      add(4000, { type: 'span.ended', spanId: 'node:team:0/ask:1', status: 'success', output: 'Approved' });
      add(end - 1000, { type: 'span.ended', spanId: 'node:team:0', status: 'success', output: { reply: 'Reviewed' } });
      add(end, { type: 'span.ended', spanId: 'run', status: 'success' });
    }),
  );

describe('visibleTabs', () => {
  it('a 9 ms single-flow run has Story and Trace', () => {
    expect(visibleTabs(shortRun())).toEqual(['story', 'trace']);
  });
  it('a team run adds Team', () => {
    expect(visibleTabs(teamRun(false))).toEqual(['story', 'trace', 'team']);
  });
  it('a run with artifacts adds Artifacts, and Report is never a tab', () => {
    expect(visibleTabs(teamRun(true))).toEqual(['story', 'trace', 'team', 'artifacts']);
    expect(visibleTabs(teamRun(true))).not.toContain('report');
  });
  it('files an agent wrote count as artifacts', () => {
    const changes = { git: false, files: [{ path: 'a.md' }], agents: [], changes: 1, notPushed: 0 } as never;
    expect(visibleTabs(shortRun(), changes)).toEqual(['story', 'trace', 'artifacts']);
  });
});

describe('tabs during a replay', () => {
  it('are those of the whole run, while a cut model has one participant', () => {
    const events = journal((add) => {
      add(0, { type: 'span.started', spanId: 'run', kind: 'run', name: 'Review', actor: flow });
      add(1000, { type: 'span.started', spanId: 'node:team:0', parentSpanId: 'run', kind: 'agent', name: 'Team', actor: lead, nodeId: 'team' });
      add(2000, { type: 'span.started', spanId: 'node:team:0/ask:1', parentSpanId: 'node:team:0', kind: 'delegate', name: 'Review #5', actor: rev, caller: lead, input: 'Review #5' });
      add(3000, { type: 'artifact', spanId: 'node:team:0/ask:1', artifact: { name: 'Notes', kind: 'report', text: '# Notes' } });
      add(4000, { type: 'span.ended', spanId: 'node:team:0/ask:1', status: 'success', output: 'Approved' });
      add(59_000, { type: 'span.ended', spanId: 'node:team:0', status: 'success', output: { reply: 'Reviewed' } });
      add(60_000, { type: 'span.ended', spanId: 'run', status: 'success' });
    });
    const full = foldJournal(events);
    const cut = foldJournal(events, { until: T0 + 1500 });
    expect(visibleTabs(full)).toEqual(['story', 'trace', 'team', 'artifacts']);
    expect(visibleTabs(cut)).not.toContain('team');
  });
});

describe('showScrubber', () => {
  it('is hidden for a short run and for one participant, shown for a longer team run', () => {
    expect(showScrubber(shortRun())).toBe(false);
    expect(showScrubber(teamRun(false, 3000))).toBe(false);
    expect(showScrubber(teamRun(false))).toBe(true);
  });
});

describe('the Story summary', () => {
  it('hides tiles that are zero', () => {
    const labels = (m: ReturnType<typeof shortRun>) => summaryTiles(m).map(([, l]) => l);
    expect(labels(shortRun())).toEqual(['run time']);
    expect(labels(teamRun(true))).toEqual(expect.arrayContaining(['run time', 'taking part', 'requests', 'artifacts']));
    expect(labels(teamRun(false))).not.toContain('artifacts');
    expect(labels(teamRun(false))).not.toContain('failed steps');
  });

  it('shows no next step for a run that passed', () => {
    const model = shortRun();
    const report = buildRunReport(model, resolveRunProfile(undefined), {});
    expect(report.verdict).toBe('pass');
    expect(nextSteps(report)).toEqual([]);
    const html = renderToStaticMarkup(createElement(StorySummary, { model, report, open: () => {} }));
    expect(html).toContain('story-summary');
    expect(html).not.toContain('What should happen next');
    expect(html).not.toMatch(/>0</);
    // The header already says it passed: no "Checked / Done / No checks" card.
    expect(html).not.toContain('No checks');
    expect(html).not.toContain('Done');
    expect(html).not.toContain('Checked');
    // Nothing reported either: no empty cards' grid adding a gap.
    expect(html).not.toContain('summary-cards');
  });

  it('shows next steps when the report has some', () => {
    expect(nextSteps({ verdict: 'fail', next: ['Finish it: a'] } as never)).toEqual(['Finish it: a']);
  });
});

describe('Debug access', () => {
  const html = renderToStaticMarkup(createElement(DebugAccessDialog, { executionId: 'x1', onClose: () => {} }));
  it('lists what the key can do in plain words, without tool names', () => {
    expect(html).toContain('See how the run went');
    expect(html).toContain('See every step of the run');
    for (const tool of ['get_execution', 'explain_failure', 'get_run_trace']) expect(html).not.toContain(tool);
  });
});

describe('one status line', () => {
  for (const [name, model] of [['short run', shortRun()], ['team run', teamRun(true)]] as const) {
    it(`the header of the ${name} has one status badge and no verdict or Reported badge`, () => {
      const html = renderToStaticMarkup(createElement(Head, { model, now: T0 + 120_000, replay: false }));
      expect(html).toMatch(/Succeeded · [^<]+ · [^<]+ ago/);
      expect(html.match(/Succeeded/g)).toHaveLength(1);
      expect(html).not.toContain('Reported');
      expect(html).not.toMatch(/Done|Needs attention|Checked/);
    });
    it(`the Story of the ${name} does not end with "Run finished at"`, () => {
      const html = renderToStaticMarkup(createElement(Story, { model, open: () => {} }));
      expect(html).not.toContain('Run finished at');
    });
  }
});
