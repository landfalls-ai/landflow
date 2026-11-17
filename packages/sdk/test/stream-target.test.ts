/** AG14: a `tool` stream chunk carries what the call reached (`target`), unchanged through JSON, and the app's ToolTarget is assignable to it. */
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { StreamChunk } from '../src/node';
import type { ToolTarget } from '../../../apps/web/src/lib/shared/tool-target';

type Target = NonNullable<NonNullable<StreamChunk['tool']>['target']>;

describe('the tool chunk’s target', () => {
  it('round-trips through JSON unchanged', () => {
    const chunk: StreamChunk = {
      type: 'tool',
      itemIndex: 0,
      tool: {
        id: 'c1',
        name: 'send_email',
        status: 'finished',
        output: 'sent',
        target: { name: 'Mailpit SMTP', system: 'SMTP', endpoint: '127.0.0.1:51183', credentialId: 'cred_1', plugin: { id: 'messaging', endpoint: '127.0.0.1:7104' }, knowledge: { collection: 'runbooks', store: 'SQLite', embeddings: 'keyword search (BM25, built in)', documents: 4 } },
      },
    };
    expect(JSON.parse(JSON.stringify(chunk))).toEqual(chunk);
  });

  it('accepts the app’s ToolTarget, and a chunk without a target still type-checks', () => {
    expectTypeOf<ToolTarget>().toMatchTypeOf<Target>();
    expectTypeOf<Target>().toMatchTypeOf<ToolTarget>();
    const plain: StreamChunk = { type: 'tool', tool: { id: 'c2', name: 'x', status: 'started' } };
    expect(plain.tool?.target).toBeUndefined();
  });
});
