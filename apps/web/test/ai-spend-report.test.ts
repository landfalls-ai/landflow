/**
 * The AI page's report on the daily rollup (SP08, docs/llm-gateway.md "The AI page" and "Who sees what", decision D1):
 * the rollup equals the raw sums, its upkeep, periods, the previous period, filters, visibility, distinct runs, unpriced
 * models, and the old `GET /api/insights/ai` keys. Run under `TZ=Pacific/Kiritimati` and `TZ=America/Los_Angeles` too.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Workflow } from '@landflow/engine';
import { AI_SPEND_GROUPS, AI_SPEND_PERIODS, type AiPageReport, type AiSpendGroup } from '@/lib/shared/ai-spend';
import type { AiConsoleGroup, AiConsolePeriod } from '@/lib/shared/llm-gateway';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-ai-spend-'));
const previousEnv = { ...process.env };
Object.assign(process.env, {
  LANDFLOW_DATA_DIR: dataDir,
  LANDFLOW_REGISTRY_GRPC_PORT: 'off',
  LANDFLOW_SCAN_ON_START: 'false',
  LANDFLOW_PLUGINS: '',
  LANDFLOW_AUDIT_OUTBOX: 'off',
});

const { store } = await import('@/lib/server/store');
const { createUser } = await import('@/lib/server/auth/users');
const { enableTestAuth } = await import('@/lib/server/auth/test-bypass');
const projects = await import('@/lib/server/projects');
const { database, MIGRATIONS, migrateSqlite } = await import('@/lib/server/db');
const { aiUsageMeter } = await import('@/lib/server/ai-usage');
const { aiSpendRollup, runRollup, runRollupInBatches, markSpendDays, rollupDay } = await import('@/lib/server/ai-usage/rollup');
const { aiSpendReport } = await import('@/lib/server/ai-usage/spend-report');
const { aiConsoleReport } = await import('@/lib/server/llm-gateway/console');
const { credentials } = await import('@/lib/server/credentials/vault');
const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
registry.registerBuiltin(corePlugin);
const { savePriceOverrides } = await import('@/lib/server/ai-usage/prices');
const route = await import('@/app/api/insights/ai/route');

// The page's own types are the contract's literals (a compile-time check: this block fails to type-check if they differ).
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const periodsMatch: Same<AiConsolePeriod, (typeof AI_SPEND_PERIODS)[number]> = true;
const groupsMatch: Same<AiConsoleGroup, AiSpendGroup> = true;

type User = Awaited<ReturnType<typeof createUser>>;
let admin: User;
let alpha: User;
let beta: User;
let counter = 0;
const meter = () => aiUsageMeter();
const DAY_MS = 86_400_000;
const addDays = (day: string, n: number) =>
  new Date(Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10)) + n * DAY_MS).toISOString().slice(0, 10);
const today = () => meter().today(Date.now());
const daysAgo = (n: number) => addDays(today(), -n);

/** A raw row on `daysAgo` (in the instance's time zone). */
function row(fields: Record<string, unknown> & { daysAgo?: number }) {
  const { daysAgo: back = 0, ...rest } = fields;
  const day = daysAgo(back);
  database().insertNew('ai_usage', {
    id: `sp08-${++counter}`,
    call_id: `sp08-call-${counter}`,
    at: back === 0 ? new Date().toISOString() : `${day}T12:00:00.000Z`,
    day,
    provider: 'anthropic',
    model: 'claude-sonnet-5-5',
    operation: 'chat',
    input_tokens: 100,
    output_tokens: 50,
    cache_read_tokens: 10,
    cache_write_tokens: 5,
    cost: 1,
    ...rest,
  });
}

const as = async <T>(user: User | undefined, fn: () => T | Promise<T>): Promise<T> => {
  enableTestAuth(user);
  try {
    return await fn();
  } finally {
    enableTestAuth();
  }
};
const reportAs = (user: User, query: Parameters<typeof aiSpendReport>[1]) => as(user, () => aiSpendReport(user, query));
const sumBy = <T>(items: T[], pick: (t: T) => number) => items.reduce((n, t) => n + pick(t), 0);

let credId = '';
let wfMine = '';
let wfTheirs = '';
let projectOpen = '';
let projectClosed = '';

