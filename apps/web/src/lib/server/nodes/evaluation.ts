/**
 * Offline evaluations (after n8n's): the Evaluation Trigger reads test cases from a Data Table, and an
 * evaluation run (lib/server/evaluations/runner.ts) starts one execution per row. The Evaluation node then
 * records what the workflow produced (“Set Outputs”), scores it (“Set Metrics”: deterministic metrics, an LLM
 * judge on the “Chat Model” slot, or custom expressions), or routes items by whether the run is an evaluation
 * (“Check If Evaluating”). Outside an evaluation run the metrics are still computed and added to the items.
 */
import { defineNode, NodeOperationError, type IExecuteContext, type JsonObject, type JsonValue, type NodeItem, type PropertyDescriptor } from '@landflow/sdk';
import type { LanguageModel } from '@landflow/engine';
import type { EvaluationRef } from '../../shared/evaluations';
import { dataTables } from '../datatables';
import { scopedTable, tableScope, tablesInScope } from '../datatables/projects';
import { loadDataset, loadFileDataset, rowItem, type Dataset } from '../evaluations/dataset';
import {
  asText,
  contains,
  exactMatch,
  judge,
  jsonEquality,
  namesOf,
  numericCloseness,
  regexMatch,
  stringSimilarity,
  toNumber,
  toolsUsed,
  type JudgeMetric,
} from '../evaluations/metrics';
import { getCase, getRun, updateCase } from '../evaluations/store';
import { connectedModel } from './fallback';

const COLOR = '#8b5cf6';

export type MetricKind =
  | 'exactMatch'
  | 'contains'
  | 'regex'
  | 'jsonEquality'
  | 'numericCloseness'
  | 'stringSimilarity'
  | 'toolsUsed'
  | 'correctness'
  | 'helpfulness'
  | 'faithfulness'
  | 'customMetrics';

export const JUDGE_METRICS: MetricKind[] = ['correctness', 'helpfulness', 'faithfulness'];
const EXPECTED_METRICS: MetricKind[] = ['exactMatch', 'contains', 'jsonEquality', 'numericCloseness', 'stringSimilarity', 'correctness'];
const ACTUAL_METRICS: MetricKind[] = ['exactMatch', 'contains', 'regex', 'jsonEquality', 'numericCloseness', 'stringSimilarity', 'correctness', 'helpfulness', 'faithfulness'];
const TEXT_METRICS: MetricKind[] = ['exactMatch', 'contains', 'regex', 'stringSimilarity'];

const metricsShow = (metrics: MetricKind[]) => ({ operation: ['setMetrics'], metric: metrics });

/** The evaluation case of the running execution (sub-executions inherit it), if it is part of an evaluation run. */
export async function evaluationOf(ctx: Pick<IExecuteContext, 'getExecutionId'>): Promise<EvaluationRef | undefined> {
  const { liveExecution } = await import('../runner');
  return liveExecution(ctx.getExecutionId())?.evaluation;
}

// ---------------------------------------------------------------------------
// Evaluation Trigger
// ---------------------------------------------------------------------------

