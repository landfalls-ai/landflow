/**
 * Flow control: If, Switch, Filter, Merge, Wait, Loop Over Items, Respond to Webhook, Limit, Sort,
 * No Operation and Stop and Error.
 */
import { defineNode, NodeOperationError, type JsonObject, type NodeItem } from '@landflow/sdk';
import type { RunReply } from '../runner';
import { conditionProperties, matches, type Condition } from './conditions';
import { formFieldsProperty, formModeOf, pageOf } from './forms';

const main = [{ type: 'main' as const }];

export const ifNode = defineNode({
  description: {
    name: 'if',
    displayName: 'If',
    description: 'Route items down a true or false branch',
    version: 1,
    kind: 'action',
    categories: ['Flow'],
    icon: 'lucide:split',
    color: '#22c55e',
    inputs: main,
    outputs: [
      { type: 'main', displayName: 'true' },
      { type: 'main', displayName: 'false' },
    ],
    properties: conditionProperties,
  },
  execute(ctx) {
    const yes: NodeItem[] = [];
    const no: NodeItem[] = [];
    ctx.getInputData().forEach((item, i) => {
      const passed = matches({ conditions: ctx.getNodeParameter('conditions', i), combinator: ctx.getNodeParameter('combinator', i) });
      (passed ? yes : no).push({ ...item, pairedItem: { item: i } });
    });
    return [yes, no];
  },
});

/**
 * Rule outputs of the Switch. Descriptors declare a static `outputs` array (the
 * editor draws handles from it), so the node has a fixed set: "0"…"3" for the
 * rules or the output index, plus "Fallback".
 */
export const SWITCH_OUTPUTS = 4;

interface SwitchRule {
  conditions?: { condition?: Condition[] };
  combinator?: string;
}

