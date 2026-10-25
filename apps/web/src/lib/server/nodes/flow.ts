import { defineNode, NodeOperationError, type NodeItem } from '@landflow/sdk';
import { conditionProperties, matches, type Condition } from './conditions';

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

export const waitNode = defineNode({
  description: {
    name: 'wait',
    displayName: 'Wait',
    description: 'Pause before continuing',
    version: 1,
    kind: 'action',
    categories: ['Flow'],
    icon: 'lucide:hourglass',
    color: '#22c55e',
    subtitle: '{{seconds}}s',
    inputs: main,
    outputs: main,
    properties: [{ name: 'seconds', displayName: 'Seconds', type: 'number', default: 1, typeOptions: { minValue: 0, maxValue: 300 } }],
  },
  async execute(ctx) {
    const seconds = Math.min(300, Math.max(0, Number(ctx.getNodeParameter('seconds'))));
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
    return [ctx.getInputData()];
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
