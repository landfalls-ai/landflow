/**
 * The cap-raise flow's two nodes (docs/llm-gateway.md#asking-for-a-higher-cap):
 *
 * - Cap Raise Request (`core.capRaiseTrigger`) starts the flow once for each request made on Insights → AI
 *   (llm-gateway/cap-raise-trigger.ts). Pair it with Ask a Person.
 * - Apply Cap Raise (`core.applyCapRaise`) settles the request after Ask a Person. Wire its "Decision" to "Approved" on
 *   the Approved branch and "Rejected" on the Rejected one. It never trusts its input item: an approval counts only when
 *   the server's own record of this run shows an owner or admin other than the requester approved it.
 */
import { defineNode, NodeOperationError, type JsonObject } from '@landflow/sdk';
import { applyCapRequest, CapRequestError } from '../llm-gateway/cap-requests';

const main = [{ type: 'main' as const }];

export const capRaiseTriggerNode = defineNode({
  description: {
    name: 'capRaiseTrigger',
    displayName: 'Cap Raise Request',
    description: 'Start the workflow when someone asks for a higher AI cap',
    version: 1,
    kind: 'trigger',
    // "Run" in the editor starts here with an example; a request starts it once the workflow is published.
    triggerSource: 'manual',
    categories: ['Triggers', 'AI'],
    icon: 'lucide:gauge',
    color: '#f59e0b',
    subtitle: 'a request for a higher cap',
    keywords: ['cap', 'budget', 'raise', 'ai usage', 'limit', 'request', 'approval'],
    inputs: [],
    outputs: main,
    properties: [
      {
        name: 'notice',
        displayName: 'Starts once per request made on Insights → AI. Pair it with Ask a Person.',
        type: 'notice',
      },
    ],
  },
  execute(ctx) {
    const items = ctx.getInputData();
    if (items.some((item) => Object.keys(item.json).length)) return [items];
    // A manual run: an example of what a request hands over.
    return [
      [
        {
          json: {
            requestId: 'acr_example',
            capId: 'user:usr_example:day:cost',
            subject: 'user “Example”',
            metric: 'cost',
            period: 'day',
            current: 5,
            requested: 20,
            reason: 'A longer report to finish today',
            requestedBy: { id: 'usr_example', name: 'Example' },
            approvers: 'admin@example.com',
          },
        },
      ],
    ];
  },
});

export const applyCapRaiseNode = defineNode({
  description: {
    name: 'applyCapRaise',
    displayName: 'Apply Cap Raise',
    description: 'Change the cap a request asked for, and tell the budgets sync, only after an admin other than the requester approved it',
    version: 1,
    kind: 'action',
    categories: ['AI'],
    icon: 'lucide:gauge',
    color: '#f59e0b',
    subtitle: '{{decision}}',
    keywords: ['cap', 'budget', 'raise', 'ai usage', 'apply', 'approval'],
    inputs: main,
    outputs: main,
    properties: [
      { name: 'requestId', displayName: 'Request ID', type: 'string', default: '', required: true, description: 'The request to settle; the template reads it from Cap Raise Request. It must be the one this run started.' },
      {
        name: 'decision',
        displayName: 'Decision',
        type: 'options',
        default: 'approved',
        noDataExpression: true,
        options: [
          { name: 'Approved', value: 'approved', description: 'For the Approved branch of Ask a Person: changes the cap, if the run’s own record shows an admin other than the requester approved' },
          { name: 'Rejected', value: 'rejected', description: 'For the Rejected branch: records the no and its comment; changes nothing' },
        ],
      },
    ],
  },
  async execute(ctx) {
    const items = ctx.getInputData();
    const out: Array<{ json: JsonObject; pairedItem: { item: number } }> = [];
    for (let i = 0; i < items.length; i++) {
      const requestId = String(ctx.getNodeParameter('requestId', i, '') ?? '').trim();
      if (!requestId) throw new NodeOperationError('Set the request ID', { itemIndex: i });
      const decision = String(ctx.getNodeParameter('decision', i, 'approved')) === 'rejected' ? 'rejected' : 'approved';
      try {
        const done = await applyCapRequest(requestId, ctx.getExecutionId(), decision);
        out.push({ json: { requestId, status: done.status, ...(done.gateway && { gateway: done.gateway }) }, pairedItem: { item: i } });
      } catch (caught) {
        if (caught instanceof CapRequestError) throw new NodeOperationError(caught.message, { itemIndex: i });
        throw caught;
      }
    }
    return [out];
  },
});
