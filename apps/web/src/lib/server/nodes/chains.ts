/**
 * AI root nodes that make one model call per item: Basic LLM Chain, Text
 * Classifier and Information Extractor (n8n's `chainLlm`, `textClassifier`,
 * `informationExtractor`). Each takes any chat model sub-node on its
 * `ai_languageModel` port (Anthropic, Ollama, OpenAI…) through the provider-neutral
 * LanguageModel interface, and asks for strict JSON where it needs structure.
 * “Enable Fallback Model” adds a second model that takes over when a call to
 * the first one fails (see fallback.ts).
 */
import { defineNode, NodeOperationError, type IExecuteContext, type JsonObject, type NodeItem } from '@landflow/sdk';
import { connectedModel, FALLBACK_PORT, FALLBACK_PROPERTY } from './fallback';
import type { GenerateInput } from './models';
import { formatInstructions, generateStructured, readSchema, type JsonSchema } from './structured';

const main = [{ type: 'main' as const }];
const modelInput = { type: 'ai_languageModel' as const, displayName: 'Chat Model', required: true, maxConnections: 1 };
const AI = { version: 1, kind: 'action' as const, categories: ['AI'], color: '#a855f7' };

/** Run `work` per item; a NodeOperationError without an item index gets this item's. */
async function perItem<T>(ctx: IExecuteContext, work: (item: NodeItem, i: number) => Promise<T>): Promise<T[]> {
  const results: T[] = [];
  for (const [i, item] of ctx.getInputData().entries()) {
    try {
      results.push(await work(item, i));
    } catch (error) {
      if (error instanceof NodeOperationError && error.itemIndex === undefined) {
        throw new NodeOperationError(error.message, { itemIndex: i, ...(error.description && { description: error.description }) });
      }
      throw error;
    }
  }
  return results;
}

const requireText = (value: unknown, label: string) => {
  const text = typeof value === 'string' ? value.trim() : value === undefined || value === null ? '' : JSON.stringify(value);
  if (!text) throw new NodeOperationError(`${label} is empty`, { description: `Set “${label}”, e.g. to {{ $json.text }}.` });
  return text;
};

const asItemJson = (value: unknown): JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as JsonObject) : { output: value as never };

// ---------------------------------------------------------------------------
// Basic LLM Chain
// ---------------------------------------------------------------------------

export const chainLlmNode = defineNode({
  description: {
    ...AI,
    name: 'chainLlm',
    displayName: 'Basic LLM Chain',
    description: 'Send a prompt to a chat model and return its answer, optionally as validated JSON',
    icon: 'lucide:link',
    keywords: ['llm', 'prompt', 'chain', 'completion', 'chat', 'json', 'structured output'],
    inputs: [{ type: 'main' }, modelInput, FALLBACK_PORT],
    outputs: main,
    properties: [
      { name: 'prompt', displayName: 'Prompt (User Message)', type: 'string', default: '{{ $json.chatInput }}', required: true, typeOptions: { rows: 4 } },
      {
        name: 'systemMessage',
        displayName: 'System Message',
        type: 'string',
        default: '',
        typeOptions: { rows: 3 },
        placeholder: 'You are a concise assistant…',
      },
      {
        name: 'hasOutputParser',
        displayName: 'Require Specific Output Format',
        type: 'boolean',
        default: false,
        description: 'Ask for JSON that matches a schema; the reply is validated and retried once',
      },
      {
        name: 'jsonSchema',
        displayName: 'JSON Schema',
        type: 'json',
        noDataExpression: true,
        default:
          '{\n  "type": "object",\n  "properties": {\n    "answer": { "type": "string" },\n    "confidence": { "type": "number", "minimum": 0, "maximum": 1 }\n  },\n  "required": ["answer"]\n}',
        displayOptions: { show: { hasOutputParser: [true] } },
      },
      FALLBACK_PROPERTY,
    ],
  },
  async execute(ctx) {
    const model = await connectedModel(ctx, 'Basic LLM Chain');
    const out = await perItem(ctx, async (_item, i): Promise<NodeItem> => {
      const prompt = requireText(ctx.getNodeParameter('prompt', i), 'Prompt');
      const system = String(ctx.getNodeParameter('systemMessage', i) ?? '').trim();
      if (ctx.getNodeParameter<boolean>('hasOutputParser', i)) {
        const schema = readSchema(ctx.getNodeParameter('jsonSchema', i));
        const { value, attempts } = await generateStructured(model, {
          system: [system, formatInstructions(schema)].filter(Boolean).join('\n\n'),
          prompt,
          schema,
        });
        if (attempts > 1) ctx.logger.info(`item ${i}: valid JSON after a retry`);
        return { json: asItemJson(value), pairedItem: { item: i } };
      }
      const request: GenerateInput = { ...(system && { system }), messages: [{ role: 'user', content: prompt }], tools: [] };
      const turn = await model.generate(request);
      return { json: { text: turn.text }, pairedItem: { item: i } };
    });
    return [out];
  },
});