beforeAll(async () => {
  admin = await createUser({
    email: 'ada@spend.test',
    name: 'Ada Admin',
    role: 'owner',
    password: 'ada-password-1',
  });
  alpha = await createUser({
    email: 'alma@spend.test',
    name: 'Alma Alpha',
    role: 'member',
    password: 'alma-password-1',
  });
  beta = await createUser({
    email: 'ben@spend.test',
    name: 'Ben Beta',
    role: 'member',
    password: 'ben-password-1',
  });
  projectOpen = projects.createTeamProject({ name: 'Open Project' }).id;
  projectClosed = projects.createTeamProject({ name: 'Closed Project' }).id;
  projects.setMember(projectOpen, alpha.id, 'editor');
  projects.setMember(projectClosed, beta.id, 'editor');
  wfMine = 'wf_sp08_mine';
  wfTheirs = 'wf_sp08_theirs';
  store.saveWorkflow({
    id: wfMine,
    name: 'Mine flow',
    nodes: [],
    connections: [],
  } as unknown as Workflow);
  store.saveWorkflow({
    id: wfTheirs,
    name: 'Their flow',
    nodes: [],
    connections: [],
  } as unknown as Workflow);
  projects.setHomeProject('workflow', wfMine, projectOpen);
  projects.setHomeProject('workflow', wfTheirs, projectClosed);
  credId = credentials.create({
    name: 'Team key',
    type: 'core.openAiApi',
    data: { apiKey: 'sk-test' },
  }).id;
  projects.setHomeProject('credential', credId, projectClosed);
  savePriceOverrides([{ provider: 'ollama', model: 'llama-priced', input: 0.1, output: 0.2 }]);

  // A spread of rows over 12 days: workflows, credentials, surfaces, purposes, sources, people and models.
  for (let back = 0; back < 12; back++) {
    row({
      daysAgo: back,
      workflow_id: wfMine,
      user_id: alpha.id,
      project_id: projectOpen,
      cost: 1 + back,
      execution_id: `ex-a-${back}`,
    });
    row({
      daysAgo: back,
      workflow_id: wfTheirs,
      user_id: beta.id,
      project_id: projectClosed,
      credential_id: credId,
      purpose: 'judge',
      cost: 2,
      model: 'claude-opus-4-1',
      execution_id: `ex-b-${back}`,
    });
    row({
      daysAgo: back,
      user_id: alpha.id,
      surface: 'spotlight',
      purpose: 'answer',
      cost: 0.5,
      session_id: `sess-${back}`,
    });
  }
  // An agent loop: 5 calls of one execution, two models.
  for (let i = 0; i < 5; i++)
    row({
      workflow_id: wfMine,
      user_id: alpha.id,
      execution_id: 'ex-loop',
      model: i % 2 ? 'claude-haiku-4-5' : 'claude-sonnet-5-5',
      cost: 0.1,
    });
  // Local models: one nobody priced, one with an override.
  row({
    provider: 'ollama',
    model: 'qwen3-coder:30b',
    cost: 0,
    user_id: alpha.id,
    workflow_id: wfMine,
    execution_id: 'ex-local',
  });
  row({
    provider: 'ollama',
    model: 'llama-priced',
    cost: 0,
    user_id: alpha.id,
    workflow_id: wfMine,
    execution_id: 'ex-local2',
  });
  // A gateway row of another client.
  row({
    source: 'litellm',
    runtime: 'claude',
    provider: 'litellm',
    model: 'claude-sonnet-5-5',
    cost: 3,
    daysAgo: 3,
  });
  for (let back = 0; back < 40; back++) markSpendDays([daysAgo(back)]);
  runRollup();
});

afterAll(() => {
  for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key];
  Object.assign(process.env, previousEnv);
});

describe('types and constants', () => {
  it('the page types are the contract literals', () => {
    expect(periodsMatch && groupsMatch).toBe(true);
    expect(AI_SPEND_GROUPS).toHaveLength(10);
  });

  it("says the instance's day now, for the page's own range check (not the browser's)", () => {
    const now = Date.parse('2026-11-16T23:30:00.000Z');
    expect(aiSpendReport(admin, { period: '7d' }, now).today).toBe(meter().today(now));
    expect(aiSpendReport(admin, { period: '24h' }, now).today).toBe(meter().today(now));
  });
});

