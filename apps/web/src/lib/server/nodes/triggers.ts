/** Triggers: manual, webhook, chat, schedule and error. Forms are in forms.ts, agent and sub-workflow calls in agents.ts. */
import { defineNode } from '@landflow/sdk';
import { authenticationProperty, ipWhitelistOption, webhookAuthCredentials } from './webhook-auth';

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
    credentials: webhookAuthCredentials,
    color: '#f97316',
    subtitle: '{{method}} /{{path}}',
    inputs: [],
    outputs: out,
    properties: [
      { name: 'path', displayName: 'Path', type: 'string', default: 'my-hook', required: true, noDataExpression: true },
      authenticationProperty(),
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
          { name: 'Using ‘Respond to Webhook’ Node', value: 'responseNode', description: 'Send what a Respond to Webhook node returns, when it runs' },
          { name: 'Streaming', value: 'streaming', description: 'Stream what AI Agent and chain nodes write as it arrives: SSE for Accept: text/event-stream, else NDJSON chunks' },
        ],
      },
      {
        name: 'options',
        displayName: 'Options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        values: [
          { name: 'binaryPropertyName', displayName: 'Binary Property', type: 'string', default: 'data', description: 'Where a file sent as the whole body goes (item.binary.<name>)' },
          { name: 'rawBody', displayName: 'Raw Body', type: 'boolean', default: false, description: 'Keep any body, also JSON or text, as a file instead of parsing it' },
          ipWhitelistOption,
        ],
      },
      {
        name: 'notice',
        displayName:
          'Production webhooks run the published version: publish the workflow to serve them. Items contain { method, path, headers, query, body } (and jwtPayload with JWT Auth). Uploaded files (multipart parts, or a PDF, image or other non-text body) arrive as binary data. A run that starts waiting first answers { status: "waiting", executionId }.',
        type: 'notice',
      },
    ],
  },
  execute: (ctx) => [ctx.getInputData()],
});

/**
 * Chat Message trigger: the editor's chat panel, and — made public — the hosted chat page /chat/<workflow id or
 * path>, the embeddable widget (/chat/widget.js) and the chat API (lib/server/chat). Each message becomes an item
 * `{ chatInput, sessionId, action }`; uploaded files arrive as binary `data0`, `data1`…
 */
const whenPublic = { show: { public: [true] } };
export const chatTrigger = defineNode({
  description: {
    name: 'chatTrigger',
    displayName: 'Chat Message',
    description: 'Start the workflow from a chat: the editor’s chat panel, a hosted chat page or a widget — pairs with the AI Agent',
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
        displayName: 'Each chat message becomes an item { chatInput, sessionId }. Uploaded files arrive as binary data0, data1…',
        type: 'notice',
      },
      {
        name: 'public',
        displayName: 'Make Chat Publicly Available',
        type: 'boolean',
        default: false,
        noDataExpression: true,
        description: 'Serve a chat page at /chat/<workflow id or path> and the embeddable widget while the workflow is Active',
      },
      {
        name: 'path',
        displayName: 'Path',
        type: 'string',
        default: '',
        noDataExpression: true,
        placeholder: 'support',
        description: 'The chat’s address: /chat/<path>. Empty: the workflow id.',
        displayOptions: whenPublic,
      },
      { name: 'title', displayName: 'Title', type: 'string', default: 'Hi there! 👋', displayOptions: whenPublic },
      { name: 'subtitle', displayName: 'Subtitle', type: 'string', default: 'Start a chat. We’re here to help you 24/7.', displayOptions: whenPublic },
      {
        name: 'initialMessages',
        displayName: 'Initial Message(s)',
        type: 'string',
        default: 'Hi there! 👋\nMy name is Nathan. How can I assist you today?',
        typeOptions: { rows: 3 },
        description: 'Shown when a chat opens, one message per line',
        displayOptions: whenPublic,
      },
      { name: 'inputPlaceholder', displayName: 'Input Placeholder', type: 'string', default: 'Type your question…', displayOptions: whenPublic },
      {
        name: 'responseMode',
        displayName: 'Response Mode',
        type: 'options',
        default: 'streaming',
        noDataExpression: true,
        options: [
          { name: 'Streaming', value: 'streaming', description: 'Text appears as the AI Agent writes it (SSE)' },
          { name: 'When Last Node Finishes', value: 'lastNode', description: 'The last node’s output, in one piece' },
        ],
        displayOptions: whenPublic,
      },
      {
        name: 'authentication',
        displayName: 'Authentication',
        type: 'options',
        default: 'none',
        noDataExpression: true,
        options: [
          { name: 'None', value: 'none' },
          { name: 'Basic Auth', value: 'basicAuth', description: 'The browser asks for a user name and password (hosted page only, not the widget)' },
        ],
        displayOptions: whenPublic,
      },
      { name: 'basicAuthUser', displayName: 'User', type: 'string', default: '', noDataExpression: true, displayOptions: { show: { public: [true], authentication: ['basicAuth'] } } },
      {
        name: 'basicAuthPassword',
        displayName: 'Password',
        type: 'string',
        default: '',
        noDataExpression: true,
        typeOptions: { password: true },
        displayOptions: { show: { public: [true], authentication: ['basicAuth'] } },
      },
      {
        name: 'loadPreviousSession',
        displayName: 'Load Previous Session',
        type: 'boolean',
        default: true,
        description: 'Show a returning visitor their earlier messages (kept by Landflow per session)',
        displayOptions: whenPublic,
      },
      { name: 'allowFileUploads', displayName: 'Allow File Uploads', type: 'boolean', default: false, displayOptions: whenPublic },
      {
        name: 'allowedFilesMimeTypes',
        displayName: 'Allowed File Types',
        type: 'string',
        default: 'image/*,application/pdf',
        description: 'MIME types visitors may attach, comma-separated (image/* matches every image)',
        displayOptions: { show: { public: [true], allowFileUploads: [true] } },
      },
      {
        name: 'allowedOrigins',
        displayName: 'Allowed Origins (CORS)',
        type: 'string',
        default: '*',
        noDataExpression: true,
        placeholder: 'https://example.com, https://app.example.com',
        description: 'Sites that may embed the widget or call the chat API, comma-separated. * allows any.',
        displayOptions: whenPublic,
      },
    ],
  },
  execute: (ctx) => [ctx.getInputData()],
});

