import type { IExecuteContext, INodeType, NodeDescriptor } from '@landflow/sdk';

const words = (s: string) =>
  s
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean);

export const CASES: Record<string, (s: string) => string> = {
  upper: (s) => s.toUpperCase(),
  lower: (s) => s.toLowerCase(),
  title: (s) => words(s).map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase()).join(' '),
  camel: (s) =>
    words(s)
      .map((w, i) => (i === 0 ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1).toLowerCase()))
      .join(''),
  snake: (s) => words(s).map((w) => w.toLowerCase()).join('_'),
  kebab: (s) => words(s).map((w) => w.toLowerCase()).join('-'),
};

export class ChangeCase implements INodeType {
  readonly description: NodeDescriptor = {
    name: 'changeCase',
    displayName: 'Change Case',
    description: 'Convert text between upper, lower, title, camel, snake and kebab case',
    version: 1,
    kind: 'action',
    // Pure transform: the same input always gives the same output, so a broker may safely deliver a call twice.
    idempotent: true,
    categories: ['Text'],
    icon: 'file:change-case.svg',
    color: '#818cf8',
    subtitle: '{{case}}',
    inputs: [{ type: 'main' }],
    outputs: [{ type: 'main' }],
    usableAsTool: true,
    toolDescription: 'Change the letter case of text. Arguments: `text` and `case` (upper|lower|title|camel|snake|kebab).',
    properties: [
      { name: 'field', displayName: 'Field', type: 'string', default: 'text' },
      {
        name: 'case',
        displayName: 'Case',
        type: 'options',
        default: 'title',
        options: Object.keys(CASES).map((key) => ({ name: key[0].toUpperCase() + key.slice(1), value: key })),
      },
      {
        name: 'inPlace',
        displayName: 'Replace Field',
        type: 'boolean',
        default: true,
        description: 'Overwrite the source field instead of writing a new one',
      },
      {
        name: 'outputField',
        displayName: 'Output Field',
        type: 'string',
        default: 'converted',
        displayOptions: { show: { inPlace: [false] } },
      },
    ],
  };

  execute(ctx: IExecuteContext) {
    return ctx.getInputData().map((item, i) => {
      const field = ctx.getNodeParameter<string>('field', i);
      const convert = CASES[ctx.getNodeParameter<string>('case', i)] ?? CASES.title;
      const target = ctx.getNodeParameter<boolean>('inPlace', i) ? field : ctx.getNodeParameter<string>('outputField', i);
      return { json: { ...item.json, [target]: convert(String(item.json[field] ?? '')) } };
    });
  }
}
