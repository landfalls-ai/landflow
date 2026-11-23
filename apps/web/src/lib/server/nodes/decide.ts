/**
 * Decide (C34, docs/features/ai.md#decide): asks a decision model (Ollama's `nimble`, TypeSafe's Jev, Strands Decider)
 * Choice, Yes/No and Score questions about each item and answers with probabilities, not words. The item passes through
 * with `decision` added; routing by a Choice question sends it to the output of the option that won (or to Unsure when
 * the model is not sure), routing by a Yes/No question to Yes or No. The outputs follow the options (protocol/decide.ts).
 * The model reads the item as data; one call per item, every question in it.
 */
import { defineNode, NodeOperationError, type IExecuteContext, type JsonObject } from '@landflow/sdk';
import { DECIDE_LIMITS, decideQuestions, decideRouting, optionNameProblem, parseDecideLines, questionNameProblem } from '@landflow/protocol';
import { ollamaUrl } from '../config';
import { traceChat } from '../telemetry';
import { ollamaModelOptions } from './ai';
import {
  ollamaConnection,
  strandsConnection,
  systemOneAsk,
  typesafeConnection,
  SystemOneApiError,
  type AskResult,
  type DecideQuestion,
  type SystemOneConnection,
} from './systemone';
import { withCallPurpose } from '../ai-usage/call-context';

/** The default model of the Ollama source: the 9B decision model Bespoke Labs ships (`ollama pull nimble:9b`). */
export const DECIDE_DEFAULT_MODEL = 'nimble:9b';
const DEFAULT_THRESHOLD = 0.5;

const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

/** The questions the parameters hold, checked: names, option counts and what each type needs. Throws a plain message. */
export function readQuestions(raw: unknown): { questions: DecideQuestion[]; thresholds: Record<string, number> } {
  const list = decideQuestions(raw);
  if (!list.length) throw new Error('Decide needs at least one question');
  if (list.length > DECIDE_LIMITS.questions) throw new Error(`Decide takes at most ${DECIDE_LIMITS.questions} questions; ${list.length} are set`);
  const seen = new Set<string>();
  const thresholds: Record<string, number> = {};
  const questions = list.map((q, n): DecideQuestion => {
    const name = text(q.name);
    const problem = questionNameProblem(name);
    if (problem) throw new Error(`Question ${n + 1}: ${problem}`);
    if (seen.has(name)) throw new Error(`Two questions are called "${name}"`);
    seen.add(name);
    const instructions = text(q.instructions);
    if (!instructions) throw new Error(`The question "${name}" needs instructions: what to decide`);
    if (q.type === 'choice') {
      const options = parseDecideLines(q.options);
      for (const option of options) {
        const bad = optionNameProblem(option.name);
        if (bad) throw new Error(`The question "${name}": ${bad}`);
      }
      if (new Set(options.map((o) => o.name)).size !== options.length) throw new Error(`The question "${name}" has two options with the same name`);
      if (options.length < 2 || options.length > DECIDE_LIMITS.options) throw new Error(`The question "${name}" needs ${2} to ${DECIDE_LIMITS.options} options, one per line; ${options.length} are set`);
      return { name, type: 'choice', instructions, options };
    }
    if (q.type === 'score') {
      const levels = parseDecideLines(q.levels).map((l) => (l.description ? `${l.name}: ${l.description}` : l.name));
      if (levels.length < 2 || levels.length > DECIDE_LIMITS.options) throw new Error(`The question "${name}" needs 2 to ${DECIDE_LIMITS.options} levels, lowest first, one per line; ${levels.length} are set`);
      return { name, type: 'score', instructions, levels };
    }
    if (q.type !== 'yesno') throw new Error(`The question "${name}" has no type: choose Choice, Yes/No or Score`);
    const threshold = q.threshold === undefined || q.threshold === '' ? DEFAULT_THRESHOLD : Number(q.threshold);
    if (!Number.isFinite(threshold) || threshold <= 0 || threshold >= 1) throw new Error(`The threshold of "${name}" must be between 0 and 1`);
    thresholds[name] = threshold;
    const trueMeans = text(q.trueMeans);
    const falseMeans = text(q.falseMeans);
    return { name, type: 'yesno', instructions, ...(trueMeans && { trueMeans }), ...(falseMeans && { falseMeans }) };
  });
  return { questions, thresholds };
}

