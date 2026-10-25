import { describe, expect, it } from 'vitest';
import { SWITCH_OUTPUTS, switchNode } from '@/lib/server/nodes/flow';
import { outputsOf, run, runFlow } from './helpers';

const rule = (left: string, operator: string, right = '') => ({ conditions: { condition: [{ left, operator, right }] }, combinator: 'and' });
const input = [
  { n: 1, tag: 'a' },
  { n: 5, tag: 'b' },
  { n: 12, tag: 'ab' },
  { n: 50, tag: 'z' },
];
const ns = (branch: Array<Record<string, unknown>>) => branch.map((json) => json.n);

describe('Switch', () => {
  it('has four rule outputs plus Fallback', () => {
    expect(switchNode.description.outputs.map((o) => o.displayName)).toEqual(['0', '1', '2', '3', 'Fallback']);
    expect(SWITCH_OUTPUTS).toBe(4);
  });

  it('routes each item to the first matching rule, evaluated per item', async () => {
    const result = await runFlow(
      [
        {
          name: 'Switch',
          type: 'core.switch',
          parameters: { mode: 'rules', rules: { values: [rule('{{ $json.n }}', 'lt', '10'), rule('{{ $json.tag }}', 'contains', 'a')] } },
        },
      ],
      [['Start', 'Switch']],
      { input },
    );
    const outputs = outputsOf(result, 'Switch');
    expect(outputs.map(ns)).toEqual([[1, 5], [12], [], [], []]);
  });

  it('sends to all matching outputs and to the Fallback output when asked', async () => {
    const result = await runFlow(
      [
        {
          name: 'Switch',
          type: 'core.switch',
          parameters: {
            rules: { values: [rule('{{ $json.n }}', 'lt', '10'), rule('{{ $json.tag }}', 'contains', 'a')] },
            options: { allMatchingOutputs: true, fallbackOutput: 'extra' },
          },
        },
      ],
      [['Start', 'Switch']],
      { input },
    );
    expect(outputsOf(result, 'Switch').map(ns)).toEqual([[1, 5], [1, 12], [], [], [50]]);
  });

  it('feeds downstream nodes from the right output', async () => {
    const result = await runFlow(
      [
        { name: 'Switch', type: 'core.switch', parameters: { rules: { values: [rule('{{ $json.n }}', 'gt', '10')] }, options: { fallbackOutput: 'extra' } } },
        { name: 'Big', type: 'core.noOp' },
        { name: 'Rest', type: 'core.noOp' },
      ],
      [
        ['Start', 'Switch'],
        ['Switch', 'Big', 'main', 0],
        ['Switch', 'Rest', 'main', SWITCH_OUTPUTS],
      ],
      { input },
    );
    expect(ns(outputsOf(result, 'Big')[0])).toEqual([12, 50]);
    expect(ns(outputsOf(result, 'Rest')[0])).toEqual([1, 5]);
  });

  it('routes by an output index expression', async () => {
    const result = await runFlow(
      [{ name: 'Switch', type: 'core.switch', parameters: { mode: 'expression', output: '{{ $json.n % 4 }}' } }],
      [['Start', 'Switch']],
      { input },
    );
    expect(outputsOf(result, 'Switch').map(ns)).toEqual([[12], [1, 5], [50], [], []]);
  });

  it('rejects an output index out of range, and too many rules', async () => {
    const bad = await run(switchNode, { mode: 'expression', output: 4 }, [{}]);
    expect(bad.error?.message).toMatch(/Output 4 doesn't exist/);
    const many = await run(switchNode, { mode: 'rules', rules: { values: Array.from({ length: 5 }, () => rule('1', 'equals', '1')) } }, [{}]);
    expect(many.error?.message).toMatch(/4 rule outputs, but 5 rules/);
  });

  it('drops unmatched items without a fallback', async () => {
    const result = await run(switchNode, { mode: 'rules', rules: { values: [rule('x', 'equals', 'y')] } }, [{}]);
    expect(result.outputs.every((branch) => branch.length === 0)).toBe(true);
  });
});
