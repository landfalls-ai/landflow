/**
 * Run events across two processes on a real Postgres (opt-in: LANDFLOW_INTEGRATION=queue). A worker saves a failing run:
 * its outbox rows are written in the save's transaction and replicate to the leader, which delivers them once to a local
 * receiver; a lease taken by one process is seen by the other (it claims nothing while the lease holds), and a leader that
 * died mid-lease is succeeded by one that delivers after the lease ends (AS-4). Each "process" is a Database of its own
 * with an in-memory copy; the one the code under test runs on is made the host's database for the moment it acts. Uses
 * LANDFLOW_TEST_DATABASE_URL, default the infra stack's `landflow_test` database, in a schema of its own
 * (`landflow_event_outbox_test`, dropped after).
 */
import { createServer, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Workflow } from '@landflow/engine';
import type { Database } from '@/lib/server/db/database';

const BASE_URL = process.env.LANDFLOW_TEST_DATABASE_URL ?? 'postgres://landflow:landflow-dev-only@127.0.0.1:55432/landflow_test';
const SCHEMA = 'landflow_event_outbox_test';
const URL = `${BASE_URL}${BASE_URL.includes('?') ? '&' : '?'}options=${encodeURIComponent(`-c search_path=${SCHEMA}`)}`;
const enabled = Boolean(process.env.LANDFLOW_INTEGRATION?.split(',').includes('queue'));

vi.setConfig({ testTimeout: 60_000 });