export const switchNode = defineNode({
  description: {
    name: 'switch',
    displayName: 'Switch',
    description: 'Route items to different outputs by rules or by an output index',
    version: 1,
    kind: 'action',
    categories: ['Flow'],
    icon: 'lucide:signpost',
    color: '#22c55e',
    subtitle: '{{mode}}',
    keywords: ['switch', 'case', 'route', 'router', 'branch'],
    inputs: main,
    outputs: [...Array.from({ length: SWITCH_OUTPUTS }, (_, i) => ({ type: 'main' as const, displayName: String(i) })), { type: 'main', displayName: 'Fallback' }],
    properties: [
      {
        name: 'mode',
        displayName: 'Mode',
        type: 'options',
        default: 'rules',
        noDataExpression: true,
        options: [
          { name: 'Rules', value: 'rules', description: 'Build a matching rule for each output' },
          { name: 'Expression', value: 'expression', description: 'Write an expression that returns the output index' },
        ],
      },
      {
        name: 'rules',
        displayName: 'Routing Rules',
        type: 'fixedCollection',
        typeOptions: { multipleValues: true },
        description: `Rule 1 sends to output 0, rule 2 to output 1, and so on (up to ${SWITCH_OUTPUTS} rules)`,
        default: { values: [{ conditions: { condition: [{ left: '{{ $json.value }}', operator: 'equals', right: '' }] }, combinator: 'and' }] },
        displayOptions: { show: { mode: ['rules'] } },
        groups: [{ name: 'values', displayName: 'Rule', values: conditionProperties }],
      },
      {
        name: 'output',
        displayName: 'Output Index',
        type: 'number',
        default: 0,
        placeholder: '{{ $json.priority === "high" ? 0 : 1 }}',
        description: `The output to send the item to, from 0 to ${SWITCH_OUTPUTS - 1}`,
        displayOptions: { show: { mode: ['expression'] } },
      },
      {
        name: 'options',
        displayName: 'Options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        values: [
          {
            name: 'fallbackOutput',
            displayName: 'Fallback Output',
            type: 'options',
            default: 'none',
            description: 'Rules: what happens to items that match no rule',
            options: [
              { name: 'None (drop the item)', value: 'none' },
              { name: 'Extra Output', value: 'extra', description: 'Send it to the “Fallback” output' },
            ],
          },
          { name: 'allMatchingOutputs', displayName: 'Send Data to All Matching Outputs', type: 'boolean', default: false, description: 'Rules: not only to the first match' },
        ],
      },
    ],
  },
  execute(ctx) {
    const outputs: NodeItem[][] = Array.from({ length: SWITCH_OUTPUTS + 1 }, () => []);
    ctx.getInputData().forEach((item, i) => {
      const routed = { ...item, pairedItem: { item: i } };
      if (ctx.getNodeParameter('mode', i) === 'expression') {
        const raw = ctx.getNodeParameter<unknown>('output', i);
        const index = typeof raw === 'string' && raw.trim() === '' ? NaN : Number(raw);
        if (!Number.isInteger(index) || index < 0 || index >= SWITCH_OUTPUTS) {
          throw new NodeOperationError(`Output ${JSON.stringify(raw)} doesn't exist`, { itemIndex: i, description: `The output index must be a whole number from 0 to ${SWITCH_OUTPUTS - 1}.` });
        }
        outputs[index].push(routed);
        return;
      }
      const rules = ctx.getNodeParameter<{ values?: SwitchRule[] }>('rules', i)?.values ?? [];
      if (rules.length > SWITCH_OUTPUTS) {
        throw new NodeOperationError(`Switch has ${SWITCH_OUTPUTS} rule outputs, but ${rules.length} rules are set`, {
          description: 'Combine rules, or chain a second Switch to its Fallback output.',
        });
      }
      const options = ctx.getNodeParameter<{ fallbackOutput?: string; allMatchingOutputs?: boolean }>('options', i) ?? {};
      let matched = false;
      for (const [index, rule] of rules.entries()) {
        if (!matches(rule)) continue;
        // The same item on several outputs: give each branch its own copy.
        outputs[index].push(matched ? structuredClone(routed) : routed);
        matched = true;
        if (!options.allMatchingOutputs) break;
      }
      if (!matched && options.fallbackOutput === 'extra') outputs[SWITCH_OUTPUTS].push(routed);
    });
    return outputs;
  },
});

export const filterNode = defineNode({
  description: {
    name: 'filter',
    displayName: 'Filter',
    description: 'Keep only the items that match the conditions',
    version: 1,
    kind: 'action',
    categories: ['Flow'],
    icon: 'lucide:filter',
    color: '#22c55e',
    inputs: main,
    outputs: main,
    properties: conditionProperties,
  },
  execute(ctx) {
    return [
      ctx
        .getInputData()
        .map((item, i) => ({ ...item, pairedItem: { item: i } }))
        .filter((_item, i) => matches({ conditions: ctx.getNodeParameter('conditions', i), combinator: ctx.getNodeParameter('combinator', i) })),
    ];
  },
});

export const mergeNode = defineNode({
  description: {
    name: 'merge',
    displayName: 'Merge',
    description: 'Wait for both inputs, then combine their items',
    version: 1,
    kind: 'action',
    categories: ['Flow'],
    icon: 'lucide:merge',
    color: '#22c55e',
    subtitle: '{{mode}}',
    inputs: [
      { type: 'main', displayName: 'A' },
      { type: 'main', displayName: 'B' },
    ],
    outputs: main,
    properties: [
      {
        name: 'mode',
        displayName: 'Mode',
        type: 'options',
        default: 'append',
        options: [
          { name: 'Append', value: 'append', description: 'All items of A, then all items of B' },
          { name: 'Combine by position', value: 'position', description: 'Merge item i of A with item i of B' },
          { name: 'Combine by field', value: 'field', description: 'Join A and B where a field matches' },
        ],
      },
      { name: 'field', displayName: 'Match Field', type: 'string', default: 'id', displayOptions: { show: { mode: ['field'] } } },
    ],
  },
  execute(ctx) {
    const a = ctx.getInputData(0);
    const b = ctx.getInputData(1);
    const mode = ctx.getNodeParameter<string>('mode');
    if (mode === 'position') {
      return [Array.from({ length: Math.max(a.length, b.length) }, (_, i) => ({ json: { ...a[i]?.json, ...b[i]?.json } }))];
    }
    if (mode === 'field') {
      const field = ctx.getNodeParameter<string>('field');
      const index = new Map(b.map((item) => [String(item.json[field]), item]));
      return [a.filter((item) => index.has(String(item.json[field]))).map((item) => ({ json: { ...item.json, ...index.get(String(item.json[field]))!.json } }))];
    }
    return [[...a, ...b]];
  },
});

