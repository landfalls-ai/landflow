// The shapes of the memory backend (docs/second-brain.md#memory-backend, C07): one interface over a project's brain
// facts, a team's notebook and an agent's memory of one user. No zod and no runtime imports: the Run Trace, the MCP
// tools and the nodes all read these types.

/** Where memory lives: a project (its brain facts), a team (its notebook) or an agent's memory of one user. */
export type MemoryContainer = { kind: 'project'; id: string } | { kind: 'team'; id: string } | { kind: 'agent'; id: string; userId: string };

export type MemoryItemSource = 'fact' | 'note' | 'agent-memory' | 'provider';

export interface MemoryItem {
  id: string;
  text: string;
  kind: string;
  source: MemoryItemSource;
  /** 0..1, set by `search` only. */
  score?: number;
  version?: number;
  static?: boolean;
  createdAt: string;
  updatedAt: string;
}

export type MemorySearchMode = 'keyword' | 'meaning' | 'hybrid';

export interface MemorySearchOptions {
  mode?: MemorySearchMode;
  limit?: number;
  threshold?: number;
  /** A run that uses the result: a note's expiry moves (C07 FR-4). A playground or API call leaves it off. */
  touch?: boolean;
}

export interface MemorySearchResult {
  items: MemoryItem[];
  via: 'meaning' | 'keywords';
  /** What the threshold removed: how many, and the best score among them (C11 shows it). */
  dropped: { count: number; best?: number };
}

export interface MemoryProfile {
  static: MemoryItem[];
  recent: MemoryItem[];
}

export interface MemoryPage {
  items: MemoryItem[];
  nextCursor?: string;
}

export interface MemoryAddInput {
  text: string;
  kind?: string;
  static?: boolean;
  /** An ISO time, a minute to five years ahead (C02). */
  forgetAfter?: string;
  /** The id of the memory this one replaces: a new version of it (C01). */
  replaces?: string;
}

export const MEMORY_LIMITS = { search: { min: 1, max: 50, default: 10 }, list: { min: 1, max: 100, default: 20 } } as const;

/** `project:<id>`, `team:<id>` or `agent:<id>`: the wire form (the user of an agent container is always the caller's). */
export function containerKey(container: MemoryContainer): string {
  return `${container.kind}:${container.id}`;
}

/** The container a key names; an agent container needs the caller's user id. Anything else is undefined. */
export function parseContainer(key: string, userId?: string): MemoryContainer | undefined {
  const at = key.indexOf(':');
  if (at < 1) return undefined;
  const kind = key.slice(0, at);
  const id = key.slice(at + 1);
  if (!id) return undefined;
  if (kind === 'project' || kind === 'team') return { kind, id };
  if (kind === 'agent') return userId ? { kind, id, userId } : undefined;
  return undefined;
}
