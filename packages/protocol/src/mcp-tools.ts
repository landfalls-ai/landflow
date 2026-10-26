/**
 * MCP tool mapping (docs/protocol.md §15.1): a plugin manifest in, MCP tool definitions out, and the way back from a
 * tool call's arguments to node parameters. Pure and shared: the SDKs' MCP faces, the host's per-plugin MCP endpoints
 * and the conformance kit all use this, so a plugin lists the same tools wherever it is reached.
 *
 * One tool per operation: n8n-style nodes carry a `resource` dropdown and one or more `operation` dropdowns shown per
 * resource; each (resource, operation) pair becomes `<resource>_<operation>`. A node without `resource` uses its own
 * name in that place (`postgres_select`, `base64_encode`), and a node without `operation` is one tool named after the
 * node (`hash`). Through the gateway every name is prefixed with the plugin: {@link gatewayToolName}.
 */
import type { JsonObject, JsonValue, McpToolAnnotations, NodeDescriptor, PluginManifest, PropertyDescriptor, PropertyOption } from './types';
import { defaultVersionOf, qualifyType } from './util';

/** Tool names: letters, digits, `_` and `-`, at most 64 characters (the MCP spec allows 128 and `.`; the strictest common client allows 64). */
export const MCP_TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const MCP_TOOL_NAME_MAX_LENGTH = 64;

/** The `_meta` key under which a tool definition carries its node binding (what the reverse mapping reads). */
export const MCP_TOOL_META_KEY = 'dev.landflow/node';

/** A parameter whose values come from `LoadOptions`: the schema says `string`, the host may resolve the list when it holds a credential. */
export interface McpDynamicOption {
  /** The parameter, as a JSON pointer-like path inside the arguments (`"channel"`, `"options/labels"`). */
  parameter: string;
  method: string;
  dependsOn?: string[];
}

/**
 * A parameter that chooses the credential (`authentication: oAuth2 | serviceAccount`): never an argument. The host
 * sets it from the credential type it binds (`byCredential[<credential type>]`), a standalone plugin from its config.
 */
export interface McpCredentialSelector {
  parameter: string;
  byCredential: Record<string, JsonValue>;
}

/** What binds a tool to a node: kept in `_meta[MCP_TOOL_META_KEY]` and read back by {@link toolCallToParameters}. */
export interface McpToolBinding {
  pluginId: string;
  /** Fully qualified: `telegram.message` is `messaging.telegram`'s node `telegram`. */
  nodeType: string;
  nodeName: string;
  typeVersion: number;
  resource?: string;
  operation?: string;
  /** Parameters the tool fixes (`resource`, `operation`); the arguments are merged over them. */
  fixedParameters: JsonObject;
  /** Top-level argument names (the properties in `inputSchema`). */
  arguments: string[];
  /** Credential type local names the node can use; never arguments (bound by the host or local config). */
  credentials: string[];
  /** Parameters that pick the credential, left out of the arguments; the host sets them from the bound credential. */
  credentialSelectors: McpCredentialSelector[];
  dynamicOptions: McpDynamicOption[];
}

/** An MCP `Tool` as listed by `tools/list`, plus the Landflow binding under `_meta`. */
export interface McpToolDefinition {
  name: string;
  title: string;
  description: string;
  /** JSON Schema 2020-12, `type: object`. */
  inputSchema: JsonObject;
  /** JSON Schema of `structuredContent` (`{ items: [...] }`), when the node or operation declares `outputSchema`. */
  outputSchema?: JsonObject;
  annotations: Required<Omit<McpToolAnnotations, 'title'>> & { title?: string };
  _meta: { [MCP_TOOL_META_KEY]: McpToolBinding };
}

export interface McpToolMappingOptions {
  /** Also map action nodes without `usableAsTool` (the spec maps only flagged nodes; the plugin design rules flag every action node). */
  includeAllActions?: boolean;
  /** Map this type version instead of the node's default one. */
  typeVersion?: number;
}

