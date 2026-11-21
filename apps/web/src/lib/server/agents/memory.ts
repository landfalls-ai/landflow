/**
 * What an agent remembers about one person (docs/agents.md#memory, C09): private `agent-user` brain facts (subject
 * `<agentId>/<userId>`, kind `memory`) written and read through P7's memory façade, so versions, static facts and soft forget
 * come from C01 and C02. This file adds what only an agent's own run needs: the two-part block (the profile, then what is
 * relevant to the question), `remember` with static and replaces, near-duplicates that refresh the old memory, the 1,000-memory
 * bound, the one-time import of the old `agent_memory` notes, and the list the agent page shows.
 *
 * Why meaning search lives here: the built-in backend searches an agent container by words only (an agent's private vectors
 * are the agent's own run to search), so the vectors in `landflow-agent-memory` are read here and fused with the words by the
 * same `scoredFactSearch` every other fact search uses.
 *
 * Memory text never reaches a log or a span: ids, counts and scores only. Evaluation runs and kagent's own session user read and
 * write nothing; a person's memories never reach another person's run.
 */
import { createHash } from 'node:crypto';
import { nanoid } from 'nanoid';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AGENT_MEMORY_COLLECTION, type BrainFact } from '../../shared/brain';
import type { Agent, AgentConfig, AgentMemoryView, AgentSession } from '../../shared/agents';
import type { MemoryContainer, MemoryItem } from '../../shared/memory';
import { wrapMemory } from '../../shared/memory-fence';
import { SAW_MEMORY_MAX_ITEMS, type SawMemoryItem, type SawMemorySource } from '../../shared/what-it-saw';
import { countLiveFacts, deleteFactsWhere, factSubjectsPage, getFact, listFacts, oldestLiveFacts, pageFacts, sameStatement, scoredFactSearch, upsertFact } from '../brain/facts';
import { forgetFact, indexFact, restoreFact } from '../brain/fact-lifecycle';
import { envString, ollamaUrl } from '../config';
import { database, type Database } from '../db';
import { memory } from '../memory';
import { assertContainer } from '../memory/access';
import { MemoryNotFoundError, MemoryWriteRefusedError, type MemoryCaller } from '../memory/backend';
import { ollamaEmbeddings } from '../rag/embeddings';
import { SqliteVectorStore } from '../rag/stores';
import { applyContent, contentOf } from '../journal/content';
import type { JournalEvent, TraceContent } from '../../shared/run-trace';
import { logger } from '../telemetry/logger';
import { AGENT_MEMORY, hasMemoryUser, setMemoryIndexer, subjectOf, deleteAgentMemories, importAgentMemories, profileNotes, rememberSync } from './memory-store';
setMemoryIndexer((fact) => indexFact(fact));
export { AGENT_MEMORY, hasMemoryUser, deleteAgentMemories, importAgentMemories, profileNotes, rememberSync };
import { withSpan } from '../telemetry';
import { StaticFactError } from '../brain/facts';

/** The numbers C09 fixes (spec FR-1, FR-2, FR-5; the two thresholds are guesses C11's playground lets a person tune). */

const NOTHING = '(nothing yet)';
const HINT = 'Use the remember tool for durable facts worth knowing next time; pass replaces with an id above to correct one, and forget_memory to drop one.';

export interface RecalledMemory {
  profile: MemoryItem[];
  relevant: MemoryItem[];
  via: 'meaning' | 'keywords';
  /** The whole block, header, fence and hint: what the prompt's `memory` part says. */
  text: string;
  /** Ids, versions and scores of what the block holds, for What it saw (C11). */
  saw: SawMemorySource[];
}

const containerOf = (agentId: string, userId: string): MemoryContainer => ({ kind: 'agent', id: agentId, userId });
/** A run (or a kagent call the signed key opened) acting for one person: the container's own rule lets it in. */
const callerFor = (agentId: string, userId: string): MemoryCaller => ({ system: true, origin: 'landflow', userId, run: { agentId } });

/** Whether a session user has memories at all: not an evaluation run, not kagent's own session user (it has no person). */

/** `m_x` from a full fact id: the handle the prompt shows (it never carries the person's id). */
export const shortId = (factId: string): string => factId.slice(factId.lastIndexOf(':') + 1);

