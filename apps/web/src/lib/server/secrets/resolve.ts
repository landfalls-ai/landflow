/**
 * `$secrets` in credential fields (and, when Settings → External secrets allows it, in node parameters: the end of
 * this file). A credential field whose value is an expression that mentions `$secrets`
 * (`{{ $secrets.vault.db.password }}`, `Bearer {{ $secrets.op['API'].credential }}`) is resolved right before the
 * credential is used: the referenced secrets are read (./service.ts, with its short cache), the expression is
 * evaluated by the engine's resolver with only `$secrets` available, and the result goes to the node. The saved
 * credential keeps the expression; the value is never written anywhere, and is remembered for redaction.
 *
 * Fields without `$secrets` are passed as they are (a password that contains `{{` stays literal), so credentials
 * that don't use external secrets behave exactly as before.
 */
import type { JsonObject } from '@landflow/protocol';
import { collectSecretReferences, ExpressionError, ExpressionResolver, formatSecretReference, hasSecretReference, secretParameterPaths, secretReferences, type SecretReference, type SecretValues } from '@landflow/engine';
import { rememberSecretValues } from './redact';
import { externalSecrets, SecretsError } from './service';
import { PARAMETERS_NOT_ALLOWED, secretsAllowedInParameters } from './settings';

/** Every string in `value` (deeply) that references `$secrets`, with its path. */
function referencing(value: unknown, path: string[] = [], out: Array<{ path: string[]; text: string }> = []) {
  if (hasSecretReference(value)) out.push({ path, text: value });
  else if (Array.isArray(value)) value.forEach((entry, i) => referencing(entry, [...path, String(i)], out));
  else if (value && typeof value === 'object') for (const [key, entry] of Object.entries(value)) referencing(entry, [...path, key], out);
  return out;
}

/** Whether any field of the data references `$secrets`. */
export const usesSecrets = (data: unknown): boolean => referencing(data).length > 0;

/** The secrets the data references. */
export function referencedSecrets(data: unknown): SecretReference[] {
  const all = referencing(data).flatMap(({ text }) => secretReferences(text));
  const seen = new Set<string>();
  return all.filter((r) => {
    const id = `${r.provider}\u0000${r.name}\u0000${r.key ?? ''}`;
    return seen.has(id) ? false : (seen.add(id), true);
  });
}

/** Read the referenced secrets (one read per secret, whatever keys are used) and remember the values used. */
export async function fetchSecrets(references: SecretReference[]): Promise<SecretValues> {
  const values: SecretValues = {};
  const unique = new Map<string, SecretReference>();
  for (const reference of references) unique.set(`${reference.provider}\u0000${reference.name}`, reference);
  await Promise.all(
    [...unique.values()].map(async ({ provider, name }) => {
      const value = await externalSecrets.read(provider, name);
      (values[provider] ??= {})[name] = value;
    }),
  );
  for (const reference of references) {
    const value = values[reference.provider]?.[reference.name];
    // A key the JSON secret doesn't have would read as undefined and send an empty value: name it instead.
    if (reference.key !== undefined && value && typeof value === 'object' && !Object.hasOwn(value, reference.key)) {
      throw new SecretsError(`External secret ${formatSecretReference({ provider: reference.provider, name: reference.name })} has no key “${reference.key}”`, 404);
    }
    // The key used, or the whole secret when the field takes it all.
    rememberSecretValues(reference.key !== undefined && value && typeof value === 'object' ? value[reference.key] : value);
  }
  return values;
}

const setAt = (target: Record<string, unknown> | unknown[], path: string[], value: unknown) => {
  let node = target as Record<string, unknown>;
  for (const key of path.slice(0, -1)) node = node[key] as Record<string, unknown>;
  node[path.at(-1)!] = value;
};

/**
 * The data with every `$secrets` field resolved, or the same object when no field uses them. Throws a SecretsError
 * that names the field and the reference when a secret can't be read or the expression fails.
 */
