/**
 * The line under a node's name that says what it will do ("Create an issue", "Issue · Get many"), and the actions a node
 * offers. Shared by the canvas tile, the node panel's header and the node creator. No runtime imports beyond the protocol.
 *
 * 1. The descriptor's own `subtitle` first (docs/protocol.md): `{{operation}}`, n8n's `{{ $parameter.operation }}` and
 *    `{{ $parameter["operation"] }}` are read with the option's display name, not its raw value. A template that holds
 *    anything else (a real expression) is not evaluated here and falls through to the next rule, and so does one that
 *    only says `{{operation}}: {{resource}}`, which rule 2 puts better.
 * 2. Else the node's `operation` option: its `action` label when it has one ("Create an issue"), else the resource and
 *    operation display names ("Issue · Get many").
 * 3. Else nothing: the caller shows the node's type name.
 */
import { isPropertyVisible, withPropertyDefaults } from '@landflow/protocol';
import type { NodeDescriptor, PropertyDescriptor } from './types';

type Described = Pick<NodeDescriptor, 'properties' | 'subtitle'>;
type Parameters = Record<string, unknown>;

/** The shown option of an `options` property for a value: the visible variant first (`operation` is declared once per resource). */
function optionFor(properties: PropertyDescriptor[], parameters: Parameters, name: string) {
  const value = parameters[name];
  if (value === undefined || value === null || value === '') return undefined;
  const candidates = properties.filter((p) => p.name === name && p.options?.length);
  const shown = candidates.filter((p) => isPropertyVisible(p, parameters));
  for (const property of [...shown, ...candidates]) {
    const option = property.options?.find((o) => o.value === value);
    if (option) return option;
  }
  return undefined;
}

/** One value as the subtitle shows it: an option's display name, an expression or object as an ellipsis. */
function shown(properties: PropertyDescriptor[], parameters: Parameters, name: string): string {
  const value = parameters[name];
  if (value === undefined || value === null) return '';
  if (Array.isArray(value)) return value.map((v) => optionFor(properties, { ...parameters, [name]: v }, name)?.name ?? String(v)).join(', ');
  if (typeof value === 'object') return '…';
  return optionFor(properties, parameters, name)?.name ?? String(value);
}

const PLACEHOLDER = /\{\{\s*([^{}]*?)\s*\}\}/g;
const REFERENCES = [/^(\w+)$/, /^\$parameter\.(\w+)$/, /^\$parameter\[\s*["'](\w+)["']\s*\]$/];

/** Fills a template; undefined when it holds something other than a parameter. */
function fill(template: string, properties: PropertyDescriptor[], parameters: Parameters): string | undefined {
  let unsupported = false;
  const text = template.replace(/^=/, '').replace(PLACEHOLDER, (_m, inner: string) => {
    const name = REFERENCES.map((re) => re.exec(inner)?.[1]).find(Boolean);
    if (!name) {
      unsupported = true;
      return '';
    }
    return shown(properties, parameters, name);
  });
  if (unsupported) return undefined;
  // An empty value leaves its separator behind ("insert · "): drop separators at either end.
  return text.replace(/^[\s·|:→]+|[\s·|:→]+$/g, '') || undefined;
}

/** `{{operation}}: {{resource}}` and its kin: what rule 2 says better, in words ("Create an issue") instead of "Create: Issue". */
function onlyResourceAndOperation(template: string): boolean {
  const names = [...template.matchAll(PLACEHOLDER)].map((m) => REFERENCES.map((re) => re.exec(m[1])?.[1]).find(Boolean));
  const rest = template.replace(PLACEHOLDER, '').replace(/[\s·|:→,-]/g, '');
  return names.length > 0 && !rest && names.every((n) => n === 'resource' || n === 'operation');
}

export function nodeSubtitle(descriptor: Described | undefined, parameters: Parameters = {}): string | undefined {
  if (!descriptor) return undefined;
  const values = withPropertyDefaults(descriptor.properties, parameters);
  if (descriptor.subtitle && !onlyResourceAndOperation(descriptor.subtitle)) {
    const text = fill(descriptor.subtitle, descriptor.properties, values);
    if (text) return text;
  }
  const operation = optionFor(descriptor.properties, values, 'operation');
  if (!operation) return undefined;
  if (operation.action) return operation.action;
  const resource = optionFor(descriptor.properties, values, 'resource');
  return resource ? `${resource.name} · ${operation.name}` : operation.name;
}

/** One thing a node can do: a value of its `operation` (and the `resource` it belongs to), as the node creator lists it. */
export interface NodeAction {
  label: string;
  /** What to set on the node: `{ resource, operation }` or `{ operation }`. */
  parameters: Parameters;
}

/**
 * The operations of a node, one per resource and operation, in the order the node declares them. Empty unless it has an
 * `operation` option; a node with a single operation and no resource has nothing to choose, so it lists none either.
 */
export function nodeActions(descriptor: Pick<NodeDescriptor, 'properties'>): NodeAction[] {
  const operations = descriptor.properties.filter((p) => p.name === 'operation' && p.options?.length);
  const resource = descriptor.properties.find((p) => p.name === 'resource' && p.options?.length);
  const out: NodeAction[] = [];
  for (const property of operations) {
    const resources = property.displayOptions?.show?.resource;
    const owners = resource && resources ? resource.options!.filter((o) => resources.includes(o.value)) : [undefined];
    for (const owner of owners) {
      for (const option of property.options!) {
        const parameters: Parameters = { ...(owner && { resource: owner.value }), operation: option.value };
        const label = option.action ?? (owner ? `${owner.name} · ${option.name}` : option.name);
        // Several variants may share an operation value for different resources: the pair is what is unique.
        if (!out.some((a) => a.parameters.resource === parameters.resource && a.parameters.operation === parameters.operation)) out.push({ label, parameters });
      }
    }
  }
  return out.length > 1 || (out.length === 1 && resource) ? out : [];
}