// ---------------------------------------------------------------------------
// Text Classifier
// ---------------------------------------------------------------------------

/**
 * Category outputs of the Text Classifier: fixed, like the Switch's, because
 * descriptor outputs are static. Category 1 → output "0" … plus "Other".
 */
export const CLASSIFIER_OUTPUTS = 4;

interface Category {
  category?: string;
  description?: string;
}

const DEFAULT_CLASSIFIER_PROMPT =
  'Please classify the text provided by the user into one of the following categories: {categories}, and use the provided formatting instructions below. Don’t explain, and only output the JSON.';

export const textClassifierNode = defineNode({
  description: {
    ...AI,
    name: 'textClassifier',
    displayName: 'Text Classifier',
    description: 'Route items by the category a chat model assigns to their text',
    icon: 'lucide:tags',
    keywords: ['classify', 'categorize', 'label', 'route', 'sentiment', 'intent', 'llm'],
    inputs: [{ type: 'main' }, modelInput, FALLBACK_PORT],
    outputs: [
      ...Array.from({ length: CLASSIFIER_OUTPUTS }, (_, i) => ({ type: 'main' as const, displayName: String(i) })),
      { type: 'main', displayName: 'Other' },
    ],
    properties: [
      { name: 'inputText', displayName: 'Text to Classify', type: 'string', default: '{{ $json.text }}', required: true, typeOptions: { rows: 2 } },
      {
        name: 'categories',
        displayName: 'Categories',
        type: 'fixedCollection',
        typeOptions: { multipleValues: true },
        description: `Category 1 goes to output 0, category 2 to output 1… (up to ${CLASSIFIER_OUTPUTS})`,
        default: {
          categories: [
            { category: 'positive', description: 'Praise, satisfaction or thanks' },
            { category: 'negative', description: 'A complaint, frustration or a problem' },
          ],
        },
        groups: [
          {
            name: 'categories',
            displayName: 'Category',
            values: [
              { name: 'category', displayName: 'Category', type: 'string', default: '', noDataExpression: true },
              { name: 'description', displayName: 'Description', type: 'string', default: '', noDataExpression: true, description: 'Helps the model decide' },
            ],
          },
        ],
      },
      FALLBACK_PROPERTY,
      {
        name: 'options',
        displayName: 'Options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        values: [
          { name: 'multiClass', displayName: 'Allow Multiple Classes To Be True', type: 'boolean', default: false },
          {
            name: 'fallback',
            displayName: 'When No Clear Match',
            type: 'options',
            default: 'discard',
            options: [
              { name: 'Discard Item', value: 'discard' },
              { name: 'Output on Extra, “Other” Branch', value: 'other' },
            ],
          },
          {
            name: 'systemPromptTemplate',
            displayName: 'System Prompt Template',
            type: 'string',
            default: DEFAULT_CLASSIFIER_PROMPT,
            typeOptions: { rows: 4 },
            description: '{categories} is replaced by the category names',
          },
        ],
      },
    ],
  },
  async execute(ctx) {
    const model = await connectedModel(ctx, 'Text Classifier');
    const outputs: NodeItem[][] = Array.from({ length: CLASSIFIER_OUTPUTS + 1 }, () => []);
    await perItem(ctx, async (item, i) => {
      const categories = (ctx.getNodeParameter<{ categories?: Category[] }>('categories', i)?.categories ?? [])
        .map((entry) => ({ name: String(entry.category ?? '').trim(), description: String(entry.description ?? '').trim() }))
        .filter((entry) => entry.name);
      if (!categories.length) throw new NodeOperationError('No categories', { description: 'Add at least one category.' });
      if (categories.length > CLASSIFIER_OUTPUTS) {
        throw new NodeOperationError(`Text Classifier has ${CLASSIFIER_OUTPUTS} category outputs, but ${categories.length} categories are set`, {
          description: 'Merge categories, or classify the “Other” branch with a second Text Classifier.',
        });
      }
      const names = categories.map((entry) => entry.name);
      const duplicate = names.find((name, index) => names.indexOf(name) !== index);
      if (duplicate) throw new NodeOperationError(`Category “${duplicate}” is listed twice`);
      const options = ctx.getNodeParameter<{ multiClass?: boolean; fallback?: string; systemPromptTemplate?: string }>('options', i) ?? {};
      const text = requireText(ctx.getNodeParameter('inputText', i), 'Text to Classify');

      const schema: JsonSchema = {
        type: 'object',
        properties: Object.fromEntries(
          categories.map((entry) => [
            entry.name,
            { type: 'boolean', description: `true if the text is “${entry.name}”${entry.description ? `: ${entry.description}` : ''}` },
          ]),
        ),
        required: names,
        additionalProperties: false,
      };
      const rules = options.multiClass
        ? 'Set every category that applies to true, the others to false.'
        : `Set exactly one category to true${options.fallback === 'other' ? ', or all of them to false when none fits' : ''}.`;
      const system = [
        (options.systemPromptTemplate || DEFAULT_CLASSIFIER_PROMPT).replace(/\{categories\}/g, names.join(', ')),
        rules,
        formatInstructions(schema),
      ].join('\n\n');
      const chosen = (value: unknown) => names.filter((name) => (value as Record<string, unknown>)[name] === true);
      const { value } = await generateStructured<Record<string, boolean>>(model, {
        system,
        prompt: text,
        schema,
        soft: (reply) => (!options.multiClass && chosen(reply).length > 1 ? [`only one category may be true, got ${chosen(reply).join(', ')}`] : []),
      });

      let matched = chosen(value);
      if (!options.multiClass && matched.length > 1) {
        ctx.logger.warn(`item ${i}: several categories (${matched.join(', ')}); using “${matched[0]}”`);
        matched = matched.slice(0, 1);
      }
      ctx.logger.info(`item ${i}: ${matched.length ? matched.join(', ') : options.fallback === 'other' ? 'Other' : 'no match (discarded)'}`);
      const routed = { json: item.json, pairedItem: { item: i } };
      matched.forEach((name, n) => outputs[names.indexOf(name)].push(n ? structuredClone(routed) : routed));
      if (!matched.length && options.fallback === 'other') outputs[CLASSIFIER_OUTPUTS].push(routed);
    });
    return outputs;
  },
});

