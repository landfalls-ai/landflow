/**
 * The Brain page (docs/second-brain.md#the-brain-page): the second brain read as a wiki.
 *
 * - The work: `work.*` events the activity integrations record (Record Event in the work ingest templates), each tied to
 *   the pages it names: its `customer` and `initiative` hints by the id the templates give them (`hintId`), and the
 *   person whose email is its `actor`. Its team is its own, else that person's department (from the Directory).
 * - The home: the pages with how much work named them lately, the customers and initiatives two or more teams worked
 *   on (shared work: the overlap the brain is for), what each team worked on, the open suggestions and the latest work.
 * - A page: the entity with its facts and suggestions, the work that names it, the people on it, the pages it shares
 *   work with, and a summary the brain's model writes (kept in `brain_pages` with a hash of what it was written from,
 *   so the page says when it is out of date).
 * - Ask: a question answered from the pages, facts and work it finds, with `[[type/id]]` links and `[n]` references.
 *
 * Everything reads through the caller's scope: a page, fact or event the caller can't open isn't there for them, and
 * isn't shown to the model on their behalf.
 */
import { createHash } from 'node:crypto';
import type { LanguageModel } from '@landflow/engine';
import type { BrainEntity, BrainFact, UsageEvent } from '../../shared/brain';
import { entityRef } from '../../shared/brain';
import type { AskTurn, SharedWork, TeamActivity, WikiAnswer, WikiEntry, WikiHealth, WikiHome, WikiLink, WikiPage, WikiPerson, WikiSummary, WorkItem } from '../../shared/brain-wiki';
import { ASK_HISTORY_CHARS, ASK_HISTORY_TURNS, hintId, wikiLinks } from '../../shared/brain-wiki';
import { assistantScope, runInUsageScope } from '../ai-usage';
import { database, type Database } from '../db';
import { listKinds } from '../usage/kinds';
import { listUsageEvents, type UsageScope } from '../usage/query';
import { logger } from '../telemetry/logger';
import { entityKey, entityKnowledge, listEntities } from './entities';
import { listFacts, searchFacts } from './facts';
import { brainStatus } from './index';
import { listProposals } from './proposals';
import { brainModel, brainModelName } from './writer';
import { HttpError } from '../errors';

const DAY = 86_400_000;
/** How far back the home's shared-work and team views look. */
export const WIKI_DAYS = 7;
/** How far back a page's work reaches. */
const PAGE_DAYS = 90;
const MAX_EVENTS = 5_000;

type Viewer = { id: string; email?: string } | undefined;

// ---------------------------------------------------------------------------
// Work items
// ---------------------------------------------------------------------------

/** The pages a work event can name, by the keys the work templates use. */
interface PageIndex {
  byRef: Map<string, BrainEntity>;
  customers: Map<string, string>;
  initiatives: Map<string, string>;
  /** Email or person id → the person's page. */
  people: Map<string, string>;
}

export function pageIndex(entities: BrainEntity[]): PageIndex {
  const index: PageIndex = { byRef: new Map(), customers: new Map(), initiatives: new Map(), people: new Map() };
  for (const e of entities) {
    const ref = entityKey(e);
    index.byRef.set(ref, e);
    const map = e.type === 'customer' ? index.customers : e.type === 'initiative' ? index.initiatives : e.type === 'person' ? index.people : undefined;
    if (!map) continue;
    for (const key of [e.id, hintId(e.name)]) if (key && !map.has(key)) map.set(key, ref);
    const email = typeof e.attrs.email === 'string' ? e.attrs.email.trim().toLowerCase() : '';
    if (e.type === 'person' && email) map.set(email, ref);
  }
  return index;
}

const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined);

function personRef(index: PageIndex, email: string | undefined): string | undefined {
  if (!email) return undefined;
  const lower = email.toLowerCase();
  return index.people.get(lower) ?? index.people.get(hintId(lower));
}

export function workItem(event: UsageEvent, index: PageIndex): WorkItem {
  const a = event.attrs ?? {};
  const actor = text(a.actor)?.toLowerCase();
  const customer = text(a.customer);
  const initiative = text(a.initiative);
  const person = personRef(index, actor);
  const department = person ? text(index.byRef.get(person)?.attrs.department) : undefined;
  const refs = [customer && index.customers.get(hintId(customer)), initiative && index.initiatives.get(hintId(initiative)), person].filter((r): r is string => Boolean(r));
  return {
    id: event.id,
    at: text(a.occurredAt) ?? event.at,
    kind: event.kind,
    ...(text(a.source) && { source: text(a.source) }),
    ...(text(a.title) && { title: text(a.title) }),
    ...(text(a.summary) && { summary: text(a.summary) }),
    ...(text(a.url) && { url: text(a.url) }),
    ...(actor && { actor }),
    ...((text(a.team) ?? department) && { team: text(a.team) ?? department }),
    ...(customer && { customer }),
    ...(initiative && { initiative }),
    refs: [...new Set(refs)],
  };
}

