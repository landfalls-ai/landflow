/** Landfall Trigger: baseline, new incidents, ended incidents and timeline events against the fake. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { JsonObject } from '@landflow/sdk';
import { LandfallTrigger, MAX_TIMELINES_PER_POLL, MAX_TRACKED } from '../src/nodes/landfall-trigger';
import { startFakeLandfall, type FakeLandfall } from './fake-landfall';
import { jsonOf, landfallCredentials, run } from './helpers';

let fake: FakeLandfall;
beforeAll(async () => {
  fake = await startFakeLandfall();
});
afterAll(() => fake.close());
beforeEach(() => fake.reset());

const poll = (events: string[], pollState?: JsonObject, extra: JsonObject = {}) =>
  run(LandfallTrigger, { pollInterval: 10, events, eventTypes: '', ...extra }, { credentials: landfallCredentials(fake), mode: 'poll', items: [], ...(pollState && { pollState }) });

describe('New Incident', () => {
  it('first poll sets a baseline and emits nothing', async () => {
    fake.seed({ title: 'old 1' });
    fake.seed({ title: 'old 2' });
    const first = await poll(['incidentOpened']);
    expect(first.outputs).toEqual([[]]);
    expect(first.pollState).toMatchObject({ maxNumber: 2, tracked: { [fake.incidents[0].id]: { n: 1 }, [fake.incidents[1].id]: { n: 2 } } });
  });

  it('emits only incidents above the last number, oldest first, and advances', async () => {
    fake.seed({ title: 'old' });
    const first = await poll(['incidentOpened']);
    fake.seed({ title: 'new 1', severity: 'sev1' });
    fake.seed({ title: 'new 2' });
    const second = await poll(['incidentOpened'], first.pollState);
    expect(jsonOf(second).map((j) => [j.event, (j.incident as JsonObject).title])).toEqual([['incident.opened', 'new 1'], ['incident.opened', 'new 2']]);
    expect(jsonOf(second)[0].incident).toMatchObject({ number: 2, severity: 'sev1', status: 'open' });
    expect(second.pollState).toMatchObject({ maxNumber: 3 });
    expect(jsonOf(await poll(['incidentOpened'], second.pollState))).toEqual([]);
  });

  it('an incident opened and resolved between polls is still reported as new', async () => {
    const first = await poll(['incidentOpened']);
    const quick = fake.seed({ title: 'quick' });
    fake.append(quick, 'status.changed', { status: 'resolved' });
    const second = await poll(['incidentOpened'], first.pollState);
    expect(jsonOf(second)).toHaveLength(1);
    expect(second.pollState).toMatchObject({ tracked: {} });
  });

  it('an empty Landfall baselines at 0', async () => {
    const first = await poll(['incidentOpened']);
    expect(first.pollState).toMatchObject({ maxNumber: 0, tracked: {} });
    fake.seed({ title: 'first ever' });
    expect(jsonOf(await poll(['incidentOpened'], first.pollState))).toHaveLength(1);
  });
});

describe('Incident Ended', () => {
  it('emits once when an incident seen open has an ended status', async () => {
    const incident = fake.seed({ title: 'will end' });
    const other = fake.seed({ title: 'stays open' });
    const first = await poll(['incidentEnded']);
    fake.append(incident, 'status.changed', { status: 'mitigated' });
    const second = await poll(['incidentEnded'], first.pollState);
    expect(jsonOf(second)).toEqual([{ event: 'incident.ended', incident: expect.objectContaining({ id: incident.id, status: 'mitigated' }) }]);
    expect(Object.keys(second.pollState!.tracked as JsonObject)).toEqual([other.id]);
    expect(jsonOf(await poll(['incidentEnded'], second.pollState))).toEqual([]);
  });

  it('every ended status counts, case-insensitively', async () => {
    const statuses = ['resolved', 'closed', 'mitigated', 'recovered', 'done', 'ARCHIVED'];
    for (const status of statuses) fake.seed({ title: status });
    const first = await poll(['incidentEnded']);
    for (const [index, status] of statuses.entries()) fake.append(fake.incidents[index], 'status.changed', { status });
    expect(jsonOf(await poll(['incidentEnded'], first.pollState))).toHaveLength(statuses.length);
  });

  it('does not emit ended events when only New Incident is selected, but still stops tracking', async () => {
    const incident = fake.seed({ title: 'x' });
    const first = await poll(['incidentOpened']);
    fake.append(incident, 'status.changed', { status: 'resolved' });
    const second = await poll(['incidentOpened'], first.pollState);
    expect(jsonOf(second)).toEqual([]);
    expect(second.pollState).toMatchObject({ tracked: {} });
  });
});

describe('New Timeline Events', () => {
  it('baseline emits nothing; later polls emit events after it with the incident, in order', async () => {
    const incident = fake.seed({ title: 'room' });
    fake.append(incident, 'chat.message', { text: 'before baseline' });
    const first = await poll(['timelineEvent']);
    expect(first.outputs).toEqual([[]]);
    await new Promise((resolve) => setTimeout(resolve, 5));
    fake.append(incident, 'chat.message', { text: 'a' });
    fake.append(incident, 'remediation.proposed', { description: 'restart' }, 'agent');
    const second = await poll(['timelineEvent'], first.pollState);
    const out = jsonOf(second);
    expect(out.map((j) => [j.event, (j.timelineEvent as JsonObject).type])).toEqual([['timeline.event', 'chat.message'], ['timeline.event', 'remediation.proposed']]);
    expect(out[0].incident).toMatchObject({ id: incident.id });
    expect(second.pollState!.tracked).toMatchObject({ [incident.id]: { s: 3 } });
    fake.append(incident, 'chat.message', { text: 'b' });
    const third = await poll(['timelineEvent'], second.pollState);
    expect(jsonOf(third).map((j) => (j.timelineEvent as JsonObject).payload)).toEqual([{ text: 'b' }]);
    expect(fake.requests.at(-1)!.query).toEqual({ sinceSeq: '3' });
  });

  it('filters by event types but still advances the cursor', async () => {
    const incident = fake.seed({ title: 'room' });
    const first = await poll(['timelineEvent'], undefined, { eventTypes: 'remediation.proposed, status.changed' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    fake.append(incident, 'chat.message', { text: 'noise' });
    fake.append(incident, 'remediation.proposed', { description: 'fix' }, 'agent');
    const second = await poll(['timelineEvent'], first.pollState, { eventTypes: 'remediation.proposed, status.changed' });
    expect(jsonOf(second).map((j) => (j.timelineEvent as JsonObject).type)).toEqual(['remediation.proposed']);
    expect(jsonOf(await poll(['timelineEvent'], second.pollState, { eventTypes: 'remediation.proposed' }))).toEqual([]);
  });

  it('a new room delivers its whole timeline, a newly seen old room is baselined at its head', async () => {
    const first = await poll(['timelineEvent']);
    const room = fake.seed({ title: 'fresh' });
    fake.append(room, 'incident.triggered', {}, 'system');
    const second = await poll(['timelineEvent'], first.pollState);
    expect(jsonOf(second).map((j) => (j.timelineEvent as JsonObject).type)).toEqual(['incident.opened', 'incident.triggered']);
    // Reopened: ended, untracked, then open again.
    fake.append(room, 'status.changed', { status: 'resolved' });
    const ended = await poll(['timelineEvent'], second.pollState);
    expect(jsonOf(ended).map((j) => (j.timelineEvent as JsonObject).type)).toEqual(['status.changed']);
    fake.append(room, 'status.changed', { status: 'open' });
    const reopened = await poll(['timelineEvent'], ended.pollState);
    // Baselined at its newest seq: nothing emitted for what happened while it was ended.
    expect(jsonOf(reopened)).toEqual([]);
    expect(reopened.pollState!.tracked).toMatchObject({ [room.id]: { s: 3 } });
    fake.append(room, 'chat.message', { text: 'back' });
    const after = await poll(['timelineEvent'], reopened.pollState);
    expect(jsonOf(after).map((j) => (j.timelineEvent as JsonObject).type)).toEqual(['chat.message']);
  });

  it('reads at most 20 incidents per poll, the longest-unread first', async () => {
    for (let n = 0; n < 25; n++) fake.seed({ title: `room ${n}` });
    const first = await poll(['timelineEvent']);
    await new Promise((resolve) => setTimeout(resolve, 5));
    for (const incident of fake.incidents) fake.append(incident, 'chat.message', { text: 'x' });
    fake.requests.length = 0;
    const second = await poll(['timelineEvent'], first.pollState);
    expect(fake.requests.filter((r) => r.path.endsWith('/events'))).toHaveLength(MAX_TIMELINES_PER_POLL);
    expect(jsonOf(second)).toHaveLength(MAX_TIMELINES_PER_POLL);
    const third = await poll(['timelineEvent'], second.pollState);
    expect(jsonOf(third)).toHaveLength(25 - MAX_TIMELINES_PER_POLL);
    const seen = new Set([...jsonOf(second), ...jsonOf(third)].map((j) => (j.incident as JsonObject).id));
    expect(seen.size).toBe(25);
  });

  it('does not read timelines for the other events', async () => {
    fake.seed({ title: 'x' });
    const first = await poll(['incidentOpened', 'incidentEnded']);
    await poll(['incidentOpened', 'incidentEnded'], first.pollState);
    expect(fake.requests.some((r) => r.path.endsWith('/events'))).toBe(false);
  });
});

describe('poll state and manual mode', () => {
  it('keeps the tracked map bounded', async () => {
    const first = await poll(['incidentOpened']);
    for (let n = 0; n < MAX_TRACKED + 20; n++) fake.seed({ title: `i${n}` });
    const second = await poll(['incidentOpened'], first.pollState);
    // Landfall lists 200 at a time, so only the newest 200 are seen and all stay tracked.
    expect(Object.keys(second.pollState!.tracked as JsonObject).length).toBeLessThanOrEqual(MAX_TRACKED);
    expect(jsonOf(second)).toHaveLength(200);
    const crowded: Record<string, JsonObject> = {};
    for (let n = 0; n < MAX_TRACKED + 30; n++) crowded[`gone_${n}`] = { n: -1000 + n, s: 1, p: 0 };
    const third = await poll(['incidentOpened'], { ...(second.pollState as JsonObject), tracked: { ...(second.pollState!.tracked as JsonObject), ...crowded } });
    const tracked = third.pollState!.tracked as Record<string, JsonObject>;
    expect(Object.keys(tracked)).toHaveLength(MAX_TRACKED);
    expect(Object.keys(tracked).some((id) => id.startsWith('gone_'))).toBe(false);
  });

  it('manual mode shows up to 5 recent items and keeps no state', async () => {
    for (let n = 0; n < 8; n++) fake.seed({ title: `i${n}` });
    const manual = await run(LandfallTrigger, { pollInterval: 10, events: ['incidentOpened'], eventTypes: '' }, { credentials: landfallCredentials(fake), mode: 'manual', items: [] });
    expect(jsonOf(manual).map((j) => (j.incident as JsonObject).number)).toEqual([8, 7, 6, 5, 4]);
    expect(manual.pollState).toBeUndefined();
  });

  it('manual mode previews ended incidents and timeline events', async () => {
    const done = fake.seed({ title: 'done' });
    fake.append(done, 'status.changed', { status: 'resolved' });
    const open = fake.seed({ title: 'open' });
    for (let n = 0; n < 6; n++) fake.append(open, 'chat.message', { text: `m${n}` });
    const ended = await run(LandfallTrigger, { pollInterval: 10, events: ['incidentEnded'], eventTypes: '' }, { credentials: landfallCredentials(fake), mode: 'manual', items: [] });
    expect(jsonOf(ended)).toEqual([{ event: 'incident.ended', incident: expect.objectContaining({ id: done.id }) }]);
    const timeline = await run(LandfallTrigger, { pollInterval: 10, events: ['timelineEvent'], eventTypes: '' }, { credentials: landfallCredentials(fake), mode: 'manual', items: [] });
    expect(jsonOf(timeline)).toHaveLength(5);
    expect(jsonOf(timeline)[0]).toMatchObject({ event: 'timeline.event', incident: { id: open.id } });
  });

  it('a Landfall error fails the poll with the mapped message', async () => {
    const failed = await run(LandfallTrigger, { pollInterval: 10, events: ['incidentOpened'], eventTypes: '' }, { credentials: landfallCredentials(fake, { apiKey: 'bad' }), mode: 'poll', items: [] });
    expect(failed.error?.message).toMatch(/Landfall API error 401/);
  });
});
