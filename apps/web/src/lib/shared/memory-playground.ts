// The shapes of the memory search playground (docs/run-trace.md#memory-playground, C11): one request over a knowledge base, a
// team notebook or a project's brain facts, and the answer with scores before and after rerank. No zod and no runtime imports:
// the playground component reads these types; the route's body schema is server only (lib/server/memory/playground-schema.ts).

export type PlaygroundMode = 'keyword' | 'meaning' | 'hybrid';

/** What a playground searches: a knowledge base of an agent, a team's notebook, a project's facts (its home project when absent). */
export type PlaygroundSource = { kind: 'kb'; agentId: string; toolId: string } | { kind: 'notebook'; teamId: string; projectId?: string } | { kind: 'facts'; projectId?: string };

/** A reranker the caller may use: a Cohere (or compatible) credential, or a local chat model that scores each passage. */
export type PlaygroundRerank = { kind: 'cohere'; credentialId: string; model?: string } | { kind: 'llm'; model: string };

export interface PlaygroundRequest {
  source: PlaygroundSource;
  query: string;
  mode: PlaygroundMode;
  /** 1 to 50 (default 10). */
  limit: number;
  /** 0 to 1: a result scoring under it is dropped and counted. */
  threshold: number;
  rerank?: PlaygroundRerank;
}

export const PLAYGROUND_LIMITS = { query: 2_000, limit: { min: 1, max: 50, default: 10 }, perMinute: 20 } as const;
/** The threshold a facts or notebook playground starts at (a knowledge base starts at 0). */
export const PLAYGROUND_THRESHOLD = 0.3;

export interface PlaygroundResult {
  id: string;
  text: string;
  /** The retrieval score (0..1 for notes and facts; a store's own scale for a knowledge base). */
  score: number;
  /** The score after the reranker, when rerank was on. */
  rerankScore?: number;
  /** Where it came from: a note, a fact, or a document of the knowledge base. */
  sourceId: string;
  kind?: string;
}

export interface PlaygroundAnswer {
  results: PlaygroundResult[];
  /** What the threshold removed: how many, and the best score among them. */
  dropped: { count: number; best?: number };
  via: 'meaning' | 'keywords';
  timings: { embedMs?: number; searchMs: number; rerankMs?: number };
  /** Said in words when the search could not run as asked (the embedding model is down); then `results` is empty. */
  error?: string;
}

export const EMBEDDER_DOWN = 'The embedding model is unreachable';