export const evaluationTrigger = defineNode({
  description: {
    name: 'evaluationTrigger',
    displayName: 'Evaluation Trigger',
    description: 'Start an evaluation run: one execution per test case of a Data Table or an uploaded CSV or JSON file',
    version: 1,
    kind: 'trigger',
    triggerSource: 'manual',
    categories: ['Triggers', 'AI', 'Evaluation'],
    icon: 'lucide:flask-conical',
    color: COLOR,
    keywords: ['evaluation', 'eval', 'test', 'dataset', 'test cases', 'benchmark', 'llm as judge', 'regression'],
    inputs: [],
    outputs: [{ type: 'main' }],
    properties: [
      {
        name: 'notice',
        displayName:
          'Start a run on the workflow’s Evaluations tab: each row runs the workflow once, as one item with the row’s columns and row_id. “Run” in the editor uses the first row.',
        type: 'notice',
      },
      {
        name: 'source',
        displayName: 'Dataset',
        type: 'options',
        default: 'dataTable',
        noDataExpression: true,
        options: [
          { name: 'Data Table', value: 'dataTable', description: 'A table on the Data Tables page' },
          { name: 'Uploaded file', value: 'file', description: 'A CSV or JSON file uploaded on the Evaluations tab' },
        ],
        description: 'Where the test cases are: one row per case, with input columns and an expected-output column.',
      },
      {
        name: 'dataTableId',
        displayName: 'Data Table',
        type: 'options',
        default: '',
        required: true,
        noDataExpression: true,
        typeOptions: { loadOptionsMethod: 'tables' },
        displayOptions: { show: { source: ['dataTable'] } },
        description: 'The test cases: one row per case, with input columns and an expected-output column.',
      },
      {
        name: 'expectedColumn',
        displayName: 'Expected Output Column',
        type: 'options',
        default: '',
        noDataExpression: true,
        typeOptions: { loadOptionsMethod: 'columns', loadOptionsDependsOn: ['dataTableId'] },
        displayOptions: { show: { source: ['dataTable'] } },
        hint: 'Empty: a column named expected, expected_output or answer. Metrics compare against it when “Expected Answer” is empty.',
      },
      {
        name: 'fileNotice',
        displayName: 'Upload the CSV or JSON file on the workflow’s Evaluations tab. CSV: the first row names the columns. JSON: an array of objects.',
        type: 'notice',
        displayOptions: { show: { source: ['file'] } },
      },
      {
        name: 'fileExpectedColumn',
        displayName: 'Expected Output Column',
        type: 'string',
        default: '',
        noDataExpression: true,
        displayOptions: { show: { source: ['file'] } },
        hint: 'Empty: a column named expected, expected_output or answer.',
      },
      { name: 'limitRows', displayName: 'Limit Rows', type: 'boolean', default: false, noDataExpression: true, description: 'Evaluate only the first rows of the table' },
      {
        name: 'maxRows',
        displayName: 'Max Rows',
        type: 'number',
        default: 10,
        noDataExpression: true,
        typeOptions: { minValue: 1 },
        displayOptions: { show: { limitRows: [true] } },
      },
    ],
  },
  async execute(ctx) {
    // An evaluation run hands over the case's row; a plain run reads the first row itself.
    if (await evaluationOf(ctx)) return [ctx.getInputData()];
    const source = ctx.getNodeParameter<string>('source', 0, 'dataTable') === 'file' ? 'file' : 'dataTable';
    const parameters = { source, dataTableId: ctx.getNodeParameter('dataTableId', 0, ''), expectedColumn: ctx.getNodeParameter('expectedColumn', 0, ''), fileExpectedColumn: ctx.getNodeParameter('fileExpectedColumn', 0, '') };
    let dataset: Dataset;
    try {
      if (source === 'file') {
        const workflowId = ctx.getWorkflowId();
        if (!workflowId) throw new Error('The file dataset belongs to a saved workflow: save it first');
        dataset = await loadFileDataset(workflowId, parameters, { maxRows: 1 });
      } else dataset = loadDataset(parameters, { maxRows: 1, ...(ctx.getWorkflowId() && { workflowId: ctx.getWorkflowId() }) });
    } catch (error) {
      throw new NodeOperationError((error as Error).message, { description: source === 'file' ? 'Upload the file on the workflow’s Evaluations tab.' : 'Tables are created on the Data Tables page.' });
    }
    if (!dataset.rows.length) throw new NodeOperationError(`${dataset.source === 'file' ? 'The file' : 'Data table'} “${dataset.name}” has no rows`, { description: 'Add one row per test case.' });
    return [[rowItem(dataset.rows[0])]];
  },
  methods: {
    loadOptions: {
      // The workflow being edited (the load-options route's scope): only its project's tables.
      tables: () =>
        tablesInScope(tableScope()).map((table) => ({ name: table.name, value: table.id, description: `${table.rowCount.toLocaleString('en-US')} rows · ${table.columns.length} columns` })),
      columns: (ctx) => [
        { name: '(automatic)', value: '', description: 'expected, expected_output or answer' },
        ...(scopedTable(String(ctx.getNodeParameter('dataTableId', '') ?? ''), tableScope())?.columns ?? []).map((c) => ({ name: c.name, value: c.name, description: c.type })),
      ],
    },
  },
});

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

const nameValueCollection = (name: string, displayName: string, group: string, groupName: string, valuePlaceholder: string, show: NonNullable<PropertyDescriptor['displayOptions']>['show']): PropertyDescriptor => ({
  name,
  displayName,
  type: 'fixedCollection',
  typeOptions: { multipleValues: true },
  default: {},
  displayOptions: { show },
  groups: [
    {
      name: group,
      displayName: groupName,
      values: [
        { name: 'name', displayName: 'Name', type: 'string', default: '', placeholder: name === 'metrics' ? 'politeness' : 'answer' },
        { name: 'value', displayName: 'Value', type: 'string', default: '', placeholder: valuePlaceholder },
      ],
    },
  ],
});

