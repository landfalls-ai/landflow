/**
 * Searching, comparing and measuring runs (lib/server/journal/runs-query.ts, app/api/runs/{search,compare,measures}):
 * three saved runs of two workflows with journals told through the writer, read through the route handlers as the
 * synthetic owner.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 20_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-run-search-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { journalOf, releaseJournal, resetJournals } = await import('@/lib/server/journal');
const { store } = await import('@/lib/server/store');
const search = await import('@/app/api/runs/search/route');
const compare = await import('@/app/api/runs/compare/route');
const measures = await import('@/app/api/runs/measures/route');

afterAll(() => {
  resetJournals();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const get = async (route: { GET: (request: Request) => Promise<Response> }, path: string) => {
  const response = await route.GET(new Request(`http://localhost${path}`));
  return { status: response.status, body: (await response.json()) as any };
};

/** Days before now, at nine o'clock UTC (the journal keeps 30 days). */
const day = (ago: number) => new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate() - ago, 9)).toISOString();
const dev = { id: 'node:dev', name: 'Developer', type: 'agent' as const };
const rev = { id: 'node:rev', name: 'Reviewer', type: 'agent' as const };

interface Seed {
  id: string;
  workflowId: string;
  startedAt: string;
  status?: 'success' | 'error';
  /** Tool calls of the developer: [name, ok, text]. */
  tools?: Array<[string, boolean, string?]>;
  checks?: Array<[string, 'pass' | 'fail' | 'warn']>;
  tokens?: [number, number];
  reviewer?: boolean;
  said?: string;
}

function seed(s: Seed) {
  const start = Date.parse(s.startedAt);
  const t = (ms: number) => new Date(start + ms).toISOString();
  store.saveExecution({ executionId: s.id, workflowId: s.workflowId, workflowName: s.workflowId === 'wf_a' ? 'Build plugin' : 'Answer tickets', mode: 'manual', status: s.status ?? 'success', startedAt: s.startedAt, finishedAt: t(10_000), durationMs: 10_000, runData: {}, executionOrder: [] });
  const journal = journalOf(s.id, { workflowId: s.workflowId });
  journal.record({ type: 'span.started', spanId: 'run', kind: 'run', name: 'Run', actor: { id: 'workflow', name: 'Run', type: 'system' }, at: t(0) });
  journal.record({ type: 'span.started', spanId: 'node:dev:0', parentSpanId: 'run', kind: 'agent', name: 'Developer', actor: dev, at: t(500) });
  (s.tools ?? []).forEach(([name, ok, text], i) => {
    const id = `node:dev:0/step:${i}`;
    journal.record({ type: 'span.started', spanId: id, parentSpanId: 'node:dev:0', kind: 'tool', name, actor: dev, input: { command: name }, at: t(1000 + i * 100) });
    journal.record({ type: 'span.ended', spanId: id, status: ok ? 'success' : 'error', ...(ok ? { output: text ?? 'ok' } : { error: text ?? 'failed' }), at: t(1050 + i * 100) });
  });
  if (s.said) journal.record({ type: 'message', spanId: 'node:dev:0', from: dev, text: s.said, at: t(4000) });
  for (const [name, status] of s.checks ?? []) journal.record({ type: 'check', spanId: 'node:dev:0', check: { name, status, source: 'node' }, at: t(5000) });
  journal.record({ type: 'span.ended', spanId: 'node:dev:0', status: 'success', ...(s.tokens && { usage: { inputTokens: s.tokens[0], outputTokens: s.tokens[1], costUsd: s.tokens[0] / 1e6 } }), at: t(6000) });
  if (s.reviewer) {
    journal.record({ type: 'span.started', spanId: 'node:rev:0', parentSpanId: 'run', kind: 'agent', name: 'Reviewer', actor: rev, at: t(6500) });
    journal.record({ type: 'span.ended', spanId: 'node:rev:0', status: 'success', at: t(8000) });
  }
  journal.record({ type: 'artifact', spanId: 'node:dev:0', artifact: { name: 'PR #7', kind: 'pull_request' }, at: t(5500) });
  journal.record({ type: 'span.ended', spanId: 'run', status: s.status ?? 'success', at: t(10_000) });
  releaseJournal(s.id);
}

