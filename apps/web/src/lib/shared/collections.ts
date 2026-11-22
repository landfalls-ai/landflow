/**
 * C21: who may use a vector collection. The pure rules (store keys, levels, the brain's closed names) shared by the host
 * (lib/server/rag/collection-access.ts) and the project's Collections card. No runtime import from lib/server, no zod.
 */
import { AGENT_MEMORY_COLLECTION, BRAIN_COLLECTION_PREFIX, isBrainCollection } from './brain';
import { notionKnowledgeCollection } from './notion-brain';

export const STORE_KINDS = ['memory', 'sqlite', 'pgvector'] as const;
export type StoreKind = (typeof STORE_KINDS)[number];

/** `read` searches; `write` also inserts, clears and deletes (and implies `read`: there is no write-only level). */
export const COLLECTION_LEVELS = ['read', 'write'] as const;
export type CollectionLevel = (typeof COLLECTION_LEVELS)[number];
export type Need = CollectionLevel;

/** A grant row's project for "All projects" (C21-D3). */
export const ALL_PROJECTS_GRANT = '*';

/**
 * A grant row that records what the upgrade took away (C21-D2, strict): the project named the collection before, another
 * project owns it now, and the project has no access until an admin of the owner grants it. Never gives access.
 */
export const LOST_LEVEL = 'lost';

/** The row that says the one-time adoption ran. Never a collection. */
export const ADOPTED_KEY = '__adopted__';

/** Where a collection's owner came from. */
export type OwnerSource = 'first-write' | 'upgrade' | 'admin';

/** How a store is reached, for the key of a pgvector collection (one key per database and table, not per credential). */
export interface PgIdentity {
  host: string;
  port: number;
  database: string;
  table: string;
}

/** The connection a `postgres` credential's values describe (the same defaults the PGVector store connects with) and the table. */
export function pgIdentityOf(data: Record<string, unknown> | undefined, table?: string): PgIdentity {
  const text = (value: unknown, fallback: string) => (typeof value === 'string' && value.trim() ? value.trim() : fallback);
  return { host: text(data?.host, 'localhost'), port: Number(data?.port) || 5432, database: text(data?.database, 'postgres'), table: text(table, 'landflow_vectors') };
}

/**
 * The key a collection is kept under in the host's database: `memory:<name>`, `sqlite:<name>`,
 * `pgvector:<JSON array of host, port, database, table, name>` (a JSON array so no part can run into the next). The name is
 * trimmed and keeps its case: the stores compare names exactly, so `HR` and `hr` are two collections. The brain's closed
 * names are not case-sensitive and have one key whatever the store: `brain:<lower-cased name>`.
 */
export function storeKeyOf(store: StoreKind, name: string, pg?: PgIdentity): string {
  const clean = name.trim();
  if (isBrainCollection(clean)) return `brain:${clean.toLowerCase()}`;
  if (store === 'pgvector') {
    if (!pg) throw new Error('A pgvector collection key needs its connection');
    return `pgvector:${JSON.stringify([pg.host.toLowerCase(), pg.port, pg.database, pg.table.trim(), clean])}`;
  }
  return `${store}:${clean}`;
}

/** The store and name a key stands for (the card shows both). */
export function partsOfKey(key: string): { store: string; name: string } {
  if (key.startsWith('brain:')) return { store: 'brain', name: key.slice(6) };
  const store = key.slice(0, key.indexOf(':'));
  if (store === 'pgvector') {
    try {
      const [host, port, database, table, name] = JSON.parse(key.slice('pgvector:'.length)) as [string, number, string, string, string];
      return { store: `pgvector (${host}:${port}/${database}, ${table})`, name };
    } catch {
      return { store: 'pgvector', name: key.slice('pgvector:'.length) };
    }
  }
  return { store, name: key.slice(store.length + 1) };
}

/** Whether `have` allows `need`: write implies read. */
export const canUse = (have: CollectionLevel, need: Need): boolean => have === 'write' || need === 'read';

/**
 * The brain's closed names: `landflow-brain*`, `landflow-agent-memory` and `landflow-notion-<project>`. The only opening is
 * a project's own Notion knowledge collection, read by that project's flows, when its admin turned the switch on (FR-7).
 */
export function brainReadAllowed(name: string, projectId: string | undefined, notionSwitchOn: boolean): boolean {
  if (!projectId || !notionSwitchOn) return false;
  const lower = name.trim().toLowerCase();
  if (lower === AGENT_MEMORY_COLLECTION || lower === BRAIN_COLLECTION_PREFIX || lower.startsWith(`${BRAIN_COLLECTION_PREFIX}-`)) return false;
  return lower === notionKnowledgeCollection(projectId).toLowerCase();
}

/** The key of a project's own Notion knowledge collection (where its read switch is kept). */
export const notionKeyOf = (projectId: string): string => storeKeyOf('sqlite', notionKnowledgeCollection(projectId));

/** What a project may do with a collection. */
export type CollectionAccess = 'owner' | 'write' | 'read' | 'none' | 'unclaimed';

/** One collection as the project's card and the listings show it. */
export interface CollectionView {
  key: string;
  store: string;
  name: string;
  /** This project owns it, or was granted `read` / `write`. */
  access: 'owner' | CollectionLevel;
  ownerProjectId: string;
  ownerName?: string;
  source: OwnerSource;
  /** Only for the owner's admins: who else may use it. */
  grants?: Array<{ projectId: string; projectName?: string; level: CollectionLevel }>;
  /** Only for the owner's admins: projects that named it before the upgrade and lost access (C21-D2). */
  lostAccess?: Array<{ projectId: string; projectName?: string }>;
}

/** What GET /api/projects/:id/collections answers. */
export interface ProjectCollections {
  collections: CollectionView[];
  /** Collections this project named before the upgrade and lost (owned by another project now). */
  lost: Array<{ key: string; store: string; name: string; ownerProjectId: string; ownerName?: string }>;
  canManage: boolean;
  /** FR-7: whether this project's flows may read its own Notion knowledge collection (shown only when it has one). */
  notion: { collection: string; read: boolean } | null;
  /** More than the answer's cap are owned: the rest are not listed. */
  truncated?: boolean;
}
