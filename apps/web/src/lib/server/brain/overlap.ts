/**
 * The work-overlap detector (docs/second-brain.md#work-overlap): two people whose shared work of the last three days
 * is about the same thing get one introduction, a suggestion addressed to both. The ranking is pure (`rankOverlaps`);
 * `overlapFindings` makes the one query. Only `org` work is read: never a private item, and not a `team` one, because the
 * card's target is the instance and so instance admins can open it, and a `team` title is for the owner's project mates
 * only (a card only its audience reads would let team work in; scope.ts `canProposal` would have to refuse the rest).
 * Both people read the same card, so it carries only titles anyone may open. No Slack message is sent on its own.
 */
import type { ProposalEvidence } from '../../shared/brain';
import type { WorkItem } from '../../shared/brain-work';
import { getUser } from '../auth/users';
import type { Database } from '../db';
import { fromRow, type UsageRow } from '../usage/ledger';
import { textOverlap, SIMILAR_MIN_SCORE, itemOf, overlappable, type Overlappable } from './related';
import { fingerprintOf } from './proposals';

const DAY_MS = 86_400_000;
/** How far back the shared work is read, and how long before the same two people are introduced again. */
export const OVERLAP_DAYS = 3;
export const INTRODUCED_DAYS = 14;
/** At most this many titles of each person on the card. */
const TITLES = 3;
const MAX_ROWS = 500;
const MAX_PAIRS = 5;

/** A shared work item with who owns it. */
export interface OwnedItem extends Overlappable {
  ownerId: string;
}

export interface Overlap {
  /** The two user ids, sorted. */
  pair: [string, string];
  /** What they share: an initiative, a customer, a directory of the same repository (`area`) or similar words (see `sharedThing`). */
  thing: { type: 'initiative' | 'customer' | 'area' | 'similar'; name: string };
  /** Each person's items the other may open: `[for the first, for the second]` are theirs, listed by owner. */
  items: Record<string, WorkItem[]>;
  newest: string;
}

/** Whether `viewer` may open `item` of its owner: `org` by anyone, `team` by a person sharing a project with the owner. */
export function mayOpen(viewer: string, item: OwnedItem, teammates: ReadonlyMap<string, ReadonlySet<string>>): boolean {
  if (item.ownerId === viewer) return true;
  if (item.item.visibility === 'org') return true;
  return item.item.visibility === 'team' && Boolean(teammates.get(viewer)?.has(item.ownerId));
}

/**
 * What two sets of items share: an initiative, a customer, a directory of the same repository, or similar words. A bare
 * directory name across different repositories (or with no repository) is no lead, so `becauseOf`'s own `repo` and
 * `area` answers are not used.
 */
export function sharedThing(a: OwnedItem[], b: OwnedItem[]): Overlap['thing'] | undefined {
  const norm = (value: string | undefined) => value?.trim().toLowerCase() || undefined;
  const common = (pick: (o: OwnedItem) => string | undefined) => {
    const mine = new Set(a.map((o) => norm(pick(o))).filter(Boolean));
    return b.map(pick).find((value) => norm(value) && mine.has(norm(value)));
  };
  const initiative = common((o) => o.initiative);
  if (initiative) return { type: 'initiative', name: initiative };
  const customer = common((o) => o.customer);
  if (customer) return { type: 'customer', name: customer };
  for (const theirs of b) {
    const repo = norm(theirs.item.repo);
    if (!repo) continue;
    const own = a.filter((m) => norm(m.item.repo) === repo);
    const same = (theirs.item.areas ?? []).find((area) => own.some((m) => (m.item.areas ?? []).some((x) => x.toLowerCase() === area.toLowerCase())));
    if (same) return { type: 'area', name: `${theirs.item.repo}/${same}` };
  }
  for (const theirs of b) {
    if (!theirs.item.summary) continue;
    const text = (o: OwnedItem) => `${o.item.title} ${o.item.summary}`;
    if (a.some((m) => m.item.summary && textOverlap(text(m), text(theirs)) >= SIMILAR_MIN_SCORE)) return { type: 'similar', name: theirs.item.title };
  }
  return undefined;
}

