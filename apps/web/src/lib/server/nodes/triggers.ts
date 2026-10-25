import { defineNode } from '@landflow/sdk';

const out = [{ type: 'main' as const }];

/** Triggers pass through whatever the host's event source handed them. */
export const manualTrigger = defineNode({
  description: {
    name: 'manualTrigger',
    displayName: 'Manual Trigger',
    description: 'Start the workflow by clicking “Run” in the editor',
    version: 1,
    kind: 'trigger',
    triggerSource: 'manual',
    categories: ['Triggers'],
    icon: 'lucide:mouse-pointer-click',
    color: '#f97316',
    inputs: [],
    outputs: out,
    properties: [
      {
        name: 'notice',
        displayName: 'This node emits one empty item when you run the workflow manually.',
        type: 'notice',
      },
    ],
  },
  execute: (ctx) => [ctx.getInputData()],
});

export const webhookTrigger = defineNode({
  description: {
    name: 'webhook',
    displayName: 'Webhook',
    description: 'Start the workflow when an HTTP request hits /api/webhook/<path>',
    version: 1,
    kind: 'trigger',
    triggerSource: 'webhook',
    categories: ['Triggers'],
    icon: 'lucide:webhook',
    color: '#f97316',
    subtitle: '{{method}} /{{path}}',
    inputs: [],
    outputs: out,
    properties: [
      { name: 'path', displayName: 'Path', type: 'string', default: 'my-hook', required: true, noDataExpression: true },
      {
        name: 'method',
        displayName: 'HTTP Method',
        type: 'options',
        default: 'POST',
        noDataExpression: true,
        options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => ({ name: m, value: m })),
      },
      {
        name: 'respond',
        displayName: 'Respond',
        type: 'options',
        default: 'lastNode',
        noDataExpression: true,
        options: [
          { name: 'When last node finishes', value: 'lastNode', description: 'Return the last node’s output as JSON' },
          { name: 'Immediately', value: 'immediately', description: 'Return 202 with the execution id' },
        ],
      },
      {
        name: 'notice',
        displayName: 'The workflow must be Active for production webhooks. Items contain { method, path, headers, query, body }.',
        type: 'notice',
      },
    ],
  },
  execute: (ctx) => [ctx.getInputData()],
});

export const chatTrigger = defineNode({
  description: {
    name: 'chatTrigger',
    displayName: 'Chat Message',
    description: 'Start the workflow from the editor’s chat panel — pairs with the AI Agent',
    version: 1,
    kind: 'trigger',
    triggerSource: 'chat',
    categories: ['Triggers', 'AI'],
    icon: 'lucide:message-circle',
    color: '#f97316',
    inputs: [],
    outputs: out,
    properties: [
      {
        name: 'notice',
        displayName: 'Each chat message becomes an item { chatInput, sessionId }.',
        type: 'notice',
      },
    ],
  },
  execute: (ctx) => [ctx.getInputData()],
});

export const scheduleTrigger = defineNode({
  description: {
    name: 'schedule',
    displayName: 'Schedule',
    description: 'Run the workflow on a fixed interval while it is Active',
    version: 1,
    kind: 'trigger',
    triggerSource: 'schedule',
    categories: ['Triggers'],
    icon: 'lucide:alarm-clock',
    color: '#f97316',
    subtitle: 'every {{every}} {{unit}}',
    inputs: [],
    outputs: out,
    properties: [
      { name: 'every', displayName: 'Every', type: 'number', default: 5, noDataExpression: true, typeOptions: { minValue: 1 } },
      {
        name: 'unit',
        displayName: 'Unit',
        type: 'options',
        default: 'minutes',
        noDataExpression: true,
        options: [
          { name: 'Seconds', value: 'seconds' },
          { name: 'Minutes', value: 'minutes' },
          { name: 'Hours', value: 'hours' },
        ],
      },
    ],
  },
  execute: (ctx) => [ctx.getInputData().map((item) => ({ json: { ...item.json, firedAt: new Date().toISOString() } }))],
});
