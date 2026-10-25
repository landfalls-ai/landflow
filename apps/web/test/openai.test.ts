import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { context, metrics, SpanStatusCode, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { MeterProvider, MetricReader, type DataPoint } from '@opentelemetry/sdk-metrics';
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider } from '@opentelemetry/sdk-trace';
import { runLoadOptions, runTestCredentials } from '@landflow/sdk';
import { corePlugin } from '@/lib/server/nodes';
import { anthropicModel, ollamaModel, openAiChat, openAiConnection, openAiEmbeddings, openAiModel, type GenerateInput } from '@/lib/server/nodes/models';
import { openAiChatModelNode, openAiNode } from '@/lib/server/nodes/openai';
import { closedPort, sentKey, startFakeOpenAi, type FakeServer } from './fake-openai';
import { outputsOf, run, runFlow, runOk } from './helpers';

/** A reader the test collects from on demand. */
class TestReader extends MetricReader {
  protected async onForceFlush() {}
  protected async onShutdown() {}
}

const KEY = 'fake-key-for-tests';
const spans = new InMemorySpanExporter();
const reader = new TestReader();
let fake: FakeServer;
let keyed: FakeServer;
let nowhere: string;
const creds = () => ({ openAiApi: { baseUrl: fake.url } });
const hello = { messages: [{ role: 'user' as const, content: 'hello' }], tools: [] };

beforeAll(async () => {
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  trace.setGlobalTracerProvider(new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter: spans })] }));
  metrics.setGlobalMeterProvider(new MeterProvider({ readers: [reader] }));
  fake = await startFakeOpenAi();
  keyed = await startFakeOpenAi({ apiKey: KEY });
  nowhere = `127.0.0.1:${await closedPort()}`;
});

afterAll(async () => {
  await Promise.all([fake.close(), keyed.close()]);
  trace.disable();
  metrics.disable();
  context.disable();
});

beforeEach(() => spans.reset());

describe('openAiApi connection', () => {
  it('defaults to OpenAI and sends no key when none is set', () => {
    const connection = openAiConnection({});
    expect(connection).toMatchObject({ base: 'https://api.openai.com/v1', system: 'openai', label: 'OpenAI', official: true });
    expect(connection.headers).toEqual({ 'content-type': 'application/json' });
  });

  it('recognises Ollama, names other hosts, and sends key and organization', () => {
    expect(openAiConnection({ baseUrl: 'http://127.0.0.1:11434/v1/' })).toMatchObject({
      base: 'http://127.0.0.1:11434/v1',
      system: 'ollama',
      label: 'Ollama',
      official: false,
      attributes: { 'server.address': '127.0.0.1', 'server.port': 11434 },
    });
    const other = openAiConnection({ baseUrl: 'https://llm.internal:8000/v1', apiKey: ` ${KEY} `, organization: 'org-1' });
    expect(other).toMatchObject({ system: 'openai', label: 'llm.internal:8000' });
    expect(other.headers).toMatchObject({ authorization: `Bearer ${KEY}`, 'openai-organization': 'org-1' });
    expect(() => openAiConnection({ baseUrl: 'localhost:11434' })).toThrow(/Invalid base URL/);
  });
});

