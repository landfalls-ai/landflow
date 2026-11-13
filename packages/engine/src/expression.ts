/**
 * `{{ expression }}` resolution, n8n-style.
 *
 *   "Hello {{ $json.name }}"      → string interpolation
 *   "{{ $json.items.length }}"    → a single expression keeps its raw type (number here)
 *   "={{ ... }}"                  → n8n's leading "=" is accepted and stripped
 *
 * Expressions run in a sealed realm (./sandbox/realm.ts): a node:vm context with code generation off and no host
 * object reachable, a 250 ms timeout, and only text crossing the boundary. See docs/features/engine.md.
 */
import type { NodeItem } from '@landflow/protocol';
import type { SecretValues } from './secrets';
import { createExpressionRealm, type ExpressionRealm } from './sandbox/realm';

const EXPRESSION = /\{\{([\s\S]+?)\}\}/g;

export interface ExpressionData {
  /** Items of main input 0 of the node being resolved. */
  items: NodeItem[];
  /** Latest output 0 items per node name. */
  nodeOutputs: Record<string, NodeItem[]>;
  workflow: { id: string; name: string };
  /** `$execution`; `resumeUrl` / `resumeFormUrl` resume a webhook or form wait of this run. */
  execution: { id: string; mode: string; resumeUrl?: string; resumeFormUrl?: string };
  /** Raw (unresolved) parameters of the current node. */
  parameters: Record<string, unknown>;
  /** Arguments chosen by an AI agent when the node runs as a tool (read by $fromAI). */
  toolArgs?: Record<string, unknown>;
  /** Instance variables, read-only as `$vars.NAME` (an unknown name is undefined, as in n8n). */
  variables?: Record<string, string>;
  /** Fetched external secrets for `$secrets` (see ./secrets.ts); without them `$secrets` throws (only credential fields get them). */
  secrets?: SecretValues;
  /** `$composite`: the composite frame the node runs in (`params` is empty outside one). */
  composite?: { id: string; name: string; type: string; params: Record<string, unknown> };
}

export class ExpressionError extends Error {
  constructor(
    message: string,
    readonly expression: string,
  ) {
    super(message);
    this.name = 'ExpressionError';
  }
}

export function hasExpression(value: unknown): boolean {
  return typeof value === 'string' && value.includes('{{') && value.includes('}}');
}

/**
 * `$input` and `$('Node')`: n8n's accessors over a list of items, as expressions and the Code node see them.
 * `.item` follows the current item by position (the same index in the other node's output, the first item when it
 * has fewer); `itemMatching(i)` is the item of the other node that matches input item `i`, by the same rule.
 * `items` undefined is a node that has not run: `isExecuted` is false and reading anything else throws.
 */
export function nodeAccessor(name: string | undefined, items: NodeItem[] | undefined, currentIndex: () => number) {
  const list = () => {
    if (!items) throw new Error(`Node "${name}" has not run yet (or produced no output)`);
    return items;
  };
  return {
    all: () => list(),
    first: () => list()[0],
    last: () => list()[list().length - 1],
    itemMatching(index: number) {
      const matched = list()[index];
      if (!matched) throw new Error(`Node "${name}" has no item matching input item ${index}`);
      return matched;
    },
    get item() {
      return list()[currentIndex()] ?? list()[0];
    },
    get json() {
      return (list()[currentIndex()] ?? list()[0])?.json;
    },
    get binary() {
      return (list()[currentIndex()] ?? list()[0])?.binary;
    },
    isExecuted: items !== undefined,
  };
}

/** `$node['Name']` / `$node.Name`: the node's first item as `json` and `binary`, and all its `items`. */
export function legacyNodeData(items: NodeItem[] | undefined) {
  return items ? { json: items[0]?.json, binary: items[0]?.binary, items } : undefined;
}

export class ExpressionResolver {
  /** Made on the first evaluation: most resolvers never evaluate anything. */
  private realm?: ExpressionRealm;

  constructor(private readonly data: ExpressionData) {}

  evaluate(code: string, itemIndex: number): unknown {
    try {
      this.realm ??= createExpressionRealm(this.data);
      return this.realm.run(code.trim(), itemIndex);
    } catch (error) {
      const message = (error as Error).message;
      // The Code node's `items` isn't here: say what an expression has instead.
      const hint = /^items is not defined$/.test(message) ? ' (an expression sees the current item as $json; $input.all() gives every item)' : '';
      throw new ExpressionError(message + hint, code.trim());
    }
  }

  /** Resolve a single parameter value (recursively for arrays/objects). */
  resolveValue(value: unknown, itemIndex: number): unknown {
    if (typeof value === 'string') {
      if (!hasExpression(value)) return value;
      const source = value.startsWith('=') ? value.slice(1) : value;
      const segments = [...source.matchAll(EXPRESSION)];
      // Exactly one {{ }} spanning the whole string keeps the raw type.
      if (segments.length === 1 && segments[0][0] === source.trim()) return this.evaluate(segments[0][1], itemIndex);
      return source.replace(EXPRESSION, (_m, code: string) => {
        const result = this.evaluate(code, itemIndex);
        if (result === undefined || result === null) return '';
        return typeof result === 'object' ? JSON.stringify(result) : String(result);
      });
    }
    if (Array.isArray(value)) return value.map((entry) => this.resolveValue(entry, itemIndex));
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(value)) out[key] = this.resolveValue(entry, itemIndex);
      return out;
    }
    return value;
  }

  resolveParameters(
    parameters: Record<string, unknown>,
    itemIndex: number,
    skip: ReadonlySet<string> = new Set(),
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(parameters)) {
      if (skip.has(key)) {
        out[key] = value;
        continue;
      }
      try {
        out[key] = this.resolveValue(value, itemIndex);
      } catch (error) {
        if (error instanceof ExpressionError) {
          throw new ExpressionError(`Parameter "${key}": ${error.message}`, error.expression);
        }
        throw error;
      }
    }
    return out;
  }
}
