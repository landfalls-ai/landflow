/**
 * Queue mode on a Valkey Cluster (the infra stack's `valkey-cluster` profile), opt-in: LANDFLOW_INTEGRATION=valkey-cluster.
 *
 *   COMPOSE_BAKE=false docker compose -f deploy/compose.infra.yml --profile valkey-cluster up -d --wait
 *   LANDFLOW_INTEGRATION=valkey-cluster npx vitest run test/valkey-cluster.integration.test.ts
 *
 * A main (startCluster) and a job worker, each with its own connections to the node that owns the queue's hash slot,
 * run production runs through the job queue (Lua scripts, streams, blocking reads, pub/sub). The test then kills the
 * slot owner's container: the cluster promotes its replica, every connection asks again where the slot is (MOVED,
 * CLUSTERDOWN, a dropped socket), a run in flight finishes and new runs go through the new owner. The killed node is
 * started again at the end (it keeps its identity and rejoins as a replica). The nodes announce container host names;
 * the test reaches them through the published 127.0.0.1 ports (LANDFLOW_VALKEY_CLUSTER_NAT).
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { defineNode, definePlugin } from '@landflow/sdk';
import type { Workflow } from '@landflow/engine';

const enabled = process.env.LANDFLOW_INTEGRATION === 'valkey-cluster';
const NODES = [1, 2, 3, 4, 5, 6].map((n) => `127.0.0.1:${56410 + n}`);
const NAT = [1, 2, 3, 4, 5, 6].map((n) => `valkey-cluster-${n}:6379=127.0.0.1:${56410 + n}`).join(',');
const PROJECT = process.env.LANDFLOW_TEST_INFRA_PROJECT ?? 'landflow-infra';
const containerOf = (port: number) => `${PROJECT}-valkey-cluster-${port - 56410}-1`;

vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });

describe.skipIf(!enabled)('queue mode on a Valkey Cluster', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'landflow-cluster-'));
  const ENV: Record<string, string | undefined> = {
    LANDFLOW_DATA_DIR: dataDir,
    LANDFLOW_DB: 'sqlite',
    LANDFLOW_REGISTRY_GRPC_PORT: 'off',
    LANDFLOW_SCAN_ON_START: 'false',
    LANDFLOW_PLUGINS: '',
    LANDFLOW_PUBLIC_URL: 'http://sentinel.test',
    LANDFLOW_EXECUTIONS_MODE: 'queue',
    LANDFLOW_QUEUE_ALLOW_SQLITE: 'true',
    LANDFLOW_INSTANCE_ID: 'main-cluster',
    LANDFLOW_QUEUE_PREFIX: `cluster-test-${Date.now().toString(36)}`,
    LANDFLOW_WORKER_PORT: '0',
    LANDFLOW_VALKEY_URL: 'redis://127.0.0.1:6379',
    LANDFLOW_VALKEY_CLUSTER: NODES.slice(0, 3).join(','),
    LANDFLOW_VALKEY_CLUSTER_NAT: NAT,
    LANDFLOW_ROLE: undefined,
  };
  const previousEnv = { ...process.env };
  let killed: string | undefined;
  let modules: Awaited<ReturnType<typeof load>>;
  let worker: { stop: (ms: number) => Promise<void>; start: () => void } | undefined;
  let workerConnection: { close: () => Promise<void>; primary?: { host: string; port: number } } | undefined;
  const gate = { closed: false, held: [] as Array<() => void>, entered: 0 };

  async function load() {
    const { registry } = await import('@/lib/server/plugins/registry');
    const { ensureBootstrapped } = await import('@/lib/server/bootstrap');
    const { store } = await import('@/lib/server/store');
    const { recordVersion } = await import('@/lib/server/versions');
    const { runWorkflow } = await import('@/lib/server/runner');
    const { startCluster, stopCluster } = await import('@/lib/server/cluster');
    const { clusterState } = await import('@/lib/server/cluster/state');
    const { clusterConfig } = await import('@/lib/server/cluster/config');
    const { ValkeyCoordinator } = await import('@/lib/server/cluster/valkey');
    const { Relay } = await import('@/lib/server/cluster/relay');
    const { JobWorker } = await import('@/lib/server/cluster/worker');
    const { askCluster, hashSlot } = await import('@/lib/server/cluster/resp');
    return { registry, ensureBootstrapped, store, recordVersion, runWorkflow, startCluster, stopCluster, clusterState, clusterConfig, ValkeyCoordinator, Relay, JobWorker, askCluster, hashSlot };
  }

  /** The node that owns the queue's hash slot now. */
  const primaryNow = async () => {
    const { cluster, prefix } = modules.clusterConfig();
    return modules.askCluster({ nodes: [...cluster!.nodes], natMap: cluster!.natMap }, modules.hashSlot(`{${prefix}}`));
  };
  const clusterOptions = () => ({ cluster: modules.clusterConfig().cluster });

  beforeAll(async () => {
    for (const [key, value] of Object.entries(ENV)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    modules = await load();
    const main = [{ type: 'main' as const }];
    modules.registry.registerBuiltin(
      definePlugin({
        info: { id: 'sentinel', name: 'Sentinel test nodes', version: '0.0.1', description: 'Test nodes' },
        nodes: [
          defineNode({
            description: { name: 'gate', displayName: 'Gate', description: 'Holds while closed', version: 1, kind: 'action', inputs: main, outputs: main, properties: [] },
            async execute(ctx) {
              gate.entered++;
              if (gate.closed) await new Promise<void>((resolve) => gate.held.push(resolve));
              return [ctx.getInputData().map((item) => ({ json: { ...item.json, passed: true } }))];
            },
          }),
        ],
      }),
    );
    expect(await modules.startCluster()).toBe(true);
    await modules.ensureBootstrapped();
    const { config } = modules.clusterState();
    const connection = new modules.ValkeyCoordinator(config.valkeyUrl, config.prefix, 'worker-cluster', clusterOptions());
    workerConnection = connection;
    const job = new modules.JobWorker(connection, new modules.Relay(new modules.ValkeyCoordinator(config.valkeyUrl, config.prefix, 'worker-cluster-relay', clusterOptions()), config.instanceId), config, 'worker-cluster');
    worker = job;
    job.start();
  });

  afterAll(async () => {
    for (const release of gate.held.splice(0)) release();
    if (worker) {
      const stopped = worker.stop(0);
      await workerConnection?.close();
      await stopped;
    }
    await modules?.stopCluster();
    // The killed node comes back with its identity and rejoins as a replica of the promoted one.
    if (killed) execFileSync('docker', ['start', killed]);
    for (const key of Object.keys(ENV)) {
      if (previousEnv[key] === undefined) delete process.env[key];
      else process.env[key] = previousEnv[key];
    }
  });

  function save(id: string): Workflow {
    const workflow = modules.store.saveWorkflow({
      id,
      name: id,
      nodes: [
        { id: 'Start', name: 'Start', type: 'core.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
        { id: 'Gate', name: 'Gate', type: 'sentinel.gate', typeVersion: 1, position: [200, 0], parameters: {} },
      ],
      connections: [{ id: 'e0', type: 'main', source: 'Start', target: 'Gate', sourceIndex: 0, targetIndex: 0 }],
    } as Workflow);
    modules.recordVersion(workflow);
    return workflow;
  }
  const run = (workflow: Workflow, n: number) => modules.runWorkflow({ workflow, mode: 'webhook', startNodeId: 'Start', triggerItems: [{ json: { n } }] });
  const gateOutput = (record: { runData: Record<string, Array<{ outputs: Array<Array<{ json: unknown }>> }>> }) => record.runData.Gate?.at(-1)?.outputs[0]?.map((item) => item.json);

  it('runs production runs on a worker through the node that owns the hash slot', async () => {
    const primary = await primaryNow();
    expect(NODES).toContain(`${primary.host}:${primary.port}`);
    const workflow = save('wf_sentinel_before');
    const records = await Promise.all([1, 2, 3].map((n) => run(workflow, n)));
    expect(records.map((record) => record.status)).toEqual(['success', 'success', 'success']);
    expect(records.map(gateOutput)).toEqual([[{ n: 1, passed: true }], [{ n: 2, passed: true }], [{ n: 3, passed: true }]]);
    expect(workerConnection?.primary?.port).toBe(primary.port);
  });

  it('keeps running across a failover: a run in flight finishes and new runs go to the promoted replica', async () => {
    const before = await primaryNow();
    killed = containerOf(before.port);

    // A run that is on the worker when the primary dies.
    const workflow = save('wf_sentinel_failover');
    gate.closed = true;
    const entered = gate.entered;
    const inFlight = run(workflow, 10);
    inFlight.catch(() => {});
    await vi.waitFor(() => expect(gate.entered).toBe(entered + 1), { timeout: 15_000, interval: 50 });

    // stop, not kill: the restart policy would bring a killed node back before the cluster notices
    execFileSync('docker', ['stop', '-t', '0', killed!]);
    const started = Date.now();
    // The cluster marks the primary failed (node timeout 3 s) and promotes its replica.
    await vi.waitFor(async () => expect((await primaryNow()).port).not.toBe(before.port), { timeout: 45_000, interval: 500 });
    const after = await primaryNow();
    const failoverMs = Date.now() - started;

    gate.closed = false;
    for (const release of gate.held.splice(0)) release();
    const finished = await inFlight;
    expect(finished.status).toBe('success');
    expect(gateOutput(finished)).toEqual([{ n: 10, passed: true }]);

    // New runs, through the new primary.
    const records = await Promise.all([11, 12, 13, 14].map((n) => run(workflow, n)));
    expect(records.map((record) => record.status)).toEqual(['success', 'success', 'success', 'success']);
    expect(records.map(gateOutput)).toEqual([[{ n: 11, passed: true }], [{ n: 12, passed: true }], [{ n: 13, passed: true }], [{ n: 14, passed: true }]]);
    await vi.waitFor(() => expect(workerConnection?.primary?.port).toBe(after.port), { timeout: 10_000, interval: 100 });
    const coordinator = modules.clusterState().coordinator as unknown as { primary?: { port: number } };
    expect(coordinator.primary?.port).toBe(after.port);
    // The leader keeps its leadership (or a new term starts) on the new primary.
    await vi.waitFor(() => expect(modules.clusterState().elector?.isLeader()).toBe(true), { timeout: 30_000, interval: 200 });
    console.info(`cluster failover: ${before.port} -> ${after.port} in ${failoverMs} ms`);
  });
});