/** Waits up to this long stay in memory; longer ones suspend the execution (it is saved and resumed later). */
export const IN_MEMORY_WAIT_MS = 65_000;

const UNIT_MS: Record<string, number> = { seconds: 1_000, minutes: 60_000, hours: 3_600_000, days: 86_400_000 };
const WAIT_MODES = ['timeInterval', 'specificTime', 'webhook', 'form'];
const timeUnits = [
  { name: 'Seconds', value: 'seconds' },
  { name: 'Minutes', value: 'minutes' },
  { name: 'Hours', value: 'hours' },
  { name: 'Days', value: 'days' },
];

/** Sleep that ends early (rejecting) when the execution is canceled or times out. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** A date parameter as epoch ms (ISO strings, Date-like values, epoch numbers). */
function timeOf(value: unknown, label: string): number {
  const at = typeof value === 'number' ? value : Date.parse(String(value ?? ''));
  if (!Number.isFinite(at)) throw new NodeOperationError(`${label} isn’t a valid date and time`, { description: `Got ${JSON.stringify(value)}.` });
  return at;
}

function intervalMs(amount: unknown, unit: unknown, label: string): number {
  const value = Number(amount);
  if (!Number.isFinite(value) || value < 0) throw new NodeOperationError(`${label} must be a number of zero or more`, { description: `Got ${JSON.stringify(amount)}.` });
  return value * (UNIT_MS[String(unit)] ?? UNIT_MS.hours);
}

/**
 * n8n's Wait node. A time interval or a specific time up to ~65 s away is waited in memory; longer
 * waits, and waits for a webhook call (/api/waiting/<executionId>, `$execution.resumeUrl`) or a form
 * submission (/form/waiting/<executionId>), suspend the execution: it is saved as "waiting" and
 * resumed, even after a restart. Version 1 nodes with only `seconds` keep the old behaviour.
 */
