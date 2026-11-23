/**
 * C29 T-2: the calls between the host and a runner. A call's request is sealed in the row (no header value in the
 * text); each queued call goes to exactly one claimer; only the claiming runner may answer, once; with no runner seen
 * in 30 s the wait ends at once (AS-4), a call nobody claims in 30 s expires, a claimed call whose runner goes quiet
 * fails as lost and is never retried (FR-7); ended rows are purged; the queue is capped. Times are shortened through
 * `limits`, and "seen" is written with explicit clocks.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-networks-calls-'));
const ENV: Record<string, string> = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const auth = await import('@/lib/server/auth');
const { database } = await import('@/lib/server/db');
const store = await import('@/lib/server/networks/store');
const calls = await import('@/lib/server/networks/calls');
const { credentials } = await import('@/lib/server/credentials/vault');

afterAll(() => {
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const defaults = { ...calls.limits };
afterEach(() => Object.assign(calls.limits, defaults));

let admin: Awaited<ReturnType<typeof auth.createUser>>;
let networkId: string;
let r1: store.RunnerRecord;
let r2: store.RunnerRecord;
beforeAll(async () => {
  admin = await auth.createUser({ email: 'calls@example.test', name: 'Calls', role: 'owner', password: 'a-long-password-1' });
  const net = store.createNetwork({ name: 'Calls net' }, admin);
  networkId = net.id;
  for (const name of ['one', 'two']) {
    const { runner } = store.registerRunner(net.id, { name }, admin);
    store.markSeen(runner.id, { version: '0.1.0' });
    const record = { id: runner.id, networkId: net.id, name, allowedIps: [] };
    if (name === 'one') r1 = record;
    else r2 = record;
  }
});

const request = (extra: Partial<import('@/lib/server/networks/calls').CallRequest> = {}) => ({ method: 'GET', url: 'http://10.20.0.10/status.json', headers: [['authorization', 'Bearer dummy-secret-value-1']] as Array<[string, string]>, timeoutMs: 5_000, ...extra });
const setSeen = (runnerId: string, ms: number) => database().upsert('network_runner_seen', { runner_id: runnerId, last_seen_at: new Date(ms).toISOString(), connected_since: new Date(ms).toISOString(), version: '0.1.0', address: null });
const meta = { executionId: 'ex_1', workflowId: 'wf_1', node: 'HTTP' };
const rowOf = (id: string) => database().get<{ request: string; response: string | null; state: string }>('SELECT * FROM network_calls WHERE id = ?', id);

describe('calls', () => {
  it('stores the request sealed: the row holds no header value', async () => {
    const id = await calls.enqueueCall(networkId, request(), meta);
    expect(rowOf(id)?.request).not.toContain('dummy-secret-value-1');
    expect(rowOf(id)?.request).not.toContain('10.20.0.10');
    const claimed = await calls.claimCall(r1, { waitMs: 50 });
    expect(claimed?.id).toBe(id);
    expect(claimed?.request.headers).toEqual([['authorization', 'Bearer dummy-secret-value-1']]);
    await calls.completeCall(r1, id, { status: 200, headers: [] });
    await calls.awaitAnswer(id, { timeoutMs: 1_000 });
  });

  it('gives each call to exactly one of two concurrent claimers', async () => {
    const id = await calls.enqueueCall(networkId, request(), meta);
    const got = await Promise.all([calls.claimCall(r1, { waitMs: 150 }), calls.claimCall(r2, { waitMs: 150 })]);
    expect(got.filter(Boolean)).toHaveLength(1);
    expect(got.find(Boolean)?.id).toBe(id);
    const winner = got[0] ? r1 : r2;
    await calls.completeCall(winner, id, { status: 204, headers: [] });
    await calls.awaitAnswer(id, { timeoutMs: 1_000 });
  });

  it('refuses an answer from a runner that did not claim the call, and a second answer', async () => {
    const id = await calls.enqueueCall(networkId, request(), meta);
    await calls.claimCall(r1, { waitMs: 50 });
    await expect(calls.completeCall(r2, id, { status: 200, headers: [] })).rejects.toMatchObject({ status: 404 });
    await calls.completeCall(r1, id, { status: 200, headers: [['x', 'y']], body: Buffer.from('ok').toString('base64') });
    await expect(calls.completeCall(r1, id, { status: 200, headers: [] })).rejects.toMatchObject({ status: 404 });
    const answer = await calls.awaitAnswer(id, { timeoutMs: 1_000 });
    expect(answer).toMatchObject({ status: 200, headers: [['x', 'y']] });
    expect(rowOf(id)).toBeUndefined();
  });

  it('wakes a waiting claimer at once when a call is queued in this process', async () => {
    const waiting = calls.claimCall(r1, { waitMs: 5_000 });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const started = Date.now();
    const id = await calls.enqueueCall(networkId, request(), meta);
    const claimed = await waiting;
    expect(claimed?.id).toBe(id);
    expect(Date.now() - started).toBeLessThan(500);
    await calls.completeCall(r1, id, { status: 200, headers: [] });
    await calls.awaitAnswer(id, { timeoutMs: 1_000 });
  });

  it('answers a poll with nothing after the wait', async () => {
    const started = Date.now();
    expect(await calls.claimCall(r1, { waitMs: 120 })).toBeUndefined();
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
  });

  it('AS-4: with no runner seen in 30 s the wait ends at once with the message', async () => {
    const net = store.createNetwork({ name: 'Quiet net' }, admin);
    store.registerRunner(net.id, { name: 'never seen' }, admin);
    const id = await calls.enqueueCall(net.id, request(), meta);
    const started = Date.now();
    await expect(calls.awaitAnswer(id, { timeoutMs: 5_000 })).rejects.toThrow('No runner online for network Quiet net');
    expect(Date.now() - started).toBeLessThan(500);
    expect(rowOf(id)).toBeUndefined();
  });

  it('a call nobody claims within the window expires with the same message', async () => {
    calls.limits.claimWithinMs = 150;
    const id = await calls.enqueueCall(networkId, request(), meta);
    await expect(calls.awaitAnswer(id, { timeoutMs: 5_000 })).rejects.toThrow('No runner online for network Calls net');
    // Too late to claim: it was removed.
    expect(await calls.claimCall(r1, { waitMs: 30 })).toBeUndefined();
  });

  it('FR-7: a claimed call whose runner goes quiet fails as lost and is not handed out again', async () => {
    calls.limits.lostAfterMs = 150;
    const id = await calls.enqueueCall(networkId, request(), meta);
    await calls.claimCall(r1, { waitMs: 50 });
    // The runner stops polling: its last sighting ages past the limit.
    setSeen(r1.id, Date.now() - 1_000);
    await expect(calls.awaitAnswer(id, { timeoutMs: 5_000 })).rejects.toThrow('The runner was lost during the call');
    expect(await calls.claimCall(r2, { waitMs: 30 })).toBeUndefined();
    setSeen(r1.id, Date.now());
  });

  it('turns a runner’s error answer into an error with its code', async () => {
    const id = await calls.enqueueCall(networkId, request(), meta);
    await calls.claimCall(r1, { waitMs: 50 });
    await calls.completeCall(r1, id, { error: { code: 'refused', message: 'refused: 10.30.0.1 is not in this runner’s allow-list' } });
    await expect(calls.awaitAnswer(id, { timeoutMs: 1_000 })).rejects.toMatchObject({ code: 'refused', message: expect.stringContaining('allow-list') });
  });

  it('stops waiting when the caller aborts, and removes the call', async () => {
    const id = await calls.enqueueCall(networkId, request(), meta);
    const controller = new AbortController();
    const waiting = calls.awaitAnswer(id, { timeoutMs: 5_000, signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    await expect(waiting).rejects.toThrow(/abort/i);
    expect(rowOf(id)).toBeUndefined();
  });

  it('purges ended rows after their keep time, on the next enqueue', async () => {
    const id = await calls.enqueueCall(networkId, request(), meta);
    await calls.claimCall(r1, { waitMs: 50 });
    await calls.completeCall(r1, id, { status: 200, headers: [] });
    expect(rowOf(id)?.state).toBe('done');
    calls.limits.keepEndedMs = 0;
    await new Promise((resolve) => setTimeout(resolve, 5));
    const next = await calls.enqueueCall(networkId, request(), meta);
    expect(rowOf(id)).toBeUndefined();
    await calls.claimCall(r1, { waitMs: 50 });
    await calls.completeCall(r1, next, { status: 200, headers: [] });
    await calls.awaitAnswer(next, { timeoutMs: 1_000 });
  });

  it('purges queued rows nobody can claim any more and claimed rows long abandoned, on the next enqueue', async () => {
    const net = store.createNetwork({ name: 'Stale net' }, admin);
    const record = { id: r1.id, networkId: net.id, name: 'one', allowedIps: [] };
    const tenMinutes = Date.now() - 10 * 60_000;
    const staleQueued = await calls.enqueueCall(net.id, request(), meta, tenMinutes);
    const staleClaimed = await calls.enqueueCall(net.id, request(), meta, Date.now() - 2 * 3_600_000);
    // Claimed two hours ago (the oldest queued row goes first); the ten-minute-old one stays queued.
    expect(await calls.claimOnce(record, Date.now() - 2 * 3_600_000)).toMatchObject({ id: staleClaimed });
    const queuedOld = await calls.enqueueCall(net.id, request(), meta, tenMinutes);
    const fresh = await calls.enqueueCall(net.id, request(), meta);
    expect(rowOf(queuedOld)).toBeUndefined();
    expect(rowOf(staleQueued)).toBeUndefined();
    expect(rowOf(staleClaimed)).toBeUndefined();
    expect(rowOf(fresh)?.state).toBe('queued');
  });

  it('the queue cap counts only calls that can still be claimed', async () => {
    const net = store.createNetwork({ name: 'Cap net' }, admin);
    for (let i = 0; i < 5; i++) await calls.enqueueCall(net.id, request(), meta, Date.now() - 10 * 60_000);
    calls.limits.queueCap = 2;
    // Five ten-minute-old queued rows are dead weight, not a full queue.
    await expect(calls.enqueueCall(net.id, request(), meta)).resolves.toMatch(/^call_/);
  });

  it('holds at most two open polls per runner: a third is refused with 429 until one ends', async () => {
    const first = calls.claimCall(r1, { waitMs: 400 });
    const second = calls.claimCall(r1, { waitMs: 400 });
    await new Promise((resolve) => setTimeout(resolve, 30));
    await expect(calls.claimCall(r1, { waitMs: 400 })).rejects.toMatchObject({ status: 429 });
    // Another runner is not affected.
    await expect(calls.claimCall(r2, { waitMs: 20 })).resolves.toBeUndefined();
    await Promise.all([first, second]);
    await expect(calls.claimCall(r1, { waitMs: 20 })).resolves.toBeUndefined();
  });

  it('finds a call queued by another process (no in-process wake-up) within a second', async () => {
    const net = store.createNetwork({ name: 'Other process net' }, admin);
    const { runner } = store.registerRunner(net.id, { name: 'op' }, admin);
    const record = { id: runner.id, networkId: net.id, name: 'op', allowedIps: [] };
    const waiting = calls.claimCall(record, { waitMs: 3_000 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const started = Date.now();
    const now = new Date().toISOString();
    database().sqlite.prepare(`INSERT INTO network_calls (id, network_id, state, request, queued_at) VALUES (?, ?, 'queued', ?, ?)`).run('call_other_proc', net.id, credentials.sealSecret(JSON.stringify({ method: 'GET', url: 'http://10.0.0.1/', headers: [], timeoutMs: 1_000 }), 'network.call'), now);
    expect((await waiting)?.id).toBe('call_other_proc');
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('caps the queue: the call past the limit fails as busy', async () => {
    const net = store.createNetwork({ name: 'Busy net' }, admin);
    calls.limits.queueCap = 2;
    await calls.enqueueCall(net.id, request(), meta);
    await calls.enqueueCall(net.id, request(), meta);
    await expect(calls.enqueueCall(net.id, request(), meta)).rejects.toThrow(/busy/i);
  });

  it('a revoked runner’s poll throws, so the route answers 401', async () => {
    const net = store.createNetwork({ name: 'Revoke net' }, admin);
    const { runner } = store.registerRunner(net.id, { name: 'x' }, admin);
    const record = { id: runner.id, networkId: net.id, name: 'x', allowedIps: [] };
    const waiting = calls.claimCall(record, { waitMs: 5_000 });
    store.revokeRunner(net.id, runner.id, admin);
    const started = Date.now();
    await expect(waiting).rejects.toMatchObject({ status: 401 });
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