describe('OpenAI chat completions', () => {
  it('sends system, messages and options; strips <think> from the answer', async () => {
    const model = openAiModel(openAiConnection({ baseUrl: fake.url, apiKey: KEY, organization: 'org-1' }), {
      model: 'gpt-test',
      temperature: 0.2,
      maxTokens: 50,
    });
    expect(model.provider).toBe('openai');
    const turn = await model.generate({ system: 'Be brief', ...hello });
    expect(turn).toEqual({ text: 'Echo: hello', toolCalls: [], stopReason: 'stop', usage: { inputTokens: 11, outputTokens: 7 } });
    const request = fake.last('/v1/chat/completions')!;
    expect(request.headers).toMatchObject({ authorization: `Bearer ${KEY}`, 'openai-organization': 'org-1' });
    expect(request.body).toEqual({
      model: 'gpt-test',
      messages: [
        { role: 'system', content: 'Be brief' },
        { role: 'user', content: 'hello' },
      ],
      temperature: 0.2,
      max_tokens: 50,
    });
  });

  it('round-trips tool calls', async () => {
    const model = openAiModel(openAiConnection({ baseUrl: fake.url }), { model: 'gpt-test' });
    const tools = [{ name: 'calculator', description: 'Math', inputSchema: { type: 'object', properties: { expression: { type: 'string' } } } }];
    const first = await model.generate({ messages: [{ role: 'user', content: '6*7?' }], tools });
    expect(first).toMatchObject({ text: '', stopReason: 'tool_calls', toolCalls: [{ id: 'call_1', name: 'calculator', input: { expression: '6*7' } }] });
    expect(fake.last('/v1/chat/completions')!.body.tools).toEqual([
      { type: 'function', function: { name: 'calculator', description: 'Math', parameters: tools[0].inputSchema } },
    ]);

    const second = await model.generate({
      messages: [
        { role: 'user', content: '6*7?' },
        { role: 'assistant', text: first.text, toolCalls: first.toolCalls },
        { role: 'tool', results: [{ id: 'call_1', name: 'calculator', content: '42' }] },
      ],
      tools,
    });
    expect(second.text).toBe('The answer is 42');
    expect(fake.last('/v1/chat/completions')!.body.messages.slice(1)).toEqual([
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'calculator', arguments: '{"expression":"6*7"}' } }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: '42' },
    ]);
  });

  it('asks for JSON per call or always', async () => {
    const connection = openAiConnection({ baseUrl: fake.url });
    const perCall = await openAiModel(connection, { model: 'gpt-test' }).generate({ ...hello, responseFormat: 'json' } as GenerateInput);
    expect(JSON.parse(perCall.text)).toEqual({ echo: 'hello' });
    expect(fake.last('/v1/chat/completions')!.body.response_format).toEqual({ type: 'json_object' });
    await openAiModel(connection, { model: 'gpt-test', responseFormat: 'json_object' }).generate(hello);
    expect(fake.last('/v1/chat/completions')!.body.response_format).toEqual({ type: 'json_object' });
    await openAiModel(connection, { model: 'gpt-test', maxTokens: -1 }).generate(hello);
    expect(fake.last('/v1/chat/completions')!.body).not.toHaveProperty('response_format');
    expect(fake.last('/v1/chat/completions')!.body).not.toHaveProperty('max_tokens');
  });

  it('turns HTTP and network failures into clear errors', async () => {
    const chat = (baseUrl: string, model: string, apiKey?: string) =>
      openAiChat(openAiConnection({ baseUrl, ...(apiKey && { apiKey }) }), { model }, [{ role: 'user', content: 'hi' }]);
    const label = `127.0.0.1:${fake.port}`;
    await expect(chat(fake.url, 'missing')).rejects.toMatchObject({
      status: 404,
      message: `${label}: The model 'missing' does not exist (404)`,
      description: expect.stringContaining('Check the model name'),
    });
    await expect(chat(fake.url, 'notfound')).rejects.toMatchObject({
      status: 404,
      message: `${label}: not found (404)`,
      description: '404 page not found Check the model name and the base URL (it usually ends in /v1).',
    });
    await expect(chat(fake.url, 'busy')).rejects.toMatchObject({ status: 429, message: `${label} rate limit or quota reached` });
    await expect(chat(fake.url, 'broken')).rejects.toMatchObject({ status: 500, message: `${label} API error 500`, description: 'upstream exploded' });
    await expect(chat(keyed.url, 'gpt-test', 'wrong')).rejects.toMatchObject({ status: 401, message: `127.0.0.1:${keyed.port} rejected the API key` });
    await expect(chat(keyed.url, 'gpt-test', KEY)).resolves.toMatchObject({ text: 'Echo: hi' });
    await expect(chat(`http://${nowhere}/v1`, 'gpt-test')).rejects.toMatchObject({
      message: `Cannot reach ${nowhere} at http://${nowhere}/v1`,
      description: 'ECONNREFUSED',
    });
  });
});

