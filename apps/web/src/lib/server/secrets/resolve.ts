/**
 * `$secrets` in credential fields. A credential field whose value is an expression that mentions `$secrets`
 * (`{{ $secrets.vault.db.password }}`, `Bearer {{ $secrets.op['API'].credential }}`) is resolved right before the
 * credential is used: the referenced secrets are read (./service.ts, with its short cache), the expression is
 * evaluated by the engine's resolver with only `$secrets` available, and the result goes to the node. The saved
 * credential keeps the expression; the value is never written anywhere, and is remembered for redaction.
 *
 * Fields without `$secrets` are passed as they are (a password that contains `{{` stays literal), so credentials
 * that don't use external secrets behave exactly as before.
 */
import type { JsonObject } from '@landflow/protocol';
import { ExpressionError, ExpressionResolver, hasSecretReference, secretReferences, type SecretReference, type SecretValues } from '@landflow/engine';
import { rememberSecretValues } from './redact';
import { externalSecrets, SecretsError } from './service';

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