export async function resolveSecretsIn<T extends JsonObject>(data: T, label = 'Credential'): Promise<T> {
  const fields = referencing(data);
  if (!fields.length) return data;
  const values = await fetchSecrets(fields.flatMap(({ text }) => secretReferences(text)));
  const resolver = new ExpressionResolver({
    items: [],
    nodeOutputs: {},
    workflow: { id: '', name: '' },
    execution: { id: '', mode: 'manual' },
    parameters: {},
    secrets: values,
  });
  const out = structuredClone(data) as T;
  for (const { path, text } of fields) {
    try {
      const resolved = resolver.resolveValue(text, 0);
      setAt(out, path, resolved);
      // An interpolated field ("Bearer {{ … }}") goes out whole too.
      rememberSecretValues(resolved);
    } catch (error) {
      const field = path.join('.') || 'value';
      const message = error instanceof ExpressionError ? error.message : (error as Error).message;
      throw new SecretsError(`${label} field “${field}”: ${message}`);
    }
  }
  return out;
}

/** A node call's credentials (by requirement name) with secrets resolved; undefined when none used them. */
export async function resolveSecretsInRecord(record: Record<string, JsonObject> | undefined): Promise<Record<string, JsonObject> | undefined> {
  if (!record || !usesSecrets(record)) return undefined;
  const out: Record<string, JsonObject> = {};
  for (const [name, data] of Object.entries(record)) out[name] = await resolveSecretsIn(data);
  return out;
}

// ---------------------------------------------------------------------------
// Node parameters
// ---------------------------------------------------------------------------

/**
 * `$secrets` in node parameters (the engine's `loadSecrets`): the referenced secrets when Settings → External secrets
 * allows it (“Allow in node parameters”), else a SecretsError that says how to allow it. Values are cached and
 * remembered for redaction like credential fields' ones.
 */
export async function loadParameterSecrets(references: SecretReference[]): Promise<SecretValues> {
  if (!secretsAllowedInParameters()) throw new SecretsError(PARAMETERS_NOT_ALLOWED, 403);
  return fetchSecrets(references);
}

/** For resolvers outside the engine (polls, app webhook registration): `secrets` for these parameters, or undefined. */
export async function parameterSecrets(parameters: unknown, skip?: ReadonlySet<string>): Promise<SecretValues | undefined> {
  const references = collectSecretReferences(parameters, skip);
  return references.length ? loadParameterSecrets(references) : undefined;
}

/** Resolvers outside the engine: remember what the parameters that read a secret resolved to, so they are redacted too. */
export function rememberResolvedParameters(raw: unknown, resolved: unknown, skip?: ReadonlySet<string>): void {
  for (const path of secretParameterPaths(raw, skip)) {
    rememberSecretValues(
      path.reduce<unknown>((value, key) => (value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined), resolved),
      { lines: false },
    );
  }
}

// ---------------------------------------------------------------------------
// Settings Landflow itself uses (OAuth2 Connect, agents, alerts, source control)
// ---------------------------------------------------------------------------

/**
 * A settings object with `$secrets` resolved in the named string fields (all of them when `fields` is absent), for
 * what the host itself calls with a credential's values: the OAuth2 Connect flow's client fields, agents' models and
 * channels, alert channels, the source control token. Same cache and redaction as credential fields; the same object
 * when nothing references a secret.
 */
export async function resolveSecretFields<T extends object>(settings: T, label: string, fields?: readonly (keyof T & string)[]): Promise<T> {
  const picked = fields ? Object.fromEntries(fields.filter((f) => hasSecretReference(settings[f])).map((f) => [f, settings[f]])) : (settings as Record<string, unknown>);
  if (!usesSecrets(picked)) return settings;
  const resolved = await resolveSecretsIn(picked as JsonObject, label);
  return { ...settings, ...resolved };
}
