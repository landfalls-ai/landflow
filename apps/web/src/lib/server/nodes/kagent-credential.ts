/**
 * The kagent credential (`core.kagentApi`): a kagent 1.0 cluster that Landflow deploys published agents to (docs/a2a.md,
 * "Landflow agents on kagent"). Its Kubernetes API with a ServiceAccount token allowed to write kagent's resources in one
 * namespace, the harness agents run on, kagent's controller as Landflow reaches it (A2A) and Landflow as kagent reaches it
 * (the agents' MCP endpoints), and Landflow's registry as kagent's nodes reach it (Claude Code plugins, ../kagent/oci.ts).
 * deploy/scripts/kagent-up.sh creates one for the local kind cluster.
 */
import { defineCredentialType } from '@landflow/sdk';
import { clusterFrom, DEFAULT_HARNESS, DEFAULT_NAMESPACE, KAGENT_API } from '../kagent/cluster';
import { getObject, listObjects } from '../kagent/kube';

export const kagentCredential = defineCredentialType({
  name: 'kagentApi',
  displayName: 'kagent cluster',
  description:
    'A Kubernetes cluster running kagent 1.0. Landflow writes published agents there (their system prompt, model and tools) with a ServiceAccount token that may manage kagent’s Agents, AgentTemplates, ModelConfigs, RemoteMCPServers and Secrets in the namespace.',
  icon: 'brand:kagent',
  documentationUrl: 'https://kagent.dev/docs',
  properties: [
    { name: 'server', displayName: 'Kubernetes API Server', type: 'string', default: '', required: true, placeholder: 'https://host.docker.internal:6443' },
    { name: 'token', displayName: 'Token', type: 'string', default: '', required: true, typeOptions: { password: true }, description: 'A ServiceAccount token (kubectl create token, or a service-account-token Secret)' },
    { name: 'caData', displayName: 'CA Certificate', type: 'string', default: '', typeOptions: { rows: 4 }, description: 'The cluster’s CA, PEM (kubeconfig’s certificate-authority-data, decoded). Empty: the system CAs' },
    { name: 'tlsServerName', displayName: 'TLS Server Name', type: 'string', default: '', placeholder: 'localhost', description: 'The name to check the API server’s certificate against when the URL’s host isn’t on it (kubeconfig’s tls-server-name)' },
    { name: 'insecureSkipTlsVerify', displayName: 'Skip TLS Verification', type: 'boolean', default: false, description: 'Only for a throwaway local cluster' },
    { name: 'namespace', displayName: 'Namespace', type: 'string', default: DEFAULT_NAMESPACE, description: 'Where agents are written' },
    { name: 'harness', displayName: 'Harness', type: 'string', default: DEFAULT_HARNESS, description: 'The Harness agents run on (kagent’s runtime and Agent Substrate settings)' },
    { name: 'controllerUrl', displayName: 'kagent Controller URL', type: 'string', default: '', placeholder: 'http://kagent-controller.kagent:8083', description: 'kagent’s controller as Landflow reaches it: agents answer A2A at <URL>/agents/<namespace>/<name>' },
    { name: 'landflowUrl', displayName: 'Landflow URL (from kagent)', type: 'string', default: '', required: true, placeholder: 'http://landflow-host.landflow:3000', description: 'This Landflow as kagent’s agents reach it: their tools are served at <URL>/api/mcp/agents/<agent id>' },
    {
      name: 'pluginRegistry',
      displayName: 'Plugin Registry (from kagent’s nodes)',
      type: 'string',
      default: '',
      placeholder: '192.168.194.176:3000',
      description:
        'This Landflow as kagent’s nodes reach it, host:port: they pull agents’ Claude Code plugins from its registry (/v2) as images. A private IP (10.x, 172.16–31.x, 192.168.x) pulls over plain HTTP. Empty: kagent fetches plugins from git, which its sandbox can’t do yet',
    },
    {
      name: 'egressPolicies',
      displayName: 'Egress Policies',
      type: 'string',
      default: '',
      placeholder: 'landflow-dev-packages',
      description:
        'EgressPolicies in the namespace that every agent references unless it names its own, comma-separated: the origins its sandbox may reach beyond Landflow and its model (package registries, a git host). Empty: only those two',
    },
  ],
  async test(data) {
    try {
      const cluster = clusterFrom(data);
      const agents = await listObjects(cluster.connection, KAGENT_API, 'Agent', cluster.namespace);
      const harness = await getObject(cluster.connection, KAGENT_API, 'Harness', cluster.namespace, cluster.harness);
      return {
        ok: true,
        message: `kagent answers in ${cluster.namespace}: ${agents.length} agent${agents.length === 1 ? '' : 's'}${harness ? `, harness ${cluster.harness}` : `; there is no harness “${cluster.harness}” yet`}`,
      };
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
  },
});
