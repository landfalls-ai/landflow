import { NodeOperationError, defineNode } from '@landflow/sdk';
import type { JsonObject } from '@landflow/sdk';
import { parseEmail } from '../lib/email';
import { str } from '../lib/util';

export const ParseEmail = defineNode({
  description: {
    name: 'parseEmail',
    displayName: 'Parse Email',
    description: 'Parse a reported phishing e-mail (.eml or raw text): headers, SPF/DKIM/DMARC, bodies, URLs and attachment hashes',
    version: 1,
    kind: 'action',
    idempotent: true,
    categories: ['Security', 'Developer Tools'],
    icon: 'file:parse-email.svg',
    color: '#8b5cf6',
    subtitle: '{{source}}',
    inputs: [{ type: 'main' }],
    outputs: [{ type: 'main' }],
    properties: [
      {
        name: 'source',
        displayName: 'Email From',
        type: 'options',
        default: 'field',
        options: [
          { name: 'JSON Field', value: 'field', description: 'Raw RFC 822 text in a field' },
          { name: 'Binary File', value: 'binary', description: 'A .eml file in a binary property' },
        ],
      },
      { name: 'field', displayName: 'Field', type: 'string', default: 'email', displayOptions: { show: { source: ['field'] } }, description: 'Dot-free item field holding the raw message' },
      { name: 'binaryPropertyName', displayName: 'Input Binary Field', type: 'string', default: 'data', displayOptions: { show: { source: ['binary'] } } },
      { name: 'outputField', displayName: 'Output Field', type: 'string', default: 'email' },
      { name: 'attachmentsAsBinary', displayName: 'Emit Attachments as Binary', type: 'boolean', default: false, description: 'Add every attachment to the item as a file (attachment_0, attachment_1…). The JSON always lists name, type, size and SHA-256' },
      { name: 'binaryPrefix', displayName: 'Binary Field Prefix', type: 'string', default: 'attachment_', displayOptions: { show: { attachmentsAsBinary: [true] } } },
    ],
  },
  async execute(ctx) {
    const out: Array<{ json: JsonObject; binary?: any; pairedItem: { item: number } }> = [];
    for (const [i, item] of ctx.getInputData().entries()) {
      try {
        let input: string | Buffer;
        if (ctx.getNodeParameter<string>('source', i, 'field') === 'binary') {
          input = await ctx.helpers.getBinaryDataBuffer(i, str(ctx.getNodeParameter('binaryPropertyName', i, 'data')).trim() || 'data');
        } else {
          const field = ctx.getNodeParameter<string>('field', i, 'email');
          const value = item.json[field];
          if (typeof value !== 'string' || !value.trim()) throw new NodeOperationError(`Field "${field}" holds no e-mail text`, { itemIndex: i, description: 'Point "Field" at a string with the raw message, or read a .eml file as binary.' });
          input = value;
        }
        if (input.length === 0) throw new NodeOperationError('The e-mail is empty', { itemIndex: i });
        const parsed = parseEmail(input);
        const { attachments, ...rest } = parsed;
        const binary: Record<string, any> = { ...(item.binary ?? {}) };
        if (ctx.getNodeParameter<boolean>('attachmentsAsBinary', i, false)) {
          const prefix = ctx.getNodeParameter<string>('binaryPrefix', i, 'attachment_') || 'attachment_';
          for (const [n, a] of attachments.entries()) binary[`${prefix}${n}`] = await ctx.helpers.prepareBinaryData(a.content ?? Buffer.alloc(0), a.filename, a.contentType);
        }
        const listed = attachments.map(({ content: _content, ...meta }) => meta);
        const outputField = ctx.getNodeParameter<string>('outputField', i, 'email') || 'email';
        out.push({
          json: { ...item.json, [outputField]: { ...rest, attachments: listed } as unknown as JsonObject },
          ...(Object.keys(binary).length > 0 && { binary }),
          pairedItem: { item: i },
        });
      } catch (error) {
        const err = error instanceof NodeOperationError ? error : new NodeOperationError((error as Error).message, { itemIndex: i });
        if (ctx.continueOnFail()) out.push({ json: { ...item.json, error: err.message }, pairedItem: { item: i } });
        else throw err;
      }
    }
    return [out];
  },
});