store.saveWorkflow({ id: 'wf_a', name: 'Build plugin', nodes: [], connections: [] });
store.saveWorkflow({ id: 'wf_b', name: 'Answer tickets', nodes: [], connections: [] });
seed({ id: 'rs_1', workflowId: 'wf_a', startedAt: day(6), tools: [['Bash', true, 'pnpm test passed'], ['Write', true]], checks: [['tests', 'pass']], tokens: [1000, 100], said: 'Refund policy applies' });
seed({ id: 'rs_2', workflowId: 'wf_a', startedAt: day(5), status: 'error', tools: [['Bash', false, 'tests exploded'], ['Bash', true], ['Grep', true]], checks: [['tests', 'fail'], ['lint', 'warn']], tokens: [3000, 400], reviewer: true });
seed({ id: 'rs_3', workflowId: 'wf_b', startedAt: day(4), tools: [['Search', true, '100% done_ok']], tokens: [200, 20] });

describe('GET /api/runs/search', () => {
  const ids = (body: { items: Array<{ executionId: string }> }) => body.items.map((i) => i.executionId);

  it('lists saved runs newest first, and filters by workflow, status and dates', async () => {
    expect(ids((await get(search, '/api/runs/search')).body).filter((i) => i.startsWith('rs_'))).toEqual(['rs_3', 'rs_2', 'rs_1']);
    expect(ids((await get(search, '/api/runs/search?workflowId=wf_a')).body)).toEqual(['rs_2', 'rs_1']);
    expect(ids((await get(search, '/api/runs/search?status=error')).body)).toEqual(['rs_2']);
    expect(ids((await get(search, `/api/runs/search?from=${day(5).slice(0, 10)}&to=${day(5).slice(0, 10)}`)).body)).toEqual(['rs_2']);
    expect(ids((await get(search, `/api/runs/search?from=${day(4).slice(0, 10)}`)).body)).toEqual(['rs_3']);
  });

  it('finds words in what the journal stores, and says where', async () => {
    const { body } = await get(search, '/api/runs/search?text=refund%20policy');
    expect(ids(body)).toEqual(['rs_1']);
    expect(body.items[0].matches[0]).toContain('Developer');
    expect(body.items[0].matches[0]).toContain('Refund policy');
    // A word that is only a field name of the stored event does not count.
    expect(ids((await get(search, '/api/runs/search?text=parentSpanId')).body)).toEqual([]);
    // LIKE wildcards are plain characters.
    expect(ids((await get(search, '/api/runs/search?text=100%25%20done_ok')).body)).toEqual(['rs_3']);
    expect(ids((await get(search, '/api/runs/search?text=100%25%25')).body)).toEqual([]);
  });

  it('filters by actor, tool, failed steps and a failed check', async () => {
    expect(ids((await get(search, '/api/runs/search?actor=reviewer')).body)).toEqual(['rs_2']);
    expect(ids((await get(search, '/api/runs/search?actor=Developer&workflowId=wf_a')).body)).toEqual(['rs_2', 'rs_1']);
    expect(ids((await get(search, '/api/runs/search?tool=grep')).body)).toEqual(['rs_2']);
    expect(ids((await get(search, '/api/runs/search?tool=bash')).body)).toEqual(['rs_2', 'rs_1']);
    const failed = await get(search, '/api/runs/search?failedSteps=true');
    expect(ids(failed.body)).toEqual(['rs_2']);
    expect(failed.body.items[0]).toMatchObject({ failedSteps: 1, failedChecks: ['tests'] });
    expect(ids((await get(search, '/api/runs/search?failedCheck=')).body)).toEqual(['rs_2']);
    expect(ids((await get(search, '/api/runs/search?failedCheck=tests')).body)).toEqual(['rs_2']);
    expect(ids((await get(search, '/api/runs/search?failedCheck=lint')).body)).toEqual([]);
    // Every filter given has to hold.
    expect(ids((await get(search, '/api/runs/search?tool=bash&text=exploded&status=error')).body)).toEqual(['rs_2']);
    expect(ids((await get(search, '/api/runs/search?tool=bash&text=exploded&status=success')).body)).toEqual([]);
  });

  it('pages', async () => {
    const first = await get(search, '/api/runs/search?workflowId=wf_a&limit=1');
    expect(ids(first.body)).toEqual(['rs_2']);
    expect(first.body.more).toBe(true);
    const second = await get(search, '/api/runs/search?workflowId=wf_a&limit=1&offset=1');
    expect(ids(second.body)).toEqual(['rs_1']);
    expect(second.body.more).toBe(false);
    const filtered = await get(search, '/api/runs/search?tool=bash&limit=1&offset=1');
    expect(ids(filtered.body)).toEqual(['rs_1']);
  });
});

