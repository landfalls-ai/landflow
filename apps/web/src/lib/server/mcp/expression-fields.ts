/**
 * Field checks for expressions: does `{{ $json.x }}` or `$('Node').item.json.x` name a field the node it reads from
 * really writes? What a node writes is known from its `outputSchema` (the selected operation's, else the node's), else
 * from the data of the last run that reached it. Only a node whose fields are known is checked: a node with neither
 * a schema nor a run is never flagged, so no false alarm for it. Code properties (the Code node's JavaScript) are
 * scanned whole; every other string parameter only inside its `{{ }}`.
 */
import type { NodeDescriptor } from '@landflow/protocol';

export interface CheckNode {
  id: string;
  name: string;
  type: string;
  parameters: Record<string, unknown>;
  disabled?: boolean;
}
export interface CheckWorkflow {
  nodes: CheckNode[];
  connections: Array<{ source: string; target: string; type: string }>;
}
export interface KnownFields {
  fields: string[];
  from: 'outputSchema' | 'last run';
}
export interface FieldIssue {
  node: string;
  nodeId: string;
  /** The text that reads the field, e.g. `$json.browserSnapshot`. */
  reference: string;
  field: string;
  /** The node it reads from. */
  upstream: string[];
  known: string[];
  from: KnownFields['from'];
  suggestion?: string;
}

/** The top-level fields one output item of a node writes, from a JSON Schema; undefined when it doesn't say. */
export function schemaFields(schema: unknown): string[] | undefined {
  if (!schema || typeof schema !== 'object') return undefined;
  const s = schema as { type?: unknown; properties?: unknown; additionalProperties?: unknown };
  if (s.type !== undefined && s.type !== 'object') return undefined;
  if (!s.properties || typeof s.properties !== 'object') return undefined;
  if (s.additionalProperties === true) return undefined;
  const names = Object.keys(s.properties);
  return names.length ? names : undefined;
}

/** The schema of what a node writes: the selected `operation` option's, else the node's own. */
export function outputSchemaOf(descriptor: NodeDescriptor, parameters: Record<string, unknown>): unknown {
  const operation = descriptor.properties.find((p) => p.name === 'operation');
  const chosen = parameters.operation ?? operation?.default;
  const option = operation?.options?.find((o) => (o as { value?: unknown }).value === chosen) as { outputSchema?: unknown } | undefined;
  return option?.outputSchema ?? descriptor.outputSchema;
}

/** The top-level keys of the items a node wrote (the first 25 items). */
export function fieldsOfItems(items: Array<{ json: Record<string, unknown> }> | undefined): string[] | undefined {
  if (!items?.length) return undefined;
  const names = new Set<string>();
  for (const item of items.slice(0, 25)) for (const key of Object.keys(item.json ?? {})) names.add(key);
  return names.size ? [...names] : undefined;
}

const IDENT = String.raw`(?:\.\s*([A-Za-z_$][\w$]*)|\[\s*(['"])([^'"\]]+)\2\s*\])`;
const ITEM = String.raw`(?:item|first\(\)|last\(\)|all\(\)\s*\[\s*\d+\s*\]|itemMatching\(\s*\d*\s*\))`;
const PATTERNS: Array<{ re: RegExp; node?: number; field: [number, number] }> = [
  // $json.x
  { re: new RegExp(String.raw`(?<![\w$.])\$json\s*${IDENT}`, 'g'), field: [1, 3] },
  // $input.item.json.x, $input.first().json.x
  { re: new RegExp(String.raw`(?<![\w$.])\$input\s*\.\s*${ITEM}\s*\.\s*json\s*${IDENT}`, 'g'), field: [1, 3] },
  // $('Node').item.json.x
  { re: new RegExp(String.raw`(?<![\w$.])\$\(\s*(['"])([^'"]+)\1\s*\)\s*\.\s*${ITEM}\s*\.\s*json\s*${IDENT}`, 'g'), node: 2, field: [3, 5] },
  // $node["Node"].json.x
  { re: new RegExp(String.raw`(?<![\w$.])\$node\s*\[\s*(['"])([^'"]+)\1\s*\]\s*\.\s*json\s*${IDENT}`, 'g'), node: 2, field: [3, 5] },
];

export interface Reference {
  text: string;
  /** Node named in the expression; absent for `$json` and `$input` (the node's own input). */
  node?: string;
  field: string;
}

/** Every `$json.x`-style read of a field in a piece of text (an expression body or code). */
export function referencesIn(text: string): Reference[] {
  const found: Reference[] = [];
  for (const { re, node, field } of PATTERNS) {
    for (const match of text.matchAll(re)) {
      const name = match[field[0]] ?? match[field[1]];
      if (!name || name in Object.prototype) continue;
      found.push({ text: match[0].replace(/\s+/g, ''), field: name, ...(node && { node: match[node] }) });
    }
  }
  return found;
}

