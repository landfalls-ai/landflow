import type { IExecuteContext, INodeType, JsonObject, NodeDescriptor } from '@landflow/sdk';

/** Tiny mustache: {{ path.to.value }} against the item JSON. */
export function render(template: string, data: JsonObject): string {
  return template.replace(/\{\{\s*([\w.[\]-]+)\s*\}\}/g, (_m, path: string) => {
    const value = path
      .replace(/\[(\d+)\]/g, '.$1')
      .split('.')
      .reduce<unknown>((acc, key) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[key] : undefined), data);
    if (value === undefined || value === null) return '';
    return typeof value === 'object' ? JSON.stringify(value) : String(value);
  });
}

export class Template implements INodeType {
  readonly description: NodeDescriptor = {
    name: 'template',
    displayName: 'Render Template',
    description: 'Render a text template per item using [[field]] placeholders',
    version: 1,
    kind: 'action',
    // Pure transform: the same input always gives the same output, so a broker may safely deliver a call twice.
    idempotent: true,
    categories: ['Text'],
    icon: 'file:template.svg',
    color: '#38bdf8',
    inputs: [{ type: 'main' }],
    outputs: [{ type: 'main' }],
    properties: [
      {
        name: 'notice',
        displayName: 'Placeholders use [[field]] so they do not clash with {{ expressions }}, which the host resolves first.',
        type: 'notice',
      },
      {
        name: 'template',
        displayName: 'Template',
        type: 'string',
        default: 'Hello [[name]]!',
        typeOptions: { rows: 4 },
      },
      { name: 'outputField', displayName: 'Output Field', type: 'string', default: 'rendered' },
    ],
  };

  execute(ctx: IExecuteContext) {
    return ctx.getInputData().map((item, i) => {
      const template = ctx.getNodeParameter<string>('template', i).replace(/\[\[\s*([^\]]+?)\s*\]\]/g, '{{$1}}');
      return { json: { ...item.json, [ctx.getNodeParameter<string>('outputField', i)]: render(template, item.json) } };
    });
  }
}
