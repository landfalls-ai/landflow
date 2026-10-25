/**
 * Runtime validation for everything that crosses the wire. The host never
 * trusts a remote manifest: it is parsed with these schemas before a single
 * node reaches the editor. `pnpm --filter @landflow/protocol gen:schema`
 * exports them as JSON Schema for the Python/Go SDKs and the docs.
 */
import { z } from 'zod';
import type { CredentialTypeDescriptor, NodeDescriptor, PluginManifest, PropertyDescriptor } from './types';

const primitive = z.union([z.string(), z.number(), z.boolean()]);

/** "#rgb", "#rgba", "#rrggbb" or "#rrggbbaa". */
export const HEX_COLOR = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/** Sub-node connection types: what a sub-node can supply. */
const SUB_NODE_TYPES = ['ai_languageModel', 'ai_tool', 'ai_memory', 'ai_embedding', 'ai_document', 'ai_textSplitter', 'ai_retriever', 'ai_reranker'] as const;

export const connectionTypeSchema = z.enum(['main', ...SUB_NODE_TYPES]);

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

export const propertyOptionSchema = z.object({
  name: z.string(),
  value: primitive,
  description: z.string().optional(),
  action: z.string().optional(),
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
  credentials: z
    .array(z.object({ name: z.string().min(1), required: z.boolean().optional(), displayOptions: displayOptionsSchema.optional() }))
    .optional(),
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
  endpoint: z.string().regex(/^(https?|grpc):\/\/[^\s/]+/, 'endpoint must be http(s):// or grpc://'),
  pluginId: z.string().min(1),
  version: z.string().min(1),
  ttlSeconds: z.number().int().positive().max(3600).optional(),
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
