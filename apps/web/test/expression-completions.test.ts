import { describe, expect, it } from 'vitest';
import { applyCompletion, completionsAt, expressionAt, expressionSegments, sampleOf, type CompletionData } from '@/components/editor/expression-completions';

const data: CompletionData = {
  json: { name: 'Ada', age: 36, tags: ['a', 'b'], 'first name': 'Ada', address: { city: 'London' } },
  nodes: [{ name: 'HTTP Request', json: { status: 200, body: { id: 7 } } }, { name: 'Webhook' }],
  vars: ['API_URL'],
};
/** Completions with the caret at the `|` marker. */
const at = (text: string) => {
  const caret = text.indexOf('|');
  const value = text.replace('|', '');
  return { value, result: completionsAt(value, caret, data) };
};
const labels = (text: string) => at(text).result?.items.map((c) => c.label) ?? [];

describe('expression segments', () => {
  it('splits text, braces and code, including an unclosed expression', () => {
    expect(expressionSegments('Hi {{ $json.name }}!')).toEqual([
      { text: 'Hi ', kind: 'text' },
      { text: '{{', kind: 'brace' },
      { text: ' $json.name ', kind: 'code' },
      { text: '}}', kind: 'brace' },
      { text: '!', kind: 'text' },
    ]);
    expect(expressionSegments('a {{ $js')).toEqual([
      { text: 'a ', kind: 'text' },
      { text: '{{', kind: 'brace' },
      { text: ' $js', kind: 'code' },
    ]);
    expect(expressionAt('x {{ a }} y', 10)).toBeUndefined();
    expect(expressionAt('x {{ $json.', 11)).toEqual({ start: 4, code: ' $json.' });
  });
});

describe('completionsAt', () => {
  it('suggests nothing outside {{ }}', () => {
    expect(at('$json.|').result).toBeUndefined();
  });

  it('suggests the variables at the start of an expression', () => {
    const list = labels('{{ |');
    expect(list).toEqual(expect.arrayContaining(['$json', '$input', '$now', '$today', '$workflow', '$execution', '$itemIndex', '$vars', "$('HTTP Request')"]));
    expect(labels('{{ $no|')).toEqual(['$now']);
  });

  it('suggests $json fields from the input sample, with bracket access for odd keys', () => {
    expect(labels('{{ $json.|')).toEqual(['name', 'age', 'tags', 'first name', 'address']);
    expect(labels('{{ $json.ad|')).toEqual(['address']);
    expect(labels('{{ $json.address.|')).toEqual(['city']);
    const { value, result } = at('{{ $json.fir| }}');
    const item = result!.items.find((c) => c.label === 'first name')!;
    expect(applyCompletion(value, result!, item).text).toBe("{{ $json['first name'] }}");
  });

  it('suggests methods for the value type', () => {
    expect(labels('{{ $json.name.|')).toEqual(expect.arrayContaining(['toUpperCase()', 'length', 'split(\',\')']));
    expect(labels('{{ $json.tags.|')).toEqual(expect.arrayContaining(['join(\', \')', 'map(x => x)', 'length']));
    expect(labels('{{ $json.age.|')).toEqual(expect.arrayContaining(['toFixed(2)']));
    expect(labels('{{ $now.|')).toEqual(expect.arrayContaining(['toISOString()', 'getFullYear()']));
    expect(labels('{{ $json.name.toUpperCase().|')).toEqual(expect.arrayContaining(['toLowerCase()']));
  });

  it("suggests node names after $(' and their output after .item.json", () => {
    const { value, result } = at("{{ $('HT|') }}");
    expect(result!.items.map((c) => c.label)).toEqual(['HTTP Request']);
    // The closing quote and parenthesis already typed are replaced, not doubled.
    expect(applyCompletion(value, result!, result!.items[0]).text).toBe("{{ $('HTTP Request') }}");
    expect(labels("{{ $('HTTP Request').|")).toEqual(['item', 'json', 'first()', 'last()', 'all()']);
    expect(labels("{{ $('HTTP Request').item.json.|")).toEqual(['status', 'body']);
    expect(labels("{{ $('HTTP Request').first().json.body.|")).toEqual(['id']);
    expect(at("{{ $('Webhook').item.json.|").result).toMatchObject({ items: [], hint: expect.stringContaining('No data yet') });
  });

  it('suggests $input members and $vars names', () => {
    expect(labels('{{ $input.|')).toEqual(['item', 'json', 'first()', 'last()', 'all()']);
    expect(labels('{{ $input.item.json.|')).toContain('name');
    expect(labels('{{ $vars.|')).toEqual(['API_URL']);
  });

  it('replaces the rest of the word after the caret', () => {
    const { value, result } = at('{{ $json.na|me }}');
    expect(applyCompletion(value, result!, result!.items.find((c) => c.label === 'name')!).text).toBe('{{ $json.name }}');
  });
});

describe('sampleOf', () => {
  it('merges the first items so fields only some items have still show', () => {
    expect(sampleOf([{ json: { a: 1 } }, { json: { b: 2, a: 5 } }])).toEqual({ a: 1, b: 2 });
    expect(sampleOf([])).toBeUndefined();
  });
});