/** The work.* events in the last `days`, newest first, that the scope covers. */
export function workEvents(days: number, scope: UsageScope | undefined, db: Database = database(), now = Date.now()): UsageEvent[] {
  const kinds = listKinds(db)
    .map((k) => k.kind)
    .filter((k) => k.startsWith('work.'));
  if (!kinds.length) return [];
  return listUsageEvents({ kinds: kinds as UsageEvent['kind'][], from: new Date(now - days * DAY).toISOString() }, { limit: MAX_EVENTS, scope }, db);
}

/**
 * The same scope read for nobody in particular: what a shared output (a stored summary, its stale check) may be written
 * from. A person's private work never enters it, whoever asks (usage/query.ts `viewerOf`).
 */
const sharedScope = (scope: UsageScope | undefined): UsageScope => ({ ...scope, viewerId: undefined, system: true });

const byTime = (a: WorkItem, b: WorkItem) => b.at.localeCompare(a.at);

// ---------------------------------------------------------------------------
// Home
// ---------------------------------------------------------------------------

export function wikiHome(scope: UsageScope | undefined, viewer: Viewer, db: Database = database(), now = Date.now()): WikiHome {
  const entities = listEntities({ scope, limit: 2_000 }, db);
  const index = pageIndex(entities);
  const all = workEvents(PAGE_DAYS, scope, db, now)
    .map((e) => workItem(e, index))
    .sort(byTime);
  const monthStart = new Date(now - 30 * DAY).toISOString();
  const items = all.filter((i) => i.at >= monthStart);
  const weekStart = new Date(now - WIKI_DAYS * DAY).toISOString();
  const week = items.filter((i) => i.at >= weekStart);

  const stats = new Map<string, { week: number; month: number; lastAt?: string; teams: Set<string> }>();
  for (const item of items) {
    for (const ref of item.refs) {
      const s = stats.get(ref) ?? { week: 0, month: 0, teams: new Set<string>() };
      s.month++;
      if (item.at >= weekStart) s.week++;
      if (!s.lastAt || item.at > s.lastAt) s.lastAt = item.at;
      if (item.team) s.teams.add(item.team);
      stats.set(ref, s);
    }
  }
  const entries: WikiEntry[] = entities.map((e) => {
    const s = stats.get(entityKey(e));
    return {
      type: e.type,
      id: e.id,
      name: e.name,
      ...(e.description && { description: e.description }),
      ...((e.ownerName ?? e.owner) && { owner: e.ownerName ?? e.owner }),
      ...(e.type === 'person' && typeof e.attrs.department === 'string' && e.attrs.department.trim() && { department: e.attrs.department.trim() }),
      week: s?.week ?? 0,
      month: s?.month ?? 0,
      ...(s?.lastAt && { lastAt: s.lastAt }),
      teams: [...(s?.teams ?? [])].sort(),
    };
  });

  return {
    status: brainStatus(db),
    days: WIKI_DAYS,
    entries,
    shared: sharedWork(week, index),
    teams: teamActivity(week, index),
    kinds: count(week.map((i) => i.kind)).map(([kind, events]) => ({ kind, events })),
    recent: items.slice(0, 30),
    proposals: listProposals({ status: 'open', scope, viewer, limit: 10 }, db),
    health: health(entities, entries, workEvents(PAGE_DAYS, sharedScope(scope), db, now).map((e) => workItem(e, index)), db),
    ...(brainModelName() && { model: brainModelName() }),
  };
}

/**
 * The lint pass: initiatives and customers with no owner, pages no work named in 30 days, and summaries out of date
 * (their page's facts or work changed since, by the same hash the page uses).
 */
