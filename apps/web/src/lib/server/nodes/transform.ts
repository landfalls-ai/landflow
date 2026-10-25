/**
 * n8n's data-transformation nodes: Split Out, Aggregate, Remove Duplicates,
 * Summarize and Rename Keys. Names, parameters and output shapes follow n8n so
 * workflows and habits carry over. Field-name parameters take dot paths
 * (see ./paths) and are `noDataExpression`: a dragged `{{ $json.x }}` is read
 * as the field name, not resolved to its value.
 */
import { defineNode, NodeOperationError, type JsonObject, type NodeItem, type PropertyDescriptor } from '@landflow/sdk';
import { cleanField, fieldList, getPath, hasPath, isEmptyValue, setPath, splitPath, stableStringify, unsetPath } from './paths';

const main = [{ type: 'main' as const }];
const DATA = { kind: 'action' as const, version: 1, categories: ['Data'], color: '#14b8a6', inputs: main, outputs: main };

const dotNotationOption: PropertyDescriptor = {
  name: 'disableDotNotation',
  displayName: 'Disable Dot Notation',
  type: 'boolean',
  default: false,
  description: 'Read "a.b" as one field name instead of the path to b inside a',
};

const fieldsParameter = (name: string, displayName: string, extra: Partial<PropertyDescriptor> = {}): PropertyDescriptor => ({
  name,
  displayName,
  type: 'string',
  default: '',
  noDataExpression: true,
  placeholder: 'e.g. id, user.email',
  hint: 'Field names separated by commas. Drag fields from the input to add them.',
  ...extra,
});

const clone = <T>(value: T): T => structuredClone(value);
const plain = (value: unknown) => value as JsonObject;

// ---------------------------------------------------------------------------
// Split Out
// ---------------------------------------------------------------------------

