/**
 * Which tools an AI Judge may use (C13, FR-7): only ones that read. Read-only is a claim, so it is checked against who makes it:
 *  - an MCP server says for itself that a tool only reads (`readOnlyHint`), and a server can be wrong or lie. Its tools are
 *    admitted only when the hint is set AND an admin listed the server in LANDFLOW_JUDGE_TRUSTED_MCP;
 *  - a Landflow or plugin node is admitted by what the platform derives for it (the operation's name, the node's own
 *    `toolAnnotations`: Search Memory and Calculator pass, HTTP Request and Add Memory do not).
 * A tool whose node cannot be found in the run's graph is refused. Pure functions: the node and the save-time check call them.
 */
import type { NodeDescriptor } from '@landflow/protocol';
import type { AgentTool } from '@landflow/engine';
import { deriveToolAnnotations } from '@landflow/protocol';
import { envString } from '../config';

export const TRUSTED_MCP_VARIABLE = 'LANDFLOW_JUDGE_TRUSTED_MCP';
export const MCP_CLIENT_TOOL = 'core.mcpClientTool';

/** A server URL as parsed parts, or undefined for anything that is not a plain http(s) URL without credentials. */
function parts(url: string): { origin: string; path: string } | undefined {
  try {
    const parsed = new URL(url.trim());
    if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || parsed.username || parsed.password) return undefined;
    // `pathname` is already resolved (dot segments, %2e%2e), so /a/../b is /b; a trailing slash is not part of the prefix.
    return { origin: parsed.origin, path: parsed.pathname.replace(/\/+$/, '') };
  } catch {
    return undefined;
  }
}

/** The server URLs an admin trusts for the judge (read at call time): the listed entries as written, matched by `mcpServerTrusted`. */
export const trustedMcpServers = (raw: string | undefined = envString(TRUSTED_MCP_VARIABLE)): string[] => (raw ?? '').split(',').map((entry) => entry.trim()).filter(Boolean);

/**
 * Whether `url` is under one of the listed servers: the same origin (scheme, host, port) exactly, then the listed path as a
 * prefix of the resolved path at a segment boundary. A URL with a username or password, or one that does not parse, is never
 * trusted, and neither is an entry that does not parse.
 */
export function mcpServerTrusted(url: unknown, trusted: readonly string[] = trustedMcpServers()): boolean {
  // An expression is not a URL yet: what it will be is unknown, so it is not trusted.
  if (typeof url !== 'string' || !url.trim() || url.includes('{{') || url.trim().startsWith('=')) return false;
  const target = parts(url);
  if (!target) return false;
  return trusted.some((entry) => {
    const listed = parts(entry);
    return Boolean(listed) && listed!.origin === target.origin && (target.path === listed!.path || target.path.startsWith(`${listed!.path}/`));
  });
}

// ---------------------------------------------------------------------------
// What a call may change: never the tool's own action
// ---------------------------------------------------------------------------

/** The engine offers a node's string, number, boolean and options parameters as "Optional override of …" arguments (tool-schema.ts). */
const OVERRIDE_NOTE = 'Optional override of';
const properties = (tool: Pick<AgentTool, 'inputSchema'>) => (tool.inputSchema.properties ?? {}) as Record<string, { description?: unknown }>;

/** The arguments of a tool that would override one of its node's parameters (`operation`, `resource`, a table name…). */
export const overrideKeys = (tool: Pick<AgentTool, 'inputSchema'>): string[] => Object.entries(properties(tool)).filter(([, p]) => typeof p?.description === 'string' && p.description.startsWith(OVERRIDE_NOTE)).map(([key]) => key);

/** The tool as the judge's model sees it: the same tool without its overrides, so a model is never offered a way to change the action. */
export function judgeSpec(tool: Pick<AgentTool, 'name' | 'description' | 'inputSchema'>): Pick<AgentTool, 'name' | 'description' | 'inputSchema'> {
  const drop = new Set(overrideKeys(tool));
  const kept = Object.fromEntries(Object.entries(properties(tool)).filter(([key]) => !drop.has(key)));
  const required = Array.isArray(tool.inputSchema.required) ? (tool.inputSchema.required as string[]).filter((key) => !drop.has(key)) : undefined;
  return { name: tool.name, description: tool.description, inputSchema: { ...tool.inputSchema, properties: kept as never, ...(required && { required }) } };
}

/**
 * The arguments of a call the judge refuses to run: any override, and, for a tool that declares its arguments, any name it does
 * not declare (the engine would apply any parameter name of the node as an override).
 */
export function disallowedArguments(tool: Pick<AgentTool, 'inputSchema'>, input: Record<string, unknown>): string[] {
  const overrides = new Set(overrideKeys(tool));
  const declared = Object.keys(properties(tool)).filter((key) => !overrides.has(key));
  const strict = overrides.size > 0 || declared.length > 0;
  return Object.keys(input).filter((key) => overrides.has(key) || (strict && !declared.includes(key)));
}

export type Admission = { ok: true } | { ok: false; why: string };

/** The graph node a tool comes from (type, parameters) and its descriptor; `undefined` for either when unknown. */
export interface ToolSource {
  type: string;
  parameters: Record<string, unknown>;
  descriptor?: NodeDescriptor;
}

/** Whether a node of this kind only reads, by what the platform derives for it (never by a model's or a server's word). */
export function nodeReadOnly(descriptor: NodeDescriptor, parameters: Record<string, unknown>): boolean {
  const verb = descriptor.properties.find((p) => p.name === 'operation');
  const value = parameters.operation ?? verb?.default;
  const operation = verb?.options?.find((o) => 'value' in o && o.value === value);
  return deriveToolAnnotations(descriptor, { ...(operation && { operation }) }, descriptor.displayName).readOnlyHint === true;
}

/** May the judge use this tool? `hint` is the tool's own `readOnlyHint` (set by an MCP server's annotation). */
export function admitTool(source: ToolSource | undefined, hint: boolean | undefined, trusted: readonly string[] = trustedMcpServers()): Admission {
  if (!source) return { ok: false, why: 'it is not in this workflow, so it cannot be checked' };
  if (source.type === MCP_CLIENT_TOOL) {
    if (hint !== true) return { ok: false, why: 'its MCP server does not mark it read-only' };
    if (!mcpServerTrusted(source.parameters.endpointUrl, trusted)) return { ok: false, why: `its MCP server is not trusted for the judge: an admin lists it in ${TRUSTED_MCP_VARIABLE}` };
    return { ok: true };
  }
  if (!source.descriptor) return { ok: false, why: 'its node type is unknown' };
  return nodeReadOnly(source.descriptor, source.parameters) ? { ok: true } : { ok: false, why: 'it can change things' };
}