function health(entities: BrainEntity[], entries: WikiEntry[], all: WorkItem[], db: Database): WikiHealth {
  const page = (e: { type: string; id: string; name: string }) => ({ ref: entityRef(e.type, e.id), name: e.name });
  const byRef = new Map(entities.map((e) => [entityKey(e), e]));
  const staleSummaries = db
    .all<{ subject: string; basis: string }>('SELECT subject, basis FROM brain_pages')
    .flatMap((r) => {
      const entity = byRef.get(r.subject);
      if (!entity) return [];
      const facts = listFacts({ subjectType: 'entity', subjectId: r.subject, limit: 100 }, db); // as entityKnowledge reads them
      return basisOf(entity, facts, all.filter((i) => i.refs.includes(r.subject))) === r.basis ? [] : [page(entity)];
    });
  return {
    noOwner: entities.filter((e) => (e.type === 'initiative' || e.type === 'customer') && !e.owner).map(page).slice(0, 20),
    quiet: entries.filter((e) => e.type !== 'person' && e.month === 0).map(page).slice(0, 20),
    staleSummaries: staleSummaries.slice(0, 20),
  };
}

const count = (values: string[]) => [...values.reduce((m, v) => m.set(v, (m.get(v) ?? 0) + 1), new Map<string, number>())].sort((a, b) => b[1] - a[1]);

/** Customers and initiatives two or more teams worked on: most teams first, then most work. */
export function sharedWork(items: WorkItem[], index: PageIndex): SharedWork[] {
  const byRef = new Map<string, WorkItem[]>();
  for (const item of items) for (const ref of item.refs) if (!ref.startsWith('person/')) byRef.set(ref, [...(byRef.get(ref) ?? []), item]);
  const out: SharedWork[] = [];
  for (const [ref, work] of byRef) {
    const teams = new Map<string, { events: number; people: Set<string> }>();
    for (const item of work) {
      if (!item.team) continue;
      const t = teams.get(item.team) ?? { events: 0, people: new Set<string>() };
      t.events++;
      if (item.actor) t.people.add(nameOf(index, item.actor));
      teams.set(item.team, t);
    }
    if (teams.size < 2) continue;
    const entity = index.byRef.get(ref)!;
    const sorted = [...work].sort(byTime);
    out.push({
      ref,
      type: entity.type,
      id: entity.id,
      name: entity.name,
      teams: [...teams].map(([team, t]) => ({ team, events: t.events, people: [...t.people].sort() })).sort((a, b) => b.events - a.events),
      events: work.length,
      lastAt: sorted[0].at,
      latest: sorted.slice(0, 4),
    });
  }
  return out.sort((a, b) => b.teams.length - a.teams.length || b.events - a.events);
}

function nameOf(index: PageIndex, email: string): string {
  const ref = personRef(index, email);
  return (ref && index.byRef.get(ref)?.name) || email;
}

function teamActivity(items: WorkItem[], index: PageIndex): TeamActivity[] {
  const teams = new Map<string, { events: number; people: Set<string>; refs: Map<string, number> }>();
  for (const item of items) {
    if (!item.team) continue;
    const t = teams.get(item.team) ?? { events: 0, people: new Set<string>(), refs: new Map<string, number>() };
    t.events++;
    if (item.actor) t.people.add(item.actor);
    for (const ref of item.refs) if (!ref.startsWith('person/')) t.refs.set(ref, (t.refs.get(ref) ?? 0) + 1);
    teams.set(item.team, t);
  }
  return [...teams]
    .map(([team, t]) => ({
      team,
      events: t.events,
      people: t.people.size,
      top: [...t.refs]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([ref, events]) => ({ ref, name: index.byRef.get(ref)?.name ?? ref, events })),
    }))
    .sort((a, b) => b.events - a.events);
}

// ---------------------------------------------------------------------------
// A page
// ---------------------------------------------------------------------------

interface PageRow {
  subject: string;
  summary: string;
  model: string;
  basis: string;
  generated_at: string;
}

/** What a summary is written from: the entity as it is, its facts, and its latest work. */
export function basisOf(entity: BrainEntity, facts: BrainFact[], work: WorkItem[]): string {
  const parts = [entity.updatedAt, entity.name, entity.description ?? '', ...facts.map((f) => `${f.id}@${f.lastSeen}`).sort(), ...work.slice(0, 20).map((w) => w.id)];
  return createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 24);
}

