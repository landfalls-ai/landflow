import { describe, expect, it } from 'vitest';
import { aggregateNode, removeDuplicatesNode, renameKeysNode, splitOutNode, summarizeNode } from '@/lib/server/nodes/transform';
import { run, runOk } from './helpers';

describe('Split Out', () => {
  const order = {
    id: 7,
    customer: { name: 'Ada' },
    lines: [
      { sku: 'a', qty: 1 },
      { sku: 'b', qty: 2 },
    ],
  };

  it('turns a list of objects into items (no other fields)', async () => {
    const result = await runOk(splitOutNode, { fieldToSplitOut: 'lines', include: 'noOtherFields' }, [order]);
    expect(result.json()).toEqual([
      { sku: 'a', qty: 1 },
      { sku: 'b', qty: 2 },
    ]);
    expect(result.outputs[0].map((item) => item.pairedItem)).toEqual([{ item: 0 }, { item: 0 }]);
  });

  it('wraps primitives under the field name, or the destination field', async () => {
    expect((await runOk(splitOutNode, { fieldToSplitOut: 'tags' }, [{ tags: ['x', 'y'] }])).json()).toEqual([{ tags: 'x' }, { tags: 'y' }]);
    expect((await runOk(splitOutNode, { fieldToSplitOut: 'tags', options: { destinationFieldName: 'tag' } }, [{ tags: ['x'] }])).json()).toEqual([
      { tag: 'x' },
    ]);
  });

  it('keeps all other fields; the element replaces the list under its name', async () => {
    const result = await runOk(splitOutNode, { fieldToSplitOut: 'lines', include: 'allOtherFields' }, [order]);
    expect(result.json()).toEqual([
      { id: 7, customer: { name: 'Ada' }, lines: { sku: 'a', qty: 1 } },
      { id: 7, customer: { name: 'Ada' }, lines: { sku: 'b', qty: 2 } },
    ]);
  });

  it('keeps selected fields by path', async () => {
    const result = await runOk(splitOutNode, { fieldToSplitOut: 'lines', include: 'selectedOtherFields', fieldsToInclude: 'id, customer.name' }, [order]);
    expect(result.json()[1]).toEqual({ lines: { sku: 'b', qty: 2 }, id: 7, 'customer.name': 'Ada' });
    const missing = await run(splitOutNode, { fieldToSplitOut: 'lines', include: 'selectedOtherFields', fieldsToInclude: '' }, [order]);
    expect(missing.error?.message).toMatch(/No fields to include/);
  });

  it('splits several fields side by side and reads dot paths and dragged expressions', async () => {
    const result = await runOk(splitOutNode, { fieldToSplitOut: 'a, b' }, [{ a: [1, 2], b: ['x'] }]);
    expect(result.json()).toEqual([{ a: 1, b: 'x' }, { a: 2 }]);
    expect((await runOk(splitOutNode, { fieldToSplitOut: '{{ $json.data.list }}' }, [{ data: { list: [3] } }])).json()).toEqual([{ 'data.list': 3 }]);
  });

  it('splits object values, skips items without the field, and warns when no item has it', async () => {
    expect((await runOk(splitOutNode, { fieldToSplitOut: 'map' }, [{ map: { a: 1, b: 2 } }])).json()).toEqual([{ map: 1 }, { map: 2 }]);
    const result = await runOk(splitOutNode, { fieldToSplitOut: 'nope' }, [{ a: 1 }]);
    expect(result.json()).toEqual([]);
    expect(result.logs?.some((log) => log.level === 'warn' && log.message.includes('nope'))).toBe(true);
  });

  it('requires one destination per field', async () => {
    const result = await run(splitOutNode, { fieldToSplitOut: 'a, b', options: { destinationFieldName: 'x' } }, [{ a: [1], b: [2] }]);
    expect(result.error?.message).toMatch(/one destination field per field/);
  });
});