export const waitNode = defineNode({
  description: {
    name: 'wait',
    displayName: 'Wait',
    description: 'Pause for a while, until a time, or until a webhook call or form submission',
    version: [1, 2],
    defaultVersion: 2,
    kind: 'action',
    categories: ['Flow'],
    icon: 'lucide:hourglass',
    color: '#22c55e',
    subtitle: '{{resume}}',
    keywords: ['wait', 'sleep', 'delay', 'pause', 'resume', 'webhook', 'approval', 'human in the loop'],
    inputs: main,
    outputs: main,
    properties: [
      {
        name: 'resume',
        displayName: 'Resume',
        type: 'options',
        default: 'timeInterval',
        noDataExpression: true,
        options: [
          { name: 'After Time Interval', value: 'timeInterval', description: 'Wait for a certain amount of time' },
          { name: 'At Specified Time', value: 'specificTime', description: 'Wait until a date and time' },
          { name: 'On Webhook Call', value: 'webhook', description: 'Wait for a call to the execution’s resume URL' },
          { name: 'On Form Submitted', value: 'form', description: 'Wait for someone to submit a form page' },
        ],
      },
      { name: 'amount', displayName: 'Wait Amount', type: 'number', default: 1, typeOptions: { minValue: 0 }, displayOptions: { show: { resume: ['timeInterval'] } } },
      { name: 'unit', displayName: 'Wait Unit', type: 'options', default: 'hours', options: timeUnits, displayOptions: { show: { resume: ['timeInterval'] } } },
      { name: 'dateTime', displayName: 'Date and Time', type: 'dateTime', default: '', required: true, displayOptions: { show: { resume: ['specificTime'] } } },
      {
        name: 'httpMethod',
        displayName: 'HTTP Method',
        type: 'options',
        default: 'GET',
        noDataExpression: true,
        displayOptions: { show: { resume: ['webhook'] } },
        options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].map((m) => ({ name: m, value: m })),
      },
      {
        name: 'responseMode',
        displayName: 'Respond',
        type: 'options',
        default: 'onReceived',
        noDataExpression: true,
        displayOptions: { show: { resume: ['webhook'] } },
        options: [
          { name: 'Immediately', value: 'onReceived', description: 'As soon as the call arrives (202 with the execution id)' },
          { name: 'When Last Node Finishes', value: 'lastNode', description: 'The last node’s output as JSON' },
          { name: 'Using ‘Respond to Webhook’ Node', value: 'responseNode', description: 'Whatever a Respond to Webhook node sends' },
        ],
      },
      { name: 'formTitle', displayName: 'Form Title', type: 'string', default: '', displayOptions: { show: { resume: ['form'] } } },
      { name: 'formDescription', displayName: 'Form Description', type: 'string', default: '', typeOptions: { rows: 2 }, displayOptions: { show: { resume: ['form'] } } },
      { ...formFieldsProperty, displayOptions: { show: { resume: ['form'] } } },
      { name: 'buttonLabel', displayName: 'Button Label', type: 'string', default: 'Submit', displayOptions: { show: { resume: ['form'] } } },
      {
        name: 'limitWaitTime',
        displayName: 'Limit Wait Time',
        type: 'boolean',
        default: false,
        description: 'Stop waiting at some point and continue with the input items',
        displayOptions: { show: { resume: ['webhook', 'form'] } },
      },
      {
        name: 'limitType',
        displayName: 'Limit Type',
        type: 'options',
        default: 'afterTimeInterval',
        displayOptions: { show: { resume: ['webhook', 'form'], limitWaitTime: [true] } },
        options: [
          { name: 'After Time Interval', value: 'afterTimeInterval' },
          { name: 'At Specified Time', value: 'atSpecifiedTime' },
        ],
      },
      {
        name: 'resumeAmount',
        displayName: 'Amount',
        type: 'number',
        default: 1,
        typeOptions: { minValue: 0 },
        displayOptions: { show: { resume: ['webhook', 'form'], limitWaitTime: [true], limitType: ['afterTimeInterval'] } },
      },
      {
        name: 'resumeUnit',
        displayName: 'Unit',
        type: 'options',
        default: 'hours',
        options: timeUnits,
        displayOptions: { show: { resume: ['webhook', 'form'], limitWaitTime: [true], limitType: ['afterTimeInterval'] } },
      },
      {
        name: 'maxDateAndTime',
        displayName: 'Max Date and Time',
        type: 'dateTime',
        default: '',
        displayOptions: { show: { resume: ['webhook', 'form'], limitWaitTime: [true], limitType: ['atSpecifiedTime'] } },
      },
      // Version 1 stored only `seconds`; choosing a Resume option drops it.
      {
        name: 'seconds',
        displayName: 'Seconds',
        type: 'number',
        typeOptions: { minValue: 0, maxValue: 300 },
        displayOptions: { hide: { resume: WAIT_MODES } },
      },
      {
        name: 'legacyNotice',
        displayName: 'This Wait uses the old “Seconds” setting (at most 300 s). Choose a Resume option to switch to the new settings.',
        type: 'notice',
        displayOptions: { hide: { resume: WAIT_MODES } },
      },
      {
        name: 'notice',
        displayName:
          'Waits over 65 s, and webhook or form waits, save the execution as “Waiting” and resume it later, also after a restart. The resume URL is {{ $execution.resumeUrl }} (webhook) or {{ $execution.resumeFormUrl }} (form).',
        type: 'notice',
        displayOptions: { show: { resume: WAIT_MODES } },
      },
    ],
  },
  async execute(ctx) {
    const items = ctx.getInputData();
    const legacy = ctx.getNode().typeVersion < 2 ? ctx.getNodeParameter<unknown>('seconds', 0, undefined) : undefined;
    if (legacy !== undefined && legacy !== null && legacy !== '') {
      await sleep(Math.min(300, Math.max(0, Number(legacy) || 0)) * 1000, ctx.signal);
      return [items];
    }

    const resume = ctx.getNodeParameter<string>('resume', 0);
    const suspend = (request: Parameters<NonNullable<typeof ctx.putExecutionToWait>>[0]) => {
      if (!ctx.putExecutionToWait) throw new NodeOperationError('This wait needs a workflow execution', { description: 'Here (e.g. as an agent tool) only time waits up to 65 seconds work.' });
      ctx.putExecutionToWait(request);
    };

    if (resume === 'timeInterval' || resume === 'specificTime') {
      const until =
        resume === 'timeInterval' ? Date.now() + intervalMs(ctx.getNodeParameter('amount', 0), ctx.getNodeParameter('unit', 0), 'Wait Amount') : timeOf(ctx.getNodeParameter('dateTime', 0), 'Date and Time');
      const delay = until - Date.now();
      if (delay <= IN_MEMORY_WAIT_MS) {
        await sleep(Math.max(0, delay), ctx.signal);
        return [items];
      }
      suspend({ resume: 'time', until: new Date(until).toISOString() });
      ctx.logger.info(`Waiting until ${new Date(until).toISOString()}`);
      return [items];
    }

    let limit: string | undefined;
    if (ctx.getNodeParameter('limitWaitTime', 0)) {
      const at =
        ctx.getNodeParameter('limitType', 0) === 'atSpecifiedTime'
          ? timeOf(ctx.getNodeParameter('maxDateAndTime', 0), 'Max Date and Time')
          : Date.now() + intervalMs(ctx.getNodeParameter('resumeAmount', 0), ctx.getNodeParameter('resumeUnit', 0), 'Amount');
      limit = new Date(at).toISOString();
    }
    // Loaded lazily: the runner needs the registry this plugin is part of.
    const { resumeUrls } = await import('../runner');
    const urls = resumeUrls(ctx.getExecutionId());
    if (resume === 'form') {
      const form = pageOf(ctx.getNodeParameter('formTitle', 0), ctx.getNodeParameter('formDescription', 0), ctx.getNodeParameter('formFields', 0), ctx.getNodeParameter('buttonLabel', 0));
      suspend({ resume: 'form', ...(limit && { until: limit }), data: { form: form as unknown as JsonObject, formMode: formModeOf(ctx.mode) } });
      ctx.logger.info(`Waiting for the form at ${urls.form}${limit ? ` until ${limit}` : ''}`);
      return [items];
    }
    if (resume !== 'webhook') throw new NodeOperationError(`Unknown resume option "${resume}"`);
    const method = String(ctx.getNodeParameter('httpMethod', 0) || 'GET').toUpperCase();
    const mode = ctx.getNodeParameter<string>('responseMode', 0);
    const respond = mode === 'lastNode' || mode === 'responseNode' ? mode : 'immediately';
    suspend({ resume: 'webhook', method, ...(limit && { until: limit }), data: { respond } });
    ctx.logger.info(`Waiting for ${method} ${urls.webhook}${limit ? ` until ${limit}` : ''}`);
    return [items];
  },
});

