/**
 * Deploying published agents to kagent (docs/a2a.md, "Landflow agents on kagent"). Landflow is the source of the persona:
 * deploying writes the resources of ./manifests.ts with server-side apply, publishing writes them again, and the status
 * reads them back and names every field that differs from what Landflow would write (someone edited the agent in kagent,
 * or a publish couldn't reach it).
 *
 * The agent runs on a Harness of the cluster: the credential's, or one chosen when deploying. Its runtime decides how the
 * resources are written: kagent's own (ADK), or Claude Code (./manifests.ts says what differs). On Claude Code the agent's
 * plugins are resolved from the added marketplaces and pinned to a commit when it is deployed or published (and packed into
 * images Landflow serves, ./oci.ts, when the credential names its registry); the status compares against those pins rather
 * than resolving them again.
 */
import { createHash, randomBytes } from 'node:crypto';
import { KAGENT_RUNTIME_LABELS } from '@landflow/protocol/harnesses';
import type { Agent, AgentConfig, CredentialRef, KagentDeployment, KagentDrift, KagentGuard, KagentHarness, KagentPlugin, KagentRouteStatus, KagentRuntime, KagentStatus } from '../../shared/agents';
import type { KagentSecretRoute } from '../../shared/kagent-routes';
import { ollamaUrl } from '../config';
import { agentStore } from '../agents/store';
import { buildToolset } from '../agents/tools';
import { credentials } from '../credentials/vault';
import { database } from '../db';
import { marketplace } from '../marketplace/service';
import { logger } from '../telemetry';
import { agentTeamStore } from '../agent-teams/store';
import { isTeamMember } from '../notebook/binding';
import { notebookStubs } from '../notebook/tools';
import { memoryStubs } from './memory-tools';
import { a2aUrlOf, clusterFrom, KAGENT_API, KAGENT_CREDENTIAL, type KagentCluster } from './cluster';
import { applyObject, deleteObject, getObject, listObjects, type KubeObject } from './kube';
import { BUILTIN_URL, builtinPin, imageRef, packPlugin } from './oci';
import { AGENT_ID_LABEL, approvalServerName, kagentManifests, kagentName, landflowEgressName, ROUTES_HMAC_ANNOTATION, routeObjects, routesName, secretName, validKagentName, type ExposedTool, type ModelSettings, type ResolvedRoute } from './manifests';
import { recordedRoute, resolveRoutes, routeHmacs, routesHashMatches, routesHmac } from './routes';
import { recordAudit } from '../audit';
import { KagentError } from './errors';
import { homeProjectId } from '../projects/store';
import { blockRuntimeKeys, ensureRuntimeKey, existingRuntimeKey, routeThroughGateway, runtimeKeyBudget } from '../llm-gateway/runtime-keys';

export { KagentError } from './errors';

/** The objects Landflow may write for an agent named `name`, in the order it applies them. */
const objectsOf = (name: string) =>
  [
    ['Secret', secretName(name)],
    ['Secret', routesName(name)],
    ['RemoteMCPServer', name],
    ['RemoteMCPServer', approvalServerName(name)],
    ['ModelConfig', name],
    ['AgentTemplate', name],
    ['EgressPolicy', landflowEgressName(name)],
    ['EgressPolicy', routesName(name)],
    ['Agent', name],
  ] as const;
const apiVersionOf = (kind: string) => (kind === 'Secret' ? 'v1' : KAGENT_API);
const keyOf = (kind: string, name: string) => `${kind}/${name}`;

/** The runtimes Landflow writes agents for. */
const SUPPORTED: KagentRuntime[] = ['kagent', 'claude'];
/** One wording for the runtimes, shared with the kagent card (the registry: packages/protocol/src/harnesses.ts). */
const RUNTIME_LABEL = KAGENT_RUNTIME_LABELS;

/** A Harness's runtime: the one key of its spec that names one. */
function runtimeOf(object: KubeObject): KagentRuntime {
  const spec = (object.spec ?? {}) as Record<string, unknown>;
  return (['claude', 'codex', 'byo', 'kagent'] as const).find((key) => spec[key] !== undefined) ?? 'kagent';
}

/** The Harnesses of the cluster's namespace, the ones Landflow can't write agents for included. */
export async function kagentHarnesses(credential: CredentialRef): Promise<KagentHarness[]> {
  const cluster = await clusterOf(credential);
  const objects = await listObjects(cluster.connection, KAGENT_API, 'Harness', cluster.namespace);
  return objects.map((object) => ({ name: object.metadata.name, runtime: runtimeOf(object) })).sort((a, b) => a.name.localeCompare(b.name));
}

