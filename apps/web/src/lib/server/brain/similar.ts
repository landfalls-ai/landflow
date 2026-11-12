/**
 * Find Similar (docs/second-brain.md#find-similar): "is anyone already doing this?". Given a title and a goal, the nearest
 * workflows, agents and facts of the brain, best first.
 *
 * Ranking: the share of words the text and a candidate have in common (a candidate is its name, description and the
 * purpose the brain wrote; a fact is its statement), and, when facts are embedded, a bonus from the vector search
 * (./study.ts `vectorFactHits`) for the subject of every fact it found. With embeddings off only the words count, so it
 * works without a model.
 *
 * The walls: a neighbour in a project the caller can open comes with its id and detail. A neighbour in a project they
 * can't open (only when `includeOthers`) is a projection of six fields, built field by field below: no id, no link, and
 * never a fact (a fact's statement or evidence would leak what the project does). Facts raise the score of their
 * subject and are not shown.
 */
import { agentStore } from '../agents/store';
import { getUser } from '../auth/users';
import { getProject, homeProjectId } from '../projects/store';
import { searchTerms } from '../rag/search';
import { store } from '../store';
import type { UsageScope } from '../usage/query';
import type { SimilarElsewhere, SimilarKind, SimilarMatch, SimilarOwn } from '../../shared/brain';
import { SIMILAR_KINDS } from '../../shared/brain';
import { getFact, getProfile, listFacts } from './facts';
import { projectsOf } from './scope';
import { vectorFactHits } from './study';

export interface FindSimilarOptions {
  /** What the caller can open (scopeForActor, scopeForWorkflow). Undefined: everything. */
  scope?: UsageScope;
  /** What to look at (default: all three). */
  kinds?: SimilarKind[];
  limit?: number;
  /** 0..1 (default 0.15). */
  minScore?: number;
  /** Also return the projection of neighbours in projects the caller can't open. */
  includeOthers?: boolean;
  /** Leave out the workflow or agent that is asking. */
  exclude?: { workflowId?: string; agentId?: string };
}

