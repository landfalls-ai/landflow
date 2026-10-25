/**
 * Ranking for the vector stores: cosine similarity for vector search, Okapi
 * BM25 for keyword search, and reciprocal rank fusion (RRF) to merge the two
 * lists in hybrid search. Brute force on purpose: the in-memory and SQLite
 * stores are meant for thousands of chunks, not millions.
 */

/** Cosine similarity in [-1, 1]; 0 when either vector is all zeros. Vectors of different lengths are an error. */
export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length) throw new Error(`Vectors have different dimensions (${a.length} and ${b.length}): were they made by the same embeddings model?`);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return normA && normB ? dot / Math.sqrt(normA * normB) : 0;
}

/** Common English words that carry no signal for keyword search. */
const STOPWORDS = new Set(
  'a an and are as at be but by for from has have he her his i in is it its of on or our she so that the their them they this to was we were what when where which who will with you your'.split(' '),
);

/** Lower-cased word and number terms, without stopwords: what BM25 and the Postgres keyword query match on. */
export function searchTerms(text: string): string[] {
  return (text.toLowerCase().normalize('NFKD').match(/[\p{L}\p{N}]+/gu) ?? []).filter((term) => !STOPWORDS.has(term));
}

export interface Bm25Options {
  /** Term-frequency saturation (default 1.2). */
  k1?: number;
  /** Length normalisation (default 0.75). */
  b?: number;
}

/**
 * Okapi BM25 score of every document for `query` (same order as `documents`). Terms that occur in no document
 * score nothing; IDF uses the "+1" variant so very common terms never go negative.
 */
export function bm25Scores(query: string, documents: string[], options: Bm25Options = {}): number[] {
  const k1 = options.k1 ?? 1.2;
  const b = options.b ?? 0.75;
  const terms = [...new Set(searchTerms(query))];
  if (!terms.length || !documents.length) return documents.map(() => 0);
  const docTerms = documents.map((doc) => searchTerms(doc));
  const averageLength = docTerms.reduce((sum, list) => sum + list.length, 0) / documents.length || 1;
  const frequencies = docTerms.map((list) => {
    const counts = new Map<string, number>();
    for (const term of list) counts.set(term, (counts.get(term) ?? 0) + 1);
    return counts;
  });
  const idf = new Map(
    terms.map((term) => {
      const containing = frequencies.filter((counts) => counts.has(term)).length;
      return [term, Math.log(1 + (documents.length - containing + 0.5) / (containing + 0.5))];
    }),
  );
  return frequencies.map((counts, i) => {
    let score = 0;
    for (const term of terms) {
      const tf = counts.get(term) ?? 0;
      if (!tf) continue;
      score += idf.get(term)! * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * docTerms[i].length) / averageLength)));
    }
    return score;
  });
}

/** RRF's damping constant: 60, as in the original paper and most search engines. */
export const RRF_K = 60;

/**
 * Reciprocal rank fusion: each list adds `1 / (k + rank)` (rank from 1) to the score of every id it contains,
 * so documents that rank well in several lists come first. Ties keep the order of first appearance.
 */
export function reciprocalRankFusion(lists: string[][], k = RRF_K): Array<{ id: string; score: number }> {
  const scores = new Map<string, number>();
  for (const list of lists) {
    list.forEach((id, index) => scores.set(id, (scores.get(id) ?? 0) + 1 / (k + index + 1)));
  }
  return [...scores.entries()].map(([id, score]) => ({ id, score })).sort((a, b) => b.score - a.score);
}

/** The `k` best entries of `scored` by score, highest first. */
export function topK<T extends { score: number }>(scored: T[], k: number): T[] {
  return [...scored].sort((a, b) => b.score - a.score).slice(0, Math.max(0, k));
}