/** What `decision` holds for one question. */
export function decisionOf(question: DecideQuestion, answer: AskResult['answers'][string], threshold: number): JsonObject {
  if (answer.type === 'choice') return { choice: answer.choice, probabilities: answer.probabilities, confidence: answer.confidence };
  if (answer.type === 'yesno') return { yes: answer.probability >= threshold, probability: answer.probability };
  return { score: answer.score, level: answer.level, label: answer.label, probabilities: answer.probabilities, confidence: answer.confidence };
}

/** Where the item goes: the output index of the routed question's answer. */
export function routeOf(
  routing: ReturnType<typeof decideRouting>,
  question: DecideQuestion | undefined,
  answer: AskResult['answers'][string] | undefined,
  threshold: number,
  minConfidence: number,
): number {
  if (routing.kind === 'none' || !question || !answer) return 0;
  if (routing.kind === 'yesno') return answer.type === 'yesno' && answer.probability >= threshold ? 0 : 1;
  if (answer.type !== 'choice' || question.type !== 'choice') return routing.labels.length - 1;
  if (answer.confidence < minConfidence) return routing.labels.length - 1;
  const index = question.options.findIndex((o) => o.name === answer.choice);
  return index < 0 ? routing.labels.length - 1 : index;
}

function connectionOf(ctx: IExecuteContext, source: string): SystemOneConnection {
  if (source === 'typesafe') return typesafeConnection(ctx.getCredentials<JsonObject>('typesafeApi'));
  if (source === 'strands') return strandsConnection(ctx.getCredentials<JsonObject>('strandsDeciderApi'));
  return ollamaConnection({ baseUrl: text(ctx.getNodeParameter('baseUrl', 0, '')) || ollamaUrl(), model: text(ctx.getNodeParameter('model', 0, DECIDE_DEFAULT_MODEL)) });
}