const properties: PropertyDescriptor[] = [
  {
    name: 'operation',
    displayName: 'Operation',
    type: 'options',
    default: 'setOutputs',
    noDataExpression: true,
    options: [
      { name: 'Set Outputs', value: 'setOutputs', description: 'Record what the workflow produced for the test case', action: 'Set outputs' },
      { name: 'Set Metrics', value: 'setMetrics', description: 'Score the output and record the metric', action: 'Set metrics' },
      { name: 'Check If Evaluating', value: 'checkIfEvaluating', description: 'Route items differently during evaluation runs', action: 'Check if evaluating' },
    ],
  },
  // Set Outputs
  nameValueCollection('outputs', 'Outputs', 'values', 'Output', '{{ $json.output }}', { operation: ['setOutputs'] }),
  {
    name: 'destination',
    displayName: 'Write To',
    type: 'options',
    default: 'run',
    noDataExpression: true,
    displayOptions: { show: { operation: ['setOutputs'] } },
    options: [
      { name: 'Evaluation Run', value: 'run', description: 'Keep the outputs with the run’s case results' },
      { name: 'Data Table Row', value: 'row', description: 'Also write them into the test case’s row (missing columns are added)' },
    ],
  },
  // Set Metrics
  {
    name: 'metric',
    displayName: 'Metric',
    type: 'options',
    default: 'correctness',
    noDataExpression: true,
    displayOptions: { show: { operation: ['setMetrics'] } },
    options: [
      { name: 'Correctness (AI)', value: 'correctness', description: 'An LLM judge rates whether the answer states the expected facts (1–5)' },
      { name: 'Helpfulness (AI)', value: 'helpfulness', description: 'An LLM judge rates how well the answer addresses the question (1–5)' },
      { name: 'Faithfulness (AI)', value: 'faithfulness', description: 'An LLM judge rates whether the answer sticks to the given context (1–5)' },
      { name: 'Exact Match', value: 'exactMatch', description: '1 when the answer equals the expected one, else 0' },
      { name: 'Contains', value: 'contains', description: '1 when the answer contains the expected text, else 0' },
      { name: 'Regex', value: 'regex', description: '1 when the answer matches a regular expression, else 0' },
      { name: 'JSON Equality', value: 'jsonEquality', description: '1 when both parse to the same JSON value (key order ignored), else 0' },
      { name: 'Numeric Closeness', value: 'numericCloseness', description: '1 within the tolerance, falling towards 0 with the relative error' },
      { name: 'String Similarity', value: 'stringSimilarity', description: '1 − edit distance ÷ length (0–1)' },
      { name: 'Tools Used', value: 'toolsUsed', description: 'Share of the expected tools the agent called (0–1)' },
      { name: 'Custom Metrics', value: 'customMetrics', description: 'Numbers from expressions' },
    ],
  },
  {
    name: 'expectedAnswer',
    displayName: 'Expected Answer',
    type: 'string',
    default: '',
    placeholder: '{{ $json.expected }}',
    hint: 'Empty: the test case’s expected-output column.',
    displayOptions: { show: metricsShow(EXPECTED_METRICS) },
  },
  {
    name: 'actualAnswer',
    displayName: 'Actual Answer',
    type: 'string',
    default: '',
    placeholder: '{{ $json.output }}',
    description: 'What the workflow produced',
    hint: 'Empty: the item’s output (AI Agent) or text (chains).',
    displayOptions: { show: metricsShow(ACTUAL_METRICS) },
  },
  {
    name: 'pattern',
    displayName: 'Regular Expression',
    type: 'string',
    default: '',
    placeholder: '^\\d{4}-\\d{2}-\\d{2}$',
    description: 'A pattern, or /pattern/flags',
    displayOptions: { show: metricsShow(['regex']) },
  },
  {
    name: 'tolerance',
    displayName: 'Tolerance',
    type: 'number',
    default: 0,
    typeOptions: { minValue: 0, numberPrecision: 4 },
    displayOptions: { show: metricsShow(['numericCloseness']) },
  },
  {
    name: 'toleranceType',
    displayName: 'Tolerance Type',
    type: 'options',
    default: 'absolute',
    noDataExpression: true,
    displayOptions: { show: metricsShow(['numericCloseness']) },
    options: [
      { name: 'Absolute', value: 'absolute', description: 'Allowed difference, e.g. 0.5' },
      { name: 'Relative', value: 'relative', description: 'Fraction of the expected value, e.g. 0.05 for 5%' },
    ],
  },
  { name: 'caseSensitive', displayName: 'Case Sensitive', type: 'boolean', default: false, displayOptions: { show: metricsShow(TEXT_METRICS) } },
  {
    name: 'expectedTools',
    displayName: 'Expected Tools',
    type: 'string',
    default: '',
    placeholder: 'calculator, search',
    hint: 'Comma-separated tool names. Empty: the test case’s expected-output column.',
    displayOptions: { show: metricsShow(['toolsUsed']) },
  },
  {
    name: 'toolsSource',
    displayName: 'Tools Called',
    type: 'options',
    default: 'execution',
    noDataExpression: true,
    displayOptions: { show: metricsShow(['toolsUsed']) },
    options: [
      { name: 'From This Execution', value: 'execution', description: 'Every tool an AI Agent called so far in the run' },
      { name: 'From an Expression', value: 'expression', description: 'A list of names, or an agent’s intermediate steps' },
    ],
  },
  {
    name: 'actualTools',
    displayName: 'Called Tools',
    type: 'string',
    default: '',
    placeholder: '{{ $json.steps }}',
    hint: 'Empty: the item’s steps (an AI Agent’s tool calls).',
    displayOptions: { show: { ...metricsShow(['toolsUsed']), toolsSource: ['expression'] } },
  },
  {
    name: 'userQuery',
    displayName: 'User Query',
    type: 'string',
    default: '',
    placeholder: '{{ $json.chatInput }}',
    hint: 'Empty: the test case’s input columns.',
    displayOptions: { show: metricsShow(JUDGE_METRICS) },
  },
  {
    name: 'context',
    displayName: 'Context',
    type: 'string',
    default: '',
    placeholder: '{{ $json.sourceDocuments }}',
    description: 'The passages the answer must be grounded in',
    displayOptions: { show: metricsShow(['faithfulness']) },
  },
  {
    name: 'prompt',
    displayName: 'Judge Instructions',
    type: 'string',
    default: '',
    typeOptions: { rows: 4 },
    hint: 'Empty: the built-in instructions of the metric. The 1–5 scale and the JSON reply format are always added.',
    displayOptions: { show: metricsShow(JUDGE_METRICS) },
  },
  nameValueCollection('metrics', 'Metrics', 'values', 'Metric', '{{ $json.output.length < 500 ? 1 : 0 }}', metricsShow(['customMetrics'])),
  {
    name: 'metricName',
    displayName: 'Metric Name',
    type: 'string',
    default: '',
    noDataExpression: true,
    hint: 'Empty: the metric’s own name (e.g. correctness).',
    displayOptions: { show: { operation: ['setMetrics'], metric: ACTUAL_METRICS.concat('toolsUsed') } },
  },
];

