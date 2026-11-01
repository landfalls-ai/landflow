/**
 * Finding notes (docs/team-notebook.md#search-by-meaning): by meaning when the embedding model answers (cosine similarity
 * against each note's vector), by words when it doesn't (and for notes that have no vector yet). `via` tells which one the
 * ranking used, so a tool can say so and a test can tell them apart.
 */
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

export interface SearchResult {
  hits: NoteHit[];
  via: 'meaning' | 'keywords';
}

/** The notes `filter` sees that best match `query`, at most `limit`. Reading them counts as using them (their expiry moves). */
export async function searchNotes(query: string, filter: NoteFilter, limit = 5): Promise<SearchResult> {
  const notes = noteStore.list({ ...filter, limit: 1000 });
  const text = query.trim();
  if (!text || !notes.length) return { hits: [], via: 'keywords' };
  const embedded = notes.filter((n) => n.embedded);
  const asked = embedded.length ? await embedTexts([text], 'query') : undefined;
  const vectors = asked ? noteStore.vectors(embedded.map((n) => n.id)) : new Map<string, number[]>();
  const queryVector = asked?.vectors[0];
  const scored = notes.map((note): NoteHit => {
    const words = keywordScore(text, note.text + (note.answer ? ` ${note.answer}` : ''));
    const vector = vectors.get(note.id);
    if (queryVector && vector) {
      const meaning = cosine(queryVector, vector);
      // The words agreeing lifts a match; a meaning match under the floor with no shared word is dropped below.
      return { ...note, score: meaning >= MEANING_FLOOR || words > 0 ? Math.min(1, Math.max(meaning, words * 0.8) + words * 0.1) : 0 };
    }
    return { ...note, score: words * 0.8 };
  });
  const hits = scored
    .filter((n) => n.score > 0)
    .sort((a, b) => b.score - a.score || Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, Math.max(1, Math.min(20, limit)));
  noteStore.touch(hits as TeamNote[]);
  return { hits, via: queryVector ? 'meaning' : 'keywords' };
}