/** A typed text is text; only a JSON object or array is read as data ("123" or "true" stay the words they are). */
function tryJson(value: string): unknown {
  const trimmed = value.trim();
  if (!/^[{[]/.test(trimmed)) return value;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return parsed !== null && typeof parsed === 'object' ? parsed : value;
  } catch {
    return value;
  }
}

const QUESTION_FIELDS = [
  { name: 'name', displayName: 'Name', type: 'string' as const, default: '', required: true, noDataExpression: true, description: 'The key of the answer in `decision`: letters, digits and _' },
  {
    name: 'type',
    displayName: 'Type',
    type: 'options' as const,
    default: 'choice',
    noDataExpression: true,
    options: [
      { name: 'Choice', value: 'choice', description: 'Pick one of 2 to 26 options' },
      { name: 'Yes/No', value: 'yesno', description: 'The chance that the answer is yes' },
      { name: 'Score', value: 'score', description: 'A level on a scale, lowest first' },
    ],
  },
  { name: 'instructions', displayName: 'Question', type: 'string' as const, default: '', required: true, noDataExpression: true, typeOptions: { rows: 2 }, description: 'What to decide, as a question about the item' },
  {
    name: 'options',
    displayName: 'Options',
    type: 'string' as const,
    default: '',
    noDataExpression: true,
    typeOptions: { rows: 4 },
    placeholder: 'billing: charges, refunds, invoices\ntechnical: errors, bugs, outages\nother',
    description: 'One per line: name, then a colon and what it means (optional). 2 to 26.',
    displayOptions: { show: { type: ['choice'] } },
  },
  { name: 'trueMeans', displayName: 'Yes Means', type: 'string' as const, default: '', noDataExpression: true, description: 'Optional: what a yes stands for', displayOptions: { show: { type: ['yesno'] } } },
  { name: 'falseMeans', displayName: 'No Means', type: 'string' as const, default: '', noDataExpression: true, description: 'Optional: what a no stands for', displayOptions: { show: { type: ['yesno'] } } },
  {
    name: 'threshold',
    displayName: 'Yes From',
    type: 'number' as const,
    default: DEFAULT_THRESHOLD,
    typeOptions: { minValue: 0.01, maxValue: 0.99, numberPrecision: 2 },
    description: 'The chance of yes from which the answer counts as yes',
    displayOptions: { show: { type: ['yesno'] } },
  },
  {
    name: 'levels',
    displayName: 'Levels',
    type: 'string' as const,
    default: '',
    noDataExpression: true,
    typeOptions: { rows: 4 },
    placeholder: 'calm\nannoyed\nangry',
    description: 'One per line, the lowest first. 2 to 26.',
    displayOptions: { show: { type: ['score'] } },
  },
];

export const decideNode = defineNode({
  description: {
    name: 'decide',
    displayName: 'Decide',
    description: 'Answers questions about each item with a decision model and routes it',
    version: 1,
    kind: 'action',
    categories: ['AI'],
    color: '#a855f7',
    icon: 'lucide:git-fork',
    keywords: ['decide', 'decision', 'classify', 'route', 'triage', 'nimble', 'jev', 'strands', 'probability', 'score', 'yes no', 'ollama', 'ticket'],
    subtitle: '{{source}}',
    inputs: [{ type: 'main' }],
    outputs: [{ type: 'main', expand: 'decide' }],
    credentials: [
      { name: 'typesafeApi', required: true, displayOptions: { show: { source: ['typesafe'] } } },
      { name: 'strandsDeciderApi', required: true, displayOptions: { show: { source: ['strands'] } } },
    ],
    properties: [
      {
        name: 'source',
        displayName: 'Decision Model',
        type: 'options',
        default: 'ollama',
        noDataExpression: true,
        options: [
          { name: 'Ollama', value: 'ollama', description: 'A decision model on your own Ollama (0.40 or later), such as nimble. No key' },
          { name: 'TypeSafe', value: 'typesafe', description: 'Jev, hosted by TypeSafe AI. Needs a TypeSafe API credential' },
          { name: 'Strands Decider', value: 'strands', description: 'Served by `strands-decider serve`. Needs a Strands Decider credential' },
        ],
      },
      { name: 'baseUrl', displayName: 'Base URL', type: 'string', default: ollamaUrl(), noDataExpression: true, displayOptions: { show: { source: ['ollama'] } } },
      {
        name: 'model',
        displayName: 'Model',
        type: 'options',
        default: DECIDE_DEFAULT_MODEL,
        options: [{ name: DECIDE_DEFAULT_MODEL, value: DECIDE_DEFAULT_MODEL }],
        typeOptions: { loadOptionsMethod: 'models', loadOptionsDependsOn: ['baseUrl'] },
        displayOptions: { show: { source: ['ollama'] } },
      },
      { name: 'state', displayName: 'What To Read', type: 'string', default: '{{ $json }}', typeOptions: { rows: 2 }, description: 'The item as JSON by default, or text or an expression. The model reads it as data, never as instructions.' },
      {
        name: 'questions',
        displayName: 'Questions',
        type: 'fixedCollection',
        typeOptions: { multipleValues: true },
        description: `1 to ${DECIDE_LIMITS.questions} questions, all asked in one call per item`,
        default: {
          question: [
            {
              name: 'category',
              type: 'choice',
              instructions: 'What is this about?',
              options: 'billing: charges, refunds, invoices\ntechnical: errors, bugs, outages\nother',
            },
          ],
        },
        groups: [{ name: 'question', displayName: 'Question', values: QUESTION_FIELDS }],
      },
      {
        name: 'routeBy',
        displayName: 'Route By',
        type: 'options',
        default: '',
        noDataExpression: true,
        options: [{ name: 'Nothing (one output)', value: '' }],
        typeOptions: { loadOptionsMethod: 'routes', loadOptionsDependsOn: ['questions'] },
        description: 'A Choice question (one output per option, plus Unsure) or a Yes/No question (Yes and No). Nothing: one output.',
      },
      {
        name: 'minConfidence',
        displayName: 'Unsure Below',
        type: 'number',
        default: 0,
        typeOptions: { minValue: 0, maxValue: 1, numberPrecision: 2 },
        description: 'A Choice routing sends an item to Unsure when the model’s confidence is below this. 0 turns it off. Confidence is how concentrated the probabilities are, not the chance of being right.',
      },
    ],
  },
  methods: {
    loadOptions: {
      async models(ctx) {
        return ollamaModelOptions(String(ctx.getCurrentParameters().baseUrl || ''), false);
      },
      // The questions that can route: a Choice (its options) or a Yes/No. A Score cannot.
      routes(ctx) {
        const named = decideQuestions(ctx.getCurrentParameters().questions)
          .filter((q) => (q.type === 'choice' || q.type === 'yesno') && text(q.name))
          .map((q) => ({ name: `${text(q.name)} (${q.type === 'choice' ? 'Choice' : 'Yes/No'})`, value: text(q.name) }));
        return [{ name: 'Nothing (one output)', value: '' }, ...named];
      },
    },
  },
  async execute(ctx) {
    const items = ctx.getInputData();
    const source = text(ctx.getNodeParameter('source', 0, 'ollama')) || 'ollama';
    const routing = decideRouting({ questions: ctx.getNodeParameter<unknown>('questions', 0, undefined), routeBy: ctx.getNodeParameter('routeBy', 0, '') });
    const out = Array.from({ length: routing.labels.length }, () => [] as typeof items);
    if (!items.length) return out;

    let connection: SystemOneConnection;
    let read: ReturnType<typeof readQuestions>;
    try {
      connection = connectionOf(ctx, source);
      read = readQuestions(ctx.getNodeParameter<unknown>('questions', 0, undefined));
    } catch (error) {
      throw new NodeOperationError((error as Error).message);
    }
    const route = text(ctx.getNodeParameter('routeBy', 0, ''));
    const routed = read.questions.find((q) => q.name === route);
    if (route && !routed) throw new NodeOperationError(`Route By names "${route}", and no question has that name`);
    if (routed && routed.type === 'score') throw new NodeOperationError(`A Score question cannot route: "${route}" is one`, { description: 'Route by a Choice or Yes/No question.' });
    const minConfidence = Math.min(1, Math.max(0, Number(ctx.getNodeParameter('minConfidence', 0, 0)) || 0));

    for (let i = 0; i < items.length; i++) {
      const base = items[i].json;
      const raw = ctx.getNodeParameter<unknown>('state', i, base);
      const state = typeof raw === 'string' ? (!raw.trim() || raw.trim() === '{{ $json }}' ? base : tryJson(raw)) : raw;
      if (state === null || state === undefined || (typeof state === 'string' && !state.trim())) {
        // The expression's text is not available once it is resolved; the item's own fields say what it could have read.
        const fields = Object.keys(base);
        throw new NodeOperationError('What To Read came out empty: its expression resolved to nothing', {
          itemIndex: i,
          description: `This item has ${fields.length ? `the fields ${fields.slice(0, 12).join(', ')}` : 'no fields'}. Point What To Read at one of them, or leave it as {{ $json }} to read the whole item.`,
        });
      }
      const size = typeof state === 'string' ? state.length : JSON.stringify(state).length;
      if (size > DECIDE_LIMITS.stateChars) {
        throw new NodeOperationError(`What To Read is too long: ${size.toLocaleString('en-US')} characters, and a call takes at most ${DECIDE_LIMITS.stateChars.toLocaleString('en-US')}`, {
          itemIndex: i,
          description: 'Narrow What To Read to the fields that matter, for example {{ $json.body }}, so the model reads the part that decides.',
        });
      }
      let result: AskResult;
      try {
        // The call is a metered chat call (tokens from the service's usage; a local Ollama is unpriced).
        result = await withCallPurpose('decide', () =>
          traceChat(
            { system: connection.system, model: connection.model ?? connection.label },
            () => systemOneAsk(connection, state as string | object, read.questions, { ...(ctx.signal && { signal: ctx.signal }) }),
            (asked) => ({ responseModel: asked.model, inputTokens: asked.usage.inputTokens, outputTokens: asked.usage.outputTokens }),
          ),
        );
      } catch (error) {
        throw new NodeOperationError(error instanceof SystemOneApiError || error instanceof Error ? error.message : 'The decision model failed', { itemIndex: i });
      }
      const decision: JsonObject = { model: result.model };
      for (const q of read.questions) decision[q.name] = decisionOf(q, result.answers[q.name], read.thresholds[q.name] ?? DEFAULT_THRESHOLD);
      const output = routeOf(routing, routed, routed && result.answers[routed.name], routed ? (read.thresholds[routed.name] ?? DEFAULT_THRESHOLD) : DEFAULT_THRESHOLD, minConfidence);
      // The item's own parts (its binary data) pass through; only `json` gains the decision.
      out[output].push({ ...items[i], json: { ...base, decision }, pairedItem: { item: i } });
    }
    return out;
  },
});