// ---------------------------------------------------------------------------
// Information Extractor
// ---------------------------------------------------------------------------

interface Attribute {
  name?: string;
  type?: 'string' | 'number' | 'boolean' | 'date';
  description?: string;
  required?: boolean;
}

const DEFAULT_EXTRACTOR_PROMPT =
  'You are an expert extraction algorithm.\nOnly extract relevant information from the text.\nIf you do not know the value of an attribute asked to extract, you may omit the attribute’s value.';

/** "Attribute list" → a JSON Schema object; optional attributes may be null. */
export function attributesSchema(attributes: Attribute[]): JsonSchema {
  const list = attributes.map((attribute) => ({ ...attribute, name: String(attribute.name ?? '').trim() })).filter((attribute) => attribute.name);
  if (!list.length) throw new NodeOperationError('No attributes', { description: 'Add an attribute to extract, or define a JSON Schema.' });
  return {
    type: 'object',
    properties: Object.fromEntries(
      list.map((attribute) => {
        const type = attribute.type === 'date' ? 'string' : (attribute.type ?? 'string');
        const description = [attribute.description, attribute.type === 'date' ? 'An ISO 8601 date, e.g. 2026-10-25.' : ''].filter(Boolean).join(' ');
        return [
          attribute.name,
          { type: attribute.required ? type : [type, 'null'], ...(description && { description }), ...(attribute.type === 'date' && { format: 'date' }) },
        ];
      }),
    ),
    required: list.filter((attribute) => attribute.required).map((attribute) => attribute.name),
    additionalProperties: false,
  };
}

