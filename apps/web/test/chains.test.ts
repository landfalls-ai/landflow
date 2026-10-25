import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defineNode } from '@landflow/sdk';
import type { ExecutionResult, LanguageModel } from '@landflow/engine';
import { attributesSchema, CLASSIFIER_OUTPUTS, textClassifierNode } from '@/lib/server/nodes/chains';
import type { GenerateInput } from '@/lib/server/nodes/models';
import { parseJsonReply, validateSchema } from '@/lib/server/nodes/structured';
import { startFakeOpenAi, type FakeServer } from './fake-openai';
import { outputsOf, runFlow, type FlowEdge, type FlowNode } from './helpers';

type Reply = string | ((input: GenerateInput) => string);

/** A chat model sub-node that answers from a script and records what it was asked. */
function scriptedModel(replies: Reply[]) {
  const calls: GenerateInput[] = [];
  const node = defineNode({
    description: {
      name: 'scripted',
      displayName: 'Scripted Model',
      description: 'Replies from a script',
      version: 1,
      kind: 'subnode',
      supplies: 'ai_languageModel',
      categories: ['AI'],
      inputs: [],
      outputs: [{ type: 'ai_languageModel', displayName: 'Model' }],
      properties: [],
    },
    supplyData: (): LanguageModel => ({
      provider: 'test',
      model: 'scripted',
      async generate(input) {
        calls.push({ ...input, messages: [...input.messages] });
        const next = replies.shift();
        if (next === undefined) throw new Error('No scripted reply left');
        return { text: typeof next === 'function' ? next(input) : next, toolCalls: [], stopReason: 'stop' };
      },
    }),
  });
  return { node, calls };
}

/** Root node "Root" fed by Start, with the scripted model on its Chat Model port. */
async function chain(
  type: string,
  parameters: Record<string, unknown>,
  replies: Reply[],
  input: Array<Record<string, unknown>> = [{}],
  more: { nodes?: FlowNode[]; edges?: FlowEdge[] } = {},
) {
  const model = scriptedModel(replies);
  const result = await runFlow(
    [{ name: 'Root', type, parameters }, { name: 'Model', type: 'test.scripted' }, ...(more.nodes ?? [])],
    [['Start', 'Root'], ['Model', 'Root', 'ai_languageModel'], ...(more.edges ?? [])],
    { input, extra: { scripted: model.node } },
  );
  return { result, calls: model.calls, outputs: () => outputsOf(result, 'Root') };
}

const failure = (result: ExecutionResult, name = 'Root') => (result.runData[name] ?? []).filter((run) => run.source === 'main').at(-1)?.error;
const userText = (input: GenerateInput, index = 0) => (input.messages[index] as { content: string }).content;

describe('structured output helpers', () => {
  it('validates the JSON Schema subset with paths', () => {
    const schema = {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 2 },
        age: { type: 'integer', minimum: 0 },
        tags: { type: 'array', items: { enum: ['a', 'b'] }, maxItems: 2 },
        when: { type: ['string', 'null'], format: 'date' },
        kind: { anyOf: [{ const: 'x' }, { type: 'number' }] },
      },
      required: ['name'],
      additionalProperties: false,
    };
    expect(validateSchema({ name: 'Al', age: 3, tags: ['a'], when: null, kind: 2 }, schema)).toEqual([]);
    expect(validateSchema({ age: 1.5, tags: ['a', 'c', 'b'], when: 'soon', kind: 'y', extra: 1 }, schema)).toEqual([
      '$.name: is required',
      '$.age: expected integer, got number',
      '$.tags: more than 2 items',
      '$.tags[1]: must be one of "a", "b"',
      '$.when: not a valid date',
      '$.kind: matches none of the allowed shapes',
      '$.extra: is not allowed',
    ]);
    expect(validateSchema('x', { type: 'object' })).toEqual(['$: expected object, got string']);
  });

  it('reads JSON from model replies', () => {
    expect(parseJsonReply('{"a": 1}')).toEqual({ a: 1 });
    expect(parseJsonReply('<think>let me see {x}</think>\n```json\n{"a": [1, 2]}\n```')).toEqual({ a: [1, 2] });
    expect(parseJsonReply('Sure! Here it is: {"a": {"b": true}} Hope that helps.')).toEqual({ a: { b: true } });
    expect(parseJsonReply('The list: ["x", "y"]')).toEqual(['x', 'y']);
    expect(() => parseJsonReply('no json here')).toThrow('the reply is not valid JSON');
    expect(() => parseJsonReply('<think>hmm</think>')).toThrow('the reply is empty');
  });

  it('builds an object schema from attributes; optional ones may be null', () => {
    expect(
      attributesSchema([
        { name: 'company', type: 'string', required: true, description: 'Company name' },
        { name: 'due', type: 'date' },
        { name: ' ', type: 'number' },
      ]),
    ).toEqual({
      type: 'object',
      properties: {
        company: { type: 'string', description: 'Company name' },
        due: { type: ['string', 'null'], description: 'An ISO 8601 date, e.g. 2026-10-25.', format: 'date' },
      },
      required: ['company'],
      additionalProperties: false,
    });
    expect(() => attributesSchema([{ name: '' }])).toThrow('No attributes');
  });
});

