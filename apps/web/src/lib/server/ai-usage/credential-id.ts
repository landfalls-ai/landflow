/**
 * Which saved credential a resolved credential object came from, for the caps per model credential. The runner tags
 * the objects it hands to nodes (`ctx.getCredentials` returns the very object, nothing in-process copies it), and the
 * model adapters read the tag when they build a connection, so every model call knows its credential without the
 * credential's id travelling through the plugin protocol. Untagged (a host key from the environment, a local model): none.
 */
const ids = new WeakMap<object, string>();

/** Remember that `data` was resolved from credential `id`; returns `data`. */
export function tagCredential<T extends object>(data: T, id: string | undefined): T {
  if (id) ids.set(data, id);
  return data;
}

/** The credential `data` was resolved from, if it was tagged. */
export const credentialIdOf = (data: object | undefined): string | undefined => (data ? ids.get(data) : undefined);

/** Tag each credential a node resolved with the id of the saved credential its slot points at. */
export function tagNodeCredentials<T extends Record<string, object>>(node: { credentials?: Record<string, { id: string }> }, resolved: T): T {
  for (const [name, data] of Object.entries(resolved ?? {})) tagCredential(data, node.credentials?.[name]?.id);
  return resolved;
}
