/**
 * Run priorities and rate limits per credential: the workflow setting `priority` (schema, order of waiting runs when the
 * instance caps its runs with LANDFLOW_MAX_RUNS, without starving low ones) and the limit set on a credential, shared by
 * every node and run that uses it (vault, API, persistence in both backends, and runs that wait for it). The job queue's
 * priority streams are tested in cluster-coordinator.test.ts.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineNode, definePlugin } from '@landflow/sdk';
import type { Workflow } from '@landflow/engine';

vi.setConfig({ testTimeout: 30_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-priorities-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_PUBLIC_URL: 'http://prio.test', LANDFLOW_ENCRYPTION_KEY: 'a'.repeat(64) };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { store } = await import('@/lib/server/store');
const { database } = await import('@/lib/server/db');
const { credentials, CredentialVault, CredentialFile, CredentialTable, cleanRateLimit } = await import('@/lib/server/credentials/vault');
const { workflowSchema } = await import('@/lib/server/schemas');
const { priorityOf, queueOrder, maxRuns, PRIORITY_DELAY_MS } = await import('@/lib/server/concurrency');
const { runWorkflow, drainQueue } = await import('@/lib/server/runner');
const credentialRoute = await import('@/app/api/credentials/[id]/route');
const credentialsRoute = await import('@/app/api/credentials/route');

const main = [{ type: 'main' as const }];
const gate = { closed: false, entered: [] as string[], held: [] as Array<{ executionId: string; release: () => void }> };
const release = (count = 1) => {
  for (const held of gate.held.splice(0, count)) held.release();
};
const stamps: number[] = [];

registry.registerBuiltin(corePlugin);
registry.registerBuiltin(
  definePlugin({
    info: { id: 'prio', name: 'Priority test nodes', version: '0.0.1', description: 'Test nodes' },
    nodes: [
      defineNode({
        description: { name: 'gate', displayName: 'Gate', description: 'Holds while closed', version: 1, kind: 'action', inputs: main, outputs: main, properties: [] },
        async execute(ctx) {
          gate.entered.push(ctx.getInputData()[0]?.json.label as string);
          if (gate.closed) await new Promise<void>((resolve) => gate.held.push({ executionId: ctx.getExecutionId(), release: resolve }));
          return [ctx.getInputData()];
        },
      }),
      defineNode({
        description: { name: 'stamp', displayName: 'Stamp', description: 'Records when it ran', version: 1, kind: 'action', inputs: main, outputs: main, properties: [] },
        execute(ctx) {
          stamps.push(Date.now());
          return [ctx.getInputData()];
        },
      }),
    ],
  }),
);

afterAll(() => {
  release(gate.held.length);
  for (const key of [...Object.keys(ENV), 'LANDFLOW_MAX_RUNS']) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

beforeEach(() => {
  release(gate.held.length);
  gate.closed = false;
  gate.entered = [];
  stamps.length = 0;
  delete process.env.LANDFLOW_MAX_RUNS;
});

const until = (check: () => void, timeout = 15_000) => vi.waitFor(check, { timeout, interval: 20 });
const save = (id: string, extra: Partial<Workflow> = {}, nodeExtra: Record<string, unknown> = {}, type = 'gate'): Workflow =>
  store.saveWorkflow({
    id,
    name: id,
    nodes: [
      { id: 'Start', name: 'Start', type: 'core.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
      { id: 'Work', name: 'Work', type: `prio.${type}`, typeVersion: 1, position: [200, 0], parameters: {}, ...nodeExtra },
    ],
    connections: [{ id: 'e0', type: 'main', source: 'Start', sourceIndex: 0, target: 'Work', targetIndex: 0 }],
    ...extra,
  } as Workflow);

/** A production run started now; resolves with its execution id once it exists. */
async function startRun(workflow: Workflow, label: string, mode: 'trigger' | 'manual' = 'trigger') {
  let id = '';
  const done = runWorkflow({ workflow, mode, startNodeId: 'Start', triggerItems: [{ json: { label } }], onStart: (started) => (id = started) });
  if (!id) await done;
  return { id, done };
}