describe('Basic LLM Chain', () => {
  it('sends the prompt per item and returns the text', async () => {
    const { calls, outputs } = await chain(
      'core.chainLlm',
      { prompt: '{{ $json.chatInput }}', systemMessage: 'Be terse' },
      ['Hello!', 'Goodbye!'],
      [{ chatInput: 'Hi' }, { chatInput: 'Bye' }],
    );
    expect(outputs()[0]).toEqual([{ text: 'Hello!' }, { text: 'Goodbye!' }]);
    expect(calls.map((call) => [call.system, userText(call), call.responseFormat])).toEqual([
      ['Be terse', 'Hi', undefined],
      ['Be terse', 'Bye', undefined],
    ]);
  });

  it('validates JSON against the schema and retries once with the errors', async () => {
    const schema = { type: 'object', properties: { answer: { type: 'string' }, confidence: { type: 'number', maximum: 1 } }, required: ['answer'] };
    const { calls, outputs } = await chain('core.chainLlm', { prompt: 'Why?', hasOutputParser: true, jsonSchema: JSON.stringify(schema) }, [
      '```json\n{"answer": 42}\n```',
      '{"answer": "Because", "confidence": 0.9}',
    ]);
    expect(outputs()[0]).toEqual([{ answer: 'Because', confidence: 0.9 }]);
    expect(calls).toHaveLength(2);
    expect(calls[0].responseFormat).toBe('json');
    expect(calls[0].system).toContain('Answer with a single JSON value that matches this JSON Schema');
    expect(calls[1].messages).toHaveLength(3);
    expect(userText(calls[1], 2)).toContain('$.answer: expected string, got number');
  });

  it('fails after a second invalid reply, and wraps non-object values', async () => {
    const bad = await chain('core.chainLlm', { prompt: 'Why?', hasOutputParser: true, jsonSchema: '{"type":"object","required":["answer"]}' }, [
      '{}',
      'still no',
    ]);
    expect(failure(bad.result)).toMatchObject({
      message: 'The model’s reply did not match the required format',
      description: expect.stringContaining('the reply is not valid JSON'),
    });

    const list = await chain('core.chainLlm', { prompt: 'Name two', hasOutputParser: true, jsonSchema: '{"type":"array","items":{"type":"string"}}' }, [
      '["a", "b"]',
    ]);
    expect(list.outputs()[0]).toEqual([{ output: ['a', 'b'] }]);
    expect(list.calls[0].responseFormat).toBeUndefined();
  });

  it('reports a missing model, an empty prompt and a broken schema', async () => {
    const lonely = await runFlow([{ name: 'Root', type: 'core.chainLlm', parameters: { prompt: 'hi' } }], [['Start', 'Root']]);
    expect(lonely.error?.message ?? failure(lonely)?.message).toMatch(/chat model/i);
    expect(failure((await chain('core.chainLlm', { prompt: '{{ $json.missing }}' }, [])).result)?.message).toBe('Prompt is empty');
    expect(failure((await chain('core.chainLlm', { prompt: 'hi', hasOutputParser: true, jsonSchema: '{nope' }, [])).result)?.message).toBe(
      'JSON Schema is not valid JSON',
    );
  });
});

