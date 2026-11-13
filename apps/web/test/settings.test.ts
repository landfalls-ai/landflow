/**
 * Instance settings: defaults, validation, and execution retention by count
 * and age through store.saveExecution and pruneExecutions (running and
 * waiting executions are never pruned).
 */
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { ExecutionRecord } from '@/lib/shared/types';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-settings-'));
const previousDir = process.env.LANDFLOW_DATA_DIR;
process.env.LANDFLOW_DATA_DIR = dataDir;

const { store } = await import('@/lib/server/store');
const settings = await import('@/lib/server/settings');
const { DEFAULT_MAX_EXECUTIONS, SettingsFile, SettingsTable, getSettings, hostTimeZone, pruneExecutions, settingsPatchSchema, staleExecutionIds, updateSettings } = settings;

afterAll(() => {
  process.env.LANDFLOW_DATA_DIR = previousDir;
});

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-25T12:00:00Z');

function execution(id: string, status: string, startedAt: string | number): ExecutionRecord {
  const started = typeof startedAt === 'number' ? new Date(startedAt).toISOString() : startedAt;
  return {
    executionId: id,
    workflowId: 'wf_retention',
    workflowName: 'Retention',
    mode: 'trigger',
    status: status as ExecutionRecord['status'],
    startedAt: started,
    finishedAt: started,
    durationMs: 10,
    runData: {},
    executionOrder: [],
  };
}

const ids = () => store.listExecutions({ limit: Infinity }).map((e) => e.id);
const saved = (id: string) => store.getExecution(id) !== undefined;

function clearExecutions() {
  for (const id of ids()) store.deleteExecution(id);
}

describe('settings file', () => {
  it('has defaults: the host time zone, 300 executions, no age limit', () => {
    const file = new SettingsFile(join(mkdtempSync(join(tmpdir(), 'landflow-settings-file-')), 'settings.json'));
    expect(file.get()).toEqual({ timezone: hostTimeZone(), executions: { maxCount: DEFAULT_MAX_EXECUTIONS, maxAgeDays: 0 } });
    expect(DEFAULT_MAX_EXECUTIONS).toBe(300);
  });

  it('merges a patch and persists it', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'landflow-settings-file-')), 'settings.json');
    const file = new SettingsFile(path);
    file.update({ timezone: 'Europe/Berlin' });
    file.update({ executions: { maxAgeDays: 14 } });
    expect(new SettingsFile(path).get()).toEqual({ timezone: 'Europe/Berlin', executions: { maxCount: 300, maxAgeDays: 14 } });
  });

  it('rejects unknown time zones, negative or fractional numbers and unknown keys', () => {
    const file = new SettingsFile(join(mkdtempSync(join(tmpdir(), 'landflow-settings-file-')), 'settings.json'));
    expect(() => file.update({ timezone: 'Mars/Olympus_Mons' })).toThrow(/Unknown time zone/);
    expect(settingsPatchSchema.safeParse({ executions: { maxCount: -1 } }).success).toBe(false);
    expect(settingsPatchSchema.safeParse({ executions: { maxAgeDays: 1.5 } }).success).toBe(false);
    expect(settingsPatchSchema.safeParse({ colour: 'red' }).success).toBe(false);
    expect(settingsPatchSchema.safeParse({ executions: { maxCount: 0, maxAgeDays: 0 } }).success).toBe(true);
    expect(settingsPatchSchema.safeParse({ timezone: 'America/New_York' }).success).toBe(true);
  });

  it('falls back to a default for a saved value that is no longer valid', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'landflow-settings-file-')), 'settings.json');
    writeFileSync(path, JSON.stringify({ timezone: 'Nowhere/Land', executions: { maxCount: 50, maxAgeDays: -3 } }));
    expect(new SettingsFile(path).get()).toEqual({ timezone: hostTimeZone(), executions: { maxCount: 50, maxAgeDays: 0 } });
  });

  it('serves the instance settings from the data directory', () => {
    expect(getSettings().executions.maxCount).toBe(300);
    updateSettings({ timezone: 'Asia/Tokyo' });
    expect(getSettings().timezone).toBe('Asia/Tokyo');
    // Kept in the data directory's database.
    expect(existsSync(join(dataDir, 'landflow.db'))).toBe(true);
    expect(new SettingsTable().get().timezone).toBe('Asia/Tokyo');
    updateSettings({ timezone: hostTimeZone() });
  });
});

