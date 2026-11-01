/**
 * A published Landflow agent as kagent 1.0 resources (docs/a2a.md, "Landflow agents on kagent"), all named after the
 * deployment and labelled `landflow.dev/agent-id`:
 *
 * - **AgentTemplate**: the persona. `systemPrompt` is ../../shared/persona.ts's, the one the runtime gives the model (without the
 *   run's time and memory notes), `description` the agent's, and one MCP binding per approval setting to the RemoteMCPServer.
 * - **RemoteMCPServer**: the agent's own tools, served by Landflow at /api/mcp/agents/<id> (./mcp.ts): the same tools the
 *   runtime builds, run the same way. The bearer token is in the Secret.
 * - **ModelConfig**: the agent's model (Ollama, OpenAI or Anthropic); an API key goes in the Secret.
 * - **Agent**: the template on the chosen Harness.
 * - **Secret**: `authorization` (the token) and `api-key`.
 *
 * On a Claude Code Harness (`runtime: 'claude'`) three things differ, because of what kagent's Claude runtime takes:
 * - the model is always `Anthropic`, with Ollama as its base URL for an Ollama model (Ollama serves Anthropic's Messages
 *   API) and no temperature;
 * - Claude Code binds a server whole and kagent pauses per server, so the tools that need an approval are on a second
 *   RemoteMCPServer, `<name>-approval` (`?tools=approval`; the first is `?tools=free`);
 * - the agent's Claude Code plugins go in the template's `plugins`: the image Landflow packed at the pinned commit when there
 *   is one (./oci.ts), else the git repository at that commit;
 * - with Landflow's landflow-harness mod among them, an **EgressPolicy** `<name>-landflow` opens Landflow's own origin to the
 *   sandbox, which the Agent references after its other policies: kagent grants an MCP server's origin only to an agent
 *   that binds tools from it, and the mod posts what it sees to /api/agent-trace/:id on every agent.
 *
 * The object kagent holds is compared with these to find drift (./deploy.ts), so every field here is one Landflow owns.
 */
import type { AgentConfig, KagentPlugin, KagentRuntime } from '../../shared/agents';
import { personaPrompt } from '../../shared/persona';
import { KAGENT_API, type KagentCluster } from './cluster';
import type { KubeObject } from './kube';

export const AGENT_ID_LABEL = 'landflow.dev/agent-id';
export const VERSION_ANNOTATION = 'landflow.dev/agent-version';
export const TOKEN_ANNOTATION = 'landflow.dev/token-sha256';
const MANAGED_BY = { 'app.kubernetes.io/managed-by': 'landflow' };
export const MCP_TIMEOUT = '120s';

/** A tool as kagent binds it: its MCP name and whether kagent pauses for a person before it runs. */
export interface ExposedTool {
  name: string;
  requireApproval: boolean;
}

export interface ModelSettings {
  /** Ollama: the server as kagent's agents reach it. */
  ollamaHost?: string;
  /** OpenAI or Anthropic: a base URL other than the provider's. */
  baseUrl?: string;
  /** OpenAI or Anthropic: the key, written to the Secret. */
  apiKey?: string;
}

export interface CompileInput {
  agentId: string;
  config: AgentConfig;
  version: number;
  name: string;
  cluster: Pick<KagentCluster, 'namespace' | 'harness' | 'landflowUrl'>;
  tools: ExposedTool[];
  model?: ModelSettings;
  /** The bearer token kagent calls the MCP endpoint with (only in the Secret; its hash is an annotation). */
  token: string;
  tokenHash: string;
  /** The Harness the Agent runs on (default: the cluster's) and its runtime (default: kagent's own). */
  harness?: string;
  runtime?: KagentRuntime;
  /** Claude Code: the plugins it loads. */
  plugins?: KagentPlugin[];
  /** EgressPolicies the Agent references: origins its sandbox may reach beyond Landflow and its model. */
  egressPolicies?: string[];
  /** Claude Code with the landflow-harness mod: open Landflow's origin to the sandbox, which the mod reports to. */
  landflowEgress?: boolean;
}