/**
 * The introductions to make. `pairs` are not made again (introduced lately, or muted); each person's titles are only
 * those the other may open, and a pair with a side that has none to show is left out.
 */
export function rankOverlaps(items: OwnedItem[], teammates: ReadonlyMap<string, ReadonlySet<string>>, skip: (a: string, b: string) => boolean = () => false): Overlap[] {
  const byOwner = new Map<string, OwnedItem[]>();
  // Only `org` work: the card is readable by instance admins (its target is the instance), who may not open a `team`
  // item of a project they are outside, and private work is never read. Team work waits for a card only its audience reads.
  for (const item of items) if (item.item.visibility === 'org') byOwner.set(item.ownerId, [...(byOwner.get(item.ownerId) ?? []), item]);
  const owners = [...byOwner.keys()].sort();
  const out: Overlap[] = [];
  for (let i = 0; i < owners.length; i++) {
    for (let j = i + 1; j < owners.length; j++) {
      const [a, b] = [owners[i], owners[j]];
      if (skip(a, b)) continue;
      // Each side's items, only the ones the other may open: the card goes to both.
      const left = byOwner.get(a)!.filter((item) => mayOpen(b, item, teammates));
      const right = byOwner.get(b)!.filter((item) => mayOpen(a, item, teammates));
      if (!left.length || !right.length) continue;
      const thing = sharedThing(left, right);
      if (!thing) continue;
      const newest = (list: OwnedItem[]) => list.map((x) => x.item.at).sort().at(-1) ?? '';
      const sorted = (list: OwnedItem[]) => [...list].sort((x, y) => y.item.at.localeCompare(x.item.at)).slice(0, TITLES).map((x) => x.item);
      out.push({ pair: [a, b], thing, items: { [a]: sorted(left), [b]: sorted(right) }, newest: [newest(left), newest(right)].sort().at(-1)! });
    }
  }
  return out.sort((x, y) => y.newest.localeCompare(x.newest)).slice(0, MAX_PAIRS);
}

/**
 * The people each person shares a non-personal project with. Kept for when `team` work is let in: `rankOverlaps` keeps
 * `org` work only today (`mayOpen` already knows the `team` rule), so no detector needs it for now.
 */
export function teammatesOf(db: Database): Map<string, Set<string>> {
  const rows = db.all<{ a: string; b: string }>(
    `SELECT DISTINCT m1.user_id AS a, m2.user_id AS b FROM project_members m1 JOIN projects p ON p.id = m1.project_id JOIN project_members m2 ON m1.project_id = m2.project_id WHERE p.type <> 'personal' AND m1.user_id <> m2.user_id`,
  );
  const out = new Map<string, Set<string>>();
  for (const { a, b } of rows) out.set(a, (out.get(a) ?? new Set()).add(b));
  return out;
}

/** The fingerprint of one pair: the same two people share it whatever the thing, so one introduction covers a fortnight. */
export const pairFingerprint = (a: string, b: string) => fingerprintOf('work-overlap', ...[a, b].sort());

/** `org` work of the last `OVERLAP_DAYS` days, newest first. Private and team work is not selected. */
function sharedRows(db: Database, now: number): UsageRow[] {
  return db.all<UsageRow>(
    `SELECT * FROM usage_events WHERE kind LIKE 'work.%' AND source_id IS NOT NULL AND owner_id IS NOT NULL AND visibility = 'org' AND at >= ? ORDER BY at DESC LIMIT ${MAX_ROWS}`,
    new Date(now - OVERLAP_DAYS * DAY_MS).toISOString(),
  );
}

const ofOf = (row: UsageRow): string => {
  const value = fromRow(row).attrs?.of;
  return typeof value === 'string' ? value : '';
};

