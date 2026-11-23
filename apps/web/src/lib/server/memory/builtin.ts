/**
 * The built-in memory backend (C07 FR-2): a project is its brain facts, a team its notebook notes, an agent and user the
 * private `agent-user` facts. It only maps containers onto stores that already exist and keep their rules: the latest
 * version (C01), forgotten and expired items left out (C02), notes written by a team run (D9). Access is the façade's.
 */
import { nanoid } from 'nanoid';
import { STUDY_FACT_KINDS, type BrainFact, type FactKind, type ProposalEvidence } from '../../shared/brain';
import { MEMORY_EVIDENCE_MAX, MEMORY_LIMITS, type MemoryAddInput, type MemoryContainer, type MemoryItem, type MemoryPage, type MemoryProfile, type MemorySearchOptions, type MemorySearchResult } from '../../shared/memory';
import type { NoteHit, TeamNote } from '../../shared/notebook';
import { recordAudit } from '../audit';
import { checkForgetAfter, getFact, listFacts, pageFacts, scoredFactSearch, upsertFact, type FactFilter } from '../brain/facts';
import { isRequestPerson } from '../brain/store/origin';
import { forgetFact, indexFact, supersedeFact } from '../brain/fact-lifecycle';
import { canFact } from '../brain/scope';
import { vectorFactScores } from '../brain/study';
import { database } from '../db';
import { decodeCursor, encodeCursor } from '../pagination';
import { forgetNote } from '../notebook/lifecycle';
import { searchNotes } from '../notebook/search';
import { addNote, projectOf } from '../notebook/service';
import { noteStore } from '../notebook/store';
import { getProject } from '../projects/store';
import { MemoryNotFoundError, MemoryWriteRefusedError, type MemoryBackend, type MemoryCaller } from './backend';

const MAX_TEXT = 2_000;
const RECENT = 10;
/** The kinds a person or a flow may write as a project's memory: `memory` for a free statement, `intended` for a decision. */
const WRITABLE_KINDS: readonly FactKind[] = ['memory', 'intended'];

const clamp = (n: number | undefined, { min, max, default: fallback }: { min: number; max: number; default: number }) => Math.max(min, Math.min(max, Math.floor(Number.isFinite(n) ? (n as number) : fallback)));

function factItem(fact: BrainFact, score?: number): MemoryItem {
  return {
    id: fact.id,
    text: fact.statement,
    kind: fact.kind,
    source: fact.subjectType === 'agent-user' ? 'agent-memory' : 'fact',
    ...(score !== undefined && { score }),
    version: fact.version ?? 1,
    ...(fact.static && { static: true }),
    confidence: fact.confidence,
    origin: fact.writtenBy?.origin === 'landflow' ? 'landflow' : 'person',
    evidenceCount: fact.evidence.length,
    createdAt: fact.firstSeen,
    updatedAt: fact.lastSeen,
  };
}

/** The confidence and evidence a writer may attach (C28): 0..1, at most six rows, links only inside Landflow. Throws a 400. */
function checkProvenance(input: MemoryAddInput): { confidence?: number; evidence?: ProposalEvidence[] } {
  const { confidence, evidence } = input;
  if (confidence !== undefined && !(Number.isFinite(confidence) && confidence >= 0 && confidence <= 1)) throw new MemoryWriteRefusedError('"confidence" is a number from 0 to 1');
  if (evidence !== undefined) {
    if (!Array.isArray(evidence) || evidence.length > MEMORY_EVIDENCE_MAX) throw new MemoryWriteRefusedError(`Give at most ${MEMORY_EVIDENCE_MAX} evidence rows`);
    for (const row of evidence) {
      if (!row || typeof row.label !== 'string' || !row.label.trim()) throw new MemoryWriteRefusedError('An evidence row needs a label');
      if (row.href !== undefined && !(typeof row.href === 'string' && row.href.startsWith('/') && !row.href.startsWith('//'))) throw new MemoryWriteRefusedError('An evidence link is a path inside Landflow, such as /runs/<id>');
    }
  }
  return { ...(confidence !== undefined && { confidence }), ...(evidence !== undefined && { evidence }) };
}

function noteItem(note: TeamNote | NoteHit, score?: number): MemoryItem {
  return {
    id: note.id,
    text: note.answer ? `${note.text} (answer: ${note.answer})` : note.text,
    kind: note.kind,
    source: 'note',
    ...(score !== undefined && { score }),
    ...(note.scope === 'project' && { static: true }),
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
  };
}