const stripComments = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|\s)\/\/.*$/gm, '$1');

/** The texts of a node's parameters to scan: whole code properties, and the `{{ }}` bodies of other strings. */
export function expressionTexts(descriptor: NodeDescriptor | undefined, parameters: Record<string, unknown>): string[] {
  const codeNames = new Set((descriptor?.properties ?? []).filter((p) => p.type === 'code' && (p.typeOptions as { language?: string } | undefined)?.language !== 'python').map((p) => p.name));
  const texts: string[] = [];
  const walk = (value: unknown, key: string | undefined, depth: number) => {
    if (depth > 8) return;
    if (typeof value === 'string') {
      if (key && codeNames.has(key)) texts.push(stripComments(value));
      else for (const match of value.matchAll(/\{\{([\s\S]+?)\}\}/g)) texts.push(match[1]);
    } else if (Array.isArray(value)) for (const entry of value) walk(entry, key, depth + 1);
    else if (value && typeof value === 'object') for (const [k, entry] of Object.entries(value)) walk(entry, depth === 0 ? k : key, depth + 1);
  };
  walk(parameters, undefined, 0);
  return texts;
}

const distance = (a: string, b: string) => {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const next = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = row[j];
      row[j] = next;
    }
  }
  return row[b.length];
};

/** The known field most like `field` ("browserSnapshot" → "snapshot"), if any is close or contains it. */
export function closest(field: string, known: string[]): string | undefined {
  const lower = field.toLowerCase();
  const contained = known.find((k) => k.length >= 3 && (lower.includes(k.toLowerCase()) || k.toLowerCase().includes(lower)));
  if (contained) return contained;
  return known.map((k) => ({ k, d: distance(lower, k.toLowerCase()) })).filter((e) => e.d <= Math.max(2, Math.floor(field.length / 3))).sort((a, b) => a.d - b.d)[0]?.k;
}

/**
 * Expressions that read a field the node before them doesn't write. `fieldsOf(node)` gives what a node writes when it
 * is known (see KnownFields); `descriptorOf` finds a node's type.
 */
export function checkExpressionFields(
  workflow: CheckWorkflow,
  descriptorOf: (node: CheckNode) => NodeDescriptor | undefined,
  fieldsOf: (node: CheckNode) => KnownFields | undefined,
): FieldIssue[] {
  const issues: FieldIssue[] = [];
  const byName = new Map(workflow.nodes.map((n) => [n.name, n]));
  const byId = new Map(workflow.nodes.map((n) => [n.id, n]));
  const cache = new Map<string, KnownFields | undefined>();
  const known = (node: CheckNode) => {
    if (!cache.has(node.id)) cache.set(node.id, fieldsOf(node));
    return cache.get(node.id);
  };
  for (const node of workflow.nodes) {
    if (node.disabled) continue;
    const references = expressionTexts(descriptorOf(node), node.parameters).flatMap(referencesIn);
    if (!references.length) continue;
    const before = workflow.connections.filter((c) => c.type === 'main' && c.target === node.id).map((c) => byId.get(c.source)).filter((n): n is CheckNode => Boolean(n));
    const seen = new Set<string>();
    for (const reference of references) {
      const sources = reference.node ? [byName.get(reference.node)].filter((n): n is CheckNode => Boolean(n)) : before;
      if (!sources.length) continue;
      const infos = sources.map(known);
      // Every node it could read from must have known fields, or it may be the one that writes it.
      if (infos.some((i) => !i)) continue;
      const fields = [...new Set(infos.flatMap((i) => i!.fields))];
      if (fields.includes(reference.field)) continue;
      const key = `${reference.text}|${sources.map((s) => s.id).join(',')}`;
      if (seen.has(key)) continue;
      seen.add(key);
      issues.push({
        node: node.name,
        nodeId: node.id,
        reference: reference.text,
        field: reference.field,
        upstream: sources.map((s) => s.name),
        known: fields,
        from: infos[0]!.from,
        suggestion: closest(reference.field, fields),
      });
    }
  }
  return issues;
}

/** One issue as a sentence for validate_workflow's warnings and explain_failure. */
export function describeIssue(issue: FieldIssue): string {
  const source = issue.upstream.length === 1 ? `"${issue.upstream[0]}"` : issue.upstream.map((n) => `"${n}"`).join(' / ');
  const basis = issue.from === 'outputSchema' ? 'its outputSchema' : 'its last run';
  const hint = issue.suggestion ? ` Did you mean "${issue.suggestion}"?` : '';
  return `Node "${issue.node}": ${issue.reference} reads the field "${issue.field}", but ${source} writes ${issue.known.map((f) => `"${f}"`).join(', ')} (from ${basis}).${hint}`;
}
