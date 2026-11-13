/**
 * Embeddings adapters supplied by the embeddings sub-nodes: Ollama's
 * `/api/embed` and any OpenAI-compatible `/embeddings`. Texts go in batches;
 * every call is a `gen_ai.embeddings {model}` span and counts in `landflow.ai.*`.
 */
import { NodeOperationError } from '@landflow/sdk';
import type { Embeddings } from '@landflow/engine';
import { safeFetch } from '../net/safe-fetch';
import { openAiEmbeddings, type OpenAiConnection } from '../nodes/models';
import { traceEmbeddings } from '../telemetry';

export interface OllamaEmbeddingsOptions {
  baseUrl: string;
  model: string;
  /** Shorten the vectors (models trained for it, e.g. nomic-embed-text v1.5). */
  dimensions?: number;
  /** Prepended to every stored text, e.g. nomic-embed-text's "search_document: ". */
  documentPrefix?: string;
  /** Prepended to every query, e.g. "search_query: ". */
  queryPrefix?: string;
  /** Texts per request (default 64). */
  batchSize?: number;
}

/** Split `texts` into batches and embed them one batch after the other. */
async function inBatches(texts: string[], size: number, embed: (batch: string[]) => Promise<number[][]>): Promise<number[][]> {
  const vectors: number[][] = [];
  for (let start = 0; start < texts.length; start += size) vectors.push(...(await embed(texts.slice(start, start + size))));
  return vectors;
}

export function ollamaEmbeddings(options: OllamaEmbeddingsOptions): Embeddings {
  const base = options.baseUrl.replace(/\/+$/, '');
  const url = URL.canParse(base) ? new URL(base) : undefined;
  const attributes = { ...(url && { 'server.address': url.hostname }), ...(url?.port && { 'server.port': Number(url.port) }) };
  const batchSize = Math.max(1, options.batchSize ?? 64);

  async function embed(input: string[], signal?: AbortSignal): Promise<number[][]> {
    return traceEmbeddings(
      { system: 'ollama', model: options.model, attributes },
      async () => {
        let response: Response;
        try {
          response = await safeFetch(`${base}/api/embed`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model: options.model, input, truncate: true, ...(options.dimensions && { dimensions: options.dimensions }) }),
            signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(300_000)]) : AbortSignal.timeout(300_000),
          });
        } catch (error) {
          if (signal?.aborted) throw error;
          throw new NodeOperationError(`Cannot reach Ollama at ${base}`, { description: (error as Error).message });
        }
        const text = await response.text();
        if (!response.ok) {
          const detail = (() => {
            try {
              return (JSON.parse(text) as { error?: string }).error ?? text;
            } catch {
              return text;
            }
          })();
          const hint = /not found/i.test(detail) ? ` Pull it first: ollama pull ${options.model}` : '';
          throw new NodeOperationError(`Ollama error ${response.status}: ${detail.slice(0, 300)}`, { ...(hint && { description: hint.trim() }) });
        }
        const data = JSON.parse(text) as { model?: string; embeddings?: number[][]; prompt_eval_count?: number };
        if (!Array.isArray(data.embeddings) || data.embeddings.length !== input.length) {
          throw new NodeOperationError(`Ollama returned ${data.embeddings?.length ?? 0} embedding(s) for ${input.length} text(s)`, { description: `Is “${options.model}” an embedding model?` });
        }
        return { vectors: data.embeddings, model: data.model, inputTokens: data.prompt_eval_count };
      },
      (result) => ({ responseModel: result.model, inputTokens: result.inputTokens, dimensions: result.vectors[0]?.length }),
    ).then((result) => result.vectors);
  }

  return {
    provider: 'ollama',
    model: options.model,
    embedDocuments: (texts, signal) => inBatches(texts.map((t) => (options.documentPrefix ?? '') + t), batchSize, (batch) => embed(batch, signal)),
    embedQuery: async (text, signal) => (await embed([(options.queryPrefix ?? '') + text], signal))[0],
  };
}

/** OpenAI or any OpenAI-compatible server (the `openAiApi` credential), through `POST /embeddings`. */
export function openAiCompatibleEmbeddings(connection: OpenAiConnection, options: { model: string; dimensions?: number; batchSize?: number }): Embeddings {
  const batchSize = Math.max(1, options.batchSize ?? 100);
  const embed = async (input: string[], signal?: AbortSignal) =>
    (await openAiEmbeddings(connection, options.model, input, { ...(options.dimensions && { dimensions: options.dimensions }), ...(signal && { signal }) })).vectors;
  return {
    provider: connection.system,
    model: options.model,
    embedDocuments: (texts, signal) => inBatches(texts, batchSize, (batch) => embed(batch, signal)),
    embedQuery: async (text, signal) => (await embed([text], signal))[0],
  };
}
