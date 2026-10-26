import { describe, expect, it } from 'vitest';
import { defineNode } from '@landflow/sdk';
import {
  collectSecretReferences,
  executeWorkflow,
  ExpressionResolver,
  formatSecretReference,
  hasSecretReference,
  inProcessNodeType,
  secretReferences,
  SECRETS_NOT_ALLOWED,
  type ExpressionData,
  type NodeTypeResolver,
  type SecretReference,
  type Workflow,
} from '../src';

const data = (extra: Partial<ExpressionData> = {}): ExpressionData => ({
  items: [{ json: { name: 'Ada' } }],
  nodeOutputs: {},
  workflow: { id: 'wf', name: 'Test' },
  execution: { id: 'ex', mode: 'manual' },
  parameters: {},
  ...extra,
});

describe('secret references', () => {
  it('reads $secrets.<provider>.<name>[.<key>] and bracket steps', () => {
    expect(secretReferences('{{ $secrets.vault.db }}')).toEqual([{ provider: 'vault', name: 'db' }]);
    expect(secretReferences('{{ $secrets.vault.db.password }}')).toEqual([{ provider: 'vault', name: 'db', key: 'password' }]);
    expect(secretReferences("postgres://{{ $secrets.vault['app/db'].user }}:{{ $secrets . vault [\"app/db\"] . password }}@host")).toEqual([
      { provider: 'vault', name: 'app/db', key: 'user' },
      { provider: 'vault', name: 'app/db', key: 'password' },
    ]);
    expect(secretReferences("{{ $secrets.aws['it\\'s'] }}")).toEqual([{ provider: 'aws', name: "it's" }]);
    // Duplicates collapse; a provider alone or a dynamic name isn't a reference.
    expect(secretReferences('{{ $secrets.a.b + $secrets.a.b }} {{ $secrets.a }} {{ $secrets.a[$json.x] }}')).toEqual([{ provider: 'a', name: 'b' }]);
    // Outside {{ }} nothing is read (a password that happens to contain the text).
    expect(secretReferences('literal $secrets.vault.db text {{ 1 }}')).toEqual([]);
    expect(secretReferences('$secrets.vault.db')).toEqual([{ provider: 'vault', name: 'db' }]);
  });

  it('tells expressions with $secrets apart from other values', () => {
    expect(hasSecretReference('{{ $secrets.vault.db }}')).toBe(true);
    expect(hasSecretReference('Bearer {{$secrets.op.token.credential}}')).toBe(true);
    expect(hasSecretReference('{{ $vars.X }}')).toBe(false);
    expect(hasSecretReference('$secrets.vault.db')).toBe(false);
    expect(hasSecretReference(42)).toBe(false);
  });

  it('formats references back as expressions', () => {
    expect(formatSecretReference({ provider: 'vault', name: 'db', key: 'password' })).toBe('$secrets.vault.db.password');
    expect(formatSecretReference({ provider: 'vault', name: 'app/db' })).toBe("$secrets.vault['app/db']");
  });
});

describe('$secrets in the resolver', () => {
  it('reads fetched values: whole secrets, keys and interpolation', () => {
    const resolver = new ExpressionResolver(data({ secrets: { vault: { db: { user: 'app', password: 's3cr3t' }, 'app/token': 'tok-123' } } }));
    expect(resolver.resolveValue('{{ $secrets.vault.db.password }}', 0)).toBe('s3cr3t');
    expect(resolver.resolveValue("Bearer {{ $secrets.vault['app/token'] }}", 0)).toBe('Bearer tok-123');
    expect(resolver.resolveValue('{{ $secrets.vault.db }}', 0)).toEqual({ user: 'app', password: 's3cr3t' });
    expect(resolver.resolveValue('{{ $secrets.vault.db.user }}-{{ $json.name }}', 0)).toBe('app-Ada');
  });

  it('refuses names that were not fetched and secrets outside credential fields', () => {
    const resolver = new ExpressionResolver(data({ secrets: { vault: { db: 'x' } } }));
    expect(() => resolver.resolveValue('{{ $secrets.vault.other }}', 0)).toThrow(/was not loaded/);
    expect(() => resolver.resolveValue('{{ $secrets.aws.db }}', 0)).toThrow(/provider "aws"/);
    // The values can't be changed from an expression.
    expect(() => resolver.resolveValue("{{ $secrets.vault.db = 'y' }}", 0)).toThrow();
    const plain = new ExpressionResolver(data());
    expect(() => plain.resolveValue('{{ $secrets.vault.db }}', 0)).toThrow(SECRETS_NOT_ALLOWED);
    // Without secrets, everything else resolves as before.
    expect(plain.resolveValue('{{ $json.name }}', 0)).toBe('Ada');
  });
});