describe('Aggregate', () => {
  const input = [
    { id: 1, user: { email: 'a@x' }, tags: ['red'] },
    { id: 2, user: { email: null }, tags: ['blue', 'green'] },
    { id: 3, tags: [] },
  ];

  it('collects individual fields, skipping missing and null values', async () => {
    const result = await runOk(
      aggregateNode,
      { aggregate: 'aggregateIndividualFields', fieldsToAggregate: { fieldToAggregate: [{ fieldToAggregate: 'id' }, { fieldToAggregate: 'user.email' }] } },
      input,
    );
    expect(result.json()).toEqual([{ id: [1, 2, 3], email: ['a@x'] }]);
  });

  it('keeps missing values, merges lists and renames', async () => {
    const result = await runOk(
      aggregateNode,
      {
        aggregate: 'aggregateIndividualFields',
        fieldsToAggregate: {
          fieldToAggregate: [{ fieldToAggregate: 'user.email', renameField: true, outputFieldName: 'emails' }, { fieldToAggregate: 'tags' }],
        },
        options: { keepMissing: true, mergeLists: true },
      },
      input,
    );
    expect(result.json()).toEqual([{ emails: ['a@x', null, null], tags: ['red', 'blue', 'green'] }]);
  });

  it('rejects an output field used twice', async () => {
    const result = await run(aggregateNode, { fieldsToAggregate: { fieldToAggregate: [{ fieldToAggregate: 'a.id' }, { fieldToAggregate: 'b.id' }] } }, input);
    expect(result.error?.message).toMatch(/“id” output field is used more than once/);
  });

  it('puts all item data into one list, with included or excluded fields', async () => {
    expect(
      (await runOk(aggregateNode, { aggregate: 'aggregateAllItemData', destinationFieldName: 'rows', include: 'allFields' }, input.slice(0, 1))).json(),
    ).toEqual([{ rows: [input[0]] }]);
    const picked = await runOk(
      aggregateNode,
      { aggregate: 'aggregateAllItemData', destinationFieldName: 'data', include: 'specifiedFields', fieldsToInclude: 'id, user.email' },
      input,
    );
    expect(picked.json()[0].data).toEqual([{ id: 1, user: { email: 'a@x' } }, { id: 2, user: { email: null } }, { id: 3 }]);
    const except = await runOk(aggregateNode, { aggregate: 'aggregateAllItemData', include: 'allFieldsExcept', fieldsToExclude: 'tags, user' }, input);
    expect(except.json()[0].data).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
  });
});

describe('Remove Duplicates', () => {
  it('compares all fields, whatever the key order', async () => {
    const result = await runOk(removeDuplicatesNode, { compare: 'allFields' }, [{ a: 1, b: { c: 2 } }, { b: { c: 2 }, a: 1 }, { a: 2 }]);
    expect(result.json()).toEqual([{ a: 1, b: { c: 2 } }, { a: 2 }]);
    expect(result.outputs[0].map((item) => item.pairedItem)).toEqual([{ item: 0 }, { item: 2 }]);
  });

  it('compares all fields except some', async () => {
    const result = await runOk(removeDuplicatesNode, { compare: 'allFieldsExcept', fieldsToExclude: 'at' }, [
      { id: 1, at: 't1' },
      { id: 1, at: 't2' },
      { id: 2, at: 't3' },
    ]);
    expect(result.json()).toEqual([
      { id: 1, at: 't1' },
      { id: 2, at: 't3' },
    ]);
  });

  it('compares selected fields (paths), optionally keeping only them', async () => {
    const input = [{ user: { email: 'a@x' }, n: 1 }, { user: { email: 'a@x' }, n: 2 }, { user: { email: 'b@x' }, n: 3 }, { n: 4 }];
    expect((await runOk(removeDuplicatesNode, { compare: 'selectedFields', fieldsToCompare: 'user.email' }, input)).json().map((j) => j.n)).toEqual([1, 3, 4]);
    const trimmed = await runOk(
      removeDuplicatesNode,
      { compare: 'selectedFields', fieldsToCompare: 'user.email', options: { removeOtherFields: true } },
      input.slice(0, 3),
    );
    expect(trimmed.json()).toEqual([{ user: { email: 'a@x' } }, { user: { email: 'b@x' } }]);
  });

  it('fails on a field no item has (a typo)', async () => {
    const result = await run(removeDuplicatesNode, { compare: 'selectedFields', fieldsToCompare: 'emial' }, [{ email: 'a' }]);
    expect(result.error?.message).toMatch(/Not found in any input item: emial/);
  });
});

