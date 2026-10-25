import { defineNode, NodeOperationError } from '@landflow/sdk';
import { store } from '../store';
import { FlowMetricError, recordFlowMetric, type FlowMetricType } from '../telemetry/flow-metrics';

const main = [{ type: 'main' as const }];

/**
 * Workflow-author metrics: per item, add to a counter, record a histogram value
 * or set a gauge under `landflow.flow.<name>`. Items pass through unchanged.
 */
export const recordMetricNode = defineNode({
  description: {
    name: 'metric',
    displayName: 'Record Metric',
    description: 'Count, measure or gauge something per item as an OpenTelemetry metric',
    version: 1,
    kind: 'action',
    categories: ['Data'],
    icon: 'lucide:gauge',
    color: '#14b8a6',
    subtitle: '{{type}} landflow.flow.{{name}}',
    keywords: ['metric', 'counter', 'histogram', 'gauge', 'prometheus', 'opentelemetry', 'observability'],
    inputs: main,
    outputs: main,
    properties: [
      {
        name: 'name',
        displayName: 'Metric Name',
        type: 'string',
        default: 'orders',
        required: true,
        noDataExpression: true,
        placeholder: 'orders.processed',
        hint: 'Recorded as landflow.flow.<name>. Lower case letters, digits, "_" and ".".',
      },
      {
        name: 'type',
        displayName: 'Type',
        type: 'options',
        default: 'counter',
        noDataExpression: true,
        options: [
          { name: 'Counter', value: 'counter', description: 'Add the value (default 1) for every item' },
          { name: 'Histogram', value: 'histogram', description: 'Record a distribution of values, e.g. sizes or amounts' },
          { name: 'Gauge', value: 'gauge', description: 'Set the current value, e.g. a queue length' },
        ],
      },
      { name: 'value', displayName: 'Value', type: 'string', default: '1', required: true, placeholder: '{{ $json.amount }}' },
      { name: 'unit', displayName: 'Unit', type: 'string', default: '', noDataExpression: true, placeholder: 'ms, By, {order}' },
      { name: 'description', displayName: 'Description', type: 'string', default: '', noDataExpression: true },
      {
        name: 'attributes',
        displayName: 'Attributes',
        type: 'fixedCollection',
        typeOptions: { multipleValues: true },
        default: {},
        description: 'Dimensions of the metric. Keep the number of distinct values small: at most 1000 attribute sets per metric are kept.',
        groups: [
          {
            name: 'attribute',
            displayName: 'Attribute',
            values: [
              { name: 'name', displayName: 'Name', type: 'string', default: '', placeholder: 'country' },
              { name: 'value', displayName: 'Value', type: 'string', default: '', placeholder: '{{ $json.country }}' },
            ],
          },
        ],
      },
    ],
  },
  execute(ctx) {
    const items = ctx.getInputData();
    const workflowId = ctx.getWorkflowId() ?? '';
    const workflowName = (workflowId && store.getWorkflow(workflowId)?.name) || '';
    const name = String(ctx.getNodeParameter('name', 0) ?? '').trim();
    const type = ctx.getNodeParameter<FlowMetricType>('type', 0, 'counter');
    const options = { unit: String(ctx.getNodeParameter('unit', 0) ?? ''), description: String(ctx.getNodeParameter('description', 0) ?? '') };

    items.forEach((_item, i) => {
      const raw = ctx.getNodeParameter<unknown>('value', i);
      const value = raw === '' || raw === undefined || raw === null ? (type === 'counter' ? 1 : NaN) : Number(raw);
      const pairs = ctx.getNodeParameter<{ attribute?: Array<{ name: string; value: unknown }> }>('attributes', i)?.attribute ?? [];
      const attributes = Object.fromEntries(pairs.filter((pair) => pair.name?.trim()).map((pair) => [pair.name.trim(), pair.value]));
      try {
        recordFlowMetric(name, type, value, { ...attributes, 'landflow.workflow.id': workflowId, 'landflow.workflow.name': workflowName }, options);
      } catch (error) {
        if (!(error instanceof FlowMetricError)) throw error;
        throw new NodeOperationError(error.message, { itemIndex: i, ...(Number.isNaN(value) && { description: `Value "${String(raw)}" is not a number` }) });
      }
    });
    return [items];
  },
});
