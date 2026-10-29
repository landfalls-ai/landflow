/**
 * Runtime validation for everything that crosses the wire. The host never
 * trusts a remote manifest: it is parsed with these schemas before a single
 * node reaches the editor. `pnpm --filter @landflow/protocol gen:schema`
 * exports them as JSON Schema for the Python/Go SDKs and the docs.
 */
import { z } from 'zod';
import type { CompositeTypeDescriptor, CredentialTypeDescriptor, NodeDescriptor, NodeMatcher, PluginManifest, PropertyDescriptor } from './types';

const primitive = z.union([z.string(), z.number(), z.boolean()]);

/** "#rgb", "#rgba", "#rrggbb" or "#rrggbbaa". */
export const HEX_COLOR = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/** Sub-node connection types: what a sub-node can supply. */
const SUB_NODE_TYPES = ['ai_languageModel', 'ai_tool', 'ai_memory', 'ai_embedding', 'ai_document', 'ai_textSplitter', 'ai_retriever', 'ai_reranker'] as const;

export const connectionTypeSchema = z.enum(['main', ...SUB_NODE_TYPES]);

/** A capability tag: lowercase words joined by dots (`ioc.enrich`, `llm.chain`). */
export const CAPABILITY = /^[a-z][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)*$/;
const IDENTIFIER = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

const displayOptionsSchema = z.object({
  show: z.record(z.string(), z.array(primitive)).optional(),
  hide: z.record(z.string(), z.array(primitive)).optional(),
});

export const portSchema = z.object({
  type: connectionTypeSchema,
  displayName: z.string().optional(),
  required: z.boolean().optional(),
  maxConnections: z.number().int().positive().optional(),
  displayOptions: displayOptionsSchema.optional(),
});

const jsonSchemaObject = z.record(z.string(), z.any());

/** MCP `ToolAnnotations` overrides (docs/protocol.md §15.1). */
export const toolAnnotationsSchema = z.object({
  title: z.string().optional(),
  readOnlyHint: z.boolean().optional(),
  destructiveHint: z.boolean().optional(),
  idempotentHint: z.boolean().optional(),
  openWorldHint: z.boolean().optional(),
});

export const propertyOptionSchema = z.object({
  name: z.string(),
  value: primitive,
  description: z.string().optional(),
  action: z.string().optional(),
  mcp: z.literal(false).optional(),
  idempotent: z.boolean().optional(),
  outputSchema: jsonSchemaObject.optional(),
  toolAnnotations: toolAnnotationsSchema.optional(),
});

const typeOptionsSchema = z.object({
  rows: z.number().int().optional(),
  password: z.boolean().optional(),
  language: z.enum(['javascript', 'json', 'python', 'sql', 'text', 'markdown']).optional(),
  minValue: z.number().optional(),
  maxValue: z.number().optional(),
  numberPrecision: z.number().int().optional(),
  multipleValues: z.boolean().optional(),
  loadOptionsMethod: z.string().optional(),
  loadOptionsDependsOn: z.array(z.string()).optional(),
});

export const propertySchema: z.ZodType<PropertyDescriptor> = z.lazy(() =>
  z.object({
    name: z.string().min(1),
    displayName: z.string(),
    type: z.enum([
      'string',
      'number',
      'boolean',
      'options',
      'multiOptions',
      'json',
      'code',
      'collection',
      'fixedCollection',
      'color',
      'dateTime',
      'notice',
      'hidden',
    ]),
    default: z.unknown().optional(),
    description: z.string().optional(),
    placeholder: z.string().optional(),
    hint: z.string().optional(),
    required: z.boolean().optional(),
    noDataExpression: z.boolean().optional(),
    options: z.array(propertyOptionSchema).optional(),
    values: z.array(propertySchema).optional(),
    groups: z
      .array(z.object({ name: z.string(), displayName: z.string(), values: z.array(propertySchema) }))
      .optional(),
    typeOptions: typeOptionsSchema.optional(),
    displayOptions: displayOptionsSchema.optional(),
  }),
);