describe('priority setting', () => {
  it('is a workflow setting: high, normal (the default) or low', () => {
    expect(workflowSchema.parse({ name: 'p', settings: { priority: 'high' } }).settings).toEqual({ priority: 'high' });
    expect(workflowSchema.safeParse({ name: 'p', settings: { priority: 'urgent' } }).success).toBe(false);
    expect(priorityOf(undefined)).toBe('normal');
    expect(priorityOf({ priority: 'low' })).toBe('low');
    expect(priorityOf({ priority: 'bogus' as never })).toBe('normal');
  });

  it('orders a queued run by priority and queue time, so a long-waiting low run still gets its turn', () => {
    const now = Date.now();
    // High goes ahead of normal and low runs queued a little earlier…
    expect(queueOrder(now, 'high')).toBeLessThan(queueOrder(now - 5_000, 'normal'));
    expect(queueOrder(now, 'high')).toBeLessThan(queueOrder(now - 30_000, 'low'));
    expect(queueOrder(now, 'normal')).toBeLessThan(queueOrder(now - 30_000, 'low'));
    // …but not ahead of runs that waited longer than the priority's delay.
    expect(queueOrder(now, 'high')).toBeGreaterThan(queueOrder(now - PRIORITY_DELAY_MS.normal - 1_000, 'normal'));
    expect(queueOrder(now, 'high')).toBeGreaterThan(queueOrder(now - PRIORITY_DELAY_MS.low - 1_000, 'low'));
  });

  it('LANDFLOW_MAX_RUNS caps production runs and starts the waiting ones high first, then normal, then low', async () => {
    process.env.LANDFLOW_MAX_RUNS = '1';
    expect(maxRuns()).toBe(1);
    const blocker = save('wf_prio_blocker');
    const low = save('wf_prio_low', { settings: { priority: 'low' } });
    const normal = save('wf_prio_normal');
    const high = save('wf_prio_high', { settings: { priority: 'high' } });
    gate.closed = true;
    const first = await startRun(blocker, 'blocker');
    await until(() => expect(gate.entered).toEqual(['blocker']));
    // Queued in the order low, normal, high; the cap holds them all (each saved as queued).
    const queued = [await startRun(low, 'low'), await startRun(normal, 'normal'), await startRun(high, 'high')];
    expect(queued.map((q) => store.getExecution(q.id)?.status)).toEqual(['queued', 'queued', 'queued']);
    // A manual run from the editor is not capped.
    gate.closed = false;
    const manual = await startRun(normal, 'manual', 'manual');
    expect((await manual.done).status).toBe('success');
    gate.closed = true;
    // One place frees at a time: high, then normal, then low.
    release();
    await first.done;
    await until(() => expect(gate.entered).toEqual(['blocker', 'manual', 'high']));
    expect(store.getExecution(queued[0].id)?.status).toBe('queued');
    release();
    await until(() => expect(gate.entered).toEqual(['blocker', 'manual', 'high', 'normal']));
    release();
    await until(() => expect(gate.entered).toEqual(['blocker', 'manual', 'high', 'normal', 'low']));
    release();
    await Promise.all(queued.map((q) => q.done));
    expect(queued.map((q) => store.getExecution(q.id)?.status)).toEqual(['success', 'success', 'success']);
    expect(drainQueue('wf_prio_low')).toBe(0);
  });

  it('runs everything at once without the cap', async () => {
    const a = save('wf_nocap_a');
    gate.closed = true;
    const runs = [await startRun(a, 'one'), await startRun(a, 'two'), await startRun(a, 'three')];
    await until(() => expect(gate.entered).toHaveLength(3));
    release(3);
    await Promise.all(runs.map((r) => r.done));
  });
});