const keyOf = (value: string) => value.trim();

/** Names of the tools AI Agents called in an execution so far: tool sub-node runs and agents' intermediate steps. */
export async function toolsCalledIn(executionId: string): Promise<string[]> {
  const { liveExecution } = await import('../runner');
  const record = liveExecution(executionId);
  if (!record) return [];
  const names = new Set<string>();
  const nodeNames = new Map((record.workflow?.nodes ?? []).map((node) => [node.id, node.name]));
  for (const [nodeId, runs] of Object.entries(record.runData)) {
    for (const run of runs) {
      if (run.source === 'tool') names.add(record.nodeNames?.[nodeId] ?? nodeNames.get(nodeId) ?? nodeId);
      for (const output of run.outputs ?? []) for (const item of output ?? []) if (Array.isArray(item.json?.steps)) for (const name of namesOf(item.json.steps)) names.add(name);
    }
  }
  return [...names];
}

interface Scored {
  value: number;
  reasoning?: string;
}

async function scoreItem(ctx: IExecuteContext, i: number, metric: MetricKind, defaults: CaseDefaults, judgeModel: () => Promise<LanguageModel>): Promise<Scored> {
  const param = <T>(name: string, fallback: T) => (ctx.getNodeParameter<T>(name, i, fallback) ?? fallback) as T;
  const blank = (value: unknown) => value === undefined || value === null || value === '';
  const expected = () => {
    const value = param<unknown>('expectedAnswer', '');
    return blank(value) ? defaults.expected : value;
  };
  // Not set (a node saved without its defaults): the item's `output` (AI Agent) or `text` (chains).
  const actual = () => {
    const value = param<unknown>('actualAnswer', '');
    if (!blank(value)) return value;
    const json = ctx.getInputData()[i]?.json ?? {};
    return json.output ?? json.text ?? '';
  };
  const text = { caseSensitive: Boolean(param('caseSensitive', false)) };
  switch (metric) {
    case 'exactMatch':
      return { value: exactMatch(expected(), actual(), text) };
    case 'contains':
      return { value: contains(expected(), actual(), text) };
    case 'regex': {
      const pattern = String(param('pattern', '') ?? '');
      if (!pattern.trim()) throw new NodeOperationError('Set the regular expression', { itemIndex: i });
      try {
        return { value: regexMatch(pattern, actual(), text.caseSensitive) };
      } catch (error) {
        throw new NodeOperationError(`Invalid regular expression: ${(error as Error).message}`, { itemIndex: i });
      }
    }
    case 'jsonEquality':
      return { value: jsonEquality(expected(), actual()) };
    case 'numericCloseness': {
      const [e, a] = [expected(), actual()];
      if (toNumber(e) === undefined) throw new NodeOperationError(`The expected answer “${asText(e).slice(0, 80)}” has no number`, { itemIndex: i });
      return { value: numericCloseness(e, a, { tolerance: Number(param('tolerance', 0)), relative: param<string>('toleranceType', 'absolute') === 'relative' }) };
    }
    case 'stringSimilarity':
      return { value: stringSimilarity(expected(), actual(), text) };
    case 'toolsUsed': {
      const wanted = param<unknown>('expectedTools', '');
      const listed = param<unknown>('actualTools', '');
      const called =
        param<string>('toolsSource', 'execution') === 'expression' ? namesOf(blank(listed) ? (ctx.getInputData()[i]?.json.steps ?? []) : listed) : await toolsCalledIn(ctx.getExecutionId());
      return { value: toolsUsed(blank(wanted) ? defaults.expected : wanted, called) };
    }
    case 'correctness':
    case 'helpfulness':
    case 'faithfulness': {
      const query = param<unknown>('userQuery', '');
      const result = await judge(
        await judgeModel(),
        metric as JudgeMetric,
        {
          question: asText(blank(query) ? defaults.question : query),
          expected: expected(),
          actual: actual(),
          ...(metric === 'faithfulness' && { context: param<unknown>('context', '') }),
          instructions: String(param('prompt', '') ?? ''),
        },
        ctx.signal,
      );
      return { value: result.score, reasoning: result.reasoning };
    }
    default:
      throw new NodeOperationError(`Unknown metric "${metric}"`);
  }
}

