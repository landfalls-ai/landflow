import { NodeOperationError, defineNode } from '@landflow/sdk';

/** Object-literal style — `defineNode` gives the same type safety as a class. */
export const RegexExtract = defineNode({
  description: {
    name: 'regexExtract',
    displayName: 'Regex Extract',
    description: 'Extract every match of a regular expression from a field',
    version: 1,
    kind: 'action',
    // Pure transform: the same input always gives the same output, so a broker may safely deliver a call twice.
    idempotent: true,
    categories: ['Text'],
    icon: 'file:regex-extract.svg',
    color: '#a78bfa',
    subtitle: '/{{pattern}}/',
    inputs: [{ type: 'main' }],
    outputs: [{ type: 'main' }],
    properties: [
      {
        name: 'source',
        displayName: 'Text From',
        type: 'options',
        default: 'field',
        options: [
          { name: 'JSON Field', value: 'field' },
          { name: 'Binary File', value: 'binary', description: 'Read a text file of the item (item.binary.<name>, UTF-8)' },
        ],
      },
      { name: 'field', displayName: 'Field', type: 'string', default: 'text', displayOptions: { show: { source: ['field'] } } },
      {
        name: 'binaryPropertyName',
        displayName: 'Input Binary Field',
        type: 'string',
        default: 'data',
        displayOptions: { show: { source: ['binary'] } },
        description: 'The text file to read (.txt, .csv, .json, .log…)',
      },
      { name: 'pattern', displayName: 'Pattern', type: 'string', default: '[\\w.+-]+@[\\w-]+\\.[\\w.]+', placeholder: '\\d+' },
      { name: 'flags', displayName: 'Flags', type: 'string', default: 'gi' },
      { name: 'outputField', displayName: 'Output Field', type: 'string', default: 'matches' },
      {
        name: 'splitMatches',
        displayName: 'One Item per Match',
        type: 'boolean',
        default: false,
      },
    ],
  },
  async execute(ctx) {
    const out = [];
    for (const [i, item] of ctx.getInputData().entries()) {
      let regex: RegExp;
      try {
        const flags = ctx.getNodeParameter<string>('flags', i);
        regex = new RegExp(ctx.getNodeParameter<string>('pattern', i), flags.includes('g') ? flags : flags + 'g');
      } catch (error) {
        throw new NodeOperationError(`Invalid pattern: ${(error as Error).message}`, { itemIndex: i });
      }
      let text: string;
      if (ctx.getNodeParameter<string>('source', i, 'field') === 'binary') {
        const property = String(ctx.getNodeParameter('binaryPropertyName', i, 'data') || 'data').trim();
        // A leading byte order mark is not text.
        text = (await ctx.helpers.getBinaryDataBuffer(i, property)).toString('utf8').replace(/^\uFEFF/, '');
      } else {
        text = String(item.json[ctx.getNodeParameter<string>('field', i)] ?? '');
      }
      const matches = [...text.matchAll(regex)].map((m) => m[0]);
      const outputField = ctx.getNodeParameter<string>('outputField', i);
      if (ctx.getNodeParameter<boolean>('splitMatches', i)) {
        for (const match of matches) out.push({ json: { ...item.json, [outputField]: match }, pairedItem: { item: i } });
      } else {
        out.push({ json: { ...item.json, [outputField]: matches }, pairedItem: { item: i } });
      }
    }
    ctx.logger.info(`extracted from ${ctx.getInputData().length} item(s)`);
    return [out];
  },
});