/** The fact filter of a container (a team has none: it is notes). */
function factFilter(c: MemoryContainer): FactFilter {
  if (c.kind === 'project') return { projectId: c.id };
  if (c.kind === 'agent') return { subjectType: 'agent-user', subjectId: `${c.id}/${c.userId}` };
  throw new Error('a team container holds notes');
}

const teamFilter = (c: MemoryContainer, caller: MemoryCaller) => ({
  teamId: c.id,
  ...(projectOf(c.id) && { projectId: projectOf(c.id) }),
  // A run's own notes only when a run is calling: a person or a playground reads the team's and the project's.
  ...((caller.notebook?.runId ?? caller.run?.executionId) && { runId: caller.notebook?.runId ?? caller.run?.executionId }),
});

/** The fact a container holds by id, or not found: an id from another container is not found either. */
function factIn(c: MemoryContainer, id: string, options: { includeForgotten?: boolean } = {}): BrainFact {
  const fact = getFact(id, database(), options);
  const mine = fact && (c.kind === 'project' ? fact.projectId === c.id : c.kind === 'agent' && fact.subjectType === 'agent-user' && fact.subjectId === `${c.id}/${c.userId}`);
  if (!fact || !mine || fact.latest === false) throw new MemoryNotFoundError();
  return fact;
}

/**
 * The fact a caller may rewrite or forget: one of this container's own memories (a project's or an agent-user's, never a fact
 * the study wrote), which an actor may also update (`canFact`). Anything else is not found, as an id from another container is.
 */
function writableFact(c: MemoryContainer, id: string, caller: MemoryCaller): BrainFact {
  const fact = factIn(c, id);
  const memoryKind = fact.subjectType === 'project' || fact.subjectType === 'agent-user';
  if (!memoryKind || (STUDY_FACT_KINDS as readonly string[]).includes(fact.kind)) throw new MemoryWriteRefusedError('only a project’s own memories can be replaced or forgotten');
  if (caller.actor && !canFact(caller.actor, fact, 'update')) throw new MemoryNotFoundError();
  return fact;
}

const origin = (caller: MemoryCaller) => ({ origin: caller.origin, by: caller.actor?.id ?? caller.userId });

function auditAdded(c: MemoryContainer, fact: BrainFact, caller: MemoryCaller, replaced: boolean) {
  // Ids, the container kind and who: never the text (it is a person's words).
  recordAudit({
    action: 'brain.memory_added',
    target: { type: 'brain_fact', id: fact.id },
    project: c.kind === 'project' ? c.id : null,
    details: { container: c.kind, origin: caller.origin, version: fact.version ?? 1, ...(replaced && { replaced: true }), ...(caller.keyId && { keyId: caller.keyId }), ...(caller.via && { via: caller.via }), ...(caller.run?.agentId && { agent: caller.run.agentId }) },
    ...(!caller.actor && { actor: 'system' as const }),
  });
}

