/**
 * C34 live: the Decide node against the real Ollama and nimble:9b. Skipped unless `LANDFLOW_INTEGRATION=ollama`
 * (needs Ollama 0.40+ with `ollama pull nimble:9b`; OLLAMA_URL names the server, default http://127.0.0.1:11434).
 */
import { describe, expect, it } from 'vitest';
import { readQuestions } from '@/lib/server/nodes/decide';
import { ollamaConnection, systemOneAsk } from '@/lib/server/nodes/systemone';
import { outputsOf, runFlow } from './helpers';

const live = (process.env.LANDFLOW_INTEGRATION ?? '').split(',').includes('ollama');
const base = process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434';
const model = process.env.DECIDE_MODEL ?? 'nimble:9b';

const topic = { name: 'topic', type: 'choice', instructions: 'What is this support ticket about?', options: 'billing: charges, refunds, invoices, payments\ntechnical: errors, bugs, outages, how a feature works\nother' };
const urgent = { name: 'urgent', type: 'yesno', instructions: 'Is the customer losing money or blocked right now?' };
const anger = { name: 'anger', type: 'score', instructions: 'How upset is the customer?', levels: 'calm\nmildly annoyed\nfurious' };
const ticket = 'I was charged twice. Please refund the extra payment.';

describe.skipIf(!live)('nimble on a real Ollama', () => {
  it('picks billing for the double charge, with a probability that dominates', async () => {
    const started = Date.now();
    const { questions } = readQuestions({ question: [topic, urgent, anger] });
    const result = await systemOneAsk(ollamaConnection({ baseUrl: base, model }), ticket, questions);
    const answer = result.answers.topic;
    console.log(`decide-live: ${JSON.stringify(result.answers)} in ${Date.now() - started} ms`);
    expect(answer.type === 'choice' && answer.choice).toBe('billing');
    expect(answer.type === 'choice' && answer.probabilities.billing).toBeGreaterThan(0.5);
    const yes = result.answers.urgent;
    expect(yes.type === 'yesno' && yes.probability >= 0 && yes.probability <= 1).toBe(true);
    const score = result.answers.anger;
    expect(score.type === 'score' && score.score >= 0 && score.score <= 2).toBe(true);
  }, 180_000);

  it('routes three tickets through the node', async () => {
    const tickets = [{ text: ticket }, { text: 'The app crashes with error 500 every time I open the dashboard.' }, { text: 'Do you have a student discount or a free plan for a class?' }];
    const result = await runFlow(
      [{ name: 'Decide', type: 'core.decide', parameters: { source: 'ollama', baseUrl: base, model, state: '{{ $json.text }}', questions: { question: [topic] }, routeBy: 'topic' } }],
      [['Start', 'Decide']],
      { input: tickets },
    );
    const branches = outputsOf(result, 'Decide');
    console.log(`decide-live routes: ${branches.map((b, i) => `${i}:${b.length}`).join(' ')}`);
    expect(branches[0]).toHaveLength(1);
    expect(branches[1]).toHaveLength(1);
  }, 180_000);

  it('answers a yes/no question both ways', async () => {
    const { questions } = readQuestions({ question: [{ name: 'refund', type: 'yesno', instructions: 'Does the customer ask for money back?' }] });
    const connection = ollamaConnection({ baseUrl: base, model });
    const yes = (await systemOneAsk(connection, ticket, questions)).answers.refund;
    const no = (await systemOneAsk(connection, 'How do I change my profile picture?', questions)).answers.refund;
    console.log(`decide-live yes/no: ${JSON.stringify([yes, no])}`);
    expect(yes.type === 'yesno' && yes.probability).toBeGreaterThan(0.5);
    expect(no.type === 'yesno' && no.probability).toBeLessThan(0.5);
  }, 180_000);
});