interface Stored {
  fingerprint: string;
  data: string;
}

/**
 * Pairs not to introduce: those with a suggestion of this detector made in the last 14 days, whatever became of it, and
 * every pair with a person who dismissed one with "Don't suggest this again" (`intended`).
 */
function skipper(db: Database, now: number): (a: string, b: string) => boolean {
  const recent = new Set<string>();
  const muted = new Set<string>();
  // Recent ones, and those dismissed as "intended" whatever their age: older rows hold nothing else this needs.
  const rows = db.all<Stored & { created_at: string }>(
    `SELECT fingerprint, created_at, data FROM proposals WHERE detector = 'work-overlap' AND (created_at >= ? OR status = 'dismissed')`,
    new Date(now - INTRODUCED_DAYS * DAY_MS).toISOString(),
  );
  for (const row of rows) {
    if (Date.parse(row.created_at) >= now - INTRODUCED_DAYS * DAY_MS) recent.add(row.fingerprint);
    try {
      const p = JSON.parse(row.data) as { status?: string; reason?: string; decision?: { by?: string }; audience?: Array<{ userId?: string }> };
      // Only one of the two people muting counts: a Slack-side decision (`slack:<id>`) or an admin's mutes no one.
      const by = p.decision?.by;
      if (p.status === 'dismissed' && p.reason === 'intended' && by && p.audience?.some((m) => m.userId === by)) muted.add(by);
    } catch {
      // A row that does not parse holds nothing.
    }
  }
  return (a, b) => recent.has(pairFingerprint(a, b)) || muted.has(a) || muted.has(b);
}

const nameOf = (id: string) => {
  const user = getUser(id);
  return user?.name?.trim() || user?.email || 'A colleague';
};

const titleOf = (thing: Overlap['thing']) => (thing.type === 'similar' ? 'similar work' : thing.name);

/** The introductions as suggestions' fields, for the detector (detectors.ts). */
export function overlapFindings(db: Database, now: number, quiet = 1): Array<{ overlap: Overlap; title: string; why: string; evidence: ProposalEvidence[]; audience: Array<{ userId: string; name: string; email?: string }> }> {
  const rows = sharedRows(db, now);
  // An item its owner also posted as an update (`work.self_update`, `attrs.of`) is counted once, as the update.
  const posted = new Set(rows.filter((row) => row.kind === 'work.self_update').map((row) => `${row.owner_id}|${ofOf(row)}`));
  const items: OwnedItem[] = rows.filter((row) => !posted.has(`${row.owner_id}|${row.source}:${row.source_id}`)).map((row) => ({ ...overlappable(row), item: itemOf(row), ownerId: row.owner_id! })).filter((i) => i.item.title);
  // A detector people mostly dismiss needs more: each side must show `quiet` items (rounded up) before it speaks.
  const min = Math.ceil(quiet);
  return rankOverlaps(items, teammatesOf(db), skipper(db, now)).filter((o) => o.pair.every((id) => o.items[id].length >= min)).map((overlap) => {
    const [a, b] = overlap.pair;
    const [na, nb] = [nameOf(a), nameOf(b)];
    return {
      overlap,
      // The card goes to both, so the title names the pair; each person reads it as "You and ...".
      title: `${na} and ${nb} are both on ${titleOf(overlap.thing)}`,
      why: `${na} and ${nb} each shared work on ${titleOf(overlap.thing)} in the last ${OVERLAP_DAYS} days. A short word between you may save the same work being done twice. Nothing is shared by this suggestion beyond the titles below, which each of you may already open.`,
      evidence: [a, b].flatMap((id) => overlap.items[id].map((item) => ({ label: nameOf(id), value: item.title, ...(item.url && { href: item.url }) }))),
      audience: [a, b].map((id) => ({ userId: id, name: nameOf(id), ...(getUser(id)?.email && { email: getUser(id)!.email }) })),
    };
  });
}
