/**
 * Bounded list requests: `limit` and `cursor` are validated (Infinity, text and out-of-range values are 400), the cursor
 * round-trips, and GET /api/executions pages by keyset without gaps or duplicates (even across equal start times) and
 * returns full pages of the executions a member may see.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-pagination-'));
const previousEnv = { ...process.env };
Object.assign(process.env, { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_AUDIT_OUTBOX: 'off' });

const { store } = await import('@/lib/server/store');
const { decodeCursor, encodeCursor, pageSchema } = await import('@/lib/server/pagination');
const { listExecutionsPage } = await import('@/lib/server/executions-query');
const route = await import('@/app/api/executions/route');
const eventsRoute = await import('@/app/api/usage/events/route');

afterAll(() => {
  process.env = previousEnv;
});

function save(id: string, workflowId: string, startedAt: string, status: 'success' | 'running' = 'success') {
  store.saveExecution({ executionId: id, workflowId, workflowName: workflowId, mode: 'manual', status, startedAt, finishedAt: startedAt, durationMs: 1, runData: {}, executionOrder: [] });
}

const get = (query: string) => route.GET(new Request(`http://localhost/api/executions${query}`));

describe('pageSchema', () => {
  it('coerces and bounds limit', () => {
    expect(pageSchema.parse({})).toEqual({ limit: 100 });
    expect(pageSchema.parse({ limit: '25' }).limit).toBe(25);
    for (const bad of ['0', '501', '-1', 'Infinity', 'abc', '1.5', '']) expect(pageSchema.safeParse({ limit: bad }).success, bad).toBe(false);
    expect(pageSchema.safeParse({ limit: '500' }).success).toBe(true);
  });

  it('round-trips a cursor and refuses others', () => {
    const cursor = { s: '2026-01-01T00:00:00.000Z', i: 'abc' };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
    expect(decodeCursor('nonsense')).toBeUndefined();
    expect(pageSchema.safeParse({ cursor: 'nonsense' }).success).toBe(false);
  });
});

describe('GET /api/executions', () => {
  it('answers 400 for a limit that is not a bounded integer', async () => {
    for (const limit of ['Infinity', 'abc', '0', '501']) {
      const response = await get(`?limit=${limit}`);
      expect(response.status, limit).toBe(400);
    }
    expect((await get('?cursor=bad')).status).toBe(400);
  });

  it('pages without gaps or duplicates, across equal started_at', async () => {
    const same = '2026-02-01T10:00:00.000Z';
    for (let i = 0; i < 7; i += 1) save(`same-${i}`, 'wf-a', same);
    for (let i = 0; i < 6; i += 1) save(`later-${i}`, 'wf-a', `2026-02-01T11:00:0${i}.000Z`);
    save('live-row', 'wf-a', '2026-02-01T12:00:00.000Z', 'running');
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const body = (await (await get(`?workflowId=wf-a&limit=4${cursor ? `&cursor=${cursor}` : ''}`)).json()) as { executions: Array<{ id: string }>; nextCursor?: string };
      expect(body.executions.length).toBeLessThanOrEqual(4);
      seen.push(...body.executions.map((e) => e.id));
      cursor = body.nextCursor;
      pages += 1;
    } while (cursor && pages < 10);
    expect(pages).toBe(4);
    expect(seen).toHaveLength(13);
    expect(new Set(seen).size).toBe(13);
    expect(seen).not.toContain('live-row');
    expect(seen.slice(0, 6)).toEqual(['later-5', 'later-4', 'later-3', 'later-2', 'later-1', 'later-0']);
  });
});

describe('listExecutionsPage visibility', () => {
  it('gives members full pages of the visible executions, chunked or not', () => {
    for (let i = 0; i < 30; i += 1) save(`vis-${i}`, i % 10 === 0 ? 'wf-mine' : 'wf-other', `2026-03-01T00:00:${String(i).padStart(2, '0')}.000Z`);
    const mine = ['wf-mine'];
    const first = listExecutionsPage({ limit: 2, visibleWorkflowIds: mine });
    expect(first.executions.map((e) => e.id)).toEqual(['vis-20', 'vis-10']);
    expect(first.nextCursor).toBeDefined();
    const second = listExecutionsPage({ limit: 2, cursor: first.nextCursor, visibleWorkflowIds: mine });
    expect(second.executions.map((e) => e.id)).toEqual(['vis-0']);
    expect(second.nextCursor).toBeUndefined();
    expect(listExecutionsPage({ limit: 5, visibleWorkflowIds: [] }).executions).toEqual([]);
    // More ids than one query takes: the pages merge to the same newest rows.
    const many = [...Array.from({ length: 1200 }, (_, i) => `none-${i}`), 'wf-mine'];
    expect(listExecutionsPage({ limit: 2, visibleWorkflowIds: many }).executions.map((e) => e.id)).toEqual(['vis-20', 'vis-10']);
  });
});

describe('other limit-taking routes', () => {
  it('refuse a limit that is not a bounded integer', async () => {
    expect((await eventsRoute.GET(new Request('http://localhost/api/usage/events?limit=Infinity'))).status).toBe(400);
    expect((await eventsRoute.GET(new Request('http://localhost/api/usage/events?limit=5001'))).status).toBe(400);
    expect((await eventsRoute.GET(new Request('http://localhost/api/usage/events?limit=10'))).status).toBe(200);
  });
});