interface CaseDefaults {
  expected?: unknown;
  question?: unknown;
}

/** What metrics fall back to inside an evaluation run: the case's expected output and inputs. */
async function caseDefaults(evaluation: EvaluationRef | undefined): Promise<CaseDefaults> {
  const testCase = evaluation && getCase(evaluation.runId, evaluation.caseIndex);
  if (!testCase) return {};
  const values = Object.values(testCase.inputs);
  return { expected: testCase.expected, question: values.length === 1 ? values[0] : testCase.inputs };
}

const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;

/** Add a column for each output the row doesn't have yet (typed after the value), then write the values. */
function writeRow(tableId: string, rowId: number, values: Record<string, unknown>) {
  const service = dataTables();
  const table = service.getTable(tableId);
  const cells: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(values)) {
    const cell = value !== null && typeof value === 'object' ? JSON.stringify(value) : value;
    if (!table.columns.some((column) => column.name === name)) service.addColumn(tableId, { name, type: typeof cell === 'number' ? 'number' : typeof cell === 'boolean' ? 'boolean' : 'string' });
    cells[name] = cell;
  }
  service.updateRow(tableId, rowId, cells);
}

export const evaluationNode = defineNode({
  description: {
    name: 'evaluation',
    displayName: 'Evaluation',
    description: 'Record outputs and metrics of an evaluation run, or branch on whether the workflow is being evaluated',
    version: 1,
    kind: 'action',
    categories: ['AI', 'Evaluation'],
    icon: 'lucide:clipboard-check',
    color: COLOR,
    subtitle: '{{operation}}',
    keywords: ['evaluation', 'eval', 'metric', 'score', 'llm as judge', 'correctness', 'helpfulness', 'faithfulness', 'exact match', 'similarity', 'test'],
    inputs: [
      { type: 'main' },
      { type: 'ai_languageModel', displayName: 'Chat Model', maxConnections: 1, displayOptions: { show: metricsShow(JUDGE_METRICS) } },
    ],
    outputs: [
      { type: 'main', displayName: 'Evaluation' },
      { type: 'main', displayName: 'Normal', displayOptions: { show: { operation: ['checkIfEvaluating'] } } },
    ],
    properties,
  },

  async execute(ctx) {
    const operation = ctx.getNodeParameter<string>('operation', 0, 'setOutputs');
    const items = ctx.getInputData();
    const evaluation = await evaluationOf(ctx);

    if (operation === 'checkIfEvaluating') return evaluation ? [items, []] : [[], items];

    if (operation === 'setOutputs') {
      const collected: Record<string, unknown[]> = {};
      items.forEach((_item, i) => {
        for (const pair of ctx.getNodeParameter<{ values?: Array<{ name?: string; value?: unknown }> }>('outputs', i)?.values ?? []) {
          const name = keyOf(String(pair.name ?? ''));
          if (name) (collected[name] ??= []).push(pair.value ?? null);
        }
      });
      // One item: its values; several: a list per output.
      const outputs = Object.fromEntries(Object.entries(collected).map(([name, values]) => [name, values.length === 1 ? values[0] : values]));
      if (evaluation && Object.keys(outputs).length) {
        updateCase(evaluation.runId, evaluation.caseIndex, (current) => ({ ...current, outputs: { ...current.outputs, ...outputs } }));
        const run = getRun(evaluation.runId);
        if (ctx.getNodeParameter<string>('destination', 0, 'run') === 'row' && run?.source === 'file') {
          throw new NodeOperationError('Outputs can only be written into rows of a Data Table', { description: 'This evaluation reads an uploaded file: set “Destination” to “Run”.' });
        }
        if (ctx.getNodeParameter<string>('destination', 0, 'run') === 'row' && run && evaluation.rowId !== undefined) {
          try {
            writeRow(run.dataTableId, evaluation.rowId, outputs);
          } catch (error) {
            throw new NodeOperationError(`Could not write the outputs into row ${evaluation.rowId}: ${(error as Error).message}`);
          }
        }
      }
      return [items];
    }

    if (operation !== 'setMetrics') throw new NodeOperationError(`Unknown operation "${operation}"`);
    const metric = ctx.getNodeParameter<MetricKind>('metric', 0, 'correctness');
    const defaults = await caseDefaults(evaluation);
    let model: LanguageModel | undefined;
    const judgeModel = async () => (model ??= await connectedModel(ctx, 'Evaluation node'));

    const scores: Record<string, number[]> = {};
    const reasons: Record<string, string> = {};
    const out: NodeItem[] = [];
    for (const [i, item] of items.entries()) {
      const metrics: Record<string, number> = {};
      if (metric === 'customMetrics') {
        for (const pair of ctx.getNodeParameter<{ values?: Array<{ name?: string; value?: unknown }> }>('metrics', i)?.values ?? []) {
          const name = keyOf(String(pair.name ?? ''));
          if (!name) continue;
          const value = typeof pair.value === 'boolean' ? Number(pair.value) : toNumber(pair.value);
          if (value === undefined) throw new NodeOperationError(`Metric “${name}” is not a number: ${asText(pair.value).slice(0, 80)}`, { itemIndex: i });
          metrics[name] = value;
        }
        if (!Object.keys(metrics).length) throw new NodeOperationError('Add at least one metric with a name', { itemIndex: i });
      } else {
        const name = keyOf(String(ctx.getNodeParameter('metricName', i, '') ?? '')) || metric;
        const scored = await scoreItem(ctx, i, metric, defaults, judgeModel);
        metrics[name] = scored.value;
        if (scored.reasoning) reasons[name] = scored.reasoning;
      }
      for (const [name, value] of Object.entries(metrics)) (scores[name] ??= []).push(value);
      const extra: Record<string, JsonValue> = { ...metrics };
      for (const [name, reasoning] of Object.entries(reasons)) extra[`${name}Reasoning`] = reasoning;
      out.push({ ...item, json: { ...item.json, ...extra } as JsonObject, pairedItem: { item: i } });
    }

    if (evaluation) {
      const means = Object.fromEntries(Object.entries(scores).map(([name, values]) => [name, mean(values)]));
      updateCase(evaluation.runId, evaluation.caseIndex, (current) => ({
        ...current,
        metrics: { ...current.metrics, ...means },
        ...(Object.keys(reasons).length && { reasons: { ...current.reasons, ...reasons } }),
      }));
    }
    return [out];
  },
});