const hourOptions = Array.from({ length: 24 }, (_, h) => ({ name: h === 0 ? 'Midnight' : h === 12 ? 'Noon' : h < 12 ? `${h}am` : `${h - 12}pm`, value: h }));
const weekdayOptions = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((name, value) => ({ name, value }));
const showFor = (...field: string[]) => ({ show: { field } });

/**
 * n8n's Schedule Trigger. "Rules" (n8n's Trigger Rules): every N seconds, minutes or hours (at a
 * minute), days, weeks (on weekdays) or months (on a day), at a time of day, or a cron expression
 * (five fields, or six with seconds first), in the workflow's time zone (Settings), else the host's.
 * The older "every N seconds / minutes / hours" counts from activation, as before.
 */
export const scheduleTrigger = defineNode({
  description: {
    name: 'schedule',
    displayName: 'Schedule',
    description: 'Run the workflow on a schedule while it is Active',
    version: 1,
    kind: 'trigger',
    triggerSource: 'schedule',
    categories: ['Triggers'],
    icon: 'lucide:alarm-clock',
    color: '#f97316',
    subtitle: '{{unit}}',
    keywords: ['schedule', 'cron', 'interval', 'timer', 'every', 'daily', 'weekly'],
    inputs: [],
    outputs: out,
    properties: [
      {
        name: 'unit',
        displayName: 'Trigger Mode',
        type: 'options',
        default: 'rules',
        noDataExpression: true,
        options: [
          { name: 'Rules', value: 'rules', description: 'Intervals at times of day, weekdays, days of the month, or cron' },
          { name: 'Every N Seconds', value: 'seconds', description: 'Counted from activation' },
          { name: 'Every N Minutes', value: 'minutes', description: 'Counted from activation' },
          { name: 'Every N Hours', value: 'hours', description: 'Counted from activation' },
        ],
      },
      { name: 'every', displayName: 'Every', type: 'number', default: 5, noDataExpression: true, typeOptions: { minValue: 1 }, displayOptions: { show: { unit: ['seconds', 'minutes', 'hours'] } } },
      {
        name: 'rule',
        displayName: 'Trigger Rules',
        type: 'fixedCollection',
        typeOptions: { multipleValues: true },
        placeholder: 'Add rule',
        default: { interval: [{ field: 'days', daysInterval: 1, triggerAtHour: 9, triggerAtMinute: 0 }] },
        displayOptions: { show: { unit: ['rules'] } },
        description: 'The workflow runs whenever any rule matches',
        groups: [
          {
            name: 'interval',
            displayName: 'Trigger Interval',
            values: [
              {
                name: 'field',
                displayName: 'Trigger Interval',
                type: 'options',
                default: 'days',
                options: [
                  { name: 'Seconds', value: 'seconds' },
                  { name: 'Minutes', value: 'minutes' },
                  { name: 'Hours', value: 'hours' },
                  { name: 'Days', value: 'days' },
                  { name: 'Weeks', value: 'weeks' },
                  { name: 'Months', value: 'months' },
                  { name: 'Custom (Cron)', value: 'cronExpression' },
                ],
              },
              { name: 'secondsInterval', displayName: 'Seconds Between Triggers', type: 'number', default: 30, typeOptions: { minValue: 1, maxValue: 59 }, displayOptions: showFor('seconds') },
              { name: 'minutesInterval', displayName: 'Minutes Between Triggers', type: 'number', default: 5, typeOptions: { minValue: 1, maxValue: 59 }, displayOptions: showFor('minutes') },
              { name: 'hoursInterval', displayName: 'Hours Between Triggers', type: 'number', default: 1, typeOptions: { minValue: 1, maxValue: 23 }, displayOptions: showFor('hours') },
              { name: 'daysInterval', displayName: 'Days Between Triggers', type: 'number', default: 1, typeOptions: { minValue: 1, maxValue: 31 }, displayOptions: showFor('days') },
              { name: 'weeksInterval', displayName: 'Weeks Between Triggers', type: 'number', default: 1, typeOptions: { minValue: 1 }, displayOptions: showFor('weeks') },
              { name: 'monthsInterval', displayName: 'Months Between Triggers', type: 'number', default: 1, typeOptions: { minValue: 1, maxValue: 12 }, displayOptions: showFor('months') },
              { name: 'triggerAtDay', displayName: 'Trigger on Weekdays', type: 'multiOptions', default: [1], options: weekdayOptions, displayOptions: showFor('weeks') },
              { name: 'triggerAtDayOfMonth', displayName: 'Trigger at Day of Month', type: 'number', default: 1, typeOptions: { minValue: 1, maxValue: 31 }, displayOptions: showFor('months') },
              { name: 'triggerAtHour', displayName: 'Trigger at Hour', type: 'options', default: 9, options: hourOptions, displayOptions: showFor('days', 'weeks', 'months') },
              { name: 'triggerAtMinute', displayName: 'Trigger at Minute', type: 'number', default: 0, typeOptions: { minValue: 0, maxValue: 59 }, displayOptions: showFor('hours', 'days', 'weeks', 'months') },
              {
                name: 'expression',
                displayName: 'Expression',
                type: 'string',
                default: '0 9 * * 1-5',
                placeholder: 'e.g. 0 15 * 1 sun',
                description: 'minute hour day-of-month month day-of-week, or six fields with seconds first',
                displayOptions: showFor('cronExpression'),
              },
            ],
          },
        ],
      },
      {
        name: 'notice',
        displayName: 'Runs while the workflow is Active, in the workflow’s time zone (Settings), else the server’s.',
        type: 'notice',
        displayOptions: { show: { unit: ['rules'] } },
      },
    ],
  },
  execute: (ctx) => [ctx.getInputData().map((item) => ({ json: { ...item.json, firedAt: new Date().toISOString() } }))],
});