/** The EgressPolicies in a cluster's namespace: what an agent's sandbox may be granted beyond Landflow and its model. */
export async function kagentEgressPolicies(credential: CredentialRef): Promise<Array<{ name: string; origins: string[] }>> {
  const cluster = await clusterOf(credential);
  const objects = await listObjects(cluster.connection, KAGENT_API, 'EgressPolicy', cluster.namespace);
  return objects
    // Not the ones Landflow writes for an agent (its own origin, for the mod's reports).
    .filter((object) => !object.metadata.labels?.[AGENT_ID_LABEL])
    .map((object) => ({ name: object.metadata.name, origins: ((specOf(object).destinations as Array<{ origin?: string }> | undefined) ?? []).flatMap((d) => d.origin ?? []) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** An EgressPolicy that isn't there would leave the agent without the access it asks for: say so before writing. */
async function checkEgressPolicies(cluster: KagentCluster, names: string[]) {
  const found: KubeObject[] = [];
  for (const name of names) {
    const object = await getObject(cluster.connection, KAGENT_API, 'EgressPolicy', cluster.namespace, name);
    if (!object) throw new KagentError(`kagent has no EgressPolicy “${name}” in ${cluster.namespace}`);
    // One Landflow wrote for an agent (its <name>-landflow or <name>-routes) is that agent's: another agent naming it would borrow its credentials.
    if (object.metadata.labels?.[AGENT_ID_LABEL]) throw new KagentError(`The EgressPolicy “${name}” was written by Landflow for an agent: list only policies made by hand`);
    found.push(object);
  }
  return found;
}

/** A host a listed policy already sends a credential to can't also be a route: two credentials for one host is ambiguous (and a route must not override a hand-made one). */
function checkRouteHosts(policies: KubeObject[], routes: ResolvedRoute[]) {
  for (const [index, route] of routes.entries()) {
    for (const host of route.hosts) {
      const clash = policies.find((policy) => ((specOf(policy).destinations as Array<{ origin?: string; authentication?: unknown }> | undefined) ?? []).some((d) => d.origin === host && d.authentication));
      if (clash) throw new KagentError(`Route ${index + 1}: ${host} already gets a credential from the EgressPolicy “${clash.metadata.name}”: remove it from the route or the policy`);
    }
  }
}

async function harnessOf(cluster: KagentCluster, name: string): Promise<KagentHarness> {
  const object = await getObject(cluster.connection, KAGENT_API, 'Harness', cluster.namespace, name);
  if (!object) throw new KagentError(`kagent has no Harness “${name}” in ${cluster.namespace}`);
  const harness = { name, runtime: runtimeOf(object) };
  if (!SUPPORTED.includes(harness.runtime)) throw new KagentError(`The Harness “${name}” runs ${RUNTIME_LABEL[harness.runtime]}, which Landflow doesn’t write agents for: choose one that runs ${RUNTIME_LABEL.kagent} or ${RUNTIME_LABEL.claude}`);
  return harness;
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

async function clusterOf(credential: CredentialRef): Promise<KagentCluster> {
  return clusterFrom(await credentials.dataWithSecrets(credential, KAGENT_CREDENTIAL));
}

export { deployedConfig } from './deployed-config';
import { deployedConfig } from './deployed-config';

/** The tools kagent binds: those the runtime builds from the config, and with cross-session memory on, the three memory tools that take a signed key (./memory-tools.ts). */
export async function kagentTools(agent: Agent, config: AgentConfig) {
  const toolset = await buildToolset({ ...agent, ...config }, config);
  // The runtime's own memory tools need the person the run is for; on kagent the three below take a signed key for that person instead.
  const tools = [...toolset.tools.filter((tool) => tool.kind !== 'memory'), ...(config.memory.crossSession ? memoryStubs() : [])];
  // An agent a team calls as a remote member also serves the team notebook's tools (docs/team-notebook.md): the stubs only
  // name them, kagent/mcp.ts binds a call to the run that is asking the agent.
  const inTeam = agentTeamStore.list().some((team) => [team.draft, team.published].some((c) => c && isTeamMember(agent, c.members)));
  return { tools: inTeam ? [...tools, ...notebookStubs()] : tools, unavailable: toolset.unavailable };
}

const LOOPBACK = /^(localhost|127\.\d+\.\d+\.\d+|\[?::1\]?)$/i;

/** Who an agent's model call goes through, and what that needs: the agent, and whether to mint or only read the key. */
interface GatewayContext {
  agent: Agent;
  /** Deploying mints (or updates) the agent's key; reading the status only looks the minted one up. */
  mint: boolean;
  /** Why the agent calls its model directly (the deploy result lists it), when a gateway is configured but cannot be used. */
  unavailable?: string[];
}

/**
 * Through the LLM gateway (docs/llm-gateway.md, "Agents outside Landflow"): the agent's own virtual key and the gateway as
 * the cluster reaches it. Undefined when the agent calls its model directly (no gateway, no cluster URL, no admin key, or a
 * model the gateway does not serve): everything stays as without a gateway.
 */
async function gatewayModelSettings(config: AgentConfig, runtime: KagentRuntime, context: GatewayContext): Promise<ModelSettings | undefined> {
  const model = config.model;
  if (!model?.model) return undefined;
  const route = await routeThroughGateway(model.model);
  if (!('connection' in route)) {
    if (!route.silent) context.unavailable?.push(`Calls the model directly: ${route.reason}`);
    return undefined;
  }
  const keyRuntime = runtime === 'claude' ? 'claude' : 'kagent';
  const projectId = homeProjectId('agent', context.agent.id);
  const minted = context.mint
    ? await ensureRuntimeKey({ agentId: context.agent.id, runtime: keyRuntime, model: model.model, ...(projectId && { projectId }), ...(runtimeKeyBudget(config.settings) && { budget: runtimeKeyBudget(config.settings) }) })
    : existingRuntimeKey(keyRuntime, context.agent.id);
  if (!minted) return undefined;
  const root = route.connection.clusterUrl!;
  const provider = runtime === 'claude' || model.provider === 'anthropic' ? 'Anthropic' : 'OpenAI';
  return { apiKey: minted.key, baseUrl: provider === 'OpenAI' ? `${root}/v1` : root, gateway: { provider, alias: minted.alias } };
}

/**
 * What the ModelConfig needs beyond the agent's config: the Ollama server as kagent reaches it, an API key. Claude Code
 * speaks only Anthropic's API, which Ollama serves too: kagent needs a key for it, which Ollama ignores.
 */
async function modelSettings(config: AgentConfig, runtime: KagentRuntime, context: GatewayContext): Promise<ModelSettings> {
  const model = config.model;
  if (!model) return {};
  if (runtime === 'claude' && model.provider === 'openai') throw new KagentError('Claude Code runs Anthropic models, or Ollama ones: change the agent’s model, or choose a Harness with kagent’s own runtime');
  const gateway = await gatewayModelSettings(config, runtime, context);
  if (gateway) return gateway;
  if (model.provider === 'ollama') {
    const host = (model.baseUrl?.trim() || ollamaUrl()).replace(/\/+$/, '');
    let hostname = '';
    try {
      hostname = new URL(host).hostname;
    } catch {
      throw new KagentError(`The agent’s Ollama URL “${host}” isn’t a URL`);
    }
    if (LOOPBACK.test(hostname)) {
      throw new KagentError(`The agent’s Ollama server is ${host}, which kagent’s agents can’t reach: set the model’s Ollama URL to an address both reach (host.docker.internal on OrbStack or Docker Desktop)`);
    }
    return { ollamaHost: host, ...(runtime === 'claude' && { apiKey: 'ollama' }) };
  }
  const type = model.provider === 'openai' ? 'core.openAiApi' : 'core.anthropicApi';
  const data = model.credential ? await credentials.dataWithSecrets(model.credential, type) : {};
  const apiKey = (typeof data.apiKey === 'string' ? data.apiKey.trim() : '') || (model.provider === 'anthropic' ? (process.env.ANTHROPIC_API_KEY ?? '').trim() : '');
  if (!apiKey) throw new KagentError(`The agent’s ${model.provider === 'openai' ? 'OpenAI' : 'Anthropic'} model has no API key to give kagent: choose a credential with one`);
  const baseUrl = typeof data.baseUrl === 'string' ? data.baseUrl.trim().replace(/\/+$/, '') : '';
  return { apiKey, ...(baseUrl && { baseUrl }) };
}

/** Where the agent runs: the Harness and, on Claude Code, the plugins at their pinned commits. */
interface Target {
  harness: KagentHarness;
  plugins?: KagentPlugin[];
  egressPolicies?: string[];
  /** Claude Code: the secret routes, resolved, and their keyed hash. */
  routes?: { entries: ResolvedRoute[]; hash: string };
}

async function compile(agent: Agent, config: AgentConfig, version: number, name: string, cluster: KagentCluster, token: string, target: Target, mint = false) {
  const { tools, unavailable } = await kagentTools(agent, config);
  const exposed: ExposedTool[] = tools.map((tool) => ({ name: tool.name, requireApproval: tool.requireApproval }));
  const { harness, plugins, egressPolicies, routes } = target;
  const model = await modelSettings(config, harness.runtime, { agent, mint, unavailable });
  return {
    gateway: model.gateway ? (harness.runtime === 'claude' ? ('claude' as const) : ('kagent' as const)) : undefined,
    objects: kagentManifests({
      agentId: agent.id,
      config,
      version,
      name,
      cluster,
      tools: exposed,
      model,
      token,
      tokenHash: sha256(token),
      harness: harness.name,
      runtime: harness.runtime,
      ...(plugins && { plugins }),
      ...(egressPolicies?.length && { egressPolicies }),
      ...(routes && { routes }),
      landflowEgress: Boolean(plugins?.some((pin) => pin.url === BUILTIN_URL)),
    }),
    unavailable,
  };
}

/**
 * Claude Code: the config's plugins, each resolved from its marketplace and pinned to the commit it is at now, and packed
 * into an image when the cluster pulls plugins from Landflow's registry.
 */
async function pinPlugins(config: AgentConfig, cluster: KagentCluster, guard: KagentGuard = 'enforce'): Promise<KagentPlugin[]> {
  const pins: KagentPlugin[] = [];
  for (const id of config.plugins ?? []) {
    let pin: KagentPlugin;
    try {
      pin = await marketplace.claudePlugin(id);
    } catch (error) {
      throw new KagentError((error as Error).message);
    }
    if (cluster.pluginRegistry) {
      try {
        pin.oci = imageRef(cluster.pluginRegistry, pin, await packPlugin(pin));
      } catch (error) {
        throw new KagentError(`The plugin ${id} couldn’t be packed for kagent: ${(error as Error).message}`, 502);
      }
    }
    pins.push(pin);
  }
  // Landflow's own mod (docs/a2a.md, "The landflow-harness mod"): real usage, tool calls and guardrails, with this agent's
  // guard as its plugin.json default. Only from the registry: kagent can't fetch it from anywhere else.
  const registry = cluster.pluginRegistry;
  const harness = registry ? builtinPin(undefined, guard === 'enforce' ? undefined : { guard }) : undefined;
  if (registry && harness && !pins.some((pin) => pin.id === harness.id)) {
    try {
      harness.oci = imageRef(registry, harness, await packPlugin(harness));
      pins.push(harness);
    } catch (error) {
      logger.warn('kagent: the landflow-harness mod could not be packed; the agent runs without it', { error: (error as Error).message });
    }
  }
  return pins;
}

/** Whether an object kagent holds was written for this agent (or doesn't exist). */
const ours = (object: KubeObject | undefined, agentId: string) => !object || object.metadata.labels?.[AGENT_ID_LABEL] === agentId;

/**
 * Write the published agent to kagent under `name` (default: the last name, else the agent's name as a DNS label). The token
 * kagent calls the agent's tools with is kept across deploys; moving to another name or cluster removes the old resources.
 */
export async function deployToKagent(agentId: string, input: { credential?: CredentialRef; name?: string; harness?: string; egressPolicies?: string[]; guard?: KagentGuard; routes?: KagentSecretRoute[] } = {}): Promise<{ agent: Agent; status: KagentStatus; unavailable: string[] }> {
  const agent = agentStore.get(agentId);
  if (!agent) throw new KagentError('Agent not found', 404);
  if (!agent.published) throw new KagentError('Publish the agent first: kagent runs the published version');
  const credential = input.credential ?? agent.kagent?.credential;
  if (!credential) throw new KagentError('Choose a kagent cluster credential');
  const name = input.name?.trim() || agent.kagent?.name || kagentName(agent.name);
  if (!validKagentName(name)) throw new KagentError(`“${name}” can’t be a kagent name: use lowercase letters, digits and dashes (up to 53), starting and ending with a letter or digit`);
  const cluster = await clusterOf(credential);
  if (!cluster.landflowUrl) throw new KagentError('The kagent credential has no Landflow URL: kagent’s agents need it to reach their tools');

  const existing = await getObject(cluster.connection, KAGENT_API, 'AgentTemplate', cluster.namespace, name);
  if (!ours(existing, agent.id)) {
    const owner = existing?.metadata.labels?.[AGENT_ID_LABEL];
    throw new KagentError(`kagent already has an agent “${name}” in ${cluster.namespace}${owner ? ` written for the Landflow agent ${owner}` : ' that Landflow didn’t write'}: choose another name`, 409);
  }
  const previous = agent.kagent;
  const sameCluster = previous?.credential.id === credential.id;
  const harness = await harnessOf(cluster, input.harness?.trim() || (sameCluster && previous?.harness) || cluster.harness);
  // The mod's guard: the one asked for, else the one deployed last (on any cluster: it is the agent's, not the cluster's).
  const guard: KagentGuard = input.guard ?? previous?.guard ?? 'enforce';
  const plugins = harness.runtime === 'claude' ? await pinPlugins(agent.published.config, cluster, guard) : [];
  // The agent's own list (an empty one: none), else the one deployed last on this cluster, else the cluster's.
  const egressPolicies = input.egressPolicies ?? (sameCluster ? previous?.egressPolicies : undefined) ?? cluster.egressPolicies ?? [];
  const listed = await checkEgressPolicies(cluster, egressPolicies);
  const { resolved: routes, droppedRoutes } = await routesFor(agent.id, harness, input.routes, sameCluster ? previous?.routes : undefined);
  const routesHash = routes.length ? routesHmac(routes) : undefined;
  if (routes.length) {
    checkRouteHosts(listed, routes);
    await checkRouteObjects(cluster, name, agent.id);
  }
  if (previous && (previous.name !== name || !sameCluster)) {
    await removeResources(previous, agent.id).catch((error) => logger.warn('kagent: the old resources could not be removed', { agentId, error: (error as Error).message }));
  }

  let token: string | undefined;
  try {
    token = previous?.token ? credentials.openSecret(previous.token) : undefined;
  } catch {
    token = undefined;
  }
  token ??= `lfk_${randomBytes(24).toString('base64url')}`;
  const version = agent.published.version;
  const { objects, unavailable, gateway } = await compile(agent, agent.published.config, version, name, cluster, token, { harness, plugins, egressPolicies, ...(routesHash && { routes: { entries: routes, hash: routesHash } }) }, true);
  if (droppedRoutes) unavailable.push('its secret routes (they need the Claude Code runtime)');
  const deployment: KagentDeployment = {
    credential,
    name,
    harness: harness.name,
    version,
    deployedAt: new Date().toISOString(),
    token: credentials.sealSecret(token),
    ...(a2aUrlOf(cluster, name) && { a2aUrl: a2aUrlOf(cluster, name) }),
    ...(plugins.length && { plugins }),
    ...(input.egressPolicies !== undefined || egressPolicies.length ? { egressPolicies } : {}),
    ...(routesHash && { routes: routes.map(recordedRoute), routesHash, routesHashes: routeHmacs(routes), routesPolicyHash: routesHash }),
    ...(guard !== 'enforce' && plugins.some((pin) => pin.url === BUILTIN_URL) && { guard }),
    ...(plugins.some((pin) => pin.url === BUILTIN_URL) && { trace: { url: `${cluster.landflowUrl}/api/agent-trace`, ...(a2aUrlOf(cluster, name) && { a2aUrl: a2aUrlOf(cluster, name) }) } }),
  };
  // Saved before kagent reads the objects: it lists the agent's tools from /api/mcp/agents/<id> as soon as they change,
  // and that serves the deployed version's, so saving after would have it list the old version's and keep them.
  const saved = agentStore.setKagent(agent.id, deployment) ?? agent;
  try {
    // A ModelConfig from an earlier deploy stays only while there is a model (publishing needs one, so it always is).
    for (const object of objects) {
      // The routes' policy is not optional: without it the agent would run with a Secret and no way to send it.
      if (object.kind !== 'EgressPolicy' || object.metadata.name === routesName(name)) {
        await applyObject(cluster.connection, object);
        continue;
      }
      try {
        await applyObject(cluster.connection, object);
      } catch (error) {
        // An access Role from before Landflow wrote EgressPolicies (deploy/kind/landflow-access.yaml) only reads them: the agent
        // runs without it, and its mod's reports can't reach Landflow.
        logger.warn('kagent: Landflow’s EgressPolicy could not be written; the agent’s mod can’t report to Landflow', { agentId, name: object.metadata.name, error: (error as Error).message });
        unavailable.push('its run reports and its calls through the gateway (Landflow may not write EgressPolicies in this cluster: apply deploy/kind/landflow-access.yaml again)');
        const spec = objects.find((o) => o.kind === 'Agent')?.spec as { egressPolicyRefs?: Array<{ name: string }> } | undefined;
        if (spec?.egressPolicyRefs) {
          spec.egressPolicyRefs = spec.egressPolicyRefs.filter((ref) => ref.name !== object.metadata.name);
          if (!spec.egressPolicyRefs.length) delete spec.egressPolicyRefs;
        }
      }
    }
    // Routes taken away: both objects go (the Agent stopped naming the policy above). Inside the try: when one can't be
    // deleted the record goes back to the one with routes, so nothing is left behind unrecorded and the next deploy retries.
    if (!routes.length && previous?.routes?.length) {
      await deleteOurs(cluster, 'EgressPolicy', routesName(name), agent.id);
      await deleteOurs(cluster, 'Secret', routesName(name), agent.id);
    }
  } catch (error) {
    // Not written: the deployment stays the one before.
    agentStore.setKagent(agent.id, previous);
    throw error;
  }
  // A key of the runtime the agent left (or of both, when it calls its model directly now) stops; none is ever deleted.
  await blockRuntimeKeys(agent.id, gateway).catch(() => undefined);
  // An approval server from an earlier deploy goes once nothing needs it (no tool waits for approval, or another runtime).
  const approval = approvalServerName(name);
  if (!objects.some((o) => o.metadata.name === approval)) await deleteOurs(cluster, 'RemoteMCPServer', approval, agent.id);
  // So does Landflow's EgressPolicy once the agent has no mod to report (another runtime, or no registry).
  if (!objects.some((o) => o.kind === 'EgressPolicy')) await deleteOurs(cluster, 'EgressPolicy', landflowEgressName(name), agent.id).catch(() => undefined);
  auditRoutes(agent, previous?.routes ?? [], routes.map(recordedRoute));
  // The cluster answers: what deleted agents left on it while it couldn't goes now.
  await removeLeftovers(credential.id).catch(() => undefined);
  logger.info('kagent: agent deployed', { agentId, name, namespace: cluster.namespace, version, harness: harness.name, runtime: harness.runtime, plugins: plugins.length });
  return { agent: saved, status: await kagentStatus(saved), unavailable };
}

/**
 * The routes to write: the request's list, else the one deployed last on this cluster. Only on Claude Code: a request for
 * routes on another runtime is refused, and routes carried over from an earlier deploy are left out (and reported).
 */
async function routesFor(agentId: string, harness: KagentHarness, asked: KagentSecretRoute[] | undefined, kept: KagentSecretRoute[] | undefined) {
  const list = asked ?? kept ?? [];
  if (!list.length) return { resolved: [] as ResolvedRoute[], droppedRoutes: false };
  if (harness.runtime !== 'claude') {
    if (asked?.length) throw new KagentError(`Secret routes need the Claude Code runtime: the Harness “${harness.name}” runs ${RUNTIME_LABEL[harness.runtime]}, whose tools go through Landflow instead`);
    return { resolved: [] as ResolvedRoute[], droppedRoutes: true };
  }
  return { resolved: await resolveRoutes(agentId, list), droppedRoutes: false };
}

/** The routes' Secret and policy must be this agent's, or not exist: another agent's (or a hand-made) object of that name is not overwritten. */
async function checkRouteObjects(cluster: KagentCluster, name: string, agentId: string) {
  for (const kind of ['Secret', 'EgressPolicy']) {
    const object = await getObject(cluster.connection, apiVersionOf(kind), kind, cluster.namespace, routesName(name));
    if (!ours(object, agentId)) throw new KagentError(`kagent already has a ${kind} “${routesName(name)}” in ${cluster.namespace} that Landflow didn’t write for this agent: choose another name`, 409);
  }
}

/** One audit event per route added, changed or removed: the agent, the credential's name, the hosts and the header, never a value. */
function auditRoutes(agent: Agent, before: KagentSecretRoute[], after: KagentSecretRoute[]) {
  const id = (r: KagentSecretRoute) => `${r.credential.id}|${r.header ?? ''}`;
  const sig = (r: KagentSecretRoute) => JSON.stringify([id(r), r.prefix ?? '', [...r.hosts].sort()]);
  // Routes unchanged cancel out; of the rest, one with the same credential and header is a change, the others added or removed
  // (a credential on two routes is matched in order, not collapsed).
  const same = new Map<string, number>();
  for (const r of before) same.set(sig(r), (same.get(sig(r)) ?? 0) + 1);
  const added: KagentSecretRoute[] = [];
  for (const r of after) {
    const left = same.get(sig(r)) ?? 0;
    if (left > 0) same.set(sig(r), left - 1);
    else added.push(r);
  }
  const removed: KagentSecretRoute[] = [];
  for (const r of before) {
    const left = same.get(sig(r)) ?? 0;
    if (left > 0) {
      same.set(sig(r), left - 1);
      removed.push(r);
    }
  }
  const record = (action: string, verb: string, route: KagentSecretRoute) =>
    recordAudit({
      action: `kagent.route.${action}`,
      target: { type: 'agent', id: agent.id, name: agent.name },
      summary: `${verb} a secret route of ${agent.name} to kagent: ${route.credential.name} for ${route.hosts.join(', ')}`,
      details: { agent: agent.name, credential: route.credential.name, credentialId: route.credential.id, hosts: route.hosts, header: route.header ?? '' },
    });
  for (const route of added) {
    const index = removed.findIndex((old) => id(old) === id(route));
    if (index >= 0) {
      removed.splice(index, 1);
      record('changed', 'Changed', route);
    } else record('added', 'Added', route);
  }
  for (const route of removed) record('removed', 'Removed', route);
}

/** Publishing a deployed agent writes the new version to kagent too; a failure is reported, not thrown. */
export async function redeployIfDeployed(agent: Agent): Promise<KagentStatus | { error: string } | undefined> {
  if (!agent.kagent) return undefined;
  try {
    return (await deployToKagent(agent.id)).status;
  } catch (error) {
    logger.warn('kagent: the published version could not be written', { agentId: agent.id, error: (error as Error).message });
    return { error: (error as Error).message };
  }
}

async function deleteOurs(cluster: KagentCluster, kind: string, name: string, agentId: string) {
  const object = await getObject(cluster.connection, apiVersionOf(kind), kind, cluster.namespace, name);
  if (object && ours(object, agentId)) await deleteObject(cluster.connection, apiVersionOf(kind), kind, cluster.namespace, name);
}

async function removeResources(deployment: Pick<KagentDeployment, 'credential' | 'name'>, agentId: string) {
  const cluster = await clusterOf(deployment.credential);
  for (const [kind, name] of [...objectsOf(deployment.name)].reverse()) await deleteOurs(cluster, kind, name, agentId);
}

/** What deleted agents left on a kagent that couldn't be reached then (the `settings` row `kagent.leftovers`). */
interface Leftover {
  credential: CredentialRef;
  name: string;
  agentId: string;
  since: string;
}
const LEFTOVERS_KEY = 'kagent.leftovers';

function leftovers(): Leftover[] {
  try {
    const saved = JSON.parse(database().get<{ value: string }>('SELECT value FROM settings WHERE key = ?', LEFTOVERS_KEY)?.value ?? '[]');
    return Array.isArray(saved) ? (saved as Leftover[]) : [];
  } catch {
    return [];
  }
}
const saveLeftovers = (list: Leftover[]) => database().upsert('settings', { key: LEFTOVERS_KEY, value: JSON.stringify(list) });

/** A deleted agent's resources kagent couldn't take: kept to remove the next time Landflow reaches that cluster. */
export function rememberLeftover(deployment: KagentDeployment, agentId: string) {
  // The cluster can't be reached, the gateway may be: the agent's keys stop now.
  void blockRuntimeKeys(agentId).catch(() => undefined);
  const list = leftovers().filter((l) => !(l.agentId === agentId && l.name === deployment.name && l.credential.id === deployment.credential.id));
  saveLeftovers([...list, { credential: deployment.credential, name: deployment.name, agentId, since: new Date().toISOString() }]);
}

/** Remove what deleted agents left (on the cluster of `credentialId`, or all); what still can't be reached is kept. Returns how many were removed. */
export async function removeLeftovers(credentialId?: string): Promise<number> {
  const list = leftovers();
  if (!list.length) return 0;
  const kept: Leftover[] = [];
  for (const item of list) {
    if (credentialId && item.credential.id !== credentialId) {
      kept.push(item);
      continue;
    }
    try {
      await removeResources(item, item.agentId);
      logger.info('kagent: a deleted agent’s resources removed', { agentId: item.agentId, name: item.name });
    } catch {
      kept.push(item);
    }
  }
  // Read again: an agent deleted meanwhile may have added one.
  const added = leftovers().filter((l) => !list.some((o) => o.agentId === l.agentId && o.name === l.name && o.credential.id === l.credential.id));
  saveLeftovers([...kept, ...added]);
  return list.length - kept.length;
}

/** Delete the agent's resources from kagent and forget the deployment. */
export async function removeFromKagent(agentId: string): Promise<Agent> {
  const agent = agentStore.get(agentId);
  if (!agent) throw new KagentError('Agent not found', 404);
  if (!agent.kagent) return agent;
  // Before the cluster is asked: the keys stop even when kagent can't be reached.
  await blockRuntimeKeys(agent.id).catch(() => undefined);
  await removeResources(agent.kagent, agent.id);
  auditRoutes(agent, agent.kagent.routes ?? [], []);
  logger.info('kagent: agent removed', { agentId, name: agent.kagent.name });
  return agentStore.setKagent(agent.id, undefined) ?? agent;
}

/** Whether `actual` holds everything `expected` does (kagent may add defaults of its own). */
function covers(expected: unknown, actual: unknown): boolean {
  if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length && expected.every((item, i) => covers(item, actual[i]));
  if (expected && typeof expected === 'object') {
    if (!actual || typeof actual !== 'object') return false;
    return Object.entries(expected).every(([key, value]) => covers(value, (actual as Record<string, unknown>)[key]));
  }
  return expected === actual;
}

const show = (value: unknown) => (typeof value === 'string' ? value : value === undefined ? undefined : JSON.stringify(value));
type Spec = Record<string, unknown>;
const specOf = (object: KubeObject | undefined) => (object?.spec ?? {}) as Spec;

function driftOf(expected: KubeObject[], actual: Map<string, KubeObject | undefined>): KagentDrift[] {
  const drift: KagentDrift[] = [];
  const check = (field: string, want: unknown, have: unknown) => {
    if (!covers(want, have)) drift.push({ field, landflow: show(want) ?? '', ...(have !== undefined && { kagent: show(have) }) });
  };
  for (const object of expected) {
    if (object.kind === 'Secret') continue;
    const held = actual.get(keyOf(object.kind, object.metadata.name));
    if (!held) {
      drift.push({ field: object.kind, landflow: `${object.kind} ${object.metadata.name}` });
      continue;
    }
    const want = specOf(object);
    const have = specOf(held);
    if (object.kind === 'AgentTemplate') {
      check('systemPrompt', want.systemPrompt, have.systemPrompt);
      check('description', want.description, have.description);
      check('tools', want.tools, have.tools);
      check('plugins', want.plugins, have.plugins);
      check('modelConfig', want.modelConfig, have.modelConfig);
    } else if (object.kind === 'ModelConfig') check('model', want, have);
    else if (object.kind === 'Agent') {
      check('template', want.template, have.template);
      check('harness', want.harnessRef, have.harnessRef);
      check('egressPolicies', want.egressPolicyRefs ?? [], have.egressPolicyRefs ?? []);
    } else if (object.kind === 'EgressPolicy') {
      const hmac = object.metadata.annotations?.[ROUTES_HMAC_ANNOTATION];
      // The routes' policy: its destinations and the keyed hash it was written with (the Secret itself is never read).
      if (hmac) {
        if (!covers(want.destinations, have.destinations) || held.metadata.annotations?.[ROUTES_HMAC_ANNOTATION] !== hmac) drift.push({ field: 'routes', landflow: show(want.destinations) ?? '', ...(have.destinations !== undefined && { kagent: show(have.destinations) }) });
      } else check('landflowEgress', want.destinations, have.destinations);
    }
    else if (object.kind === 'RemoteMCPServer') check('mcpServer', { url: want.url, headersFrom: want.headersFrom }, { url: have.url, headersFrom: have.headersFrom });
  }
  return drift;
}

function readyOf(object: KubeObject | undefined): KagentStatus['ready'] {
  const conditions = (object?.status as { conditions?: Array<{ type: string; status: string; reason?: string; message?: string }> } | undefined)?.conditions;
  const ready = conditions?.find((c) => c.type === 'Ready');
  return ready && { status: ready.status === 'True', ...(ready.reason && { reason: ready.reason }), ...(ready.message && { message: ready.message }) };
}

/** The deployment, what kagent holds now, and every difference from what Landflow would write from the deployed version. */
export async function kagentStatus(agent: Agent): Promise<KagentStatus> {
  const deployment = agent.kagent;
  if (!deployment) return { deployed: false, inSync: false, drift: [], outdated: false };
  const outdated = Boolean(agent.published && deployment.version !== agent.published.version);
  const base = {
    deployed: true,
    credential: deployment.credential,
    name: deployment.name,
    version: deployment.version,
    deployedAt: deployment.deployedAt,
    outdated,
    ...(deployment.plugins && { plugins: deployment.plugins }),
    ...(deployment.egressPolicies && { egressPolicies: deployment.egressPolicies }),
    ...(deployment.guard && { guard: deployment.guard }),
  };
  try {
    const cluster = await clusterOf(deployment.credential);
    const harness = await harnessOf(cluster, deployment.harness ?? cluster.harness);
    const held = new Map<string, KubeObject | undefined>();
    const kept = objectsOf(deployment.name).filter(([kind]) => kind !== 'Secret');
    await Promise.all(kept.map(async ([kind, name]) => held.set(keyOf(kind, name), await getObject(cluster.connection, KAGENT_API, kind, cluster.namespace, name))));
    const source = deployedConfig(agent);
    const token = deployment.token ? credentials.openSecret(deployment.token) : '';
    // The routes' shape as deployed (no values): the policy is compared with it, and the vault says whether the Secret is behind.
    const routes = deployment.routes?.length && deployment.routesPolicyHash ? { entries: deployment.routes.map((route, i) => shapeOf(route, i)), hash: deployment.routesPolicyHash } : undefined;
    const target = { harness, plugins: deployment.plugins ?? [], egressPolicies: deployment.egressPolicies ?? cluster.egressPolicies ?? [], ...(routes && { routes }) };
    const expected = source ? (await compile(agent, source.config, source.version, deployment.name, cluster, token, target)).objects : [];
    const drift = driftOf(expected, held);
    const routeState = await routesNow(agent.id, deployment);
    if (routeState.pending) drift.push({ field: 'routes', landflow: 'A routed credential changed: the Secret is rewritten within a minute' });
    const template = held.get(keyOf('AgentTemplate', deployment.name));
    const systemPrompt = specOf(template).systemPrompt;
    const ready = readyOf(held.get(keyOf('Agent', deployment.name)));
    return {
      ...base,
      harness,
      namespace: cluster.namespace,
      ...(a2aUrlOf(cluster, deployment.name) && { a2aUrl: a2aUrlOf(cluster, deployment.name) }),
      inSync: !drift.length && !outdated,
      drift,
      ...(routeState.routes && { routes: routeState.routes }),
      ...(typeof systemPrompt === 'string' && { systemPrompt }),
      ...(ready && { ready }),
    };
  } catch (error) {
    return { ...base, inSync: false, drift: [], error: (error as Error).message };
  }
}

/** A deployed route without its value: only what the policy holds, to compare it. */
const shapeOf = (route: KagentSecretRoute, index: number): ResolvedRoute => ({ key: `r${index}`, header: route.header ?? 'Authorization', prefix: route.prefix ?? '', hosts: route.hosts, value: '', credentialId: route.credential.id, credentialName: route.credential.name });

/**
 * The deployed routes against the vault now: each with the reason it can't be sent (a credential deleted, changed type, no
 * longer shared), and whether the vault's values differ from the Secret's (`pending`: the refresh has not rewritten it yet).
 */
async function routesNow(agentId: string, deployment: KagentDeployment): Promise<{ routes?: KagentRouteStatus[]; pending?: boolean; resolved?: ResolvedRoute[] }> {
  if (!deployment.routes?.length) return {};
  try {
    const { routes: resolved, broken } = await resolveRoutes(agentId, deployment.routes, { lenient: true });
    const reasons = new Map(broken.map((b) => [b.index, b.reason]));
    return {
      resolved,
      routes: deployment.routes.map((route, i) => ({ ...route, ...(reasons.has(i) && { broken: `${reasons.get(i)}` }) })),
      pending: !routesHashMatches(resolved, deployment.routesHash),
    };
  } catch (error) {
    // The stored routes no longer pass the rules (a production host rule since): shown broken as a whole.
    return { routes: deployment.routes.map((route) => ({ ...route, broken: (error as Error).message })) };
  }
}

/**
 * The refresh (./route-refresh.ts): when the vault's values differ from the Secret's, rewrite the Secret and nothing else,
 * and keep the new hash. A credential that can't be read now empties its key (the gateway then sends nothing useful) and the
 * route shows as broken. Returns what changed, or undefined when the Secret is current. Never throws for a route's own fault.
 */
export async function refreshRouteSecret(agent: Agent): Promise<{ changed: string[]; broken: string[] } | undefined> {
  const deployment = agent.kagent;
  if (!deployment?.routes?.length) return undefined;
  const { routes: resolved, broken } = await resolveRoutes(agent.id, deployment.routes, { lenient: true });
  if (routesHashMatches(resolved, deployment.routesHash)) return undefined;
  const hash = routesHmac(resolved);
  const hashes = routeHmacs(resolved);
  const cluster = await clusterOf(deployment.credential);
  const secret = routeObjects({ agentId: agent.id, version: deployment.version ?? 0, cluster }, deployment.name, resolved, hash).find((o) => o.kind === 'Secret')!;
  // A deploy that landed since this read writes the routes itself: leave it the Secret.
  if (agentStore.get(agent.id)?.kagent?.deployedAt !== deployment.deployedAt) return undefined;
  await applyObject(cluster.connection, secret);
  // And one that landed while this was writing: its record is not ours to complete.
  const now = agentStore.get(agent.id)?.kagent;
  if (now && now.deployedAt === deployment.deployedAt) agentStore.setKagent(agent.id, { ...now, routesHash: hash, routesHashes: hashes, routesRefreshedAt: new Date().toISOString() });
  else if (now?.routes?.length && now.name === deployment.name && now.credential.id === deployment.credential.id) {
    // Same Secret, a newer deploy: forget the hash, so the next tick compares with the vault again and writes what is right.
    const { routesHash: _hash, routesHashes: _hashes, ...rest } = now;
    agentStore.setKagent(agent.id, rest);
  } else await deleteOurs(cluster, 'Secret', routesName(deployment.name), agent.id);
  const changed = deployment.routes.flatMap((route, i) => (!broken.some((b) => b.index === i) && !routesHashMatches([resolved[i]], deployment.routesHashes?.[i]) ? [route.credential.name] : []));
  return { changed: [...new Set(changed)], broken: broken.map((b) => b.credentialName) };
}