/** The full fact id a handle (or a full id) names for this agent and person; ownership is checked where it is used. */
function resolveId(agentId: string, userId: string, handle: string): string {
  const given = handle.trim();
  return given.includes(':') ? given : `agent-user:${subjectOf(agentId, userId)}:memory:${given}`;
}

function itemOf(fact: BrainFact, score?: number): MemoryItem {
  return {
    id: fact.id,
    text: fact.statement,
    kind: fact.kind,
    source: 'agent-memory',
    ...(score !== undefined && { score }),
    version: fact.version ?? 1,
    ...(fact.static && { static: true }),
    createdAt: fact.firstSeen,
    updatedAt: fact.lastSeen,
  };
}

/** One of this agent and person's memories, live (latest version, not forgotten), or not found: another person's id is not found either. */
function ownFact(agentId: string, userId: string, id: string): BrainFact {
  const fact = getFact(resolveId(agentId, userId, id), database());
  if (!fact || fact.subjectType !== 'agent-user' || fact.subjectId !== subjectOf(agentId, userId) || fact.latest === false) throw new MemoryNotFoundError();
  return fact;
}

// ---------------------------------------------------------------------------
// Embeddings (the brain's model; words are used when it does not answer)
// ---------------------------------------------------------------------------

/** After a failure Ollama is left alone this long, so a run never waits on a host that is down. */
const BACKOFF_MS = 60_000;
const EMBED_TIMEOUT_MS = 5_000;
let downUntil = 0;

/** Forget a recorded failure (tests; and the agent page's probe after a person turned Ollama on). */
export function resetEmbeddingBackoff(): void {
  downUntil = 0;
}

async function embed(text: string, as: 'query' | 'document'): Promise<number[] | undefined> {
  const model = envString('LANDFLOW_BRAIN_EMBEDDINGS');
  if (model?.toLowerCase() === 'off' || Date.now() < downUntil) return undefined;
  try {
    const embeddings = ollamaEmbeddings({ baseUrl: ollamaUrl(), model: model || 'nomic-embed-text', documentPrefix: 'search_document: ', queryPrefix: 'search_query: ' });
    const signal = AbortSignal.timeout(EMBED_TIMEOUT_MS);
    const vector = as === 'query' ? await embeddings.embedQuery(text, signal) : (await embeddings.embedDocuments([text], signal))[0];
    return vector?.length ? vector : undefined;
  } catch {
    downUntil = Date.now() + BACKOFF_MS;
    return undefined;
  }
}

/** Whether the embedding model answers now (the agent page says "recall by words only" when it does not). A probe that fails is not repeated for a minute. */
export async function embeddingsAnswer(): Promise<boolean> {
  return Boolean(await embed('ping', 'query'));
}

