/**
 * The memory search playground (docs/run-trace.md#memory-playground, C11): one search over an agent's knowledge base, a team's
 * notebook or a project's brain facts, with mode, limit, threshold and rerank, answered with the scores before and after rerank,
 * what the threshold dropped and the time per stage. It changes nothing: notes are read with `touch: false`, facts and the
 * store are only read, no cache is filled, no agent usage row is written and nothing is audited (reads are not). The query and
 * the text never reach a span: `memory.playground` carries the source kind, mode and counts.
 */
import type { AiDocument, Embeddings, Reranker } from '@landflow/engine';
import { EMBEDDER_DOWN, PLAYGROUND_LIMITS, type PlaygroundAnswer, type PlaygroundMode, type PlaygroundRequest, type PlaygroundResult } from '../../shared/memory-playground';
import { isNodeKnowledge, type AgentToolConfig, type VectorKnowledgeBaseConfig } from '../../shared/agents';
import { agentStore } from '../agents/store';
import { knowledgeSearcher } from '../agents/knowledge';
import { CollectionAccessError } from '../rag/collection-access'; // C21:
import { ollamaUrl } from '../config';
import { credentials } from '../credentials/vault';
import { HttpError } from '../errors';
import { ollamaModel } from '../nodes/models';
import { search } from '../nodes/vector-stores';
import { listFacts } from '../brain/facts';
import { canFact } from '../brain/scope';
import { vectorFactScores } from '../brain/study';
import { fuseScores, keywordScore } from '../notebook/search';
import { canResource, credentialUsableBy, projectRole, type Actor } from '../projects/access';
import { getProject, homeProjectId } from '../projects/store';
import { cohereReranker, llmReranker } from '../rag/rerank';
import { withSpan } from '../telemetry';
import { memory } from './index';
import type { MemoryContainer } from '../../shared/memory';

/** Tests replace how a reranker is made (Cohere is a hosted API: never called from a test). */
export interface PlaygroundDeps {
  makeReranker?: (rerank: NonNullable<PlaygroundRequest['rerank']>, actor: Actor, projectId?: string) => Reranker;
}

const notFound = (what: string) => new HttpError(`${what} not found`, 404);
const elapsed = (from: number) => Math.round(performance.now() - from);

/** The reranker a request asks for: a Cohere credential the caller may read, or a local chat model. */
function makeReranker(rerank: NonNullable<PlaygroundRequest['rerank']>, actor: Actor, projectId: string | undefined): Reranker {
  if (rerank.kind === 'llm') return llmReranker(ollamaModel({ baseUrl: ollamaUrl(), model: rerank.model }));
  // The credential must be one the caller reads and the searched source's project may use (its home, or shared with it).
  if (!canResource(actor, 'credential', rerank.credentialId, 'read') || !credentialUsableBy(rerank.credentialId, projectId)) throw notFound('Credential');
  const data = credentials.dataFor({ id: rerank.credentialId, name: rerank.credentialId }, 'core.cohereApi') as { apiKey?: string; baseUrl?: string };
  return cohereReranker({ ...(data.baseUrl && { baseUrl: data.baseUrl }), ...(data.apiKey && { apiKey: data.apiKey }), ...(rerank.model && { model: rerank.model }) });
}

/** Reorder `results` with the reranker; each keeps its first score and gains the reranked one. */
async function rerankResults(query: string, results: PlaygroundResult[], reranker: Reranker, limit: number): Promise<PlaygroundResult[]> {
  const docs: AiDocument[] = results.map((r) => ({ pageContent: r.text, metadata: { id: r.id }, score: r.score }));
  const ranked = (await reranker.rerank(query, docs, { topK: limit })).slice(0, limit);
  const byId = new Map(results.map((r) => [r.id, r]));
  return ranked.flatMap((doc) => {
    const base = byId.get(String(doc.metadata.id));
    if (!base) return [];
    // A reranker that falls back (a failed call keeps the retrieval order and its scores) adds no second score: a score equal to the first is not one.
    return [{ ...base, ...(doc.score !== undefined && doc.score !== base.score && { rerankScore: doc.score }) }];
  });
}

const modeOf = (mode: PlaygroundMode) => (mode === 'meaning' ? 'vector' : mode);