export const splitOutNode = defineNode({
  description: {
    ...DATA,
    name: 'splitOut',
    displayName: 'Split Out',
    description: 'Turn a list inside an item into separate items',
    icon: 'lucide:ungroup',
    subtitle: '{{fieldToSplitOut}}',
    keywords: ['split', 'explode', 'unwind', 'flatten', 'array', 'list'],
    properties: [
      fieldsParameter('fieldToSplitOut', 'Fields To Split Out', {
        required: true,
        placeholder: 'items',
        hint: 'The list field to split. Several fields, separated by commas, are split side by side.',
      }),
      {
        name: 'include',
        displayName: 'Include',
        type: 'options',
        default: 'noOtherFields',
        options: [
          { name: 'No Other Fields', value: 'noOtherFields' },
          { name: 'All Other Fields', value: 'allOtherFields' },
          { name: 'Selected Other Fields', value: 'selectedOtherFields' },
        ],
      },
      fieldsParameter('fieldsToInclude', 'Fields To Include', { displayOptions: { show: { include: ['selectedOtherFields'] } } }),
      {
        name: 'options',
        displayName: 'Options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        values: [
          dotNotationOption,
          {
            name: 'destinationFieldName',
            displayName: 'Destination Field Name',
            type: 'string',
            default: '',
            noDataExpression: true,
            description: 'Put each element under this field (comma-separated, one per field to split out)',
          },
        ],
      },
    ],
  },
  execute(ctx) {
    const out: NodeItem[] = [];
    const items = ctx.getInputData();
    const found = new Set<string>();
    let wanted: string[] = [];
    items.forEach((item, i) => {
      const fields = fieldList(ctx.getNodeParameter('fieldToSplitOut', i), 'Fields To Split Out');
      if (!fields.length) throw new NodeOperationError('No field to split out', { itemIndex: i, description: 'Enter the name of a list field.' });
      wanted = fields;
      const include = ctx.getNodeParameter<string>('include', i);
      const options = ctx.getNodeParameter<{ disableDotNotation?: boolean; destinationFieldName?: string }>('options', i) ?? {};
      const dot = !options.disableDotNotation;
      const destinations = fieldList(options.destinationFieldName ?? '', 'Destination Field Name');
      if (destinations.length && destinations.length !== fields.length) {
        throw new NodeOperationError('Give one destination field per field to split out', {
          itemIndex: i,
          description: `${fields.length} field(s) to split out, ${destinations.length} destination field(s).`,
        });
      }
      const multiple = fields.length > 1;
      const rows: Record<string, unknown>[] = [];
      fields.forEach((field, f) => {
        let list = getPath(item.json, field, dot);
        if (list !== undefined) found.add(field);
        if (list === undefined) list = [];
        else if (typeof list !== 'object' || list === null) list = [list];
        else if (!Array.isArray(list)) list = Object.values(list);
        const name = destinations[f] || field;
        (list as unknown[]).forEach((element, e) => {
          rows[e] ??= {};
          // A single object list with no other fields becomes the item itself, as in n8n.
          if (typeof element === 'object' && element !== null && !Array.isArray(element) && include === 'noOtherFields' && !destinations[f] && !multiple) {
            Object.assign(rows[e], element);
          } else rows[e][name] = element;
        });
      });
      const others = include === 'selectedOtherFields' ? fieldList(ctx.getNodeParameter('fieldsToInclude', i), 'Fields To Include') : [];
      if (include === 'selectedOtherFields' && !others.length) {
        throw new NodeOperationError('No fields to include', {
          itemIndex: i,
          description: 'Add a field to “Fields To Include”, or include no or all other fields.',
        });
      }
      for (const row of rows) {
        let json: Record<string, unknown> = row;
        if (include === 'allOtherFields') {
          const rest = clone(item.json) as Record<string, unknown>;
          for (const field of fields) unsetPath(rest, field, dot);
          json = { ...rest, ...row };
        } else if (include === 'selectedOtherFields') {
          for (const field of others) json[field] = clone(getPath(item.json, field, dot)) ?? null;
        }
        out.push({ json: plain(json), pairedItem: { item: i } });
      }
    });
    const missing = wanted.filter((field) => !found.has(field));
    if (missing.length && items.length) ctx.logger.warn(`Not found in any input item: ${missing.join(', ')}`);
    return [out];
  },
});

// ---------------------------------------------------------------------------
// Aggregate
// ---------------------------------------------------------------------------

interface FieldToAggregate {
  fieldToAggregate?: string;
  renameField?: boolean;
  outputFieldName?: string;
}

/** Keep, drop or pick fields of an item ("All Item Data" in Aggregate). */
function selectFields(json: JsonObject, include: string, fields: string[], dot: boolean): JsonObject {
  if (include === 'specifiedFields') {
    const picked: Record<string, unknown> = {};
    for (const field of fields) if (hasPath(json, field, dot)) setPath(picked, field, clone(getPath(json, field, dot)), dot);
    return plain(picked);
  }
  const copy = clone(json) as Record<string, unknown>;
  if (include === 'allFieldsExcept') for (const field of fields) unsetPath(copy, field, dot);
  return plain(copy);
}

