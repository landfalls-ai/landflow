/**
 * The brain store's port (docs/features/notion-brain.md#how-it-is-built): which store a project's brain is read and written
 * through, and the change feed every brain write goes through. The local store registers itself
 * (lib/server/brain/store/local.ts, loaded by lib/server/brain/store/index.ts); a project's backend comes from the resolver
 * the Notion links register (lib/server/brain/notion/links.ts, NB03). Nothing here imports a brain module, so either side can
 * load it alone.
 *
 * Written by the plan for the Notion brain program, wave nb1: NB01 owns it (backbone/contracts/nb/brain-store-port.ts); NB03
 * adds this file byte for byte. Change it in the contract first, then every copy.
 */
import type { BrainBackendResolver, BrainChange, BrainChangeListener, BrainStore } from '../../../shared/brain-store';
import { singleton } from '../../singleton';
import { logger } from '../../telemetry/logger';

interface Slot {
  local?: BrainStore;
  resolver?: BrainBackendResolver;
  listeners: Set<BrainChangeListener>;
}

const slot = () => singleton('brain-store', (): Slot => ({ listeners: new Set() }));

/** The local store (local.ts calls this when it loads; a later call replaces it, so a test that sets a fake loads the real one first). */
export function setLocalBrainStore(store: BrainStore | undefined): void {
  slot().local = store;
}

/** Which backend a project uses (links.ts, NB03). Undefined: every project is local. */
export function setBackendResolver(resolver: BrainBackendResolver | undefined): void {
  slot().resolver = resolver;
}

/** The local store reporting another backend: what a linked project gets before a Notion store is registered (nb1). */
function reporting(store: BrainStore, backend: 'notion'): BrainStore {
  return new Proxy(store, { get: (target, key, receiver) => (key === 'backend' ? backend : Reflect.get(target, key, receiver)) });
}

/**
 * The store for `projectId`'s brain: the resolver's answer for a linked project, else the local store. No project (an
 * instance-wide read, an org practice): always the local store. Throws when no local store is registered (import
 * `lib/server/brain/store`, not this file, to use the brain).
 */
export function brainStoreFor(projectId: string | undefined): BrainStore {
  const { local, resolver } = slot();
  if (!local) throw new Error('The brain store is not loaded: import lib/server/brain/store');
  if (!projectId || !resolver) return local;
  let resolved: ReturnType<BrainBackendResolver>;
  try {
    resolved = resolver(projectId);
  } catch (error) {
    // A resolver that fails (its table missing, a bad row) never stops the brain: the project reads and writes locally.
    logger.warn('[brain-store] backend resolver failed; using the local store', { projectId, error });
    return local;
  }
  if (!resolved || resolved.backend === 'local') return local;
  return resolved.store ?? reporting(local, 'notion');
}

/** Hear every brain write. Returns the unsubscribe function. */
export function onBrainChange(listener: BrainChangeListener): () => void {
  const { listeners } = slot();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Tell the listeners about a write that was stored. Call it after the write returned (never inside a transaction that may
 * still throw). Listeners run in a microtask, one after the other; one that throws is logged (kind and key only, never
 * text) and the next still runs. Never throws.
 */
export function emitBrainChange(change: BrainChange): void {
  const listeners = [...slot().listeners];
  if (!listeners.length) return;
  queueMicrotask(() => {
    for (const listener of listeners) {
      try {
        listener(change);
      } catch (error) {
        logger.warn('[brain-store] a change listener failed', { kind: change.kind, key: change.key, error });
      }
    }
  });
}
