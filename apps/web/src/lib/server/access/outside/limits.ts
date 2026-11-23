// placeholder until C36-A merges: C36-A owns the limiters (shared through Valkey in queue mode).
const buckets = new Map<string, number[]>();

/** Take one from `bucket`/`key`: false when `limit` were already taken in the last `windowMs`. */
export function takeOutside(bucket: string, key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const id = `${bucket}:${key}`;
  const hits = (buckets.get(id) ?? []).filter((at) => at > now - windowMs);
  if (hits.length >= limit) return false;
  hits.push(now);
  buckets.set(id, hits);
  return true;
}
