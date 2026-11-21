/**
 * Reads the state of memory items for "What it saw" (C11): `/api/memory/items` takes at most 50 ids a call, so the ids go in
 * batches, and one call per distinct batch: the same ids asked again (a re-render, a parent handing a new array of the same
 * ids) share the request already made.
 */
export const ITEMS_BATCH = 50;

/** The ids split into batches of at most 50. */
export const idBatches = (ids: string[]): string[][] => Array.from({ length: Math.ceil(ids.length / ITEMS_BATCH) }, (_, i) => ids.slice(i * ITEMS_BATCH, (i + 1) * ITEMS_BATCH));

/** A reader that asks once per distinct id set: `fetchBatch` gets one batch's query string (`ids=a,b`). */
export function itemsReader<T extends { id: string }>(fetchBatch: (query: string) => Promise<{ items: T[] }>) {
  const seen = new Map<string, Promise<Record<string, T>>>();
  return (ids: string[]): Promise<Record<string, T>> => {
    const key = ids.join('\u0000');
    let hit = seen.get(key);
    if (!hit) {
      hit = Promise.all(idBatches(ids).map((batch) => fetchBatch(`ids=${batch.map(encodeURIComponent).join(',')}`))).then((all) => Object.fromEntries(all.flatMap((r) => r.items).map((i) => [i.id, i])));
      hit.catch(() => seen.delete(key));
      seen.set(key, hit);
    }
    return hit;
  };
}