/** A DNS label for kagent from an agent's name: `Text formatter` → `text-formatter`. */
export function kagentName(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
    .replace(/-+$/, '');
  return slug || 'landflow-agent';
}

export const validKagentName = (name: string) => /^[a-z0-9]([-a-z0-9]{0,51}[a-z0-9])?$/.test(name);

export const secretName = (name: string) => `${name}-landflow`;
/** The EgressPolicy that lets the sandbox reach Landflow (its mod's reports): the Secret's name, as another kind. */
export const landflowEgressName = (name: string) => `${name}-landflow`;
/** Claude Code: the RemoteMCPServer with the tools kagent pauses on. */
export const approvalServerName = (name: string) => `${name}-approval`;
export const mcpServerPath = (agentId: string) => `/api/mcp/agents/${encodeURIComponent(agentId)}`;

function metadata(input: CompileInput, name: string, annotations: Record<string, string> = {}) {
  return {
    name,
    namespace: input.cluster.namespace,
    labels: { ...MANAGED_BY, [AGENT_ID_LABEL]: input.agentId },
    annotations: { [VERSION_ANNOTATION]: String(input.version), ...annotations },
  };
}

/** The AgentTemplate's tool bindings: the tools that run freely, then those kagent pauses on (either may be absent). */
export function toolBindings(name: string, tools: ExposedTool[]) {
  const server = { kind: 'RemoteMCPServer', name };
  const free = tools.filter((t) => !t.requireApproval).map((t) => t.name);
  const gated = tools.filter((t) => t.requireApproval).map((t) => t.name);
  return [...(free.length ? [{ mcp: { server, tools: free } }] : []), ...(gated.length ? [{ mcp: { server, tools: gated, requireApproval: true } }] : [])];
}

/** Claude Code: each server whole, the one with the tools that need an approval paused on (either may be absent). */
export function claudeToolBindings(name: string, tools: ExposedTool[]) {
  const server = (serverName: string) => ({ kind: 'RemoteMCPServer', name: serverName });
  return [
    ...(tools.some((t) => !t.requireApproval) ? [{ mcp: { server: server(name) } }] : []),
    ...(tools.some((t) => t.requireApproval) ? [{ mcp: { server: server(approvalServerName(name)), requireApproval: true } }] : []),
  ];
}

/** Claude Code: the agent's model as Anthropic's Messages API, which Ollama serves too. kagent takes no other options. */
export function claudeModelSpec(config: AgentConfig, settings: ModelSettings, secret: string): Record<string, unknown> | undefined {
  const model = config.model;
  if (!model?.model) return undefined;
  const baseUrl = model.provider === 'ollama' ? settings.ollamaHost : settings.baseUrl;
  return { provider: 'Anthropic', model: model.model, apiKeySecret: secret, apiKeySecretKey: 'api-key', anthropic: { ...(baseUrl && { baseUrl }) } };
}

/** The ModelConfig spec for the agent's model. */
export function modelSpec(config: AgentConfig, settings: ModelSettings, secret: string): Record<string, unknown> | undefined {
  const model = config.model;
  if (!model?.model) return undefined;
  const temperature = model.temperature === undefined ? undefined : String(model.temperature);
  const key = settings.apiKey ? { apiKeySecret: secret, apiKeySecretKey: 'api-key' } : {};
  switch (model.provider) {
    case 'ollama':
      return { provider: 'Ollama', model: model.model, ollama: { host: settings.ollamaHost ?? '', ...(temperature && { options: { temperature } }) } };
    case 'openai':
      return { provider: 'OpenAI', model: model.model, ...key, openAI: { ...(settings.baseUrl && { baseUrl: settings.baseUrl }), ...(temperature && { temperature }) } };
    case 'anthropic':
      return { provider: 'Anthropic', model: model.model, ...key, anthropic: { ...(settings.baseUrl && { baseUrl: settings.baseUrl }), ...(temperature && { temperature }) } };
  }
}