export const nodeDescriptorSchema: z.ZodType<NodeDescriptor> = z.object({
  name: z
    .string()
    .regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/, 'node name must be an identifier (letters, digits, _ and -)'),
  displayName: z.string().min(1),
  description: z.string(),
  version: z.union([z.number().int().positive(), z.array(z.number().int().positive()).min(1)]),
  defaultVersion: z.number().int().positive().optional(),
  kind: z.enum(['trigger', 'action', 'subnode']),
  triggerSource: z.enum(['manual', 'webhook', 'schedule', 'chat', 'poll', 'appWebhook']).optional(),
  categories: z.array(z.string()).optional(),
  icon: z.string().optional(),
  color: z.string().optional(),
  subtitle: z.string().optional(),
  inputs: z.array(portSchema),
  outputs: z.array(portSchema),
  properties: z.array(propertySchema),
  usableAsTool: z.boolean().optional(),
  toolDescription: z.string().optional(),
  toolInputSchema: z.record(z.string(), z.any()).optional(),
  supplies: z.enum(SUB_NODE_TYPES).optional(),
  documentationUrl: z.string().optional(),
  keywords: z.array(z.string()).optional(),
  capabilities: z.array(z.string().regex(CAPABILITY, 'a capability is a lowercase dotted tag like ioc.enrich')).optional(),
  credentials: z
    .array(z.object({ name: z.string().min(1), required: z.boolean().optional(), displayOptions: displayOptionsSchema.optional() }))
    .optional(),
  idempotent: z.boolean().optional(),
  mcp: z.literal(false).optional(),
  outputSchema: jsonSchemaObject.optional(),
  toolAnnotations: toolAnnotationsSchema.optional(),
});

export const credentialTypeSchema: z.ZodType<CredentialTypeDescriptor> = z.object({
  name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/, 'credential type name must be an identifier'),
  displayName: z.string().min(1),
  description: z.string().optional(),
  icon: z.string().optional(),
  documentationUrl: z.string().optional(),
  properties: z.array(propertySchema),
  testable: z.boolean().optional(),
  extends: z.array(z.string().min(1)).optional(),
});

const oneOrMany = <T extends z.ZodTypeAny>(schema: T) => z.union([schema, z.array(schema).min(1)]);

export const nodeMatcherSchema: z.ZodType<NodeMatcher> = z.lazy(() =>
  z
    .object({
      type: oneOrMany(z.string().min(1)).optional(),
      kind: oneOrMany(z.enum(['trigger', 'action', 'subnode'])).optional(),
      supplies: oneOrMany(z.enum(SUB_NODE_TYPES)).optional(),
      category: oneOrMany(z.string().min(1)).optional(),
      capability: oneOrMany(z.string().regex(CAPABILITY)).optional(),
      input: connectionTypeSchema.optional(),
      composite: oneOrMany(z.string().min(1)).optional(),
      anyOf: z.array(nodeMatcherSchema).min(1).optional(),
    })
    .refine((m) => Object.keys(m).length > 0, 'a matcher needs at least one field'),
);

const compositePortSchema = z.object({
  name: z.string().regex(IDENTIFIER, 'a port name must be an identifier'),
  displayName: z.string().optional(),
  slot: z.string().optional(),
  index: z.number().int().min(0).optional(),
});

const compositeRuleSchema = z.discriminatedUnion('rule', [
  z.object({ rule: z.literal('feeds'), from: z.string().min(1), to: z.string().min(1), via: connectionTypeSchema.optional() }),
  z.object({ rule: z.literal('onError'), slots: z.array(z.string().min(1)).min(1), value: z.enum(['stop', 'continue']) }),
  z.object({ rule: z.literal('reaches'), to: z.string().min(1) }),
  z.object({ rule: z.literal('sealed') }),
]);

