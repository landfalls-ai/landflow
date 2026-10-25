/**
 * External secrets in expressions: `{{ $secrets.<provider>.<name>[.<key>] }}`, n8n's syntax. A name that isn't a
 * JavaScript identifier (a Vault path, an AWS name with `/`) uses brackets: `{{ $secrets.vault['app/db'].password }}`.
 *
 * Expressions evaluate synchronously, and secret providers answer over the network, so the host reads the
 * references first (`secretReferences`), fetches those secrets, and hands the values to the resolver as
 * `ExpressionData.secrets`. `$secrets` then reads only what was fetched: a name built at run time
 * (`$secrets.vault[$json.name]`) is "not loaded". Without `secrets`, `$secrets` is unavailable: the host passes them
 * only where secrets are allowed (credential fields).
 */

/** A secret's value as a provider returns it: text, or an object of keys (a KV entry, a JSON secret, an item's fields). */
export type SecretValue = string | Record<string, unknown>;

/** Fetched secrets by provider name, then secret name. */
export type SecretValues = Record<string, Record<string, SecretValue>>;

export interface SecretReference {
  provider: string;
  name: string;
  /** The key read from the secret (`.password`), when the expression names one right after the secret. */
  key?: string;
}

const EXPRESSION = /\{\{([\s\S]+?)\}\}/g;
/** `$secrets` followed by `.ident` or `['text']` steps. */
const CHAIN = /\$secrets((?:\s*\.\s*[A-Za-z_$][\w$]*|\s*\[\s*(?:'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")\s*\])+)/g;
const STEP = /\s*\.\s*([A-Za-z_$][\w$]*)|\s*\[\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")\s*\]/g;

const unescape = (text: string) => text.replace(/\\(.)/g, '$1');

/** Whether a value is a string with an expression that mentions `$secrets`. */
export function hasSecretReference(value: unknown): value is string {
  return typeof value === 'string' && value.includes('$secrets') && /\{\{[\s\S]*?\$secrets[\s\S]*?\}\}/.test(value);
}

/** The secrets an expression (or a text with `{{ }}` parts) reads literally, in order, without duplicates. */
export function secretReferences(value: string): SecretReference[] {
  const found = new Map<string, SecretReference>();
  const scan = (code: string) => {
    for (const chain of code.matchAll(CHAIN)) {
      const parts = [...chain[1].matchAll(STEP)].map((step) => step[1] ?? unescape(step[2] ?? step[3] ?? ''));
      if (parts.length < 2 || !parts[0] || !parts[1]) continue;
      const reference: SecretReference = { provider: parts[0], name: parts[1], ...(parts[2] !== undefined && { key: parts[2] }) };
      const id = `${reference.provider}\u0000${reference.name}\u0000${reference.key ?? ''}`;
      if (!found.has(id)) found.set(id, reference);
    }
  };
  if (value.includes('{{')) for (const segment of value.matchAll(EXPRESSION)) scan(segment[1]);
  else scan(value);
  return [...found.values()];
}

/** The text of a reference as an expression would write it. */
export function formatSecretReference(reference: SecretReference): string {
  const step = (part: string) => (/^[A-Za-z_$][\w$]*$/.test(part) ? `.${part}` : `['${part.replace(/['\\]/g, '\\$&')}']`);
  return `$secrets${step(reference.provider)}${step(reference.name)}${reference.key !== undefined ? step(reference.key) : ''}`;
}

const fail = (): never => {
  throw new Error('$secrets is read-only');
};

/** Error text when an expression reads `$secrets` where it isn't available. */
export const SECRETS_NOT_ALLOWED = '$secrets (external secrets) can only be used in credential fields';

/**
 * What `$secrets` is inside an expression: the fetched values, read-only. Unknown providers and names throw with a
 * hint instead of reading as undefined, so a typo can't send an empty password.
 */
export function secretsSandbox(values: SecretValues | undefined): object {
  const readOnly = { set: () => fail(), defineProperty: () => fail(), deleteProperty: () => fail() };
  const refuse = (message: string) =>
    new Proxy(Object.freeze({}), {
      ...readOnly,
      get: (_target, key) => {
        if (typeof key === 'symbol' || key === 'then' || key === 'toJSON') return undefined;
        throw new Error(message);
      },
    });
  if (!values) return refuse(SECRETS_NOT_ALLOWED);
  return new Proxy(Object.freeze({}), {
    ...readOnly,
    get: (_target, provider) => {
      if (typeof provider === 'symbol' || provider === 'then' || provider === 'toJSON') return undefined;
      const secrets = values[provider];
      if (!secrets) throw new Error(`No secret of external secrets provider "${provider}" was loaded: reference secrets literally, as $secrets.${provider}.<name>`);
      return new Proxy(Object.freeze({}), {
        ...readOnly,
        get: (_inner, name) => {
          if (typeof name === 'symbol' || name === 'then' || name === 'toJSON') return undefined;
          if (!Object.hasOwn(secrets, name)) throw new Error(`External secret ${formatSecretReference({ provider, name })} was not loaded: reference it literally (not built at run time)`);
          const value = secrets[name];
          return typeof value === 'object' && value !== null ? Object.freeze({ ...value }) : value;
        },
      });
    },
  });
}
