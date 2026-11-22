/**
 * The Slack node against the stateful Slack fake (@landflow/test-fakes): the test asserts on what landed in the
 * channel, not on the request shape. The older fake-slack.ts and the request-shape tests in slack.test.ts stay.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { JsonObject } from '@landflow/sdk';
import { fakeSlack } from '@landflow/test-fakes/slack';
import { Slack } from '../src/nodes/slack';
import { run } from './helpers';

const slack = fakeSlack();
beforeAll(() => slack.start());
afterAll(() => slack.stop());
beforeEach(() => slack.reset());

const credentials = (token = slack.token) => ({ slackApi: { accessToken: token, baseUrl: slack.url } });
const post = (text: string, token?: string, extra: JsonObject = {}) =>
  run(Slack, { resource: 'message', operation: 'post', channelId: slack.state().channels['#ops'].id, text, ...extra }, { credentials: credentials(token) });

/** What the host's "Retry on fail" does around a node: run it again until it succeeds or the tries are spent. */
async function withRetries(attempt: () => ReturnType<typeof post>, tries: number) {
  let response = await attempt();
  for (let n = 1; n < tries && response.error; n++) response = await attempt();
  return response;
}

describe('Slack Send Message', () => {
  it('lands the text in #ops', async () => {
    const response = await post('deploy finished');
    expect(response.error).toBeUndefined();
    expect(slack.state().channels['#ops'].messages.map((m) => m.text)).toEqual(['deploy finished']);
    expect(slack.state().channels['#general'].messages).toEqual([]);
  });

  it('puts a reply in the thread of the message it answers', async () => {
    await post('incident');
    const ts = slack.state().channels['#ops'].messages[0].ts;
    expect((await post('on it', undefined, { otherOptions: { thread_ts: ts } })).error).toBeUndefined();
    expect(slack.state().channels['#ops'].messages[1]).toMatchObject({ text: 'on it', thread_ts: ts });
  });

  it('after a 429 and a retry, the fake saw two calls and holds one message', async () => {
    slack.script({ status: 429, retryAfter: 1, times: 1 });
    const first = await post('once');
    expect(first.error?.message).toMatch(/429|ratelimited|rate limit/i);
    expect(slack.state().channels['#ops'].messages).toEqual([]);
    slack.reset();
    slack.script({ status: 429, retryAfter: 1, times: 1 });
    const response = await withRetries(() => post('once'), 2);
    expect(response.error).toBeUndefined();
    expect(slack.requests().map((r) => [r.path, r.status])).toEqual([['/chat.postMessage', 429], ['/chat.postMessage', 200]]);
    expect(slack.state().channels['#ops'].messages.map((m) => m.text)).toEqual(['once']);
  });

  it('with a wrong token the fake refuses and the node error names authentication', async () => {
    const response = await post('nope', 'xoxb-wrong-token');
    expect(response.error?.message).toMatch(/unauthorized|invalid_auth|token/i);
    expect(slack.requests()[0]).toMatchObject({ refused: true });
    expect(slack.state().channels['#ops'].messages).toEqual([]);
  });
});
