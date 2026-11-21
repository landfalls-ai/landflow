/**
 * Which tools an AI Judge may use (C13, FR-7): only ones that read. Read-only is a claim, so it is checked against who makes it:
 *  - an MCP server says for itself that a tool only reads (`readOnlyHint`), and a server can be wrong or lie. Its tools are
 *    admitted only when the hint is set AND an admin listed the server in LANDFLOW_JUDGE_TRUSTED_MCP;
 *  - a Landflow or plugin node is admitted by what the platform derives for it (the operation's name, the node's own
 *    `toolAnnotations`: Search Memory and Calculator pass, HTTP Request and Add Memory do not).
 * A tool whose node cannot be found in the run's graph is refused. Pure functions: the node and the save-time check call them.
 */
import type { NodeDescriptor } from '@landflow/protocol';
import { deriveToolAnnotations } from '@landflow/protocol';
import { envString } from '../config';

export const TRUSTED_MCP_VARIABLE = 'LANDFLOW_JUDGE_TRUSTED_MCP';
export const MCP_CLIENT_TOOL = 'core.mcpClientTool';

const norm = (url: string) => url.trim().replace(/\/+$/, '').toLowerCase();

/** The server URLs an admin trusts for the judge (read at call time). */
export const trustedMcpServers = (raw: string | undefined = envString(TRUSTED_MCP_VARIABLE)): string[] => (raw ?? '').split(',').map(norm).filter(Boolean);

/** Whether `url` is one of the listed servers, or under a listed one at a path boundary (an origin trusts its paths). */
export function mcpServerTrusted(url: unknown, trusted: readonly string[] = trustedMcpServers()): boolean {
  // An expression is not a URL yet: what it will be is unknown, so it is not trusted.
  if (typeof url !== 'string' || !url.trim() || url.includes('{{') || url.trim().startsWith('=')) return false;
  const target = norm(url);
  return trusted.some((entry) => target === entry || target.startsWith(`${entry}/`));
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
