// displayOptions-aware defaults from @landflow/protocol, which the SDK runtime and the editor both use.
import { expect, it } from 'vitest';
import { changeParameter, defaultParameters } from '@landflow/protocol';

const properties = [
  { name: 'resource', displayName: 'R', type: 'options', default: 'message' },
  { name: 'operation', displayName: 'O', type: 'options', default: 'send', displayOptions: { show: { resource: ['message'] } } },
  { name: 'operation', displayName: 'O', type: 'options', default: 'get', displayOptions: { show: { resource: ['chat'] } } },
  { name: 'text', displayName: 'T', type: 'string', default: '', displayOptions: { show: { operation: ['send'] } } },
  { name: 'returnAll', displayName: 'A', type: 'boolean', default: false, displayOptions: { show: { operation: ['get'] } } },
  { name: 'limit', displayName: 'L', type: 'number', default: 50, displayOptions: { show: { operation: ['get'], returnAll: [false] } } },
] as never;

it('defaults and changes follow displayOptions', () => {
  const initial = defaultParameters({ properties });
  expect(initial).toEqual({ resource: 'message', operation: 'send', text: '' });
  const typed = changeParameter(properties, initial, 'text', 'hi');
  expect(typed).toEqual({ resource: 'message', operation: 'send', text: 'hi' });
  const chat = changeParameter(properties, typed, 'resource', 'chat');
  expect(chat).toEqual({ resource: 'chat', operation: 'get', returnAll: false, limit: 50 });
  expect(changeParameter(properties, chat, 'returnAll', true)).toEqual({ resource: 'chat', operation: 'get', returnAll: true });
});