const READ_ONLY_OPERATION = /^(get|getAll|getMany|list|search|read|find|fetch|describe|count|exists|check|download|select|info|keys|llen|lookup|retrieve|view|show|preview|head)(?![a-z])/;
const DESTRUCTIVE_OPERATION = /^(delete|remove|destroy|drop|purge|archive|trash|clear|truncate|revoke|unpublish|deleteTable|deleteMessage)(?![a-z])/;
const DISCRIMINATORS = new Set(['resource', 'operation']);

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/**
 * Make any string a legal tool name: characters outside `[A-Za-z0-9_-]` become `_`, runs collapse, leading and trailing
 * `_` go, and the result is cut to `max` characters (`tool` if nothing is left).
 */
export function sanitizeToolName(raw: string, max = MCP_TOOL_NAME_MAX_LENGTH): string {
  const cleaned = raw
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^[_-]+|[_-]+$/g, '')
    .slice(0, max)
    .replace(/[_-]+$/g, '');
  return cleaned || 'tool';
}

/** The name a tool has on the gateway's shared endpoint: `<pluginId>_<tool>` (`twilio_message_send`), sanitised to the same rules. */
export function gatewayToolName(pluginId: string, toolName: string): string {
  return sanitizeToolName(`${pluginId}_${toolName}`);
}

