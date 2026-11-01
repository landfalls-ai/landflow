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
import type { Agent, AgentConfig, CredentialRef, KagentDeployment, KagentDrift, KagentHarness, KagentPlugin, KagentRuntime, KagentStatus } from '../../shared/agents';
import { OLLAMA_URL } from '../agents/models';
import { agentStore } from '../agents/store';
import { buildToolset } from '../agents/tools';
import { credentials } from '../credentials/vault';
import { database } from '../db';
import { marketplace } from '../marketplace/service';
import { logger } from '../telemetry';
import { agentTeamStore } from '../agent-teams/store';
import { isTeamMember } from '../notebook/binding';
import { notebookStubs } from '../notebook/tools';
import { a2aUrlOf, clusterFrom, KAGENT_API, KAGENT_CREDENTIAL, type KagentCluster } from './cluster';
import { applyObject, deleteObject, getObject, listObjects, type KubeObject } from './kube';
import { BUILTIN_URL, builtinPin, imageRef, packPlugin } from './oci';
import { AGENT_ID_LABEL, approvalServerName, kagentManifests, kagentName, landflowEgressName, secretName, validKagentName, type ExposedTool, type ModelSettings } from './manifests';

export class KagentError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

/** The objects Landflow may write for an agent named `name`, in the order it applies them. */
const objectsOf = (name: string) =>
  [
    ['Secret', secretName(name)],
    ['RemoteMCPServer', name],
    ['RemoteMCPServer', approvalServerName(name)],
    ['ModelConfig', name],
    ['AgentTemplate', name],
    ['EgressPolicy', landflowEgressName(name)],
    ['Agent', name],
  ] as const;
const apiVersionOf = (kind: string) => (kind === 'Secret' ? 'v1' : KAGENT_API);
const keyOf = (kind: string, name: string) => `${kind}/${name}`;

/** The runtimes Landflow writes agents for. */
const SUPPORTED: KagentRuntime[] = ['kagent', 'claude'];
const RUNTIME_LABEL: Record<KagentRuntime, string> = { kagent: 'kagent’s own runtime', claude: 'Claude Code', codex: 'Codex', byo: 'an image of its own' };

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
  for (const name of names) {
    if (!(await getObject(cluster.connection, KAGENT_API, 'EgressPolicy', cluster.namespace, name))) throw new KagentError(`kagent has no EgressPolicy “${name}” in ${cluster.namespace}`);
  }
}

