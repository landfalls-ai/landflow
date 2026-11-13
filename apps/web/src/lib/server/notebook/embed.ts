/**
 * Embeddings for the team notebook (docs/team-notebook.md#search-by-meaning): Ollama's `nomic-embed-text`, through the same
 * adapter the knowledge bases and the Embeddings Ollama node use (rag/embeddings.ts). A note is still written and found by
 * its words when Ollama is unreachable: a failure here only means "no vector", and after one the server isn't asked again
 * for a minute so a team run never waits on a host that is down.
 */
import { ollamaEmbeddings } from '../rag/embeddings';
import { ollamaUrl } from '../config';

export type NoteEmbedder = (texts: string[], as: 'document' | 'query') => Promise<number[][]>;

export const DEFAULT_EMBED_MODEL = 'nomic-embed-text';
/** How long one embedding request may take before the notebook falls back to words. */
const TIMEOUT_MS = 5_000;
/** After a failure the server is left alone this long. */
const BACKOFF_MS = 60_000;

let override: NoteEmbedder | undefined;
let downUntil = 0;

/** Replace the embedder (tests, or an instance that embeds some other way). `undefined` goes back to Ollama. */
export function setNotebookEmbedder(embedder: NoteEmbedder | undefined) {
  override = embedder;
  downUntil = 0;
}

export const embedModel = () => process.env.LANDFLOW_NOTEBOOK_EMBED_MODEL?.trim() || DEFAULT_EMBED_MODEL;
const enabled = () => !/^(off|false|0)$/i.test(process.env.LANDFLOW_NOTEBOOK_EMBEDDINGS?.trim() ?? '');

function ollama(): NoteEmbedder {
  const embeddings = ollamaEmbeddings({
    baseUrl: ollamaUrl(),
    model: embedModel(),
    // nomic-embed-text expects these prefixes: a stored text is a document, a question is a query.
    documentPrefix: 'search_document: ',
    queryPrefix: 'search_query: ',
  });
  return async (texts, as) => {
    const signal = AbortSignal.timeout(TIMEOUT_MS);
    return as === 'query' ? [await embeddings.embedQuery(texts[0], signal)] : embeddings.embedDocuments(texts, signal);
  };
}

/** Vectors for the texts, or undefined when embeddings are off or Ollama can't be reached (words are used instead). */
export async function embedTexts(texts: string[], as: 'document' | 'query'): Promise<{ vectors: number[][]; model: string } | undefined> {
  if (!texts.length || !enabled() || Date.now() < downUntil) return undefined;
  try {
    const vectors = await (override ?? ollama())(texts, as);
    if (vectors.length !== texts.length || vectors.some((v) => !Array.isArray(v) || !v.length)) return undefined;
    return { vectors, model: override ? 'custom' : embedModel() };
  } catch {
    downUntil = Date.now() + BACKOFF_MS;
    return undefined;
  }
}

export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || !a.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}
