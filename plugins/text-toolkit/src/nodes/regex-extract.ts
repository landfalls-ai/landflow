import { NodeOperationError, defineNode } from '@landflow/sdk';

/** Object-literal style — `defineNode` gives the same type safety as a class. */
export const RegexExtract = defineNode({
  description: {
    name: 'regexExtract',
    displayName: 'Regex Extract',
    description: 'Extract every match of a regular expression from a field',
    version: 1,
    kind: 'action',
    categories: ['Text'],
    icon: 'file:regex-extract.svg',
    color: '#a78bfa',
    subtitle: '/{{pattern}}/',
    inputs: [{ type: 'main' }],
    outputs: [{ type: 'main' }],
    properties: [
      { name: 'field', displayName: 'Field', type: 'string', default: 'text' },
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
  execute(ctx) {
    const out = [];
    for (const [i, item] of ctx.getInputData().entries()) {
      let regex: RegExp;
      try {
        const flags = ctx.getNodeParameter<string>('flags', i);
        regex = new RegExp(ctx.getNodeParameter<string>('pattern', i), flags.includes('g') ? flags : flags + 'g');
      } catch (error) {
        throw new NodeOperationError(`Invalid pattern: ${(error as Error).message}`, { itemIndex: i });
      }
      const matches = [...String(item.json[ctx.getNodeParameter<string>('field', i)] ?? '').matchAll(regex)].map((m) => m[0]);
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
