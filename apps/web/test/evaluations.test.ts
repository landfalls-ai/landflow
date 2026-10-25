/**
 * Evaluations: the metrics (deterministic and LLM-as-judge with a scripted model), the Evaluation Trigger and
 * Evaluation node, a full offline run over a Data Table (cases, outputs written back, averages stored), comparing
 * two runs, keeping evaluation executions out of Insights and production counts, the routes, and online grading
 * of agents and AI Agent nodes (sampling, scores, flags, trend).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineNode, definePlugin } from '@landflow/sdk';
import type { LanguageModel, ModelTurn, Workflow } from '@landflow/engine';
import type { GenerateInput } from '@/lib/server/nodes/models';
import type { AgentSession } from '@/lib/shared/agents';
import type { ExecutionRecord } from '@/lib/shared/types';

vi.setConfig({ testTimeout: 30_000 });

/** Every scripted model answers through this; tests replace it. */
type Responder = (input: GenerateInput) => Partial<ModelTurn>;
const model = { respond: ((): Partial<ModelTurn> => ({ text: '{"reasoning":"fine","score":4}' })) as Responder, calls: [] as GenerateInput[] };
const scripted = (name = 'scripted'): LanguageModel => ({
  provider: 'test',
  model: name,
  async generate(input) {
    model.calls.push({ ...input, messages: [...input.messages] });
    return { text: '', toolCalls: [], stopReason: 'stop', ...model.respond(input) };
  },
});

vi.mock('@/lib/server/agents/models', () => ({
  OLLAMA_URL: 'http://127.0.0.1:11434',
  modelOptions: async () => [],
  agentModel: (config: { model?: string } | undefined) => {
    if (!config?.model) throw new Error('Choose a model for this agent first');
    return scripted(config.model);
  },
}));

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-evaluations-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { store } = await import('@/lib/server/store');
const { dataTables } = await import('@/lib/server/datatables');
const { InsightsRollup } = await import('@/lib/server/insights');
const { agentStore } = await import('@/lib/server/agents/store');
const metrics = await import('@/lib/server/evaluations/metrics');
const evalStore = await import('@/lib/server/evaluations/store');
const { startEvaluation, evaluationDone, compareRuns, cancelEvaluation, summarizeMetrics, evaluationDetail, EvaluationError } = await import('@/lib/server/evaluations/runner');
const online = await import('@/lib/server/evaluations/online');
const { evaluationNode, evaluationTrigger } = await import('@/lib/server/nodes/evaluation');
const { outputsOf, run, runFlow } = await import('./helpers');
const overviewRoute = await import('@/app/api/workflows/[id]/evaluations/route');
const runRoute = await import('@/app/api/workflows/[id]/evaluations/[runId]/route');
const compareRoute = await import('@/app/api/workflows/[id]/evaluations/compare/route');
const agentEvalRoute = await import('@/app/api/agents/[id]/evaluations/route');

// ---------------------------------------------------------------------------
// Test nodes
// ---------------------------------------------------------------------------

/** What the "Answer" node replies per question; tests change it between runs. */
const answers: Record<string, string> = {};
const slow = { ms: 0 };
const main = [{ type: 'main' as const }];

const evalTestPlugin = definePlugin({
  info: { id: 'evaltest', name: 'Evaluation test nodes', version: '0.0.1', description: 'Test nodes' },
  nodes: [
    defineNode({
      description: { name: 'answer', displayName: 'Answer', description: 'Looks the question up', version: 1, kind: 'action', inputs: main, outputs: main, properties: [] },
      async execute(ctx) {
        if (slow.ms) await new Promise((resolve) => setTimeout(resolve, slow.ms));
        return [ctx.getInputData().map((item) => ({ json: { output: answers[String(item.json.question)] ?? 'I don’t know' } }))];
      },
    }),
    defineNode({
      description: {
        name: 'model',
        displayName: 'Scripted Model',
        description: 'Replies from the test script',
        version: 1,
        kind: 'subnode',
        supplies: 'ai_languageModel',
        inputs: [],
        outputs: [{ type: 'ai_languageModel', displayName: 'Model' }],
        properties: [],
      },
      supplyData: () => scripted(),
    }),
  ],
});

registry.registerBuiltin(corePlugin);
registry.registerBuiltin(evalTestPlugin);

