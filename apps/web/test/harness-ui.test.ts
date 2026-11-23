/** The pure parts of the live status UI (C04): the chip's words and colour, and how live events change the open list. */
import { describe, expect, it } from 'vitest';
import { harnessChipLabel, harnessChipTone, mergeHarnessSession, newestByAgent, type HarnessSessionView } from '@/lib/shared/harness';

const session = (over: Partial<HarnessSessionView> = {}): HarnessSessionView => ({
  id: 's1', harness: 'claude-code', status: 'thinking', stale: false, changedAt: '2026-11-21T10:00:00Z', lastEventAt: '2026-11-21T10:00:00Z', openedAt: '2026-11-21T09:00:00Z', prompts: 1, toolCalls: 0, ...over,
});

describe('the chip', () => {
  it('uses the words of the card: waiting reads "Waiting for you", a stale session "Idle (stale)" (AS-4, AS-8)', () => {
    expect(harnessChipLabel(session({ status: 'waiting' }))).toBe('Waiting for you');
    expect(harnessChipLabel(session({ status: 'working', stale: true }))).toBe('Idle (stale)');
    expect(harnessChipLabel(session({ status: 'blocked' }))).toBe('Blocked');
  });
  it('is the accent while busy, warning when it needs a person, danger on error, quiet when idle or stale', () => {
    expect(harnessChipTone(session({ status: 'working' }))).toBe('accent');
    expect(harnessChipTone(session({ status: 'waiting' }))).toBe('warning');
    expect(harnessChipTone(session({ status: 'blocked' }))).toBe('warning');
    expect(harnessChipTone(session({ status: 'error' }))).toBe('danger');
    expect(harnessChipTone(session({ status: 'idle' }))).toBe('muted');
    expect(harnessChipTone(session({ status: 'working', stale: true }))).toBe('muted');
  });
});

describe('live events on the open list', () => {
  it('replaces a session by id, puts the newest event first and drops an ended or closed one', () => {
    let list = mergeHarnessSession([], session({ id: 'a', lastEventAt: '2026-11-21T10:00:00Z' }));
    list = mergeHarnessSession(list, session({ id: 'b', lastEventAt: '2026-11-21T10:05:00Z' }));
    expect(list.map((s) => s.id)).toEqual(['b', 'a']);
    list = mergeHarnessSession(list, session({ id: 'a', status: 'working', lastEventAt: '2026-11-21T10:09:00Z' }));
    expect(list.map((s) => [s.id, s.status])).toEqual([['a', 'working'], ['b', 'thinking']]);
    expect(mergeHarnessSession(list, session({ id: 'a', status: 'ended' })).map((s) => s.id)).toEqual(['b']);
    expect(mergeHarnessSession(list, session({ id: 'b', closedAt: '2026-11-21T11:00:00Z' })).map((s) => s.id)).toEqual(['a']);
  });
  it('gives each agent its newest open session and skips own sessions', () => {
    const map = newestByAgent([session({ id: 'new', agentId: 'ag1' }), session({ id: 'old', agentId: 'ag1' }), session({ id: 'mine' })]);
    expect([...map.keys()]).toEqual(['ag1']);
    expect(map.get('ag1')?.id).toBe('new');
  });
});
