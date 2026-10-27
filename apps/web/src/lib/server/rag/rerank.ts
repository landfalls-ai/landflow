/**
 * LLM-as-reranker (the Reranker sub-node): the attached chat model scores each
 * retrieved passage 0–10 for the query in one JSON reply, and the passages are
 * re-ordered by that score. A reply that can't be used keeps the retrieval order.
 */
import type { AiDocument, LanguageModel, Reranker } from '@landflow/engine';
import { NodeOperationError } from '@landflow/sdk';
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

export interface CohereRerankerOptions {
  /** Cohere's API root (default https://api.cohere.com), or a Cohere-compatible server such as vLLM, Jina or a gateway. */
  baseUrl?: string;
  apiKey?: string;
  /** Default rerank-v3.5. */
  model?: string;
  topK?: number;
  /** Cohere's `max_tokens_per_doc`: longer passages are cut. */
  maxTokensPerDoc?: number;
  /** A failed call keeps the retrieval order instead of failing the search. */
  keepOrderOnFailure?: boolean;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export const COHERE_BASE_URL = 'https://api.cohere.com';

/**
 * Cohere's rerank API (`POST {base}/v2/rerank`): the passages are scored by a cross-encoder and come back ordered,
 * each with a `relevance_score` between 0 and 1 (kept as the document's `score`).
 */
export function cohereReranker(options: CohereRerankerOptions = {}): Reranker {
  const base = (options.baseUrl?.trim() || COHERE_BASE_URL).replace(/\/+$/, '');
  const model = options.model?.trim() || 'rerank-v3.5';
  const send = options.fetch ?? fetch;
  return {
    async rerank(query, documents, rerankOptions) {
      const keep = Math.max(1, rerankOptions?.topK ?? options.topK ?? documents.length);
      if (documents.length <= 1) return documents.slice(0, keep);
      return traceRerank({ method: 'cohere', model, documents: documents.length, topK: keep }, async () => {
        try {
          const response = await send(`${base}/v2/rerank`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json', ...(options.apiKey && { authorization: `Bearer ${options.apiKey}` }) },
            body: JSON.stringify({
              model,
              query,
              documents: documents.map((doc) => doc.pageContent),
              top_n: Math.min(keep, documents.length),
              ...(options.maxTokensPerDoc && { max_tokens_per_doc: options.maxTokensPerDoc }),
            }),
            signal: AbortSignal.any([...(rerankOptions?.signal ? [rerankOptions.signal] : []), AbortSignal.timeout(options.timeoutMs ?? 30_000)]),
          });
          if (!response.ok) {
            const detail = (await response.text().catch(() => '')).slice(0, 300);
            throw new NodeOperationError(`The reranker answered ${response.status}`, { description: `${base}/v2/rerank${detail ? `: ${detail}` : ''}` });
          }
          const data = (await response.json()) as { results?: Array<{ index: number; relevance_score: number }> };
          if (!Array.isArray(data.results)) throw new NodeOperationError('The reranker’s reply has no results', { description: 'Expected Cohere’s { results: [{ index, relevance_score }] }.' });
          const ranked = data.results
            .filter((r) => Number.isInteger(r.index) && r.index >= 0 && r.index < documents.length && typeof r.relevance_score === 'number')
            .sort((a, b) => b.relevance_score - a.relevance_score)
            .map((r) => ({ ...documents[r.index], score: r.relevance_score }));
          return ranked.slice(0, keep);
        } catch (error) {
          if (rerankOptions?.signal?.aborted) throw error;
          if (options.keepOrderOnFailure) return documents.slice(0, keep);
          if (error instanceof NodeOperationError) throw error;
          throw new NodeOperationError(`Can’t reach the reranker at ${base}`, { description: (error as Error).message });
        }
      });
    },
  };
}
