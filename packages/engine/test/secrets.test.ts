import { describe, expect, it } from 'vitest';
import { ExpressionResolver, formatSecretReference, hasSecretReference, secretReferences, SECRETS_NOT_ALLOWED, type ExpressionData } from '../src';

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
