/**
 * The access-request flow's three nodes (docs/access-requests.md#the-nodes):
 *
 * - Access Request (`core.accessRequestTrigger`) starts the flow once for each request made on the Access page or in its chat
 *   (access/trigger.ts). Pair it with Ask a Person.
 * - Apply Access Decision (`core.accessDecision`) settles the request after Ask a Person. It never trusts its input item: a grant
 *   happens only when the server's record of this run shows an approver other than the requester approved (access/grants.ts).
 * - File Access Request (`core.fileAccessRequest`, an agent tool) files a request from the chat, after the person confirmed in a
 *   later message. It never grants and has no other operation (access/chat.ts).
 */
import { defineNode, NodeOperationError, type JsonObject } from '@landflow/sdk';

const main = [{ type: 'main' as const }];

export const accessRequestTriggerNode = defineNode({
  description: {
    name: 'accessRequestTrigger',
    displayName: 'Access Request',
    description: 'Start the workflow when someone asks for access on the Access page or in its chat',
    version: 1,
    kind: 'trigger',
    // "Run" in the editor starts here with an example; a request starts it once the workflow is the installed one and published.
    triggerSource: 'manual',
    categories: ['Triggers', 'Core'],
    icon: 'lucide:key-round',
    color: '#0ea5e9',
    subtitle: 'a request for access',
    keywords: ['access', 'request', 'grant', 'github', 'google', 'approval', 'permission'],
    inputs: [],
    outputs: main,
    properties: [{ name: 'notice', displayName: 'Starts once per request made on the Access page or in its chat. Pair it with Ask a Person.', type: 'notice' }],
  },
  execute(ctx) {
    const items = ctx.getInputData();
    if (items.some((item) => Object.keys(item.json).length)) return [items];
    // A manual run: an example of what a request hands over (Apply Access Decision answers it with a dry run).
    return [
      [
        {
          json: {
            requestId: 'areq_example',
            entry: { id: 'ae_example', name: 'Platform team', system: 'github-team', targetLabel: 'GitHub team acme/platform (member)' },
            requester: { id: 'usr_example', name: 'Example', email: 'example@example.com' },
            account: 'example-user',
            durationMinutes: 60,
            durationText: '1 h',
            reason: 'Fixing the build',
            channel: 'form',
            approvers: 'admin@example.com',
            durationChoices: '60: 1 h\n15: 15 min',
            summary: 'Example asks for Platform team\nWhat: GitHub team acme/platform (member)\nFor: 1 h\nAccount: example-user (unverified: typed by the requester)\n--- the requester wrote:\n“Fixing the build”',
            askTitle: 'Give Example Platform team for 1 h?',
            askText: 'Example asks for Platform team\nWhat: GitHub team acme/platform (member)\nFor: 1 h\nAccount: example-user (unverified: typed by the requester)\n--- the requester wrote:\n“Fixing the build”',
          },
        },
      ],
    ];
  },
});

export const accessDecisionNode = defineNode({
  description: {
    name: 'accessDecision',
    displayName: 'Apply Access Decision',
    description: 'Grant the access a request asked for, or record the no, only after an approver other than the requester decided',
    version: 1,
    kind: 'action',
    categories: ['Core'],
    icon: 'lucide:key-round',
    color: '#0ea5e9',
    subtitle: '{{decision}}',
    keywords: ['access', 'grant', 'approval', 'github', 'google', 'apply', 'decision'],
    inputs: main,
    outputs: main,
    properties: [
      { name: 'requestId', displayName: 'Request ID', type: 'string', default: '', required: true, description: 'The request to settle; the template reads it from Access Request. It must be the one this run started.' },
      {
        name: 'decision',
        displayName: 'Decision',
        type: 'options',
        default: 'approved',
        noDataExpression: true,
        options: [
          { name: 'Approved', value: 'approved', description: 'For the Approved branch of Ask a Person: grants, if the run’s own record shows an approver other than the requester approved' },
          { name: 'Rejected', value: 'rejected', description: 'For the Rejected branch: records the no and its comment, or the timeout; grants nothing' },
        ],
      },
      { name: 'steps', displayName: 'Approval Steps', type: 'string', default: 'Ask the approver', description: 'The names of the Ask a Person nodes, in step order, one per line. Each needs an approval by a different approver of that step.', typeOptions: { rows: 2 } },
      { name: 'failRun', displayName: 'Fail the Run on a Failed Grant', type: 'boolean', default: false, description: 'Off: a failed grant is an item with status “failed” and the reason, so the next step can tell someone' },
    ],
  },
  async execute(ctx) {
    const { applyDecision } = await import('../access/grants');
    const { AccessError } = await import('../access/errors');
    const items = ctx.getInputData();
    const out: Array<{ json: JsonObject; pairedItem: { item: number } }> = [];
    for (let i = 0; i < items.length; i++) {
      const requestId = String(ctx.getNodeParameter('requestId', i, '') ?? '').trim();
      if (!requestId) throw new NodeOperationError('Set the request ID', { itemIndex: i });
      const decision = String(ctx.getNodeParameter('decision', i, 'approved')) === 'rejected' ? 'rejected' : 'approved';
      const steps = String(ctx.getNodeParameter('steps', i, 'Ask the approver') ?? '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      try {
        const done = await applyDecision(requestId, ctx.getExecutionId(), decision, { steps: steps.length ? steps : ['Ask the approver'] });
        if (done.status === 'failed' && ctx.getNodeParameter('failRun', i, false)) throw new NodeOperationError(done.note ?? 'The grant failed', { itemIndex: i });
        out.push({ json: { requestId, status: done.status, ...(done.grantId && { grantId: done.grantId }), ...(done.until !== undefined && { until: done.until }), ...(done.note && { note: done.note }), ...(done.dryRun && { dryRun: true }) } as JsonObject, pairedItem: { item: i } });
      } catch (caught) {
        if (caught instanceof AccessError) throw new NodeOperationError(caught.message, { itemIndex: i });
        throw caught;
      }
    }
    return [out];
  },
});

