import { describe, expect, it } from 'vitest';
import { askKind, type AskKind } from '@/lib/shared/ask-kind';

const table: Array<[string, AskKind]> = [
  // The evaluation's phrasings (finding 2.1 and the evaluation's change messages).
  ['why did the last run fail?', 'question'],
  ['what does Check total do?', 'question'],
  ['it should retry 3 times', 'change'],
  ['only that one node: retry 3 times', 'change'],
  ['why did it fail? fix it', 'change'],
  ['', 'change'],
  ['   ', 'change'],
  // An imperative at the start, or after a lead-in.
  ['fix it', 'change'],
  ['Remove the HTTP step', 'change'],
  ['add a Slack message after Check total', 'change'],
  ['please set the channel to #ops', 'change'],
  ['can you make it retry 3 times?', 'change'],
  ['could you rename the node?', 'change'],
  ['would you delete the filter', 'change'],
  ["I want it to send a message", 'change'],
  ['I need you to connect them', 'change'],
  ["let's use the other model", 'change'],
  ['move Check total before the filter', 'change'],
  ['make sure the email goes out', 'change'],
  ['the HTTP step should retry 3 times', 'change'],
  // Questions: the words that open one, a question mark, or "explain".
  ['how many items did Fetch return?', 'question'],
  ['which node failed', 'question'],
  ['is the webhook published?', 'question'],
  ['does Check total run twice', 'question'],
  ['should it retry?', 'question'],
  ['can you explain the error?', 'question'],
  ['explain the last run', 'question'],
  ['tell me what Notify does', 'question'],
  ['show me why it stopped', 'question'],
  ['Why did it return 401?', 'question'],
  ['the last run failed, why?', 'question'],
  // Conditions and comma clauses are changes; the audit's phrasings.
  ['When a webhook receives an order, POST it to http://127.0.0.1:3401/orders', 'change'],
  ['When the total is over 100, send a Slack message', 'change'],
  ['when it fails, retry 3 times', 'change'],
  ['Where it says #bugs, change it to #oncall', 'change'],
  ['Have the HTTP step retry 3 times', 'change'],
  ['Do a retry on the HTTP step', 'change'],
  ['Does not need the Slack step, remove it', 'change'],
  ['Should retry 3 times', 'change'],
  ['What I want is a retry on the HTTP step', 'change'],
  ['Can we add a retry?', 'change'],
  ['Could we log the response too?', 'change'],
  ['when did it fail?', 'question'],
  ['where is the webhook', 'question'],
  // Mixed or unclear stays a change: a request is never dropped.
  ['why did it fail? thanks', 'question'],
  ['why did it fail? use the other credential', 'change'],
  ['what does it do, and then add a retry', 'change'],
  ['why did it fail? the one from this morning please', 'change'],
  ['retry', 'change'],
  ['hmm, the order flow', 'change'],
];

describe('askKind', () => {
  it.each(table)('%j is a %s', (message, kind) => {
    expect(askKind(message)).toBe(kind);
  });
});
