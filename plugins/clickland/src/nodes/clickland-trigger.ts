import { defineNode, pollIntervalProperty, type JsonObject, type NodeItem } from '@landflow/sdk';
import { Clickland } from '../client';
import type { ApiContext, ClicklandCredentials } from '../shared';
import { COLOR } from './clickland';

/** A cursor over a time-ordered stream: everything after `since`, plus the ids already emitted at exactly `since`. */
interface Cursor extends JsonObject {
  since: string;
  seen: string[];
  /** A baseline: whatever happened at exactly `since` was already there (it was not read, so its ids are unknown). */
  exclusive: boolean;
}

interface PollState extends JsonObject {
  events: Cursor;
  notes: Cursor;
}

/** Alerts whose events are read per poll (the most recently changed first). */
export const MAX_ALERTS_PER_POLL = 25;
const EVENT_PAGE = 50;
const NOTE_PAGE = 50;
const MANUAL_ITEMS = 5;

const KINDS = ['alertEvent', 'note'];

/** When an event or note happened: the first time field it has (the contract leaves AlertEvent's fields open). */
export function timeOf(entry: JsonObject): string {
  for (const key of ['createdAt', 'at', 'timestamp', 'changedAt', 'firedAt', 'time']) {
    const value = entry[key];
    if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) return new Date(value).toISOString();
  }
  return '';
}

const idOf = (entry: JsonObject, fallback: string) => (typeof entry.id === 'string' && entry.id ? entry.id : fallback);

/** The newest state change of an alert ('' when it has no states). */
function lastChange(alert: JsonObject): string {
  const states = Array.isArray(alert.states) ? (alert.states as JsonObject[]) : [];
  return states.reduce((max, state) => {
    const at = typeof state.changedAt === 'string' && !Number.isNaN(Date.parse(state.changedAt)) ? new Date(state.changedAt).toISOString() : '';
    return at > max ? at : max;
  }, '');
}

/** The alert as items carry it: without its states (they change; the event says what happened). */
const alertSummary = (alert: JsonObject): JsonObject => {
  const { states: _states, ...rest } = alert;
  return rest;
};

/** Entries after the cursor, oldest first, and the cursor moved past them. */
export function advance<T extends JsonObject>(cursor: Cursor, entries: Array<{ id: string; at: string; entry: T }>): { fresh: T[]; cursor: Cursor } {
  const seen = new Set(cursor.seen);
  const fresh = entries.filter((e) => e.at && (e.at > cursor.since || (e.at === cursor.since && !cursor.exclusive && !seen.has(e.id)))).sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  if (!fresh.length) return { fresh: [], cursor };
  const since = fresh[fresh.length - 1].at;
  const atBoundary = fresh.filter((e) => e.at === since).map((e) => e.id);
  return { fresh: fresh.map((e) => e.entry), cursor: { since, seen: since === cursor.since ? [...cursor.seen, ...atBoundary].slice(-500) : atBoundary, exclusive: false } };
}

