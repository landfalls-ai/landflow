/**
 * Evaluations, wave 6: a CSV/JSON file as the dataset (parsing, the upload route, a run over it), scheduled runs (the
 * cron, the clock-driven tick the leader runs), and the alert when a metric's average falls below a limit or drops
 * against the previous run, sent through an alert channel to a fake receiver.
 */
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineNode, definePlugin } from '@landflow/sdk';
import type { Workflow } from '@landflow/engine';

vi.setConfig({ testTimeout: 30_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-evaluations6-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_PUBLIC_URL: 'http://landflow.test' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { store } = await import('@/lib/server/store');
const { database } = await import('@/lib/server/db');
const { dataTables } = await import('@/lib/server/datatables');
const { alertStore } = await import('@/lib/server/alerts/store');
const files = await import('@/lib/server/evaluations/files');
const evalStore = await import('@/lib/server/evaluations/store');
const { startEvaluationRun, evaluationDone, evaluationDetail, EvaluationError } = await import('@/lib/server/evaluations/runner');
const { metricProblems } = await import('@/lib/server/evaluations/alerts');
const { checkSchedule, nextRun, evaluationSchedules } = await import('@/lib/server/evaluations/schedule');
const datasetRoute = await import('@/app/api/workflows/[id]/evaluations/dataset/route');
const scheduleRoute = await import('@/app/api/workflows/[id]/evaluations/schedule/route');
const overviewRoute = await import('@/app/api/workflows/[id]/evaluations/route');

const answers: Record<string, string> = {};
const main = [{ type: 'main' as const }];
registry.registerBuiltin(corePlugin);
registry.registerBuiltin(
  definePlugin({
    info: { id: 'evaltest', name: 'Evaluation test nodes', version: '0.0.1', description: 'Test nodes' },
    nodes: [
      defineNode({
        description: { name: 'answer', displayName: 'Answer', description: 'Looks the question up', version: 1, kind: 'action', inputs: main, outputs: main, properties: [] },
        async execute(ctx) {
          return [ctx.getInputData().map((item) => ({ json: { output: answers[String(item.json.question)] ?? 'I don’t know' } }))];
        },
      }),
    ],
  }),
);

const hooks: Array<Record<string, any>> = [];
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    hooks.push(JSON.parse(body || '{}'));
    res.writeHead(204).end();
  });
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const hookUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;