export const compositeTypeSchema: z.ZodType<CompositeTypeDescriptor> = z
  .object({
    name: z.string().regex(IDENTIFIER, 'composite name must be an identifier'),
    displayName: z.string().min(1),
    description: z.string(),
    version: z.number().int().positive(),
    icon: z.string().optional(),
    color: z.string().regex(HEX_COLOR).optional(),
    inputs: z.array(compositePortSchema).optional(),
    outputs: z.array(compositePortSchema).optional(),
    slots: z
      .array(
        z.object({
          name: z.string().regex(IDENTIFIER, 'a slot name must be an identifier'),
          displayName: z.string().min(1),
          description: z.string().optional(),
          accepts: nodeMatcherSchema,
          min: z.number().int().min(0).optional(),
          max: z.number().int().positive().optional(),
          locked: z.boolean().optional(),
        }),
      )
      .min(1),
    rules: z.array(compositeRuleSchema).optional(),
    closed: z.boolean().optional(),
    onError: z.enum(['stop', 'fallback']).optional(),
    timeoutSeconds: z.number().positive().optional(),
    properties: z.array(propertySchema).optional(),
    starter: z
      .object({
        nodes: z.array(
          z.object({
            id: z.string().min(1),
            name: z.string().min(1),
            type: z.string().min(1),
            typeVersion: z.number().int().positive().optional(),
            position: z.tuple([z.number(), z.number()]),
            parameters: z.record(z.string(), z.any()).optional(),
            onError: z.enum(['stop', 'continue']).optional(),
            retryOnFail: z.boolean().optional(),
            maxTries: z.number().int().positive().optional(),
            slot: z.string().optional(),
          }),
        ),
        connections: z.array(
          z.object({ source: z.string().min(1), sourceIndex: z.number().int().min(0).optional(), target: z.string().min(1), targetIndex: z.number().int().min(0).optional(), type: connectionTypeSchema.optional() }),
        ),
      })
      .optional(),
  })
  .superRefine((type, ctx) => {
    const slots = new Set<string>();
    for (const slot of type.slots) {
      if (slots.has(slot.name)) ctx.addIssue({ code: 'custom', message: `duplicate slot "${slot.name}"` });
      slots.add(slot.name);
      if (slot.max !== undefined && slot.max < (slot.min ?? 1)) ctx.addIssue({ code: 'custom', message: `slot "${slot.name}": max is below min` });
    }
    const known = (name: string | undefined, where: string) => {
      if (name !== undefined && !slots.has(name)) ctx.addIssue({ code: 'custom', message: `${where} names unknown slot "${name}"` });
    };
    for (const port of [...(type.inputs ?? []), ...(type.outputs ?? [])]) known(port.slot, `port "${port.name}"`);
    for (const rule of type.rules ?? []) {
      if (rule.rule === 'feeds') (known(rule.from, 'a feeds rule'), known(rule.to, 'a feeds rule'));
      if (rule.rule === 'onError') rule.slots.forEach((slot) => known(slot, 'an onError rule'));
      if (rule.rule === 'reaches') known(rule.to, 'a reaches rule');
    }
    const ids = new Set(type.starter?.nodes.map((n) => n.id));
    for (const node of type.starter?.nodes ?? []) known(node.slot, `starter node "${node.id}"`);
    for (const c of type.starter?.connections ?? []) {
      if (!ids.has(c.source) || !ids.has(c.target)) ctx.addIssue({ code: 'custom', message: `starter connection ${c.source} → ${c.target} names an unknown node` });
    }
  });

export const pluginInfoSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'plugin id must be lowercase kebab-case'),
  name: z.string().min(1),
  version: z.string().min(1),
  description: z.string().optional(),
  language: z.string().min(1),
  sdk: z.object({ name: z.string(), version: z.string() }).optional(),
  icon: z.string().optional(),
  color: z.string().regex(HEX_COLOR, 'plugin color must be a hex colour like #2563eb').optional(),
  author: z.string().optional(),
  homepage: z.string().optional(),
});

export const manifestSchema: z.ZodType<PluginManifest> = z.object({
  protocol: z.literal('landflow.plugin/v1'),
  plugin: pluginInfoSchema,
  nodes: z.array(nodeDescriptorSchema),
  credentialTypes: z.array(credentialTypeSchema).optional(),
  composites: z.array(compositeTypeSchema).optional(),
  transports: z.array(z.string().regex(/^[a-z0-9][a-z0-9._-]*$/, 'a transport kind is lowercase: http, grpc, kafka, …')).optional(),
  maxConcurrency: z.number().int().positive().optional(),
});

const jsonObject = z.record(z.string(), z.unknown());

/** A stored ref has an `id`; one a node returns may carry inline base64 `data` instead (the host stores it). */
export const binaryRefSchema = z
  .object({
    id: z.string().regex(/^[\w-]{1,64}\.[\w-]{8,64}$/, 'binary id must look like <scope>.<random>').optional(),
    mimeType: z.string(),
    fileName: z.string().optional(),
    fileExtension: z.string().optional(),
    fileSize: z.number().int().nonnegative().optional(),
    fileType: z.enum(['image', 'text', 'json', 'html', 'pdf', 'audio', 'video', 'other']).optional(),
    data: z.string().optional(),
  })
  .refine((ref) => ref.id !== undefined || ref.data !== undefined, 'a binary ref needs an id or inline data');