describe('the rollup', () => {
  it('equals the raw sums for every group and for the series (older days read the rollup)', async () => {
    const report = await reportAs(admin, { period: '30d' });
    const from = daysAgo(29);
    const raw = (sql: string) => database().all<{ key: string | null; cost: number; calls: number }>(sql, from);
    const check = (
      group: AiSpendGroup,
      rows: Array<{ key: string | null; cost: number; calls: number }>,
      norm: (k: string | null) => string = (k) => k || 'none',
    ) => {
      const wanted = new Map(rows.map((r) => [norm(r.key), r]));
      for (const out of report.groups[group]) {
        const expected = wanted.get(out.key);
        if (!expected) continue;
        expect(out.cost).toBeCloseTo(expected.cost, 6);
        expect(out.calls).toBe(Number(expected.calls));
      }
      expect(sumBy(report.groups[group], (r) => r.cost)).toBeCloseTo(
        sumBy(rows, (r) => r.cost),
        6,
      );
    };
    for (const [group, column] of [
      ['workflow', 'workflow_id'],
      ['person', 'user_id'],
      ['credential', 'credential_id'],
      ['surface', 'surface'],
      ['purpose', 'purpose'],
    ] as const) {
      check(group, raw(`SELECT ${column} AS key, SUM(cost) AS cost, COUNT(*) AS calls FROM ai_usage WHERE day >= ? GROUP BY ${column}`));
    }
    check('model', raw(`SELECT provider || '/' || model AS key, SUM(cost) AS cost, COUNT(*) AS calls FROM ai_usage WHERE day >= ? GROUP BY provider, model`));
    const daily = database().all<{
      day: string;
      cost: number;
      calls: number;
      input: number;
    }>('SELECT day, SUM(cost) AS cost, COUNT(*) AS calls, SUM(input_tokens) AS input FROM ai_usage WHERE day >= ? GROUP BY day', from);
    expect(report.series).toHaveLength(30);
    expect(report.series[29].at).toBe(today());
    expect(report.series[0].at).toBe(from);
    for (const d of daily) {
      const point = report.series.find((p) => p.at === d.day);
      expect(point?.cost).toBeCloseTo(d.cost, 6);
      expect(point?.calls).toBe(Number(d.calls));
      expect(point?.inputTokens).toBe(Number(d.input));
    }
    // A day with no calls is present with zeros.
    expect(report.series.find((p) => p.at === daysAgo(20))).toMatchObject({
      cost: 0,
      calls: 0,
    });
  });

  it('a rolled-up day differs from nothing: a changed raw row shows after the day is recomputed', async () => {
    const day = daysAgo(8);
    const before = (await reportAs(admin, { period: '30d' })).totals.cost;
    database().insertNew('ai_usage', {
      id: 'sp08-late',
      at: `${day}T10:00:00.000Z`,
      day,
      provider: 'anthropic',
      model: 'claude-sonnet-5-5',
      operation: 'chat',
      input_tokens: 10,
      output_tokens: 10,
      cost: 7,
    });
    expect((await reportAs(admin, { period: '30d' })).totals.cost).toBeCloseTo(before, 6);
    rollupDay(day);
    expect((await reportAs(admin, { period: '30d' })).totals.cost).toBeCloseTo(before + 7, 6);
  });

  it('a late imported row marks its day dirty and the next pass fixes it', async () => {
    const day = daysAgo(6);
    const before = (await reportAs(admin, { period: '30d' })).totals.cost;
    database().insertNew('ai_usage', {
      id: 'sp08-late2',
      at: `${day}T10:00:00.000Z`,
      day,
      provider: 'litellm',
      model: 'x',
      operation: 'chat',
      input_tokens: 10,
      output_tokens: 10,
      cost: 5,
      source: 'litellm',
      runtime: 'kagent',
    });
    markSpendDays([day]);
    expect(database().get<{ value: string }>("SELECT value FROM meta WHERE key = 'ai_spend_dirty_days'")?.value).toContain(day);
    expect(runRollup()).toContain(day);
    expect((await reportAs(admin, { period: '30d' })).totals.cost).toBeCloseTo(before + 5, 6);
    expect(database().get('SELECT 1 AS found FROM meta WHERE key = ?', 'ai_spend_dirty_days')).toBeUndefined();
  });

  it('a pass after a gap of days still fixes the day of the last pass', () => {
    const day = daysAgo(0);
    runRollup();
    expect(database().get<{ value: string }>("SELECT value FROM meta WHERE key = 'ai_spend_rolled_through'")?.value).toBe(day);
    const sum = () => database().get<{ cost: number }>('SELECT COALESCE(SUM(cost), 0) AS cost FROM ai_usage_daily WHERE day = ?', day)!.cost;
    const before = sum();
    // A call recorded after the day's last pass, with no dirty mark, and the host off for days after.
    database().insertNew('ai_usage', {
      id: 'sp08-gap',
      at: `${day}T10:00:00.000Z`,
      day,
      provider: 'anthropic',
      model: 'claude-sonnet-5-5',
      operation: 'chat',
      input_tokens: 1,
      output_tokens: 1,
      cost: 11,
    });
    expect(sum()).toBeCloseTo(before, 6);
    runRollup(Date.now() + 4 * 86_400_000);
    expect(sum()).toBeCloseTo(before + 11, 6);
    database().delete('ai_usage', { id: 'sp08-gap' });
    rollupDay(day);
    database().upsert('meta', { key: 'ai_spend_rolled_through', value: day });
  });

  it('catches up in steps of a week with the event loop free between them, and writes the same rows', async () => {
    const rolled = () => database().all('SELECT * FROM ai_usage_daily ORDER BY day, project_id, goal_id, agent_id, workflow_id, user_id, credential_id, surface, purpose, provider, model, source, runtime');
    const wanted = rolled();
    // A host off for 30 days: the last pass was 30 days ago, and the rollup holds nothing newer.
    database().upsert('meta', { key: 'ai_spend_rolled_through', value: daysAgo(30) });
    for (let back = 0; back <= 30; back++) database().delete('ai_usage_daily', { day: daysAgo(back) });
    expect(rolled().length).toBeLessThan(wanted.length);
    let pauses = 0;
    const days = await runRollupInBatches(Date.now(), database(), async () => {
      pauses += 1;
      // The rows written so far stay whole: a step is complete days.
      await Promise.resolve();
    });
    expect(days.length).toBeGreaterThanOrEqual(31);
    // At least 31 days in steps of 7: four pauses or more.
    expect(pauses).toBe(Math.ceil(days.length / 7) - 1);
    expect(pauses).toBeGreaterThanOrEqual(4);
    expect(rolled()).toEqual(wanted);
    expect(database().get<{ value: string }>("SELECT value FROM meta WHERE key = 'ai_spend_rolled_through'")?.value).toBe(daysAgo(0));
  });

  it('a late import during a pause, into a dirty day already rolled, is rolled on the next pass', async () => {
    const day = daysAgo(20);
    const insert = (id: string) => database().insertNew('ai_usage', { id, at: `${day}T10:00:00.000Z`, day, provider: 'anthropic', model: 'claude-sonnet-5-5', operation: 'chat', input_tokens: 10, output_tokens: 1, cost: 1 });
    const count = (sql: string) => Number(database().get<{ c: number }>(sql, day)!.c);
    const raw = () => count('SELECT COUNT(*) AS c FROM ai_usage WHERE day = ?');
    const rolled = () => count('SELECT COALESCE(SUM(calls), 0) AS c FROM ai_usage_daily WHERE day = ?');
    const dirty = () => database().get<{ value: string }>("SELECT value FROM meta WHERE key = 'ai_spend_dirty_days'")?.value;
    try {
      insert('race-1');
      markSpendDays([day]);
      let fired = false;
      await runRollupInBatches(
        Date.now(),
        database(),
        async () => {
          // The day was rolled by the first step; a late import adds a row and marks it during the pause.
          if (!fired) {
            fired = true;
            insert('race-2');
            markSpendDays([day]);
          }
          await Promise.resolve();
        },
        1,
      );
      expect(fired).toBe(true);
      // The mark added during the pause outlives the pass, and the rollup is short until the next one.
      expect(dirty()).toContain(day);
      await runRollupInBatches(Date.now(), database(), async () => {}, 1);
      expect(rolled()).toBe(raw());
      expect(dirty()).toBeUndefined();
    } finally {
      database().delete('ai_usage', { id: 'race-1' });
      database().delete('ai_usage', { id: 'race-2' });
      database().delete('meta', { key: 'ai_spend_dirty_days' });
      rollupDay(day);
    }
  });

  it('a throw on one dirty day keeps the marks of the days after it, and of itself (fails if marks are taken before the days are rolled)', async () => {
    const [a, b] = [daysAgo(20), daysAgo(19)];
    const insert = (id: string, day: string) => database().insertNew('ai_usage', { id, at: `${day}T10:00:00.000Z`, day, provider: 'anthropic', model: 'claude-sonnet-5-5', operation: 'chat', input_tokens: 10, output_tokens: 1, cost: 1 });
    const dirty = () => database().get<{ value: string }>("SELECT value FROM meta WHERE key = 'ai_spend_dirty_days'")?.value;
    const db = database();
    const original = db.all.bind(db);
    try {
      insert('throw-a', a);
      insert('throw-b', b);
      markSpendDays([a, b]);
      let thrown = false;
      (db as unknown as { all: unknown }).all = (sql: string, ...params: unknown[]) => {
        if (!thrown && sql.includes('FROM ai_usage WHERE day = ?') && params[0] === a) {
          thrown = true;
          throw new Error('boom');
        }
        return original(sql, ...params);
      };
      await expect(runRollupInBatches(Date.now(), db, async () => {}, 7)).rejects.toThrow('boom');
      (db as unknown as { all: unknown }).all = original;
      expect(JSON.parse(dirty() ?? '[]')).toEqual([a, b]);
      await runRollupInBatches(Date.now(), db, async () => {}, 7);
      expect(dirty()).toBeUndefined();
      for (const day of [a, b]) expect(Number(db.get<{ c: number }>('SELECT COALESCE(SUM(calls), 0) AS c FROM ai_usage_daily WHERE day = ?', day)!.c)).toBe(Number(db.get<{ c: number }>('SELECT COUNT(*) AS c FROM ai_usage WHERE day = ?', day)!.c));
    } finally {
      (db as unknown as { all: unknown }).all = original;
      db.delete('ai_usage', { id: 'throw-a' });
      db.delete('ai_usage', { id: 'throw-b' });
      db.delete('meta', { key: 'ai_spend_dirty_days' });
      rollupDay(a);
      rollupDay(b);
    }
  });

  it('stop() then start() while a pass runs leaves one timer and halts the old pass (fails without the generation counter)', async () => {
    const through = daysAgo(30);
    database().upsert('meta', { key: 'ai_spend_rolled_through', value: through });
    for (let back = 0; back <= 30; back++) database().delete('ai_usage_daily', { day: daysAgo(back) });
    const rolledOn = (day: string) => Number(database().get<{ c: number }>('SELECT COUNT(*) AS c FROM ai_usage_daily WHERE day = ?', day)!.c);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      aiSpendRollup.start();
      await vi.advanceTimersByTimeAsync(15_000);
      aiSpendRollup.stop();
      aiSpendRollup.start();
      for (let tick = 0; tick < 10; tick++) await new Promise((resolve) => setImmediate(resolve));
      expect(rolledOn(daysAgo(0))).toBe(0);
      expect(vi.getTimerCount()).toBe(1);
    } finally {
      aiSpendRollup.stop();
      vi.useRealTimers();
      runRollup();
    }
  });

  it('stop() ends a pass in flight between batches and leaves `through` alone', async () => {
    const through = daysAgo(30);
    database().upsert('meta', { key: 'ai_spend_rolled_through', value: through });
    for (let back = 0; back <= 30; back++) database().delete('ai_usage_daily', { day: daysAgo(back) });
    const rolledOn = (day: string) => Number(database().get<{ c: number }>('SELECT COUNT(*) AS c FROM ai_usage_daily WHERE day = ?', day)!.c);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      aiSpendRollup.start();
      // The pass starts after 15 s: it rolls its first week and then waits on the event loop.
      await vi.advanceTimersByTimeAsync(15_000);
      aiSpendRollup.stop();
      for (let tick = 0; tick < 10; tick++) await new Promise((resolve) => setImmediate(resolve));
      // Without the halt the pass runs on to today and moves `through`.
      expect(rolledOn(daysAgo(0))).toBe(0);
      expect(database().get<{ value: string }>("SELECT value FROM meta WHERE key = 'ai_spend_rolled_through'")?.value).toBe(through);
    } finally {
      aiSpendRollup.stop();
      vi.useRealTimers();
      runRollup();
    }
  });

  it('writes only through row-level calls', () => {
    const ops: Array<{ op: string; table: string }> = [];
    const stop = database().observe((batch) => ops.push(...batch.map((o) => ({ op: o.op, table: o.table }))));
    markSpendDays([daysAgo(2)]);
    runRollup();
    stop();
    expect(ops.length).toBeGreaterThan(0);
    const kinds = new Set(ops.map((o) => o.op));
    expect(kinds).toContain('upsert');
    expect(kinds).toContain('delete');
    for (const kind of kinds) expect(['upsert', 'delete', 'deleteBefore', 'insert']).toContain(kind);
    expect(ops.filter((o) => o.table === 'ai_usage_daily').length).toBeGreaterThan(0);
  });

  it('prunes days older than the retention', () => {
    const old = '2020-01-01';
    database().upsert('ai_usage_daily', {
      day: old,
      project_id: '',
      goal_id: '',
      agent_id: '',
      workflow_id: '',
      user_id: '',
      credential_id: '',
      surface: '',
      purpose: '',
      provider: 'p',
      model: 'm',
      source: '',
      runtime: '',
      calls: 1,
    });
    runRollup();
    expect(database().get('SELECT 1 AS found FROM ai_usage_daily WHERE day = ?', old)).toBeUndefined();
  });

  it('migration 2902 backfills the rollup from rows already there', () => {
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');
    const sqlite = new DatabaseSync(':memory:');
    migrateSqlite(
      sqlite,
      MIGRATIONS.filter((m) => m.version < 2902),
    );
    const insert = sqlite.prepare(
      `INSERT INTO ai_usage (id, at, day, provider, model, operation, input_tokens, output_tokens, cost, execution_id, session_id, workflow_id) VALUES (?, ?, ?, 'anthropic', 'm', 'chat', ?, ?, ?, ?, ?, ?)`,
    );
    insert.run('a', '2026-11-01T10:00:00Z', '2026-11-01', 10, 5, 1, 'ex1', null, 'wf');
    insert.run('b', '2026-11-01T11:00:00Z', '2026-11-01', 20, 5, 2, 'ex1', null, 'wf');
    insert.run('c', '2026-11-01T12:00:00Z', '2026-11-01', 1, 1, 0.5, null, 's1', null);
    // Only 2902 here: later migrations (SP12's 2903) are not this test's.
    expect(migrateSqlite(sqlite, MIGRATIONS.filter((m) => m.version <= 2902))).toEqual([2902]);
    const rows = sqlite.prepare('SELECT * FROM ai_usage_daily ORDER BY workflow_id').all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      workflow_id: '',
      calls: 1,
      runs: 1,
      cost: 0.5,
      user_id: '',
      purpose: '',
    });
    expect(rows[1]).toMatchObject({
      workflow_id: 'wf',
      calls: 2,
      runs: 1,
      input_tokens: 30,
      cost: 3,
    });
    sqlite.close();
  });
});

