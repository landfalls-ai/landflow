/**
 * GitHub to Work Event (docs/features/integrations.md#github-into-the-brain): turns a GitHub Webhook Trigger item into a
 * flat work.* item for Record Event. Deliveries that are not a work fact (a push, a comment, a pending status) are dropped.
 */
import { defineNode, type JsonObject, type NodeItem } from '@landflow/sdk';
import { githubToWork, parsePeople } from '../brain/github-work';

const main = [{ type: 'main' as const }];

export const githubWorkEventNode = defineNode({
  description: {
    name: 'githubWorkEvent',
    displayName: 'GitHub to Work Event',
    description: 'Turn a GitHub delivery (pull request, review, CI result) into one work event for the second brain; anything else is dropped. No diffs, code or review text are kept',
    version: 1,
    kind: 'action',
    categories: ['AI', 'Core'],
    icon: 'lucide:git-pull-request',
    color: '#24292F',
    keywords: ['github', 'pull request', 'review', 'ci', 'work event', 'second brain', 'webhook'],
    inputs: main,
    outputs: main,
    properties: [
      {
        name: 'people',
        displayName: 'People (JSON)',
        type: 'json',
        default: '{}',
        description: 'GitHub login to email, such as {"octo-dev": "dev@example.com"}. Sets the event’s actor email so person pages match; without it the actor is the login',
      },
      {
        name: 'notice',
        displayName:
          'Input: a GitHub Webhook Trigger item. Output: { kind, source, sourceId, occurredAt, title, summary, url, repo, actor, actorEmail, prNumber, state, reviewState, ci, waitedMs } for pull requests opened, merged, closed or review-requested, reviews submitted, and workflow runs or commit statuses that passed or failed.',
        type: 'notice',
      },
    ],
  },
  execute(ctx) {
    const out: NodeItem[] = [];
    const items = ctx.getInputData();
    items.forEach((item, i) => {
      const json = item.json as Record<string, unknown>;
      const headers = (typeof json.headers === 'object' && json.headers !== null ? json.headers : {}) as Record<string, unknown>;
      const event = String(json.event ?? headers['x-github-event'] ?? '');
      const mapped = githubToWork(event, json.body, parsePeople(ctx.getNodeParameter('people', i, {})));
      if (mapped) out.push({ json: JSON.parse(JSON.stringify(mapped)) as JsonObject });
    });
    return [out];
  },
});