export function wikiPage(entity: BrainEntity, scope: UsageScope | undefined, viewer: Viewer, canEdit: boolean, db: Database = database(), now = Date.now()): WikiPage {
  const ref = entityKey(entity);
  const knowledge = entityKnowledge(entity, (target) => listProposals({ status: 'open', scope, viewer, limit: 200 }, db).filter((p) => p.target.type === 'entity' && p.target.id === target), db);
  const entities = listEntities({ scope, limit: 2_000 }, db);
  const index = pageIndex(entities);
  const work = workEvents(PAGE_DAYS, scope, db, now)
    .map((e) => workItem(e, index))
    .filter((i) => i.refs.includes(ref))
    .sort(byTime);

  const people = new Map<string, WikiPerson>();
  const related = new Map<string, number>();
  const teams = new Map<string, number>();
  for (const item of work) {
    if (item.team) teams.set(item.team, (teams.get(item.team) ?? 0) + 1);
    for (const other of item.refs) if (other !== ref && !other.startsWith('person/')) related.set(other, (related.get(other) ?? 0) + 1);
    if (!item.actor) continue;
    const personPage = personRef(index, item.actor);
    if (personPage === ref) continue;
    const person = people.get(item.actor) ?? {
      ...(personPage && { ref: personPage }),
      name: nameOf(index, item.actor),
      email: item.actor,
      ...(item.team && { team: item.team }),
      events: 0,
    };
    person.events++;
    people.set(item.actor, person);
  }
  // On a person's page, the people they work with are the ones on the same pages.
  if (entity.type === 'person') {
    const theirRefs = new Set(work.flatMap((w) => w.refs).filter((r) => r !== ref));
    for (const item of workEvents(PAGE_DAYS, scope, db, now).map((e) => workItem(e, index))) {
      if (!item.actor || personRef(index, item.actor) === ref || !item.refs.some((r) => theirRefs.has(r))) continue;
      const person = people.get(item.actor) ?? { ...(personRef(index, item.actor) && { ref: personRef(index, item.actor) }), name: nameOf(index, item.actor), email: item.actor, ...(item.team && { team: item.team }), events: 0 };
      person.events++;
      people.set(item.actor, person);
    }
  }

  const row = db.get<PageRow>('SELECT * FROM brain_pages WHERE subject = ?', ref);
  // The stored summary is shared text: whether it is stale counts shared work only, never the viewer's private events.
  const sharedWork = row ? workEvents(PAGE_DAYS, sharedScope(scope), db, now).map((e) => workItem(e, index)).filter((i) => i.refs.includes(ref)).sort(byTime) : [];
  const summary = row ? summaryOf(row, basisOf(entity, knowledge.facts, sharedWork), index) : undefined;

  return {
    ...knowledge,
    ...(summary && { summary }),
    work: work.slice(0, 60),
    people: [...people.values()].sort((a, b) => b.events - a.events).slice(0, 24),
    related: [...related]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .flatMap(([r, shared]) => {
        const e = index.byRef.get(r);
        return e ? [{ ref: r, type: e.type, id: e.id, name: e.name, shared }] : [];
      }),
    teams: [...teams].sort((a, b) => b[1] - a[1]).map(([team, events]) => ({ team, events })),
    mentionedIn: mentions(entity, index, db),
    ...(brainModelName() && { model: brainModelName() }),
    canEdit,
  };
}

function summaryOf(row: PageRow, basis: string, index: PageIndex): WikiSummary {
  return { text: row.summary, model: row.model, generatedAt: row.generated_at, stale: row.basis !== basis, links: linksIn(row.summary, index) };
}

const linksIn = (textIn: string, index: PageIndex): WikiLink[] => wikiLinks(textIn).flatMap((ref) => (index.byRef.has(ref) ? [{ ref, name: index.byRef.get(ref)!.name }] : []));

/** Other pages that name this one: in their description, or as a link in their summary. Only pages the caller sees. */
function mentions(entity: BrainEntity, index: PageIndex, db: Database): Array<{ ref: string; name: string }> {
  const ref = entityKey(entity);
  const out = new Map<string, string>();
  for (const row of db.all<{ subject: string }>('SELECT subject FROM brain_pages WHERE summary LIKE ?', `%[[${ref}%`)) {
    const e = index.byRef.get(row.subject);
    if (e && row.subject !== ref) out.set(row.subject, e.name);
  }
  const name = entity.name.toLowerCase();
  if (name.length >= 3) {
    for (const [other, e] of index.byRef) if (other !== ref && e.description?.toLowerCase().includes(name)) out.set(other, e.name);
  }
  return [...out].map(([r, n]) => ({ ref: r, name: n })).slice(0, 20);
}

// ---------------------------------------------------------------------------
// The model's parts
// ---------------------------------------------------------------------------

export class WikiError extends HttpError {
  static readonly errorName: string = 'WikiError';
  constructor(
    message: string,
    status = 400,
  ) {
    super(message, status, { expose: true });
  }
}

const clip = (value: string | undefined, max: number) => (value && value.length > max ? `${value.slice(0, max - 1)}…` : (value ?? ''));
const day = (iso: string) => iso.slice(0, 10);