describe('staleExecutionIds', () => {
  const list = [
    { id: 'run', status: 'running', startedAt: new Date(NOW - 40 * DAY).toISOString() },
    { id: 'a', status: 'success', startedAt: new Date(NOW - 1 * DAY).toISOString() },
    { id: 'wait', status: 'waiting', startedAt: new Date(NOW - 50 * DAY).toISOString() },
    { id: 'b', status: 'error', startedAt: new Date(NOW - 2 * DAY).toISOString() },
    { id: 'c', status: 'canceled', startedAt: new Date(NOW - 10 * DAY).toISOString() },
    { id: 'd', status: 'success', startedAt: new Date(NOW - 31 * DAY).toISOString() },
  ] as Parameters<typeof staleExecutionIds>[0];

  it('keeps the newest N finished executions', () => {
    expect(staleExecutionIds(list, { maxCount: 2, maxAgeDays: 0 }, NOW)).toEqual(['c', 'd']);
  });

  it('removes finished executions older than D days', () => {
    expect(staleExecutionIds(list, { maxCount: 0, maxAgeDays: 7 }, NOW)).toEqual(['c', 'd']);
    expect(staleExecutionIds(list, { maxCount: 0, maxAgeDays: 30 }, NOW)).toEqual(['d']);
  });

  it('applies both limits, and 0 turns a limit off', () => {
    expect(staleExecutionIds(list, { maxCount: 1, maxAgeDays: 30 }, NOW)).toEqual(['b', 'c', 'd']);
    expect(staleExecutionIds(list, { maxCount: 0, maxAgeDays: 0 }, NOW)).toEqual([]);
  });

  it('never returns running or waiting executions, nor counts them', () => {
    const stale = staleExecutionIds(list, { maxCount: 1, maxAgeDays: 1 }, NOW);
    expect(stale).not.toContain('run');
    expect(stale).not.toContain('wait');
    expect(staleExecutionIds(list, { maxCount: 4, maxAgeDays: 0 }, NOW)).toEqual([]);
  });
});

describe('retention in the store', () => {
  const previousEvery = process.env.LANDFLOW_RETENTION_EVERY;
  afterAll(() => {
    if (previousEvery === undefined) delete process.env.LANDFLOW_RETENTION_EVERY;
    else process.env.LANDFLOW_RETENTION_EVERY = previousEvery;
  });
  beforeEach(() => {
    process.env.LANDFLOW_RETENTION_EVERY = '1';
    clearExecutions();
    updateSettings({ executions: { maxCount: 300, maxAgeDays: 0 } });
  });

  it('saveExecution prunes beyond the configured count, keeping the newest', () => {
    updateSettings({ executions: { maxCount: 3 } });
    for (let i = 1; i <= 5; i++) store.saveExecution(execution(`ex_count_${i}`, 'success', Date.now() - (10 - i) * 1000));
    expect(ids()).toEqual(['ex_count_5', 'ex_count_4', 'ex_count_3']);
    expect(saved('ex_count_1')).toBe(false);
    expect(saved('ex_count_2')).toBe(false);
    expect(saved('ex_count_5')).toBe(true);
  });

  it('saveExecution prunes by age', () => {
    updateSettings({ executions: { maxAgeDays: 7 } });
    store.saveExecution(execution('ex_age_old', 'error', Date.now() - 8 * DAY));
    expect(ids()).toEqual([]);
    store.saveExecution(execution('ex_age_new', 'success', Date.now() - 6 * DAY));
    expect(ids()).toEqual(['ex_age_new']);
  });

  it('never prunes running or waiting executions', () => {
    updateSettings({ executions: { maxCount: 1, maxAgeDays: 1 } });
    store.saveExecution(execution('ex_waiting', 'waiting', Date.now() - 30 * DAY));
    store.saveExecution(execution('ex_running', 'running', Date.now() - 30 * DAY));
    store.saveExecution(execution('ex_done_1', 'success', Date.now() - 2000));
    store.saveExecution(execution('ex_done_2', 'success', Date.now() - 1000));
    // Running executions are listed by the runner (their saved rows are for crash recovery), so not here.
    expect(ids().sort()).toEqual(['ex_done_2', 'ex_waiting']);
    expect(saved('ex_waiting')).toBe(true);
    expect(saved('ex_running')).toBe(true);
  });

  it('pruneExecutions applies changed settings and reports how many it removed ("Prune now")', () => {
    for (let i = 1; i <= 4; i++) store.saveExecution(execution(`ex_now_${i}`, 'success', Date.now() - (10 - i) * 1000));
    expect(ids()).toHaveLength(4);
    updateSettings({ executions: { maxCount: 1 } });
    expect(pruneExecutions()).toBe(3);
    expect(ids()).toEqual(['ex_now_4']);
    expect(pruneExecutions()).toBe(0);
  });

  it('keeps everything when both limits are off', () => {
    updateSettings({ executions: { maxCount: 0, maxAgeDays: 0 } });
    for (let i = 1; i <= 5; i++) store.saveExecution(execution(`ex_off_${i}`, 'success', Date.now() - i * 365 * DAY));
    expect(ids()).toHaveLength(5);
  });
});

