import { describe, expect, it } from 'vitest';
import { ExpressionResolver } from '../src';

const resolver = new ExpressionResolver({
  items: [{ json: { n: 0 } }, { json: { n: 1 } }],
  nodeOutputs: { Customers: [{ json: { id: 'a' }, binary: { data: { mimeType: 'text/plain', fileSize: 1 } } }, { json: { id: 'b' } }, { json: { id: 'c' } }] },
  workflow: { id: 'wf', name: 'Flow' },
  execution: { id: 'ex', mode: 'manual' },
  parameters: {},
});
const at = (code: string, index = 0) => resolver.evaluate(code, index);

describe("$('Node') in expressions", () => {
  it('has item, first, last, all, itemMatching, isExecuted and $node', () => {
    expect(at("$('Customers').item.json.id", 1)).toBe('b');
    expect(at("$('Customers').first().json.id")).toBe('a');
    expect(at("$('Customers').last().json.id")).toBe('c');
    expect(at("$('Customers').all().length")).toBe(3);
    expect(at("$('Customers').itemMatching(2).json.id")).toBe('c');
    expect(at("$('Customers').isExecuted")).toBe(true);
    expect(at("$('Nowhere').isExecuted")).toBe(false);
    expect(at("$node['Customers'].json.id")).toBe('a');
    expect(at("$node.Customers.binary.data.fileSize")).toBe(1);
    expect(at("$input.item.json.n", 1)).toBe(1);
  });

  it('throws when a node that has not run is read', () => {
    expect(() => at("$('Nowhere').first()")).toThrow('Node "Nowhere" has not run yet');
    expect(() => at("$('Customers').itemMatching(9)")).toThrow('no item matching input item 9');
  });
});
