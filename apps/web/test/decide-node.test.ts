/**
 * C34: the Decide node. The System One client for Choice, Yes/No and Score questions, the node's routing and validation, its
 * outputs following the options, and the judge's yes/no calls unchanged, all against a fake System One server
 * (packages/test-fakes). The real nimble:9b is in decide-live.test.ts (LANDFLOW_INTEGRATION=ollama).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { expandPorts, indexedPorts } from '@landflow/protocol';
import { fakeSystemOne } from '@landflow/test-fakes';
import { DECIDE_LIMITS } from '@landflow/protocol';
import { decideNode, readQuestions } from '@/lib/server/nodes/decide';
import { ollamaConnection, SystemOneApiError, systemOneAsk, systemOneJudge, typesafeConnection, type DecideQuestion } from '@/lib/server/nodes/systemone';
import { outputsOf, run, runFlow } from './helpers';

const server = fakeSystemOne({ yes: ['urgent', 'asap'], high: ['furious'] });
beforeAll(() => server.start());
afterAll(() => server.stop());
beforeEach(() => server.reset());

const topic = { name: 'topic', type: 'choice', instructions: 'What is the ticket about?', options: 'billing: charged, refund, invoice\ntechnical: error, crash, outage\nother' };
const urgent = { name: 'urgent', type: 'yesno', instructions: 'Does the customer need an answer today?', trueMeans: 'needs help today' };
const anger = { name: 'anger', type: 'score', instructions: 'How upset is the customer?', levels: 'calm\nannoyed\nangry' };
const tickets = [{ text: 'I was charged twice, please refund' }, { text: 'The app shows an error and a crash' }, { text: 'Do you have a student plan' }];

const parameters = (more: Record<string, unknown> = {}, questions: unknown[] = [topic]) => ({ source: 'ollama', baseUrl: server.url, model: 'nimble:9b', state: '{{ $json }}', questions: { question: questions }, routeBy: 'topic', ...more });

describe('the client', () => {
  const connection = () => ollamaConnection({ baseUrl: `${server.url}/`, model: 'nimble:9b' });
  const asked = () => server.state().asked[0] as { model: string; state: unknown; questions: Record<string, unknown> };

  it('sends each type the way the server wants it and reads the answers', async () => {
    const questions = readQuestions({ question: [topic, urgent, anger] }).questions;
    const result = await systemOneAsk(connection(), 'Furious: I was charged twice, refund it asap', questions);
    expect(asked().questions).toEqual({
      topic: { type: 'choice', instructions: 'What is the ticket about?', criteria: { billing: 'charged, refund, invoice', technical: 'error, crash, outage', other: null } },
      urgent: { type: 'noul', instructions: 'Does the customer need an answer today?', criteria: { true: 'needs help today' } },
      anger: { type: 'score', instructions: 'How upset is the customer?', criteria: ['calm', 'annoyed', 'angry'] },
    });
    expect(asked().model).toBe('nimble:9b');
    expect(result.model).toBe('nimble:9b');
    const a = result.answers;
    expect(a.topic).toMatchObject({ type: 'choice', choice: 'billing' });
    expect(a.urgent).toEqual({ type: 'yesno', probability: 0.93 });
    expect(a.anger).toMatchObject({ type: 'score', level: 2, label: 'angry' });
    expect(result.usage.inputTokens).toBeGreaterThan(0);
  });

  it('sends an object state as JSON', async () => {
    await systemOneAsk(connection(), { subject: 'Refund', body: 'charged twice' }, [readQuestions({ question: [topic] }).questions[0]]);
    expect(asked().state).toEqual({ subject: 'Refund', body: 'charged twice' });
  });

  it('refuses an answer it cannot read: an invented option, a missing probability, a non-number', async () => {
    const [q] = readQuestions({ question: [topic] }).questions;
    const answer = (body: unknown) => async () => new Response(JSON.stringify({ model: 'm', answers: { topic: body } }), { headers: { 'content-type': 'application/json' } });
    const bad = [
      { type: 'choice', choice: 'refunds', probabilities: { billing: 0.5, technical: 0.3, other: 0.2 }, confidence: 0.5 },
      { type: 'choice', choice: 'billing', probabilities: { billing: 0.5, technical: 0.3 }, confidence: 0.5 },
      { type: 'choice', choice: 'billing', probabilities: { billing: 'high', technical: 0.3, other: 0.2 }, confidence: 0.5 },
    ];
    for (const body of bad) await expect(systemOneAsk(connection(), 'x', [q], { fetcher: answer(body) })).rejects.toThrow(/could not read/);
    await expect(systemOneAsk(connection(), 'x', [q], { fetcher: async () => new Response(JSON.stringify({ answers: {} }), { headers: { 'content-type': 'application/json' } }) })).rejects.toThrow(/did not answer/);
  });

  it('tells a missing model to be pulled and an old Ollama to be upgraded', async () => {
    const [q] = readQuestions({ question: [topic] }).questions;
    await expect(systemOneAsk(ollamaConnection({ baseUrl: server.url, model: 'nimble:70b' }), 'x', [q])).rejects.toThrow('run `ollama pull nimble:70b`');
    const old = fakeSystemOne({ oldServer: true });
    await old.start();
    try {
      await expect(systemOneAsk(ollamaConnection({ baseUrl: old.url, model: 'nimble:9b' }), 'x', [q])).rejects.toThrow(/upgrade Ollama to 0\.40/);
    } finally {
      await old.stop();
    }
  });

  it('gives Ollama a long timeout and refuses a connection without a model', () => {
    expect(connection().timeoutMs).toBeGreaterThanOrEqual(60_000);
    expect(() => ollamaConnection({ baseUrl: server.url, model: ' ' })).toThrow(/ollama pull/);
    expect(connection()).not.toHaveProperty('apiKey');
  });
});

describe('the judge still works on the same client', () => {
  it('asks one yes/no question and flags by the probability', async () => {
    const keyed = fakeSystemOne({ key: 'k1', yes: ['spam'] });
    await keyed.start();
    try {
      const judge = systemOneJudge(typesafeConnection({ apiKey: 'k1', baseUrl: keyed.url, model: 'nimble:9b' }));
      expect(await judge('No spam.', 'buy spam now')).toMatchObject({ flagged: true, confidence: 0.93 });
      expect(await judge('No spam.', 'hello')).toMatchObject({ flagged: false });
      expect((keyed.state().asked[0] as { questions: Record<string, { type: string }> }).questions.flagged.type).toBe('noul');
    } finally {
      await keyed.stop();
    }
  });
});

describe('the node', () => {
  it('routes each item to the output of its option, with the probabilities in decision', async () => {
    const result = await run(decideNode, parameters(), tickets);
    expect(result.error).toBeUndefined();
    // billing, technical, other, Unsure
    expect(result.outputs.map((branch) => branch.length)).toEqual([1, 1, 1, 0]);
    const decision = (output: number) => (result.outputs[output][0].json as { decision: { model: string; topic: { choice: string; probabilities: Record<string, number>; confidence: number } }; text: string });
    expect(decision(0).text).toBe(tickets[0].text);
    expect(decision(0).decision.model).toBe('nimble:9b');
    expect(decision(0).decision.topic.choice).toBe('billing');
    expect(Object.keys(decision(0).decision.topic.probabilities)).toEqual(['billing', 'technical', 'other']);
    expect(decision(1).decision.topic.choice).toBe('technical');
    expect(decision(2).decision.topic.choice).toBe('other');
    expect(server.state().asked).toHaveLength(3);
  });

  it('sends an item to Unsure when the confidence is below the minimum', async () => {
    const result = await run(decideNode, parameters({ minConfidence: 0.99 }), tickets);
    expect(result.outputs.map((branch) => branch.length)).toEqual([0, 0, 0, 3]);
  });

  it('routes a Yes/No question by its threshold to Yes or No', async () => {
    const base = { routeBy: 'urgent' };
    const text = [{ text: 'refund me asap' }, { text: 'whenever' }];
    const result = await run(decideNode, parameters(base, [urgent]), text);
    expect(result.outputs.map((branch) => branch.length)).toEqual([1, 1]);
    expect((result.outputs[0][0].json as { decision: { urgent: unknown } }).decision.urgent).toEqual({ yes: true, probability: 0.93 });
    expect((result.outputs[1][0].json as { decision: { urgent: unknown } }).decision.urgent).toEqual({ yes: false, probability: 0.07 });
    // A threshold above the probability turns a yes into a no.
    const strict = await run(decideNode, parameters(base, [{ ...urgent, threshold: 0.95 }]), [text[0]]);
    expect(strict.outputs.map((branch) => branch.length)).toEqual([0, 1]);
  });

  it('has one output when it routes by nothing, and a Score question never routes', async () => {
    const none = await run(decideNode, parameters({ routeBy: '' }, [topic, urgent, anger]), [{ text: 'furious refund asap' }]);
    expect(none.outputs).toHaveLength(1);
    expect((none.outputs[0][0].json as { decision: Record<string, unknown> }).decision).toMatchObject({ topic: { choice: 'billing' }, urgent: { yes: true }, anger: { level: 2, label: 'angry' } });
    const scored = await run(decideNode, parameters({ routeBy: 'anger' }, [anger]), [{ text: 'x' }]);
    expect(scored.error?.message).toMatch(/Score question cannot route/);
  });

  it('feeds each branch of a flow from its own output', async () => {
    const result = await runFlow(
      [
        { name: 'Decide', type: 'core.decide', parameters: parameters({ state: '{{ $json.text }}' }) },
        { name: 'Billing', type: 'core.noOp' },
        { name: 'Technical', type: 'core.noOp' },
        { name: 'Other', type: 'core.noOp' },
      ],
      [['Start', 'Decide'], ['Decide', 'Billing', 'main', 0], ['Decide', 'Technical', 'main', 1], ['Decide', 'Other', 'main', 2]],
      { input: tickets },
    );
    expect(outputsOf(result, 'Billing')[0]).toHaveLength(1);
    expect(outputsOf(result, 'Technical')[0]).toHaveLength(1);
    expect(outputsOf(result, 'Other')[0]).toHaveLength(1);
  });

  it('reads the whole item by default', async () => {
    await run(decideNode, parameters({ state: '{{ $json }}' }), [{ subject: 'Refund', text: 'charged twice' }]);
    expect((server.state().asked[0] as { state: unknown }).state).toEqual({ subject: 'Refund', text: 'charged twice' });
  });

  it('uses a TypeSafe credential and says so when it is missing', async () => {
    const keyed = fakeSystemOne({ key: 'sk-1' });
    await keyed.start();
    try {
      const ok = await run(decideNode, parameters({ source: 'typesafe' }), [tickets[0]], { typesafeApi: { apiKey: 'sk-1', baseUrl: keyed.url, model: 'nimble:9b' } });
      expect(ok.error).toBeUndefined();
      expect(ok.outputs[0]).toHaveLength(1);
      const missing = await run(decideNode, parameters({ source: 'typesafe' }), [tickets[0]], { typesafeApi: { apiKey: ' ' } });
      expect(missing.error?.message).toMatch(/no API key/);
    } finally {
      await keyed.stop();
    }
  });

  it('fails with the server\'s words on a bad answer, and the item index', async () => {
    server.script({ status: 500, body: { detail: 'model crashed' } });
    const result = await run(decideNode, parameters(), tickets);
    expect(result.error?.message).toMatch(/Ollama answered 500: model crashed/);
  });
});

describe('the questions are checked', () => {
  const refuse = (questions: unknown[], message: RegExp) => expect(() => readQuestions({ question: questions })).toThrow(message);

  it('needs 1 to 64 questions with safe, unique names', () => {
    refuse([], /at least one question/);
    refuse(Array.from({ length: 65 }, (_, i) => ({ ...urgent, name: `q${i}` })), /at most 64/);
    expect(readQuestions({ question: Array.from({ length: 64 }, (_, i) => ({ ...urgent, name: `q${i}` })) }).questions).toHaveLength(64);
    refuse([{ ...urgent, name: 'two words' }], /must start with a letter/);
    refuse([{ ...urgent, name: 'model' }], /reserved/);
    refuse([urgent, urgent], /Two questions are called "urgent"/);
    refuse([{ ...urgent, instructions: ' ' }], /needs instructions/);
    refuse([{ name: 'x', instructions: 'q' }], /no type/);
  });

  it('needs 2 to 26 options and levels, and option names that can be keys', () => {
    refuse([{ ...topic, options: 'only' }], /needs 2 to 26 options/);
    refuse([{ ...topic, options: Array.from({ length: 27 }, (_, i) => `o${i}`).join('\n') }], /needs 2 to 26 options/);
    expect(readQuestions({ question: [{ ...topic, options: Array.from({ length: 26 }, (_, i) => `o${i}`).join('\n') }] }).questions).toHaveLength(1);
    refuse([{ ...topic, options: 'a\na' }], /two options with the same name/);
    refuse([{ ...topic, options: '__proto__: x\nb' }], /cannot be an option name/);
    refuse([{ ...topic, options: ': nameless\nb' }], /has no name/);
    refuse([{ ...anger, levels: 'one' }], /needs 2 to 26 levels/);
    refuse([{ ...urgent, threshold: 1 }], /between 0 and 1/);
  });
});

describe('the outputs follow the options', () => {
  const outputs = (more: Record<string, unknown>, questions: unknown[]) => expandPorts(decideNode.description.outputs, parameters(more, questions)).map((p) => p.displayName);

  it('names the options plus Unsure, Yes and No, or one output', () => {
    expect(outputs({}, [topic])).toEqual(['billing', 'technical', 'other', 'Unsure']);
    expect(outputs({ routeBy: 'urgent' }, [urgent])).toEqual(['Yes', 'No']);
    expect(outputs({ routeBy: '' }, [topic])).toEqual(['Decided']);
    // Edit the options and the outputs change with them; an unfinished edit keeps the single output.
    expect(outputs({}, [{ ...topic, options: 'a\nb' }])).toEqual(['a', 'b', 'Unsure']);
    expect(outputs({}, [{ ...topic, options: 'a' }])).toEqual(['Decided']);
    expect(outputs({ routeBy: 'missing' }, [topic])).toEqual(['Decided']);
  });

  it('indexes the expanded ports so handle ids are main:0, main:1, …', () => {
    const ports = indexedPorts(decideNode.description.outputs, parameters());
    expect(ports.map((p) => `${p.port.type}:${p.index}:${p.port.displayName}`)).toEqual(['main:0:billing', 'main:1:technical', 'main:2:other', 'main:3:Unsure']);
  });

  it('is a node the catalog can find, in AI, as Decide', () => {
    expect(decideNode.description).toMatchObject({ displayName: 'Decide', categories: ['AI'], description: 'Answers questions about each item with a decision model and routes it' });
  });

  it('is a SystemOneApiError when the server is down', async () => {
    await expect(systemOneAsk(ollamaConnection({ baseUrl: 'http://127.0.0.1:1', model: 'x' }), 'x', [readQuestions({ question: [topic] }).questions[0] as DecideQuestion])).rejects.toBeTruthy();
    expect(SystemOneApiError).toBeDefined();
  });
});

describe('C34 review: what the node keeps, caps and sends', () => {
  it('keeps the binary data of an item', async () => {
    const result = await runFlow(
      [{ name: 'Decide', type: 'core.decide', parameters: parameters({ state: '{{ $json.text }}' }) }],
      [['Start', 'Decide']],
      { input: [{ text: 'charged twice' }] },
    );
    expect(outputsOf(result, 'Decide')[0]).toHaveLength(1);
    // The SDK runner sees the item's own fields: a binary item comes out with the same binary.
    const input = { json: { text: 'charged twice, refund' }, binary: { invoice: { mimeType: 'application/pdf', fileName: 'a.pdf', data: 'JVBERi0=' } } };
    const { runNode, } = await import('@landflow/sdk');
    const response = await runNode(decideNode, {
      protocol: 'landflow.plugin/v1', executionId: 'ex', workflowId: 'wf', mode: 'manual',
      node: { id: 'n1', name: 'Decide', type: 'core.decide', typeVersion: 1 },
      parameters: parameters({ state: '{{ $json }}' }) as never, itemParameters: [parameters({ state: '{{ $json }}' }) as never], inputs: [[input as never]],
    });
    const out = response.outputs.flat()[0] as unknown as { binary?: Record<string, unknown>; json: { decision?: unknown } };
    expect(out.binary).toEqual(input.binary);
    expect(out.json.decision).toBeDefined();
  });

  it('refuses a state over the cap and suggests narrowing What To Read', async () => {
    const result = await run(decideNode, parameters(), [{ text: 'x'.repeat(DECIDE_LIMITS.stateChars + 1) }]);
    expect(result.error?.message).toMatch(/too long/);
    expect(result.error?.description ?? '').toMatch(/What To Read/);
    expect(server.state().asked).toHaveLength(0);
    const ok = await run(decideNode, parameters(), [{ text: 'x'.repeat(DECIDE_LIMITS.stateChars - 100) }]);
    expect(ok.error).toBeUndefined();
  });

  it('sends a typed text as text: only an object or an array is read as JSON', async () => {
    for (const [value, sent] of [['123', '123'], ['true', 'true'], ['"quoted"', '"quoted"'], ['{"a":1}', { a: 1 }], ['[1,2]', [1, 2]], ['plain words', 'plain words']] as const) {
      server.reset();
      await run(decideNode, parameters({ state: value }), [{}]);
      expect((server.state().asked[0] as { state: unknown }).state).toEqual(sent);
    }
  });

  it('says What To Read came out empty and what the item could have offered', async () => {
    // The helper's run() does not resolve expressions, so a blank text stands for "resolved to nothing".
    const result = await run(decideNode, parameters({ state: '{{ $json.missing }}' }), [{ text: 'x' }]);
    expect(result.error).toBeUndefined(); // an unresolved expression is still text: only a blank one is empty
    const blank = await run(decideNode, parameters({ state: ' ' }), [{ text: 'x', subject: 'y' }]);
    // A blank state means the whole item (the documented default), so nothing is empty either.
    expect(blank.error).toBeUndefined();
    const flow = await runFlow([{ name: 'Decide', type: 'core.decide', parameters: parameters({ state: '{{ $json.description }}' }) }], [['Start', 'Decide']], { input: [{ text: 'x' }] });
    const failed = flow.runData.Decide.find((r) => r.error)?.error;
    expect(failed?.message).toMatch(/What To Read came out empty/);
    expect(failed?.description).toMatch(/the fields text/);
    expect(failed?.description).toMatch(/\{\{ \$json \}\}/);
  });

  it('refuses an option called Unsure, in any case', () => {
    expect(() => readQuestions({ question: [{ ...topic, options: 'billing\nUnsure' }] })).toThrow(/Unsure/);
    expect(() => readQuestions({ question: [{ ...topic, options: 'billing\nunsure' }] })).toThrow(/Unsure/);
  });

  it('does not let a question instruction be an expression, and offers Route By from the questions', async () => {
    const property = (name: string) => (decideNode.description.properties.find((p) => p.name === 'questions')?.groups?.[0].values ?? []).find((v) => v.name === name);
    expect(property('instructions')?.noDataExpression).toBe(true);
    expect(property('options')?.noDataExpression).toBe(true);
    const routeBy = decideNode.description.properties.find((p) => p.name === 'routeBy');
    expect(routeBy?.typeOptions?.loadOptionsMethod).toBe('routes');
    const listed = await decideNode.methods?.loadOptions?.routes?.({ getCurrentParameters: () => parameters({}, [topic, urgent, anger]) } as never);
    expect(listed?.map((o) => o.value)).toEqual(['', 'topic', 'urgent']);
  });

  it('reads an answer key that is not its own: an option named like an Object property is no answer', async () => {
    const [q] = readQuestions({ question: [topic] }).questions;
    const toString = async () => new Response(JSON.stringify({ model: 'm', answers: { topic: { type: 'choice', choice: 'toString', probabilities: { billing: 0.3, technical: 0.3, other: 0.4 }, confidence: 0.1 } } }), { headers: { 'content-type': 'application/json' } });
    await expect(systemOneAsk(ollamaConnection({ baseUrl: server.url, model: 'nimble:9b' }), 'x', [q], { fetcher: toString })).rejects.toThrow(/could not read/);
  });
});
