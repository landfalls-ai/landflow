/**
 * The memory graph's data (docs/second-brain.md#the-graph): a page of facts as nodes with their subjects, an `about` edge
 * from each fact to its subject and, with history on, a version edge from each version's parent. What the caller may see
 * is decided by the same scope as the facts list (`scopeForActor`, `canFact`); statements are plain text.
 *
 * `pageFacts` below is the keyset page over `listFacts` this package needs. C07 (P7) adds the SQL version with the scope in
 * the query; when it lands `readFacts` swaps for it and nothing else here changes.
 */
import { logger } from '../telemetry/logger';
import { agentStore } from '../agents/store';
import { type Actor } from '../projects/access';
import { store } from '../store';
import { decodeCursor, encodeCursor } from '../pagination';
import { getProfile, listFacts } from './facts';
import { getEntity } from './entities';
import { canFact, scopeForActor } from './scope';
import { wikiPage } from './wiki';
import { FACT_SUBJECTS, parseEntityRef, type BrainFact, type FactSubject } from '../../shared/brain';
import { factNodeId, subjectNodeId, type GraphEdge, type GraphFactNode, type GraphNode, type GraphPage, type GraphQuery, type GraphSubjectNode } from '../../shared/brain-graph';

/** Subjects a graph page reads at depth 2 (the spec's bound). */
export const MAX_NEIGHBOURS = 50;
/** The most facts one request reads before paging. */
export const READ_CAP = 20_000;

export interface SubjectKey {
  subjectType: FactSubject;
  subjectId: string;
}

/**
 * A subject key as the route takes it: `workflow/<id>`, `agent/<id>`, `entity/<type>/<id>`, or an entity page's own
 * `<type>/<id>` (`customer/acme`). Undefined when it names nothing this module knows.
 */
export function parseSubject(key: string): SubjectKey | undefined {
  const slash = key.indexOf('/');
  if (slash <= 0) return undefined;
  const head = key.slice(0, slash);
  const rest = key.slice(slash + 1);
  if (!rest) return undefined;
  if (head === 'agent-user') return undefined; // private to one person: never a subject of a shared graph
  if (head === 'entity') return parseEntityRef(rest) ? { subjectType: 'entity', subjectId: rest } : undefined;
  if (parseEntityRef(key)) return { subjectType: 'entity', subjectId: key };
  return (FACT_SUBJECTS as readonly string[]).includes(head) && head !== 'entity' ? { subjectType: head as FactSubject, subjectId: rest } : undefined;
}

/** The page ref (`customer/acme`) a subject opens in the Brain workbench, when it has one. */
const pageOf = (s: SubjectKey): string | undefined => (s.subjectType === 'entity' ? s.subjectId : undefined);

function nameOf(s: SubjectKey, hint?: string): string {
  if (s.subjectType === 'workflow') return store.getWorkflow(s.subjectId)?.name ?? hint ?? s.subjectId;
  if (s.subjectType === 'agent') return agentStore.get(s.subjectId)?.name ?? hint ?? s.subjectId;
  if (s.subjectType === 'entity') {
    const ref = parseEntityRef(s.subjectId);
    return (ref && getEntity(ref.type, ref.id)?.name) || hint || s.subjectId;
  }
  return s.subjectType === 'instance' ? 'This instance' : (hint ?? s.subjectId);
}

/** Whether a fact is hidden (forgotten, or past its forget-after time). */
const isForgotten = (f: BrainFact, now: string) => Boolean(f.forgottenAt || (f.forgetAfter && f.forgetAfter <= now));

/** Newest first, then by id, so a cursor `{ s: lastSeen, i: id }` names a position in a stable order. */
const byPosition = (a: BrainFact, b: BrainFact) => (a.lastSeen === b.lastSeen ? (a.id < b.id ? -1 : 1) : a.lastSeen < b.lastSeen ? 1 : -1);

/** The facts the caller may see for `query`, in page order, before paging; `truncated` when the read hit `READ_CAP`. */
function readFacts(actor: Actor | undefined, query: GraphQuery, subjects: SubjectKey[], now: string, cap: number): { facts: BrainFact[]; truncated: boolean } {
  const scope = actor && scopeForActor(actor);
  const forgotten = query.forgotten ? ('include' as const) : ('exclude' as const);
  const base = { status: 'all' as const, scope, history: query.history, forgotten, limit: cap + 1, now };
  // One read per subject (or one for the whole brain), each asked for one fact past the cap so a hit is noticed.
  const reads = subjects.length ? subjects.map((s) => listFacts({ ...base, subjectType: s.subjectType, subjectId: s.subjectId })) : [listFacts(base)];
  const truncated = reads.some((r) => r.length > cap);
  const all = reads.flatMap((r) => r.slice(0, cap));
  // Whether the caller may restore a subject's facts is decided once per subject, not once per forgotten fact.
  const mayRestore = new Map<string, boolean>();
  const canRestore = (f: BrainFact) => {
    if (!actor) return false;
    const key = `${f.subjectType}\u0000${f.subjectId}`;
    if (!mayRestore.has(key)) mayRestore.set(key, canFact(actor, f, 'update'));
    return mayRestore.get(key)!;
  };
  const facts = all
    .filter((f) => (f.subjectType as string) !== 'agent-user') // a person's private notes about an agent never enter a shared graph
    .filter((f) => !isForgotten(f, now) || canRestore(f))
    .sort(byPosition);
  if (truncated) logger.warn('brain graph read hit its cap', { cap, forgotten: query.forgotten, history: query.history });
  return { facts, truncated };
}