describe('periods and previous period', () => {
  it('90d and custom ranges read the rollup; a bad custom range is a 400', async () => {
    const ninety = await reportAs(admin, { period: '90d' });
    expect(ninety.series).toHaveLength(90);
    expect(ninety.from).toBe(daysAgo(89));
    const custom = await reportAs(admin, {
      period: 'custom',
      from: daysAgo(10),
      to: daysAgo(5),
    });
    expect(custom.series.map((p) => p.at)).toEqual([10, 9, 8, 7, 6, 5].map(daysAgo));
    expect(custom.totals.calls).toBeGreaterThan(0);
    const one = await reportAs(admin, {
      period: 'custom',
      from: daysAgo(3),
      to: daysAgo(3),
    });
    expect(one.series).toHaveLength(1);
    const bad = (query: Parameters<typeof aiSpendReport>[1]) =>
      reportAs(admin, query).then(
        () => 0,
        (e: { status?: number }) => e.status,
      );
    expect(await bad({ period: 'custom', from: daysAgo(500), to: daysAgo(1) })).toBe(400);
    expect(await bad({ period: 'custom', from: daysAgo(1), to: daysAgo(5) })).toBe(400);
    expect(
      await bad({
        period: 'custom',
        from: daysAgo(1),
        to: addDays(today(), 2),
      }),
    ).toBe(400);
    expect(await bad({ period: 'custom', from: '2026-13-40', to: daysAgo(1) })).toBe(400);
    expect(await bad({ period: 'custom' })).toBe(400);
    // The same through the route (the schema).
    const get = async (qs: string) => (route.GET as (r: Request) => Promise<Response>)(new Request(`http://x.test/api/insights/ai?${qs}`));
    expect((await as(admin, () => get(`period=custom&from=${daysAgo(500)}&to=${daysAgo(1)}`))).status).toBe(400);
    expect((await as(admin, () => get(`period=custom&from=${daysAgo(5)}&to=${daysAgo(10)}`))).status).toBe(400);
    expect((await as(admin, () => get(`period=custom&from=${daysAgo(10)}&to=${daysAgo(5)}&compare=1&stack=model`))).status).toBe(200);
  });

  it('24h reads raw rows by hour', async () => {
    const report = await reportAs(admin, { period: '24h' });
    expect(report.series.length).toBeGreaterThanOrEqual(24);
    expect(report.series[0].at).toMatch(/T\d\d:00:00\.000Z$/);
    expect(report.totals.calls).toBe(sumBy(report.series, (p) => p.calls));
  });

  it('compares with the previous period of the same length', async () => {
    const report = await reportAs(admin, { period: '7d', compare: true });
    const prior = database().get<{ cost: number; calls: number }>(
      'SELECT SUM(cost) AS cost, COUNT(*) AS calls FROM ai_usage WHERE day >= ? AND day <= ?',
      daysAgo(13),
      daysAgo(7),
    );
    expect(report.previous?.cost).toBeCloseTo(Number(prior?.cost), 6);
    expect(report.previous?.calls).toBe(Number(prior?.calls));
    const workflow = report.groups.workflow.find((r) => r.key === wfTheirs);
    expect(workflow?.previous?.calls).toBeGreaterThan(0);
    expect(report.movers.length).toBeGreaterThan(0);
    for (const m of report.movers) expect(['none', 'shared', 'other']).not.toContain(m.key);
    expect((await reportAs(admin, { period: '7d' })).previous).toBeUndefined();
    // A custom range over 90 days has no previous period.
    expect(
      (
        await reportAs(admin, {
          period: 'custom',
          from: daysAgo(100),
          to: daysAgo(1),
          compare: true,
        })
      ).previous,
    ).toBeUndefined();
    expect(
      (
        await reportAs(admin, {
          period: 'custom',
          from: daysAgo(10),
          to: daysAgo(1),
          compare: true,
        })
      ).previous,
    ).toBeDefined();
  });

  it('stacks the series by a group, top 5 and Other', async () => {
    const report = await reportAs(admin, { period: '7d', stack: 'model' });
    expect(report.stack?.group).toBe('model');
    expect(report.stack?.points).toHaveLength(7);
    const sum = sumBy(report.stack?.points ?? [], (p) => sumBy(p.cost, (c) => c));
    expect(sum).toBeCloseTo(report.totals.cost, 6);
    expect(report.stack?.scope).toBe('visible');
    expect((await reportAs(alpha, { period: '7d', stack: 'person' })).stack?.scope).toBe('everyone');
  });
});

