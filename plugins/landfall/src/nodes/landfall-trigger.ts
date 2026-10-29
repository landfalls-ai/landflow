import { defineNode, pollIntervalProperty, type JsonObject, type NodeItem } from '@landflow/sdk';
import { isEnded, Org, type IncidentView, type LandfallCredentials, type TimelineEvent } from '../client';
import type { ApiContext } from '../shared';

/** One incident Landfall has seen open. `s` is where its timeline cursor stands. */
interface Tracked extends JsonObject {
  /** The incident number, to drop the oldest first when the map is full. */
  n: number;
  /** A seq (events after it are new) or a marker: 'time' (events after the baseline time), 'head' (baseline at the newest seq), 'all' (every event). */
  s: number | string;
  /** When this incident's timeline was last polled (epoch ms; 0 = never), so the oldest-polled goes first. */
  p: number;
}

interface PollState extends JsonObject {
  /** The highest incident number seen. */
  maxNumber: number;
  /** ISO time of the baseline poll, for incidents whose cursor is 'time'. */
  since: string;
  tracked: Record<string, Tracked>;
}

const LIST_LIMIT = 200;
/** Incidents tracked at once; the lowest numbers drop out first. */
export const MAX_TRACKED = 200;
/** Incidents whose timelines are read per poll. */
export const MAX_TIMELINES_PER_POLL = 20;
const EVENT_PAGE = 500;
const MANUAL_ITEMS = 5;

const EVENTS = ['incidentOpened', 'incidentEnded', 'timelineEvent'];

const incidentItem = (event: string, incident: IncidentView, timelineEvent?: TimelineEvent): NodeItem => ({
  json: { event, incident, ...(timelineEvent && { timelineEvent }) },
});

const numberOf = (incident: IncidentView) => Number(incident.number) || 0;

