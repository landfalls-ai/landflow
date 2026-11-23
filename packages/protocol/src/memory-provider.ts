// The memory provider contract (docs/protocol.md#memory-providers, C07): an action node that flags `memoryProvider` and
// answers five operations through its `operation` option. The host's remote memory backend calls it like any node (one
// manual-mode input item) and reads the first output item. The check runs when a manifest is parsed, so a provider with a
// wrong shape fails registration with a message naming the node rather than failing on its first call.
import type { NodeDescriptor } from './types';

export const MEMORY_OPERATIONS = ['search', 'profile', 'add', 'forget', 'list'] as const;
export type MemoryOperation = (typeof MEMORY_OPERATIONS)[number];

/** One memory as a provider returns it. `score` is 0..1 (search only). */
export interface MemoryItemWire {
  id: string;
  text: string;
  kind?: string;
  score?: number;
  version?: number;
  static?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

/** The input item's `json` the host sends for each operation (`container` is `project:<id>`). */
export type MemoryRequestWire =
  | { operation: 'search'; container: string; query: string; mode: 'keyword' | 'meaning' | 'hybrid'; limit: number; threshold: number }
  | { operation: 'profile'; container: string }
  | { operation: 'add'; container: string; text: string; kind?: string; static?: boolean; forgetAfter?: string; replaces?: string; confidence?: number; evidence?: Array<{ label: string; value?: string | number; href?: string }> }
  | { operation: 'forget'; container: string; id: string; reason: string }
  | { operation: 'list'; container: string; cursor?: string; limit: number };

/** The keys the first output item's `json` must carry, per operation: `search` and `list` answer `{ items }`, `profile` `{ static, recent }`, `add` and `forget` `{ item }`. */
export const MEMORY_OUTPUT_REQUIRED: Record<MemoryOperation, readonly string[]> = {
  search: ['items'],
  profile: ['static', 'recent'],
  add: ['item'],
  forget: ['item'],
  list: ['items'],
};

/** undefined when `node` is a valid memory provider; otherwise a message naming the node and what is missing. */
export function checkMemoryProvider(node: Pick<NodeDescriptor, 'name' | 'kind' | 'properties'>): string | undefined {
  const head = `node “${node.name}”: a memory provider needs`;
  if (node.kind !== 'action') return `${head} to be an action node`;
  const operation = node.properties.find((p) => p.name === 'operation' && p.type === 'options');
  if (!operation) return `${head} an “operation” options property with the five operations (${MEMORY_OPERATIONS.join(', ')})`;
  const options = operation.options ?? [];
  const values = options.map((o) => o.value);
  const missing = MEMORY_OPERATIONS.filter((op) => !values.includes(op));
  if (missing.length) return `${head} the operation${missing.length > 1 ? 's' : ''} ${missing.join(', ')}`;
  const extra = values.filter((v) => !(MEMORY_OPERATIONS as readonly unknown[]).includes(v));
  if (extra.length) return `${head} exactly the five operations; “${String(extra[0])}” is not one`;
  for (const op of MEMORY_OPERATIONS) {
    const schema = options.find((o) => o.value === op)?.outputSchema;
    const required = Array.isArray(schema?.required) ? (schema.required as unknown[]) : [];
    const lacking = MEMORY_OUTPUT_REQUIRED[op].filter((key) => !required.includes(key));
    if (lacking.length) return `${head} an output schema for ${op} that requires ${lacking.map((k) => `“${k}”`).join(' and ')}`;
  }
  return undefined;
}
