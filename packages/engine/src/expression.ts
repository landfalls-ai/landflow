/**
 * `{{ expression }}` resolution, n8n-style.
 *
 *   "Hello {{ $json.name }}"      → string interpolation
 *   "{{ $json.items.length }}"    → a single expression keeps its raw type (number here)
 *   "={{ ... }}"                  → n8n's leading "=" is accepted and stripped
 *
 * Expressions run in a node:vm context with a short timeout. That is isolation
 * from accidents, not a security boundary — run untrusted workflows in a
 * separate worker/sandbox (see docs/architecture.md).
 */
import vm from 'node:vm';
import type { NodeItem } from '@landflow/protocol';

const EXPRESSION = /\{\{([\s\S]+?)\}\}/g;
const scriptCache = new Map<string, vm.Script>();

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

function compile(code: string): vm.Script {
  let script = scriptCache.get(code);
  if (!script) {
    script = new vm.Script(`(${code})`);
    if (scriptCache.size > 2000) scriptCache.clear();
    scriptCache.set(code, script);
  }
  return script;
}

function accessor(items: NodeItem[], itemIndex: number) {
  return {
    all: () => items,
    first: () => items[0],
    last: () => items[items.length - 1],
    get item() {
      return items[itemIndex] ?? items[0];
    },
    get json() {
      return (items[itemIndex] ?? items[0])?.json;
    },
  };
}

export class ExpressionResolver {
  private readonly context: vm.Context;
  private readonly sandbox: Record<string, unknown>;

  constructor(private readonly data: ExpressionData) {
    const nodeProxy = new Proxy(
      {},
      {
        get: (_target, name: string) => {
          const items = data.nodeOutputs[name];
          return items ? { json: items[0]?.json, items } : undefined;
        },
      },
    );
    this.sandbox = {
      $node: nodeProxy,
      $workflow: data.workflow,
      $execution: data.execution,
      $parameter: data.parameters,
      $vars: Object.freeze({ ...data.variables }),
      $fromAI: (key: string, _description?: string, _type?: string, fallback?: unknown) => data.toolArgs?.[key] ?? fallback ?? '',
      $: (name: string) => {
        const items = data.nodeOutputs[name];
        if (!items) throw new Error(`Node "${name}" has not run yet (or produced no output)`);
        return accessor(items, this.sandbox.$itemIndex as number);
      },
    };
    this.context = vm.createContext(this.sandbox);
  }

  private bindItem(itemIndex: number) {
    const item = this.data.items[itemIndex];
    this.sandbox.$itemIndex = itemIndex;
    this.sandbox.$json = item?.json ?? {};
    this.sandbox.$input = accessor(this.data.items, itemIndex);
    this.sandbox.$now = new Date();
    this.sandbox.$today = new Date(new Date().toDateString());
  }

  evaluate(code: string, itemIndex: number): unknown {
    this.bindItem(itemIndex);
    try {
      return compile(code.trim()).runInContext(this.context, { timeout: 250 });
    } catch (error) {
      throw new ExpressionError((error as Error).message, code.trim());
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
