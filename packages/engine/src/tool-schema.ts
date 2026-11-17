/**
 * Tool argument schemas for nodes used as agent tools.
 *
 * Priority: the descriptor's own `toolInputSchema` → `$fromAI('key', 'description', 'type')`
 * placeholders the user put in parameters (n8n's convention) → a heuristic:
 * parameters that *name an input field* ("field", "textField"…) turn their
 * configured value into a required argument, other primitive parameters become
 * optional overrides.
 */
import type { JsonObject, NodeDescriptor } from '@landflow/protocol';

export interface FromAIPlaceholder {
  key: string;
  description?: string;
  type: 'string' | 'number' | 'boolean' | 'json';
}

const FROM_AI = /\$fromAI\(\s*(['"`])([\w-]+)\1(?:\s*,\s*(['"`])(.*?)\3)?(?:\s*,\s*(['"`])(string|number|boolean|json)\5)?/g;

export function collectFromAI(value: unknown, found = new Map<string, FromAIPlaceholder>()): FromAIPlaceholder[] {
  if (typeof value === 'string') {
    for (const match of value.matchAll(FROM_AI)) {
      if (!found.has(match[2])) {
        found.set(match[2], { key: match[2], ...(match[4] && { description: match[4] }), type: (match[6] as FromAIPlaceholder['type']) ?? 'string' });
      }
    }
  } else if (Array.isArray(value)) value.forEach((entry) => collectFromAI(entry, found));
  else if (value && typeof value === 'object') Object.values(value).forEach((entry) => collectFromAI(entry, found));
  return [...found.values()];
}

const isFieldParam = (name: string) => name === 'field' || (/Field$/.test(name) && !/^output/i.test(name));
const IDENTIFIER = /^[A-Za-z_][\w-]{0,63}$/;

/** What the model is told to write in the `reason` argument of a delegating tool. */
export const REASON_DESCRIPTION = 'Why you are asking and what done looks like, in one sentence';

/** The schema with a required `reason` argument (for nodes that hand work to another agent: `delegates`). A copy. */
export function withReason(schema: JsonObject): JsonObject {
  const properties = (schema.properties && typeof schema.properties === 'object' ? schema.properties : {}) as JsonObject;
  const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
  return {
    ...schema,
    type: 'object',
    properties: { ...properties, reason: { type: 'string', description: REASON_DESCRIPTION } },
    required: [...required.filter((name) => name !== 'reason'), 'reason'],
  };
}

export function deriveToolSchema(descriptor: NodeDescriptor, parameters: Record<string, unknown>): JsonObject {
  if (descriptor.toolInputSchema) return descriptor.toolInputSchema;

  const placeholders = collectFromAI(parameters);
  if (placeholders.length) {
    return {
      type: 'object',
      properties: Object.fromEntries(
        placeholders.map((p) => [p.key, { type: p.type === 'json' ? 'object' : p.type, ...(p.description && { description: p.description }) }]),
      ),
      required: placeholders.map((p) => p.key),
    };
  }

  const properties: JsonObject = {};
  const required: string[] = [];
  for (const property of descriptor.properties) {
    if (property.type !== 'string' || !isFieldParam(property.name)) continue;
    const field = String(parameters[property.name] ?? property.default ?? '');
    if (!IDENTIFIER.test(field) || field in properties) continue;
    properties[field] = { type: 'string', description: `Value of the "${field}" field this tool processes (${property.displayName})` };
    required.push(field);
  }
  for (const property of descriptor.properties) {
    if (!['string', 'number', 'boolean', 'options'].includes(property.type)) continue;
    if (isFieldParam(property.name) || /^output/i.test(property.name) || property.name in properties) continue;
    properties[property.name] = {
      type: property.type === 'options' ? 'string' : property.type,
      description: `Optional override of “${property.displayName}” (currently ${JSON.stringify(parameters[property.name] ?? property.default)})`,
      ...(property.type === 'options' && property.options && { enum: property.options.map((o) => String(o.value)) }),
    };
  }
  // AG03: a node that reads its whole input item needs the data to work on: an `item` argument carries it.
  const hasMain = descriptor.inputs.some((port) => port.type === 'main');
  if (hasMain && !descriptor.delegates && !required.length && !('item' in properties) && !descriptor.properties.some((p) => p.name === 'item')) {
    properties.item = { type: 'object', additionalProperties: true, description: TOOL_ITEM_DESCRIPTION };
    required.push('item');
  }
  return { type: 'object', properties, ...(required.length && { required }), additionalProperties: true };
}

// AG03: the `item` argument of a tool whose node reads its whole input item.
export const TOOL_ITEM_DESCRIPTION =
  'The data this tool works on, as JSON (for example the alert, email or record you were given). Put the whole thing here.';

/**
 * AG03: the node's one input item and the overrides, from the model's arguments. When the schema carries the generated
 * `item` argument, `json` is that item (an object; a string that parses as a JSON object; any other string becomes
 * `{ text }`, the key free text goes under) and `rest` is every other argument. Otherwise `{ json: given, rest: given }`.
 */
export function toolInputItem(schema: JsonObject, given: Record<string, unknown>): { json: JsonObject; rest: Record<string, unknown> } {
  const item = (schema.properties as Record<string, { description?: string }> | undefined)?.item;
  if (item?.description !== TOOL_ITEM_DESCRIPTION) return { json: given as JsonObject, rest: given };
  const { item: value, ...rest } = given;
  let json: JsonObject;
  if (value && typeof value === 'object' && !Array.isArray(value)) json = value as JsonObject;
  else if (typeof value === 'string') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      parsed = undefined;
    }
    json = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as JsonObject) : { text: value };
  } else json = rest as JsonObject;
  return { json, rest };
}
