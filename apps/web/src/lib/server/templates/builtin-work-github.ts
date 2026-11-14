/**
 * "Work from GitHub into the second brain" (docs/features/integrations.md#github-into-the-brain): the productivity plugin's
 * GitHub Webhook Trigger → GitHub to Work Event → Record work event, and the repository kept as a system entity.
 * The builders are private to builtin.ts, so it hands them in.
 */
import type { WorkflowConnection, WorkflowNode } from '@landflow/engine';
import type { TemplateCredentialSlot, TemplateDetail } from '../../shared/templates';

type Slot = TemplateCredentialSlot & { key: string };
type Link = [type: WorkflowConnection['type'], source: string, target: string, sourceIndex?: number, targetIndex?: number];
export interface WorkGithubHelpers {
  template: (def: { id: string; name: string; description: string; categories: Array<'productivity' | 'data'>; setup: string[]; nodes: WorkflowNode[]; links: Link[] }) => TemplateDetail;
  node: (id: string, name: string, type: string, position: [number, number], parameters?: Record<string, unknown>, extra?: Partial<WorkflowNode> & { uses?: Slot[] }) => WorkflowNode;
  main: (source: string, target: string, sourceIndex?: number, targetIndex?: number) => Link;
  slot: Slot;
}

const ATTRIBUTES =
  '{{ ({ source: $json.source, sourceId: $json.sourceId, url: $json.url, actor: $json.actorEmail || $json.actor, title: $json.title, summary: $json.summary, repo: $json.repo, prNumber: $json.prNumber, state: $json.state, reviewState: $json.reviewState, ciConclusion: ($json.ci || {}).conclusion, ciDurationMs: ($json.ci || {}).durationMs, ciAttempt: ($json.ci || {}).attempt, waitedMs: $json.waitedMs, occurredAt: $json.occurredAt }) }}';

export function workGithubTemplates(h: WorkGithubHelpers): TemplateDetail[] {
  const { template, node, main, slot } = h;
  return [
    template({
      id: 'work-github',
      name: 'Work from GitHub into the second brain',
      description: 'Pull requests opened, merged, closed or waiting for review, reviews (their state only) and CI results in GitHub become work events in the second brain, and each repository is kept as a system. No diffs, code or review text come in.',
      categories: ['productivity', 'data'],
      setup: [
        'Needs the **productivity** plugin (it holds the GitHub Webhook Trigger). Pick or add a GitHub token that can create webhooks: admin:repo_hook, or Webhooks read and write on a fine-grained token.',
        'Choose the repository in the trigger. Publishing registers the webhook and unpublishing removes it, so Landflow must be reachable from GitHub (a public URL).',
        'In **GitHub to Work Event**, set **People** to a JSON table of GitHub login to email, such as `{"octo-dev": "dev@example.com"}`, so person pages match. Without it the actor is the login.',
        'Declare the work kinds once with `pnpm brain:work-kinds` (or leave **Declare Kind If New** on in **Record work event**). Publish; the events show in **Insights**.',
      ],
      nodes: [
        node('trigger', 'GitHub Webhook Trigger', 'productivity.githubWebhookTrigger', [0, 0], { events: ['pull_request', 'pull_request_review', 'workflow_run', 'status'] }, { uses: [slot] }),
        node('map', 'GitHub to Work Event', 'githubWorkEvent', [260, 0], { people: '{}' }),
        node('record', 'Record work event', 'recordEvent', [520, -80], { kind: '{{ $json.kind }}', attributes: ATTRIBUTES, declareIfNew: true, message: '{{ $json.title }}' }),
        node('repo', 'Keep the repository', 'brainEntity', [520, 100], {
          operation: 'upsert',
          type: 'system',
          entityId: "{{ String($json.repo).toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) }}",
          name: '{{ $json.repo }}',
          attributes: '{{ ({ lastSource: $json.source, lastSeenAt: $json.occurredAt }) }}',
        }),
      ],
      links: [main('trigger', 'map'), main('map', 'record'), main('map', 'repo')],
    }),
  ];
}
