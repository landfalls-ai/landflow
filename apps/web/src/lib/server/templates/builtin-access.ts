/**
 * The access-request templates (docs/access-requests.md): the request flow and the chat flow. An admin installs both once from the
 * Access page (access/setup.ts); a copy from the gallery never handles requests (only the installed flow is armed). The helpers belong
 * to builtin.ts, which passes them in, so there is no import cycle.
 */
import type { WorkflowNode } from '@landflow/engine';
import type { TemplateDetail } from '../../shared/templates';

type Link = [type: string, source: string, target: string, sourceIndex?: number, targetIndex?: number];
type Helpers = {
  template: (def: never) => TemplateDetail;
  node: (id: string, name: string, type: string, position: [number, number], parameters?: Record<string, unknown>, extra?: never) => WorkflowNode;
  main: (source: string, target: string, sourceIndex?: number, targetIndex?: number) => Link;
  model: (source: string, target: string, targetIndex?: number) => Link;
  memory: (source: string, target: string) => Link;
  tool: (source: string, target: string) => Link;
  SLOT: { anthropic: unknown };
};

export const ASK_NODE = 'Ask the approver';

export function accessTemplates(h: Helpers): TemplateDetail[] {
  const { node, main, model, memory, tool, SLOT } = h;
  const template = h.template as (def: unknown) => TemplateDetail;
  const note = (position: [number, number]) => ({
    id: 'note_1',
    content: 'Requests reach only the flow set up on the Access page. Nothing is granted until an approver other than the requester approves.',
    position,
    width: 460,
    height: 100,
    color: 5,
  });
  return [
    template({
      id: 'access-requests',
      name: 'Access requests: ask, approve, grant',
      description:
        'When someone asks for access on the Access page, the entry’s approvers decide in Ask a Person (they may allow a shorter time). Approval grants the access for the time allowed and Landflow takes it back when it ends. Nothing is granted before an approver other than the requester says yes.',
      categories: ['it-ops'],
      setup: [
        'An admin turns this flow on once, from the Access page. Until then nobody can ask.',
        'The request reaches the entry’s approvers (never the person who asked) in Needs you. With the host’s SMTP configured it is an email with signed links instead.',
        'A Slack answer cannot be matched to a person, so it never grants. A link approves the time that was asked. To tell a channel in Slack, add a Slack node after Grant.',
        'If nobody answers in 3 days the request expires and nothing is granted.',
      ],
      nodes: [
        node('request', 'Access Request', 'accessRequestTrigger', [0, 0]),
        node('ask', ASK_NODE, 'confirmDraft', [260, 0], {
          title: '{{ $json.askTitle }}',
          draft: '{{ $json.askText }}',
          channel: 'chat',
          emails: '{{ $json.approvers }}',
          approvers: '{{ $json.approvers }}',
          choices: '{{ $json.durationChoices }}',
          peopleOnly: true,
          allowEdit: false,
          timeoutMinutes: 4320,
          onTimeout: 'reject',
        }),
        node('grant', 'Grant', 'accessDecision', [520, -80], { requestId: '{{ $node["Access Request"].json.requestId }}', decision: 'approved', steps: ASK_NODE }),
        node('no', 'Record the no', 'accessDecision', [520, 80], { requestId: '{{ $node["Access Request"].json.requestId }}', decision: 'rejected', steps: ASK_NODE }),
      ],
      links: [main('request', 'ask'), main('ask', 'grant', 0), main('ask', 'no', 1)],
      notes: [note([0, 180])],
    }),
    template({
      id: 'access-requests-chat',
      name: 'Access requests: ask in a chat',
      description:
        'A chat where people ask for access in their own words. The assistant reads the request back and files it only after the person says yes in a later message. It can only file; people approve and Landflow grants.',
      categories: ['it-ops', 'ai'],
      setup: ['Pick your Anthropic credential in the setup step (the admin does this when setting up access requests).', 'The chat is for signed-in people on the Access page; it is not public.'],
      nodes: [
        node('chat', 'When chat message received', 'chatTrigger', [0, 0]),
        node('agent', 'Access assistant', 'aiAgent', [260, -6], {
          systemMessage:
            'You help people ask for access. You can only file a request with the File Access Request tool. Read the request back and file it only after the person says yes in a later message. Only GitHub entries need a GitHub username; never ask for one for a Google group or a manual entry, leave the account empty. When the entry or the duration is unclear, call the tool without a token and let it list the choices instead of guessing. You never grant, approve or promise access.',
        }),
        node('claude', 'Anthropic Chat Model', 'anthropicChatModel', [220, 200], { model: 'claude-sonnet-5-5' }, { uses: [SLOT.anthropic] } as never),
        node('memory', 'Simple Memory', 'simpleMemory', [330, 200], {}),
        node('file', 'File Access Request', 'fileAccessRequest', [460, 200], {
          entry: "{{ $fromAI('entry', 'The name of the access asked for', 'string') }}",
          duration: "{{ $fromAI('duration', 'How long, for example 1 h, 15 min or unlimited', 'string') }}",
          reason: "{{ $fromAI('reason', 'Why the person needs it', 'string') }}",
          account: "{{ $fromAI('account', 'The person’s GitHub username, when the entry needs one, else empty', 'string', '') }}",
          confirmToken: "{{ $fromAI('confirmToken', 'Empty on the first call; the token from the first answer once the person confirmed in a later message', 'string', '') }}",
        }),
      ],
      links: [main('chat', 'agent'), model('claude', 'agent'), memory('memory', 'agent'), tool('file', 'agent')],
      notes: [note([0, 360])],
    }),
  ];
}