async function harnessOf(cluster: KagentCluster, name: string): Promise<KagentHarness> {
  const object = await getObject(cluster.connection, KAGENT_API, 'Harness', cluster.namespace, name);
  if (!object) throw new KagentError(`kagent has no Harness “${name}” in ${cluster.namespace}`);
  const harness = { name, runtime: runtimeOf(object) };
  if (!SUPPORTED.includes(harness.runtime)) throw new KagentError(`The Harness “${name}” runs ${RUNTIME_LABEL[harness.runtime]}, which Landflow doesn’t write agents for: choose one that runs kagent’s own runtime or Claude Code`);
  return harness;
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

async function clusterOf(credential: CredentialRef): Promise<KagentCluster> {
  return clusterFrom(await credentials.dataWithSecrets(credential, KAGENT_CREDENTIAL));
}

/** The config kagent runs: the deployed version's, else the published one. */
export function deployedConfig(agent: Agent): { config: AgentConfig; version: number } | undefined {
  const version = agent.kagent?.version;
  const found = version !== undefined ? (agent.published?.version === version ? agent.published : agent.history.find((v) => v.version === version)) : undefined;
  const chosen = found ?? agent.published;
  return chosen && { config: chosen.config, version: chosen.version };
}

/** The tools kagent binds: those the runtime builds from the config, without memory (it needs the person the agent talks to). */
export async function kagentTools(agent: Agent, config: AgentConfig) {
  const toolset = await buildToolset({ ...agent, ...config }, config);
  const tools = toolset.tools.filter((tool) => tool.kind !== 'memory');
  // An agent a team calls as a remote member also serves the team notebook's tools (docs/team-notebook.md): the stubs only
  // name them, kagent/mcp.ts binds a call to the run that is asking the agent.
  const inTeam = agentTeamStore.list().some((team) => [team.draft, team.published].some((c) => c && isTeamMember(agent, c.members)));
  return { tools: inTeam ? [...tools, ...notebookStubs()] : tools, unavailable: toolset.unavailable };
}

const LOOPBACK = /^(localhost|127\.\d+\.\d+\.\d+|\[?::1\]?)$/i;

/**
 * What the ModelConfig needs beyond the agent's config: the Ollama server as kagent reaches it, an API key. Claude Code
 * speaks only Anthropic's API, which Ollama serves too: kagent needs a key for it, which Ollama ignores.
 */
async function modelSettings(config: AgentConfig, runtime: KagentRuntime): Promise<ModelSettings> {
  const model = config.model;
  if (!model) return {};
  if (runtime === 'claude' && model.provider === 'openai') throw new KagentError('Claude Code runs Anthropic models, or Ollama ones: change the agent’s model, or choose a Harness with kagent’s own runtime');
  if (model.provider === 'ollama') {
    const host = (model.baseUrl?.trim() || OLLAMA_URL).replace(/\/+$/, '');
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
}

async function compile(agent: Agent, config: AgentConfig, version: number, name: string, cluster: KagentCluster, token: string, target: Target) {
  const { tools, unavailable } = await kagentTools(agent, config);
  const exposed: ExposedTool[] = tools.map((tool) => ({ name: tool.name, requireApproval: tool.requireApproval }));
  const { harness, plugins, egressPolicies } = target;
  return {
    objects: kagentManifests({
      agentId: agent.id,
      config,
      version,
      name,
      cluster,
      tools: exposed,
      model: await modelSettings(config, harness.runtime),
      token,
      tokenHash: sha256(token),
      harness: harness.name,
      runtime: harness.runtime,
      ...(plugins && { plugins }),
      ...(egressPolicies?.length && { egressPolicies }),
      landflowEgress: Boolean(plugins?.some((pin) => pin.url === BUILTIN_URL)),
    }),
    unavailable,
  };
}

/**
 * Claude Code: the config's plugins, each resolved from its marketplace and pinned to the commit it is at now, and packed
 * into an image when the cluster pulls plugins from Landflow's registry.
 */
async function pinPlugins(config: AgentConfig, cluster: KagentCluster): Promise<KagentPlugin[]> {
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
  // Landflow's own mod (docs/a2a.md, "The landflow-harness mod"): real usage, tool calls and guardrails. Only from the
  // registry: kagent can't fetch it from anywhere else.
  const registry = cluster.pluginRegistry;
  const harness = registry ? builtinPin() : undefined;
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
export async function deployToKagent(agentId: string, input: { credential?: CredentialRef; name?: string; harness?: string; egressPolicies?: string[] } = {}): Promise<{ agent: Agent; status: KagentStatus; unavailable: string[] }> {
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
  const plugins = harness.runtime === 'claude' ? await pinPlugins(agent.published.config, cluster) : [];
  // The agent's own list (an empty one: none), else the one deployed last on this cluster, else the cluster's.
  const egressPolicies = input.egressPolicies ?? (sameCluster ? previous?.egressPolicies : undefined) ?? cluster.egressPolicies ?? [];
  await checkEgressPolicies(cluster, egressPolicies);
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
  const { objects, unavailable } = await compile(agent, agent.published.config, version, name, cluster, token, { harness, plugins, egressPolicies });
  // A ModelConfig from an earlier deploy stays only while there is a model (publishing needs one, so it always is).
  for (const object of objects) {
    if (object.kind !== 'EgressPolicy') {
      await applyObject(cluster.connection, object);
      continue;
    }
    try {
      await applyObject(cluster.connection, object);
    } catch (error) {
      // An access Role from before Landflow wrote EgressPolicies (deploy/kind/landflow-access.yaml) only reads them: the agent
      // runs without it, and its mod's reports can't reach Landflow.
      logger.warn('kagent: Landflow’s EgressPolicy could not be written; the agent’s mod can’t report to Landflow', { agentId, name: object.metadata.name, error: (error as Error).message });
      unavailable.push('its run reports (Landflow may not write EgressPolicies in this cluster: apply deploy/kind/landflow-access.yaml again)');
      const spec = objects.find((o) => o.kind === 'Agent')?.spec as { egressPolicyRefs?: Array<{ name: string }> } | undefined;
      if (spec?.egressPolicyRefs) {
        spec.egressPolicyRefs = spec.egressPolicyRefs.filter((ref) => ref.name !== object.metadata.name);
        if (!spec.egressPolicyRefs.length) delete spec.egressPolicyRefs;
      }
    }
  }
  // An approval server from an earlier deploy goes once nothing needs it (no tool waits for approval, or another runtime).
  const approval = approvalServerName(name);
  if (!objects.some((o) => o.metadata.name === approval)) await deleteOurs(cluster, 'RemoteMCPServer', approval, agent.id);
  // So does Landflow's EgressPolicy once the agent has no mod to report (another runtime, or no registry).
  if (!objects.some((o) => o.kind === 'EgressPolicy')) await deleteOurs(cluster, 'EgressPolicy', landflowEgressName(name), agent.id).catch(() => undefined);
  const deployment: KagentDeployment = {
    credential,
    name,
    harness: harness.name,
    version,
    deployedAt: new Date().toISOString(),
    token: credentials.sealSecret(token),
    ...(plugins.length && { plugins }),
    ...(input.egressPolicies !== undefined || egressPolicies.length ? { egressPolicies } : {}),
    ...(plugins.some((pin) => pin.url === BUILTIN_URL) && { trace: { url: `${cluster.landflowUrl}/api/agent-trace`, ...(a2aUrlOf(cluster, name) && { a2aUrl: a2aUrlOf(cluster, name) }) } }),
  };
  const saved = agentStore.setKagent(agent.id, deployment) ?? agent;
  // The cluster answers: what deleted agents left on it while it couldn't goes now.
  await removeLeftovers(credential.id).catch(() => undefined);
  logger.info('kagent: agent deployed', { agentId, name, namespace: cluster.namespace, version, harness: harness.name, runtime: harness.runtime, plugins: plugins.length });
  return { agent: saved, status: await kagentStatus(saved), unavailable };
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
  await removeResources(agent.kagent, agent.id);
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
    } else if (object.kind === 'EgressPolicy') check('landflowEgress', want.destinations, have.destinations);
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
  };
  try {
    const cluster = await clusterOf(deployment.credential);
    const harness = await harnessOf(cluster, deployment.harness ?? cluster.harness);
    const held = new Map<string, KubeObject | undefined>();
    const kept = objectsOf(deployment.name).filter(([kind]) => kind !== 'Secret');
    await Promise.all(kept.map(async ([kind, name]) => held.set(keyOf(kind, name), await getObject(cluster.connection, KAGENT_API, kind, cluster.namespace, name))));
    const source = deployedConfig(agent);
    const token = deployment.token ? credentials.openSecret(deployment.token) : '';
    const target = { harness, plugins: deployment.plugins ?? [], egressPolicies: deployment.egressPolicies ?? cluster.egressPolicies ?? [] };
    const expected = source ? (await compile(agent, source.config, source.version, deployment.name, cluster, token, target)).objects : [];
    const drift = driftOf(expected, held);
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
      ...(typeof systemPrompt === 'string' && { systemPrompt }),
      ...(ready && { ready }),
    };
  } catch (error) {
    return { ...base, inSync: false, drift: [], error: (error as Error).message };
  }
}
