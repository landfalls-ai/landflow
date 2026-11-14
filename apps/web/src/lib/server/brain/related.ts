/**
 * Related colleagues (docs/work-and-briefings.md#related-colleagues): the people whose shared work of the last two days
 * overlaps the caller's own, and why. The ranking is pure (`rankRelated`); `relatedFor` fetches the rows through the
 * ledger's one visibility rule, so a colleague's `team` item reaches only the people who share a project with them,
 * an `org` item everyone, and a private one nobody.
 */
import { database, type Database } from '../db';
import { getUser } from '../auth/users';
import { searchTerms } from '../rag/search';
import type { Actor } from '../projects/access';
import { scopeClause } from '../usage/query';
import { fromRow, type UsageRow } from '../usage/ledger';
import type { RelatedColleague, WorkItem, WorkVisibility } from '../../shared/brain-work';

/** A ledger row as the briefing lists it. */
export function itemOf(row: UsageRow): WorkItem {
  const event = fromRow(row);
  const attrs = event.attrs ?? {};
  const text = (name: string) => (typeof attrs[name] === 'string' && attrs[name] ? String(attrs[name]) : undefined);
  const areas = text('areas')?.split(',').filter(Boolean);
  return {
    id: event.id,
    sourceId: row.source_id ?? '',
    source: row.source ?? text('source') ?? '',
    kind: event.kind,
    title: text('title') ?? event.message ?? '',
    ...(text('summary') && { summary: text('summary') }),
    ...(text('repo') && { repo: text('repo') }),
    ...(areas?.length && { areas }),
    at: event.at,
    ...(text('endedAt') && { endedAt: text('endedAt') }),
    ...(text('url') && { url: text('url') }),
    visibility: (row.visibility ?? 'private') as WorkVisibility,
  };
}

export const RELATED_PEOPLE = 5;
export const RELATED_ITEMS = 3;
export const RELATED_DAYS = 2;
/** The same floor the similar module uses (brain/similar.ts `minScore`). */
export const SIMILAR_MIN_SCORE = 0.15;

type Because = RelatedColleague['because'];

/** A work item with the hints the overlap compares. */
export interface Overlappable {
  item: WorkItem;
  initiative?: string;
  customer?: string;
}

/** A colleague's shared item, with who it is. */
export interface ColleagueItem extends Overlappable {
  person: RelatedColleague['person'];
}

/** How strong each reason is; the strongest one is the person's `because`. */
const STRENGTH: Record<Because['type'], number> = { repo: 5, initiative: 4, customer: 3, area: 2, similar: 1 };

const norm = (value: string | undefined) => value?.trim().toLowerCase() || undefined;
const stem = (term: string) => (term.length > 4 ? term.replace(/(ing|ed|es|s)$/, '') : term);
const termsOf = (text: string) => new Set(searchTerms(text).map(stem));

/** The words two texts share, over the geometric mean of their sizes (0..1). */
export function textOverlap(a: string, b: string): number {
  const left = termsOf(a);
  const right = termsOf(b);
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const term of left) if (right.has(term)) shared++;
  return shared / Math.sqrt(left.size * right.size);
}

const textOf = (item: WorkItem) => `${item.title} ${item.summary ?? ''}`;

/** Why `theirs` relates to any of `mine`, or undefined when it doesn't. */
export function becauseOf(mine: Overlappable[], theirs: Overlappable): Because | undefined {
  const repo = norm(theirs.item.repo);
  const hit = (pick: (o: Overlappable) => string | undefined) => {
    const value = norm(pick(theirs));
    return value ? mine.find((m) => norm(pick(m)) === value) : undefined;
  };
  if (repo && hit((o) => o.item.repo)) return { type: 'repo', name: theirs.item.repo! };
  if (theirs.initiative && hit((o) => o.initiative)) return { type: 'initiative', name: theirs.initiative };
  if (theirs.customer && hit((o) => o.customer)) return { type: 'customer', name: theirs.customer };
  const mineAreas = new Set(mine.flatMap((m) => m.item.areas ?? []).map((a) => a.toLowerCase()));
  // A repository's directories only mean the same thing inside the same repository, but two people naming one area is a lead.
  const area = (theirs.item.areas ?? []).find((a) => mineAreas.has(a.toLowerCase()));
  if (area) return { type: 'area', name: area };
  if (theirs.item.summary && mine.some((m) => m.item.summary && textOverlap(textOf(m.item), textOf(theirs.item)) >= SIMILAR_MIN_SCORE)) return { type: 'similar', name: theirs.item.title };
  return undefined;
}