afterAll(async () => {
  evaluationSchedules.stop();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const params = <T extends Record<string, string>>(value: T) => ({ params: Promise.resolve(value) });
const put = (url: string, body: BodyInit, headers: Record<string, string> = {}) => new Request(`http://localhost${url}`, { method: 'PUT', body, headers });
const putJson = (body: unknown) => new Request('http://localhost/api', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const CSV = 'question,expected\n2+2,4\ncapital of France,Paris\n"color, of the sky",blue\n';

function fileWorkflow(id: string, settings: Workflow['settings'] = {}): Workflow {
  const node = (name: string, type: string, parameters: Record<string, unknown> = {}, i = 0) => ({ id: name, name, type, typeVersion: 1, position: [i * 200, 0] as [number, number], parameters });
  return store.saveWorkflow({
    id,
    name: id,
    settings,
    nodes: [
      node('Trigger', 'core.evaluationTrigger', { source: 'file', fileExpectedColumn: 'expected' }),
      node('Answer', 'evaltest.answer', {}, 1),
      node('Check', 'core.evaluation', { operation: 'checkIfEvaluating' }, 2),
      node('Exact', 'core.evaluation', { operation: 'setMetrics', metric: 'exactMatch' }, 3),
    ],
    connections: [
      { id: 'e0', type: 'main', source: 'Trigger', target: 'Answer', sourceIndex: 0, targetIndex: 0 },
      { id: 'e1', type: 'main', source: 'Answer', target: 'Check', sourceIndex: 0, targetIndex: 0 },
      { id: 'e2', type: 'main', source: 'Check', target: 'Exact', sourceIndex: 0, targetIndex: 0 },
    ],
  } as Workflow);
}

beforeEach(() => {
  hooks.length = 0;
  for (const table of ['alert_rules', 'alert_channels', 'alert_state'] as const) database().sqlite.exec(`DELETE FROM ${table}`);
});

describe('dataset files', () => {
  it('parses CSV (quotes, delimiters), JSON arrays and wrapped arrays, and JSONL', () => {
    const csv = files.parseDatasetText(CSV, 'cases.csv');
    expect(csv).toMatchObject({ format: 'csv', columns: ['question', 'expected'] });
    expect(csv.rows[2]).toMatchObject({ question: 'color, of the sky', expected: 'blue' });
    expect(files.parseDatasetText('question;expected\na;b\n', 'x.csv').columns).toEqual(['question', 'expected']);
    expect(files.parseDatasetText('[{"q":"a","n":1},{"q":"b"}]', 'x.json')).toMatchObject({ format: 'json', columns: ['q', 'n'] });
    expect(files.parseDatasetText('{"cases":[{"q":"a"}]}', 'x.json').rows).toHaveLength(1);
    expect(files.parseDatasetText('{"q":"a"}\n{"q":"b"}\n', 'x.jsonl').rows).toHaveLength(2);
  });

  it('says what is wrong with a bad file', () => {
    expect(() => files.parseDatasetText('', 'x.csv')).toThrow(files.DatasetFileError);
    expect(() => files.parseDatasetText('question,expected\n', 'x.csv')).toThrow(/no rows/);
    expect(() => files.parseDatasetText('[1,2]', 'x.json')).toThrow(/not an object/);
    expect(() => files.parseDatasetText('{"a":1}', 'x.json')).toThrow(/array of objects/);
  });
});

describe('the dataset route', () => {
  it('uploads a CSV (raw or multipart), previews it, and removes it', async () => {
    fileWorkflow('wf_ds_route');
    const raw = await datasetRoute.PUT(put('/api?fileName=cases.csv', CSV, { 'content-type': 'text/csv' }), params({ id: 'wf_ds_route' }));
    expect(raw.status).toBe(201);
    expect(((await raw.json()) as { file: { fileName: string; rows: number } }).file).toMatchObject({ fileName: 'cases.csv', rows: 3 });

    const form = new FormData();
    form.set('file', new File(['[{"question":"a","expected":"b"}]'], 'cases.json', { type: 'application/json' }));
    const multi = await datasetRoute.PUT(new Request('http://localhost/api', { method: 'PUT', body: form }), params({ id: 'wf_ds_route' }));
    expect(((await multi.json()) as { file: { fileName: string; rows: number } }).file).toMatchObject({ fileName: 'cases.json', rows: 1 });

    const view = (await (await datasetRoute.GET(new Request('http://localhost/api'), params({ id: 'wf_ds_route' }))).json()) as { file: { fileName: string }; preview: unknown[] };
    expect(view.file.fileName).toBe('cases.json');
    expect(view.preview).toHaveLength(1);

    const bad = await datasetRoute.PUT(put('/api?fileName=bad.json', '{"a":1}'), params({ id: 'wf_ds_route' }));
    expect(bad.status).toBe(400);
    expect((await datasetRoute.PUT(put('/api?fileName=e.csv', ''), params({ id: 'wf_ds_route' }))).status).toBe(400);
    expect((await datasetRoute.PUT(put('/api?fileName=e.csv', CSV), params({ id: 'wf_missing' }))).status).toBe(404);

    const removed = await datasetRoute.DELETE(new Request('http://localhost/api', { method: 'DELETE' }), params({ id: 'wf_ds_route' }));
    expect(await removed.json()).toEqual({ removed: true });
    expect(await files.readDatasetFile('wf_ds_route')).toBeUndefined();
  });

  it('keeps the file out of the orphan sweep while the workflow exists', async () => {
    fileWorkflow('wf_ds_sweep');
    await files.saveDatasetFile('wf_ds_sweep', new TextEncoder().encode(CSV), 'cases.csv');
    const scope = database().get<{ scope: string }>('SELECT scope FROM evaluation_settings WHERE workflow_id = ?', 'wf_ds_sweep')!.scope;
    expect(evalStore.isDatasetScope(scope, (id) => Boolean(store.getWorkflow(id)))).toBe(true);
    expect(evalStore.isDatasetScope(scope, () => false)).toBe(false);
    expect(evalStore.isDatasetScope('exec_nothing', () => true)).toBe(false);
  });
});

describe('evaluation runs over a file', () => {
  it('runs every row of the file and stores the averages', async () => {
    Object.assign(answers, { '2+2': '4', 'capital of France': 'Paris', 'color, of the sky': 'green' });
    const workflow = fileWorkflow('wf_file_run');
    await files.saveDatasetFile(workflow.id, new TextEncoder().encode(CSV), 'cases.csv');
    const started = await startEvaluationRun(workflow.id, { workflow });
    expect(started).toMatchObject({ status: 'running', total: 3, source: 'file' });
    const done = await evaluationDone(started.id);
    expect(done).toMatchObject({ status: 'success', total: 3, completed: 3, failed: 0 });
    expect(done!.metrics.exactMatch.average).toBeCloseTo(2 / 3);
    expect(evaluationDetail(started.id)!.cases.map((c) => [c.inputs.question, c.expected, c.metrics.exactMatch])).toEqual([
      ['2+2', '4', 1],
      ['capital of France', 'Paris', 1],
      ['color, of the sky', 'blue', 0],
    ]);
    const overview = (await (await overviewRoute.GET(new Request('http://localhost/api'), params({ id: workflow.id }))).json()) as { trigger: { source: string }; file?: { fileName: string } };
    expect(overview.trigger).toMatchObject({ source: 'file' });
    expect(overview.file).toMatchObject({ fileName: 'cases.csv' });
  });

  it('refuses to start without an uploaded file', async () => {
    const workflow = fileWorkflow('wf_file_none');
    await expect(startEvaluationRun(workflow.id, { workflow })).rejects.toThrow(EvaluationError);
  });
});

describe('schedules', () => {
  it('checks the cron and finds the next run', () => {
    expect(checkSchedule({ cron: '0 6 * * *' })).toBeUndefined();
    expect(checkSchedule({ cron: 'not a cron' })).toBeTruthy();
    expect(checkSchedule({ cron: '0 0 6 * * *' })).toContain('five fields');
    expect(checkSchedule({ cron: '0 6 * * *', timezone: 'Mars/Base' })).toContain('Unknown time zone');
    expect(nextRun({ cron: '30 6 * * *', timezone: 'UTC' }, new Date('2026-10-27T05:00:00Z'))).toBe('2026-10-27T06:30:00.000Z');
    expect(nextRun({ cron: '30 6 * * *', timezone: 'UTC' }, new Date('2026-10-27T06:30:00Z'))).toBe('2026-10-28T06:30:00.000Z');
  });

  it('is set through the route, with validation', async () => {
    fileWorkflow('wf_sched_route');
    const ctx = params({ id: 'wf_sched_route' });
    expect((await scheduleRoute.PUT(putJson({ enabled: true, cron: 'nope' }), ctx)).status).toBe(400);
    const saved = await scheduleRoute.PUT(putJson({ enabled: true, cron: '0 6 * * *', timezone: 'UTC', maxRows: 10 }), ctx);
    expect(saved.status).toBe(200);
    const view = (await saved.json()) as { schedule: { cron: string; maxRows: number }; nextRun: string };
    expect(view.schedule).toMatchObject({ enabled: true, cron: '0 6 * * *', maxRows: 10 });
    expect(view.nextRun).toMatch(/T06:00:00/);
    await scheduleRoute.DELETE(new Request('http://localhost/api', { method: 'DELETE' }), ctx);
    expect(await (await scheduleRoute.GET(new Request('http://localhost/api'), ctx)).json()).toEqual({});
  });

  it('starts a run when the cron matches the minute, once per minute, and records it', async () => {
    Object.assign(answers, { '2+2': '4', 'capital of France': 'Paris', 'color, of the sky': 'blue' });
    const workflow = fileWorkflow('wf_sched_run');
    await files.saveDatasetFile(workflow.id, new TextEncoder().encode(CSV), 'cases.csv');
    await scheduleRoute.PUT(putJson({ enabled: true, cron: '30 6 * * *', timezone: 'UTC' }), params({ id: workflow.id }));
    expect(await evaluationSchedules.tick(new Date('2026-10-27T06:29:10Z'))).toEqual([]);
    const started = await evaluationSchedules.tick(new Date('2026-10-27T06:30:05Z'));
    expect(started).toHaveLength(1);
    // The same minute again: nothing.
    expect(await evaluationSchedules.tick(new Date('2026-10-27T06:30:40Z'))).toEqual([]);
    const done = await evaluationDone(started[0]);
    expect(done).toMatchObject({ status: 'success', trigger: 'schedule' });
    const schedule = evalStore.getSettings(workflow.id).schedule!;
    expect(schedule).toMatchObject({ lastRunId: started[0] });
    expect(schedule.lastError).toBeUndefined();
  });

  it('records why a scheduled run could not start, and skips disabled schedules', async () => {
    const workflow = fileWorkflow('wf_sched_err');
    await scheduleRoute.PUT(putJson({ enabled: true, cron: '0 7 * * *', timezone: 'UTC' }), params({ id: workflow.id }));
    expect(await evaluationSchedules.tick(new Date('2026-10-27T07:00:00Z'))).toEqual([]);
    expect(evalStore.getSettings(workflow.id).schedule!.lastError).toBeTruthy();
    await scheduleRoute.PUT(putJson({ enabled: false, cron: '0 8 * * *', timezone: 'UTC' }), params({ id: workflow.id }));
    expect(await evaluationSchedules.tick(new Date('2026-10-27T08:00:00Z'))).toEqual([]);
  });
});

describe('score alerts', () => {
  const summary = (average: number) => ({ metrics: { exactMatch: { average, count: 3, min: 0, max: 1 } } });

  it('trips below a minimum and on a drop against the previous run', () => {
    expect(metricProblems({ evaluation: { below: 0.8 } }, summary(0.7))).toHaveLength(1);
    expect(metricProblems({ evaluation: { below: 0.8 } }, summary(0.8))).toHaveLength(0);
    expect(metricProblems({ evaluation: { dropPercent: 10 } }, summary(0.8), summary(0.95))[0].reasons[0]).toContain('down 15.8%');
    expect(metricProblems({ evaluation: { dropPercent: 10 } }, summary(0.9), summary(0.95))).toHaveLength(0);
    // No previous run: a drop cannot be measured.
    expect(metricProblems({ evaluation: { dropPercent: 10 } }, summary(0.1))).toHaveLength(0);
    // A rule for one metric ignores the others.
    expect(metricProblems({ evaluation: { metric: 'correctness', below: 0.99 } }, summary(0.1))).toHaveLength(0);
  });

  it('sends one alert through the channels when a finished run trips a rule, and none when it does not', async () => {
    const channel = alertStore.createChannel({ name: 'Hook', kind: 'webhook', config: { url: hookUrl } });
    alertStore.createRule({ name: 'Eval', kind: 'evaluation', enabled: true, workflows: { mode: 'all' }, events: ['evaluationScore'], channelIds: [channel.id], throttleMinutes: 0, evaluation: { below: 0.9, dropPercent: 20 } } as never);
    const workflow = fileWorkflow('wf_eval_alert');
    await files.saveDatasetFile(workflow.id, new TextEncoder().encode(CSV), 'cases.csv');

    Object.assign(answers, { '2+2': '4', 'capital of France': 'Paris', 'color, of the sky': 'blue' });
    await evaluationDone((await startEvaluationRun(workflow.id, { workflow })).id);
    expect(hooks).toHaveLength(0);

    Object.assign(answers, { '2+2': 'five', 'capital of France': 'Lyon', 'color, of the sky': 'blue' });
    await evaluationDone((await startEvaluationRun(workflow.id, { workflow })).id);
    // The notice is sent after the run is stored; give the dispatch a moment.
    for (let i = 0; i < 100 && !hooks.length; i++) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(hooks).toHaveLength(1);
    expect(hooks[0]).toMatchObject({ event: 'evaluationScore' });
    expect(String(hooks[0].summary)).toContain('Evaluation score fell: wf_eval_alert (exactMatch)');
    expect(JSON.stringify(hooks[0].details)).toContain('below the minimum 0.9');
    expect(JSON.stringify(hooks[0].details)).toContain('down 66.7%');
  });
});
