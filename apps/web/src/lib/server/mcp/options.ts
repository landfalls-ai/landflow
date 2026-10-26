/**
 * Looked-up option lists for MCP (docs/transports.md "From node to tool", "Dynamic options"): the `list_options` tool
 * resolves a dynamic parameter's values through the plugin's `LoadOptions` method with the caller's credential, and the
 * successful lookups are remembered here for a short while, per (plugin, node type, method, bound credentials, the
 * parameters sent). `tools/list` reads them back: when the caller's own credential has a remembered lookup for a
 * parameter that depends on nothing else, the tool's schema carries the values as an `enum`.
 *
 * Correct per caller because the key holds the credential the caller resolves (the grant's, else their newest visible
 * one), and only tools that bind a credential take part: a list without one (a plugin's public list, or Landflow's own
 * `workflows`) could differ per caller's projects, so it is never shown to somebody else. Lookups from `list_options`
 * always go to the plugin (a person asking wants it now) and refresh the entry; only `tools/list` reads the cache.
 */
import { createHash } from 'node:crypto';
import type { JsonObject, PropertyOption } from '@landflow/protocol';
import { singleton } from '../singleton';

const DEFAULT_TTL_SECONDS = 300;
const MAX_ENTRIES = 500;

/** LANDFLOW_MCP_OPTIONS_CACHE_SECONDS (default 300); 0 turns the cache, and with it the enums, off. */
export function optionsCacheTtlMs(): number {
  const value = process.env.LANDFLOW_MCP_OPTIONS_CACHE_SECONDS;
  const seconds = value === undefined || value === '' ? DEFAULT_TTL_SECONDS : Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
}

export interface LookupKey {
  pluginId: string;
  nodeType: string;
  method: string;
  /** Slot → credential id as bound for the call (never empty: lookups without a credential are not cached). */
  credentials: Record<string, string>;
  /** The parameters sent to the method (the fixed ones, the credential selector, the caller's arguments). */
  parameters: JsonObject;
}

interface Entry {
  options: PropertyOption[];
  expiresAt: number;
}

const cache = () => singleton('mcp-options-cache', () => new Map<string, Entry>());

const sortedJson = (value: unknown): string =>
  JSON.stringify(value, (_key, v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1))) : v));

const keyOf = (k: LookupKey) =>
  createHash('sha256')
    .update(sortedJson([k.pluginId, k.nodeType, k.method, k.credentials, k.parameters]))
    .digest('hex');

/** Remember a successful lookup. Returns whether it is news (a new entry, or a different list than before). */
export function rememberOptions(key: LookupKey, options: PropertyOption[], now = Date.now()): boolean {
  const ttl = optionsCacheTtlMs();
  if (!ttl || !Object.keys(key.credentials).length) return false;
  const entries = cache();
  const id = keyOf(key);
  const before = entries.get(id);
  const changed = !before || before.expiresAt <= now || sortedJson(before.options) !== sortedJson(options);
  entries.set(id, { options, expiresAt: now + ttl });
  if (entries.size > MAX_ENTRIES) {
    for (const [k, e] of entries) if (e.expiresAt <= now) entries.delete(k);
    while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value as string);
  }
  return changed;
}

/** A remembered, unexpired lookup. */
export function recalledOptions(key: LookupKey, now = Date.now()): PropertyOption[] | undefined {
  if (!Object.keys(key.credentials).length) return undefined;
  const entries = cache();
  const id = keyOf(key);
  const entry = entries.get(id);
  if (!entry) return undefined;
  if (entry.expiresAt <= now) {
    entries.delete(id);
    return undefined;
  }
  return entry.options;
}

/** Forget everything (tests). */
export function clearOptionsCache() {
  cache().clear();
}