export const LandfallTrigger = defineNode({
  description: {
    name: 'landfallTrigger',
    displayName: 'Landfall Trigger',
    description: 'Starts the workflow when Landfall opens an incident, an incident ends, or a room gets timeline events (polls the Landfall API, no public URL needed)',
    version: 1,
    kind: 'trigger',
    triggerSource: 'poll',
    categories: ['Development', 'Communication'],
    icon: 'file:landfall-trigger.svg',
    color: '#3B5B7A',
    subtitle: 'every {{pollInterval}}s',
    documentationUrl: 'https://landfalls.ai',
    keywords: ['landfall', 'incident', 'war room', 'trigger', 'timeline'],
    inputs: [],
    outputs: [{ type: 'main' }],
    credentials: [{ name: 'landfallApi', required: true }],
    properties: [
      pollIntervalProperty(30),
      {
        name: 'events',
        displayName: 'Trigger On',
        type: 'multiOptions',
        default: ['incidentOpened'],
        options: [
          { name: 'New Incident', value: 'incidentOpened', description: 'An incident with a number above the last one seen' },
          { name: 'Incident Ended', value: 'incidentEnded', description: 'An incident seen open now has an ended status (resolved, closed, mitigated, recovered, done, archived)' },
          { name: 'New Timeline Events', value: 'timelineEvent', description: 'New events in open rooms' },
        ],
      },
      {
        name: 'eventTypes',
        displayName: 'Event Types',
        type: 'string',
        default: '',
        placeholder: 'remediation.proposed, status.changed',
        description: 'For New Timeline Events: a comma-separated list of event types to emit (empty: all)',
      },
      {
        name: 'notice',
        displayName: `The first poll sets a baseline and emits nothing. Timelines are read for at most ${MAX_TIMELINES_PER_POLL} open incidents per poll (the longest unread first) and ${MAX_TRACKED} incidents are tracked. Execute in the editor shows up to ${MANUAL_ITEMS} recent items and changes nothing.`,
        type: 'notice',
      },
    ],
  },
  async execute(ctx) {
    const credentials = ctx.getCredentials<LandfallCredentials>('landfallApi');
    const api: ApiContext = { http: ctx.http, ...(ctx.signal && { signal: ctx.signal }) };
    const org = new Org(api, credentials);
    const selected = (ctx.getNodeParameter<string[]>('events', 0, ['incidentOpened']) ?? []).filter((e) => EVENTS.includes(e));
    const want = (event: string) => selected.includes(event);
    const types = String(ctx.getNodeParameter('eventTypes', 0, '') ?? '')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    const matches = (event: TimelineEvent) => types.length === 0 || types.includes(String(event.type));

    const { items } = await org.listIncidents({ limit: LIST_LIMIT, status: 'all' });
    const byNumber = [...items].sort((a, b) => numberOf(a) - numberOf(b));
    const maxNumber = byNumber.reduce((max, incident) => Math.max(max, numberOf(incident)), 0);

    if (ctx.mode === 'manual') {
      // Nothing is stored, so the next scheduled poll still sees whatever this shows.
      const out: NodeItem[] = [];
      const newest = [...byNumber].reverse();
      if (want('incidentOpened')) out.push(...newest.slice(0, MANUAL_ITEMS).map((incident) => incidentItem('incident.opened', incident)));
      if (want('incidentEnded')) out.push(...newest.filter((incident) => isEnded(incident.status)).slice(0, MANUAL_ITEMS).map((incident) => incidentItem('incident.ended', incident)));
      if (want('timelineEvent')) {
        for (const incident of newest.filter((i) => !isEnded(i.status)).slice(0, 3)) {
          if (out.length >= MANUAL_ITEMS * 3) break;
          const recent = (await org.getEvents(String(incident.id), { limit: MANUAL_ITEMS })).filter(matches);
          out.push(...recent.map((event) => incidentItem('timeline.event', incident, event)));
        }
      }
      return out.slice(0, MANUAL_ITEMS);
    }

    if (ctx.isFirstPoll()) {
      const tracked: Record<string, Tracked> = {};
      for (const incident of byNumber.filter((i) => !isEnded(i.status)).slice(-MAX_TRACKED)) tracked[String(incident.id)] = { n: numberOf(incident), s: 'time', p: 0 };
      ctx.setPollState({ maxNumber, since: new Date().toISOString(), tracked } satisfies PollState);
      ctx.logger.info(`landfall trigger baseline at incident number ${maxNumber}, ${Object.keys(tracked).length} open`);
      return [];
    }

    const previous = ctx.getPollState<PollState>();
    const state: PollState = {
      maxNumber: typeof previous?.maxNumber === 'number' ? previous.maxNumber : maxNumber,
      since: typeof previous?.since === 'string' ? previous.since : new Date().toISOString(),
      tracked: { ...(previous?.tracked ?? {}) },
    };
    const out: NodeItem[] = [];
    const byId = new Map(items.map((incident) => [String(incident.id), incident]));

    // New incidents, oldest first.
    for (const incident of byNumber.filter((i) => numberOf(i) > state.maxNumber)) {
      if (want('incidentOpened')) out.push(incidentItem('incident.opened', incident));
      // A brand-new room's whole timeline is new; an old one seen open for the first time (reopened) is baselined at its head.
      if (!isEnded(incident.status)) state.tracked[String(incident.id)] = { n: numberOf(incident), s: 'all', p: 0 };
    }
    for (const incident of byNumber.filter((i) => numberOf(i) <= state.maxNumber && !isEnded(i.status) && !state.tracked[String(i.id)])) {
      state.tracked[String(incident.id)] = { n: numberOf(incident), s: 'head', p: 0 };
    }
    state.maxNumber = Math.max(state.maxNumber, maxNumber);

    // Ended: tracked incidents the list now shows with an ended status. They get one last timeline read below.
    const ended: string[] = [];
    for (const id of Object.keys(state.tracked)) {
      const incident = byId.get(id);
      if (incident && isEnded(incident.status)) {
        ended.push(id);
        if (want('incidentEnded')) out.push(incidentItem('incident.ended', incident));
      }
    }

    if (want('timelineEvent')) {
      const due = Object.entries(state.tracked)
        .filter(([id]) => byId.has(id))
        .sort(([, a], [, b]) => a.p - b.p || a.n - b.n)
        .slice(0, MAX_TIMELINES_PER_POLL);
      const now = Date.now();
      for (const [id, entry] of due) {
        const incident = byId.get(id)!;
        let events: TimelineEvent[];
        if (entry.s === 'head') {
          const [head] = await org.getEvents(id, { limit: 1 });
          entry.s = head ? Number(head.seq) : 'all';
          entry.p = now;
          continue;
        } else if (typeof entry.s === 'number') {
          events = await org.getEvents(id, { sinceSeq: entry.s });
        } else {
          events = await org.getEvents(id, { limit: EVENT_PAGE });
          if (entry.s === 'time') events = events.filter((event) => typeof event.occurredAt === 'string' && event.occurredAt > state.since);
        }
        events.sort((a, b) => Number(a.seq) - Number(b.seq));
        if (events.length) entry.s = Number(events[events.length - 1].seq);
        entry.p = now;
        out.push(...events.filter(matches).map((event) => incidentItem('timeline.event', incident, event)));
      }
    }

    for (const id of ended) delete state.tracked[id];
    const ids = Object.keys(state.tracked);
    if (ids.length > MAX_TRACKED) {
      for (const id of ids.sort((a, b) => state.tracked[a].n - state.tracked[b].n).slice(0, ids.length - MAX_TRACKED)) delete state.tracked[id];
    }
    ctx.setPollState(state);
    if (out.length) ctx.logger.info(`landfall trigger found ${out.length} new item(s)`, { 'landflow.poll.items': out.length });
    return out;
  },
});
