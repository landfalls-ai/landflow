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
  return { type: 'object', properties, ...(required.length && { required }), additionalProperties: true };
}