describe('filters', () => {
  it('narrow the report', async () => {
    const byWorkflow = await reportAs(admin, {
      period: '30d',
      filters: { workflowId: wfTheirs },
    });
    expect(byWorkflow.groups.workflow.map((r) => r.key)).toEqual([wfTheirs]);
    const byModel = await reportAs(admin, {
      period: '30d',
      filters: { model: 'claude-opus-4-1' },
    });
    expect(byModel.groups.model.map((r) => r.key)).toEqual(['anthropic/claude-opus-4-1']);
    expect(
      (
        await reportAs(admin, {
          period: '30d',
          filters: { model: 'anthropic/claude-opus-4-1' },
        })
      ).totals.calls,
    ).toBe(byModel.totals.calls);
    expect((await reportAs(admin, { period: '30d', filters: { purpose: 'judge' } })).groups.purpose.map((r) => r.key)).toEqual(['judge']);
    expect((await reportAs(admin, { period: '30d', filters: { purpose: 'none' } })).groups.purpose.map((r) => r.key)).toEqual(['none']);
    expect(
      (
        await reportAs(admin, {
          period: '30d',
          filters: { surface: 'spotlight' },
        })
      ).groups.surface.map((r) => r.key),
    ).toEqual(['spotlight']);
    expect(
      (
        await reportAs(admin, {
          period: '30d',
          filters: { source: 'litellm:claude' },
        })
      ).totals.calls,
    ).toBe(1);
    expect(
      (
        await reportAs(admin, {
          period: '30d',
          filters: { source: 'landflow:landflow' },
        })
      ).groups.source.map((r) => r.key),
    ).toEqual(['landflow:landflow']);
    expect((await reportAs(admin, { period: '30d', filters: { userId: beta.id } })).groups.person.map((r) => r.key)).toEqual([beta.id]);
    expect(
      (
        await reportAs(admin, {
          period: '30d',
          filters: { projectId: projectClosed },
        })
      ).groups.workflow.map((r) => r.key),
    ).toEqual([wfTheirs]);
    expect(
      (
        await reportAs(admin, {
          period: '30d',
          filters: { credentialId: credId },
        })
      ).totals.calls,
    ).toBeGreaterThan(0);
  });

  it('a filter on a workflow, agent, project or credential the member cannot read is a 404', async () => {
    const status = (filters: Parameters<typeof aiSpendReport>[1]['filters']) =>
      reportAs(alpha, { period: '7d', filters }).then(
        () => 200,
        (e: { status?: number }) => e.status,
      );
    expect(await status({ workflowId: wfTheirs })).toBe(404);
    expect(await status({ projectId: projectClosed })).toBe(404);
    expect(await status({ agentId: 'ag_not_theirs' })).toBe(404);
    expect(await status({ credentialId: credId })).toBe(404);
    expect(await status({ workflowId: wfMine })).toBe(200);
    expect(await status({ projectId: projectOpen })).toBe(200);
    const response = await as(alpha, () =>
      (route.GET as (r: Request) => Promise<Response>)(new Request(`http://x.test/api/insights/ai?workflowId=${wfTheirs}`)),
    );
    expect(response.status).toBe(404);
  });
});

