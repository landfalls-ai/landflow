/**
 * The Story tab's headlines (lib/shared/run-headlines.ts): the moments a team node kept on its output's `activity`,
 * placed in time from the node's start and on the story entry of the member they are about.
 */
import { describe, expect, it } from 'vitest';
import type { JournalEvent, RunActor } from '@/lib/shared/run-trace';
import { foldJournal } from '@/lib/shared/run-trace-model';
import { headlinesOf, turnEntryKey } from '@/lib/shared/run-headlines';
import { turnOrdinal } from '@/components/editor/team-live';
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

  it('places the moments of a run that waited for a person on the node run each part was in', () => {
    // The team worked 20 s, waited 60 s for an approval, then 10 s more: its activity counts 30 s without the wait.
    const activity: TeamActivity = {
      durationMs: 30_000,
      parts: [20_000, 10_000],
      turns: [],
      steps: {},
      moments: [
        { at: 15_000, member: 'Developer', tone: 'warn', text: 'Developer asks to use publish' },
        { at: 25_000, member: 'Developer', tone: 'info', text: 'Developer reported back' },
      ],
    };
    let seq = 0;
    const list: JournalEvent[] = [];
    const add = (time: number, e: Record<string, unknown>) => list.push({ seq: ++seq, executionId: 'x1', at: at(time), ...e } as JournalEvent);
    add(0, { type: 'span.started', spanId: 'run', kind: 'run', name: 'Build flow', actor: flow });
    add(10, { type: 'span.started', spanId: 'node:team:0', parentSpanId: 'run', kind: 'agent', name: 'Team', actor: lead, nodeId: 'team' });
    add(90, { type: 'span.ended', spanId: 'node:team:0', status: 'success' });
    add(90, { type: 'span.started', spanId: 'node:team:1', parentSpanId: 'run', kind: 'agent', name: 'Team', actor: lead, nodeId: 'team' });
    add(100, { type: 'span.ended', spanId: 'node:team:1', status: 'success', output: { reply: 'Done', activity } });
    add(100, { type: 'span.ended', spanId: 'run', status: 'success' });
    const headlines = headlinesOf(foldJournal(list));
    // 15 s into the first part (which began 10 s into the run), and 5 s into the second (which began at 90 s).
    expect(headlines.map((h) => h.at)).toEqual([T0 + 25_000, T0 + 95_000]);
  });

  it('has none for a run without a team node', () => {
    const model = foldJournal(events({ durationMs: 1, turns: [], steps: {}, moments: [] }));
    expect(headlinesOf(model)).toEqual([]);
  });
});

describe('a ribbon segment opens its turn in the Story', () => {
  it('counts a member’s turns and finds the request where each starts', () => {
    const turns = [
      { member: 'Tech Lead', start: 0, end: 2_000 },
      { member: 'Developer', start: 2_000, end: 30_000 },
      { member: 'Tech Lead', start: 30_000, end: 40_000 },
    ];
    expect(turns.map((t) => turnOrdinal(turns, t))).toEqual([1, 1, 2]);
    const model = foldJournal(events({ durationMs: 50_000, turns, steps: {}, moments: [] }));
    const ask = model.story.find((e) => e.type === 'ask' && e.span.actor.name === 'Developer');
    const back = model.story.find((e) => e.type === 'reply' && e.span.caller?.name === 'Tech Lead');
    expect(turnEntryKey(model, 'Developer', 1)).toBe(ask?.key);
    // The lead works again when the Developer reports back.
    expect(turnEntryKey(model, 'Tech Lead', 2)).toBe(back?.key);
    // A turn past the last request still lands on the member.
    expect(turnEntryKey(model, 'developer', 3)).toBe(ask?.key);
    expect(turnEntryKey(model, 'Nobody', 1)).toBeUndefined();
  });
});