describe('Text Classifier', () => {
  const categories = { categories: [{ category: 'positive', description: 'Praise' }, { category: 'negative' }, { category: 'question' }] };
  const answer = (positive: boolean, negative: boolean, question: boolean) => JSON.stringify({ positive, negative, question });
  const texts = [{ text: 'Love it' }, { text: 'Broken again' }, { text: 'The sky is blue' }, { text: 'How do I reset it?' }];

  it('has one output per category slot plus Other', () => {
    expect(textClassifierNode.description.outputs.map((output) => output.displayName)).toEqual(['0', '1', '2', '3', 'Other']);
    expect(CLASSIFIER_OUTPUTS).toBe(4);
  });

  it('routes each item, unchanged, to its category output; no match goes to Other', async () => {
    const { calls, outputs } = await chain(
      'core.textClassifier',
      { inputText: '{{ $json.text }}', categories, options: { fallback: 'other' } },
      [answer(true, false, false), answer(false, true, false), answer(false, false, false), answer(false, false, true)],
      texts,
    );
    expect(outputs()).toEqual([[texts[0]], [texts[1]], [texts[3]], [], [texts[2]]]);
    expect(userText(calls[1])).toBe('Broken again');
    expect(calls[0].responseFormat).toBe('json');
    expect(calls[0].system).toContain('into one of the following categories: positive, negative, question');
    expect(calls[0].system).toContain('or all of them to false when none fits');
    expect(calls[0].system).toContain('"positive": {\n      "type": "boolean",\n      "description": "true if the text is “positive”: Praise"');
  });

  it('discards unmatched items by default and can send one item to several outputs', async () => {
    const discard = await chain('core.textClassifier', { categories }, [answer(false, false, false)], [texts[2]]);
    expect(discard.outputs().every((branch) => branch.length === 0)).toBe(true);
    const multi = await chain('core.textClassifier', { categories, options: { multiClass: true } }, [answer(false, true, true)], [texts[3]]);
    expect(multi.outputs()).toEqual([[], [texts[3]], [texts[3]], [], []]);
    expect(multi.calls[0].system).toContain('Set every category that applies to true');
  });

  it('retries when several categories are true in single-class mode, then takes the first', async () => {
    const fixed = await chain('core.textClassifier', { categories }, [answer(true, true, false), answer(false, true, false)], [texts[1]]);
    expect(fixed.outputs()[1]).toEqual([texts[1]]);
    expect(userText(fixed.calls[1], 2)).toContain('only one category may be true, got positive, negative');
    const stubborn = await chain('core.textClassifier', { categories }, [answer(true, true, false), answer(true, true, false)], [texts[1]]);
    expect(stubborn.outputs().map((branch) => branch.length)).toEqual([1, 0, 0, 0, 0]);
  });

  it('feeds downstream nodes from the category outputs', async () => {
    const { result } = await chain(
      'core.textClassifier',
      { categories, options: { fallback: 'other' } },
      [answer(false, true, false), answer(false, false, false)],
      [texts[1], texts[2]],
      {
        nodes: [
          { name: 'Complaints', type: 'core.noOp' },
          { name: 'Rest', type: 'core.noOp' },
        ],
        edges: [
          ['Root', 'Complaints', 'main', 1],
          ['Root', 'Rest', 'main', CLASSIFIER_OUTPUTS],
        ],
      },
    );
    expect(outputsOf(result, 'Complaints')[0]).toEqual([texts[1]]);
    expect(outputsOf(result, 'Rest')[0]).toEqual([texts[2]]);
  });

  it('rejects too many, duplicate or missing categories', async () => {
    const five = { categories: ['a', 'b', 'c', 'd', 'e'].map((category) => ({ category })) };
    expect(failure((await chain('core.textClassifier', { categories: five }, [])).result)?.message).toBe(
      'Text Classifier has 4 category outputs, but 5 categories are set',
    );
    expect(failure((await chain('core.textClassifier', { categories: { categories: [{ category: 'a' }, { category: 'a' }] } }, [])).result)?.message).toBe(
      'Category “a” is listed twice',
    );
    expect(failure((await chain('core.textClassifier', { categories: { categories: [] } }, [])).result)?.message).toBe('No categories');
  });
});

describe('Information Extractor', () => {
  it('extracts attributes into the item JSON', async () => {
    const attributes = {
      attributes: [
        { name: 'company', type: 'string', required: true },
        { name: 'amount', type: 'number' },
        { name: 'due', type: 'date' },
        { name: 'paid', type: 'boolean' },
      ],
    };
    const { calls, outputs } = await chain(
      'core.informationExtractor',
      { text: '{{ $json.text }}', attributes },
      ['<think>An invoice.</think>{"company": "Acme", "amount": 120.5, "due": "2026-11-01", "paid": null}'],
      [{ text: 'Acme invoice: $120.50 due Nov 1st' }],
    );
    expect(outputs()[0]).toEqual([{ company: 'Acme', amount: 120.5, due: '2026-11-01', paid: null }]);
    expect(userText(calls[0])).toBe('Acme invoice: $120.50 due Nov 1st');
    expect(calls[0].system).toMatch(/^You are an expert extraction algorithm/);
    expect(calls[0].responseFormat).toBe('json');
  });

  it('uses a JSON Schema and retries a reply that misses a required field', async () => {
    const inputSchema = JSON.stringify({
      type: 'object',
      properties: { state: { type: 'string' }, cities: { type: 'array', items: { type: 'string' } } },
      required: ['state'],
    });
    const { calls, outputs } = await chain(
      'core.informationExtractor',
      { text: 'Austin and Dallas', schemaType: 'manual', inputSchema, options: { systemPromptTemplate: 'Extract places.' } },
      ['{"cities": ["Austin"]}', '{"state": "Texas", "cities": ["Austin", "Dallas"]}'],
    );
    expect(outputs()[0]).toEqual([{ state: 'Texas', cities: ['Austin', 'Dallas'] }]);
    expect(calls[0].system).toMatch(/^Extract places\./);
    expect(userText(calls[1], 2)).toContain('$.state: is required');
  });
});

