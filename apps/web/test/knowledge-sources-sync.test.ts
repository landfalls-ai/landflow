/**
 * C22 (W4b P21): a sync of a source. A folder source against a temp files directory and an agent knowledge base (keyword search:
 * nothing is sent anywhere, `embedded` counts the chunks that needed a vector). Version markers decide what is fetched; each
 * item goes through the knowledge base's own write path; gone items lose their chunks only for a complete listing; the 2,000-item
 * cap, the claim and the deadline; a collection the agent's project can't write fails the run and pauses the source.
 */
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { VectorKnowledgeBaseConfig } from '@/lib/shared/agents';
import { SOURCE_LIMITS } from '@/lib/shared/knowledge-sources';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-ks-sync-'));
const filesDir = join(dataDir, 'files');
mkdirSync(filesDir, { recursive: true });
const previousEnv = { ...process.env };
Object.assign(process.env, { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_FILES_DIR: filesDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_AUDIT_OUTBOX: 'off' });

const projects = await import('@/lib/server/projects');
const { setHomeProject } = await import('@/lib/server/projects/store');
const { agentStore } = await import('@/lib/server/agents/store');
const knowledge = await import('@/lib/server/agents/knowledge');
const access = await import('@/lib/server/rag/collection-access');
const store = await import('@/lib/server/knowledge-sources/store');
const claim = await import('@/lib/server/knowledge-sources/claim');
const { runSync, startSync, sourceKeyOf } = await import('@/lib/server/knowledge-sources/sync');
const { knowledgeSourceScheduler, MAX_CONCURRENT_SYNCS } = await import('@/lib/server/knowledge-sources/scheduler');
const { listSourceRows } = store;

const unique = (name: string) => `${name}-${Math.random().toString(36).slice(2, 7)}`;
const base = (collection: string): VectorKnowledgeBaseConfig => ({ id: 'kb1', type: 'knowledge', source: 'vector', name: 'search_docs', description: 'Search the docs', store: 'memory', collection, embeddings: { provider: 'none', model: 'bm25' }, topK: 4 });

let A = '';
let B = '';
beforeAll(() => {
  A = projects.createTeamProject({ name: 'Alpha' }).id;
  B = projects.createTeamProject({ name: 'Beta' }).id;
  access.collectionAccess('memory:__warm__', A);
});
afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key];
  Object.assign(process.env, previousEnv);
});

function agentIn(project: string, collection: string) {
  const agent = agentStore.create({ name: unique('agent'), tools: [base(collection)] });
  setHomeProject('agent', agent.id, project);
  return agent;
}

