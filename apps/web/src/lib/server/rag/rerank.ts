/**
 * LLM-as-reranker (the Reranker sub-node): the attached chat model scores each
 * retrieved passage 0–10 for the query in one JSON reply, and the passages are
 * re-ordered by that score. A reply that can't be used keeps the retrieval order.
 */
import type { AiDocument, LanguageModel, Reranker } from '@landflow/engine';
import { generateStructured, type JsonSchema } from '../nodes/structured';
import { traceRerank } from '../telemetry';

export interface LlmRerankerOptions {
  /** Keep this many after reranking (the caller's `topK` wins). */
  topK?: number;
  /** Each passage is cut to this many characters in the prompt (default 1000). */
  maxCharacters?: number;
  /** Extra guidance for the model, e.g. "prefer the most recent policy". */
  instructions?: string;
}

const SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    scores: {
      type: 'array',
      items: { type: 'object', properties: { index: { type: 'integer' }, score: { type: 'number', minimum: 0, maximum: 10 } }, required: ['index', 'score'] },
    },
  },
  required: ['scores'],
};

const SYSTEM = [
  'You rank passages by how useful they are for answering a search query.',
  'Score every passage from 0 (irrelevant) to 10 (answers the query directly).',
  'Reply with JSON only: {"scores":[{"index":0,"score":7},…]} with one entry per passage.',
].join(' ');

export function llmReranker(model: LanguageModel, options: LlmRerankerOptions = {}): Reranker {
  const maxCharacters = Math.max(100, options.maxCharacters ?? 1000);
  return {
    async rerank(query, documents, rerankOptions) {
      const keep = Math.max(1, rerankOptions?.topK ?? options.topK ?? documents.length);
      if (documents.length <= 1) return documents.slice(0, keep);
      return traceRerank({ method: 'llm', model: model.model, documents: documents.length, topK: keep }, async () => {
        const passages = documents.map((doc, i) => `[${i}] ${doc.pageContent.slice(0, maxCharacters).replace(/\s+/g, ' ')}`).join('\n\n');
        const prompt = `Query: ${query}\n\nPassages:\n${passages}`;
        let scores: Map<number, number>;
        try {
          const { value } = await generateStructured<{ scores: Array<{ index: number; score: number }> }>(model, {
            system: [SYSTEM, options.instructions?.trim()].filter(Boolean).join('\n\n'),
            prompt,
            schema: SCHEMA,
            ...(rerankOptions?.signal && { signal: rerankOptions.signal }),
          });
          scores = new Map(value.scores.filter((s) => Number.isInteger(s.index) && s.index >= 0 && s.index < documents.length).map((s) => [s.index, s.score]));
        } catch (error) {
          if (rerankOptions?.signal?.aborted) throw error;
          // Keep the retrieval order rather than fail the search.
          return documents.slice(0, keep);
        }
        return rankByScores(documents, scores).slice(0, keep);
      });
    },
  };
}

/** Order documents by score (0–10, unscored last), keeping the original order on ties; `score` becomes score / 10. */
export function rankByScores(documents: AiDocument[], scores: Map<number, number>): AiDocument[] {
  return documents
    .map((doc, index) => ({ doc, index, score: scores.get(index) }))
    .sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || a.index - b.index)
    .map(({ doc, score }) => ({ ...doc, ...(score !== undefined && { score: score / 10 }) }));
}
