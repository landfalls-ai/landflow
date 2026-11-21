/**
 * The memory backend interface (docs/second-brain.md#memory-backend, C07): five operations over three containers, so a
 * flow node, an MCP tool and an agent's recall all use one thing and a plugin can provide it. Callers never reach into
 * `brain_facts`, `team_notes` or `agent_memory` directly. The built-in backend maps containers onto those stores
 * (./builtin); a project can choose a plugin provider instead (./remote). Access and spans are the façade's (./index).
 */
import type { MemoryAddInput, MemoryContainer, MemoryItem, MemoryPage, MemoryProfile, MemorySearchOptions, MemorySearchResult } from '../../shared/memory';
import { HttpError } from '../errors';
import type { NotebookBinding } from '../notebook/service';
import type { Actor } from '../projects/access';

/** Who is calling: a person (actor), or a run that acts for the instance in one project (`system` with `projectId`). */
export interface MemoryCaller {
  actor?: Actor;
  /** No person: a seeded flow or an agent's tool. It reaches `projectId`'s containers only. */
  system?: boolean;
  projectId?: string;
  /** Who a write is recorded as (a signed-in person, or the instance). */
  origin: 'person' | 'landflow';
  /** The person the call is for (an agent container is that person's). */
  userId?: string;
  /** The API key that called (audited; never the key). */
  keyId?: string;
  run?: { executionId?: string; agentId?: string };
  /** A team run's notebook binding: the only thing that can write a note (C07 D9) and the only way to read a run's notes. */
  notebook?: NotebookBinding;
}

/** The container does not exist or the caller may not read it: the same answer, so existence stays private (FR-3). */
export class MemoryNotFoundError extends HttpError {
  static readonly errorName: string = 'MemoryNotFoundError';
  constructor(message = 'Memory not found') {
    super(message, 404);
  }
}

/** The container's owner forbids this write (a study kind, a note outside a run, an empty text). */
export class MemoryWriteRefusedError extends HttpError {
  static readonly errorName: string = 'MemoryWriteRefusedError';
  constructor(message: string) {
    super(message, 400);
  }
}

/** A memory provider failed, timed out or answered something that is not its contract. No other backend is tried (FR-8). */
export class MemoryProviderError extends HttpError {
  static readonly errorName: string = 'MemoryProviderError';
  constructor(message: string) {
    super(message, 502);
  }
}

export interface MemoryBackend {
  /** Which backend this is, for spans: `built-in` or `provider`. */
  readonly name: 'built-in' | 'provider';
  search(container: MemoryContainer, query: string, options: MemorySearchOptions, caller: MemoryCaller): Promise<MemorySearchResult>;
  /** Static items first, then the most recent ones. */
  profile(container: MemoryContainer, caller: MemoryCaller): Promise<MemoryProfile>;
  /** A new item, or (with `replaces`) a new version of one. Returns the item as stored. */
  add(container: MemoryContainer, input: MemoryAddInput, caller: MemoryCaller): Promise<MemoryItem>;
  /** Forgets softly with a reason; the item leaves every read. The container says where to look and who may. */
  forget(container: MemoryContainer, id: string, reason: string, caller: MemoryCaller): Promise<MemoryItem>;
  list(container: MemoryContainer, page: { limit?: number; cursor?: string }, caller: MemoryCaller): Promise<MemoryPage>;
}

export type { MemoryContainer };