/** A knowledge base on `collection` with a folder source on `folder` of the files directory. */
function folderSource(folder: string, collection = unique('docs'), project = A) {
  const agent = agentIn(project, collection);
  const id = `src_${Math.random().toString(36).slice(2, 10)}`;
  store.insertSource({ id, agent_id: agent.id, tool_id: 'kb1', collection_key: `memory:${collection}`, kind: 'folder', name: folder, location: folder, settings: JSON.stringify({ folder }), credential_id: null, schedule: 'manual', paused: 0, paused_reason: null, created_by: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
  return { id, agent, collection, config: () => knowledge.knowledgeConfigOf(agent.id, 'kb1')! };
}
const docs = async (s: ReturnType<typeof folderSource>) => (await knowledge.listKnowledgeDocuments(s.config(), { asProject: A })).documents;
const write = (folder: string, name: string, text: string) => {
  mkdirSync(join(filesDir, folder), { recursive: true });
  writeFileSync(join(filesDir, folder, name), text);
};
const section = (title: string, body: string) => `# ${title}\n\n${body.repeat(30)}\n\n`;

describe('a folder source', () => {
  it('indexes three files, then finds nothing to do, then only what changed (FR-5, FR-6)', async () => {
    const folder = unique('runbooks');
    write(folder, 'a.md', section('Disk', 'Free the disk with the cleanup job. '));
    write(folder, 'b.md', section('Network', 'Restart the router and check the cable. '));
    write(folder, 'c.md', section('Backups', 'Verify the nightly backup finished. '));
    const s = folderSource(folder);

    const first = (await runSync(s.id, 'manual'))!;
    expect(first.status).toBe('ok');
    expect(first.counts).toMatchObject({ seen: 3, added: 3, changed: 0, removed: 0, failed: 0 });
    expect(first.counts.embedded).toBeGreaterThan(0);
    expect(await docs(s)).toHaveLength(3);

    const second = (await runSync(s.id, 'manual'))!;
    expect(second.counts).toMatchObject({ seen: 3, added: 0, changed: 0, removed: 0, embedded: 0 });
    expect(second.status).toBe('ok');

    // one file edited in one section: only its new text is embedded
    const a = section('Disk', 'Free the disk with the cleanup job. ') + section('Extra', 'A new section about the paging service. ');
    write(folder, 'a.md', a);
    utimesSync(join(filesDir, folder, 'a.md'), new Date(), new Date(Date.now() + 5000));
    const third = (await runSync(s.id, 'manual'))!;
    expect(third.counts).toMatchObject({ seen: 3, added: 0, changed: 1 });
    expect(third.counts.embedded).toBeGreaterThan(0);
    expect(third.counts.reused).toBeGreaterThan(0);
    expect(await docs(s)).toHaveLength(3); // the document kept its identity

    expect(store.listRuns(s.id).runs.map((r) => r.status)).toEqual(['ok', 'ok', 'ok']);
  });

  it('a file deleted in the source is removed with its chunks at the next sync (AS-2)', async () => {
    const folder = unique('runbooks');
    write(folder, 'a.md', section('Disk', 'Free the disk. '));
    write(folder, 'b.md', section('Network', 'Restart the router. '));
    const s = folderSource(folder);
    await runSync(s.id, 'manual');
    unlinkSync(join(filesDir, folder, 'b.md'));
    const run = (await runSync(s.id, 'manual'))!;
    expect(run.counts).toMatchObject({ seen: 1, removed: 1 });
    expect((await docs(s)).map((d) => d.fileName)).toEqual(['a.md']);
    expect([...store.itemsOf(s.id).keys()]).toEqual([`${folder}/a.md`]);
  });

  it('an unreadable file among five makes the run partial with its reason; the four others are indexed (AS-6)', async () => {
    const folder = unique('mixed');
    for (const n of ['a', 'b', 'c', 'd']) write(folder, `${n}.md`, section(n.toUpperCase(), `Text of ${n}. `));
    write(folder, 'broken.pdf', 'this is not a pdf at all');
    const s = folderSource(folder);
    const run = (await runSync(s.id, 'manual'))!;
    expect(run.status).toBe('partial');
    expect(run.counts).toMatchObject({ seen: 5, added: 4, failed: 1 });
    expect(run.errors).toHaveLength(1);
    expect(run.errors[0].item).toContain('broken.pdf');
    expect(run.errors[0].reason.length).toBeGreaterThan(5);
    expect(await docs(s)).toHaveLength(4);
    // the failure is retried at the next sync, and the others are not
    const again = (await runSync(s.id, 'manual'))!;
    expect(again.counts).toMatchObject({ added: 0, failed: 1 });
  });

  it('chunks carry the source, its kind and the file name', async () => {
    const folder = unique('meta');
    write(folder, 'a.md', section('Disk', 'Free the disk. '));
    const s = folderSource(folder);
    await runSync(s.id, 'manual');
    const rows = await knowledge.knowledgeSearcher(s.config(), { asProject: A }).store.metadataOf(s.collection);
    expect(rows[0].metadata).toMatchObject({ source: sourceKeyOf(s.id, `${folder}/a.md`), sourceId: s.id, sourceKind: 'folder', fileName: 'a.md' });
  });
});

/** A connector over a fixed list, for the caps and the completeness rule. */
const stub = (items: Array<{ key: string; version?: string }>, complete = true) => ({
  async list() {
    return { items: items.map((i) => ({ key: i.key, name: `${i.key}.md`, version: i.version ?? '1' })), complete, ...(!complete && { note: 'The listing stopped early' }) };
  },
  async fetch(item: { key: string }) {
    return { bytes: new TextEncoder().encode(`# ${item.key}\n\nText of ${item.key}.`), fileName: `${item.key}.md` };
  },
});

describe('caps and completeness', () => {
  it('2,500 items: the first sync takes 2,000 and says partial, the next takes the rest, nothing is removed in between (AS-8, D12)', async () => {
    const s = folderSource('unused');
    const items = Array.from({ length: 2500 }, (_, i) => ({ key: `item-${String(i).padStart(4, '0')}` }));
    const first = (await runSync(s.id, 'manual', { connector: stub(items) }))!;
    expect(first.status).toBe('partial');
    expect(first.counts).toMatchObject({ seen: 2500, added: SOURCE_LIMITS.itemsPerSync, removed: 0 });
    expect(first.note).toMatch(/2000 items/);
    expect(await docs(s)).toHaveLength(2000);
    const next = new Date(claim.stateOf(s.id)!.next_at!).getTime() - Date.now();
    expect(next).toBeGreaterThan(30_000);
    expect(next).toBeLessThanOrEqual(SOURCE_LIMITS.retryAfterCapMs);
    const second = (await runSync(s.id, 'manual', { connector: stub(items) }))!;
    expect(second.status).toBe('ok');
    expect(second.counts).toMatchObject({ added: 500, removed: 0 });
    expect(await docs(s)).toHaveLength(2500);
  }, 120_000);

  it('an incomplete listing removes nothing; a complete one removes what is gone', async () => {
    const s = folderSource('unused');
    await runSync(s.id, 'manual', { connector: stub([{ key: 'a' }, { key: 'b' }]) });
    const partial = (await runSync(s.id, 'manual', { connector: stub([{ key: 'a' }], false) }))!;
    expect(partial.status).toBe('partial');
    expect(partial.counts.removed).toBe(0);
    expect(partial.note).toMatch(/nothing was removed/);
    expect(await docs(s)).toHaveLength(2);
    const whole = (await runSync(s.id, 'manual', { connector: stub([{ key: 'a' }]) }))!;
    expect(whole.counts.removed).toBe(1);
    expect(await docs(s)).toHaveLength(1);
  });

  it('a listing that fails is a failed run that changes nothing', async () => {
    const s = folderSource('unused');
    await runSync(s.id, 'manual', { connector: stub([{ key: 'a' }]) });
    const broken = { list: async () => Promise.reject(new Error('The bucket is not reachable')), fetch: stub([]).fetch };
    const run = (await runSync(s.id, 'manual', { connector: broken }))!;
    expect(run.status).toBe('failed');
    expect(run.note).toContain('The bucket is not reachable');
    expect(await docs(s)).toHaveLength(1);
  });

  it('a stopped signal ends the run as partial and removes nothing', async () => {
    const s = folderSource('unused');
    await runSync(s.id, 'manual', { connector: stub([{ key: 'a' }, { key: 'b' }]) });
    const controller = new AbortController();
    controller.abort();
    const run = (await runSync(s.id, 'manual', { connector: stub([{ key: 'a', version: '2' }]), signal: controller.signal }))!;
    expect(run.status).toBe('partial');
    expect(run.counts.removed).toBe(0);
    expect(await docs(s)).toHaveLength(2);
  });
});

describe('access and one run at a time', () => {
  it('a collection the agent’s project can’t write fails the run with the access message and pauses the source', async () => {
    const collection = unique('owned');
    const owner = agentIn(A, collection);
    await knowledge.addKnowledgeDocument(knowledge.knowledgeConfigOf(owner.id, 'kb1')!, { bytes: new TextEncoder().encode('# Mine\n\ntext'), fileName: 'mine.md' }, {}, { asProject: A, subject: 'agent' });
    const s = folderSource('unused', collection, B);
    const run = (await runSync(s.id, 'manual', { connector: stub([{ key: 'a' }]) }))!;
    expect(run.status).toBe('failed');
    expect(run.note).toMatch(new RegExp(`project can.t use the collection “${collection}”`));
    const row = store.getSource(s.id)!;
    expect(row.paused).toBe(1);
    expect(row.paused_reason).toMatch(/can.t use the collection/);
  });

  it('a knowledge base that was removed fails the run and pauses the source (D15)', async () => {
    const s = folderSource('unused');
    agentStore.saveDraft(s.agent.id, { ...s.agent, tools: [] });
    const run = (await runSync(s.id, 'manual', { connector: stub([{ key: 'a' }]) }))!;
    expect(run.status).toBe('failed');
    expect(store.getSource(s.id)!.paused_reason).toMatch(/knowledge base was removed/);
  });

  it('a second sync while one runs is refused; the claim is released after (AS-7, FR-8)', async () => {
    const s = folderSource('unused');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow = { list: async () => (await gate, { items: [], complete: true }), fetch: stub([]).fetch };
    const first = (await startSync(s.id, 'manual', { connector: slow }))!;
    expect(await startSync(s.id, 'manual', { connector: slow })).toBeUndefined();
    expect(claim.stateOf(s.id)!.run_id).toBe(first.runId);
    release();
    await first.done;
    expect(claim.stateOf(s.id)!.run_id).toBeNull();
    expect(await startSync(s.id, 'manual', { connector: stub([]) })).toBeDefined();
  });

  it('what a run records holds no file bytes and no credential values', async () => {
    const s = folderSource('unused');
    const leaky = { list: async () => ({ items: [{ key: 'a', name: 'a.md', version: '1' }], complete: true }), fetch: async () => Promise.reject(new Error('Request failed (403)')) };
    const run = (await runSync(s.id, 'manual', { connector: leaky }))!;
    expect(JSON.stringify(run)).not.toMatch(/secret|token|Bearer/i);
    expect(run.errors).toEqual([{ item: 'a.md', reason: 'Request failed (403)' }]);
  });
});

describe('the scheduler', () => {
  const T0 = Date.UTC(2030, 0, 1, 8, 0, 0);
  const minutes = (n: number) => T0 + n * 60_000;
  /** A folder source on a schedule, due at once. */
  async function scheduled(schedule: 'hourly' | 'daily' | 'manual', collection = unique('sch')) {
    const s = folderSource('unused', collection);
    store.updateSourceRow(s.id, { schedule });
    await claim.setNextAt(s.id, schedule === 'manual' ? null : new Date(T0).toISOString());
    return s;
  }
  const settledAll = async () => {
    while (knowledgeSourceScheduler.active()) await new Promise((resolve) => setTimeout(resolve, 5));
  };
  const one = (...items: Array<{ key: string }>) => ({ connector: stub(items) });
  /** The tick's options with the test clock at `t` (the scheduler itself never passes a clock: a real run follows real time). */
  const at = (t: number, options: { connector: ReturnType<typeof stub> }) => ({ ...options, now: () => t });
  // Only the sources this test made are due: every other source of the file is paused for the duration.
  const only = (...mine: Array<{ id: string }>) => {
    for (const row of store.allSourceRows()) store.updateSourceRow(row.id, { paused: mine.some((m) => m.id === row.id) ? 0 : 1, paused_reason: 'other test' });
  };

  it('starts an hourly source when it is due and not before, again an hour after it ended', async () => {
    const s = await scheduled('hourly');
    only(s);
    expect(await knowledgeSourceScheduler.tick(T0 - 1000, at(T0 - 1000, one({ key: 'a' })))).toBe(0);
    expect(await knowledgeSourceScheduler.tick(T0, at(T0, one({ key: 'a' })))).toBe(1);
    await settledAll();
    const run = store.listRuns(s.id).runs[0];
    expect(run).toMatchObject({ trigger: 'schedule', status: 'ok', counts: { added: 1 } });
    expect(claim.stateOf(s.id)!.next_at).toBe(new Date(T0 + 3600_000).toISOString());
    expect(await knowledgeSourceScheduler.tick(minutes(30), at(minutes(30), one({ key: 'a' })))).toBe(0);
    expect(await knowledgeSourceScheduler.tick(minutes(61), at(minutes(61), one({ key: 'a' })))).toBe(1);
    await settledAll();
    expect(store.listRuns(s.id).runs).toHaveLength(2);
  });

  it('never starts a paused source or a manual one', async () => {
    const paused = await scheduled('hourly');
    const manual = await scheduled('manual');
    only(manual, paused);
    store.updateSourceRow(paused.id, { paused: 1, paused_reason: 'Paused' });
    expect(await knowledgeSourceScheduler.tick(minutes(500), at(minutes(500), one({ key: 'a' })))).toBe(0);
    expect(store.listRuns(paused.id).runs).toEqual([]);
    expect(store.listRuns(manual.id).runs).toEqual([]);
  });

  it('a sync a cap cut short is due again in a minute (D12)', async () => {
    const s = await scheduled('hourly');
    only(s);
    const items = Array.from({ length: SOURCE_LIMITS.itemsPerSync + 5 }, (_, i) => ({ key: `i${i}` }));
    expect(await knowledgeSourceScheduler.tick(T0, at(T0, { connector: stub(items) }))).toBe(1);
    await settledAll();
    expect(store.listRuns(s.id).runs[0].status).toBe('partial');
    expect(new Date(claim.stateOf(s.id)!.next_at!).getTime() - T0).toBe(SOURCE_LIMITS.retryAfterCapMs);
    expect(await knowledgeSourceScheduler.tick(T0 + 30_000, at(T0 + 30_000, { connector: stub(items) }))).toBe(0);
    expect(await knowledgeSourceScheduler.tick(T0 + 61_000, at(T0 + 61_000, { connector: stub(items) }))).toBe(1);
    await settledAll();
    expect(store.listRuns(s.id).runs[0]).toMatchObject({ status: 'ok', counts: { added: 5 } });
  }, 120_000);

  it('an expired lease closes its run as failed “The process stopped” and frees the source', async () => {
    const s = await scheduled('hourly');
    only(s);
    const dead = store.insertRun(s.id, 'schedule', new Date(T0), 'run-dead');
    expect(await claim.claimSource(s.id, dead.id, T0)).toBe(true);
    expect(await knowledgeSourceScheduler.tick(T0 + 1000, at(T0 + 1000, one({ key: 'a' })))).toBe(0); // the lease still holds
    expect(await knowledgeSourceScheduler.tick(T0 + claim.LEASE_MS + 1000, at(T0 + claim.LEASE_MS + 1000, one({ key: 'a' })))).toBe(1); // freed, and the source is due again
    await settledAll();
    const runs = store.listRuns(s.id).runs;
    expect(runs.find((r) => r.id === 'run-dead')).toMatchObject({ status: 'failed', note: 'The process stopped' });
    expect(runs.find((r) => r.id !== 'run-dead')).toMatchObject({ status: 'ok' });
    expect(claim.stateOf(s.id)!.run_id).toBeNull();
  });

  it('pauses the sources of a knowledge base that was removed and deletes the sources of an agent that was deleted (D15)', async () => {
    const noBase = await scheduled('hourly');
    const noAgent = await scheduled('hourly');
    only(noBase, noAgent);
    agentStore.saveDraft(noBase.agent.id, { ...noBase.agent, tools: [] });
    agentStore.delete(noAgent.agent.id);
    expect(await knowledgeSourceScheduler.tick(T0, at(T0, one({ key: 'a' })))).toBe(0);
    expect(store.getSource(noAgent.id)).toBeDefined(); // missing once: only skipped (a store that has not loaded would say the same)
    expect(await knowledgeSourceScheduler.tick(T0 + 1000, at(T0 + 1000, one({ key: 'a' })))).toBe(0);
    expect(store.getSource(noBase.id)).toMatchObject({ paused: 1, paused_reason: 'The knowledge base was removed' });
    expect(store.getSource(noAgent.id)).toBeUndefined();
    expect(listSourceRows(noAgent.agent.id, 'kb1')).toEqual([]);
  });

  it('runs at most two syncs at once on this process', async () => {
    const sources = await Promise.all([scheduled('hourly'), scheduled('hourly'), scheduled('hourly'), scheduled('hourly')]);
    only(...sources);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow = { list: async () => (await gate, { items: [], complete: true }), fetch: stub([]).fetch };
    expect(await knowledgeSourceScheduler.tick(T0, at(T0, { connector: slow }))).toBe(MAX_CONCURRENT_SYNCS);
    expect(knowledgeSourceScheduler.active()).toBe(2);
    expect(await knowledgeSourceScheduler.tick(T0 + 1000, at(T0 + 1000, { connector: slow }))).toBe(0);
    release();
    await settledAll();
    expect(await knowledgeSourceScheduler.tick(T0 + 2000, at(T0 + 2000, { connector: slow }))).toBe(2);
    await settledAll();
  });
});

describe('a long sync and a lost claim (review: the lease follows real time)', () => {
  afterEach(() => vi.useRealTimers());
  async function scheduledNow(schedule: 'hourly' | 'daily') {
    const s = folderSource('unused');
    store.updateSourceRow(s.id, { schedule });
    await claim.setNextAt(s.id, new Date(Date.now() - 1000).toISOString());
    return s;
  }
  // Only this test's source is looked at: every other source of the file is paused.
  const only = (mine: { id: string }) => {
    for (const row of store.allSourceRows()) store.updateSourceRow(row.id, { paused: row.id === mine.id ? 0 : 1, paused_reason: 'other test' });
  };

  it('a sync of more than five minutes keeps its lease, so no second run is claimed (heartbeat on the real clock)', async () => {
    const s = await scheduledNow('hourly');
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow = { list: async () => (await gate, { items: [], complete: true }), fetch: stub([]).fetch };
    only(s);
    expect(await knowledgeSourceScheduler.tick(Date.now(), { connector: slow })).toBe(1);
    const runId = claim.stateOf(s.id)!.run_id;
    for (let minute = 0; minute < 8; minute++) {
      await vi.advanceTimersByTimeAsync(60_000);
      // the scheduler looks every 30 s: it must find the claim held, never expired, and start nothing
      expect(await knowledgeSourceScheduler.tick(Date.now(), { connector: slow })).toBe(0);
      expect(claim.stateOf(s.id)!.run_id).toBe(runId);
    }
    expect(Date.now() - new Date(store.listRuns(s.id).runs[0].startedAt).getTime()).toBeGreaterThan(claim.LEASE_MS);
    expect(store.listRuns(s.id).runs).toHaveLength(1);
    release();
    while (knowledgeSourceScheduler.active()) await vi.advanceTimersByTimeAsync(5);
    expect(store.listRuns(s.id).runs[0].status).toBe('ok');
  });

  it('a run whose claim the scheduler took back stops at its next renewal and leaves the run the scheduler closed as it is', async () => {
    const s = folderSource('unused');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let aborted = false;
    const connector = { list: async (signal: AbortSignal) => (signal.addEventListener('abort', () => (aborted = true)), await gate, { items: [{ key: 'a', name: 'a.md', version: '1' }], complete: true }), fetch: stub([{ key: 'a' }]).fetch };
    const started = (await startSync(s.id, 'manual', { connector, heartbeatMs: 20 }))!;
    // another process's scheduler found the lease expired and closed the run
    await knowledgeSourceScheduler.tick(Date.now() + claim.LEASE_MS + 60_000, { connector: stub([]) });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(aborted).toBe(true);
    release();
    const view = await started.done;
    expect(view).toMatchObject({ status: 'failed', note: 'The process stopped' });
    expect(store.listRuns(s.id).runs.find((r) => r.id === started.runId)).toMatchObject({ status: 'failed', note: 'The process stopped' });
    expect(await docs(s)).toHaveLength(0); // nothing written after the claim was lost
  });
});

describe('the credential is checked again at every sync (review)', () => {
  const s3Source = (credentialId: string | null) => {
    const s = folderSource('unused');
    store.updateSourceRow(s.id, { kind: 's3', credential_id: credentialId, settings: JSON.stringify({ bucket: 'docs', prefix: '' }), location: unique('docs/') });
    return s;
  };
  const wrongProject = async () => {
    const { credentials } = await import('@/lib/server/credentials/vault');
    const { registry } = await import('@/lib/server/plugins/registry');
    const { corePlugin } = await import('@/lib/server/nodes');
    registry.registerBuiltin(corePlugin);
    const credential = credentials.create({ name: unique('Elsewhere'), type: 'core.s3Api', data: { endpoint: '', region: 'us-east-1', accessKeyId: 'AKIADUMMYKEYFORTESTS', secretAccessKey: 'dummy-secret-for-tests-only', forcePathStyle: true } as never });
    setHomeProject('credential', credential.id, B);
    return credential;
  };

  it('a credential that was deleted, or that the agent’s project can no longer use, fails the run and pauses the source with the reason', async () => {
    const gone = s3Source('cred-deleted');
    const run1 = (await runSync(gone.id, 'manual', { connector: stub([{ key: 'a' }]) }))!;
    expect(run1).toMatchObject({ status: 'failed', note: 'The credential was deleted' });
    expect(store.getSource(gone.id)).toMatchObject({ paused: 1, paused_reason: 'The credential was deleted' });
    expect(await docs(gone)).toHaveLength(0);

    const credential = await wrongProject();
    const other = s3Source(credential.id);
    const run2 = (await runSync(other.id, 'manual', { connector: stub([{ key: 'a' }]) }))!;
    expect(run2.status).toBe('failed');
    expect(run2.note).toMatch(/can’t use the credential/);
    expect(store.getSource(other.id)!.paused).toBe(1);
    expect(run2.note).not.toMatch(/dummy-secret/);
  });
});

describe('a source that is removed while a sync starts (review)', () => {
  it('startSync finds nothing to do for a source deleted before the claim, and leaves no state behind', async () => {
    const s = folderSource('unused');
    store.deleteSource(s.id);
    expect(await startSync(s.id, 'manual', { connector: stub([{ key: 'a' }]) })).toBeUndefined();
    expect(claim.stateOf(s.id)).toBeUndefined();
  });
});
