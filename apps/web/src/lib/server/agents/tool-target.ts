/**
 * What a tool call reached (wave ag3, AG14; docs/run-trace.md "What a tool call reached"): built on the server when the
 * tool is built, from its config and its credential, and made only of non-secret facts (shared/tool-target.ts). The
 * vault's `get()` already leaves a credential's secret fields out; `secretFieldsOf` is checked too, so a made-up type
 * with a secret field named `url` still gives no endpoint. A URL is cut to `host:port`, a file path to its last part.
 */
import type { JsonObject } from '@landflow/protocol';
import { safeEndpoint, type ToolTarget } from '../../shared/tool-target';
import { credentials as vault } from '../credentials/vault';
import { registry } from '../plugins/registry';

type Refs = Record<string, { id: string; name?: string }> | undefined;

/** The fields of a credential that may say where it points, in the order they are read. */
const URL_FIELDS = ['url', 'baseUrl', 'endpoint', 'server'] as const;
const PLACE_FIELDS = ['path', 'database'] as const;

function pluginIdOf(nodeType: string): string {
  return nodeType.split('.')[0] ?? nodeType;
}

/** Where a credential's non-secret fields say it points: a URL, host and port, or a file. */
function endpointOfData(data: Record<string, unknown>, secret: Set<string>, parameters: Record<string, unknown>): string | undefined {
  const field = (name: string) => (secret.has(name) ? undefined : data[name]);
  for (const name of URL_FIELDS) {
    const found = safeEndpoint(field(name));
    if (found) return found;
  }
  const host = safeEndpoint(field('host'), field('port'));
  if (host) return host;
  for (const name of PLACE_FIELDS) {
    const found = safeEndpoint(field(name));
    if (found) return found;
  }
  // The node's own parameters (a URL or a file it was given), when the credential says nothing.
  for (const name of [...URL_FIELDS, 'host', ...PLACE_FIELDS]) {
    const found = safeEndpoint(parameters[name], name === 'host' ? parameters.port : undefined);
    if (found) return found;
  }
  return undefined;
}

/** The plugin that owns a node type and where it answers (its active endpoint), when it is not in the host. */
function pluginOf(nodeType: string): ToolTarget['plugin'] {
  const id = pluginIdOf(nodeType);
  try {
    const summary = registry.list().find((p) => p.id === id);
    const endpoint = summary?.activeEndpoint ? safeEndpoint(summary.activeEndpoint) : undefined;
    return { id, ...(endpoint && { endpoint }) };
  } catch {
    return { id };
  }
}

/** A plugin node's target: its first credential, else the plugin (and the URL or file its parameters name). */
export function targetOfNode(nodeType: string, refs: Refs, parameters: JsonObject | Record<string, unknown> = {}): ToolTarget {
  const ref = refs ? Object.values(refs).find((r) => r?.id) : undefined;
  const credential = ref ? vault.get(ref.id) : undefined;
  if (credential) {
    const secret = new Set(vault.secretFieldsOf(credential.type));
    const info = registry.credentialType(credential.type);
    const endpoint = endpointOfData(credential.data as Record<string, unknown>, secret, parameters);
    return {
      name: credential.name,
      system: info?.descriptor.displayName ?? credential.type,
      ...(endpoint && { endpoint }),
      credentialId: credential.id,
    };
  }
  const plugin = pluginOf(nodeType);
  const endpoint = endpointOfData({}, new Set(), parameters);
  const node = registry.resolve(nodeType);
  const display = 'error' in node ? undefined : node.descriptor.displayName;
  // A node the host runs itself (core.*) has no plugin: it is named by what it is.
  if (pluginIdOf(nodeType) === 'core') return { name: display ?? nodeType, ...(endpoint && { endpoint }) };
  return { name: `${plugin?.id ?? pluginIdOf(nodeType)} plugin`, ...(display && { system: display }), ...(endpoint && { endpoint }), ...(plugin && { plugin }) };
}

export interface KnowledgeTargetInput {
  collection: string;
  store: string;
  embeddings?: { provider?: unknown; model?: unknown };
}

/** A knowledge base's target: the collection, the store, how it searches and how many documents it holds. */
export function targetOfKnowledge(config: KnowledgeTargetInput, documents?: number): ToolTarget {
  const e = config.embeddings;
  const embeddings = !e || String(e.provider) === 'none' ? 'keyword search (BM25, built in)' : `${String(e.provider)}/${String(e.model ?? '')}`;
  const store = config.store === 'sqlite' ? 'SQLite' : config.store === 'pgvector' ? 'PGVector' : config.store === 'memory' ? 'In-memory' : config.store;
  return { name: config.collection, system: 'Knowledge base', knowledge: { collection: config.collection, store, embeddings, ...(documents !== undefined && { documents }) } };
}

export const targetOfWorkflow = (workflowName: string): ToolTarget => ({ name: workflowName, system: 'Workflow' });
export const targetOfAgent = (agentName: string): ToolTarget => ({ name: agentName, system: 'Agent' });

/** An MCP server: its name, and its host from the endpoint URL (never its path, query or headers). */
export function targetOfMcp(name: string, parameters: Record<string, unknown>, refs?: Refs): ToolTarget {
  const base = targetOfNode('core.mcpClientTool', refs, {});
  const endpoint = safeEndpoint(parameters.endpointUrl);
  return { name, system: 'MCP server', ...(endpoint && { endpoint }), ...(base.credentialId && { credentialId: base.credentialId }) };
}

/** A remote A2A agent: its name and host. */
export function targetOfA2a(name: string, parameters: Record<string, unknown>, refs?: Refs): ToolTarget {
  const base = targetOfNode('core.a2aAgent', refs, {});
  const endpoint = safeEndpoint(parameters.agentUrl);
  return { name, system: 'A2A agent', ...(endpoint && { endpoint }), ...(base.credentialId && { credentialId: base.credentialId }) };
}
