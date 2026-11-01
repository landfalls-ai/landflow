/**
 * The Story tab's headlines (lib/shared/run-headlines.ts): the moments a team node kept on its output's `activity`,
 * placed in time from the node's start and on the story entry of the member they are about.
 */
import { describe, expect, it } from 'vitest';
import type { JournalEvent, RunActor } from '@/lib/shared/run-trace';
import { foldJournal } from '@/lib/shared/run-trace-model';
import { headlinesOf } from '@/lib/shared/run-headlines';
import type { TeamActivity } from '@/lib/shared/team-progress';

const T0 = Date.parse('2026-11-01T10:00:00.000Z');
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
const flow: RunActor = { id: 'workflow', type: 'system', name: 'Build flow' };
const lead: RunActor = { id: 'node:team', type: 'agent', name: 'Tech Lead' };
const dev: RunActor = { id: 'member:dev', type: 'agent', name: 'Developer' };

function events(activity: TeamActivity): JournalEvent[] {
  let seq = 0;
  const list: JournalEvent[] = [];
  const add = (time: number, e: Record<string, unknown>) => list.push({ seq: ++seq, executionId: 'x1', at: at(time), ...e } as JournalEvent);
  add(0, { type: 'span.started', spanId: 'run', kind: 'run', name: 'Build flow', actor: flow });
  add(10, { type: 'span.started', spanId: 'node:team:0', parentSpanId: 'run', kind: 'agent', name: 'Team', actor: lead, nodeId: 'team' });
  add(12, { type: 'span.started', spanId: 'node:team:0/ask:1', parentSpanId: 'node:team:0', kind: 'delegate', name: 'Build it', actor: dev, caller: lead, input: 'Build it' });
  add(40, { type: 'span.ended', spanId: 'node:team:0/ask:1', status: 'success', output: 'Built, 14 tests pass' });
  add(60, { type: 'span.ended', spanId: 'node:team:0', status: 'success', output: { reply: 'Done', activity } });
  add(61, { type: 'span.ended', spanId: 'run', status: 'success' });
  return list;
}

describe('the Story headlines', () => {
  it('places a team run’s moments in time and on the member’s entry, leaving out the hand-offs', () => {
    const activity: TeamActivity = {
      durationMs: 50_000,
      turns: [],
      steps: {},
      moments: [
        { at: 2_000, member: 'Tech Lead', tone: 'info', text: 'Asked the Developer' },
        { at: 29_000, member: 'Developer', tone: 'ok', text: '14 tests pass' },
        { at: 30_000, member: 'Developer', tone: 'warn', text: 'Developer used 80% of its budget' },
        { at: 31_000, member: 'Developer', tone: 'info', text: 'Developer reported back' },
      ],
    };
    const model = foldJournal(events(activity));
    const headlines = headlinesOf(model);
    expect(headlines.map((h) => h.moment.text)).toEqual(['14 tests pass', 'Developer used 80% of its budget', 'Developer reported back']);
    // The node started 10 s into the run: a moment 29 s into the team is 39 s into the run.
    expect(headlines[0].at).toBe(T0 + 39_000);
    // Each scrolls to an entry the story shows; the Developer's moments to the Developer's own.
    const keys = new Set(model.story.map((e) => e.key));
    for (const h of headlines) expect(keys.has(h.entryKey!)).toBe(true);
    const entry = model.story.find((e) => e.key === headlines[0].entryKey)!;
    expect('span' in entry && entry.span.actor.name).toBe('Developer');
  });

  it('headlines the notes members wrote, though they are only information', () => {
    const activity: TeamActivity = {
      durationMs: 50_000,
      turns: [],
      steps: {},
      moments: [
        { at: 2_000, member: 'Tech Lead', tone: 'info', text: 'Asked the Developer' },
        { at: 20_000, member: 'Developer', tone: 'info', text: 'Developer noted: plugins need an icons/ folder', note: true },
      ],
    };
    expect(headlinesOf(foldJournal(events(activity))).map((h) => h.moment.text)).toEqual(['Developer noted: plugins need an icons/ folder']);
  });

  it('has none for a run without a team node', () => {
    const model = foldJournal(events({ durationMs: 1, turns: [], steps: {}, moments: [] }));
    expect(headlinesOf(model)).toEqual([]);
  });
});