export const aggregateNode = defineNode({
  description: {
    ...DATA,
    name: 'aggregate',
    displayName: 'Aggregate',
    description: 'Combine a field from many items into a list in a single item',
    icon: 'lucide:group',
    subtitle: '{{aggregate}}',
    keywords: ['aggregate', 'combine', 'collect', 'concatenate', 'group', 'list', 'array', 'join'],
    properties: [
      {
        name: 'aggregate',
        displayName: 'Aggregate',
        type: 'options',
        default: 'aggregateIndividualFields',
        options: [
          { name: 'Individual Fields', value: 'aggregateIndividualFields', description: 'A list per field' },
          { name: 'All Item Data (Into a Single List)', value: 'aggregateAllItemData', description: 'Every item, as one list' },
        ],
      },
      {
        name: 'fieldsToAggregate',
        displayName: 'Fields To Aggregate',
        type: 'fixedCollection',
        typeOptions: { multipleValues: true },
        default: { fieldToAggregate: [{ fieldToAggregate: '', renameField: false }] },
        displayOptions: { show: { aggregate: ['aggregateIndividualFields'] } },
        groups: [
          {
            name: 'fieldToAggregate',
            displayName: 'Field',
            values: [
              { name: 'fieldToAggregate', displayName: 'Input Field Name', type: 'string', default: '', noDataExpression: true, placeholder: 'e.g. id' },
              { name: 'renameField', displayName: 'Rename Field', type: 'boolean', default: false },
              {
                name: 'outputFieldName',
                displayName: 'Output Field Name',
                type: 'string',
                default: '',
                noDataExpression: true,
                displayOptions: { show: { renameField: [true] } },
              },
            ],
          },
        ],
      },
      {
        name: 'destinationFieldName',
        displayName: 'Put Output in Field',
        type: 'string',
        default: 'data',
        noDataExpression: true,
        displayOptions: { show: { aggregate: ['aggregateAllItemData'] } },
      },
      {
        name: 'include',
        displayName: 'Include',
        type: 'options',
        default: 'allFields',
        displayOptions: { show: { aggregate: ['aggregateAllItemData'] } },
        options: [
          { name: 'All Fields', value: 'allFields' },
          { name: 'Specified Fields', value: 'specifiedFields' },
          { name: 'All Fields Except', value: 'allFieldsExcept' },
        ],
      },
      fieldsParameter('fieldsToInclude', 'Fields To Include', {
        displayOptions: { show: { aggregate: ['aggregateAllItemData'], include: ['specifiedFields'] } },
      }),
      fieldsParameter('fieldsToExclude', 'Fields To Exclude', {
        displayOptions: { show: { aggregate: ['aggregateAllItemData'], include: ['allFieldsExcept'] } },
      }),
      {
        name: 'options',
        displayName: 'Options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        values: [
          dotNotationOption,
          {
            name: 'mergeLists',
            displayName: 'Merge Lists',
            type: 'boolean',
            default: false,
            description: 'Individual fields: when a field is a list, add its elements instead of the list',
          },
          {
            name: 'keepMissing',
            displayName: 'Keep Missing And Null Values',
            type: 'boolean',
            default: false,
            description: 'Individual fields: add a null for items without the field (or with null)',
          },
        ],
      },
    ],
  },
  execute(ctx) {
    const items = ctx.getInputData();
    const options = ctx.getNodeParameter<{ disableDotNotation?: boolean; mergeLists?: boolean; keepMissing?: boolean }>('options', 0) ?? {};
    const dot = !options.disableDotNotation;

    if (ctx.getNodeParameter('aggregate', 0) === 'aggregateAllItemData') {
      const destination = cleanField(ctx.getNodeParameter('destinationFieldName', 0)) || 'data';
      const include = ctx.getNodeParameter<string>('include', 0);
      const fields =
        include === 'specifiedFields'
          ? fieldList(ctx.getNodeParameter('fieldsToInclude', 0), 'Fields To Include')
          : include === 'allFieldsExcept'
            ? fieldList(ctx.getNodeParameter('fieldsToExclude', 0), 'Fields To Exclude')
            : [];
      const json: Record<string, unknown> = {};
      setPath(
        json,
        destination,
        items.map((item) => selectFields(item.json, include, fields, dot)),
        dot,
      );
      return [[{ json: plain(json), pairedItem: { item: 0 } }]];
    }

    const entries = ctx.getNodeParameter<{ fieldToAggregate?: FieldToAggregate[] }>('fieldsToAggregate', 0)?.fieldToAggregate ?? [];
    if (!entries.length) throw new NodeOperationError('No fields to aggregate', { description: 'Add a field to “Fields To Aggregate”.' });
    const json: Record<string, unknown> = {};
    const used = new Set<string>();
    const missing: string[] = [];
    for (const entry of entries) {
      const field = cleanField(entry.fieldToAggregate);
      if (!field) throw new NodeOperationError('A field to aggregate has no name', { description: 'Enter an input field name or remove the empty row.' });
      const renamed = entry.renameField && entry.outputFieldName?.trim();
      const output = renamed || (dot ? (splitPath(field).pop() ?? field) : field);
      if (used.has(output)) throw new NodeOperationError(`The “${output}” output field is used more than once`, { description: 'Rename one of the fields.' });
      used.add(output);
      const values: unknown[] = [];
      let seen = false;
      for (const item of items) {
        const value = getPath(item.json, field, dot);
        if (value !== undefined) seen = true;
        if ((value === undefined || value === null) && !options.keepMissing) continue;
        if (options.mergeLists && Array.isArray(value)) values.push(...clone(value));
        else values.push(value === undefined ? null : clone(value));
      }
      if (!seen) missing.push(field);
      setPath(json, output, values, Boolean(renamed) && dot);
    }
    if (missing.length && items.length) ctx.logger.warn(`Not found in any input item: ${missing.join(', ')}`);
    return [[{ json: plain(json), pairedItem: { item: 0 } }]];
  },
});