export const informationExtractorNode = defineNode({
  description: {
    ...AI,
    name: 'informationExtractor',
    displayName: 'Information Extractor',
    description: 'Pull structured fields out of text with a chat model',
    icon: 'lucide:scan-text',
    keywords: ['extract', 'parse', 'structured', 'entities', 'fields', 'json', 'llm'],
    inputs: [{ type: 'main' }, modelInput, FALLBACK_PORT],
    outputs: main,
    properties: [
      { name: 'text', displayName: 'Text', type: 'string', default: '{{ $json.text }}', required: true, typeOptions: { rows: 2 } },
      {
        name: 'schemaType',
        displayName: 'Schema Type',
        type: 'options',
        default: 'fromAttributes',
        noDataExpression: true,
        options: [
          { name: 'From Attribute Descriptions', value: 'fromAttributes', description: 'List the attributes to extract' },
          { name: 'Define Using JSON Schema', value: 'manual' },
        ],
      },
      {
        name: 'attributes',
        displayName: 'Attributes',
        type: 'fixedCollection',
        typeOptions: { multipleValues: true },
        displayOptions: { show: { schemaType: ['fromAttributes'] } },
        default: { attributes: [{ name: '', type: 'string', description: '', required: false }] },
        groups: [
          {
            name: 'attributes',
            displayName: 'Attribute',
            values: [
              { name: 'name', displayName: 'Name', type: 'string', default: '', noDataExpression: true, placeholder: 'e.g. company' },
              {
                name: 'type',
                displayName: 'Type',
                type: 'options',
                default: 'string',
                options: [
                  { name: 'String', value: 'string' },
                  { name: 'Number', value: 'number' },
                  { name: 'Boolean', value: 'boolean' },
                  { name: 'Date', value: 'date' },
                ],
              },
              { name: 'description', displayName: 'Description', type: 'string', default: '', noDataExpression: true, placeholder: 'What to extract' },
              { name: 'required', displayName: 'Required', type: 'boolean', default: false },
            ],
          },
        ],
      },
      {
        name: 'inputSchema',
        displayName: 'JSON Schema',
        type: 'json',
        noDataExpression: true,
        displayOptions: { show: { schemaType: ['manual'] } },
        default:
          '{\n  "type": "object",\n  "properties": {\n    "state": { "type": "string" },\n    "cities": { "type": "array", "items": { "type": "string" } }\n  },\n  "required": ["state"]\n}',
      },
      FALLBACK_PROPERTY,
      {
        name: 'options',
        displayName: 'Options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        values: [
          { name: 'systemPromptTemplate', displayName: 'System Prompt Template', type: 'string', default: DEFAULT_EXTRACTOR_PROMPT, typeOptions: { rows: 4 } },
        ],
      },
    ],
  },
  async execute(ctx) {
    const model = await connectedModel(ctx, 'Information Extractor');
    const out = await perItem(ctx, async (_item, i): Promise<NodeItem> => {
      const text = requireText(ctx.getNodeParameter('text', i), 'Text');
      const schema =
        ctx.getNodeParameter('schemaType', i) === 'manual'
          ? readSchema(ctx.getNodeParameter('inputSchema', i))
          : attributesSchema(ctx.getNodeParameter<{ attributes?: Attribute[] }>('attributes', i)?.attributes ?? []);
      const options = ctx.getNodeParameter<{ systemPromptTemplate?: string }>('options', i) ?? {};
      const { value, attempts } = await generateStructured(model, {
        system: [options.systemPromptTemplate || DEFAULT_EXTRACTOR_PROMPT, formatInstructions(schema)].join('\n\n'),
        prompt: text,
        schema,
      });
      if (attempts > 1) ctx.logger.info(`item ${i}: valid JSON after a retry`);
      return { json: asItemJson(value), pairedItem: { item: i } };
    });
    return [out];
  },
});
