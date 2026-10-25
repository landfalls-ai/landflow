/**
 * Process-wide singletons. Next.js compiles instrumentation and each route into
 * separate module graphs (and re-evaluates modules on HMR), so module-level
 * state would be duplicated. Pin long-lived services to globalThis instead.
 */
const store = globalThis as unknown as { __landflow?: Map<string, unknown> };

export function singleton<T>(key: string, create: () => T): T {
  store.__landflow ??= new Map();
  if (!store.__landflow.has(key)) store.__landflow.set(key, create());
  return store.__landflow.get(key) as T;
}
