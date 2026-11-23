/**
 * C22 (W4b P21): the stores of knowledge sources: sources and their unique place, the sync history (newest first, paged,
 * the last 100 kept, 50 errors), the item markers, and the claim that lets one process sync a source at a time (the lease lives
 * in its own row, so an admin's edit never frees it). SQLite here; the Postgres claim is knowledge-sources.postgres.test.ts.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { MIGRATIONS } from '@/lib/server/db/schema';
import { EMPTY_COUNTS, SOURCE_LIMITS, syncSummary } from '@/lib/shared/knowledge-sources';

Object.assign(process.env, { LANDFLOW_DATA_DIR: mkdtempSync(join(tmpdir(), 'landflow-ks-store-')), LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' });

const store = await import('@/lib/server/knowledge-sources/store');
const claim = await import('@/lib/server/knowledge-sources/claim');

const source = (over: Partial<Parameters<typeof store.insertSource>[0]> = {}) => ({
  id: `src_${Math.random().toString(36).slice(2, 10)}`,
  agent_id: 'agent1',
  tool_id: 'kb1',
  collection_key: 'sqlite:docs',
  kind: 'folder',
  name: 'Runbooks',
  location: `runbooks-${Math.random().toString(36).slice(2, 6)}`,
  settings: JSON.stringify({ folder: 'runbooks' }),
  credential_id: null,
  schedule: 'manual',
  paused: 0,
  paused_reason: null,
  created_by: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  ...over,
});

describe('migration 2929', () => {
  it('follows 2928 in the order the wave merges', () => {
    const versions = MIGRATIONS.map((m) => m.version);
    expect(versions).toContain(2929);
    expect(MIGRATIONS.find((m) => m.version === 2929)!.name).toBe('knowledge_sources');
  });
});

describe('sources', () => {
  it('stores and reads a source; the same place twice is refused', () => {
    const a = source({ location: 'x' });
    store.insertSource(a);
    expect(store.getSource(a.id)?.name).toBe('Runbooks');
    expect(() => store.insertSource(source({ location: 'x' }))).toThrow(/already/i);
    // another kind or another collection at the same place is a different source
    store.insertSource(source({ location: 'x', kind: 's3' }));
    store.insertSource(source({ location: 'x', collection_key: 'sqlite:other' }));
    expect(store.listSourceRows('agent1', 'kb1').length).toBeGreaterThanOrEqual(3);
  });

  it('removing a source takes its state, items and runs with it', () => {
    const a = source();
    store.insertSource(a);
    store.putItem({ source_id: a.id, item_key: 'a.md', version: '1', name: 'a.md', size: 1, extra: null, synced_at: 'now' });
    const run = store.insertRun(a.id, 'manual', new Date());
    store.deleteSource(a.id);
    expect(store.getSource(a.id)).toBeUndefined();
    expect([...store.itemsOf(a.id)]).toEqual([]);
    expect(store.listRuns(a.id).runs).toEqual([]);
    expect(run.id).toBeTruthy();
  });
});

describe('sync runs', () => {
  it('lists newest first with a cursor, limit at most 50', () => {
    const a = source();
    store.insertSource(a);
    for (let i = 0; i < 7; i++) store.insertRun(a.id, i % 2 ? 'schedule' : 'manual', new Date(Date.UTC(2026, 10, 22, 8, i)));
    const first = store.listRuns(a.id, { limit: 3 });
    expect(first.runs).toHaveLength(3);
    expect(first.runs[0].startedAt > first.runs[1].startedAt).toBe(true);
    expect(first.next).toBeTruthy();
    const second = store.listRuns(a.id, { limit: 3, cursor: first.next });
    expect(second.runs[0].startedAt < first.runs[2].startedAt).toBe(true);
    const rest = store.listRuns(a.id, { limit: 3, cursor: second.next });
    expect(rest.runs).toHaveLength(1);
    expect(rest.next).toBeUndefined();
    expect(store.listRuns(a.id, { limit: 500 }).runs.length).toBe(7);
    expect(store.listRuns(a.id, { limit: 9999 }).runs.length).toBe(7); // capped, not refused
  });

  it('keeps the last 100 runs and 50 errors', () => {
    const a = source();
    store.insertSource(a);
    for (let i = 0; i < 105; i++) store.insertRun(a.id, 'schedule', new Date(Date.UTC(2026, 0, 1, 0, 0, i)));
    store.pruneRuns(a.id);
    const all = [];
    let cursor: string | undefined;
    do {
      const page = store.listRuns(a.id, { limit: 50, cursor });
      all.push(...page.runs);
      cursor = page.next;
    } while (cursor);
    expect(all).toHaveLength(SOURCE_LIMITS.runsKept);
    expect(all[0].startedAt).toBe(new Date(Date.UTC(2026, 0, 1, 0, 0, 104)).toISOString());

    const run = store.insertRun(a.id, 'manual', new Date());
    const errors = Array.from({ length: 80 }, (_, i) => ({ item: `f${i}`, reason: 'bad' }));
    store.finishRun(run.id, { status: 'partial', counts: { ...EMPTY_COUNTS, failed: 80 }, errors });
    const read = store.listRuns(a.id, { limit: 1 }).runs[0];
    expect(read.errors).toHaveLength(SOURCE_LIMITS.errorsKept);
    expect(read.status).toBe('partial');
    expect(read.finishedAt).toBeTruthy();
  });

  it('words the counts of a run', () => {
    expect(syncSummary({ counts: { ...EMPTY_COUNTS, added: 3, changed: 1, embedded: 12, reused: 240 } })).toBe('added 3, changed 1, removed 0 · 12 embedded, 240 reused');
    expect(syncSummary({ counts: { ...EMPTY_COUNTS, failed: 2 } })).toBe('added 0, changed 0, removed 0, failed 2');
  });
});

describe('item markers', () => {
  it('upserts and removes by key', () => {
    const a = source();
    store.insertSource(a);
    store.putItem({ source_id: a.id, item_key: 'a', version: '1', name: 'a', size: 1, extra: null, synced_at: 'n' });
    store.putItem({ source_id: a.id, item_key: 'a', version: '2', name: 'a', size: 1, extra: null, synced_at: 'n' });
    store.putItem({ source_id: a.id, item_key: 'b', version: '1', name: 'b', size: 1, extra: null, synced_at: 'n' });
    expect(store.itemsOf(a.id).get('a')?.version).toBe('2');
    store.deleteItem(a.id, 'a');
    expect([...store.itemsOf(a.id).keys()]).toEqual(['b']);
  });
});

describe('the claim', () => {
  const T0 = Date.UTC(2026, 10, 22, 9, 0, 0);
  it('refuses a second claim while the lease holds, accepts one after it ends', async () => {
    const a = source();
    store.insertSource(a);
    expect(await claim.claimSource(a.id, 'run1', T0)).toBe(true);
    expect(await claim.claimSource(a.id, 'run2', T0 + 1000)).toBe(false);
    expect(await claim.claimSource(a.id, 'run2', T0 + claim.LEASE_MS + 1)).toBe(true);
  });

  it('renewLease extends it, and only for the holder', async () => {
    const a = source();
    store.insertSource(a);
    await claim.claimSource(a.id, 'run1', T0);
    await claim.renewLease(a.id, 'run1', T0 + claim.LEASE_MS - 1000);
    expect(await claim.claimSource(a.id, 'run2', T0 + claim.LEASE_MS + 1)).toBe(false);
    await claim.renewLease(a.id, 'someone-else', T0 + claim.LEASE_MS * 5);
    expect(claim.stateOf(a.id)?.run_id).toBe('run1');
  });

  it('release clears the claim and sets the next time; an admin edit in between does not free it', async () => {
    const a = source();
    store.insertSource(a);
    await claim.claimSource(a.id, 'run1', T0);
    store.updateSourceRow(a.id, { paused: 1, paused_reason: 'Paused' }); // an admin pauses it mid-run
    expect(claim.stateOf(a.id)?.run_id).toBe('run1');
    expect(await claim.claimSource(a.id, 'run2', T0 + 1)).toBe(false);
    await claim.releaseSource(a.id, 'run1', new Date(T0 + 3600_000).toISOString());
    expect(claim.stateOf(a.id)?.run_id).toBeNull();
    expect(claim.stateOf(a.id)?.next_at).toBe(new Date(T0 + 3600_000).toISOString());
    expect(await claim.claimSource(a.id, 'run2', T0 + 2)).toBe(true);
  });

  it('a stale holder cannot release a claim that moved on', async () => {
    const a = source();
    store.insertSource(a);
    await claim.claimSource(a.id, 'run1', T0);
    await claim.claimSource(a.id, 'run2', T0 + claim.LEASE_MS + 1);
    await claim.releaseSource(a.id, 'run1', null);
    expect(claim.stateOf(a.id)?.run_id).toBe('run2');
  });

  it('finds expired leases and frees them once', async () => {
    const a = source();
    store.insertSource(a);
    await claim.claimSource(a.id, 'run1', T0);
    expect(await claim.freeExpired(T0 + 1000)).toEqual([]);
    expect(await claim.freeExpired(T0 + claim.LEASE_MS + 1)).toEqual([{ sourceId: a.id, runId: 'run1' }]);
    expect(await claim.freeExpired(T0 + claim.LEASE_MS + 2)).toEqual([]);
  });
});

beforeAll(() => undefined);