export const nodeItemSchema = z.object({
  json: jsonObject,
  binary: z.record(z.string(), binaryRefSchema).optional(),
  pairedItem: z.object({ item: z.number().int(), input: z.number().int().optional() }).optional(),
});

export const executeRequestSchema = z.object({
  protocol: z.literal('landflow.plugin/v1'),
  executionId: z.string(),
  workflowId: z.string().optional(),
  mode: z.enum(['manual', 'trigger', 'webhook', 'tool', 'chat', 'poll', 'mcp']),
  node: z.object({
    id: z.string(),
    name: z.string(),
    type: z.string(),
    typeVersion: z.number().int(),
  }),
  parameters: jsonObject,
  itemParameters: z.array(jsonObject),
  inputs: z.array(z.array(nodeItemSchema)),
  credentials: z.record(z.string(), jsonObject).optional(),
  pollState: jsonObject.optional(),
  continueOnFail: z.boolean().optional(),
  idempotencyKey: z.string().optional(),
  binaryAccess: z.object({ url: z.string(), token: z.string() }).optional(),
});

export const executeResponseSchema = z.object({
  outputs: z.array(z.array(nodeItemSchema)),
  logs: z
    .array(z.object({ level: z.enum(['debug', 'info', 'warn', 'error']), message: z.string() }))
    .optional(),
  error: z
    .object({
      message: z.string(),
      description: z.string().optional(),
      itemIndex: z.number().int().optional(),
    })
    .optional(),
  pollState: jsonObject.optional(),
});

const nodeRefSchema = z.object({ id: z.string(), name: z.string(), type: z.string(), typeVersion: z.number().int() });

export const webhookMethodRequestSchema = z.object({
  protocol: z.literal('landflow.plugin/v1'),
  method: z.enum(['checkExists', 'create', 'delete']),
  workflowId: z.string(),
  node: nodeRefSchema,
  parameters: jsonObject,
  credentials: z.record(z.string(), jsonObject).optional(),
  webhookUrl: z.string(),
  staticData: jsonObject.default({}),
});

export const webhookRequestSchema = z.object({
  protocol: z.literal('landflow.plugin/v1'),
  workflowId: z.string(),
  node: nodeRefSchema,
  parameters: jsonObject,
  credentials: z.record(z.string(), jsonObject).optional(),
  webhookUrl: z.string(),
  staticData: jsonObject.default({}),
  request: z.object({
    method: z.string(),
    path: z.string().default(''),
    headers: z.record(z.string(), z.string()).default({}),
    query: z.record(z.string(), z.string()).default({}),
    body: z.string().default(''),
  }),
});

export const announceRequestSchema = z.object({
  protocol: z.literal('landflow.plugin/v1'),
  /** Direct URLs, or a brokered `<kind>://<connectionId>/<pluginId>` (docs/protocol.md §14.2). */
  endpoint: z.string().regex(/^(?:(?:https?|grpc):\/\/[^\s/]+|[a-z][a-z0-9+.-]*:\/\/[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*)$/i, 'endpoint must be http(s)://, grpc:// or <kind>://<connectionId>/<pluginId>'),
  pluginId: z.string().min(1),
  version: z.string().min(1),
  ttlSeconds: z.number().int().positive().max(3600).optional(),
  instanceId: z.string().min(1).max(128).optional(),
  /** Hints (docs/protocol.md §14.1): the faces the plugin process was built with, and how many calls one instance takes at once. */
  transports: z.array(z.string().min(1).max(32)).max(32).optional(),
  maxConcurrency: z.number().int().positive().max(100_000).optional(),
});

export const withdrawRequestSchema = z.object({
  endpoint: z.string(),
  pluginId: z.string().optional(),
});

/** Parse a manifest and return a readable error instead of throwing a ZodError. */
export function parseManifest(input: unknown):
  | { ok: true; manifest: PluginManifest }
  | { ok: false; error: string } {
  const result = manifestSchema.safeParse(input);
  if (result.success) return { ok: true, manifest: result.data };
  const error = result.error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
  return { ok: false, error };
}