function jsonText(reply: string, key: string): string | undefined {
  const match = reply.match(/\{[\s\S]*\}/);
  if (!match) return reply.trim() || undefined;
  try {
    const value = (JSON.parse(match[0]) as Record<string, unknown>)[key];
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  } catch {
    return undefined;
  }
}

/** Links to pages that don't exist (or the caller can't see) become their plain label. */
function keepKnownLinks(textIn: string, index: PageIndex): string {
  return textIn.replace(/\[\[([a-z]+\/[a-z0-9][a-z0-9_.-]{0,63})(?:\|([^\]]*))?\]\]/g, (whole, ref: string, label?: string) => (index.byRef.has(ref) ? whole : (label ?? index.byRef.get(ref)?.name ?? ref.split('/')[1])));
}

/**
 * Link the first plain mention of each page the model was shown ("Tal Ben" → `[[person/tal-x|Tal Ben]]`), so the text
 * links even when the model wrote names instead of links. Not the page itself, not inside a link, names of 3+ letters.
 */
export function linkMentions(textIn: string, pages: Array<{ ref: string; name: string }>, self?: string): string {
  const linked = new Set(wikiLinks(textIn));
  const candidates = pages
    .filter((p, i) => p.ref !== self && p.name.trim().length >= 3 && !linked.has(p.ref) && pages.findIndex((q) => q.ref === p.ref) === i)
    .sort((a, b) => b.name.length - a.name.length);
  const parts = textIn.split(/(\[\[[^\]]*\]\])/);
  for (const page of candidates) {
    const pattern = new RegExp(`(^|[^\\p{L}\\p{N}])(${page.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})(?![\\p{L}\\p{N}])`, 'u');
    for (let i = 0; i < parts.length; i += 2) {
      const match = parts[i].match(pattern);
      if (!match) continue;
      // The text stays at even places and links at odd ones.
      const start = match.index! + match[1].length;
      parts.splice(i, 1, parts[i].slice(0, start), `[[${page.ref}|${match[2]}]]`, parts[i].slice(start + match[2].length));
      break;
    }
  }
  return parts.join('');
}

const pageLine = (e: BrainEntity) =>
  `[[${entityKey(e)}|${e.name}]] (${e.type})${e.description ? ` — ${clip(e.description, 200)}` : ''}${(e.ownerName ?? e.owner) ? `; owner ${e.ownerName ?? e.owner}` : ''}${Object.keys(e.attrs).length ? `; ${Object.entries(e.attrs).slice(0, 8).map(([k, v]) => `${k}: ${clip(String(v), 60)}`).join(', ')}` : ''}`;
/** A link with the page's name in it, so the model writes names it was given rather than guessing them from ids. */
const linkOf = (ref: string, index: PageIndex) => `[[${ref}|${index.byRef.get(ref)?.name ?? ref.split('/')[1]}]]`;
const workLine = (w: WorkItem, n: number, index: PageIndex) => {
  const by = w.actor ? (personRef(index, w.actor) ? linkOf(personRef(index, w.actor)!, index) : w.actor) : undefined;
  const pages = w.refs.filter((r) => !r.startsWith('person/'));
  return `[${n}] ${day(w.at)} ${w.kind}${w.source ? ` (${w.source})` : ''}: ${clip(w.title, 140)}${w.summary ? ` — ${clip(w.summary, 220)}` : ''}${by ? ` · by ${by}` : ''}${w.team ? ` · team ${w.team}` : ''}${pages.length ? ` · about ${pages.map((r) => linkOf(r, index)).join(' ')}` : ''}`;
};
const factLine = (f: BrainFact) => `- ${f.subjectName ?? f.subjectId} (${f.kind}): ${clip(f.statement, 240)}`;

