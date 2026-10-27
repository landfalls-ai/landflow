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
      {
        name: 'asFile',
        displayName: 'Also Output as File',
        type: 'boolean',
        default: false,
        description: 'Whether to also store the rendered text as a binary file (item.binary), e.g. to attach it to an email or upload it',
      },
      {
        name: 'binaryPropertyName',
        displayName: 'Binary Field',
        type: 'string',
        default: 'data',
        displayOptions: { show: { asFile: [true] } },
        description: 'The item.binary field for the file',
      },
      {
        name: 'fileName',
        displayName: 'File Name',
        type: 'string',
        default: 'rendered.txt',
        displayOptions: { show: { asFile: [true] } },
      },
      {
        name: 'mimeType',
        displayName: 'MIME Type',
        type: 'string',
        default: 'text/plain',
        placeholder: 'text/html',
        displayOptions: { show: { asFile: [true] } },
        description: 'text/html, text/csv, application/json, text/markdown…; the text is stored as UTF-8',
      },
    ],
  };

  async execute(ctx: IExecuteContext) {
    const out = [];
    for (const [i, item] of ctx.getInputData().entries()) {
      const template = ctx.getNodeParameter<string>('template', i).replace(/\[\[\s*([^\]]+?)\s*\]\]/g, '{{$1}}');
      const text = render(template, item.json);
      const json = { ...item.json, [ctx.getNodeParameter<string>('outputField', i)]: text };
      if (!ctx.getNodeParameter<boolean>('asFile', i, false)) {
        out.push({ json });
        continue;
      }
      const fileName = String(ctx.getNodeParameter('fileName', i, 'rendered.txt') || 'rendered.txt').trim();
      const mimeType = String(ctx.getNodeParameter('mimeType', i, 'text/plain') || 'text/plain').trim();
      const property = String(ctx.getNodeParameter('binaryPropertyName', i, 'data') || 'data').trim();
      const ref = await ctx.helpers.prepareBinaryData(Buffer.from(text, 'utf8'), fileName, mimeType);
      // The item's other files stay; the new one replaces a file of the same name.
      out.push({ json, binary: { ...item.binary, [property]: ref } });
    }
    return out;
  }
}