/** The nearest of this person's memory vectors to `vector`, with cosine similarity; [] when the collection has none. */
async function nearest(agentId: string, userId: string, vector: number[], limit: number): Promise<Array<{ factId: string; similarity: number }>> {
  try {
    const hits = await new SqliteVectorStore().similaritySearch(AGENT_MEMORY_COLLECTION, vector, limit, { agentId, userId });
    return hits.map((d) => ({ factId: String(d.metadata?.factId ?? ''), similarity: Number(d.score ?? 0) })).filter((h) => h.factId);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// The block
// ---------------------------------------------------------------------------

/** One memory as a line. Only `render` puts lines into a prompt, and it hands the whole array to wrapMemory (the fence). */
const entryOf = (item: MemoryItem) => `- [${shortId(item.id)}] ${item.text.replace(/\s+/g, ' ').trim()} (${item.static ? 'static' : item.createdAt.slice(0, 10)})`;

/** The block's lines: the profile, then what is relevant, each part only when it has items. */
const linesOf = (profile: readonly MemoryItem[], relevant: readonly MemoryItem[]): string[] => [
  ...(profile.length ? ['Profile:', ...profile.map(entryOf)] : []),
  ...(relevant.length ? ['Relevant to this request:', ...relevant.map(entryOf)] : []),
];

const render = (profile: readonly MemoryItem[], relevant: readonly MemoryItem[]): string =>
  ['## What you remember about this user', profile.length || relevant.length ? wrapMemory('agent-memory', linesOf(profile, relevant)) : NOTHING, HINT].join('\n');

/**
 * The block within `blockChars`: the lowest-scored relevant lines go first, then the oldest non-static profile lines, then (only
 * if static memories alone are too long) the oldest static ones. What stays is what `saw` lists.
 */
export function fitBlock(profileIn: readonly MemoryItem[], relevantIn: readonly MemoryItem[], max: number = AGENT_MEMORY.blockChars): { text: string; profile: MemoryItem[]; relevant: MemoryItem[] } {
  const profile = [...profileIn];
  const relevant = [...relevantIn].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  let text = render(profile, relevant);
  while (text.length > max && (relevant.length || profile.length)) {
    if (relevant.length) relevant.pop();
    else {
      // The profile is static first, then the newest others: the last non-static is the oldest of those, else the last static.
      const last = profile.map((p) => !p.static).lastIndexOf(true);
      profile.splice(last >= 0 ? last : profile.length - 1, 1);
    }
    text = render(profile, relevant);
  }
  return { text, profile, relevant };
}

const hash = (lines: readonly string[]) => createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 16);
const round = (n: number) => Math.round(n * 100) / 100;

function sawItem(item: MemoryItem): SawMemoryItem {
  return { id: item.id, ...(item.version !== undefined && { version: item.version }), kind: item.kind, ...(item.static && { static: true }), ...(item.score !== undefined && { score: round(item.score) }) };
}

/** The memory sources a block's items make for What it saw: ids, versions, kinds, scores and a hash of each part's lines, never the text. */
export function sawOf(profile: readonly MemoryItem[], relevant: readonly MemoryItem[], via: 'meaning' | 'keywords'): SawMemorySource[] {
  return [
    ...(profile.length ? [{ source: 'agent-profile' as const, count: profile.length, items: profile.slice(0, SAW_MEMORY_MAX_ITEMS).map(sawItem), hash: hash(profile.map(entryOf)) }] : []),
    ...(relevant.length ? [{ source: 'agent-relevant' as const, mode: via, count: relevant.length, items: relevant.slice(0, SAW_MEMORY_MAX_ITEMS).map(sawItem), hash: hash(relevant.map(entryOf)) }] : []),
  ];
}

/** The profile as items: every static memory, then the ten newest others. Synchronous, so `systemPromptParts` can use it without a recall. */
function profileItems(agentId: string, userId: string): MemoryItem[] {
  const filter = { subjectType: 'agent-user' as const, subjectId: subjectOf(agentId, userId) };
  return [...listFacts({ ...filter, static: true, limit: 50 }), ...listFacts({ ...filter, static: false, limit: AGENT_MEMORY.recent })].map((f) => itemOf(f));
}

/** The profile part only, as the prompt shows it (the fallback of `systemPromptParts` without a recall, and the tests'). */
export function profileBlock(agentId: string, userId: string): string {
  return fitBlock(hasMemoryUser(userId) ? profileItems(agentId, userId) : [], []).text;
}

/** What is relevant to `question` among a person's memories, best first, without the ones in `exclude`; by meaning and words, or by words alone. */
async function relevantTo(agentId: string, userId: string, question: string, exclude: ReadonlySet<string>): Promise<{ items: MemoryItem[]; via: 'meaning' | 'keywords' }> {
  if (!question.trim()) return { items: [], via: 'keywords' };
  const vector = await embed(question, 'query');
  const similar = vector ? await nearest(agentId, userId, vector, 50) : [];
  const found = scoredFactSearch(
    question,
    { filter: { subjectType: 'agent-user', subjectId: subjectOf(agentId, userId) }, mode: 'hybrid', vector: similar, limit: AGENT_MEMORY.relevant + exclude.size, threshold: AGENT_MEMORY.recallThreshold },
    database(),
  );
  const items = found.hits.filter((h) => !exclude.has(h.fact.id)).slice(0, AGENT_MEMORY.relevant).map((h) => itemOf(h.fact, h.score));
  return { items, via: found.via };
}

/**
 * The block for one person and a question (the run's first message): the profile, and the memories relevant to the question
 * that the profile does not already hold. A recall that fails to embed falls back to words and says nothing about it (FR-8).
 */
export async function recallFor(agentId: string, userId: string, question: string | undefined): Promise<RecalledMemory> {
  const container = containerOf(agentId, userId);
  const caller = callerFor(agentId, userId);
  // The façade checks the container (this person, this agent) and records the span; the search itself reads the vectors (see the header).
  const profileIn = await memory.profile(container, caller);
  const profile = [...profileIn.static, ...profileIn.recent];
  const { items, via } = await withSpan('memory.search', { attributes: { 'landflow.memory.backend': 'built-in', 'landflow.memory.container': 'agent' } }, async (span) => {
    assertContainer(caller, container, 'read');
    const result = await relevantTo(agentId, userId, question ?? '', new Set(profile.map((p) => p.id)));
    span.setAttribute('landflow.memory.count', result.items.length);
    return result;
  });
  const fitted = fitBlock(profile, items);
  return { profile: fitted.profile, relevant: fitted.relevant, via, text: fitted.text, saw: sawOf(fitted.profile, fitted.relevant, via) };
}

/** The run's block (undefined when cross-session memory is off, for an evaluation run, or for kagent's own session user). */
export async function recallForRun(agent: Pick<Agent, 'id'>, config: Pick<AgentConfig, 'memory'>, session: Pick<AgentSession, 'userId'>, question: string | undefined): Promise<RecalledMemory | undefined> {
  if (!config.memory.crossSession || !hasMemoryUser(session.userId)) return undefined;
  return recallFor(agent.id, session.userId, question);
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export interface RememberInput {
  fact: string;
  static?: boolean;
  /** A memory id from the block (`m_…`, or the full id): this one supersedes it. */
  replaces?: string;
}

export type RememberOutcome = 'added' | 'refreshed' | 'replaced';

/** How many live memories this person has with this agent. */
export const countMemories = (agentId: string, userId: string): number => countLiveFacts({ subjectType: 'agent-user', subjectId: subjectOf(agentId, userId) });

/**
 * Remember a fact for one person. `replaces` supersedes a memory (a new version); a static one is refused, as an agent's write is Landflow's and only a person may change a static memory. Otherwise a
 * near-duplicate (the same words after normalising, or an embedding at least 0.92 alike) refreshes the old memory and keeps its
 * words; anything else is added, and past 1,000 the oldest non-static memory is forgotten (`capacity`).
 */
export async function rememberMemory(agentId: string, userId: string, input: RememberInput): Promise<{ item: MemoryItem; outcome: RememberOutcome; count: number }> {
  const text = input.fact.replace(/\s+/g, ' ').trim().slice(0, AGENT_MEMORY.factChars);
  if (!text) throw new MemoryWriteRefusedError('"fact" is empty: say what to remember in a sentence');
  const container = containerOf(agentId, userId);
  const caller = callerFor(agentId, userId);
  const db = database();
  const subject = subjectOf(agentId, userId);
  const done = (item: MemoryItem, outcome: RememberOutcome) => ({ item, outcome, count: countMemories(agentId, userId) });

  if (input.replaces) {
    const target = resolveId(agentId, userId, input.replaces);
    try {
      return done(await memory.add(container, { text, replaces: target, ...(input.static && { static: true }) }, caller), 'replaced');
    } catch (error) {
      // An agent's write is Landflow's, never a person's: it cannot rewrite a static memory (the person said it is always true).
      if (error instanceof StaticFactError) throw new MemoryWriteRefusedError('That memory is static, so it cannot be replaced. Forget it with forget_memory, then remember the new one.');
      throw error;
    }
  }

  const live = listFacts({ subjectType: 'agent-user', subjectId: subject, limit: AGENT_MEMORY.max + 100 }, db);
  let same = live.find((f) => sameStatement(f.statement, text));
  if (!same && live.length) {
    const vector = await embed(`${subject}: ${text}`, 'document');
    const best = vector ? (await nearest(agentId, userId, vector, 5)).find((h) => h.similarity >= AGENT_MEMORY.nearDuplicate && live.some((f) => f.id === h.factId)) : undefined;
    same = best && live.find((f) => f.id === best.factId);
  }
  if (same) {
    // Refresh the sightings and keep the old words (D4); a static request makes it static.
    const refreshed = upsertFact(same, db, new Date().toISOString(), 'landflow', userId, { isStatic: input.static || same.static });
    return done(itemOf(refreshed), 'refreshed');
  }

  const item = await memory.add(container, { text, ...(input.static && { static: true }) }, caller);
  await enforceBound(agentId, userId, db);
  return done(item, 'added');
}

/** Past the bound the oldest non-static memories are forgotten with reason `capacity`, audited as Landflow; static ones are never touched. */
async function enforceBound(agentId: string, userId: string, db: Database): Promise<void> {
  const subject = { subjectType: 'agent-user' as const, subjectId: subjectOf(agentId, userId) };
  const over = countLiveFacts(subject, { static: false }, db) - AGENT_MEMORY.max;
  if (over <= 0) return;
  for (const fact of oldestLiveFacts(subject, over, db)) await forgetFact(fact.id, { reason: 'capacity' }, { userId: 'landflow' }, db);
  logger.info('an agent memory passed its bound; the oldest were forgotten', { 'gen_ai.agent.id': agentId, count: over });
}

/** Forget one of this person's live memories (soft: it can be restored). Another person's id, or none, is "not found". */
export async function forgetAgentMemory(agentId: string, userId: string, id: string, reason: string, by: string): Promise<BrainFact> {
  const fact = ownFact(agentId, userId, id);
  return forgetFact(fact.id, { reason }, { userId: by }, database());
}

/** Bring a forgotten memory of this person back. */
export function restoreAgentMemory(agentId: string, userId: string, id: string, by: string): BrainFact {
  const full = resolveId(agentId, userId, id);
  const fact = getFact(full, database(), { includeForgotten: true });
  if (!fact || fact.subjectType !== 'agent-user' || fact.subjectId !== subjectOf(agentId, userId) || fact.latest === false) throw new MemoryNotFoundError();
  return restoreFact(fact.id, { userId: by }, database());
}

// ---------------------------------------------------------------------------
// The list the agent page shows
// ---------------------------------------------------------------------------

export function viewOf(fact: BrainFact): AgentMemoryView {
  return {
    id: shortId(fact.id),
    text: fact.statement,
    static: Boolean(fact.static),
    version: fact.version ?? 1,
    at: fact.firstSeen,
    lastSeen: fact.lastSeen,
    ...(fact.forgottenAt && { forgottenAt: fact.forgottenAt }),
    ...(fact.forgetReason && { forgetReason: fact.forgetReason }),
  };
}

/** One page of a person's memories, newest first: the live ones, or the forgotten ones. */
export function listAgentMemories(agentId: string, userId: string, page: { limit: number; cursor?: string; forgotten?: boolean }): { items: AgentMemoryView[]; nextCursor?: string } {
  const { facts, nextCursor } = pageFacts({ subjectType: 'agent-user', subjectId: subjectOf(agentId, userId), forgotten: page.forgotten ? 'only' : 'exclude' }, { limit: page.limit, cursor: page.cursor }, database());
  return { items: facts.map(viewOf), ...(nextCursor && { nextCursor }) };
}

/** The people an agent has memories of (user ids), one page: for its editors to pick from. */
export function memoryUsers(agentId: string, page: { limit: number; after?: string }): { users: string[]; next?: string } {
  const prefix = `${agentId}/`;
  const { subjects, next } = factSubjectsPage({ subjectType: 'agent-user', subjectIdPrefix: prefix }, page);
  return { users: subjects.map((s) => s.slice(prefix.length)), ...(next && { next: next.slice(prefix.length) }) };
}

/**
 * The memory a run recalled as the session record keeps it: cut by the run's trace content mode by the journal's own rule
 * (`applyContent`), so the record never holds more than the journal does: `full` keeps the sources and the block, `summaries`
 * the sources only, `off` neither. `setting` is the workflow's `traceContent`, else the instance default.
 */
export function sessionMemory(sources: SawMemorySource[], text: string | undefined, setting?: TraceContent): { memory?: SawMemorySource[]; memoryText?: string } {
  if (!sources.length && !text) return {};
  const event = { type: 'span.updated', attrs: { saw: { memory: sources, ...(text && { memoryText: text }) } } } as unknown as JournalEvent;
  const kept = ((applyContent(event, contentOf(setting)) as unknown as { attrs: { saw: { memory?: SawMemorySource[]; memoryText?: string } } }).attrs.saw);
  return { ...(kept.memory && { memory: kept.memory }), ...(kept.memoryText && { memoryText: kept.memoryText }) };
}