/** An EgressPolicy origin as kagent's schema takes it (scheme, DNS name, port): none for an IP address or a path. */
const EGRESS_ORIGIN = /^https?:\/\/([a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?\.)*[a-z]([-a-z0-9]{0,61}[a-z0-9])?(:\d{1,5})?$/;
export function egressOrigin(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const origin = new URL(url).origin;
    return EGRESS_ORIGIN.test(origin) ? origin : undefined;
  } catch {
    return undefined;
  }
}

/** A pinned plugin as a template source: its image when Landflow packed one, else its repository at the commit. */
export const pluginSource = (p: KagentPlugin) => ({ source: p.oci ? { oci: p.oci } : { git: { url: p.url, commit: p.commit }, ...(p.path && { path: p.path }) } });

function mcpServer(input: CompileInput, name: string, secret: string, tools?: 'free' | 'approval'): KubeObject {
  return {
    apiVersion: KAGENT_API,
    kind: 'RemoteMCPServer',
    // The token's hash: a new token changes the object, so the controller reads the Secret again.
    metadata: metadata(input, name, { [TOKEN_ANNOTATION]: input.tokenHash }),
    spec: {
      description: `The tools of the Landflow agent “${input.config.name}”${tools === 'approval' ? ' that wait for a person’s approval' : ''}`,
      url: `${input.cluster.landflowUrl}${mcpServerPath(input.agentId)}${tools ? `?tools=${tools}` : ''}`,
      protocol: 'STREAMABLE_HTTP',
      timeout: MCP_TIMEOUT,
      headersFrom: [{ name: 'Authorization', valueFrom: { type: 'Secret', name: secret, key: 'authorization' } }],
    },
  };
}

export function kagentManifests(input: CompileInput): KubeObject[] {
  const { name, config } = input;
  const secret = secretName(name);
  const claude = input.runtime === 'claude';
  const model = (claude ? claudeModelSpec : modelSpec)(config, input.model ?? {}, secret);
  const plugins = claude ? (input.plugins ?? []) : [];
  const landflowOrigin = claude && input.landflowEgress ? egressOrigin(input.cluster.landflowUrl) : undefined;
  const egress = [...(input.egressPolicies ?? []), ...(landflowOrigin ? [landflowEgressName(name)] : [])];
  return [
    {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: metadata(input, secret),
      type: 'Opaque',
      stringData: { authorization: `Bearer ${input.token}`, ...(input.model?.apiKey && { 'api-key': input.model.apiKey }) },
    },
    mcpServer(input, name, secret, claude ? 'free' : undefined),
    ...(claude && input.tools.some((t) => t.requireApproval) ? [mcpServer(input, approvalServerName(name), secret, 'approval')] : []),
    ...(model ? [{ apiVersion: KAGENT_API, kind: 'ModelConfig', metadata: metadata(input, name), spec: model }] : []),
    {
      apiVersion: KAGENT_API,
      kind: 'AgentTemplate',
      metadata: metadata(input, name),
      spec: {
        description: config.description || config.name,
        ...(model && { modelConfig: { name } }),
        systemPrompt: personaPrompt(config),
        tools: (claude ? claudeToolBindings : toolBindings)(name, input.tools),
        ...(plugins.length && { plugins: plugins.map(pluginSource) }),
      },
    },
    ...(landflowOrigin
      ? [{ apiVersion: KAGENT_API, kind: 'EgressPolicy', metadata: metadata(input, landflowEgressName(name)), spec: { destinations: [{ origin: landflowOrigin }] } }]
      : []),
    {
      apiVersion: KAGENT_API,
      kind: 'Agent',
      metadata: metadata(input, name),
      spec: {
        template: { ref: { name } },
        harnessRef: { name: input.harness ?? input.cluster.harness },
        ...(egress.length && { egressPolicyRefs: egress.map((policy) => ({ name: policy })) }),
      },
    },
  ];
}