describe('OpenAI embeddings', () => {
  it('returns vectors in input order and passes dimensions', async () => {
    const result = await openAiEmbeddings(openAiConnection({ baseUrl: fake.url }), 'text-embedding-test', ['a', 'bbb'], { dimensions: 3 });
    expect(result).toEqual({
      vectors: [
        [1, 0, 0.5],
        [3, 1, 0.5],
      ],
      model: 'text-embedding-test',
      inputTokens: 6,
    });
    expect(fake.last('/v1/embeddings')!.body).toEqual({ model: 'text-embedding-test', input: ['a', 'bbb'], dimensions: 3 });
  });

  it('Create Embeddings adds the vector to each item, in batches of 100', async () => {
    const params = { resource: 'embeddings', embeddingModel: 'text-embedding-test', inputField: 'doc.body' };
    const result = await runOk(
      openAiNode,
      params,
      [
        { id: 1, doc: { body: 'hello' } },
        { id: 2, doc: { body: 'hi' } },
      ],
      creds(),
    );
    expect(result.json()).toEqual([
      { id: 1, doc: { body: 'hello' }, embedding: [5, 0, 0.5], dimensions: 3 },
      { id: 2, doc: { body: 'hi' }, embedding: [2, 1, 0.5], dimensions: 3 },
    ]);
    const before = fake.requests.filter((r) => r.path === '/v1/embeddings').length;
    const many = await runOk(
      openAiNode,
      { ...params, inputField: 'text' },
      Array.from({ length: 150 }, (_, i) => ({ text: `t${i}` })),
      creds(),
    );
    const calls = fake.requests.filter((r) => r.path === '/v1/embeddings').slice(before);
    expect(calls.map((call) => call.body.input.length)).toEqual([100, 50]);
    expect(many.json()[120]).toMatchObject({ text: 't120', embedding: [4, 20, 0.5] });
  });

  it('reports the item with a missing field', async () => {
    const result = await run(
      openAiNode,
      { resource: 'embeddings', embeddingModel: 'text-embedding-test', inputField: 'text' },
      [{ text: 'ok' }, { other: 1 }],
      creds(),
    );
    expect(result.error).toMatchObject({ message: '“text” is empty or missing', itemIndex: 1 });
  });
});

describe('OpenAI node: Message a Model', () => {
  const messages = (...values: Array<{ role: string; content: string }>) => ({ values });

  it('returns the message, usage and model', async () => {
    const result = await runOk(
      openAiNode,
      {
        resource: 'text',
        operation: 'message',
        modelId: 'gpt-test',
        messages: messages({ role: 'system', content: 'Be nice' }, { role: 'user', content: 'hello' }),
      },
      [{}],
      creds(),
    );
    expect(result.json()).toEqual([
      {
        message: { role: 'assistant', content: 'Echo: hello' },
        usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 },
        finishReason: 'stop',
        model: 'gpt-test-2026',
      },
    ]);
  });

  it('parses JSON output and tells the model to answer in JSON', async () => {
    const result = await runOk(
      openAiNode,
      { resource: 'text', modelId: 'gpt-test', messages: messages({ role: 'user', content: 'hello' }), jsonOutput: true },
      [{}],
      creds(),
    );
    expect(result.json()[0].message).toEqual({ role: 'assistant', content: { echo: 'hello' } });
    expect(fake.last('/v1/chat/completions')!.body.messages[0]).toEqual({ role: 'system', content: 'Respond with a JSON object.' });
  });

  it('needs a user message', async () => {
    const result = await run(openAiNode, { resource: 'text', modelId: 'gpt-test', messages: messages({ role: 'system', content: 'Be nice' }) }, [{}], creds());
    expect(result.error).toMatchObject({ message: 'No user message', itemIndex: 0 });
  });
});

