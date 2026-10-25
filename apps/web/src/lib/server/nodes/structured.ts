/**
 * Structured output for the AI root nodes (Basic LLM Chain, Text Classifier,
 * Information Extractor): a JSON Schema validator for the subset models are
 * asked to follow, a lenient reader for JSON inside model replies, and one
 * generate-validate-retry loop that works with any connected chat model.
 */
import { NodeOperationError } from '@landflow/sdk';
import type { AgentMessage, LanguageModel, ModelAttachment } from '@landflow/engine';
import type { GenerateInput } from './models';
import { stableStringify } from './paths';

export interface JsonSchema {
  type?: string | string[];
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  enum?: unknown[];
  const?: unknown;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  allOf?: JsonSchema[];
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: string;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
}

const typeOf = (value: unknown) => (value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value);

function hasType(value: unknown, type: string): boolean {
  switch (type) {
    case 'integer':
      return Number.isInteger(value);
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'object':
      return typeOf(value) === 'object';
    default:
      return typeOf(value) === type;
  }
}

/** Validation errors as "$.path: problem" lines (empty when valid). */
export function validateSchema(value: unknown, schema: JsonSchema, path = '$'): string[] {
  const errors: string[] = [];
  if (schema.allOf) for (const part of schema.allOf) errors.push(...validateSchema(value, part, path));
  const alternatives = schema.anyOf ?? schema.oneOf;
  if (alternatives && !alternatives.some((part) => validateSchema(value, part, path).length === 0)) errors.push(`${path}: matches none of the allowed shapes`);
  if (schema.const !== undefined && stableStringify(value) !== stableStringify(schema.const)) errors.push(`${path}: must be ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.some((option) => stableStringify(option) === stableStringify(value))) {
    errors.push(`${path}: must be one of ${schema.enum.map((option) => JSON.stringify(option)).join(', ')}`);
  }
  const types = schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types.length && !types.some((type) => hasType(value, type))) {
    errors.push(`${path}: expected ${types.join(' or ')}, got ${typeOf(value)}`);
    return errors;
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${path}: shorter than ${schema.minLength} characters`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${path}: longer than ${schema.maxLength} characters`);
    if (schema.pattern) {
      try {
        if (!new RegExp(schema.pattern).test(value)) errors.push(`${path}: does not match ${schema.pattern}`);
      } catch {
        // An invalid pattern in the schema is not the model's fault.
      }
    }
    if ((schema.format === 'date-time' || schema.format === 'date') && Number.isNaN(Date.parse(value))) errors.push(`${path}: not a valid ${schema.format}`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: less than ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: greater than ${schema.maximum}`);
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) errors.push(`${path}: must be greater than ${schema.exclusiveMinimum}`);
    if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) errors.push(`${path}: must be less than ${schema.exclusiveMaximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path}: fewer than ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path}: more than ${schema.maxItems} items`);
    if (schema.items) value.forEach((entry, index) => errors.push(...validateSchema(entry, schema.items!, `${path}[${index}]`)));
  }
  if (typeOf(value) === 'object') {
    const object = value as Record<string, unknown>;
    for (const key of schema.required ?? []) if (object[key] === undefined) errors.push(`${path}.${key}: is required`);
    for (const [key, entry] of Object.entries(object)) {
      const property = schema.properties?.[key];
      if (property) errors.push(...validateSchema(entry, property, `${path}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${path}.${key}: is not allowed`);
      else if (typeof schema.additionalProperties === 'object') errors.push(...validateSchema(entry, schema.additionalProperties, `${path}.${key}`));
    }
  }
  return errors;
}

/** The JSON value in a model reply: the whole text, a ```json fence, or the outermost {…} / […]. */
export function parseJsonReply(text: string): unknown {
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  const candidates = [cleaned];
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(cleaned);
  if (fence) candidates.push(fence[1].trim());
  for (const [open, close] of [
    ['{', '}'],
    ['[', ']'],
  ]) {
    const start = cleaned.indexOf(open);
    const end = cleaned.lastIndexOf(close);
    if (start >= 0 && end > start) candidates.push(cleaned.slice(start, end + 1));
  }
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next reading.
    }
  }
  throw new Error(cleaned ? 'the reply is not valid JSON' : 'the reply is empty');
}

/** Parse a JSON Schema parameter (a JSON string or an object). */
export function readSchema(raw: unknown, label = 'JSON Schema'): JsonSchema {
  let schema = raw;
  if (typeof raw === 'string') {
    try {
      schema = JSON.parse(raw);
    } catch (error) {
      throw new NodeOperationError(`${label} is not valid JSON`, { description: (error as Error).message });
    }
  }
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) throw new NodeOperationError(`${label} must be a JSON object`);
  return schema as JsonSchema;
}

export const formatInstructions = (schema: JsonSchema) =>
  `Answer with a single JSON value that matches this JSON Schema, and nothing else: no explanation, no code fences.\n\n${JSON.stringify(schema, null, 2)}`;

export interface StructuredResult<T> {
  value: T;
  text: string;
  attempts: number;
}

/**
 * Ask for JSON, validate it, and retry once with the validation errors. `check`
 * adds rules the schema can't express; `soft` rules trigger the retry but are
 * accepted on the last attempt (the caller then repairs the value).
 */
export async function generateStructured<T = unknown>(
  model: LanguageModel,
  input: {
    system: string;
    prompt: string;
    schema: JsonSchema;
    check?: (value: unknown) => string[];
    soft?: (value: unknown) => string[];
    signal?: AbortSignal;
    /** Images / PDFs sent with the prompt ("Include Binary as Input"). */
    attachments?: ModelAttachment[];
  },
): Promise<StructuredResult<T>> {
  // JSON mode (OpenAI json_object, Ollama format) only produces objects.
  const responseFormat = input.schema.type === 'object' ? ('json' as const) : undefined;
  let messages: AgentMessage[] = [{ role: 'user', content: input.prompt, ...(input.attachments?.length && { attachments: input.attachments }) }];
  for (let attempt = 1; ; attempt++) {
    const request: GenerateInput = {
      system: input.system,
      messages,
      tools: [],
      ...(responseFormat && { responseFormat }),
      ...(input.signal && { signal: input.signal }),
    };
    const turn = await model.generate(request);
    if (turn.stopReason === 'refusal') throw new NodeOperationError('The model declined the request', { description: turn.text });
    let value: unknown;
    let errors: string[];
    let softErrors: string[] = [];
    try {
      value = parseJsonReply(turn.text);
      errors = [...validateSchema(value, input.schema), ...(input.check?.(value) ?? [])];
      if (!errors.length) softErrors = input.soft?.(value) ?? [];
    } catch (error) {
      errors = [(error as Error).message];
    }
    if (!errors.length && (!softErrors.length || attempt >= 2)) return { value: value as T, text: turn.text, attempts: attempt };
    if (attempt >= 2) {
      throw new NodeOperationError('The model’s reply did not match the required format', {
        description: `${errors.slice(0, 5).join('; ')}. Reply: ${turn.text.slice(0, 300) || '(empty)'}`,
      });
    }
    const correction = `Your reply was not valid: ${[...errors, ...softErrors].slice(0, 10).join('; ')}. Reply again with only the corrected JSON.`;
    messages = turn.text.trim()
      ? [...messages, { role: 'assistant', text: turn.text, toolCalls: [] }, { role: 'user', content: correction }]
      : [{ role: 'user', content: `${input.prompt}\n\n${correction}` }];
  }
}