const oneLine = (text: string | undefined, max = 160): string | undefined => {
  const line = (text ?? '').split('\n').find((l) => l.trim())?.trim().replace(/\s+/g, ' ');
  if (!line) return undefined;
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** Words without their plural and -ing/-ed endings, so "reminders" meets "reminder". */
const stem = (term: string) => (term.length > 4 ? term.replace(/(ing|ed|es|s)$/, '') : term);
const termsOf = (text: string) => new Set(searchTerms(text).map(stem));

/** The words two texts share, over the geometric mean of their sizes (0..1). */
function overlap(query: Set<string>, text: string): number {
  const terms = termsOf(text);
  if (!query.size || !terms.size) return 0;
  let shared = 0;
  for (const term of query) if (terms.has(term)) shared++;
  return shared / Math.sqrt(query.size * terms.size);
}

/** What the vector search adds to the subject of its n-th best fact. */
const vectorBonus = (rank: number) => 0.5 / (1 + rank / 3);
const round = (n: number) => Math.round(Math.min(1, Math.max(0, n)) * 1000) / 1000;

function projectOf(kind: 'workflow' | 'agent', id: string) {
  const projectId = homeProjectId(kind, id);
  return projectId ? getProject(projectId) : undefined;
}

export async function findSimilar(text: string, options: FindSimilarOptions = {}): Promise<SimilarMatch[]> {
  const query = termsOf(text);
  if (!query.size) return [];
  const { scope } = options;
  const kinds = new Set(options.kinds?.length ? options.kinds : SIMILAR_KINDS);
  const limit = Math.max(1, Math.min(100, options.limit ?? 10));
  const minScore = options.minScore ?? 0.15;
  const sees = (kind: 'workflow' | 'agent', id: string) => !scope || Boolean((kind === 'workflow' ? scope.workflows : scope.agents)?.has(id));

  // The vector search, over every project when others are wanted (only to rank: nothing of a fact is shown from there).
  const hits = await vectorFactHits(text, options.includeOthers ? undefined : projectsOf(scope));
  const bonus = new Map<string, number>();
  hits.forEach((factId, rank) => {
    const fact = getFact(factId);
    if (!fact || (fact.subjectType !== 'workflow' && fact.subjectType !== 'agent')) return;
    const key = `${fact.subjectType}:${fact.subjectId}`;
    bonus.set(key, Math.max(bonus.get(key) ?? 0, vectorBonus(rank)));
  });

  const found: Array<{ score: number; match: SimilarMatch }> = [];
  const add = (score: number, match: SimilarMatch) => score >= minScore && found.push({ score, match });

  const candidates: Array<{ kind: 'workflow' | 'agent'; id: string; name: string; description?: string; owner?: string; active?: boolean }> = [];
  if (kinds.has('workflow')) {
    for (const w of store.listWorkflows()) {
      if (w.id === options.exclude?.workflowId) continue;
      const creator = w.createdBy ? getUser(w.createdBy)?.name : undefined;
      candidates.push({ kind: 'workflow', id: w.id, name: w.name, description: w.description, owner: creator, active: w.active });
    }
  }
  if (kinds.has('agent')) {
    for (const a of agentStore.list()) {
      if (a.id === options.exclude?.agentId) continue;
      const ownerId = projectOf('agent', a.id)?.ownerId;
      candidates.push({ kind: 'agent', id: a.id, name: a.name, description: a.description, owner: ownerId ? getUser(ownerId)?.name : undefined });
    }
  }
  for (const c of candidates) {
    const visible = sees(c.kind, c.id);
    if (!visible && !options.includeOthers) continue;
    const purpose = getProfile(c.kind, c.id)?.purpose;
    const score = round(overlap(query, `${c.name} ${c.name} ${c.description ?? ''} ${purpose ?? ''}`) + (bonus.get(`${c.kind}:${c.id}`) ?? 0));
    const goal = oneLine(purpose ?? c.description);
    const project = projectOf(c.kind, c.id)?.name;
    if (visible) {
      const own: SimilarOwn = { type: c.kind, title: c.name, ...(c.owner && { owner: c.owner }), ...(goal && { goal }), ...(project && { project }), score, yours: true, id: c.id, ...(c.description && { description: c.description }), ...(c.active !== undefined && { active: c.active }) };
      add(score, own);
    } else {
      // The projection: these fields only.
      const elsewhere: SimilarElsewhere = { type: c.kind, title: c.name, ...(c.owner && { owner: c.owner }), ...(goal && { goal }), ...(project && { project }), score };
      add(score, elsewhere);
    }
  }

  // Facts: only those the caller may read.
  if (kinds.has('fact')) {
    const rank = new Map(hits.map((id, i) => [id, i]));
    for (const fact of listFacts({ scope, limit: 5_000 })) {
      if (fact.subjectType === 'workflow' && fact.subjectId === options.exclude?.workflowId) continue;
      if (fact.subjectType === 'agent' && fact.subjectId === options.exclude?.agentId) continue;
      const words = overlap(query, `${fact.subjectName ?? ''} ${fact.statement}`);
      const vector = rank.has(fact.id) ? vectorBonus(rank.get(fact.id)!) + 0.3 : 0;
      const score = round(Math.max(words, vector));
      const project = fact.projectId ? getProject(fact.projectId)?.name : undefined;
      const own: SimilarOwn = {
        type: 'fact',
        title: fact.subjectName ?? fact.subjectId,
        goal: oneLine(fact.statement),
        ...(project && { project }),
        score,
        yours: true,
        id: fact.id,
        kind: fact.kind,
        statement: fact.statement,
        subject: { type: fact.subjectType, id: fact.subjectId },
      };
      add(score, own);
    }
  }
  return found.sort((a, b) => b.score - a.score).slice(0, limit).map((f) => f.match);
}