export const builtInBackend: MemoryBackend = {
  name: 'built-in',

  async search(c, query, options: MemorySearchOptions, caller): Promise<MemorySearchResult> {
    const mode = options.mode ?? 'hybrid';
    const limit = clamp(options.limit, MEMORY_LIMITS.search);
    const threshold = Math.max(0, Math.min(1, options.threshold ?? 0));
    if (c.kind === 'team') {
      if (!query.trim()) {
        const notes = noteStore.list({ ...teamFilter(c, caller), limit });
        return { items: notes.map((n) => noteItem(n)), via: 'keywords', dropped: { count: 0 } };
      }
      const found = await searchNotes(query, teamFilter(c, caller), limit, { touch: options.touch === true, mode, threshold, maxLimit: MEMORY_LIMITS.search.max });
      return { items: found.hits.map((h) => noteItem(h, h.score)), via: found.via, dropped: found.dropped };
    }
    // Meaning only helps a project's facts: an agent's private vectors are searched by its own run (C09).
    const vector = c.kind === 'project' && mode !== 'keyword' && query.trim() ? await vectorFactScores(query, new Set([c.id]), 50) : [];
    const found = scoredFactSearch(query, { filter: factFilter(c), mode, vector, limit, threshold }, database());
    return { items: found.hits.map((h) => factItem(h.fact, query.trim() ? h.score : undefined)), via: found.via, dropped: found.dropped };
  },

  async profile(c, caller): Promise<MemoryProfile> {
    if (c.kind === 'team') {
      const notes = noteStore.list({ ...teamFilter(c, caller), limit: 200 });
      return { static: notes.filter((n) => n.scope === 'project').map((n) => noteItem(n)), recent: notes.filter((n) => n.scope !== 'project').slice(0, RECENT).map((n) => noteItem(n)) };
    }
    const filter = factFilter(c);
    return {
      static: listFacts({ ...filter, static: true, limit: 50 }).map((f) => factItem(f)),
      recent: listFacts({ ...filter, static: false, limit: RECENT }).map((f) => factItem(f)),
    };
  },

  async add(c, input: MemoryAddInput, caller): Promise<MemoryItem> {
    const text = input.text?.replace(/\s+/g, ' ').trim() ?? '';
    if (!text) throw new MemoryWriteRefusedError('"text" is empty: say the memory in a sentence');
    if (text.length > MAX_TEXT) throw new MemoryWriteRefusedError(`Keep a memory under ${MAX_TEXT} characters (it is ${text.length})`);
    if (c.kind === 'team') {
      // A note needs its run, member and quote (notebook/service.ts), so only a team run writes one (C07 D9).
      if (!caller.notebook) throw new MemoryWriteRefusedError('notes are written by a team run');
      const { note } = await addNote(caller.notebook, { text, ...(input.kind && { kind: input.kind }) });
      return noteItem(note);
    }
    const kind = (input.kind ?? 'memory') as FactKind;
    if ((STUDY_FACT_KINDS as readonly string[]).includes(kind)) throw new MemoryWriteRefusedError(`the study writes ${kind} facts`);
    if (!WRITABLE_KINDS.includes(kind)) throw new MemoryWriteRefusedError(`Unknown memory kind “${kind}”: use memory or intended`);
    const forgetAfter = checkForgetAfter(input.forgetAfter);
    const provenance = checkProvenance(input);
    const who = origin(caller);

    if (input.replaces) {
      // `<id>` replaces the latest version; `<id>#v<n>` says "I read version n", and a chain that moved on is 409.
      const match = /^(.*)#v(\d+)$/.exec(input.replaces);
      const chainId = match ? match[1] : input.replaces;
      writableFact(c, chainId, caller); // not found when it is not this container's, or the study's
      const written = await supersedeFact(chainId, { statement: text, ...provenance, ...(match && { expectedVersion: Number(match[2]) }), ...(caller.origin === 'person' && caller.actor && isRequestPerson(caller.actor.id) && { replaceStatic: true }) }, who, database());
      auditAdded(c, written, caller, true);
      return factItem(written);
    }

    const id = c.kind === 'project' ? `project:${c.id}:${kind}:m_${nanoid(10)}` : `agent-user:${c.id}/${c.userId}:${kind}:m_${nanoid(10)}`;
    const fact = upsertFact(
      {
        id,
        subjectType: c.kind === 'project' ? 'project' : 'agent-user',
        subjectId: c.kind === 'project' ? c.id : `${c.id}/${c.userId}`,
        ...(c.kind === 'project' && { subjectName: getProject(c.id)?.name, projectId: c.id }),
        kind,
        statement: text,
        confidence: provenance.confidence ?? 1,
        evidence: provenance.evidence ?? [],
      },
      database(),
      new Date().toISOString(),
      who.origin,
      who.by,
      { ...(input.static && { isStatic: true }), ...(forgetAfter && { forgetAfter }) },
    );
    await indexFact(fact);
    auditAdded(c, fact, caller, false);
    return factItem(fact);
  },

  async forget(c, id, reason, caller): Promise<MemoryItem> {
    const by = { userId: caller.actor?.id ?? caller.userId ?? 'system' };
    if (c.kind === 'team') {
      const note = noteStore.get(id);
      if (!note || note.teamId !== c.id) throw new MemoryNotFoundError();
      return noteItem(forgetNote(c.id, id, { reason }, by.userId));
    }
    writableFact(c, id, caller);
    return factItem(await forgetFact(id, { reason }, by, database()));
  },

  async list(c, page, caller): Promise<MemoryPage> {
    const limit = clamp(page.limit, MEMORY_LIMITS.list);
    if (c.kind === 'team') {
      // Keyset by (created, id) in SQL: a cursor whose note is gone still continues after its position, never at page 1.
      const cursor = page.cursor ? decodeCursor(page.cursor) : undefined;
      const notes = noteStore.list({ ...teamFilter(c, caller), limit: limit + 1, ...(cursor && { before: { createdAt: cursor.s, id: cursor.i } }) });
      const shown = notes.slice(0, limit);
      const last = shown.at(-1);
      return { items: shown.map((n) => noteItem(n)), ...(notes.length > limit && last && { nextCursor: encodeCursor({ s: last.createdAt, i: last.id }) }) };
    }
    const { facts, nextCursor } = pageFacts(factFilter(c), { limit, cursor: page.cursor }, database());
    return { items: facts.map((f) => factItem(f)), ...(nextCursor && { nextCursor }) };
  },
};