describe('rate limit per credential', () => {
  const api = credentials.create({ name: 'Limited API', type: 'core.openAiApi', data: { apiKey: 'sk-test' }, rateLimit: { limit: 1, intervalSeconds: 0.4 } });

  it('is kept on the credential, shown in the API and taken off with null', async () => {
    expect(credentials.get(api.id)?.rateLimit).toEqual({ limit: 1, intervalSeconds: 0.4 });
    expect(credentials.list().find((c) => c.id === api.id)?.rateLimit).toEqual({ limit: 1, intervalSeconds: 0.4 });
    const other = credentials.create({ name: 'Plain', type: 'core.openAiApi', data: { apiKey: 'sk-test' } });
    expect(other.rateLimit).toBeUndefined();

    const patch = (id: string, body: unknown) => credentialRoute.PATCH(new Request('http://prio.test/x', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });
    const set = await patch(other.id, { rateLimit: { limit: 5, intervalSeconds: 10 } });
    expect(((await set.json()) as { credential: { rateLimit: unknown } }).credential.rateLimit).toEqual({ limit: 5, intervalSeconds: 10 });
    // Renaming alone keeps it; invalid limits are refused; null takes it off.
    await patch(other.id, { name: 'Renamed' });
    expect(credentials.get(other.id)?.rateLimit).toEqual({ limit: 5, intervalSeconds: 10 });
    expect((await patch(other.id, { rateLimit: { limit: 0, intervalSeconds: 10 } })).status).toBe(400);
    expect((await patch(other.id, { rateLimit: { limit: 1, intervalSeconds: 0 } })).status).toBe(400);
    await patch(other.id, { rateLimit: null });
    expect(credentials.get(other.id)?.rateLimit).toBeUndefined();

    const created = await credentialsRoute.POST(new Request('http://prio.test/x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Made', type: 'core.openAiApi', data: { apiKey: 'sk-x' }, rateLimit: { limit: 2, intervalSeconds: 1 } }) }));
    expect(((await created.json()) as { credential: { rateLimit: unknown } }).credential.rateLimit).toEqual({ limit: 2, intervalSeconds: 1 });
    expect(cleanRateLimit({ limit: 0, intervalSeconds: 5 })).toBeUndefined();
    expect(cleanRateLimit({ limit: 3.7, intervalSeconds: 1e9 })).toEqual({ limit: 3, intervalSeconds: 86_400 });
  });

  it('survives a reload from credentials.json and from the credentials table', () => {
    const fileVault = new CredentialVault({ dir: dataDir, backend: new CredentialFile(join(dataDir, 'credentials.json')) });
    expect(fileVault.get(api.id)?.rateLimit).toEqual({ limit: 1, intervalSeconds: 0.4 });
    const tableVault = new CredentialVault({ dir: dataDir, backend: new CredentialTable(join(dataDir, 'none.json'), () => database()) });
    const made = tableVault.create({ name: 'In table', type: 'core.openAiApi', data: { apiKey: 'sk-t' }, rateLimit: { limit: 4, intervalSeconds: 2 } });
    const reread = new CredentialVault({ dir: dataDir, backend: new CredentialTable(join(dataDir, 'none.json'), () => database()) });
    expect(reread.get(made.id)?.rateLimit).toEqual({ limit: 4, intervalSeconds: 2 });
    reread.update(made.id, { rateLimit: null });
    expect(new CredentialVault({ dir: dataDir, backend: new CredentialTable(join(dataDir, 'none.json'), () => database()) }).get(made.id)?.rateLimit).toBeUndefined();
  });

  it('lists the limits of the credentials a node uses, once each', () => {
    const ref = { id: api.id, name: api.name };
    expect(credentials.rateLimitsFor({ credentials: { a: ref, b: ref } })).toEqual([{ key: `credential:${api.id}`, name: 'Limited API', limit: { limit: 1, intervalSeconds: 0.4 } }]);
    expect(credentials.rateLimitsFor({ credentials: { a: { id: 'cred_missing', name: 'x' } } })).toEqual([]);
    expect(credentials.rateLimitsFor({})).toEqual([]);
  });

  it('holds back nodes of different workflows that share the credential, and logs the wait', async () => {
    const ref = { openAiApi: { id: api.id, name: api.name } };
    const one = save('wf_cred_one', {}, { credentials: ref }, 'stamp');
    const two = save('wf_cred_two', {}, { credentials: ref }, 'stamp');
    const free = save('wf_cred_free', {}, {}, 'stamp');
    const [a, b, c] = await Promise.all([
      runWorkflow({ workflow: one, mode: 'trigger', startNodeId: 'Start', triggerItems: [{ json: {} }] }),
      runWorkflow({ workflow: two, mode: 'trigger', startNodeId: 'Start', triggerItems: [{ json: {} }] }),
      runWorkflow({ workflow: free, mode: 'trigger', startNodeId: 'Start', triggerItems: [{ json: {} }] }),
    ]);
    expect([a.status, b.status, c.status]).toEqual(['success', 'success', 'success']);
    const waits = [a, b].flatMap((r) => r.runData.Work[0].logs ?? []).filter((line) => line.message.includes('Rate limit of credential "Limited API"'));
    expect(waits).toHaveLength(1);
    // Three stamps; the two sharing the credential ran at least ~0.4 s apart, the free one was not held.
    expect(stamps).toHaveLength(3);
    const sorted = [...stamps].sort((x, y) => x - y);
    expect(sorted[2] - sorted[0]).toBeGreaterThanOrEqual(330);
  });
});