describe('collectSecretReferences', () => {
  it('walks parameters deeply, skips the given top-level keys and drops duplicates', () => {
    const parameters = {
      url: 'https://api/{{ $secrets.vault.api.host }}',
      headers: { values: [{ name: 'Authorization', value: 'Bearer {{ $secrets.vault.api.token }}' }, { name: 'X', value: '{{ $secrets.vault.api.token }}' }] },
      code: "return '{{ $secrets.vault.code }}'",
      plain: '$secrets.vault.literal',
    };
    expect(collectSecretReferences(parameters, new Set(['code']))).toEqual([
      { provider: 'vault', name: 'api', key: 'host' },
      { provider: 'vault', name: 'api', key: 'token' },
    ]);
    expect(collectSecretReferences('{{ $secrets.aws.x }}')).toEqual([{ provider: 'aws', name: 'x' }]);
    expect(collectSecretReferences({ a: 1, b: [null, { c: '{{ $json.x }}' }] })).toEqual([]);
  });
});

describe('$secrets in node parameters (loadSecrets)', () => {
  const main = [{ type: 'main' as const }];
  const trigger = defineNode({
    description: { name: 'trigger', displayName: 'Trigger', description: '', version: 1, kind: 'trigger', inputs: [], outputs: main, properties: [] },
    execute: (ctx) => [ctx.getInputData()],
  });
  const echo = defineNode({
    description: {
      name: 'echo', displayName: 'Echo', description: '', version: 1, kind: 'action', inputs: main, outputs: main,
      properties: [{ name: 'value', displayName: 'Value', type: 'string' }, { name: 'code', displayName: 'Code', type: 'code' }],
    },
    execute: (ctx) => ctx.getInputData().map((item, i) => ({ json: { ...item.json, value: ctx.getNodeParameter('value', i), code: ctx.getNodeParameter('code', i) } })),
  });
  const types: Record<string, ReturnType<typeof defineNode>> = { trigger, echo };
  const resolver: NodeTypeResolver = { resolve: (type) => (types[type.slice(2)] ? inProcessNodeType('t', types[type.slice(2)]) : { error: 'unknown' }) };
  const workflow = (parameters: Record<string, unknown>): Workflow => ({
    id: 'wf',
    name: 'Secrets',
    nodes: [
      { id: 'a', name: 'a', type: 't.trigger', typeVersion: 1, position: [0, 0], parameters: {} },
      { id: 'b', name: 'b', type: 't.echo', typeVersion: 1, position: [0, 100], parameters },
    ],
    connections: [{ id: 'ab', type: 'main', source: 'a', sourceIndex: 0, target: 'b', targetIndex: 0 }],
  });

  it('reads the referenced secrets right before the node runs and resolves them per item', async () => {
    const calls: Array<{ references: SecretReference[]; node: string }> = [];
    const derived: unknown[] = [];
    const result = await executeWorkflow({
      workflow: workflow({ value: 'Bearer {{ $secrets.vault.api.token }} for {{ $json.n }}', code: '{{ $secrets.vault.never }}' }),
      resolver,
      executionId: 'ex',
      mode: 'manual',
      triggerItems: [{ json: { n: 1 } }, { json: { n: 2 } }],
      loadSecrets: async (references, node) => {
        calls.push({ references, node: node.id });
        return { vault: { api: { token: 'tok-123456' } } };
      },
      onSecretParameter: (value) => derived.push(value),
    });
    expect(result.status).toBe('success');
    expect(result.runData.b[0].outputs[0].map((i) => i.json.value)).toEqual(['Bearer tok-123456 for 1', 'Bearer tok-123456 for 2']);
    // Code parameters aren't resolved, so they read nothing.
    expect(result.runData.b[0].outputs[0][0].json.code).toBe('{{ $secrets.vault.never }}');
    expect(calls).toEqual([{ references: [{ provider: 'vault', name: 'api', key: 'token' }], node: 'b' }]);
    // The resolved values that read a secret are reported (the node-level one, then per item) for redaction.
    expect(derived).toEqual(['Bearer tok-123456 for 1', 'Bearer tok-123456 for 1', 'Bearer tok-123456 for 2']);
  });

  it('fails the node with the loader’s message, and without a loader with the usual expression error', async () => {
    const refused = await executeWorkflow({
      workflow: workflow({ value: '{{ $secrets.vault.api.token }}' }),
      resolver,
      executionId: 'ex2',
      mode: 'manual',
      loadSecrets: async () => {
        throw new Error('not allowed in node parameters here');
      },
    });
    expect(refused.status).toBe('error');
    expect(refused.runData.b[0].error?.message).toBe('not allowed in node parameters here');
    const plain = await executeWorkflow({ workflow: workflow({ value: '{{ $secrets.vault.api.token }}' }), resolver, executionId: 'ex3', mode: 'manual' });
    expect(plain.runData.b[0].error?.message).toContain(SECRETS_NOT_ALLOWED);
    // Nodes without $secrets never call the loader.
    let called = false;
    const none = await executeWorkflow({ workflow: workflow({ value: '{{ $json.n }}' }), resolver, executionId: 'ex4', mode: 'manual', triggerItems: [{ json: { n: 5 } }], loadSecrets: async () => ((called = true), {}) });
    expect(none.runData.b[0].outputs[0][0].json.value).toBe(5);
    expect(called).toBe(false);
  });
});