describe('chains with the real chat model adapters', () => {
  let fake: FakeServer;
  beforeAll(async () => {
    // JSON mode answers like a classifier that picks "negative"; anything else uses the default fake.
    fake = await startFakeOpenAi({
      chat: (body) =>
        body.response_format ? { message: { role: 'assistant', content: '{"positive": false, "negative": true}' }, finish_reason: 'stop' } : undefined,
    });
  });
  afterAll(() => fake.close());

  const run = (root: FlowNode, model: FlowNode, input: Array<Record<string, unknown>> = [{}]) =>
    runFlow(
      [root, model],
      [
        ['Start', root.name],
        [model.name, root.name, 'ai_languageModel'],
      ],
      { input: input as never },
    );

  it('Text Classifier with the OpenAI Chat Model', async () => {
    const result = await run(
      { name: 'Classify', type: 'core.textClassifier', parameters: { categories: { categories: [{ category: 'positive' }, { category: 'negative' }] } } },
      { name: 'OpenAI', type: 'core.openAiChatModel', parameters: { model: 'gpt-test' }, credentials: { openAiApi: { baseUrl: fake.url } } },
      [{ text: 'It broke' }],
    );
    expect(outputsOf(result, 'Classify')).toEqual([[], [{ text: 'It broke' }], [], [], []]);
    const body = fake.last('/v1/chat/completions')!.body;
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.messages.map((m: { role: string }) => m.role)).toEqual(['system', 'user']);
  });

  it('Basic LLM Chain with the OpenAI Chat Model', async () => {
    const result = await run(
      { name: 'Chain', type: 'core.chainLlm', parameters: { prompt: 'Say hi' } },
      { name: 'OpenAI', type: 'core.openAiChatModel', parameters: { model: 'gpt-test' }, credentials: { openAiApi: { baseUrl: fake.url } } },
    );
    expect(outputsOf(result, 'Chain')[0]).toEqual([{ text: 'Echo: Say hi' }]);
  });

  it('Information Extractor with the Ollama Chat Model (format: json)', async () => {
    const result = await run(
      {
        name: 'Extract',
        type: 'core.informationExtractor',
        parameters: { text: 'anything', schemaType: 'manual', inputSchema: '{"type":"object","properties":{"ok":{"type":"boolean"}},"required":["ok"]}' },
      },
      { name: 'Ollama', type: 'core.ollamaChatModel', parameters: { baseUrl: fake.origin, model: 'qwen-test', temperature: 0 } },
    );
    expect(outputsOf(result, 'Extract')[0]).toEqual([{ ok: true }]);
    expect(fake.last('/api/chat')!.body.format).toBe('json');
  });

  it('Basic LLM Chain with the Anthropic Chat Model and an anthropicApi credential', async () => {
    const result = await run(
      {
        name: 'Chain',
        type: 'core.chainLlm',
        parameters: { prompt: 'Is it ok?', hasOutputParser: true, jsonSchema: '{"type":"object","properties":{"ok":{"type":"boolean"}}}' },
      },
      {
        name: 'Claude',
        type: 'core.anthropicChatModel',
        parameters: { model: 'claude-haiku-5-5', effort: 'low', maxTokens: 512, fallback: false },
        credentials: { anthropicApi: { apiKey: 'fake-key-for-tests', baseUrl: fake.origin } },
      },
    );
    expect(outputsOf(result, 'Chain')[0]).toEqual([{ ok: true }]);
    expect(fake.last('/v1/messages')!.body).toMatchObject({ model: 'claude-haiku-5-5', max_tokens: 512, messages: [{ role: 'user', content: 'Is it ok?' }] });
  });
});