// ---------------------------------------------------------------------------
// Remove Duplicates
// ---------------------------------------------------------------------------

export const removeDuplicatesNode = defineNode({
  description: {
    ...DATA,
    name: 'removeDuplicates',
    displayName: 'Remove Duplicates',
    description: 'Drop items that repeat an earlier item of the same input',
    icon: 'lucide:copy-minus',
    subtitle: '{{compare}}',
    keywords: ['dedupe', 'deduplicate', 'unique', 'distinct', 'duplicates'],
    properties: [
      {
        name: 'compare',
        displayName: 'Compare',
        type: 'options',
        default: 'allFields',
        options: [
          { name: 'All Fields', value: 'allFields' },
          { name: 'All Fields Except', value: 'allFieldsExcept' },
          { name: 'Selected Fields', value: 'selectedFields' },
        ],
      },
      fieldsParameter('fieldsToExclude', 'Fields To Exclude', { displayOptions: { show: { compare: ['allFieldsExcept'] } } }),
      fieldsParameter('fieldsToCompare', 'Fields To Compare', { required: true, displayOptions: { show: { compare: ['selectedFields'] } } }),
      {
        name: 'options',
        displayName: 'Options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        values: [
          dotNotationOption,
          {
            name: 'removeOtherFields',
            displayName: 'Remove Other Fields',
            type: 'boolean',
            default: false,
            description: 'Selected fields: output only the compared fields',
          },
        ],
      },
    ],
  },
  execute(ctx) {
    const items = ctx.getInputData();
    const compare = ctx.getNodeParameter<string>('compare', 0);
    const options = ctx.getNodeParameter<{ disableDotNotation?: boolean; removeOtherFields?: boolean }>('options', 0) ?? {};
    const dot = !options.disableDotNotation;
    const fields =
      compare === 'selectedFields'
        ? fieldList(ctx.getNodeParameter('fieldsToCompare', 0), 'Fields To Compare')
        : compare === 'allFieldsExcept'
          ? fieldList(ctx.getNodeParameter('fieldsToExclude', 0), 'Fields To Exclude')
          : [];
    if (compare === 'selectedFields') {
      if (!fields.length) throw new NodeOperationError('No fields to compare', { description: 'Enter at least one field name.' });
      // A field no item has is almost certainly a typo.
      const absent = fields.filter((field) => items.length > 0 && !items.some((item) => hasPath(item.json, field, dot)));
      if (absent.length)
        throw new NodeOperationError(`Not found in any input item: ${absent.join(', ')}`, { description: 'Check the field names in “Fields To Compare”.' });
    }
    const keyOf = (json: JsonObject) => {
      if (compare === 'selectedFields') return stableStringify(fields.map((field) => getPath(json, field, dot)));
      if (compare === 'allFieldsExcept') return stableStringify(selectFields(json, 'allFieldsExcept', fields, dot));
      return stableStringify(json);
    };
    const seen = new Set<string>();
    const out: NodeItem[] = [];
    items.forEach((item, i) => {
      const key = keyOf(item.json);
      if (seen.has(key)) return;
      seen.add(key);
      const json = compare === 'selectedFields' && options.removeOtherFields ? selectFields(item.json, 'specifiedFields', fields, dot) : item.json;
      out.push({ json, pairedItem: { item: i } });
    });
    if (out.length < items.length) ctx.logger.info(`Removed ${items.length - out.length} duplicate item(s)`);
    return [out];
  },
});