/**
 * The colleagues to show: for each person, the items that relate to `mine`, with the strongest reason; at most
 * `RELATED_PEOPLE` people (strongest reason first, then the newest item) and `RELATED_ITEMS` items each.
 */
export function rankRelated(mine: Overlappable[], colleagues: ColleagueItem[]): RelatedColleague[] {
  if (!mine.length) return [];
  const byPerson = new Map<string, { person: RelatedColleague['person']; items: WorkItem[]; because: Because }>();
  for (const theirs of colleagues) {
    const because = becauseOf(mine, theirs);
    if (!because) continue;
    const key = theirs.person.userId ?? theirs.person.name;
    const entry = byPerson.get(key);
    if (!entry) byPerson.set(key, { person: theirs.person, items: [theirs.item], because });
    else {
      entry.items.push(theirs.item);
      if (STRENGTH[because.type] > STRENGTH[entry.because.type]) entry.because = because;
    }
  }
  const newest = (c: { items: WorkItem[] }) => c.items.reduce((max, i) => (i.at > max ? i.at : max), '');
  return [...byPerson.values()]
    .sort((a, b) => STRENGTH[b.because.type] - STRENGTH[a.because.type] || newest(b).localeCompare(newest(a)))
    .slice(0, RELATED_PEOPLE)
    .map((entry) => ({ person: entry.person, items: [...entry.items].sort((a, b) => b.at.localeCompare(a.at)).slice(0, RELATED_ITEMS), because: entry.because }));
}

const hintOf = (row: UsageRow, name: string): string | undefined => {
  const value = fromRow(row).attrs?.[name];
  return typeof value === 'string' && value ? value : undefined;
};

export const overlappable = (row: UsageRow): Overlappable => ({ item: itemOf(row), initiative: hintOf(row, 'initiative'), customer: hintOf(row, 'customer') });

/** Colleagues' work of the last `RELATED_DAYS` days that `actor` may read, newest first. */
export function colleagueRows(actor: Actor, now: number, db: Database = database()): UsageRow[] {
  const where = ["kind LIKE 'work.%'", 'source_id IS NOT NULL', 'owner_id <> ?', 'at >= ?'];
  const params: Array<string | number> = [actor.id, new Date(now - RELATED_DAYS * 86_400_000).toISOString()];
  scopeClause({ viewerId: actor.id }, where, params);
  return db.all<UsageRow>(`SELECT * FROM usage_events WHERE ${where.join(' AND ')} ORDER BY at DESC LIMIT 500`, ...params);
}

/** The briefing's `related`: `mine` are the caller's own items (today and yesterday). */
export function relatedFor(actor: Actor, mine: UsageRow[], now: number, db: Database = database()): RelatedColleague[] {
  if (!mine.length) return [];
  const rows = colleagueRows(actor, now, db);
  // An item its owner also posted as an update (`work.self_update`, `attrs.of`) is listed once, as the update.
  const posted = new Set(rows.filter((row) => row.kind === 'work.self_update').map((row) => `${row.owner_id}|${hintOf(row, 'of') ?? ''}`));
  const colleagues: ColleagueItem[] = rows.filter((row) => !posted.has(`${row.owner_id}|${row.source}:${row.source_id}`)).map((row) => {
    const user = row.owner_id ? getUser(row.owner_id) : undefined;
    return { ...overlappable(row), person: { name: user?.name?.trim() || user?.email || 'Someone', ...(row.owner_id && { userId: row.owner_id }) } };
  });
  return rankRelated(mine.map(overlappable), colleagues);
}
