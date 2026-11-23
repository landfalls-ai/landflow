/**
 * The AI Judge's decision schema (C13): `decision`, `reason`, `confidence` always, plus the builder's own fields (string,
 * number, boolean or enum only, at most 20). `checkDecision` validates the model's `submit_decision` input; anything that
 * does not pass counts as no decision, so the judge fails closed.
 */
import { NodeOperationError } from '@landflow/sdk';
import { JUDGE_LIMITS } from '../../shared/judge';
import { readSchema, validateSchema, type JsonSchema } from './structured';

const FIXED = ['decision', 'reason', 'confidence'];
const MAX_EXTRA = 20;
const SIMPLE = new Set(['string', 'number', 'integer', 'boolean']);

/** The schema `submit_decision` takes. `extra` is the builder's JSON Schema (`{ properties: {...} }`), if any. */
export function decisionSchema(extra?: unknown): JsonSchema {
  const properties: Record<string, JsonSchema> = {
    decision: { type: 'string', enum: ['approve', 'deny'], description: 'approve only when the policy clearly allows it' },
    reason: { type: 'string', minLength: 1, maxLength: JUDGE_LIMITS.reasonChars, description: 'Why, in one or two sentences' },
    confidence: { type: 'number', minimum: 0, maximum: 1, description: 'How sure you are, from 0 to 1' },
  };
  const required = [...FIXED];
  const given = extra === undefined || extra === null || extra === '' ? undefined : readSchema(extra, 'Decision Fields');
  const entries = Object.entries(given?.properties ?? {});
  if (entries.length > MAX_EXTRA) throw new NodeOperationError(`Decision Fields has ${entries.length} properties; at most ${MAX_EXTRA} are allowed`);
  for (const [name, property] of entries) {
    if (FIXED.includes(name)) throw new NodeOperationError(`Decision Fields cannot redefine “${name}”: the judge always has decision, reason and confidence`);
    const type = Array.isArray(property.type) ? undefined : property.type;
    if (!property.enum && !(type && SIMPLE.has(type))) throw new NodeOperationError(`Decision Fields “${name}” must be a string, number, boolean or enum`);
    properties[name] = property;
    if (given?.required?.includes(name)) required.push(name);
  }
  return { type: 'object', properties, required };
}

export type DecisionCheck = { ok: true; value: Record<string, unknown> } | { ok: false; errors: string[] };

/** The model's `submit_decision` input, validated against the schema. */
export function checkDecision(input: unknown, schema: JsonSchema): DecisionCheck {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, errors: ['$: expected an object'] };
  const errors = validateSchema(input, schema);
  return errors.length ? { ok: false, errors } : { ok: true, value: input as Record<string, unknown> };
}