describe('a member (D1)', () => {
  it('sees every person by name over every row, other groups as Another ..., totals of what they see', async () => {
    const report = await reportAs(alpha, { period: '7d' });
    const people = Object.fromEntries(report.groups.person.map((r) => [r.label, r.cost]));
    expect(Object.keys(people)).toEqual(expect.arrayContaining(['Alma Alpha', 'Ben Beta']));
    expect(sumBy(report.groups.person, (r) => r.cost)).toBeCloseTo(report.peopleTotals.cost, 6);
    expect(report.peopleTotals.cost).toBeGreaterThan(report.totals.cost);
    const wf = report.groups.workflow.map((r) => r.label);
    expect(wf).toContain('Mine flow');
    expect(wf).not.toContain('Their flow');
    expect(report.groups.workflow.find((r) => r.key === wfMine)?.href).toBe(`/workflows/${wfMine}`);
    expect(report.groups.person.find((r) => r.key === alpha.id)?.href).toBe(`/insights/ai?userId=${alpha.id}`);
    expect(report.groups.credential.map((r) => r.label)).not.toContain('Team key');
    expect(sumBy(report.groups.workflow, (r) => r.cost)).toBeCloseTo(report.totals.cost, 6);
    const text = JSON.stringify(report);
    expect(text).not.toContain('ben@spend.test');
    expect(text).not.toContain(credId);
    // An admin sees the credential by name.
    expect((await reportAs(admin, { period: '7d' })).groups.credential.map((r) => r.label)).toContain('Team key');
  });

  it('ben sees Another workflow for what is not his and his own credential by name', async () => {
    const report = await reportAs(beta, { period: '7d' });
    expect(report.groups.workflow.map((r) => r.label)).toContain('Their flow');
    expect(report.groups.credential.map((r) => r.label)).toContain('Team key');
    const alma = await reportAs(alpha, { period: '7d' });
    expect(alma.groups.surface.map((r) => r.label)).toEqual(expect.arrayContaining(['Spotlight']));
    expect(alma.groups.purpose.map((r) => r.label)).toEqual(expect.arrayContaining(['Answer']));
  });

  it('labels the groups', async () => {
    const report = await reportAs(admin, { period: '30d' });
    expect(report.groups.surface.map((r) => r.label)).toEqual(expect.arrayContaining(['Spotlight', 'Runs and agents']));
    expect(report.groups.purpose.map((r) => r.label)).toEqual(expect.arrayContaining(['Judge', 'No purpose']));
    expect(report.groups.workflow.map((r) => r.label)).toEqual(expect.arrayContaining(['Mine flow', 'No workflow']));
    expect(report.groups.credential.map((r) => r.label)).toContain('No credential');
    expect(report.groups.source.map((r) => r.label)).toContain('Claude Code on kagent');
  });
});