describe.skipIf(!enabled)('the event outbox across a worker and the leader on Postgres', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'landflow-pgevents-'));
  const previous = { mode: process.env.LANDFLOW_EXECUTIONS_MODE, dataDir: process.env.LANDFLOW_DATA_DIR, audit: process.env.LANDFLOW_AUDIT_OUTBOX, keys: process.env.LANDFLOW_REGISTRY_GRPC_PORT };
  process.env.LANDFLOW_EXECUTIONS_MODE = 'queue';
  process.env.LANDFLOW_DATA_DIR = dir;
  process.env.LANDFLOW_AUDIT_OUTBOX = 'off';
  process.env.LANDFLOW_REGISTRY_GRPC_PORT = 'off';

  const pg = (await import('pg')).default;
  const { openPostgres } = await import('@/lib/server/db/postgres');
  const { singleton } = await import('@/lib/server/singleton');
  const { store } = await import('@/lib/server/store');
  const projects = await import('@/lib/server/projects');
  const { ensureExecutionReactions } = await import('@/lib/server/execution-reactions');
  const subs = await import('@/lib/server/outbox/subscriptions');
  const { drainSubscriptions } = await import('@/lib/server/outbox/dispatcher');
  const { claimDue, SUBSCRIPTION_OUTBOX } = await import('@/lib/server/outbox/core');

  const admin = new pg.Pool({ connectionString: URL, max: 2 });
  const tmp = () => mkdtempSync(join(tmpdir(), 'landflow-pgevents-db-'));
  const opened: Database[] = [];
  let main: Database;
  let worker: Database;
  let receiver: Server;
  let receiverUrl = '';
  const hits: string[] = [];
  const until = (check: () => void) => vi.waitFor(check, { timeout: 15_000, interval: 50 });

  /** Make `db` the host's database while `fn` runs (the stores read `database()` on every call). */
  const slot = () => singleton<{ db?: Database }>('database', () => ({}));
  async function as<T>(db: Database, fn: () => T | Promise<T>): Promise<T> {
    const held = slot();
    const before = held.db;
    held.db = db;
    try {
      return await fn();
    } finally {
      held.db = before;
    }
  }
  const outboxRows = (db: Database) => db.all<{ event_id: string; lease_until: string | null }>("SELECT event_id, lease_until FROM event_outbox WHERE topic = 'subscription' ORDER BY created_at");

  let subscriptionId = '';
  const WF = 'wf_pg_events';
  let n = 0;
  const failingRun = () => {
    n += 1;
    const at = new Date().toISOString();
    return { executionId: `ex_pg_evt_${n}`, workflowId: WF, workflowName: 'Events', mode: 'trigger', status: 'error', startedAt: at, finishedAt: at, durationMs: 3, runData: {}, executionOrder: [], error: { message: 'boom' } } as never;
  };

  beforeAll(async () => {
    if (!/_test$/.test(new globalThis.URL(BASE_URL).pathname)) throw new Error(`Refusing to use ${BASE_URL}: its database name must end in _test`);
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    main = await openPostgres(URL, tmp(), { instanceId: 'events-main' });
    worker = await openPostgres(URL, tmp(), { instanceId: 'events-worker' });
    opened.push(main, worker);
    receiver = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (c: Buffer) => chunks.push(c));
      request.on('end', () => {
        hits.push(String(request.headers['x-landflow-event-id']));
        response.writeHead(200).end('ok');
      });
    });
    await new Promise<void>((done) => receiver.listen(0, '127.0.0.1', done));
    const address = receiver.address();
    receiverUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/hook`;
    ensureExecutionReactions();
    // The main creates the project, the workflow and the subscription; the worker hears of them.
    const projectId = await as(main, () => {
      const id = projects.createTeamProject({ name: 'Events PG' }).id;
      store.saveWorkflow({ id: WF, name: 'Events', nodes: [], connections: [] } as unknown as Workflow);
      projects.setHomeProject('workflow', WF, id);
      subscriptionId = subs.createSubscription({ id: 'usr_test' }, id, { name: 'Receiver', url: receiverUrl, events: ['run.failed'] }).subscription.id;
      return id;
    });
    await main.flush();
    await until(() => {
      expect(worker.get('SELECT id FROM event_subscriptions WHERE id = ?', subscriptionId)).toBeDefined();
      expect(worker.get('SELECT project_id FROM project_resources WHERE resource_id = ?', WF)).toBeDefined();
    });
    expect(projectId).toBeTruthy();
  });

  afterAll(async () => {
    await new Promise<void>((done) => receiver?.close(() => done()));
    for (const db of opened) await db.close().catch(() => {});
    for (const [key, value] of [['LANDFLOW_EXECUTIONS_MODE', previous.mode], ['LANDFLOW_DATA_DIR', previous.dataDir], ['LANDFLOW_AUDIT_OUTBOX', previous.audit], ['LANDFLOW_REGISTRY_GRPC_PORT', previous.keys]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.end();
  });

  it('a worker saves a failing run: the rows are in Postgres with it, and the leader delivers them once', async () => {
    const run = failingRun();
    await as(worker, () => store.saveExecution(run));
    await worker.flush();
    // The row went to Postgres in the save's batch, the execution with it.
    const executionId = (run as { executionId: string }).executionId;
    expect((await admin.query('SELECT event_id FROM event_outbox WHERE target_id = $1', [subscriptionId])).rows.map((r) => r.event_id)).toEqual([`${executionId}:run.failed`]);
    expect((await admin.query('SELECT id FROM executions WHERE id = $1', [executionId])).rowCount).toBe(1);
    await until(() => expect(outboxRows(main)).toHaveLength(1));
    expect(await as(main, () => drainSubscriptions())).toBe(1);
    expect(hits).toEqual([`${executionId}:run.failed`]);
    await main.flush();
    await until(() => expect(outboxRows(worker)).toEqual([]));
    expect((await admin.query('SELECT 1 FROM event_outbox')).rowCount).toBe(0);
  });

  it('a lease taken in one process holds in the other; after it ends the next leader delivers (AS-4)', async () => {
    hits.length = 0;
    const run = failingRun();
    await as(worker, () => store.saveExecution(run));
    await worker.flush();
    await until(() => expect(outboxRows(main)).toHaveLength(1));
    const t0 = Date.now() + 200;
    // The first leader claims the row and dies before settling it.
    expect(await as(main, () => claimDue(SUBSCRIPTION_OUTBOX, subscriptionId, 1, t0, true))).toHaveLength(1);
    await main.flush();
    await until(() => expect(outboxRows(worker)[0]?.lease_until).toBeTruthy());
    // The other process, now the leader, finds the lease held: nothing is sent twice at once.
    expect(await as(worker, () => drainSubscriptions(t0 + 1_000))).toBe(0);
    expect(hits).toEqual([]);
    // Once the lease has run out it delivers, once.
    expect(await as(worker, () => drainSubscriptions(t0 + 61_000))).toBe(1);
    expect(hits).toEqual([`${(run as { executionId: string }).executionId}:run.failed`]);
    await worker.flush();
    await until(() => expect(outboxRows(main)).toEqual([]));
  });
});