/** Write (or rewrite) a page's summary with the brain's model and keep it. */
export async function writeSummary(entity: BrainEntity, scope: UsageScope | undefined, viewer: Viewer, options: { model?: LanguageModel; signal?: AbortSignal } = {}, db: Database = database()): Promise<WikiSummary> {
  const model = brainModel(options.model);
  if (!model) throw new WikiError('The brain has no model (LANDFLOW_BRAIN_MODEL is off)', 409);
  // A summary is shown to everyone who can open the page: it is written from the shared view, never the caller's private work.
  const shared = sharedScope(scope);
  const page = wikiPage(entity, shared, viewer, false, db);
  const index = pageIndex(listEntities({ scope: shared, limit: 2_000 }, db));
  const prompt = [
    `Write the summary at the top of the wiki page for ${entity.name} (${entity.type}).`,
    '',
    'The page:',
    pageLine(entity),
    page.facts.length ? `\nWhat the brain learned about it:\n${page.facts.slice(0, 20).map(factLine).join('\n')}` : '',
    page.work.length ? `\nIts latest work, newest first:\n${page.work.slice(0, 40).map((w, i) => workLine(w, i + 1, index)).join('\n')}` : '\nNo work names it yet.',
    page.people.length ? `\nPeople on it: ${page.people.slice(0, 12).map((p) => `${p.ref ? `[[${p.ref}|${p.name}]]` : p.name}${p.team ? ` (${p.team})` : ''}, ${p.events} items`).join('; ')}` : '',
    page.related.length ? `\nPages it shares work with: ${page.related.map((r) => `[[${r.ref}|${r.name}]] (${r.shared} items)`).join('; ')}` : '',
    page.proposals.length ? `\nOpen suggestions about it: ${page.proposals.map((p) => p.title).join('; ')}` : '',
    '',
    'Write 2 to 4 short paragraphs in plain language: what it is, who works on it and which teams, what happened lately, and anything that looks duplicated, blocked or at risk.',
    'Use only what is above; say plainly what is not known. Call people and pages by the names given, never by their ids or email addresses.',
    'Link a person or page you mention by copying its link from above, as [[type/id|Name]]. After a sentence that comes from a work item, put its number, like [3]. No headings, no bullet lists.',
    'Reply with JSON: {"summary": "..."}',
  ]
    .filter((line) => line !== '')
    .join('\n');
  let reply: string;
  try {
    const turn = await model.generate({ system: 'You keep a company wiki written from its work tools. You are accurate and brief. Reply with JSON only.', messages: [{ role: 'user', content: prompt }], tools: [], responseFormat: 'json', ...(options.signal && { signal: options.signal }) });
    reply = turn.text ?? '';
  } catch (caught) {
    logger.warn('brain wiki: summary failed', { 'landflow.entity': entityKey(entity), error: (caught as Error).message });
    throw new WikiError(`The model failed: ${(caught as Error).message}`, 502);
  }
  const summary = jsonText(reply, 'summary');
  if (!summary) throw new WikiError('The model wrote nothing', 502);
  const shown = [...page.people.filter((p) => p.ref).map((p) => ({ ref: p.ref!, name: p.name })), ...page.related, ...page.work.flatMap((w) => w.refs).map((ref) => ({ ref, name: index.byRef.get(ref)?.name ?? '' }))];
  const textOut = linkMentions(keepKnownLinks(summary.slice(0, 4_000), index), shown, entityKey(entity));
  const generatedAt = new Date().toISOString();
  db.upsert('brain_pages', { subject: entityKey(entity), summary: textOut, model: `${model.provider}/${model.model}`, basis: basisOf(entity, page.facts, page.work), generated_at: generatedAt });
  return { text: textOut, model: `${model.provider}/${model.model}`, generatedAt, stale: false, links: linksIn(textOut, index) };
}

const STOP = new Set(['the', 'and', 'for', 'with', 'who', 'what', 'which', 'when', 'where', 'why', 'how', 'are', 'was', 'were', 'is', 'on', 'in', 'of', 'to', 'a', 'an', 'it', 'its', 'this', 'that', 'there', 'about', 'any', 'all', 'our', 'we', 'do', 'does', 'did', 'has', 'have', 'from', 'working', 'work', 'team', 'teams']);
const wordsOf = (q: string) => [...new Set(q.toLowerCase().split(/[^a-z0-9@._-]+/).filter((w) => w.length >= 3 && !STOP.has(w)))];
const hits = (haystack: string, words: string[]) => words.reduce((n, w) => n + (haystack.includes(w) ? 1 : 0), 0);

export interface AskOptions {
  model?: LanguageModel;
  signal?: AbortSignal;
  vectorHits?: string[];
  about?: string;
  /** Earlier turns of the conversation: the last two count. */
  history?: AskTurn[];
}

/** The last two turns, each part cut to 1,500 characters; empty turns dropped. */
export function clampHistory(history: AskTurn[] | undefined): AskTurn[] {
  return (history ?? [])
    .filter((t) => t.question?.trim() && t.answer?.trim())
    .slice(-ASK_HISTORY_TURNS)
    .map((t) => ({ question: clip(t.question.trim(), ASK_HISTORY_CHARS), answer: clip(t.answer.trim(), ASK_HISTORY_CHARS) }));
}

