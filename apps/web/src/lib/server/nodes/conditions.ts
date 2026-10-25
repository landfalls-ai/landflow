import type { PropertyDescriptor } from '@landflow/sdk';

export interface Condition {
  left?: unknown;
  operator?: string;
  right?: unknown;
}

export const OPERATORS = [
  { name: 'is equal to', value: 'equals' },
  { name: 'is not equal to', value: 'notEquals' },
  { name: 'contains', value: 'contains' },
  { name: 'does not contain', value: 'notContains' },
  { name: 'starts with', value: 'startsWith' },
  { name: 'is greater than', value: 'gt' },
  { name: 'is greater or equal', value: 'gte' },
  { name: 'is less than', value: 'lt' },
  { name: 'is less or equal', value: 'lte' },
  { name: 'matches regex', value: 'regex' },
  { name: 'is empty', value: 'isEmpty' },
  { name: 'is not empty', value: 'isNotEmpty' },
  { name: 'is true', value: 'isTrue' },
  { name: 'is false', value: 'isFalse' },
];

export const conditionProperties: PropertyDescriptor[] = [
  {
    name: 'conditions',
    displayName: 'Conditions',
    type: 'fixedCollection',
    typeOptions: { multipleValues: true },
    default: { condition: [{ left: '{{ $json.value }}', operator: 'isNotEmpty', right: '' }] },
    groups: [
      {
        name: 'condition',
        displayName: 'Condition',
        values: [
          { name: 'left', displayName: 'Value', type: 'string', default: '', placeholder: '{{ $json.status }}' },
          { name: 'operator', displayName: 'Operator', type: 'options', default: 'equals', options: OPERATORS },
          { name: 'right', displayName: 'Compare To', type: 'string', default: '' },
        ],
      },
    ],
  },
  {
    name: 'combinator',
    displayName: 'Combine',
    type: 'options',
    default: 'and',
    options: [
      { name: 'All conditions (AND)', value: 'and' },
      { name: 'Any condition (OR)', value: 'or' },
    ],
  },
];

const isEmpty = (v: unknown) =>
  v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0) || (typeof v === 'object' && Object.keys(v as object).length === 0);

const toNumber = (v: unknown) => (typeof v === 'number' ? v : Number(v));

export function evaluate(condition: Condition): boolean {
  const { left, right } = condition;
  switch (condition.operator) {
    case 'equals':
      return String(left) === String(right);
    case 'notEquals':
      return String(left) !== String(right);
    case 'contains':
      return String(left ?? '').includes(String(right ?? ''));
    case 'notContains':
      return !String(left ?? '').includes(String(right ?? ''));
    case 'startsWith':
      return String(left ?? '').startsWith(String(right ?? ''));
    case 'gt':
      return toNumber(left) > toNumber(right);
    case 'gte':
      return toNumber(left) >= toNumber(right);
    case 'lt':
      return toNumber(left) < toNumber(right);
    case 'lte':
      return toNumber(left) <= toNumber(right);
    case 'regex':
      try {
        return new RegExp(String(right)).test(String(left ?? ''));
      } catch {
        return false;
      }
    case 'isEmpty':
      return isEmpty(left);
    case 'isNotEmpty':
      return !isEmpty(left);
    case 'isTrue':
      return left === true || left === 'true';
    case 'isFalse':
      return left === false || left === 'false';
    default:
      return Boolean(left);
  }
}

export function matches(parameters: { conditions?: { condition?: Condition[] }; combinator?: string }): boolean {
  const list = parameters.conditions?.condition ?? [];
  if (!list.length) return true;
  return parameters.combinator === 'or' ? list.some(evaluate) : list.every(evaluate);
}