interface BatchState {
  /** Items still to hand out. */
  items: NodeItem[];
  /** Items that came back through the loop. */
  processed: NodeItem[];
  runIndex: number;
}

/**
 * n8n's Loop Over Items (Split in Batches v3): hands out `batchSize` items at a time on "loop" and,
 * once every batch has come back, all the returned items on "done". Connect the end of the loop
 * back to this node. Its state lasts for the execution (also across waits) and is cleared when done.
 */
export const splitInBatchesNode = defineNode({
  description: {
    name: 'splitInBatches',
    displayName: 'Loop Over Items',
    description: 'Split the items into batches and loop over them',
    version: 3,
    kind: 'action',
    categories: ['Flow'],
    icon: 'lucide:repeat',
    color: '#22c55e',
    subtitle: 'batches of {{batchSize}}',
    keywords: ['loop', 'batch', 'split in batches', 'iterate', 'for each', 'chunk'],
    inputs: main,
    outputs: [
      { type: 'main', displayName: 'done' },
      { type: 'main', displayName: 'loop' },
    ],
    properties: [
      { name: 'batchSize', displayName: 'Batch Size', type: 'number', default: 1, typeOptions: { minValue: 1, numberPrecision: 0 }, description: 'Items per loop' },
      {
        name: 'options',
        displayName: 'Options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        values: [{ name: 'reset', displayName: 'Reset', type: 'boolean', default: false, description: 'Start over with the incoming items instead of continuing the loop' }],
      },
      {
        name: 'notice',
        displayName: 'Connect the last node of the loop back to this node. “loop” gets each batch; “done” gets every item that came back, once all batches have run.',
        type: 'notice',
      },
    ],
  },
  execute(ctx) {
    if (!ctx.getNodeState || !ctx.setNodeState) throw new NodeOperationError('Loop Over Items can only run inside a workflow execution');
    const items = ctx.getInputData();
    const batchSize = Math.max(1, Math.floor(Number(ctx.getNodeParameter('batchSize', 0)) || 1));
    const reset = Boolean(ctx.getNodeParameter<{ reset?: boolean }>('options', 0)?.reset);
    const saved = ctx.getNodeState<BatchState & JsonObject>();
    let state: BatchState;
    let batch: NodeItem[];
    if (!saved || reset) {
      // First run: the incoming items are the ones to loop over.
      const all = items.map((item, index) => ({ json: item.json, pairedItem: { item: index } }));
      batch = all.slice(0, batchSize);
      state = { items: all.slice(batchSize), processed: [], runIndex: 0 };
    } else {
      // Back from the loop: keep what came back and hand out the next batch.
      state = { items: [...saved.items], processed: [...saved.processed, ...items.map((item) => ({ json: item.json }))], runIndex: saved.runIndex + 1 };
      batch = state.items.splice(0, batchSize);
    }
    if (!batch.length) {
      ctx.setNodeState(undefined);
      return [state.processed, []];
    }
    ctx.setNodeState(state as unknown as JsonObject);
    return [[], batch];
  },
});

