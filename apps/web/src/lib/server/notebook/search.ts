/**
 * Finding notes (docs/team-notebook.md#search-by-meaning): by meaning when the embedding model answers (cosine similarity
 * against each note's vector), by words when it doesn't (and for notes that have no vector yet). `via` tells which one the
 * ranking used, so a tool can say so and a test can tell them apart.
 */
import type { MemorySearchMode } from '../../shared/memory';
import type { NoteHit, TeamNote } from '../../shared/notebook';
import { cosine, embedTexts } from './embed';
import { noteStore, type NoteFilter } from './store';

/** Below this a cosine match is noise for nomic-embed-text, unless the words agree. */
const MEANING_FLOOR = 0.42;
const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'is', 'are', 'was', 'be', 'it', 'this', 'that', 'we', 'do', 'does', 'how', 'what', 'which', 'with', 'as', 'at', 'by']);

const words = (text: string) =>
  text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 1 && !STOP.has(w));

/** How much of the query the text says: each query word counts when the text has it (or a word it starts with, 4+ letters). */
export function keywordScore(query: string, text: string): number {
  const wanted = [...new Set(words(query))];
  if (!wanted.length) return 0;
  const have = words(text);
  const hit = wanted.filter((w) => have.some((h) => h === w || (w.length >= 4 && h.length >= 4 && (h.startsWith(w.slice(0, Math.max(4, w.length - 2))) || w.startsWith(h.slice(0, Math.max(4, h.length - 2)))))));
  return hit.length / wanted.length;
}

/**
 * One score for meaning and words (C07 D6), 0..1, shared by notes and facts so both rank the same way. The words agreeing
 * lifts a meaning match; a meaning match under the floor with no shared word is 0; with no meaning only the words count.
 */
export function fuseScores(meaning: number | undefined, words: number): number {
  if (meaning === undefined) return words * 0.8;
  return meaning >= MEANING_FLOOR || words > 0 ? Math.min(1, Math.max(meaning, words * 0.8) + words * 0.1) : 0;
}

export interface SearchResult {
  hits: NoteHit[];
  via: 'meaning' | 'keywords';
}

export interface SearchNotesOptions {
  /** Reading a hit counts as using it and moves its expiry (default: yes, for a run). A playground or API read passes false. */
  touch?: boolean;
  /** Hits scoring under this (0..1) are dropped and counted. */
  threshold?: number;
  /** `keyword` never embeds the query; `meaning` ignores the words; default `hybrid`. */
  mode?: MemorySearchMode;
  /** The most hits one call may return (default 20; the memory backend passes 50). */
  maxLimit?: number;
}

/** The notes `filter` sees that best match `query`, at most `limit`. Reading them counts as using them (their expiry moves) unless `touch: false`. */
export async function searchNotes(query: string, filter: NoteFilter, limit = 5, options: SearchNotesOptions = {}): Promise<SearchResult & { dropped: { count: number; best?: number } }> {
  const none = { hits: [], via: 'keywords' as const, dropped: { count: 0 } };
  const notes = noteStore.list({ ...filter, limit: 1000 });
  const text = query.trim();
  if (!text || !notes.length) return none;
  const mode = options.mode ?? 'hybrid';
  const embedded = mode === 'keyword' ? [] : notes.filter((n) => n.embedded);
  const asked = embedded.length ? await embedTexts([text], 'query') : undefined;
  const vectors = asked ? noteStore.vectors(embedded.map((n) => n.id)) : new Map<string, number[]>();
  const queryVector = asked?.vectors[0];
  const scored = notes.map((note): NoteHit => {
    const words = keywordScore(text, note.text + (note.answer ? ` ${note.answer}` : ''));
    const vector = vectors.get(note.id);
    if (mode === 'keyword') return { ...note, score: words };
    if (queryVector && vector) {
      const meaning = cosine(queryVector, vector);
      if (mode === 'meaning') return { ...note, score: meaning >= MEANING_FLOOR ? meaning : 0 };
      return { ...note, score: fuseScores(meaning, words) };
    }
    return { ...note, score: mode === 'meaning' ? 0 : fuseScores(undefined, words) };
  });
  const threshold = options.threshold ?? 0;
  const matched = scored.filter((n) => n.score > 0);
  const kept = matched.filter((n) => n.score >= threshold);
  const droppedScores = matched.filter((n) => n.score < threshold).map((n) => n.score);
  const hits = kept.sort((a, b) => b.score - a.score || Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, Math.max(1, Math.min(options.maxLimit ?? 20, limit)));
  if (options.touch !== false) noteStore.touch(hits as TeamNote[]);
  return { hits, via: queryVector ? 'meaning' : 'keywords', dropped: { count: droppedScores.length, ...(droppedScores.length && { best: Math.max(...droppedScores) }) } };
}