/**
 * n8n's Error Trigger: starts an error workflow, the one other workflows name in Settings → Error
 * workflow, when one of their non-manual executions fails. Run in the editor, it emits an example.
 */
export const errorTrigger = defineNode({
  description: {
    name: 'errorTrigger',
    displayName: 'Error Trigger',
    description: 'Start this workflow when another workflow fails',
    version: 1,
    kind: 'trigger',
    // "Run" in the editor starts here with an example; failures start it from the runner.
    triggerSource: 'manual',
    categories: ['Triggers'],
    icon: 'lucide:triangle-alert',
    color: '#ef4444',
    keywords: ['error', 'failure', 'alert', 'error workflow', 'on error'],
    inputs: [],
    outputs: out,
    properties: [
      {
        name: 'notice',
        displayName:
          'Pick this workflow under Settings → Error workflow of the workflows to watch. When one of their non-manual runs fails, this one starts with { execution: { id, url, error, lastNodeExecuted, mode }, workflow: { id, name } }.',
        type: 'notice',
      },
    ],
  },
  execute(ctx) {
    const items = ctx.getInputData();
    if (items.some((item) => Object.keys(item.json).length)) return [items];
    // A manual run: an example of what a failure hands over.
    return [
      [
        {
          json: {
            execution: {
              id: 'ex_example',
              url: `/workflows/wf_example/executions/ex_example`,
              error: { message: 'Example error message', stack: 'Error: Example error message' },
              lastNodeExecuted: 'Node With Error',
              mode: 'trigger',
            },
            workflow: { id: 'wf_example', name: 'Example Workflow' },
          },
        },
      ],
    ];
  },
});