describe('model pickers and connection tests', () => {
  it('lists chat and embedding models from /models', async () => {
    const chat = await runLoadOptions(openAiChatModelNode, 'chatModels', {}, creds());
    expect(chat).toEqual([{ name: 'gpt-test', value: 'gpt-test', description: `127.0.0.1:${fake.port} · fake` }]);
    expect((await runLoadOptions(openAiNode, 'embeddingModels', {}, creds())).map((o) => o.value)).toEqual(['text-embedding-test']);
    await expect(runLoadOptions(openAiChatModelNode, 'chatModels', {}, { openAiApi: { baseUrl: keyed.url } })).rejects.toThrow(/rejected the API key/);
  });

  it('tests openAiApi credentials by listing models', async () => {
    const test = (data: Record<string, string>) => runTestCredentials(corePlugin, { credentialType: 'core.openAiApi', data });
    expect(await test({ baseUrl: fake.url })).toEqual({ ok: true, message: `Connected to 127.0.0.1:${fake.port}: 3 models available` });
    expect(await test({ baseUrl: keyed.url, apiKey: KEY })).toMatchObject({ ok: true });
    expect(await test({ baseUrl: keyed.url, apiKey: 'wrong' })).toMatchObject({
      ok: false,
      message: expect.stringMatching(/rejected the API key — Incorrect API key provided/),
    });
    expect(await test({ baseUrl: `http://${nowhere}/v1` })).toEqual({ ok: false, message: `Cannot reach ${nowhere} at http://${nowhere}/v1 — ECONNREFUSED` });
  });

  it('tests anthropicApi credentials by listing models with the official SDK', async () => {
    const test = (data: Record<string, string>) => runTestCredentials(corePlugin, { credentialType: 'core.anthropicApi', data });
    expect(await test({ apiKey: KEY, baseUrl: keyed.origin })).toEqual({ ok: true, message: 'API key accepted: 3 models available' });
    expect(sentKey(keyed.last('/v1/models')!)).toBe(KEY);
    expect(await test({ apiKey: 'wrong', baseUrl: keyed.origin })).toEqual({ ok: false, message: 'Anthropic rejected the API key (401)' });
    expect(await test({ apiKey: '' })).toEqual({ ok: false, message: 'Enter an API key' });
  });
});

describe('other adapters', () => {
  it('Anthropic uses the credential key and base URL', async () => {
    const model = anthropicModel({ model: 'claude-haiku-5-5', effort: 'low', maxTokens: 256, fallback: true, apiKey: KEY, baseUrl: keyed.origin });
    const turn = await model.generate(hello);
    expect(turn).toMatchObject({ text: 'Sure: {"ok": true}', stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 3 } });
    expect(sentKey(keyed.last('/v1/messages')!)).toBe(KEY);
    await expect(
      anthropicModel({ model: 'claude-haiku-5-5', effort: 'low', maxTokens: 256, fallback: false, apiKey: 'wrong', baseUrl: keyed.origin }).generate(hello),
    ).rejects.toMatchObject({
      message: 'Anthropic rejected the credentials',
      description: 'Check the API key of the Anthropic credential.',
    });
  });

  it('Ollama asks for JSON with format: json', async () => {
    const model = ollamaModel({ baseUrl: fake.origin, model: 'qwen-test' });
    expect((await model.generate({ ...hello, responseFormat: 'json' } as GenerateInput)).text).toBe('{"ok": true}');
    expect(fake.last('/api/chat')!.body.format).toBe('json');
    expect((await model.generate(hello)).text).toBe('plain text');
    expect(fake.last('/api/chat')!.body).not.toHaveProperty('format');
  });
});