/** The webhook response options of Respond to Webhook. */
interface RespondOptions {
  responseCode?: number;
  responseHeaders?: { entries?: Array<{ name?: string; value?: string }> };
  responseKey?: string;
}

/**
 * n8n's Respond to Webhook: answers the request that started the run (a Webhook trigger set to
 * "Using ‘Respond to Webhook’ Node", or a Wait node's resume call) while the run goes on. Only the
 * first response counts; the items pass through.
 */
export const respondToWebhookNode = defineNode({
  description: {
    name: 'respondToWebhook',
    displayName: 'Respond to Webhook',
    description: 'Send the response to the webhook call that started the workflow',
    version: 1,
    kind: 'action',
    categories: ['Flow'],
    icon: 'lucide:reply',
    color: '#22c55e',
    subtitle: '{{respondWith}}',
    keywords: ['respond', 'response', 'webhook', 'http', 'reply', 'return'],
    inputs: main,
    outputs: main,
    properties: [
      {
        name: 'respondWith',
        displayName: 'Respond With',
        type: 'options',
        default: 'firstIncomingItem',
        noDataExpression: true,
        options: [
          { name: 'First Incoming Item', value: 'firstIncomingItem', description: 'Its JSON' },
          { name: 'All Incoming Items', value: 'allIncomingItems', description: 'A JSON array' },
          { name: 'JSON', value: 'json', description: 'A JSON body you write' },
          { name: 'Text', value: 'text' },
          { name: 'No Data', value: 'noData', description: 'An empty body' },
          { name: 'Redirect', value: 'redirect' },
        ],
      },
      {
        name: 'responseBody',
        displayName: 'Response Body',
        type: 'json',
        default: '{\n  "myField": "value"\n}',
        typeOptions: { language: 'json' },
        displayOptions: { show: { respondWith: ['json'] } },
      },
      { name: 'responseBody', displayName: 'Response Body', type: 'string', default: '', typeOptions: { rows: 3 }, displayOptions: { show: { respondWith: ['text'] } } },
      { name: 'redirectURL', displayName: 'Redirect URL', type: 'string', default: '', required: true, placeholder: 'https://example.com', displayOptions: { show: { respondWith: ['redirect'] } } },
      {
        name: 'options',
        displayName: 'Options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        values: [
          { name: 'responseCode', displayName: 'Response Code', type: 'number', default: 200, typeOptions: { minValue: 100, maxValue: 599 } },
          {
            name: 'responseHeaders',
            displayName: 'Response Headers',
            type: 'fixedCollection',
            typeOptions: { multipleValues: true },
            default: {},
            groups: [
              {
                name: 'entries',
                displayName: 'Header',
                values: [
                  { name: 'name', displayName: 'Name', type: 'string', default: '' },
                  { name: 'value', displayName: 'Value', type: 'string', default: '' },
                ],
              },
            ],
          },
          { name: 'responseKey', displayName: 'Put Response in Field', type: 'string', default: '', description: 'First / all incoming items: wrap the JSON in this field' },
        ],
      },
      {
        name: 'notice',
        displayName: 'Set the Webhook trigger’s Respond option to “Using ‘Respond to Webhook’ Node”. The first response is sent; the workflow continues.',
        type: 'notice',
      },
    ],
  },
  async execute(ctx) {
    const items = ctx.getInputData();
    const respondWith = ctx.getNodeParameter<string>('respondWith', 0);
    const options = ctx.getNodeParameter<RespondOptions>('options', 0) ?? {};
    const headers: Record<string, string> = {};
    for (const entry of options.responseHeaders?.entries ?? []) if (entry.name?.trim()) headers[entry.name.trim().toLowerCase()] = String(entry.value ?? '');
    const status = Math.round(Number(options.responseCode ?? 200)) || 200;
    if (status < 100 || status > 599) throw new NodeOperationError(`Response code ${status} isn’t a valid HTTP status`);
    const reply: Extract<RunReply, { type: 'webhook' }> = { type: 'webhook', status, headers };
    const wrap = (value: unknown) => (options.responseKey?.trim() ? { [options.responseKey.trim()]: value } : value);
    switch (respondWith) {
      case 'allIncomingItems':
        reply.json = wrap(items.map((item) => item.json));
        break;
      case 'json': {
        const body = ctx.getNodeParameter<unknown>('responseBody', 0);
        if (typeof body === 'string') {
          try {
            reply.json = body.trim() ? JSON.parse(body) : {};
          } catch (error) {
            throw new NodeOperationError('The response body isn’t valid JSON', { description: (error as Error).message });
          }
        } else reply.json = body ?? {};
        break;
      }
      case 'text':
        reply.body = String(ctx.getNodeParameter('responseBody', 0) ?? '');
        break;
      case 'noData':
        break;
      case 'redirect': {
        const url = String(ctx.getNodeParameter('redirectURL', 0) ?? '').trim();
        if (!url) throw new NodeOperationError('Set the URL to redirect to');
        reply.redirect = url;
        if (!options.responseCode) reply.status = 307;
        break;
      }
      default:
        reply.json = wrap(items[0]?.json ?? {});
    }
    // Loaded lazily: the runner needs the registry this plugin is part of.
    const { deliverReply } = await import('../runner');
    if (!deliverReply(ctx.getExecutionId(), reply)) {
      ctx.logger.warn('No webhook call is waiting for a response (the trigger isn’t set to “Using ‘Respond to Webhook’ Node”, or a response was already sent)');
    }
    return [items];
  },
});