describe('json-render setting', () => {
  afterAll(() => {
    delete process.env.LANDFLOW_JSON_RENDER;
  });
  it('follows the environment until a choice is saved, then the choice wins, and null goes back', () => {
    delete process.env.LANDFLOW_JSON_RENDER;
    updateSettings({ jsonRender: null });
    expect(getSettings().jsonRender).toBeUndefined();
    expect(settings.jsonRenderOn()).toBe(false);
    process.env.LANDFLOW_JSON_RENDER = '1';
    expect(settings.jsonRenderOn()).toBe(true);
    updateSettings({ jsonRender: false });
    expect(getSettings().jsonRender).toBe(false);
    expect(settings.jsonRenderOn()).toBe(false);
    delete process.env.LANDFLOW_JSON_RENDER;
    updateSettings({ jsonRender: true });
    expect(settings.jsonRenderOn()).toBe(true);
    // Other patches keep it.
    updateSettings({ timezone: 'UTC' });
    expect(getSettings().jsonRender).toBe(true);
    updateSettings({ jsonRender: null });
    expect(getSettings().jsonRender).toBeUndefined();
  });
  it('validates the patch and works through the file store too', () => {
    expect(settingsPatchSchema.safeParse({ jsonRender: 'yes' }).success).toBe(false);
    expect(settingsPatchSchema.safeParse({ jsonRender: null }).success).toBe(true);
    const file = new SettingsFile(join(dataDir, 'settings-jr.json'));
    expect(file.update({ jsonRender: true }).jsonRender).toBe(true);
    expect(file.update({ timezone: 'UTC' }).jsonRender).toBe(true);
    expect(file.update({ jsonRender: null }).jsonRender).toBeUndefined();
  });
  it('is reported by GET /api/settings and saved by PATCH (the synthetic owner)', async () => {
    const route = await import('@/app/api/settings/route');
    updateSettings({ jsonRender: null });
    const get = async () => (await (await route.GET(new Request('http://x/api/settings'))).json()) as { jsonRender: boolean; settings: { jsonRender?: boolean } };
    expect((await get()).jsonRender).toBe(false);
    const patch = (body: unknown) => route.PATCH(new Request('http://x/api/settings', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
    expect((await patch({ jsonRender: true })).status).toBe(200);
    expect(await get()).toMatchObject({ jsonRender: true, settings: { jsonRender: true } });
    expect((await patch({ jsonRender: 'x' })).status).toBe(400);
    await patch({ jsonRender: null });
    expect((await get()).jsonRender).toBe(false);
  });
});
