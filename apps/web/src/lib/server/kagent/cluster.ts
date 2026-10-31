/**
 * A kagent cluster, as a core.kagentApi credential describes it (../nodes/kagent-credential.ts): how to reach its Kubernetes
 * API, the namespace and harness agents go to, the two URLs between Landflow and kagent, and where kagent's nodes pull
 * Claude Code plugins from.
 */
import type { JsonObject } from '@landflow/protocol';
import type { KubeConnection } from './kube';

export const KAGENT_CREDENTIAL = 'core.kagentApi';
export const KAGENT_API = 'api.kagent.dev/v1alpha3';
export const DEFAULT_NAMESPACE = 'kagent';
export const DEFAULT_HARNESS = 'landflow-kagent';

export interface KagentCluster {
  connection: KubeConnection;
  namespace: string;
  harness: string;
  /** kagent's controller as Landflow reaches it (A2A at /agents/<namespace>/<name>). */
  controllerUrl: string;
  /** Landflow as kagent's agents reach it (their MCP server is <landflowUrl>/api/mcp/agents/<id>). */
  landflowUrl: string;
  /** Landflow's registry as kagent's nodes reach it (host:port): Claude Code plugins are pulled from there as images (./oci.ts). */
  pluginRegistry?: string;
  /** EgressPolicies every agent references unless it names its own: what its sandbox may reach beyond Landflow and its model. */
  egressPolicies?: string[];
}

const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
const trimUrl = (value: unknown) => text(value).replace(/\/+$/, '');
/** host:port, from a bare one or a URL. */
const registryOf = (value: unknown) => trimUrl(value).replace(/^https?:\/\//, '');
/** Names from a list or from one string split on commas and new lines. */
export const namesOf = (value: unknown): string[] => [...new Set((Array.isArray(value) ? value.map(String) : text(value).split(/[,\n]/)).map((n) => n.trim()).filter(Boolean))];

export function clusterFrom(data: JsonObject): KagentCluster {
  const server = trimUrl(data.server);
  if (!server) throw new Error('The kagent credential has no Kubernetes API server URL');
  const token = text(data.token);
  if (!token) throw new Error('The kagent credential has no token');
  return {
    connection: {
      server,
      token,
      ...(text(data.caData) && { caData: text(data.caData) }),
      ...(text(data.tlsServerName) && { tlsServerName: text(data.tlsServerName) }),
      ...(data.insecureSkipTlsVerify === true && { insecureSkipTlsVerify: true }),
    },
    namespace: text(data.namespace) || DEFAULT_NAMESPACE,
    harness: text(data.harness) || DEFAULT_HARNESS,
    controllerUrl: trimUrl(data.controllerUrl),
    landflowUrl: trimUrl(data.landflowUrl),
    ...(registryOf(data.pluginRegistry) && { pluginRegistry: registryOf(data.pluginRegistry) }),
    ...(namesOf(data.egressPolicies).length && { egressPolicies: namesOf(data.egressPolicies) }),
  };
}

/** The agent's A2A endpoint on kagent's controller. */
export const a2aUrlOf = (cluster: Pick<KagentCluster, 'controllerUrl' | 'namespace'>, name: string) =>
  cluster.controllerUrl ? `${cluster.controllerUrl}/agents/${encodeURIComponent(cluster.namespace)}/${encodeURIComponent(name)}` : undefined;