// ---------------------------------------------------------------------------
// Summarize
// ---------------------------------------------------------------------------

type Aggregation = 'append' | 'average' | 'concatenate' | 'count' | 'countUnique' | 'max' | 'min' | 'sum';

interface FieldToSummarize {
  aggregation?: Aggregation;
  field?: string;
  includeEmpty?: boolean;
  separateBy?: string;
  customSeparator?: string;
}

/** Output field prefixes, as n8n names them: `sum_amount`, `unique_count_email`… */
const PREFIX: Record<Aggregation, string> = {
  append: 'appended_',
  average: 'average_',
  concatenate: 'concatenated_',
  count: 'count_',
  countUnique: 'unique_count_',
  max: 'max_',
  min: 'min_',
  sum: 'sum_',
};

const numeric = (value: unknown) => typeof value === 'number' || (typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value)));

function summarizeValues(values: unknown[], spec: Required<Pick<FieldToSummarize, 'aggregation' | 'field'>> & FieldToSummarize): unknown {
  const kept = spec.includeEmpty ? values : values.filter((value) => !isEmptyValue(value));
  const numbers = () =>
    values
      .filter((value) => !isEmptyValue(value))
      .map((value) => {
        if (!numeric(value))
          throw new NodeOperationError(`“${spec.field}” has a value that is not a number: ${JSON.stringify(value)}`, {
            description: `${spec.aggregation} needs numbers.`,
          });
        return Number(value);
      });
  switch (spec.aggregation) {
    case 'count':
      return kept.length;
    case 'countUnique':
      return new Set(kept.map(stableStringify)).size;
    case 'append':
      return kept.map((value) => (value === undefined ? null : clone(value)));
    case 'concatenate': {
      const separator = spec.separateBy === 'other' ? (spec.customSeparator ?? '') : (spec.separateBy ?? ',');
      return kept.map((value) => (typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value ?? ''))).join(separator);
    }
    case 'sum':
      return numbers().reduce((sum, n) => sum + n, 0);
    case 'average': {
      const list = numbers();
      return list.length ? list.reduce((sum, n) => sum + n, 0) / list.length : null;
    }
    case 'min':
    case 'max': {
      const present = values.filter((value) => !isEmptyValue(value));
      if (!present.length) return null;
      const pick = spec.aggregation === 'min' ? -1 : 1;
      if (present.every(numeric)) return present.map(Number).reduce((best, n) => (Math.sign(n - best) === pick ? n : best));
      // Strings (ISO dates sort correctly) compare lexicographically.
      return present.map(String).reduce((best, s) => (Math.sign(s.localeCompare(best)) === pick ? s : best));
    }
    default:
      throw new NodeOperationError(`Unknown aggregation "${String(spec.aggregation)}"`);
  }
}

const AGGREGATIONS: Array<{ name: string; value: Aggregation }> = [
  { name: 'Append', value: 'append' },
  { name: 'Average', value: 'average' },
  { name: 'Concatenate', value: 'concatenate' },
  { name: 'Count', value: 'count' },
  { name: 'Count Unique', value: 'countUnique' },
  { name: 'Max', value: 'max' },
  { name: 'Min', value: 'min' },
  { name: 'Sum', value: 'sum' },
];

