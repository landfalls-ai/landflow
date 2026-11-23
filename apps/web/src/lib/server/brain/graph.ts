/**
 * The memory graph's data (docs/second-brain.md#the-graph): a page of facts as nodes with their subjects, an `about` edge
 * from each fact to its subject and, with history on, a version edge from each version's parent. What the caller may see
 * is decided by the same scope as the facts list (`scopeForActor`, `canFact`); statements are plain text.
 *
 * A page is `pageFacts` (C07): the scope, subject and history are in the SQL, so a page is never shrunk after the query, except
 * that forgotten facts the caller may not restore are dropped from it.
 */
import { getProject } from '../projects/store';
import { agentStore } from '../agents/store';
import { type Actor } from '../projects/access';
import { store } from '../store';
import { getProfile, pageFacts, type FactFilter } from './facts';
import { getEntity } from './entities';
import { canFact, scopeForActor } from './scope';
import { wikiPage } from './wiki';
import { FACT_SUBJECTS, parseEntityRef, type BrainFact, type FactSubject } from '../../shared/brain';
import { factNodeId, subjectNodeId, type GraphEdge, type GraphFactNode, type GraphNode, type GraphPage, type GraphQuery, type GraphSubjectNode } from '../../shared/brain-graph';

/** Subjects a graph page reads at depth 2 (the spec's bound). */
export const MAX_NEIGHBOURS = 50;

export interface SubjectKey {
  subjectType: FactSubject;
  subjectId: string;
}

/**
 * A subject key as the route takes it: `workflow/<id>`, `agent/<id>`, `entity/<type>/<id>`, `project/<id>`, or an entity page's own
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
  if (s.subjectType === 'project') return getProject(s.subjectId)?.name ?? hint ?? s.subjectId;
  return s.subjectType === 'instance' ? 'This instance' : (hint ?? s.subjectId);
}

/** Whether a fact is hidden (forgotten, or past its forget-after time). */
const isForgotten = (f: BrainFact, now: string) => Boolean(f.forgottenAt || (f.forgetAfter && f.forgetAfter <= now));

/** At most this many `pageFacts` reads fill one graph page when forgotten facts the caller may not restore are dropped. */
const MAX_ROUNDS = 5;

/**
 * One page of the facts the caller may see for `query`, with the scope, subject and history in SQL (`pageFacts`). Forgotten
 * facts the caller may not restore are dropped after a read, so it reads on from the cursor until the page holds `limit`
 * facts or there is nothing more (a page of only hidden facts is never empty while later ones exist).
 */
function readFacts(actor: Actor | undefined, query: GraphQuery, subjects: SubjectKey[], now: string): { facts: BrainFact[]; nextCursor?: string } {
  const filter = { status: 'all' as const, history: query.history, forgotten: query.forgotten ? ('include' as const) : ('exclude' as const), now };
  let scoped: Omit<FactFilter, 'limit'>;
  if (subjects.length === 1) {
    // One subject the route already checked (a project's facts are not in a member's scope, so no scope is added).
    scoped = { ...filter, subjectType: subjects[0]!.subjectType, subjectId: subjects[0]!.subjectId };
  } else if (subjects.length > 1) {
    // The page's subject and its neighbours, each checked by `neighbours`: their ids are the scope.
    const ids = (type: FactSubject) => new Set(subjects.filter((s) => s.subjectType === type).map((s) => s.subjectId));
    scoped = { ...filter, scope: { workflows: ids('workflow'), agents: ids('agent'), entities: ids('entity') } };
  } else {
    scoped = { ...filter, scope: actor && scopeForActor(actor) };
  }
  // Whether the caller may restore a subject's facts is decided once per subject, and only for forgotten facts.
  const mayRestore = new Map<string, boolean>();
  const canRestore = (f: BrainFact) => {
    if (!actor) return false;
    const key = `${f.subjectType}\u0000${f.subjectId}`;
    if (!mayRestore.has(key)) mayRestore.set(key, canFact(actor, f, 'update'));
    return mayRestore.get(key)!;
  };
  const kept: BrainFact[] = [];
  let cursor = query.cursor;
  let nextCursor: string | undefined;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const page = pageFacts(scoped, { limit: query.limit - kept.length, cursor });
    kept.push(
      ...page.facts
        .filter((f) => f.subjectType !== 'agent-user') // a person's private notes about an agent never enter a shared graph
        .filter((f) => !isForgotten(f, now) || canRestore(f)),
    );
    nextCursor = page.nextCursor;
    cursor = page.nextCursor;
    if (!cursor || kept.length >= query.limit) break;
  }
  return { facts: kept, nextCursor };
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
export function brainGraph(actor: Actor | undefined, query: GraphQuery, now = new Date().toISOString()): GraphPage {
  const about = query.about ? parseSubject(query.about) : undefined;
  const subjects = about ? [about, ...(query.depth === 2 ? neighbours(actor, about) : [])] : [];
  const read = readFacts(actor, query, subjects, now);
  const page = read.facts;
  const cursor = query.cursor;

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
    return { nodes, edges, ...(read.nextCursor && { nextCursor: read.nextCursor }) };
}
