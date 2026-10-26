import { NodeOperationError, type IExecuteContext, type INodeType, type NodeDescriptor } from '@landflow/sdk';

export function slugify(input: string, separator = '-'): string {
  return input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, separator)
    .replace(new RegExp(`^\\${separator}+|\\${separator}+$`, 'g'), '');
}

export class Slugify implements INodeType {
  readonly description: NodeDescriptor = {
    name: 'slugify',
    displayName: 'Slugify',
    description: 'Turn text into a URL-safe slug',
    version: 1,
    kind: 'action',
    // Pure transform: the same input always gives the same output, so a broker may safely deliver a call twice.
    idempotent: true,
    categories: ['Text'],
    icon: 'file:slugify.svg',
    color: '#60a5fa',
    subtitle: '{{field}} → {{outputField}}',
    inputs: [{ type: 'main' }],
    outputs: [{ type: 'main' }],
    usableAsTool: true,
    toolDescription: 'Convert a piece of text into a URL slug. Pass the text in the `text` argument.',
    toolInputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'The text to slugify' } },
      required: ['text'],
    },
    properties: [
      { name: 'field', displayName: 'Field', type: 'string', default: 'text', description: 'Item field holding the text' },
      { name: 'outputField', displayName: 'Output Field', type: 'string', default: 'slug' },
      {
        name: 'separator',
        displayName: 'Separator',
        type: 'options',
        default: '-',
        options: [
          { name: 'Hyphen (-)', value: '-' },
          { name: 'Underscore (_)', value: '_' },
          { name: 'Dot (.)', value: '.' },
        ],
      },
    ],
  };

  async execute(ctx: IExecuteContext) {
    const items = ctx.getInputData();
    // A child span under the SDK's `plugin.execute text-toolkit.slugify` server span, plus a custom metric
    // (Prometheus: text_toolkit_slugs_produced_total on GET /metrics).
    return ctx.span('text_toolkit.slugify', { 'text_toolkit.items': items.length }, async (span) => {
      const results = items.map((item, i) => {
        const field = ctx.getNodeParameter<string>('field', i);
        const value = item.json[field];
        if (typeof value !== 'string') {
          throw new NodeOperationError(`Field "${field}" is not a string`, {
            itemIndex: i,
            description: `Got ${JSON.stringify(value)} — point "Field" at a text property.`,
          });
        }
        const outputField = ctx.getNodeParameter<string>('outputField', i);
        return { json: { ...item.json, [outputField]: slugify(value, ctx.getNodeParameter('separator', i)) } };
      });
      const separator = ctx.getNodeParameter<string>('separator', 0);
      span.setAttribute('text_toolkit.separator', separator);
      ctx.metrics
        .counter('text_toolkit.slugs.produced', { description: 'Slugs produced by the Slugify node' })
        .add(results.length, { 'text_toolkit.separator': separator });
      return results;
    });
  }
}