async function searchKnowledge(actor: Actor, request: PlaygroundRequest & { source: { kind: 'kb' } }, candidates: number): Promise<Omit<PlaygroundAnswer, 'timings'> & { embedMs?: number }> {
  const { agentId, toolId } = request.source;
  const agent = agentStore.get(agentId);
  if (!agent || !canResource(actor, 'agent', agentId, 'update')) throw notFound('Agent');
  const tool = agent.tools.find((t: AgentToolConfig) => t.id === toolId && t.type === 'knowledge');
  if (!tool) throw notFound('Knowledge base');
  if (isNodeKnowledge(tool as never)) throw new HttpError('A knowledge base a plugin answers is searched through its own node', 400);
  const config = tool as VectorKnowledgeBaseConfig;
  let searcher;
  try {
    searcher = knowledgeSearcher(config, { asProject: homeProjectId('agent', agentId), subject: 'agent' }); // C21: the agent's home project asks
  } catch (error) {
    if (error instanceof CollectionAccessError) throw error;
    throw new HttpError((error as Error).message, 400);
  }
  // Keyword search needs no embedding model; a store with one can do all three.
  const keywordOnly = searcher.embeddings.provider === 'none';
  let mode: PlaygroundMode = keywordOnly ? 'keyword' : request.mode;
  let embedMs: number | undefined;
  let embedFailed = false;
  const timed: Embeddings = { ...searcher.embeddings, embedQuery: async (text, signal) => {
    const at = performance.now();
    try {
      return await searcher.embeddings.embedQuery(text, signal);
    } catch (error) {
      embedFailed = true;
      throw error;
    } finally {
      embedMs = elapsed(at);
    }
  } };
  const run = (m: PlaygroundMode) => search({ ...searcher, embeddings: timed, options: { searchMode: modeOf(m) as 'vector' | 'hybrid' | 'keyword', candidates } }, request.query, candidates);
  let docs: AiDocument[];
  let via: 'meaning' | 'keywords' = mode === 'keyword' ? 'keywords' : 'meaning';
  try {
    docs = await run(mode);
  } catch (error) {
    // Only a failed embedding call means the model is unreachable; any other error is the store's or the query's, and is raised.
    if (!embedFailed) throw error;
    if (mode === 'meaning') return { results: [], dropped: { count: 0 }, via: 'meaning', error: EMBEDDER_DOWN, ...(embedMs !== undefined && { embedMs }) };
    if (mode !== 'hybrid') throw error;
    // Hybrid: the keyword half still answers.
    mode = 'keyword';
    via = 'keywords';
    docs = await run('keyword');
  }
  const all = docs.map((d, i): PlaygroundResult => ({ id: String(d.id ?? `${config.collection}:${i}`), text: d.pageContent, score: d.score ?? 0, sourceId: String(d.metadata.documentId ?? d.metadata.fileName ?? config.collection) }));
  const kept = all.filter((r) => r.score >= request.threshold);
  const dropped = all.filter((r) => r.score < request.threshold).map((r) => r.score);
  return { results: kept, dropped: { count: dropped.length, ...(dropped.length && { best: Math.max(...dropped) }) }, via, ...(embedMs !== undefined && { embedMs }) };
}

/**
 * Facts the caller may read, scored: the candidates are filtered BEFORE scoring (never an agent's memory of a person, and only
 * what `canFact` allows), so the threshold, the dropped count and the limit see visible facts only and say nothing about a hidden
 * one. Scores are the facts search's (words, meaning, their fusion; `scoredFactSearch`'s rules). With no project, every fact the
 * caller may read; with one, that project's (project read access, else 404).
 */