describe('runs and unpriced models', () => {
  it('counts distinct runs: an agent loop of 5 calls is 1 run, and one run across two models is 1 in the totals', async () => {
    const report = await reportAs(admin, {
      period: '7d',
      filters: { workflowId: wfMine },
    });
    const loop = database().get<{ runs: number }>(
      'SELECT COUNT(DISTINCT execution_id) AS runs FROM ai_usage WHERE workflow_id = ? AND day >= ? AND execution_id IS NOT NULL',
      wfMine,
      daysAgo(6),
    );
    expect(report.totals.runs).toBe(Number(loop?.runs));
    expect(report.totals.runs).toBeLessThan(report.totals.calls);
    const models = report.groups.model.filter((m) => ['anthropic/claude-haiku-4-5', 'anthropic/claude-sonnet-5-5'].includes(m.key));
    expect(models).toHaveLength(2);
    // ex-loop ran on both models: counted once in each model row, once in the total.
    expect(sumBy(report.groups.model, (m) => m.runs)).toBe(report.totals.runs + 1);
    const loopOnly = database().all("SELECT DISTINCT execution_id FROM ai_usage WHERE execution_id = 'ex-loop'");
    expect(loopOnly).toHaveLength(1);
  });

  it('flags a model with no price and no cost, and not a priced one', async () => {
    const report = await reportAs(admin, { period: '7d' });
    expect(report.groups.model.find((m) => m.key === 'ollama/qwen3-coder:30b')?.unpriced).toBe(true);
    expect(report.groups.model.find((m) => m.key === 'ollama/llama-priced')?.unpriced).toBeUndefined();
    expect(report.groups.model.find((m) => m.key === 'anthropic/claude-sonnet-5-5')?.unpriced).toBeUndefined();
    expect(report.totals.unpricedCalls).toBeGreaterThanOrEqual(1);
  });

  it('counts the calls of an unpriced model in the totals and in the rows that hold them', async () => {
    const report = await reportAs(admin, { period: '7d' });
    const raw = Number(database().get<{ n: number }>("SELECT COUNT(*) AS n FROM ai_usage WHERE provider = 'ollama' AND model = 'qwen3-coder:30b' AND day >= ?", daysAgo(6))?.n);
    expect(raw).toBeGreaterThan(0);
    // The only calls with no price and no cost: the unpriced local model's.
    expect(report.totals.unpricedCalls).toBe(raw);
    expect(report.groups.model.find((m) => m.key === 'ollama/qwen3-coder:30b')?.unpricedCalls).toBe(raw);
    expect(report.groups.model.find((m) => m.key === 'ollama/llama-priced')?.unpricedCalls).toBe(0);
    expect(report.groups.workflow.find((w) => w.key === wfMine)?.unpricedCalls).toBe(raw);
    expect(sumBy(report.groups.model, (m) => m.unpricedCalls)).toBe(report.totals.unpricedCalls);
  });
});

describe('the old report', () => {
  it('GET /api/insights/ai?period=7d keeps every key it had', async () => {
    const response = await as(admin, () => (route.GET as (r: Request) => Promise<Response>)(new Request('http://x.test/api/insights/ai?period=7d')));
    expect(response.status).toBe(200);
    const body = (await response.json()) as AiPageReport & Record<string, unknown>;
    for (const key of ['period', 'from', 'to', 'totals', 'peopleTotals', 'groups', 'caps', 'requests', 'viewer', 'capRaise']) expect(body).toHaveProperty(key);
    for (const group of ['project', 'goal', 'agent', 'person', 'model', 'source']) expect(Array.isArray(body.groups[group as AiSpendGroup])).toBe(true);
    for (const key of ['inputTokens', 'outputTokens', 'cost', 'calls']) expect(body.totals).toHaveProperty(key);
    expect(body.viewer).toEqual({ admin: true, userId: admin.id });
    expect(Object.keys(body.groups).sort()).toEqual([...AI_SPEND_GROUPS].sort());
    const old = await as(admin, () => aiConsoleReport(admin, '7d'));
    expect(old.totals.calls).toBe(body.totals.calls);
  });
});
