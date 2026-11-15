/**
 * The AI cap templates (docs/llm-gateway.md#asking-for-a-higher-cap): the cap-raise flow. The helpers belong to
 * builtin.ts, which passes them in (`aiTemplates(helpers)`), so there is no import cycle.
 */
import type { WorkflowNode } from '@landflow/engine';
import type { TemplateDetail } from '../../shared/templates';

type Helpers = {
  template: (def: never) => TemplateDetail;
  node: (id: string, name: string, type: string, position: [number, number], parameters?: Record<string, unknown>, extra?: Partial<WorkflowNode>) => WorkflowNode;
  main: (source: string, target: string, sourceIndex?: number, targetIndex?: number) => unknown;
  daily: (hour: number, minute?: number) => Record<string, unknown>;
  SLOT: unknown;
};

export function aiTemplates(h: Helpers): TemplateDetail[] {
  const { node, main } = h;
  const template = h.template as (def: unknown) => TemplateDetail;
  return [
    template({
      id: 'ai-cap-raise',
      name: 'Cap raise: an admin approves a higher AI cap',
      description:
        'When someone asks for a higher AI cap on Insights → AI, an admin other than them decides in Ask a Person. Approval raises the Landflow cap and, when the budgets sync is on, the LiteLLM budget. Nothing changes before that.',
      categories: ['it-ops', 'ai'],
      setup: [
        'An admin turns this flow on once, from Insights → AI. Until then nobody can ask for a higher cap.',
        'The request reaches every owner and admin except the person who asked, in Needs you. It asks in chat; switch Ask a Person to Slack or email if you prefer.',
        'If nobody answers in 3 days the request is rejected and nothing changes.',
      ],
      nodes: [
        node('request', 'Cap Raise Request', 'capRaiseTrigger', [0, 0]),
        node('ask', 'Ask a Person', 'confirmDraft', [260, 0], {
          title: 'Raise the {{ $json.period }} {{ $json.metric }} cap of {{ $json.subject }}?',
          draft: 'Now: {{ $json.current }}\nAsked for: {{ $json.requested }}\nWhy: {{ $json.reason }}\nAsked by: {{ $json.requestedBy.name }}',
          channel: 'chat',
          approvers: '{{ $json.approvers }}',
          allowEdit: false,
          timeoutMinutes: 4320,
          onTimeout: 'reject',
        }),
        node('approved', 'Apply Cap Raise', 'applyCapRaise', [520, -80], { requestId: '{{ $node["Cap Raise Request"].json.requestId }}', decision: 'approved' }),
        node('rejected', 'Record the No', 'applyCapRaise', [520, 80], { requestId: '{{ $node["Cap Raise Request"].json.requestId }}', decision: 'rejected' }),
      ],
      links: [main('request', 'ask'), main('ask', 'approved', 0), main('ask', 'rejected', 1)],
      notes: [
        {
          id: 'note_1',
          content: 'Nothing changes until an admin other than the requester approves. Approval changes the Landflow cap and, when the budgets sync is on, the LiteLLM budget.',
          position: [0, 160],
          width: 420,
          height: 120,
          color: 5,
        },
      ],
    }),
  ];
}