/** Give every entry a distinct name: a repeat gets `_2`, `_3`, … while staying within the length limit. */
function uniqueNames(names: string[]): string[] {
  const seen = new Map<string, number>();
  const out: string[] = [];
  const taken = new Set(names);
  for (const name of names) {
    const count = (seen.get(name) ?? 0) + 1;
    seen.set(name, count);
    if (count === 1) {
      out.push(name);
      continue;
    }
    let n = count;
    let candidate: string;
    do {
      const suffix = `_${n++}`;
      candidate = `${name.slice(0, MCP_TOOL_NAME_MAX_LENGTH - suffix.length)}${suffix}`;
    } while (taken.has(candidate));
    taken.add(candidate);
    out.push(candidate);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

interface OperationSlot {
  resource?: PropertyOption;
  operation?: PropertyOption;
  fixed: JsonObject;
}

function isOptionsProperty(property: PropertyDescriptor, name: string): property is PropertyDescriptor & { options: PropertyOption[] } {
  return property.name === name && property.type === 'options' && !property.typeOptions?.loadOptionsMethod && (property.options?.length ?? 0) > 0;
}

/** Does this `operation` property show for the resource? Only its `resource` condition counts; other conditions (an auth method) are ignored. */
function appliesToResource(property: PropertyDescriptor, resource: string | number | boolean): boolean {
  const show = property.displayOptions?.show?.resource;
  if (show && !show.includes(resource)) return false;
  const hide = property.displayOptions?.hide?.resource;
  return !(hide && hide.includes(resource));
}

function uniqueOptions(options: PropertyOption[]): PropertyOption[] {
  const seen = new Set<string>();
  return options.filter((option) => (seen.has(String(option.value)) ? false : (seen.add(String(option.value)), true)));
}

/**
 * The (resource, operation) pairs of a node, in manifest order. Operations split over several `operation` properties
 * (one per authentication method, as in n8n) are merged per resource, so a tool exists whatever the auth method.
 */
export function operationSlots(node: Pick<NodeDescriptor, 'properties'>): OperationSlot[] {
  const resourceProperty = node.properties.find((p) => isOptionsProperty(p, 'resource'));
  const operationProperties = node.properties.filter((p) => isOptionsProperty(p, 'operation'));
  if (!resourceProperty) {
    if (!operationProperties.length) return [{ fixed: {} }];
    return uniqueOptions(operationProperties.flatMap((p) => p.options)).map((operation) => ({ operation, fixed: { operation: operation.value } }));
  }
  const slots: OperationSlot[] = [];
  for (const resource of resourceProperty.options) {
    const operations = uniqueOptions(operationProperties.filter((p) => appliesToResource(p, resource.value)).flatMap((p) => p.options));
    if (!operations.length) slots.push({ resource, fixed: { resource: resource.value } });
    for (const operation of operations) slots.push({ resource, operation, fixed: { resource: resource.value, operation: operation.value } });
  }
  return slots;
}

/**
 * Visibility against the fixed parameters only: a condition on `resource`/`operation` must hold; a condition on any
 * other parameter (an argument the agent may set) is ignored, so the property is offered and its condition is noted
 * in the description instead.
 */
function shownForSlot(property: { displayOptions?: PropertyDescriptor['displayOptions'] }, fixed: JsonObject): boolean {
  const { show, hide } = property.displayOptions ?? {};
  for (const [key, allowed] of Object.entries(show ?? {})) {
    if (key in fixed && !allowed.includes(fixed[key] as never)) return false;
  }
  for (const [key, blocked] of Object.entries(hide ?? {})) {
    if (key in fixed && blocked.includes(fixed[key] as never)) return false;
  }
  return true;
}

/** "Only used when `sendTo` is `channel`." for conditions on arguments (not on the fixed discriminators). */
function conditionNote(property: { displayOptions?: PropertyDescriptor['displayOptions'] }, fixed: JsonObject, selectors?: Set<string>): string | undefined {
  const parts: string[] = [];
  const skip = (key: string) => key in fixed || key.startsWith('/') || selectors?.has(key);
  for (const [key, allowed] of Object.entries(property.displayOptions?.show ?? {})) {
    if (skip(key)) continue;
    parts.push(`\`${key}\` is ${allowed.map((v) => `\`${String(v)}\``).join(' or ')}`);
  }
  for (const [key, blocked] of Object.entries(property.displayOptions?.hide ?? {})) {
    if (skip(key)) continue;
    parts.push(`\`${key}\` is not ${blocked.map((v) => `\`${String(v)}\``).join(' or ')}`);
  }
  return parts.length ? `Only used when ${parts.join(' and ')}.` : undefined;
}

// ---------------------------------------------------------------------------
// Property → JSON Schema
// ---------------------------------------------------------------------------

interface SchemaContext {
  fixed: JsonObject;
  dynamic: McpDynamicOption[];
  /** Path of the enclosing collections, for `McpDynamicOption.parameter`. */
  path: string[];
  /** Top-level parameter names that choose the credential (never arguments; no "only used when" note about them). */
  selectors?: Set<string>;
}

/**
 * The parameters a node's `credentials[].displayOptions` switch on (`authentication`), with the value each credential
 * type needs: `{ parameter: 'authentication', byCredential: { googleOAuth2Api: 'oAuth2', googleServiceAccount: 'serviceAccount' } }`.
 */
export function credentialSelectorsOf(node: Pick<NodeDescriptor, 'credentials'>): McpCredentialSelector[] {
  const byParameter = new Map<string, Record<string, JsonValue>>();
  for (const credential of node.credentials ?? []) {
    for (const [parameter, values] of Object.entries(credential.displayOptions?.show ?? {})) {
      if (!values.length) continue;
      const entry = byParameter.get(parameter) ?? {};
      entry[credential.name] = values[0];
      byParameter.set(parameter, entry);
    }
  }
  return [...byParameter].map(([parameter, byCredential]) => ({ parameter, byCredential }));
}

const joinText = (...parts: Array<string | undefined>) => {
  const text = parts.filter((p): p is string => !!p && p.trim().length > 0).map((p) => p.trim().replace(/\.?$/, '.'));
  return text.length ? text.join(' ') : undefined;
};

function enumOf(options: PropertyOption[], several: boolean): { values: JsonValue[]; type?: string; note: string } {
  const values = options.map((o) => o.value);
  const kinds = new Set(values.map((v) => typeof v));
  const type = kinds.size === 1 ? (kinds.has('number') ? 'number' : kinds.has('boolean') ? 'boolean' : 'string') : undefined;
  const note = `${several ? 'Any of' : 'One of'}: ${options.map((o) => `\`${String(o.value)}\` (${o.name}${o.description ? `: ${o.description}` : ''})`).join(', ')}`;
  return { values, type, note };
}

function objectSchema(fields: PropertyDescriptor[], context: SchemaContext): JsonObject {
  const properties: JsonObject = {};
  const required: string[] = [];
  for (const field of fields) {
    if (field.name in properties) continue;
    const schema = propertyToJsonSchema(field, context);
    if (!schema) continue;
    properties[field.name] = schema;
    if (field.required) required.push(field.name);
  }
  return { type: 'object', properties, ...(required.length && { required }) };
}

/**
 * The JSON Schema (2020-12) of one node property as a tool argument, or `undefined` for properties that are not
 * arguments (`notice`, `hidden`, the `resource`/`operation` discriminators, properties the fixed parameters hide).
 * Static options become `enum` and the option titles go into the description; dynamic options (`loadOptionsMethod`)
 * become a string with a note, and are recorded in `context.dynamic`.
 */
export function propertyToJsonSchema(property: PropertyDescriptor, context: SchemaContext = { fixed: {}, dynamic: [], path: [] }): JsonObject | undefined {
  if (property.type === 'notice' || property.type === 'hidden') return undefined;
  if (!context.path.length && DISCRIMINATORS.has(property.name) && property.name in context.fixed) return undefined;
  if (!context.path.length && context.selectors?.has(property.name)) return undefined;
  if (!shownForSlot(property, context.fixed)) return undefined;
  const path = [...context.path, property.name];
  const base: JsonObject = { title: property.displayName };
  let note: string | undefined;
  const typeOptions = property.typeOptions ?? {};
  switch (property.type) {
    case 'string':
    case 'color':
      base.type = 'string';
      break;
    case 'code':
      base.type = 'string';
      note = typeOptions.language ? `${typeOptions.language} code.` : 'Code.';
      break;
    case 'dateTime':
      base.type = 'string';
      base.format = 'date-time';
      break;
    case 'number':
      base.type = typeOptions.numberPrecision === 0 ? 'integer' : 'number';
      if (typeOptions.minValue !== undefined) base.minimum = typeOptions.minValue;
      if (typeOptions.maxValue !== undefined) base.maximum = typeOptions.maxValue;
      break;
    case 'boolean':
      base.type = 'boolean';
      break;
    case 'json':
      base.type = ['object', 'array', 'string'];
      note = 'A JSON value (an object or array, or JSON text).';
      break;
    case 'options':
    case 'multiOptions': {
      let item: JsonObject;
      if (typeOptions.loadOptionsMethod) {
        item = { type: 'string' };
        note = 'Values come from the connected account (a dynamic list); pass the id or value, not the label.';
        context.dynamic.push({ parameter: path.join('/'), method: typeOptions.loadOptionsMethod, ...(typeOptions.loadOptionsDependsOn?.length && { dependsOn: typeOptions.loadOptionsDependsOn }) });
      } else if (property.options?.length) {
        const { values, type, note: enumNote } = enumOf(property.options, property.type === 'multiOptions');
        item = { ...(type && { type }), enum: values };
        note = enumNote;
      } else {
        item = { type: 'string' };
      }
      if (property.type === 'options') Object.assign(base, item);
      else {
        base.type = 'array';
        base.items = item;
      }
      break;
    }
    case 'collection':
      Object.assign(base, objectSchema(property.values ?? [], { ...context, path }));
      break;
    case 'fixedCollection': {
      const groups: JsonObject = {};
      for (const group of property.groups ?? []) {
        const schema = { title: group.displayName, ...objectSchema(group.values, { ...context, path: [...path, group.name] }) };
        groups[group.name] = typeOptions.multipleValues ? { type: 'array', items: schema } : schema;
      }
      Object.assign(base, { type: 'object', properties: groups });
      break;
    }
  }
  const description = joinText(property.description ?? property.hint, note, conditionNote(property, context.fixed, context.selectors));
  if (description) base.description = description;
  if (property.default !== undefined && property.default !== null && !(property.type === 'fixedCollection' || property.type === 'collection')) {
    base.default = property.default as JsonValue;
  }
  return base;
}

// ---------------------------------------------------------------------------
// Annotations, titles, descriptions
// ---------------------------------------------------------------------------

/** The annotations derived from the operation name and `idempotent`, then the node's and the operation's overrides. */
export function deriveToolAnnotations(node: NodeDescriptor, slot: { operation?: PropertyOption }, title: string): McpToolDefinition['annotations'] {
  const verb = slot.operation ? String(slot.operation.value) : node.name;
  const readOnly = READ_ONLY_OPERATION.test(verb);
  const destructive = !readOnly && DESTRUCTIVE_OPERATION.test(verb);
  const idempotent = slot.operation?.idempotent ?? node.idempotent ?? false;
  return {
    title,
    readOnlyHint: readOnly,
    destructiveHint: destructive,
    idempotentHint: readOnly || idempotent,
    openWorldHint: true,
    ...node.toolAnnotations,
    ...slot.operation?.toolAnnotations,
  };
}

/**
 * `<resource>_<operation>`, prefixed with the node name when a plugin hosts several apps (`telegram_message_sendMessage`
 * next to `slack_message_post`: Telegram and Slack both have a `message` resource). The prefix is dropped when the node
 * is named after its plugin (the Twilio plugin's `twilio` node gives `message_send`, `twilio_message_send` on the
 * gateway). Without a `resource` the node name takes its place (`postgres_select`); without both, the node name alone.
 */
export function rawToolName(pluginId: string, node: Pick<NodeDescriptor, 'name'>, slot: { resource?: PropertyOption; operation?: PropertyOption }): string {
  const segments: string[] = [];
  if (!slot.resource || node.name !== pluginId) segments.push(node.name);
  if (slot.resource) segments.push(String(slot.resource.value));
  if (slot.operation) segments.push(String(slot.operation.value));
  return segments.join('_');
}

function toolTitle(node: NodeDescriptor, slot: OperationSlot): string {
  return [node.displayName, slot.resource?.name, slot.operation?.name].filter((p): p is string => !!p).join(' · ');
}

function toolDescription(node: NodeDescriptor, slot: OperationSlot): string {
  const operation = slot.operation;
  const what = operation
    ? operation.action ?? operation.description ?? (slot.resource ? `${operation.name} (${slot.resource.name.toLowerCase()})` : operation.name)
    : slot.resource
      ? `${slot.resource.name}${slot.resource.description ? `: ${slot.resource.description}` : ''}`
      : undefined;
  return joinText(what, node.toolDescription ?? node.description) ?? node.displayName;
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

/** Whether a node is offered as MCP tools at all: an action node, `usableAsTool` (unless `includeAllActions`), not opted out. */
export function isMcpToolNode(node: NodeDescriptor, options: McpToolMappingOptions = {}): boolean {
  if (node.kind !== 'action' || node.mcp === false) return false;
  return options.includeAllActions ? true : node.usableAsTool === true;
}

/** The tools of one node, before names are made unique across the plugin (see {@link mcpToolsFromDescriptors}). */
export function mcpToolsForNode(pluginId: string, node: NodeDescriptor, options: McpToolMappingOptions = {}): McpToolDefinition[] {
  if (!isMcpToolNode(node, options)) return [];
  const typeVersion = options.typeVersion ?? defaultVersionOf(node);
  const credentialSelectors = credentialSelectorsOf(node);
  const selectors = new Set(credentialSelectors.map((s) => s.parameter));
  const tools: McpToolDefinition[] = [];
  for (const slot of operationSlots(node)) {
    if (slot.resource?.mcp === false || slot.operation?.mcp === false) continue;
    const context: SchemaContext = { fixed: slot.fixed, dynamic: [], path: [], selectors };
    const inputSchema = objectSchema(node.properties, context);
    const title = toolTitle(node, slot);
    const outputSchema = slot.operation?.outputSchema ?? node.outputSchema;
    tools.push({
      name: sanitizeToolName(rawToolName(pluginId, node, slot)),
      title,
      description: toolDescription(node, slot),
      inputSchema,
      ...(outputSchema && { outputSchema: structuredContentSchema(outputSchema) }),
      annotations: deriveToolAnnotations(node, slot, title),
      _meta: {
        [MCP_TOOL_META_KEY]: {
          pluginId,
          nodeType: qualifyType(pluginId, node.name),
          nodeName: node.name,
          typeVersion,
          ...(slot.resource && { resource: String(slot.resource.value) }),
          ...(slot.operation && { operation: String(slot.operation.value) }),
          fixedParameters: slot.fixed,
          arguments: Object.keys(inputSchema.properties as JsonObject),
          credentials: (node.credentials ?? []).map((c) => c.name),
          credentialSelectors,
          dynamicOptions: context.dynamic,
        },
      },
    });
  }
  return tools;
}

/** `outputSchema` of a tool: `structuredContent` is `{ items: [<one item's json>] }`. */
function structuredContentSchema(itemSchema: JsonObject): JsonObject {
  return { type: 'object', properties: { items: { type: 'array', items: itemSchema } }, required: ['items'] };
}

/** The tools of a set of node descriptors (a manifest's nodes, or the host's core nodes), with names unique per plugin. */
export function mcpToolsFromDescriptors(pluginId: string, nodes: NodeDescriptor[], options: McpToolMappingOptions = {}): McpToolDefinition[] {
  const tools = nodes.flatMap((node) => mcpToolsForNode(pluginId, node, options));
  const names = uniqueNames(tools.map((tool) => tool.name));
  return tools.map((tool, i) => (tool.name === names[i] ? tool : { ...tool, name: names[i] }));
}

/** The MCP tools of a plugin, from its manifest. */
export function mcpToolsFromManifest(manifest: PluginManifest, options: McpToolMappingOptions = {}): McpToolDefinition[] {
  return mcpToolsFromDescriptors(manifest.plugin.id, manifest.nodes, options);
}

/** A tool definition as the MCP client sees it: without `_meta` when the server does not want to expose the binding. */
export function withoutBinding(tool: McpToolDefinition): Omit<McpToolDefinition, '_meta'> {
  const { _meta: _ignored, ...rest } = tool;
  return rest;
}

export function findMcpTool(tools: McpToolDefinition[], name: string): McpToolDefinition | undefined {
  return tools.find((tool) => tool.name === name);
}

/** The result of mapping a tool call back onto a node: what to put into `ExecuteRequest.node` and `parameters`. */
export interface McpToolCallMapping {
  nodeType: string;
  typeVersion: number;
  /** The fixed parameters (`resource`, `operation`) with the known arguments merged over them. */
  parameters: JsonObject;
  /** Argument names the tool's schema does not know; the host ignores them (and may tell the client). */
  ignored: string[];
}

/**
 * The reverse mapping: a tool call's arguments become the node's parameters for that resource and operation. Only
 * arguments the tool declares are taken; the rest is reported in `ignored`. Defaults are left to the host (its engine
 * fills unset visible properties from the descriptor, as for any node).
 */
export function toolCallToParameters(tool: McpToolDefinition, args: JsonObject | undefined): McpToolCallMapping {
  const binding = tool._meta[MCP_TOOL_META_KEY];
  const known = new Set(binding.arguments);
  const parameters: JsonObject = { ...binding.fixedParameters };
  const ignored: string[] = [];
  for (const [key, value] of Object.entries(args ?? {})) {
    if (known.has(key)) parameters[key] = value;
    else ignored.push(key);
  }
  return { nodeType: binding.nodeType, typeVersion: binding.typeVersion, parameters, ignored };
}