export const ClicklandTrigger = defineNode({
  description: {
    name: 'clicklandTrigger',
    displayName: 'Clickland Trigger',
    description: 'Starts the workflow on new Clickland alert events (fired or resolved) and, optionally, new notes. Polls the Clickland API: no public URL needed',
    version: 1,
    kind: 'trigger',
    triggerSource: 'poll',
    categories: ['Development', 'Analytics'],
    icon: 'file:clickland-trigger.svg',
    color: COLOR,
    subtitle: 'every {{pollInterval}}s',
    documentationUrl: 'https://github.com/landfalls-ai/landflow/blob/main/plugins/clickland/README.md',
    keywords: ['clickland', 'alert', 'note', 'observability', 'poll', 'trigger'],
    inputs: [],
    outputs: [{ type: 'main' }],
    credentials: [{ name: 'clicklandApi', required: true }],
    properties: [
      pollIntervalProperty(60),
      {
        name: 'events',
        displayName: 'Trigger On',
        type: 'multiOptions',
        default: ['alertEvent'],
        options: [
          { name: 'New Alert Event', value: 'alertEvent', description: 'An alert group fired or resolved' },
          { name: 'New Note', value: 'note', description: 'Someone (or an agent) added a note' },
        ],
      },
      {
        name: 'notice',
        displayName: `The first poll sets a baseline and emits nothing. Events are read for at most ${MAX_ALERTS_PER_POLL} alerts per poll (the most recently changed first). Execute in the editor shows up to ${MANUAL_ITEMS} recent items and changes nothing. For instant delivery use the Clickland Alert Trigger.`,
        type: 'notice',
        default: '',
      },
    ],
  },
  async execute(ctx) {
    const api: ApiContext = { http: ctx.http, ...(ctx.signal && { signal: ctx.signal }) };
    const client = new Clickland(api, ctx.getCredentials<ClicklandCredentials>('clicklandApi'));
    const selected = (ctx.getNodeParameter<string[]>('events', 0, ['alertEvent']) ?? []).filter((e) => KINDS.includes(e));
    const want = (kind: string) => selected.includes(kind);

    const alerts = want('alertEvent') ? ((await client.alerts()).alerts ?? []) : [];
    const byChange = [...alerts].sort((a, b) => (lastChange(b) > lastChange(a) ? 1 : lastChange(b) < lastChange(a) ? -1 : 0));
    const readEvents = async (alert: JsonObject, limit: number) => {
      const { events } = await client.alertEvents(String(alert.id), limit);
      return (events ?? []).map((event, n) => ({ id: idOf(event, `${alert.id}:${timeOf(event)}:${n}`), at: timeOf(event), entry: { event: 'alert.event', alert: alertSummary(alert), alertEvent: event } as JsonObject }));
    };
    const readNotes = async () =>
      ((await client.notes({ limit: NOTE_PAGE })).notes ?? []).map((note, n) => ({ id: idOf(note, `note:${timeOf(note)}:${n}`), at: timeOf(note), entry: { event: 'note.created', note } as JsonObject }));

    if (ctx.mode === 'manual') {
      // Nothing is stored, so the next scheduled poll still sees whatever this shows.
      const out: NodeItem[] = [];
      if (want('alertEvent')) {
        const recent = (await Promise.all(byChange.slice(0, MANUAL_ITEMS).map((alert) => readEvents(alert, MANUAL_ITEMS)))).flat();
        out.push(...recent.sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, MANUAL_ITEMS).map((e) => ({ json: e.entry })));
      }
      if (want('note')) out.push(...(await readNotes()).slice(0, MANUAL_ITEMS).map((e) => ({ json: e.entry })));
      return out;
    }

    const now = new Date().toISOString();
    if (ctx.isFirstPoll()) {
      // Baseline at the newest thing Clickland has seen (its clock), else now.
      const newestChange = alerts.reduce((max, alert) => (lastChange(alert) > max ? lastChange(alert) : max), '');
      const notes = want('note') ? await readNotes() : [];
      const newestNote = notes.reduce((max, n) => (n.at > max ? n.at : max), '');
      ctx.setPollState({
        events: { since: newestChange || now, seen: [], exclusive: true },
        notes: { since: newestNote || now, seen: notes.filter((n) => n.at === newestNote).map((n) => n.id), exclusive: false },
      } satisfies PollState);
      ctx.logger.info('clickland trigger baseline set', { 'landflow.poll.alerts': alerts.length });
      return [];
    }

    const previous = ctx.getPollState<PollState>();
    const state: PollState = {
      events: previous?.events && typeof previous.events.since === 'string' ? previous.events : { since: now, seen: [], exclusive: true },
      notes: previous?.notes && typeof previous.notes.since === 'string' ? previous.notes : { since: now, seen: [], exclusive: true },
    };
    const out: NodeItem[] = [];
    if (want('alertEvent')) {
      // Only alerts that changed since the cursor have new events; alerts without states are read too.
      const due = byChange.filter((alert) => !lastChange(alert) || lastChange(alert) >= state.events.since).slice(0, MAX_ALERTS_PER_POLL);
      const entries = (await Promise.all(due.map((alert) => readEvents(alert, EVENT_PAGE)))).flat();
      const moved = advance(state.events, entries);
      state.events = moved.cursor;
      out.push(...moved.fresh.map((json) => ({ json })));
    }
    if (want('note')) {
      const moved = advance(state.notes, await readNotes());
      state.notes = moved.cursor;
      out.push(...moved.fresh.map((json) => ({ json })));
    }
    ctx.setPollState(state);
    if (out.length) ctx.logger.info(`clickland trigger found ${out.length} new item(s)`, { 'landflow.poll.items': out.length });
    return out;
  },
});