export const summarizeNode = defineNode({
  description: {
    ...DATA,
    name: 'summarize',
    displayName: 'Summarize',
    description: 'Count, sum, average or list fields, optionally per group (a pivot table)',
    icon: 'lucide:sigma',
    keywords: ['summarize', 'group by', 'pivot', 'count', 'sum', 'average', 'min', 'max', 'statistics'],
    properties: [
      {
        name: 'fieldsToSummarize',
        displayName: 'Fields To Summarize',
        type: 'fixedCollection',
        typeOptions: { multipleValues: true },
        default: { values: [{ aggregation: 'count', field: '' }] },
        groups: [
          {
            name: 'values',
            displayName: 'Field',
            values: [
              { name: 'aggregation', displayName: 'Aggregation', type: 'options', default: 'count', options: AGGREGATIONS },
              { name: 'field', displayName: 'Field', type: 'string', default: '', noDataExpression: true, placeholder: 'e.g. amount' },
              {
                name: 'includeEmpty',
                displayName: 'Include Empty Values',
                type: 'boolean',
                default: false,
                displayOptions: { show: { aggregation: ['append', 'concatenate', 'count', 'countUnique'] } },
              },
              {
                name: 'separateBy',
                displayName: 'Separator',
                type: 'options',
                default: ',',
                displayOptions: { show: { aggregation: ['concatenate'] } },
                options: [
                  { name: 'Comma', value: ',' },
                  { name: 'Comma and Space', value: ', ' },
                  { name: 'New Line', value: '\n' },
                  { name: 'None', value: '' },
                  { name: 'Space', value: ' ' },
                  { name: 'Other', value: 'other' },
                ],
              },
              {
                name: 'customSeparator',
                displayName: 'Custom Separator',
                type: 'string',
                default: '',
                displayOptions: { show: { aggregation: ['concatenate'], separateBy: ['other'] } },
              },
            ],
          },
        ],
      },
      fieldsParameter('fieldsToSplitBy', 'Fields To Split By', {
        placeholder: 'e.g. country, status',
        hint: 'One summary per combination of these fields. Leave empty for one summary of every item.',
      }),
      {
        name: 'options',
        displayName: 'Options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        values: [
          { name: 'continueIfFieldNotFound', displayName: 'Continue if Field Not Found', type: 'boolean', default: false },
          dotNotationOption,
          {
            name: 'outputFormat',
            displayName: 'Output Format',
            type: 'options',
            default: 'separateItems',
            options: [
              { name: 'Each Split in a Separate Item', value: 'separateItems' },
              { name: 'All Splits in a Single Item', value: 'singleItem' },
            ],
          },
          { name: 'skipEmptySplitFields', displayName: 'Ignore Items Without Valid Fields to Group By', type: 'boolean', default: false },
        ],
      },
    ],
  },
  execute(ctx) {
    const items = ctx.getInputData();
    const options =
      ctx.getNodeParameter<{ continueIfFieldNotFound?: boolean; disableDotNotation?: boolean; outputFormat?: string; skipEmptySplitFields?: boolean }>(
        'options',
        0,
      ) ?? {};
    const dot = !options.disableDotNotation;
    const specs = (ctx.getNodeParameter<{ values?: FieldToSummarize[] }>('fieldsToSummarize', 0)?.values ?? []).map((spec) => ({
      ...spec,
      aggregation: spec.aggregation ?? 'count',
      field: cleanField(spec.field),
    }));
    if (!specs.length) throw new NodeOperationError('No fields to summarize', { description: 'Add a field to “Fields To Summarize”.' });
    const blank = specs.find((spec) => !spec.field);
    if (blank) throw new NodeOperationError('A field to summarize has no name', { description: 'Enter a field name or remove the empty row.' });
    const splitBy = fieldList(ctx.getNodeParameter('fieldsToSplitBy', 0), 'Fields To Split By');

    if (!options.continueIfFieldNotFound && items.length) {
      for (const field of new Set([...specs.map((spec) => spec.field), ...splitBy])) {
        if (!items.some((item) => hasPath(item.json, field, dot))) {
          throw new NodeOperationError(`The field “${field}” does not exist in any items`, {
            description: 'Check the name, or turn on “Continue if Field Not Found”.',
          });
        }
      }
    }

    // Group items by the values of the split fields, in order of first appearance.
    const groups = new Map<string, { values: unknown[]; indexes: number[] }>();
    items.forEach((item, i) => {
      const values = splitBy.map((field) => getPath(item.json, field, dot));
      if (options.skipEmptySplitFields && values.some(isEmptyValue)) return;
      const key = stableStringify(values);
      const group = groups.get(key) ?? { values, indexes: [] };
      group.indexes.push(i);
      groups.set(key, group);
    });

    const summarize = (indexes: number[]) => {
      const result: Record<string, unknown> = {};
      for (const spec of specs) {
        result[PREFIX[spec.aggregation] + spec.field] = summarizeValues(
          indexes.map((i) => getPath(items[i].json, spec.field, dot)),
          spec,
        );
      }
      return result;
    };

    if (!splitBy.length) return [[{ json: plain(summarize(items.map((_item, i) => i))), pairedItem: { item: 0 } }]];

    if (options.outputFormat === 'singleItem') {
      // { country: { US: { status: { open: { count_id: 2 } } } } }
      const tree: Record<string, unknown> = {};
      for (const group of groups.values()) {
        let cursor = tree;
        group.values.forEach((value, f) => {
          const byField = (cursor[splitBy[f]] ??= {}) as Record<string, unknown>;
          const label = typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value);
          cursor = (byField[label] ??= {}) as Record<string, unknown>;
        });
        Object.assign(cursor, summarize(group.indexes));
      }
      return [[{ json: plain(tree), pairedItem: { item: 0 } }]];
    }

    return [
      [...groups.values()].map((group) => ({
        json: plain({ ...Object.fromEntries(splitBy.map((field, f) => [field, group.values[f] ?? null])), ...summarize(group.indexes) }),
        pairedItem: { item: group.indexes[0] },
      })),
    ];
  },
});