/** How many work items the text cites, as the numbers of the ones it names (valid `[n]` only, in order, no repeats). */
export function citedNumbers(textIn: string, sources: number): number[] {
  const out: number[] = [];
  for (const match of textIn.matchAll(CITATION)) {
    const n = Number(match[1]);
    if (n >= 1 && n <= sources && !out.includes(n)) out.push(n);
  }
  return out;
}

// `[n]` and not part of a `[[link]]` or a Markdown link.
const CITATION = /(?<!\[)\[(\d{1,3})\](?![\]([])/g;

/** Drop the `[n]` markers that point at no source: any marker when there are none, a number past the last one. */
export function cleanCitations(textIn: string, sources: number | unknown[]): string {
  const count = Array.isArray(sources) ? sources.length : sources;
  let dropped = false;
  const out = textIn.replace(new RegExp(`( ?)${CITATION.source}`, 'g'), (whole, _space: string, n: string) => {
    if (Number(n) >= 1 && Number(n) <= count) return whole;
    dropped = true;
    return '';
  });
  return dropped ? out.replace(/ +([.,;:!?])/g, '$1') : out;
}

/** What an ask found: the pages, facts and work the question reaches, and the pieces the prompt is built from. */
export interface Gathered {
  question: string;
  index: PageIndex;
  pages: BrainEntity[];
  facts: BrainFact[];
  work: WorkItem[];
  about?: BrainEntity;
  history: AskTurn[];
  found: WikiAnswer;
}

/** Find what a question is about, among what the caller can see. `onPhase` hears how long each part took. */
export function gatherAsk(question: string, scope: UsageScope | undefined, options: Pick<AskOptions, 'vectorHits' | 'about' | 'history'> = {}, db: Database = database(), onPhase?: (phase: 'pages' | 'facts' | 'work', ms: number) => void): Gathered {
  const q = question.trim().slice(0, 500);
  if (!q) throw new WikiError('Ask a question');
  const history = clampHistory(options.history);
  // A short follow-up ("and since when?") carries few words of its own: it borrows the last question's.
  const own = wordsOf(q);
  const borrow = own.length <= 3 && history.length > 0;
  const words = borrow ? [...new Set([...own, ...wordsOf(history.at(-1)!.question)])] : own;
  let started = Date.now();
  const lap = (phase: 'pages' | 'facts' | 'work') => {
    onPhase?.(phase, Date.now() - started);
    started = Date.now();
  };
  const entities = listEntities({ scope, limit: 2_000 }, db);
  const index = pageIndex(entities);
  const pages = entities
    .map((e) => ({ e, score: hits(e.name.toLowerCase(), words) * 3 + hits(`${e.description ?? ''} ${e.ownerName ?? e.owner ?? ''} ${Object.values(e.attrs).join(' ')}`.toLowerCase(), words) }))
    .filter((p) => p.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map((p) => p.e);
  // Asked from a page: that page comes first, whatever the words.
  const about = options.about ? index.byRef.get(options.about) : undefined;
  if (about) pages.splice(0, pages.length, about, ...pages.filter((p) => entityKey(p) !== options.about));
  const pageRefs = new Set(pages.map(entityKey));
  lap('pages');
  const facts = [
    ...searchFacts(borrow ? `${q} ${history.at(-1)!.question}` : q, { scope, limit: 12, ...(options.vectorHits && { vectorHits: options.vectorHits }) }, db),
    ...pages.flatMap((p) => listFacts({ subjectType: 'entity', subjectId: entityKey(p), scope, limit: 5 }, db)),
  ].filter((f, i, all) => all.findIndex((g) => g.id === f.id) === i).slice(0, 20);
  lap('facts');
  const work = workEvents(PAGE_DAYS, scope, db)
    .map((e) => workItem(e, index))
    .map((w) => ({ w, score: (about && w.refs.includes(entityKey(about)) ? 3 : 0) + hits(`${w.title ?? ''} ${w.summary ?? ''} ${w.customer ?? ''} ${w.initiative ?? ''} ${w.team ?? ''} ${w.actor ?? ''} ${w.kind}`.toLowerCase(), words) + (w.refs.some((r) => pageRefs.has(r)) ? 2 : 0) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || b.w.at.localeCompare(a.w.at))
    .slice(0, 15)
    .map((x) => x.w);
  // The pages the work names are part of the answer's reach too.
  for (const ref of work.flatMap((w) => w.refs)) {
    const e = index.byRef.get(ref);
    if (e && !pageRefs.has(ref) && pages.length < 14) {
      pages.push(e);
      pageRefs.add(ref);
    }
  }
  lap('work');
  const found: WikiAnswer = { question: q, pages: pages.map((e) => ({ type: e.type, id: e.id, name: e.name })), facts, work, ...(about && { about: entityKey(about) }) };
  return { question: q, index, pages, facts, work, history, found, ...(about && { about }) };
}

export const ASK_SYSTEM = 'You are the company’s second brain. You answer from its wiki and work log, accurately and briefly.';

/** The prompt of an ask. `json` asks for `{"answer": "..."}`; otherwise the answer alone, so it can stream as it is written. */
export function askPrompt(g: Gathered, format: 'json' | 'text', db: Database = database()): string {
  const { question, pages, facts, work, about, index, history } = g;
  const summaries = new Map(db.all<PageRow>(`SELECT * FROM brain_pages WHERE subject IN (${pages.map(() => '?').join(',') || "''"})`, ...pages.map(entityKey)).map((r) => [r.subject, r.summary]));
  return [
    history.length ? `The conversation so far (earlier turns, for context only; the rules below are unchanged):\n${history.map((t) => `Question: ${t.question}\nAnswer: ${t.answer}`).join('\n\n')}\n` : '',
    `${history.length ? 'New question' : 'Question'}: ${question}`,
    about ? `It was asked on the page [[${entityKey(about)}]] ${about.name}: read it as about that page.` : '',
    pages.length ? `\nPages:\n${pages.map((e) => `${pageLine(e)}${summaries.has(entityKey(e)) ? `\n  Summary: ${clip(summaries.get(entityKey(e)), 600)}` : ''}`).join('\n')}` : '',
    facts.length ? `\nFacts:\n${facts.map(factLine).join('\n')}` : '',
    work.length ? `\nWork, most relevant first:\n${work.map((w, i) => workLine(w, i + 1, index)).join('\n')}` : '',
    '',
    `Answer the question from the context above only, in 2 to 6 sentences or a short list. Call people and pages by the names given; link them by copying their link, as [[type/id|Name]].${work.length ? ' Cite a work item as [n], using only the numbers listed above.' : ' There is no numbered work above: write no [n] markers.'}`,
    format === 'json' ? 'If the context does not answer it, say so and say what is missing. Reply with JSON: {"answer": "..."}' : 'If the context does not answer it, say so and say what is missing. Reply with the answer only, no JSON.',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

/** The answer a model wrote, made safe to show: links to unknown pages dropped, plain names linked, citations that point at nothing removed. */
export function finishAnswer(raw: string, g: Gathered): { text: string; links: WikiLink[]; cited: number[] } | undefined {
  const trimmed = raw.trim();
  const answer = trimmed.startsWith('{') ? jsonText(trimmed, 'answer') : trimmed;
  if (!answer) return undefined;
  const linked = linkMentions(keepKnownLinks(answer.slice(0, 4_000), g.index), [...g.pages.map((e) => ({ ref: entityKey(e), name: e.name })), ...g.work.flatMap((w) => w.refs).map((ref) => ({ ref, name: g.index.byRef.get(ref)?.name ?? '' }))]);
  const text = cleanCitations(linked, g.work.length);
  return { text, links: linksIn(text, g.index), cited: citedNumbers(text, g.work.length) };
}

/** Answer a question from the pages, facts and work the caller can see. Without a model, only what it found. */
export async function askBrain(question: string, scope: UsageScope | undefined, viewer: Viewer, options: AskOptions = {}, db: Database = database()): Promise<WikiAnswer> {
  const g = gatherAsk(question, scope, options, db);
  const { found, pages, facts, work } = g;
  const model = brainModel(options.model);
  if (!model) return found;
  if (!pages.length && !facts.length && !work.length) return { ...found, answer: 'The brain has nothing about that yet.', model: `${model.provider}/${model.model}` };
  try {
    // Metered under the asker, like every other chat (docs/observability.md).
    const turn = await runInUsageScope(assistantScope({ surface: 'brain', ...(viewer?.id && { userId: viewer.id }) }), () =>
      model.generate({ system: `${ASK_SYSTEM} Reply with JSON only.`, messages: [{ role: 'user', content: askPrompt(g, 'json', db) }], tools: [], responseFormat: 'json', ...(options.signal && { signal: options.signal }) }),
    );
    const done = finishAnswer(turn.text ?? '', g);
    return { ...found, ...(done && { answer: done.text, links: done.links, cited: done.cited }), model: `${model.provider}/${model.model}` };
  } catch (caught) {
    logger.warn('brain wiki: ask failed', { error: (caught as Error).message });
    return { ...found, model: `${model.provider}/${model.model}`, note: `The model failed: ${(caught as Error).message}` };
  }
}
