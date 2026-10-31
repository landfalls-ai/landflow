/**
 * A run started from the editor outlives the request that started it (app/api/workflows/[id]/run/route.ts): closing or
 * reloading the editor leaves it running and Stop asks the server (POST /api/executions/:id/stop). A debug run stops
 * with the request, since nobody would be left to step it.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { Workflow, WorkflowNode } from '@landflow/engine';

vi.setConfig({ testTimeout: 20_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-outlives-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_PUBLIC_URL: 'http://outlives.test' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { store } = await import('@/lib/server/store');
const runRoute = await import('@/app/api/workflows/[id]/run/route');
const stopRoute = await import('@/app/api/executions/[id]/stop/route');

registry.registerBuiltin(corePlugin);

afterAll(() => {
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const params = <T>(value: T) => ({ params: Promise.resolve(value) });
const node = (id: string, type: string, parameters: Record<string, unknown> = {}): WorkflowNode => ({ id, name: id, type, typeVersion: 1, position: [0, 0], parameters });

/** A manual trigger and a one-second wait: long enough to leave mid-run. */
function slowWorkflow(id: string): Workflow {
  return { id, name: id, nodes: [node('Start', 'core.manualTrigger'), node('Wait', 'core.wait', { seconds: 1 })], connections: [{ id: 'e', type: 'main', source: 'Start', target: 'Wait', sourceIndex: 0, targetIndex: 0 }] };
}

/** Start a run, read until the server names its execution, then leave as a closed tab would. */
async function startAndLeave(id: string, body: Record<string, unknown> = {}): Promise<string> {
  const leave = new AbortController();
  const response = await runRoute.POST(
    new Request(`http://outlives.test/api/workflows/${id}/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: leave.signal }),
    params({ id }),
  );
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  while (!/event: started\ndata: (.*)\n/.test(text)) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`stream ended before started: ${text}`);
    text += decoder.decode(value);
  }
  const { executionId } = JSON.parse(/event: started\ndata: (.*)\n/.exec(text)![1]) as { executionId: string };
  leave.abort();
  void reader.cancel().catch(() => {});
  return executionId;
}

const ended = (executionId: string) => vi.waitFor(() => {
  const status = store.getExecution(executionId)?.status;
  if (!status || status === 'running') throw new Error(`still ${status ?? 'unknown'}`);
  return status;
}, { timeout: 10_000, interval: 50 });

describe('a run outlives its request', () => {
  it('finishes when the editor that started it goes away', async () => {
    store.saveWorkflow(slowWorkflow('wf_outlives'));
    const executionId = await startAndLeave('wf_outlives');
    expect(await ended(executionId)).toBe('success');
    expect(store.getExecution(executionId)?.runData.Wait?.[0]?.status).toBe('success');
  });

  it('stops when asked, as the editor’s Stop does', async () => {
    store.saveWorkflow(slowWorkflow('wf_outlives_stop'));
    const executionId = await startAndLeave('wf_outlives_stop');
    const stopped = await stopRoute.POST(new Request(`http://outlives.test/api/executions/${executionId}/stop`, { method: 'POST' }), params({ id: executionId }));
    expect(await stopped.json()).toMatchObject({ executionId, stopped: true, status: 'running' });
    expect(await ended(executionId)).toBe('canceled');
  });

  it('stops a debug run with its request', async () => {
    store.saveWorkflow(slowWorkflow('wf_outlives_debug'));
    // Paused before the first node: with the editor gone, nobody would step it.
    const executionId = await startAndLeave('wf_outlives_debug', { debug: { breakpoints: [], step: true } });
    expect(await ended(executionId)).toBe('canceled');
  });
});