/** The subjects one link away from `s` that `actor` may read (at most `MAX_NEIGHBOURS`). */
function neighbours(actor: Actor | undefined, s: SubjectKey): SubjectKey[] {
  const out: SubjectKey[] = [];
  const add = (n: SubjectKey) => {
    if (out.length >= MAX_NEIGHBOURS || (n.subjectType === s.subjectType && n.subjectId === s.subjectId)) return;
    if (actor && !canFact(actor, n, 'read')) return;
    if (!out.some((o) => o.subjectType === n.subjectType && o.subjectId === n.subjectId)) out.push(n);
  };
  if (s.subjectType === 'entity') {
    const ref = parseEntityRef(s.subjectId);
    const entity = ref && getEntity(ref.type, ref.id);
    // Without an actor (a flow) there is no scope to read the page through: its own facts only.
    if (entity && actor) for (const r of wikiPage(entity, scopeForActor(actor), actor, false).related) add({ subjectType: 'entity', subjectId: r.ref });
  } else if (s.subjectType === 'workflow' || s.subjectType === 'agent') {
    for (const use of getProfile(s.subjectType, s.subjectId)?.uses ?? []) if (use.type === 'workflow' || use.type === 'agent') add({ subjectType: use.type, subjectId: use.id });
  }
  return out;
}

/** One page of the graph for `actor` (undefined: no access check, for the instance's own use). */
export function brainGraph(actor: Actor | undefined, query: GraphQuery, now = new Date().toISOString(), cap = READ_CAP): GraphPage {
  const about = query.about ? parseSubject(query.about) : undefined;
  const subjects = about ? [about, ...(query.depth === 2 ? neighbours(actor, about) : [])] : [];
  const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;
  const read = readFacts(actor, query, subjects, now, cap);
  const ordered = read.facts.filter((f) => !cursor || f.lastSeen < cursor.s || (f.lastSeen === cursor.s && f.id > cursor.i));
  const page = ordered.slice(0, query.limit);
  const last = page.at(-1);

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const subjectsSeen = new Set<string>();
  const factIds = new Set(page.map((f) => f.id));
  // A subject asked for is a node even when it has no facts on this page (an empty page still says what it is about).
  const addSubject = (s: SubjectKey, hint?: string) => {
    const id = subjectNodeId(s.subjectType, s.subjectId);
    if (subjectsSeen.has(id)) return id;
    subjectsSeen.add(id);
    const node: GraphSubjectNode = { id, kind: 'subject', subjectType: s.subjectType, subjectId: s.subjectId, label: nameOf(s, hint), ...(pageOf(s) && { page: pageOf(s) }) };
    nodes.push(node);
    return id;
  };
  if (about && !cursor) addSubject(about);
  for (const f of page) {
    const subject = addSubject({ subjectType: f.subjectType, subjectId: f.subjectId }, f.subjectName);
    const node: GraphFactNode = {
      id: factNodeId(f.id),
      kind: 'fact',
      factId: f.id,
      chainId: f.rootId ?? f.id,
      statement: f.trimmed ? '' : f.statement,
      factKind: f.kind,
      version: f.version ?? 1,
      latest: f.latest ?? true,
      ...(f.relation && { relation: f.relation }),
      ...(f.parentId && { parentId: f.parentId }),
      confidence: f.confidence,
      firstSeen: f.firstSeen,
      lastSeen: f.lastSeen,
      status: f.status,
      ...(isForgotten(f, now) && { forgotten: true }),
    };
    nodes.push(node);
    edges.push({ from: node.id, to: subject, type: 'about' });
  }
  // A version edge only where both ends are on this page: the client joins the ones that straddle two pages.
  if (query.history)
    for (const f of page) if (f.parentId && factIds.has(f.parentId)) edges.push({ from: factNodeId(f.parentId), to: factNodeId(f.id), type: f.relation ?? 'updates' });
  const more = ordered.length > page.length && last;
  return { nodes, edges, ...(more && { nextCursor: encodeCursor({ s: last.lastSeen, i: last.id }) }), ...(read.truncated && { truncated: true }) };
}