export const limitNode = defineNode({
  description: {
    name: 'limit',
    displayName: 'Limit',
    description: 'Keep the first or last N items',
    version: 1,
    kind: 'action',
    categories: ['Data'],
    icon: 'lucide:list-end',
    color: '#14b8a6',
    inputs: main,
    outputs: main,
    properties: [
      { name: 'maxItems', displayName: 'Max Items', type: 'number', default: 10, typeOptions: { minValue: 1 } },
      { name: 'keep', displayName: 'Keep', type: 'options', default: 'first', options: [{ name: 'First items', value: 'first' }, { name: 'Last items', value: 'last' }] },
    ],
  },
  execute(ctx) {
    const items = ctx.getInputData();
    const max = Number(ctx.getNodeParameter('maxItems'));
    return [ctx.getNodeParameter('keep') === 'last' ? items.slice(-max) : items.slice(0, max)];
  },
});

export const sortNode = defineNode({
  description: {
    name: 'sort',
    displayName: 'Sort',
    description: 'Sort items by a field',
    version: 1,
    kind: 'action',
    categories: ['Data'],
    icon: 'lucide:arrow-down-wide-narrow',
    color: '#14b8a6',
    subtitle: '{{field}} {{order}}',
    inputs: main,
    outputs: main,
    properties: [
      { name: 'field', displayName: 'Field', type: 'string', default: 'value' },
      { name: 'order', displayName: 'Order', type: 'options', default: 'asc', options: [{ name: 'Ascending', value: 'asc' }, { name: 'Descending', value: 'desc' }] },
    ],
  },
  execute(ctx) {
    const field = ctx.getNodeParameter<string>('field');
    const direction = ctx.getNodeParameter('order') === 'desc' ? -1 : 1;
    const get = (item: NodeItem) => item.json[field] as never;
    return [[...ctx.getInputData()].sort((a, b) => (get(a) > get(b) ? direction : get(a) < get(b) ? -direction : 0))];
  },
});

export const noOpNode = defineNode({
  description: {
    name: 'noOp',
    displayName: 'No Operation',
    description: 'Do nothing — handy as a visual anchor or to end a branch',
    version: 1,
    kind: 'action',
    categories: ['Flow'],
    icon: 'lucide:circle-dashed',
    color: '#64748b',
    inputs: main,
    outputs: main,
    properties: [],
  },
  execute: (ctx) => [ctx.getInputData()],
});

export const stopAndErrorNode = defineNode({
  description: {
    name: 'stopAndError',
    displayName: 'Stop and Error',
    description: 'Fail the execution with a message',
    version: 1,
    kind: 'action',
    categories: ['Flow'],
    icon: 'lucide:octagon-x',
    color: '#ef4444',
    inputs: main,
    outputs: [],
    properties: [{ name: 'message', displayName: 'Error Message', type: 'string', default: 'Something went wrong' }],
  },
  execute(ctx) {
    throw new NodeOperationError(ctx.getNodeParameter<string>('message'));
  },
});