afterAll(() => {
  online.stopOnlineEvaluations();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

beforeEach(() => {
  model.calls.length = 0;
  model.respond = () => ({ text: '{"reasoning":"fine","score":4}' });
  slow.ms = 0;
});

/** The judge's prompt (the user message of the last call). */
const promptOf = (input: GenerateInput) => (input.messages[0] as { content: string }).content;

/** A judge that gives 1 when the ACTUAL section says "green" and EXPECTED doesn't, else 5. */
const colorJudge: Responder = (input) => ({
  text:
    /ACTUAL:\n[^]*green/.test(promptOf(input)) && !/EXPECTED:\n[^\n]*green/.test(promptOf(input))
      ? '{"reasoning":"The sky is not green.","score":1}'
      : '{"reasoning":"Matches the expected answer.","score":5}',
});

interface N {
  name: string;
  type: string;
  parameters?: Record<string, unknown>;
}

/** Save a workflow (node ids are their names); edges are [source, target, type = main, sourceIndex = 0]. */
function save(id: string, nodes: N[], edges: Array<[string, string, string?, number?]>): Workflow {
  return store.saveWorkflow({
    id,
    name: id,
    nodes: nodes.map((n, i) => ({ id: n.name, name: n.name, type: n.type, typeVersion: 1, position: [i * 200, 0], parameters: n.parameters ?? {} })),
    connections: edges.map(([source, target, type = 'main', sourceIndex = 0], i) => ({ id: `e${i}`, type, source, target, sourceIndex, targetIndex: 0 })),
  } as Workflow);
}

function dataset(name: string, rows: Array<Record<string, unknown>>, columns = ['question', 'expected']) {
  const table = dataTables().createTable({ name, columns: columns.map((column) => ({ name: column, type: 'string' })) });
  dataTables().insertRows(table.id, rows);
  return table;
}

const call = <T>(fn: (request: Request, ctx: T) => Promise<Response>, url: string, ctx: T, init?: RequestInit) => fn(new Request(`http://localhost${url}`, init), ctx);
const params = <T extends Record<string, string>>(value: T) => ({ params: Promise.resolve(value) });

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

describe('metrics', () => {
  it('scores exact match, contains and regex (case and whitespace options)', () => {
    expect(metrics.exactMatch('Paris', ' paris ')).toBe(1);
    expect(metrics.exactMatch('Paris', 'paris', { caseSensitive: true })).toBe(0);
    expect(metrics.exactMatch({ a: 1 }, '{"a":1}')).toBe(1);
    expect(metrics.contains('Paris', 'The capital is Paris.')).toBe(1);
    expect(metrics.contains('Lyon', 'The capital is Paris.')).toBe(0);
    expect(metrics.regexMatch('^\\d{4}-\\d{2}-\\d{2}$', '2026-10-25')).toBe(1);
    expect(metrics.regexMatch('/^HELLO/i', 'hello world')).toBe(1);
    expect(metrics.regexMatch('^HELLO', 'hello world', true)).toBe(0);
  });

  it('compares JSON regardless of key order and formatting', () => {
    expect(metrics.jsonEquality('{"a":1,"b":[1,2]}', { b: [1, 2], a: 1 })).toBe(1);
    expect(metrics.jsonEquality('{"a":1}', '{"a":2}')).toBe(0);
    expect(metrics.jsonEquality('[1,2]', '[2,1]')).toBe(0);
  });

  it('scores numeric closeness with absolute and relative tolerances', () => {
    expect(metrics.numericCloseness(100, 100)).toBe(1);
    expect(metrics.numericCloseness(100, '90')).toBeCloseTo(0.9);
    expect(metrics.numericCloseness(100, 'about 99 apples', { tolerance: 1 })).toBe(1);
    expect(metrics.numericCloseness(100, 104, { tolerance: 0.05, relative: true })).toBe(1);
    expect(metrics.numericCloseness(100, 400)).toBe(0);
    expect(metrics.numericCloseness(100, 'none')).toBe(0);
  });

  it('scores string similarity by edit distance', () => {
    expect(metrics.stringSimilarity('kitten', 'kitten')).toBe(1);
    expect(metrics.stringSimilarity('kitten', 'sitting')).toBeCloseTo(1 - 3 / 7);
    expect(metrics.stringSimilarity('', '')).toBe(1);
    expect(metrics.editDistance('flaw', 'lawn')).toBe(2);
  });

  it('scores tools used from names, lists and agent steps', () => {
    expect(metrics.toolsUsed('calculator, search', ['Calculator'])).toBe(0.5);
    expect(metrics.toolsUsed(['calculator'], ['calculator', 'search'])).toBe(1);
    expect(metrics.toolsUsed('', [])).toBe(1);
    expect(metrics.namesOf([{ tool: 'calculator', input: {} }, { action: { tool: 'web_search' } }])).toEqual(['calculator', 'web_search']);
    expect(metrics.namesOf('a,\nb')).toEqual(['a', 'b']);
  });

  it('asks the judge for JSON and reads its score and reasoning', async () => {
    model.respond = () => ({ text: '```json\n{"reasoning":"States the same fact.","score":"4"}\n```' });
    const result = await metrics.judge(scripted(), 'correctness', { question: 'Capital of France?', expected: 'Paris', actual: 'It is Paris.' });
    expect(result).toEqual({ score: 4, reasoning: 'States the same fact.' });
    const prompt = promptOf(model.calls[0]);
    expect(prompt).toContain('EXPECTED:\nParis');
    expect(prompt).toContain('ACTUAL:\nIt is Paris.');
    expect(model.calls[0].system).toMatch(/strict evaluator/);
    expect(model.calls[0].responseFormat).toBe('json');
  });

  it('retries an out-of-range score, rounds a fraction, and falls back to a plain “Score: N” reply', async () => {
    const replies = ['{"score": 9}', '{"score": 3}'];
    model.respond = () => ({ text: replies.shift()! });
    expect((await metrics.judge(scripted(), 'helpfulness', { question: 'q', actual: 'a' })).score).toBe(3);
    expect(model.calls).toHaveLength(2);

    const fractions = ['{"score": 4.4}', '{"score": 4.4}'];
    model.respond = () => ({ text: fractions.shift()! });
    expect((await metrics.judge(scripted(), 'helpfulness', { question: 'q', actual: 'a' })).score).toBe(4);

    model.respond = () => ({ text: 'The answer is grounded in the context. Score: 5' });
    const fallback = await metrics.judge(scripted(), 'faithfulness', { actual: 'a', context: 'ctx' });
    expect(fallback.score).toBe(5);
    expect(promptOf(model.calls.at(-1)!)).toContain('CONTEXT:\nctx');
  });

  it('averages each metric over the cases that recorded it', () => {
    const base = { runId: 'r', status: 'success' as const, inputs: {}, outputs: {} };
    expect(summarizeMetrics([{ ...base, index: 0, metrics: { a: 1, b: 2 } }, { ...base, index: 1, metrics: { a: 0 } }])).toEqual({
      a: { average: 0.5, count: 2, min: 0, max: 1 },
      b: { average: 2, count: 1, min: 2, max: 2 },
    });
  });
});

// ---------------------------------------------------------------------------
// Nodes outside an evaluation run
// ---------------------------------------------------------------------------

describe('Evaluation node (plain runs)', () => {
  it('“Check If Evaluating” sends items to Normal outside an evaluation run', async () => {
    const result = await run(evaluationNode, { operation: 'checkIfEvaluating' }, [{ a: 1 }]);
    expect(result.outputs.map((output) => output.length)).toEqual([0, 1]);
  });

  it('computes deterministic and custom metrics and adds them to the items', async () => {
    const exact = await run(evaluationNode, { operation: 'setMetrics', metric: 'exactMatch', expectedAnswer: 'Paris', actualAnswer: 'paris' }, [{ q: 1 }]);
    expect(exact.json()).toEqual([{ q: 1, exactMatch: 1 }]);
    const named = await run(evaluationNode, { operation: 'setMetrics', metric: 'numericCloseness', expectedAnswer: '10', actualAnswer: '9', metricName: 'closeness' });
    expect(named.json()[0].closeness).toBeCloseTo(0.9);
    const custom = await run(evaluationNode, { operation: 'setMetrics', metric: 'customMetrics', metrics: { values: [{ name: 'short', value: '1' }, { name: 'polite', value: true }] } });
    expect(custom.json()).toEqual([{ short: 1, polite: 1 }]);
    const bad = await run(evaluationNode, { operation: 'setMetrics', metric: 'customMetrics', metrics: { values: [{ name: 'x', value: 'abc' }] } });
    expect(bad.error?.message).toMatch(/not a number/);
    const regex = await run(evaluationNode, { operation: 'setMetrics', metric: 'regex', pattern: '(', actualAnswer: 'x' });
    expect(regex.error?.message).toMatch(/Invalid regular expression/);
  });

  it('“Set Outputs” passes items through unchanged', async () => {
    const result = await run(evaluationNode, { operation: 'setOutputs', outputs: { values: [{ name: 'answer', value: 'x' }] } }, [{ a: 1 }]);
    expect(result.json()).toEqual([{ a: 1 }]);
  });

  it('scores correctness with the LLM judge on the Chat Model slot (expressions per item)', async () => {
    model.respond = colorJudge;
    const result = await runFlow(
      [
        { name: 'Eval', type: 'core.evaluation', parameters: { operation: 'setMetrics', metric: 'correctness', expectedAnswer: '{{ $json.expected }}', actualAnswer: '{{ $json.output }}', userQuery: '{{ $json.question }}' } },
        { name: 'Judge', type: 'test.model' },
      ],
      [
        ['Start', 'Eval'],
        ['Judge', 'Eval', 'ai_languageModel'],
      ],
      {
        input: [
          { question: 'Color of the sky?', expected: 'blue', output: 'green' },
          { question: 'Color of grass?', expected: 'green', output: 'Grass is green' },
        ],
        extra: { model: evalTestPlugin.nodes[1] },
      },
    );
    const [out] = outputsOf(result, 'Eval');
    expect(out.map((item) => item.correctness)).toEqual([1, 5]);
    expect(out[0].correctnessReasoning).toBe('The sky is not green.');
    expect(promptOf(model.calls[0])).toContain('QUESTION:\nColor of the sky?');
  });

  it('asks for a chat model when a judge metric has none', async () => {
    const result = await runFlow([{ name: 'Eval', type: 'core.evaluation', parameters: { operation: 'setMetrics', metric: 'helpfulness' } }], [['Start', 'Eval']]);
    expect(result.runData.Eval?.at(-1)?.error?.message).toMatch(/No chat model connected/);
  });

  it('the Evaluation Trigger outputs the first row (with row_id) when run by hand', async () => {
    const table = dataset('trigger_rows', [
      { question: 'first', expected: '1' },
      { question: 'second', expected: '2' },
    ]);
    const result = await run(evaluationTrigger, { dataTableId: table.name });
    expect(result.json()).toEqual([{ question: 'first', expected: '1', row_id: expect.any(Number) }]);
    expect((await run(evaluationTrigger, { dataTableId: 'missing_table' })).error?.message).toMatch(/not found/);
  });
});

// ---------------------------------------------------------------------------
// Offline runs
// ---------------------------------------------------------------------------

function qaWorkflow(id: string, tableId: string, destination: 'run' | 'row' = 'row') {
  return save(
    id,
    [
      { name: 'Trigger', type: 'core.evaluationTrigger', parameters: { dataTableId: tableId } },
      { name: 'Answer', type: 'evaltest.answer' },
      { name: 'Check', type: 'core.evaluation', parameters: { operation: 'checkIfEvaluating' } },
      { name: 'Record', type: 'core.evaluation', parameters: { operation: 'setOutputs', outputs: { values: [{ name: 'answer', value: '{{ $json.output }}' }] }, destination } },
      { name: 'Exact', type: 'core.evaluation', parameters: { operation: 'setMetrics', metric: 'exactMatch' } },
      { name: 'Correct', type: 'core.evaluation', parameters: { operation: 'setMetrics', metric: 'correctness' } },
      { name: 'Judge', type: 'evaltest.model' },
    ],
    [
      ['Trigger', 'Answer'],
      ['Answer', 'Check'],
      ['Check', 'Record', 'main', 0],
      ['Record', 'Exact'],
      ['Exact', 'Correct'],
      ['Judge', 'Correct', 'ai_languageModel'],
    ],
  );
}

describe('offline evaluation runs', () => {
  const rows = [
    { question: '2+2', expected: '4' },
    { question: 'capital of France', expected: 'Paris' },
    { question: 'color of the sky', expected: 'blue' },
  ];

  it('runs every row, records outputs and metrics per case, writes outputs back to the row and stores the averages', async () => {
    Object.assign(answers, { '2+2': '4', 'capital of France': 'Paris', 'color of the sky': 'green' });
    model.respond = colorJudge;
    const table = dataset('qa_cases', rows);
    const workflow = qaWorkflow('wf_eval_qa', table.id);
    const statsBefore = store.stats().executions24h;

    const started = startEvaluation(workflow.id);
    expect(started).toMatchObject({ status: 'running', number: 1, total: 3, dataTableName: 'qa_cases' });
    const done = await evaluationDone(started.id);
    expect(done).toMatchObject({ status: 'success', total: 3, completed: 3, failed: 0 });
    expect(done!.metrics.exactMatch).toEqual({ average: 2 / 3, count: 3, min: 0, max: 1 });
    expect(done!.metrics.correctness.average).toBeCloseTo(11 / 3);

    // Stored: the run and its cases come back from the database.
    const detail = evaluationDetail(started.id)!;
    expect(detail.metrics).toEqual(done!.metrics);
    expect(detail.cases.map((c) => [c.inputs.question, c.expected, c.outputs.answer, c.metrics.exactMatch, c.metrics.correctness])).toEqual([
      ['2+2', '4', '4', 1, 5],
      ['capital of France', 'Paris', 'Paris', 1, 5],
      ['color of the sky', 'blue', 'green', 0, 1],
    ]);
    expect(detail.cases[2].reasons?.correctness).toBe('The sky is not green.');
    // Each case links its execution, marked as part of the run.
    for (const testCase of detail.cases) {
      const execution = store.getExecution(testCase.executionId!)!;
      expect(execution).toMatchObject({ status: 'success', mode: 'manual', evaluation: { runId: started.id, caseIndex: testCase.index, rowId: testCase.rowId } });
      expect(store.listExecutions({ workflowId: workflow.id, limit: 10 }).find((e) => e.id === testCase.executionId)?.evaluation).toEqual({ runId: started.id });
    }
    // “Write To: Data Table Row” added an answer column and filled it.
    const tableRows = dataTables().listRows(table.id).rows;
    expect(tableRows.map((row) => row.answer)).toEqual(['4', 'Paris', 'green']);
    // Evaluation executions are not production runs.
    expect(store.stats().executions24h).toBe(statsBefore);
  });

  it('compares two runs: metric deltas and per-case improvements and regressions', async () => {
    model.respond = colorJudge;
    const table = dataset('qa_compare', rows);
    const workflow = qaWorkflow('wf_eval_compare', table.id, 'run');
    Object.assign(answers, { '2+2': '4', 'capital of France': 'Paris', 'color of the sky': 'green' });
    const first = (await evaluationDone(startEvaluation(workflow.id).id))!;
    Object.assign(answers, { '2+2': '5', 'color of the sky': 'blue' });
    const second = (await evaluationDone(startEvaluation(workflow.id).id))!;
    expect(second.number).toBe(2);
    // Run destination: the table got no answer column.
    expect(dataTables().getTable(table.id).columns.map((c) => c.name)).toEqual(['question', 'expected']);

    const comparison = compareRuns(first.id, second.id)!;
    expect(comparison.metrics).toEqual([
      { name: 'correctness', a: 11 / 3, b: 5, delta: 5 - 11 / 3 },
      { name: 'exactMatch', a: 2 / 3, b: 2 / 3, delta: 0 },
    ]);
    expect(comparison.cases.map((c) => c.deltas)).toEqual([{ exactMatch: -1, correctness: 0 }, { exactMatch: 0, correctness: 0 }, { exactMatch: 1, correctness: 4 }]);
    expect(comparison.cases[0].a?.outputs).toEqual({ answer: '4' });
    expect(comparison.cases[0].b?.outputs).toEqual({ answer: '5' });
    expect({ improved: comparison.improved, regressed: comparison.regressed, unchanged: comparison.unchanged }).toEqual({ improved: 1, regressed: 1, unchanged: 1 });

    // Over the routes: overview (runs newest first), detail and comparison.
    const overview = await (await call(overviewRoute.GET, `/api/workflows/${workflow.id}/evaluations`, params({ id: workflow.id }))).json();
    expect(overview.runs.map((r: { number: number }) => r.number)).toEqual([2, 1]);
    expect(overview.trigger).toMatchObject({ nodeName: 'Trigger', dataTableName: 'qa_compare', rows: 3, expectedColumn: 'expected' });
    expect(overview.hasMetrics).toBe(true);
    const detail = await (await call(runRoute.GET, `/api/workflows/${workflow.id}/evaluations/${first.id}`, params({ id: workflow.id, runId: first.id }))).json();
    expect(detail.run.cases).toHaveLength(3);
    const viaRoute = await (await call(compareRoute.GET, `/api/workflows/${workflow.id}/evaluations/compare?a=${first.id}&b=${second.id}`, params({ id: workflow.id }))).json();
    expect(viaRoute.improved).toBe(1);
    expect((await call(compareRoute.GET, `/api/workflows/wf_other/evaluations/compare?a=${first.id}&b=${second.id}`, params({ id: 'wf_other' }))).status).toBe(404);
  });

  it('starts over the route, refuses a workflow without an Evaluation Trigger, and limits rows', async () => {
    Object.assign(answers, { '2+2': '4' });
    const table = dataset('qa_route', rows);
    const workflow = qaWorkflow('wf_eval_route', table.id, 'run');
    const response = await call(overviewRoute.POST, `/api/workflows/${workflow.id}/evaluations`, params({ id: workflow.id }), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ maxRows: 1 }),
    });
    expect(response.status).toBe(201);
    const { run: started } = await response.json();
    expect(started.total).toBe(1);
    expect(await evaluationDone(started.id)).toMatchObject({ status: 'success', completed: 1 });

    const plain = save('wf_eval_none', [{ name: 'Start', type: 'core.manualTrigger' }], []);
    expect(() => startEvaluation(plain.id)).toThrow(EvaluationError);
    const refused = await call(overviewRoute.POST, `/api/workflows/${plain.id}/evaluations`, params({ id: plain.id }), { method: 'POST', body: '{}' });
    expect(refused.status).toBe(400);
    expect((await refused.json()).error).toMatch(/Evaluation Trigger/);

    const empty = dataTables().createTable({ name: 'qa_empty', columns: [{ name: 'question', type: 'string' }] });
    const emptyFlow = qaWorkflow('wf_eval_empty', empty.id);
    expect(() => startEvaluation(emptyFlow.id)).toThrow(/no rows/);
  });

  it('records failed cases and goes on with the next row', async () => {
    const table = dataset('qa_fail', [{ question: 'a' }, { question: 'b' }], ['question']);
    const workflow = save(
      'wf_eval_fail',
      [
        { name: 'Trigger', type: 'core.evaluationTrigger', parameters: { dataTableId: table.id } },
        { name: 'Boom', type: 'core.stopAndError', parameters: { message: 'Case {{ $json.question }} failed' } },
      ],
      [['Trigger', 'Boom']],
    );
    const done = (await evaluationDone(startEvaluation(workflow.id).id))!;
    expect(done).toMatchObject({ status: 'success', completed: 2, failed: 2 });
    const cases = evaluationDetail(done.id)!.cases;
    expect(cases.map((c) => c.status)).toEqual(['error', 'error']);
    expect(cases[0].error).toMatch(/failed/);
  });

  it('cancels a running evaluation: the remaining cases never run', async () => {
    slow.ms = 150;
    Object.assign(answers, { '2+2': '4' });
    const table = dataset('qa_cancel', rows);
    const workflow = qaWorkflow('wf_eval_cancel', table.id, 'run');
    const started = startEvaluation(workflow.id);
    expect(() => startEvaluation(workflow.id)).toThrow(/already running/);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(cancelEvaluation(started.id)).toBe(true);
    const done = (await evaluationDone(started.id))!;
    expect(done.status).toBe('canceled');
    expect(evaluationDetail(started.id)!.cases.map((c) => c.status)).toEqual(['canceled', 'canceled', 'canceled']);
  });

  it('“Tools Used” reads the tools an AI Agent called in the case’s execution', async () => {
    const table = dataset('qa_tools', [{ question: 'What is 2+3?', expected: 'calculator' }]);
    let turn = 0;
    model.respond = () => (turn++ === 0 ? { toolCalls: [{ id: 'c1', name: 'Calculator', input: { input: '2+3' } }] } : { text: 'It is 5.' });
    const workflow = save(
      'wf_eval_tools',
      [
        { name: 'Trigger', type: 'core.evaluationTrigger', parameters: { dataTableId: table.id } },
        { name: 'Agent', type: 'core.aiAgent', parameters: { prompt: '{{ $json.question }}' } },
        { name: 'Model', type: 'evaltest.model' },
        { name: 'Calculator', type: 'core.calculatorTool' },
        { name: 'Tools', type: 'core.evaluation', parameters: { operation: 'setMetrics', metric: 'toolsUsed' } },
      ],
      [
        ['Trigger', 'Agent'],
        ['Model', 'Agent', 'ai_languageModel'],
        ['Calculator', 'Agent', 'ai_tool'],
        ['Agent', 'Tools'],
      ],
    );
    const done = (await evaluationDone(startEvaluation(workflow.id).id))!;
    expect(done.metrics.toolsUsed?.average).toBe(1);
  });
});