// ---------------------------------------------------------------------------
// Rename Keys
// ---------------------------------------------------------------------------

interface KeyPair {
  currentKey?: string;
  newKey?: string;
}

interface RegexReplacement {
  searchRegex?: string;
  replaceRegex?: string;
  caseInsensitive?: boolean;
  depth?: number;
}

/** Rename top-level keys in place, keeping their position. A swap (a→b, b→a) works. */
function renameTopLevel(json: Record<string, unknown>, renames: Map<string, string>): Record<string, unknown> {
  const targets = new Set(renames.values());
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(json)) {
    if (renames.has(key)) out[renames.get(key)!] = value;
    else if (!targets.has(key)) out[key] = value;
  }
  return out;
}

function renameByRegex(value: unknown, regex: RegExp, replacement: string, depth: number, level = 0): unknown {
  if (Array.isArray(value)) return value.map((entry) => renameByRegex(entry, regex, replacement, depth, level));
  if (typeof value !== 'object' || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const name = depth < 0 || level <= depth ? key.replace(regex, replacement) : key;
    out[name] = depth < 0 || level < depth ? renameByRegex(entry, regex, replacement, depth, level + 1) : entry;
  }
  return out;
}

export const renameKeysNode = defineNode({
  description: {
    ...DATA,
    name: 'renameKeys',
    displayName: 'Rename Keys',
    description: 'Rename fields, by name or with a regular expression',
    icon: 'lucide:replace',
    keywords: ['rename', 'keys', 'fields', 'map', 'regex'],
    properties: [
      {
        name: 'keys',
        displayName: 'Keys',
        type: 'fixedCollection',
        typeOptions: { multipleValues: true },
        default: { key: [{ currentKey: '', newKey: '' }] },
        groups: [
          {
            name: 'key',
            displayName: 'Key',
            values: [
              { name: 'currentKey', displayName: 'Current Key Name', type: 'string', default: '', noDataExpression: true, placeholder: 'e.g. user.firstName' },
              { name: 'newKey', displayName: 'New Key Name', type: 'string', default: '', noDataExpression: true, placeholder: 'e.g. user.first_name' },
            ],
          },
        ],
      },
      {
        name: 'additionalOptions',
        displayName: 'Additional Options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        values: [
          {
            name: 'regexReplacement',
            displayName: 'Regex',
            type: 'fixedCollection',
            typeOptions: { multipleValues: true },
            default: { replacements: [{ searchRegex: '', replaceRegex: '', caseInsensitive: false, depth: -1 }] },
            description: 'Rename every key that matches; the replacement can use $1, $2…',
            groups: [
              {
                name: 'replacements',
                displayName: 'Replacement',
                values: [
                  { name: 'searchRegex', displayName: 'Regular Expression', type: 'string', default: '', noDataExpression: true, placeholder: 'e.g. ^old_' },
                  { name: 'replaceRegex', displayName: 'Replace With', type: 'string', default: '', noDataExpression: true, placeholder: 'e.g. new_' },
                  { name: 'caseInsensitive', displayName: 'Case Insensitive', type: 'boolean', default: false },
                  {
                    name: 'depth',
                    displayName: 'Max Depth',
                    type: 'number',
                    default: -1,
                    description: '-1 renames keys at every level, 0 only top-level keys',
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  },
  execute(ctx) {
    return [
      ctx.getInputData().map((item, i) => {
        const pairs = (ctx.getNodeParameter<{ key?: KeyPair[] }>('keys', i)?.key ?? [])
          .map((pair) => ({ from: cleanField(pair.currentKey), to: cleanField(pair.newKey) }))
          .filter((pair) => pair.from && pair.to && pair.from !== pair.to);
        let json = clone(item.json) as Record<string, unknown>;

        const topLevel = pairs.filter((pair) => !/[.[]/.test(pair.from) && !/[.[]/.test(pair.to) && pair.from in json);
        if (topLevel.length) json = renameTopLevel(json, new Map(topLevel.map((pair) => [pair.from, pair.to])));
        // Paths: read every value first, then remove and set, so overlapping renames don't clobber each other.
        const nested = pairs
          .filter((pair) => !topLevel.includes(pair) && hasPath(json, pair.from))
          .map((pair) => ({ ...pair, value: getPath(json, pair.from) }));
        for (const pair of nested) unsetPath(json, pair.from);
        for (const pair of nested) setPath(json, pair.to, pair.value);

        const replacements =
          ctx.getNodeParameter<{ regexReplacement?: { replacements?: RegexReplacement[] } }>('additionalOptions', i)?.regexReplacement?.replacements ?? [];
        for (const replacement of replacements) {
          if (!replacement.searchRegex) continue;
          let regex: RegExp;
          try {
            regex = new RegExp(replacement.searchRegex, replacement.caseInsensitive ? 'gi' : 'g');
          } catch (error) {
            throw new NodeOperationError(`Invalid regular expression: ${replacement.searchRegex}`, { itemIndex: i, description: (error as Error).message });
          }
          json = renameByRegex(json, regex, replacement.replaceRegex ?? '', Number(replacement.depth ?? -1)) as Record<string, unknown>;
        }
        return { json: plain(json), ...(item.binary && { binary: item.binary }), pairedItem: { item: i } };
      }),
    ];
  },
});