export const fileAccessRequestNode = defineNode({
  description: {
    name: 'fileAccessRequest',
    displayName: 'File Access Request',
    description: 'Ask for access on behalf of the person in the chat, after they confirm it in a later message',
    version: 1,
    kind: 'action',
    categories: ['Core'],
    icon: 'lucide:key-round',
    color: '#0ea5e9',
    subtitle: '{{entry}}',
    keywords: ['access', 'request', 'chat', 'tool'],
    usableAsTool: true,
    toolDescription:
      'File a request for access. Arguments: `entry` (the name of what is asked), `duration` (for example “1 h”, “15 min”, “unlimited”), `reason`, `account` (the person’s GitHub username, when the entry needs one) and `confirmToken`. Call it first WITHOUT `confirmToken`: nothing is filed, and you get a summary and a token. Read the summary to the person and ask them to confirm. Only after they say yes in their next message, call it again with the same arguments and the token. It cannot approve or grant; only people do that.',
    inputs: main,
    outputs: main,
    properties: [
      { name: 'entry', displayName: 'Entry', type: 'string', default: '', description: 'The name (or ID) of the access asked for' },
      { name: 'duration', displayName: 'Duration', type: 'string', default: '', description: 'For example 1 h, 15 min, 2 days or unlimited; one the entry offers' },
      { name: 'reason', displayName: 'Reason', type: 'string', default: '', typeOptions: { rows: 2 } },
      { name: 'account', displayName: 'GitHub Username', type: 'string', default: '', description: 'Only for GitHub entries; kept for next time' },
      { name: 'confirmToken', displayName: 'Confirm Token', type: 'string', default: '', description: 'Empty to read the request back; the token from that answer to file it, in a later message' },
    ],
  },
  async execute(ctx) {
    const { fileAccessFromChat, isAccessChatRun } = await import('../access/chat');
    const { accessSettings } = await import('../access/store');
    const { liveExecution } = await import('../runner');
    const { store } = await import('../store');
    const record = liveExecution(ctx.getExecutionId()) ?? (await store.loadExecution(ctx.getExecutionId()));
    // Only a person's chat message names who is asking (`startedBy`: a Landflow user, or an outside requester's `ext_…` id, which
    // fileAccessFromChat resolves through access/principal.ts), and only in the installed chat flow's run that the Access page's or the
    // public request page's chat started: any other run (a copy, another flow, the hosted chat, a trigger) files nothing.
    const fromAccessChat = record?.mode === 'chat' && record.workflowId === accessSettings().chatWorkflowId && isAccessChatRun(ctx.getExecutionId());
    const userId = fromAccessChat ? record?.startedBy : undefined;
    const items = ctx.getInputData();
    const out: Array<{ json: JsonObject; pairedItem: { item: number } }> = [];
    for (let i = 0; i < Math.max(items.length, 1); i++) {
      const answer = await fileAccessFromChat({
        userId,
        executionId: ctx.getExecutionId(),
        entry: ctx.getNodeParameter('entry', i, ''),
        duration: ctx.getNodeParameter('duration', i, ''),
        reason: ctx.getNodeParameter('reason', i, ''),
        account: ctx.getNodeParameter('account', i, ''),
        confirmToken: ctx.getNodeParameter('confirmToken', i, ''),
      });
      out.push({ json: answer as unknown as JsonObject, pairedItem: { item: i } });
    }
    return [out];
  },
});