describe('Insights', () => {
  it('leaves evaluation executions out of the rollup', () => {
    const rollup = new InsightsRollup(join(mkdtempSync(join(tmpdir(), 'landflow-eval-rollup-')), 'insights.json'), () => 'UTC');
    const base: ExecutionRecord = {
      executionId: 'ex_eval_rollup',
      workflowId: 'wf',
      workflowName: 'wf',
      mode: 'manual',
      status: 'success',
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: 5,
      runData: {},
      executionOrder: [],
    };
    expect(rollup.record({ ...base, evaluation: { runId: 'ev_x', caseIndex: 0 } })).toBe(false);
    expect(rollup.record({ ...base, executionId: 'ex_plain' })).toBe(true);
    expect(rollup.report({ period: '24h', includeManual: true }).current.runs).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Online evaluations
// ---------------------------------------------------------------------------

function session(agentId: string, id: string, reply: string): AgentSession {
  const at = new Date().toISOString();
  return agentStore.saveSession({
    id,
    agentId,
    agentName: 'Helper',
    source: 'test',
    userId: 'you',
    title: 'Test',
    status: 'idle',
    version: 'draft',
    messages: [],
    timeline: [
      { id: 't1', type: 'user', text: 'Hi', at },
      { id: 't2', type: 'assistant', text: 'Hello! How can I help?', at },
      { id: 't3', type: 'user', text: 'What is 6*7?', at },
      { id: 't4', type: 'tool', callId: 'c1', tool: 'calculator', label: 'Calculator', kind: 'node', input: { input: '6*7' }, output: '42', status: 'success', at },
      { id: 't5', type: 'assistant', text: reply, at },
    ],
    usage: { inputTokens: 0, outputTokens: 0 },
    traceIds: [],
    createdAt: at,
    updatedAt: at,
  } as AgentSession);
}

describe('online evaluations', () => {
  it('samples by rate', () => {
    expect(online.shouldSample(0, () => 0)).toBe(false);
    expect(online.shouldSample(100, () => 0.999)).toBe(true);
    expect(online.shouldSample(20, () => 0.1)).toBe(true);
    expect(online.shouldSample(20, () => 0.3)).toBe(false);
  });

  it('grades an agent’s latest turn against the rubric, flags low scores and reports the trend', async () => {
    const agent = agentStore.create({ name: 'Helper', model: { provider: 'ollama', model: 'judge-model' } });
    const target = online.agentTarget(agent.id);
    evalStore.saveOnlineConfig(target, { ...evalStore.getOnlineConfig(target), enabled: true, sampleRate: 100, rubric: 'Answers maths correctly.', lowScore: 2 });

    session(agent.id, 'ses_good', '6 × 7 = 42.');
    model.respond = () => ({ text: '{"reasoning":"Correct and uses the calculator.","score":5}' });
    const good = await online.gradeAgentSession(agent.id, 'ses_good');
    expect(good).toMatchObject({ score: 5, flagged: false, agentId: agent.id, sessionId: 'ses_good', tools: ['Calculator'], judge: 'test/judge-model', output: '6 × 7 = 42.' });
    const prompt = promptOf(model.calls[0]);
    expect(prompt).toContain('RUBRIC:\nAnswers maths correctly.');
    expect(prompt).toContain('User: What is 6*7?');
    expect(prompt).toContain('REPLY:\n6 × 7 = 42.');
    expect(prompt).toContain('Tools the agent called: Calculator');

    session(agent.id, 'ses_bad', '6 × 7 = 48.');
    model.respond = () => ({ text: '{"reasoning":"Wrong product.","score":1}' });
    expect(await online.gradeAgentSession(agent.id, 'ses_bad')).toMatchObject({ score: 1, flagged: true });

    const report = online.onlineReport(target);
    expect(report).toMatchObject({ total: 2, average: 3, flagged: 1 });
    expect(report.scores.map((s) => s.sessionId)).toEqual(['ses_bad', 'ses_good']);
    expect(report.trend).toEqual([{ day: new Date().toISOString().slice(0, 10), average: 3, count: 2, flagged: 1 }]);
  });

  it('grades sampled agent runs from the bus (completed runs only)', async () => {
    const agent = agentStore.create({ name: 'Sampled', model: { provider: 'ollama', model: 'judge-model' } });
    const target = online.agentTarget(agent.id);
    session(agent.id, 'ses_bus', 'The answer is 42.');
    model.respond = () => ({ text: '{"reasoning":"ok","score":4}' });

    // Off: nothing is graded.
    expect(online.onAgentRunFinished(agent.id, 'ses_bus', () => 0)).toBeUndefined();
    evalStore.saveOnlineConfig(target, { ...evalStore.getOnlineConfig(target), enabled: true, sampleRate: 50 });
    // Out of the sample.
    expect(online.onAgentRunFinished(agent.id, 'ses_bus', () => 0.9)).toBeUndefined();

    online.startOnlineEvaluations();
    const { bus } = await import('@/lib/server/bus');
    evalStore.saveOnlineConfig(target, { ...evalStore.getOnlineConfig(target), sampleRate: 100 });
    bus.publish({ channel: 'agent', agentId: agent.id, event: { type: 'run.finished', sessionId: 'ses_bus', status: 'idle', reason: 'error', usage: { inputTokens: 0, outputTokens: 0 } } });
    bus.publish({ channel: 'agent', agentId: agent.id, event: { type: 'run.finished', sessionId: 'ses_bus', status: 'idle', reason: 'completed', usage: { inputTokens: 0, outputTokens: 0 } } });
    await online.gradingIdle();
    expect(evalStore.listScores(target).map((s) => s.score)).toEqual([4]);
  });

  it('grades AI Agent node runs of finished executions, never evaluation runs', async () => {
    const workflow = save(
      'wf_online_node',
      [
        { name: 'Chat', type: 'core.chatTrigger' },
        { name: 'Agent', type: 'core.aiAgent' },
        { name: 'Model', type: 'core.ollamaChatModel', parameters: { model: 'node-judge', baseUrl: 'http://127.0.0.1:11434' } },
      ],
      [
        ['Chat', 'Agent'],
        ['Model', 'Agent', 'ai_languageModel'],
      ],
    );
    expect(online.modelOfNode(workflow, 'Agent')).toEqual({ provider: 'ollama', model: 'node-judge', baseUrl: 'http://127.0.0.1:11434' });
    const target = online.nodeTarget(workflow.id, 'Agent');
    evalStore.saveOnlineConfig(target, { ...evalStore.getOnlineConfig(target), enabled: true, sampleRate: 100 });
    const agentRun = (output: string) => ({
      Agent: [
        {
          startedAt: new Date().toISOString(),
          durationMs: 5,
          status: 'success' as const,
          source: 'main' as const,
          inputs: [[{ json: { chatInput: 'What is 6*7?' } }]],
          outputs: [[{ json: { output, steps: [{ tool: 'calculator', input: {}, output: 42 }] } }]],
        },
      ],
    });
    const record = (id: string, extra: Partial<ExecutionRecord> = {}): ExecutionRecord => ({
      executionId: id,
      workflowId: workflow.id,
      workflowName: workflow.name,
      mode: 'chat',
      status: 'success',
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: 5,
      runData: agentRun('42'),
      executionOrder: ['Chat', 'Agent'],
      ...extra,
    });
    store.saveExecution(record('ex_online_1'));
    store.saveExecution(record('ex_online_eval', { runData: agentRun('48'), evaluation: { runId: 'ev_x', caseIndex: 0 } }));
    model.respond = () => ({ text: '{"reasoning":"Correct.","score":5}' });

    await online.onExecutionFinished(workflow.id, 'ex_online_1');
    await online.onExecutionFinished(workflow.id, 'ex_online_eval');
    const scores = evalStore.listScores(target);
    expect(scores).toHaveLength(1);
    expect(scores[0]).toMatchObject({ score: 5, executionId: 'ex_online_1', nodeId: 'Agent', workflowId: workflow.id, input: 'What is 6*7?', output: '42', tools: ['calculator'], judge: 'test/node-judge' });
  });

  it('agent evaluations route: settings, report and grading now', async () => {
    const agent = agentStore.create({ name: 'Routed', model: { provider: 'ollama', model: 'judge-model' } });
    const ctx = params({ id: agent.id });
    const put = await call(agentEvalRoute.PUT, `/api/agents/${agent.id}/evaluations`, ctx, {
      method: 'PUT',
      body: JSON.stringify({ enabled: true, sampleRate: 250, rubric: '  Be right.  ', lowScore: 3 }),
    });
    expect(put.status).toBe(400);
    const saved = await (
      await call(agentEvalRoute.PUT, `/api/agents/${agent.id}/evaluations`, ctx, { method: 'PUT', body: JSON.stringify({ enabled: true, sampleRate: 25, rubric: '  Be right.  ', lowScore: 3 }) })
    ).json();
    expect(saved.report.config).toMatchObject({ enabled: true, sampleRate: 25, rubric: 'Be right.', lowScore: 3 });

    session(agent.id, 'ses_route', 'Fine.');
    model.respond = () => ({ text: '{"reasoning":"Meh.","score":3}' });
    const graded = await call(agentEvalRoute.POST, `/api/agents/${agent.id}/evaluations`, ctx, { method: 'POST', body: JSON.stringify({ sessionId: 'ses_route' }) });
    expect(graded.status).toBe(201);
    expect((await graded.json()).score).toMatchObject({ score: 3, flagged: true });
    const report = await (await call(agentEvalRoute.GET, `/api/agents/${agent.id}/evaluations`, ctx)).json();
    expect(report.report).toMatchObject({ total: 1, flagged: 1 });
    const missing = await call(agentEvalRoute.POST, `/api/agents/${agent.id}/evaluations`, ctx, { method: 'POST', body: JSON.stringify({ sessionId: 'nope' }) });
    expect(missing.status).toBe(404);
  });
});