describe('AI Agent with the OpenAI Chat Model', () => {
  it('calls the Calculator tool and answers with its result', async () => {
    const result = await runFlow(
      [
        { name: 'Agent', type: 'core.aiAgent', parameters: { prompt: 'What is 6 * 7?' } },
        { name: 'Model', type: 'core.openAiChatModel', parameters: { model: 'gpt-test' }, credentials: creds() },
        { name: 'Calculator', type: 'core.calculatorTool' },
      ],
      [
        ['Start', 'Agent'],
        ['Model', 'Agent', 'ai_languageModel'],
        ['Calculator', 'Agent', 'ai_tool'],
      ],
    );
    const [answer] = outputsOf(result, 'Agent')[0];
    expect(answer).toMatchObject({ model: 'openai/gpt-test', iterations: 2, usage: { inputTokens: 22, outputTokens: 14 } });
    expect(answer.output).toContain('"result":42');
    expect(answer.steps).toMatchObject([{ input: { expression: '6*7' }, output: { result: 42 } }]);
  });

  it('fails clearly without a credential', async () => {
    const result = await runFlow(
      [
        { name: 'Agent', type: 'core.aiAgent', parameters: { prompt: 'hi' } },
        { name: 'Model', type: 'core.openAiChatModel', parameters: { model: 'gpt-test' } },
      ],
      [
        ['Start', 'Agent'],
        ['Model', 'Agent', 'ai_languageModel'],
      ],
    );
    expect(result.error?.message).toMatch(/No "openAiApi" credentials/);
  });
});

describe('telemetry', () => {
  const finished = (name: string) => spans.getFinishedSpans().find((span) => span.name === name);

  it('traces chat calls as gen_ai.chat spans', async () => {
    await openAiChat(openAiConnection({ baseUrl: fake.url }), { model: 'gpt-test', temperature: 0.5 }, [{ role: 'user', content: 'hi' }]);
    const span = finished('gen_ai.chat gpt-test');
    expect(span?.attributes).toMatchObject({
      'gen_ai.system': 'openai',
      'gen_ai.operation.name': 'chat',
      'gen_ai.request.model': 'gpt-test',
      'gen_ai.request.temperature': 0.5,
      'gen_ai.response.model': 'gpt-test-2026',
      'gen_ai.usage.input_tokens': 11,
      'gen_ai.usage.output_tokens': 7,
      'gen_ai.response.finish_reasons': ['stop'],
      'server.address': '127.0.0.1',
      'server.port': fake.port,
    });

    await expect(openAiChat(openAiConnection({ baseUrl: fake.url }), { model: 'missing' }, [{ role: 'user', content: 'hi' }])).rejects.toThrow();
    const failed = finished('gen_ai.chat missing');
    expect(failed?.status.code).toBe(SpanStatusCode.ERROR);
    expect(failed?.attributes['error.type']).toBe('OpenAiApiError');
  });

  it('traces embeddings as gen_ai.embeddings spans and counts them in the AI metrics', async () => {
    await openAiEmbeddings(openAiConnection({ baseUrl: fake.url }), 'text-embedding-test', ['abc', 'de']);
    const span = finished('gen_ai.embeddings text-embedding-test');
    expect(span?.attributes).toMatchObject({
      'gen_ai.system': 'openai',
      'gen_ai.operation.name': 'embeddings',
      'gen_ai.request.model': 'text-embedding-test',
      'gen_ai.usage.input_tokens': 6,
      'gen_ai.embeddings.dimension.count': 3,
    });
    expect(span?.attributes).not.toHaveProperty('gen_ai.usage.output_tokens');

    const { resourceMetrics } = await reader.collect();
    const points = (name: string) =>
      resourceMetrics.scopeMetrics
        .flatMap((scope) => scope.metrics)
        .filter((metric) => metric.descriptor.name === name)
        .flatMap((metric) => metric.dataPoints as DataPoint<unknown>[])
        .filter((point) => point.attributes['gen_ai.request.model'] === 'text-embedding-test');
    expect(points('landflow.ai.requests').find((p) => p.attributes['landflow.outcome'] === 'ok')?.value).toBeGreaterThanOrEqual(1);
    expect(points('landflow.ai.tokens').map((p) => p.attributes['gen_ai.token.type'])).toEqual(['input']);
    expect(points('landflow.ai.duration')).toHaveLength(1);
  });
});