async function searchFacts(actor: Actor, request: PlaygroundRequest & { source: { kind: 'facts' } }, candidates: number): Promise<Omit<PlaygroundAnswer, 'timings'>> {
  const { projectId } = request.source;
  if (projectId && (!getProject(projectId) || projectRole(actor, projectId) === undefined)) throw notFound('Project');
  const visible = listFacts({ ...(projectId && { projectId }), limit: 5_000 }).filter((f) => f.subjectType !== 'agent-user' && canFact(actor, f, 'read'));
  const projects = new Set(visible.flatMap((f) => (f.projectId ? [f.projectId] : [])));
  const vector = request.mode !== 'keyword' && projects.size ? await vectorFactScores(request.query, projects, 50) : [];
  const similarity = new Map(vector.map((v) => [v.factId, v.similarity]));
  const useVector = similarity.size > 0;
  if (request.mode === 'meaning' && !useVector) return { results: [], dropped: { count: 0 }, via: 'keywords', error: EMBEDDER_DOWN };
  const scored = visible.map((fact) => {
    const words = keywordScore(request.query, [fact.subjectName ?? '', fact.kind, fact.statement].join(' ')); // scoring input, never a prompt
    const meaning = similarity.get(fact.id);
    const score = request.mode === 'keyword' ? words : request.mode === 'meaning' ? (meaning ?? 0) : fuseScores(useVector ? (meaning ?? 0) : undefined, words);
    return { fact, score: Math.min(1, score) };
  });
  const matched = scored.filter((r) => r.score > 0);
  const hits = matched.filter((r) => r.score >= request.threshold).sort((a, b) => b.score - a.score || b.fact.lastSeen.localeCompare(a.fact.lastSeen));
  const dropped = matched.filter((r) => r.score < request.threshold).map((r) => r.score);
  return {
    results: hits.slice(0, candidates).map((h): PlaygroundResult => ({ id: h.fact.id, text: h.fact.statement, score: h.score, sourceId: h.fact.id, kind: h.fact.kind })),
    dropped: { count: dropped.length, ...(dropped.length && { best: Math.max(...dropped) }) },
    via: useVector ? 'meaning' : 'keywords',
  };
}

async function searchMemory(actor: Actor, request: PlaygroundRequest & { source: { kind: 'notebook' | 'facts' } }, candidates: number): Promise<Omit<PlaygroundAnswer, 'timings'>> {
  if (request.source.kind === 'facts') return searchFacts(actor, request as never, candidates);
  const container: MemoryContainer = { kind: 'team', id: request.source.teamId };
  // `touch` stays unset: a playground reads, it does not keep a note alive.
  const found = await memory.search(container, request.query, { mode: request.mode, limit: candidates, threshold: request.threshold }, { actor, origin: 'person', userId: actor.id });
  if (request.mode === 'meaning' && found.via === 'keywords' && request.query.trim()) return { results: [], dropped: found.dropped, via: found.via, error: EMBEDDER_DOWN };
  const results = found.items.map((i): PlaygroundResult => ({ id: i.id, text: i.text, score: i.score ?? 0, sourceId: i.id, kind: i.kind }));
  return { results, dropped: found.dropped, via: found.via };
}

/** The project the searched source belongs to (a knowledge base's agent's, a team's, the facts'), for the reranker credential's rule. */
function sourceProject(_actor: Actor, request: PlaygroundRequest): string | undefined {
  const { source } = request;
  if (source.kind === 'kb') return homeProjectId('agent', source.agentId);
  if (source.kind === 'notebook') return homeProjectId('agentTeam', source.teamId);
  // No project named: no single project to test a credential against (a Cohere rerank needs one).
  return source.projectId;
}

/** One search for `actor`. A source the caller may not reach is a 404 (a knowledge base needs edit access to its agent). */
export async function runPlayground(actor: Actor, request: PlaygroundRequest, deps: PlaygroundDeps = {}): Promise<PlaygroundAnswer> {
  if (request.query.length > PLAYGROUND_LIMITS.query) throw new HttpError(`Keep the query under ${PLAYGROUND_LIMITS.query} characters`, 400);
  return withSpan('memory.playground', { attributes: { 'landflow.memory.source': request.source.kind, 'landflow.memory.mode': request.mode } }, async (span) => {
    const reranker = request.rerank ? (deps.makeReranker ?? makeReranker)(request.rerank, actor, sourceProject(actor, request)) : undefined;
    const candidates = reranker ? Math.min(PLAYGROUND_LIMITS.limit.max, Math.max(request.limit, 20)) : request.limit;
    const started = performance.now();
    const found = request.source.kind === 'kb' ? await searchKnowledge(actor, request as never, candidates) : await searchMemory(actor, request as never, candidates);
    const { embedMs, ...answer } = found as typeof found & { embedMs?: number };
    const timings: PlaygroundAnswer['timings'] = { searchMs: elapsed(started), ...(embedMs !== undefined && { embedMs }) };
    if (reranker && answer.results.length > 1 && !answer.error) {
      const at = performance.now();
      answer.results = await rerankResults(request.query, answer.results, reranker, request.limit);
      timings.rerankMs = elapsed(at);
    } else answer.results = answer.results.slice(0, request.limit);
    span.setAttribute('landflow.memory.count', answer.results.length);
    span.setAttribute('landflow.memory.dropped', answer.dropped.count);
    return { ...answer, timings };
  });
}