describe('Summarize', () => {
  const sales = [
    { country: 'US', status: 'paid', amount: 10, email: 'a@x', note: 'x' },
    { country: 'US', status: 'open', amount: '5', email: 'a@x', note: '' },
    { country: 'DE', status: 'paid', amount: 7.5, email: 'b@x' },
    { country: 'US', status: 'paid', amount: 2, email: 'c@x', note: 'y' },
  ];
  const fields = (...values: Array<Record<string, unknown>>) => ({ values });

  it('computes every aggregation over all items', async () => {
    const result = await runOk(
      summarizeNode,
      {
        fieldsToSummarize: fields(
          { aggregation: 'count', field: 'note' },
          { aggregation: 'count', field: 'note', includeEmpty: true },
          { aggregation: 'countUnique', field: 'email' },
          { aggregation: 'sum', field: 'amount' },
          { aggregation: 'average', field: 'amount' },
          { aggregation: 'min', field: 'amount' },
          { aggregation: 'max', field: 'country' },
          { aggregation: 'concatenate', field: 'country', separateBy: 'other', customSeparator: '|' },
          { aggregation: 'append', field: 'note' },
        ),
      },
      sales,
    );
    // The second count of the same field overwrites the first: n8n names them both count_note.
    expect(result.json()).toEqual([
      {
        count_note: 4,
        unique_count_email: 3,
        sum_amount: 24.5,
        average_amount: 6.125,
        min_amount: 2,
        max_country: 'US',
        concatenated_country: 'US|US|DE|US',
        appended_note: ['x', 'y'],
      },
    ]);
  });

  it('splits by fields, one item per group in order of appearance', async () => {
    const result = await runOk(
      summarizeNode,
      { fieldsToSummarize: fields({ aggregation: 'sum', field: 'amount' }, { aggregation: 'count', field: 'email' }), fieldsToSplitBy: 'country, status' },
      sales,
    );
    expect(result.json()).toEqual([
      { country: 'US', status: 'paid', sum_amount: 12, count_email: 2 },
      { country: 'US', status: 'open', sum_amount: 5, count_email: 1 },
      { country: 'DE', status: 'paid', sum_amount: 7.5, count_email: 1 },
    ]);
    expect(result.outputs[0][2].pairedItem).toEqual({ item: 2 });
  });

  it('outputs all splits in a single item', async () => {
    const result = await runOk(
      summarizeNode,
      { fieldsToSummarize: fields({ aggregation: 'count', field: 'email' }), fieldsToSplitBy: 'country', options: { outputFormat: 'singleItem' } },
      sales,
    );
    expect(result.json()).toEqual([{ country: { US: { count_email: 3 }, DE: { count_email: 1 } } }]);
  });

  it('can ignore items with an empty split field', async () => {
    const input = [{ g: 'a', v: 1 }, { g: '', v: 2 }, { v: 3 }];
    expect((await runOk(summarizeNode, { fieldsToSummarize: fields({ aggregation: 'sum', field: 'v' }), fieldsToSplitBy: 'g' }, input)).json()).toHaveLength(3);
    expect(
      (
        await runOk(
          summarizeNode,
          { fieldsToSummarize: fields({ aggregation: 'sum', field: 'v' }), fieldsToSplitBy: 'g', options: { skipEmptySplitFields: true } },
          input,
        )
      ).json(),
    ).toEqual([{ g: 'a', sum_v: 1 }]);
  });

  it('fails on a missing field unless told to continue, and on non-numbers in a sum', async () => {
    expect((await run(summarizeNode, { fieldsToSummarize: fields({ aggregation: 'sum', field: 'price' }) }, sales)).error?.message).toMatch(
      /“price” does not exist/,
    );
    const lenient = await runOk(
      summarizeNode,
      { fieldsToSummarize: fields({ aggregation: 'sum', field: 'price' }), options: { continueIfFieldNotFound: true } },
      sales,
    );
    expect(lenient.json()).toEqual([{ sum_price: 0 }]);
    expect((await run(summarizeNode, { fieldsToSummarize: fields({ aggregation: 'sum', field: 'country' }) }, sales)).error?.message).toMatch(/not a number/);
  });
});

describe('Rename Keys', () => {
  it('renames in place, keeping the key order, and overwrites an existing key', async () => {
    const result = await runOk(
      renameKeysNode,
      {
        keys: {
          key: [
            { currentKey: 'b', newKey: 'beta' },
            { currentKey: 'c', newKey: 'a' },
          ],
        },
      },
      [{ a: 1, b: 2, c: 3, d: 4 }],
    );
    expect(result.json()[0]).toEqual({ beta: 2, a: 3, d: 4 });
    expect(Object.keys(result.json()[0])).toEqual(['beta', 'a', 'd']);
  });

  it('swaps two keys', async () => {
    const result = await runOk(
      renameKeysNode,
      {
        keys: {
          key: [
            { currentKey: 'x', newKey: 'y' },
            { currentKey: 'y', newKey: 'x' },
          ],
        },
      },
      [{ x: 1, y: 2 }],
    );
    expect(result.json()[0]).toEqual({ y: 1, x: 2 });
  });

  it('moves nested values by path and ignores missing keys', async () => {
    const result = await runOk(
      renameKeysNode,
      {
        keys: {
          key: [
            { currentKey: 'user.first', newKey: 'name.first' },
            { currentKey: 'nope', newKey: 'x' },
          ],
        },
      },
      [{ user: { first: 'Ada', last: 'L' } }],
    );
    expect(result.json()[0]).toEqual({ user: { last: 'L' }, name: { first: 'Ada' } });
  });

  it('renames by regex with a depth limit and case-insensitivity', async () => {
    const input = [{ Old_a: 1, nested: { old_b: 2, deeper: { old_c: 3 } } }];
    const all = await runOk(
      renameKeysNode,
      {
        keys: {},
        additionalOptions: { regexReplacement: { replacements: [{ searchRegex: '^old_', replaceRegex: 'new_', caseInsensitive: true, depth: -1 }] } },
      },
      input,
    );
    expect(all.json()[0]).toEqual({ new_a: 1, nested: { new_b: 2, deeper: { new_c: 3 } } });
    const top = await runOk(
      renameKeysNode,
      { keys: {}, additionalOptions: { regexReplacement: { replacements: [{ searchRegex: '^old_(\\w)', replaceRegex: '$1_new', depth: 1 }] } } },
      input,
    );
    expect(top.json()[0]).toEqual({ Old_a: 1, nested: { b_new: 2, deeper: { old_c: 3 } } });
  });

  it('reports an invalid regex', async () => {
    const result = await run(renameKeysNode, { additionalOptions: { regexReplacement: { replacements: [{ searchRegex: '([' }] } } }, [{ a: 1 }]);
    expect(result.error?.message).toMatch(/Invalid regular expression/);
  });
});
