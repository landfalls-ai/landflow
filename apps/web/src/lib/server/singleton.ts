/**
 * Process-wide singletons: the one way to hold state that must exist once per process. Next.js compiles
 * instrumentation and each route into separate module graphs (and re-evaluates modules on HMR), so module-level
 * state would be duplicated; this map lives on globalThis and every graph sees the same one. Nothing else in lib/
 * touches `globalThis.__landflow` (test/singletons.test.ts scans for it).
 */
const store = globalThis as unknown as { __landflow?: Map<string, unknown> };
const registry = () => (store.__landflow ??= new Map());

/** Keys used by more than one file, each with one definition so the files can't drift apart. */
export const singletonKeys = {
  /** HMAC secret of binary tokens (binary/access.ts) and MCP signatures (mcp/signing.ts). */
  binaryTokenSecret: 'binary-token-secret',
  /** The binary store's promise (binary/access.ts; a test swaps it). */
  binaryStore: 'binary-store',
  /** Data table rows cached process-wide (datatables/service.ts; cluster/index.ts drops entries other processes changed). */
  dataTablesSqlCache: 'data-tables-sql-cache',
  /** One git/source-control operation at a time (sync/git.ts, environments/promote.ts). */
  sourceControlQueue: 'source-control-queue',
  /** Queue mode's start promise (cluster/index.ts; reset on stop). */
  clusterStart: 'cluster-start',
} as const;

export function singleton<T>(key: string, create: () => T): T {
  const map = registry();
  if (!map.has(key)) map.set(key, create());
  return map.get(key) as T;
}

/** Drop a singleton so the next `singleton(key, …)` creates it again (a failed boot retries; tests start clean). */
export function resetSingleton(key: string): void {
  store.__landflow?.delete(key);
}

/** The old name, kept for callers that have not moved. */
export const forgetSingleton = resetSingleton;

/**
 * Workflows only instance admins may change (the installed access-request flows, access/guard.ts). The workflow store and project access
 * ask here and import nothing else of the feature, so their import closure stays small; the feature registers itself at load.
 */
interface Locks {
  /** The ids that are locked right now. */
  providers: Array<() => string[]>;
  /** Called with (workflowId, actorId) on every save made by someone; throws to refuse. */
  saveGuards: Array<(workflowId: string, actorId: string) => void>;
}

const locks = () => singleton<Locks>('workflow-locks', () => ({ providers: [], saveGuards: [] }));

export const registerWorkflowLock = (lock: { locked: () => string[]; guard: (workflowId: string, actorId: string) => void }): void => {
  const state = locks();
  if (!state.providers.includes(lock.locked)) state.providers.push(lock.locked);
  if (!state.saveGuards.includes(lock.guard)) state.saveGuards.push(lock.guard);
};

export const isLockedWorkflow = (workflowId: string): boolean => locks().providers.some((provider) => provider().includes(workflowId));
export const guardWorkflowSave = (workflowId: string, actorId: string): void => locks().saveGuards.forEach((guard) => guard(workflowId, actorId));