describe('GET /api/runs/compare', () => {
  it('sets two runs side by side with a difference per actor', async () => {
    const { status, body } = await get(compare, '/api/runs/compare?a=rs_1&b=rs_2');
    expect(status).toBe(200);
    expect(body.a).toMatchObject({ executionId: 'rs_1', workflowName: 'Build plugin', status: 'success', durationMs: 10_000, tokensIn: 1000, tokensOut: 100, failedSteps: 0, checks: { pass: 1, fail: 0, warn: 0 } });
    expect(body.a.artifacts).toEqual([{ name: 'PR #7', kind: 'pull_request' }]);
    expect(body.b).toMatchObject({ status: 'error', tokensIn: 3000, tokensOut: 400, failedSteps: 1, failedChecks: ['tests'], checks: { pass: 0, fail: 1, warn: 1 } });
    expect(body.delta).toMatchObject({ tokensIn: 2000, tokensOut: 300, failedSteps: 1, checksFailed: 1, steps: 1 });
    const developer = body.actors.find((a: { id: string }) => a.id === 'node:dev');
    expect(developer.a.steps).toBe(2);
    expect(developer.b.steps).toBe(3);
    expect(developer.delta).toMatchObject({ steps: 1, failedSteps: 1, tokensIn: 2000 });
    // The reviewer took part only in the second run.
    const reviewer = body.actors.find((a: { id: string }) => a.id === 'node:rev');
    expect(reviewer.a).toBeUndefined();
    expect(reviewer.b).toBeDefined();
  });

  it('asks for two runs that exist', async () => {
    expect((await get(compare, '/api/runs/compare?a=rs_1')).status).toBe(400);
    expect((await get(compare, '/api/runs/compare?a=rs_1&b=nope')).status).toBe(404);
  });
});

describe('GET /api/runs/measures', () => {
  it('gives a workflow’s runs oldest first with their numbers', async () => {
    const { status, body } = await get(measures, '/api/runs/measures?workflowId=wf_a');
    expect(status).toBe(200);
    expect(body.workflowName).toBe('Build plugin');
    expect(body.runs.map((r: { executionId: string }) => r.executionId)).toEqual(['rs_1', 'rs_2']);
    expect(body.runs[1]).toMatchObject({ status: 'error', durationMs: 10_000, tokensIn: 3000, tokensOut: 400, failedSteps: 1, checksFailed: 1 });
    expect(body.runs[0].costUsd).toBeCloseTo(0.001, 6);
    expect((await get(measures, '/api/runs/measures')).status).toBe(400);
    expect((await get(measures, '/api/runs/measures?workflowId=nope')).status).toBe(404);
  });
});
