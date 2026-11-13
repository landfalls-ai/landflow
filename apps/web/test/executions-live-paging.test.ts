/**
 * GET /api/executions with a live run whose saved row says `waiting` (a resumed execution): it is listed once, at the
 * top of the first page, and left out of the later page where its saved row falls.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { ExecutionSummary } from '@/lib/shared/types';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-live-paging-'));
const previousEnv = { ...process.env };
Object.assign(process.env, { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_AUDIT_OUTBOX: 'off' });

const live: ExecutionSummary[] = [];
vi.mock('@/lib/server/runner', async (original) => ({ ...(await original<object>()), liveExecutions: () => live }));

const { store } = await import('@/lib/server/store');
const route = await import('@/app/api/executions/route');

afterAll(() => {
  process.env = previousEnv;
});

describe('GET /api/executions and a resumed run', () => {
  it('lists the live run once, on the first page only', async () => {
    for (let i = 0; i < 6; i += 1) {
      const at = `2026-03-01T10:00:0${i}.000Z`;
      const status = i === 1 ? 'waiting' : 'success';
      store.saveExecution({ executionId: `run-${i}`, workflowId: 'wf-live', workflowName: 'Live', mode: 'manual', status, startedAt: at, ...(status === 'success' && { finishedAt: at }), durationMs: 1, runData: {}, executionOrder: [] });
    }
    // run-1 was saved waiting long ago and is running again now.
    live.push({ ...store.listExecutions({ workflowId: 'wf-live' }).find((e) => e.id === 'run-1')!, status: 'running' });
    const ids: string[][] = [];
    let cursor: string | undefined;
    do {
      const response = await route.GET(new Request(`http://localhost/api/executions?workflowId=wf-live&limit=3${cursor ? `&cursor=${cursor}` : ''}`));
      const body = (await response.json()) as { executions: ExecutionSummary[]; nextCursor?: string };
      ids.push(body.executions.map((e) => e.id));
      cursor = body.nextCursor;
    } while (cursor && ids.length < 5);
    expect(ids[0]).toEqual(['run-1', 'run-5', 'run-4', 'run-3']);
    expect(ids.slice(1).flat()).toEqual(['run-2', 'run-0']);
  });
});
