/**
 * AG17: a Run an Agent node follows its agent (docs/agents.md#from-workflows). A saved flow that wired its own chat model,
 * tools or memory into a Run an Agent node (or a Run a Team node, into its lead) moves that wiring into the agent's
 * DRAFT, and the flow is cleaned of it so the bubbles take over: every agent behaves the same in every flow.
 *
 * - `planMoves`: pure; per wired sub-node the outcome (`moved`, `same`, `kept` with why) and the change to the agent's config.
 * - `moveFlowOverrides`: one step per flow: the drafts, then the workflow without the moved sub-nodes (the 412 rule); a failed
 *   save puts every draft back. Rows in `agent_flow_moves` record it (R9); a second call changes nothing (R10).
 * - `startPass`: the host's one-time pass over every saved flow, as each workflow's owner; the editor's open path calls the
 *   same function as the person.
 * - `pendingFor`: what the Run an Agent node adds to a run of the saved graph on the agent's published config (R11).
 * - `movesOf`: the record, read against the agent now.
 *
 * Nothing here publishes an agent or a workflow, and nothing touches a workflow version or a pin: production keeps running
 * what it ran until a person publishes again. Names only, in every answer and row: a credential's secret never appears.
 */
import { nanoid } from 'nanoid';
import type { NodeDescriptor } from '@landflow/protocol';
import type { Workflow, WorkflowConnection, WorkflowNode } from '@landflow/engine';
import { KEEP_WHY, MOVE_NOTE, hasWiredOverrides, type AgentMove, type AgentMoveResult, type BubbleSlot } from '../../shared/agent-bubbles';
import { PIN_PARAM } from '../../shared/agent-versions';
import type { Agent, AgentConfig, AgentModel, AgentToolConfig, CredentialRef, NodeToolConfig, VectorKnowledgeBaseConfig } from '../../shared/agents';
import { writesOutside } from '../../shared/run-check';
import { agentTeamStore } from '../agent-teams/store';
import { getUser, listUsers } from '../auth/users';
import { database, type Database } from '../db';
import { HttpError } from '../errors';
import { isProtectedEnvironment } from '../environments/settings';
import { registry } from '../plugins/registry';
import { canResource, credentialUsableBy, filterVisible, type Actor } from '../projects/access';
import { homeProjectId } from '../projects/store';
import { store } from '../store';
import { logger } from '../telemetry/logger';
import { versionFor } from '../versions';
import { rootOf } from '../../shared/agent-teams';
import { agentStore, configOf } from './store';

const META_KEY = 'agents.flowOverrides.migrated';
const SUB_TYPES: Record<string, BubbleSlot> = { ai_languageModel: 'model', ai_memory: 'memory', ai_tool: 'tool' };

// ---- the plan (pure) ---------------------------------------------------------------------------------------------

/** What the plan reads from the outside world: passed in, so the rules are unit-tested without I/O. */
export interface MoveLookup {
  agent(id: string): Agent | undefined;
  /** The lead agent of a published team (a Run a Team node's `teamId`). */
  teamLead(teamId: string): string | undefined;
  /** The registry's answer for a node type: its descriptor, or why it can't run (unknown, plugin offline). */
  resolve(type: string): { descriptor: NodeDescriptor } | { error: string };
  /** Whether the agent's owner may use the credential (the check the agent page's picker applies). */
  credentialUsable(agentId: string, credentialId: string): boolean;
  canUpdateAgent(agentId: string): boolean;
  /** Every saved flow: the other flows' wiring of the same agents (R3). */
  workflows(): Workflow[];
  /** A protected environment: nothing moves (R7). */
  protectedEnv?: boolean;
}

export interface PlanOptions {
  subNodeIds?: readonly string[];
  resolve?: Readonly<Record<string, 'useEverywhere'>>;
}

type MoveFields = Omit<AgentMove, 'workflowId' | 'workflowName' | 'by' | 'at' | 'state'>;

interface Snapshot {
  nodes: WorkflowNode[];
  connections: WorkflowConnection[];
  moved?: { model?: AgentModel; tool?: AgentToolConfig };
}

export interface PlannedMove {
  move: MoveFields;
  snapshot: Snapshot;
  /** The nodes and edges that leave the flow (empty for a kept item). */
  removeEdges: string[];
  removeNodes: string[];
}

export interface Plan {
  items: PlannedMove[];
  /** The draft of every agent the plan changes, as it would be saved. */
  configs: Map<string, AgentConfig>;
  /** Their drafts before, to put back. */
  before: Map<string, AgentConfig>;
}

const plainId = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '' && !v.trim().startsWith('=') && !v.includes('{{');

/** The agent a node runs: a Run an Agent node's plain `agentId`, a Run a Team node's lead. */
export function boundAgentOf(node: Pick<WorkflowNode, 'type' | 'parameters'>, teamLead: (teamId: string) => string | undefined): string | undefined {
  if (node.type === 'core.messageAgent' && plainId(node.parameters?.agentId)) return node.parameters.agentId.trim();
  if (node.type === 'core.runTeam' && plainId(node.parameters?.teamId)) return teamLead(node.parameters.teamId.trim());
  return undefined;
}

/**
 * The agent whose draft a node's wiring moves into: only a Run an Agent node's. A Run a Team node's wiring stays in the flow and still runs
 * with the lead (run-team.ts has no R11 overlay for moved items yet, so moving it would drop it from runs until the lead is published).
 */
const movableAgentOf = (node: Pick<WorkflowNode, 'type' | 'parameters'>): string | undefined => (node.type === 'core.messageAgent' && plainId(node.parameters?.agentId) ? node.parameters.agentId.trim() : undefined);

const stable = (value: unknown): string => JSON.stringify(value, (_k, v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) : v));
const snake = (name: string): string => name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'tool';
const sameModel = (a?: AgentModel, b?: AgentModel): boolean => Boolean(a && b) && a!.provider === b!.provider && a!.model === b!.model && (a!.baseUrl ?? '') === (b!.baseUrl ?? '') && (a!.credential?.id ?? '') === (b!.credential?.id ?? '');
const refs = (node: Pick<WorkflowNode, 'credentials'>): Array<[string, CredentialRef]> => Object.entries(node.credentials ?? {}).filter(([, ref]) => ref?.id).map(([slot, ref]) => [slot, { id: ref.id, name: ref.name }]);
const credentialIds = (credentials?: Record<string, CredentialRef>): string => stable(Object.fromEntries(Object.entries(credentials ?? {}).map(([slot, ref]) => [slot, ref.id])));
const credentialNames = (credentials?: Record<string, CredentialRef>): string => Object.values(credentials ?? {}).map((ref) => ref.name).join(', ') || 'none';
const pluginOf = (type: string): string => type.split('.')[0] ?? type;

/** A chat model sub-node as the agent's model: its provider from the node type, the model, the credential reference. */
export function modelOfNode(node: WorkflowNode): AgentModel | undefined {
  const model = typeof node.parameters?.model === 'string' ? node.parameters.model.trim() : '';
  if (!model) return undefined;
  const credential = (slot: string) => {
    const ref = node.credentials?.[slot];
    return ref?.id ? { credential: { id: ref.id, name: ref.name } } : {};
  };
  if (node.type === 'core.anthropicChatModel') return { provider: 'anthropic', model, ...credential('anthropicApi') };
  if (node.type === 'core.openAiChatModel') return { provider: 'openai', model, ...credential('openAiApi') };
  if (node.type === 'core.ollamaChatModel') {
    const baseUrl = typeof node.parameters.baseUrl === 'string' ? node.parameters.baseUrl.trim() : '';
    return { provider: 'ollama', model, ...(baseUrl && { baseUrl }) };
  }
  return undefined;
}

const VECTOR_STORES: Record<string, VectorKnowledgeBaseConfig['store']> = { 'core.vectorStoreInMemory': 'memory', 'core.vectorStoreSqlite': 'sqlite', 'core.vectorStorePGVector': 'pgvector' };

function embeddingsOfNode(node: WorkflowNode): VectorKnowledgeBaseConfig['embeddings'] | undefined {
  const options = (node.parameters?.options ?? {}) as { dimensions?: number; queryPrefix?: string };
  const extras = { ...(options.queryPrefix && { queryPrefix: options.queryPrefix }), ...(Number(options.dimensions) > 0 && { dimensions: Number(options.dimensions) }) };
  if (node.type === 'core.embeddingsOllama') {
    const baseUrl = typeof node.parameters.baseUrl === 'string' ? node.parameters.baseUrl.trim() : '';
    return { provider: 'ollama', model: String(node.parameters.model || 'nomic-embed-text'), ...(baseUrl && { baseUrl }), ...extras };
  }
  if (node.type === 'core.embeddingsOpenAi') {
    const ref = node.credentials?.openAiApi;
    return { provider: 'openai', model: String(node.parameters.model || 'text-embedding-3-small'), ...(ref?.id && { credential: { id: ref.id, name: ref.name } }), ...extras };
  }
  return undefined;
}

/** The models other bound nodes of the saved flows wire into `agentId`, and how many other workflows run it. */
function otherWiring(lookup: MoveLookup, agentId: string, workflowId: string, nodeId: string): { models: Array<{ workflow: string; model: AgentModel }>; others: number } {
  const models: Array<{ workflow: string; model: AgentModel }> = [];
  const workflows = new Set<string>();
  for (const flow of lookup.workflows()) {
    for (const node of flow.nodes) {
      if (boundAgentOf(node, lookup.teamLead) !== agentId) continue;
      if (flow.id !== workflowId) workflows.add(flow.id);
      if (flow.id === workflowId && node.id === nodeId) continue;
      for (const c of flow.connections) {
        if (c.target !== node.id || c.type !== 'ai_languageModel') continue;
        const sub = flow.nodes.find((n) => n.id === c.source);
        const model = sub && !sub.disabled ? modelOfNode(sub) : undefined;
        if (model) models.push({ workflow: flow.name, model });
      }
    }
  }
  return { models, others: workflows.size };
}

/** What each wired sub-node of the workflow's bound nodes would do (R1–R7), over working copies of the agents' drafts. */
export function planMoves(workflow: Workflow, lookup: MoveLookup, options: PlanOptions = {}): Plan {
  const working = new Map<string, AgentConfig>();
  const before = new Map<string, AgentConfig>();
  const changed = new Set<string>();
  const draftOf = (agent: Agent): AgentConfig => {
    let config = working.get(agent.id);
    if (!config) {
      config = structuredClone(configOf(agent));
      working.set(agent.id, config);
      before.set(agent.id, structuredClone(config));
    }
    return config;
  };
  const items: PlannedMove[] = [];
  const nodeById = new Map(workflow.nodes.map((n) => [n.id, n]));
  const used = new Set<string>();

  for (const node of workflow.nodes) {
    const agentId = movableAgentOf(node);
    const agent = agentId ? lookup.agent(agentId) : undefined;
    if (!agentId || !agent) continue;
    const edges = workflow.connections.filter((c) => c.target === node.id && SUB_TYPES[c.type]);
    // A model first, so a tool's pass sees the draft as the model's left it.
    edges.sort((a, b) => ['ai_languageModel', 'ai_tool', 'ai_memory'].indexOf(a.type) - ['ai_languageModel', 'ai_tool', 'ai_memory'].indexOf(b.type));
    for (const edge of edges) {
      const sub = nodeById.get(edge.source);
      if (!sub || sub.disabled) continue;
      if (options.subNodeIds && !options.subNodeIds.includes(sub.id)) continue;
      const slot = SUB_TYPES[edge.type]!;
      const rowKey = used.has(sub.id) ? `${sub.id}@${node.id}` : sub.id;
      used.add(sub.id);
      const base = { nodeId: node.id, subNodeId: rowKey, name: sub.name, slot, agentId, agentName: agent.name } as const;
      const snapshot: Snapshot = { nodes: [structuredClone(sub)], connections: [structuredClone(edge)] };
      const keep = (why: string, extra: { retry?: boolean; resolvable?: 'useEverywhere' } = {}): void => {
        items.push({ move: { ...base, outcome: 'kept', why, ...(extra.retry && { retry: true }), ...(extra.resolvable && { resolvable: extra.resolvable }) }, snapshot, removeEdges: [], removeNodes: [] });
      };
      const take = (move: Partial<MoveFields> & Pick<MoveFields, 'outcome'>, extraNodes: WorkflowNode[] = [], extraEdges: WorkflowConnection[] = []): void => {
        snapshot.nodes.push(...extraNodes.map((n) => structuredClone(n)));
        snapshot.connections.push(...extraEdges.map((c) => structuredClone(c)));
        items.push({ move: { ...base, ...move }, snapshot, removeEdges: [edge.id, ...extraEdges.map((c) => c.id)], removeNodes: [sub.id, ...extraNodes.map((n) => n.id)] });
      };
      const forced = options.resolve?.[sub.id] === 'useEverywhere' || options.resolve?.[rowKey] === 'useEverywhere';

      if (slot === 'memory') {
        keep(KEEP_WHY.memory);
        continue;
      }
      if (lookup.protectedEnv) {
        keep(KEEP_WHY.protectedEnv);
        continue;
      }
      if (!lookup.canUpdateAgent(agentId)) {
        keep(KEEP_WHY.access(agent.name), { retry: true });
        continue;
      }
      const config = draftOf(agent);

      // ---- a chat model (R3)
      if (slot === 'model') {
        const model = modelOfNode(sub);
        if (!model) {
          keep(KEEP_WHY.notATool);
          continue;
        }
        const denied = model.credential && !lookup.credentialUsable(agentId, model.credential.id) ? model.credential.name : undefined;
        if (sameModel(config.model, model)) {
          take({ outcome: 'same', as: 'model' });
          snapshot.moved = { model };
          continue;
        }
        if (denied) {
          keep(KEEP_WHY.credentialAccess(denied), { retry: true });
          continue;
        }
        const { models, others } = otherWiring(lookup, agentId, workflow.id, node.id);
        const conflicting = models.filter((m) => !sameModel(m.model, model));
        const published = lookup.agent(agentId)?.published?.config.model;
        const draftMoved = !sameModel(config.model, published) && !(config.model === undefined && published === undefined);
        const resolvable = { resolvable: 'useEverywhere' } as const;
        if (!forced && conflicting.length) {
          keep(KEEP_WHY.modelConflict(conflicting.map((m) => `${m.model.model} in ${m.workflow}`).join(', ')), resolvable);
          continue;
        }
        if (!forced && draftMoved) {
          keep(KEEP_WHY.draftModel(config.model?.model ?? 'none'), resolvable);
          continue;
        }
        config.model = model;
        changed.add(agentId);
        take({ outcome: 'moved', as: 'model', ...(others && { why: MOVE_NOTE.everywhere(others) }) });
        snapshot.moved = { model };
        continue;
      }

      // ---- a tool: a node tool, or a vector store searched as a tool (R5)
      const resolved = lookup.resolve(sub.type);
      if ('error' in resolved) {
        keep(KEEP_WHY.pluginOffline(pluginOf(sub.type)), { retry: true });
        continue;
      }
      const denied = refs(sub).find(([, ref]) => !lookup.credentialUsable(agentId, ref.id))?.[1].name;
      const store = VECTOR_STORES[sub.type];
      const credentials = Object.fromEntries(refs(sub));
      const names = () => new Set(config.tools.flatMap((t) => ('name' in t && typeof t.name === 'string' ? [snake(t.name)] : [])));
      const unique = (wanted: string): { name: string; renamed: boolean } => {
        const taken = names();
        let name = wanted;
        for (let n = 2; taken.has(name); n++) name = `${wanted}_${n}`;
        return { name, renamed: name !== wanted };
      };

      if (store) {
        const params = sub.parameters ?? {};
        const options2 = (params.options ?? {}) as { searchMode?: string };
        const embeddingsEdge = workflow.connections.find((c) => c.target === sub.id && c.type === 'ai_embedding');
        const embeddingsNode = embeddingsEdge && nodeById.get(embeddingsEdge.source);
        const embeddings = embeddingsNode && embeddingsOfNode(embeddingsNode);
        const collection = String(params.collection ?? '').trim();
        if (String(params.mode ?? 'insert') !== 'retrieve-as-tool' || !embeddings || !embeddingsNode || !collection || params.useReranker) {
          keep(KEEP_WHY.notATool);
          continue;
        }
        const existing = config.tools.find((t): t is VectorKnowledgeBaseConfig => t.type === 'knowledge' && t.source !== 'node' && t.store === store && t.collection === collection);
        // Sub-nodes wired only into the moved one (its embeddings) leave with it.
        const alone = workflow.connections.filter((c) => c.source === embeddingsNode.id).every((c) => c.target === sub.id);
        const extraNodes = alone ? [embeddingsNode] : [];
        const extraEdges = alone ? workflow.connections.filter((c) => c.source === embeddingsNode.id) : [];
        if (existing) {
          take({ outcome: 'same', as: 'knowledge', agentToolId: existing.id }, extraNodes, extraEdges);
          continue;
        }
        const embeddingCredential = embeddings.credential ? [embeddings.credential] : [];
        const blocked = [...refs(sub).map(([, r]) => r), ...embeddingCredential].find((ref) => !lookup.credentialUsable(agentId, ref.id));
        if (blocked) {
          keep(KEEP_WHY.credentialAccess(blocked.name), { retry: true });
          continue;
        }
        const named = unique(snake(String(params.toolName || sub.name)));
        const tool: VectorKnowledgeBaseConfig = {
          id: `tool_${nanoid(8)}`,
          type: 'knowledge',
          source: 'vector',
          name: named.name,
          description: String(params.toolDescription || `Search the “${collection}” knowledge base`),
          store,
          collection,
          ...(credentials.postgres && { credential: credentials.postgres }),
          ...(store === 'pgvector' && params.tableName ? { tableName: String(params.tableName) } : {}),
          embeddings,
          ...(Number(params.topK) > 0 && { topK: Number(params.topK) }),
          ...(options2.searchMode === 'hybrid' && { searchMode: 'hybrid' as const }),
          requireApproval: false,
        };
        config.tools.push(tool);
        changed.add(agentId);
        take({ outcome: 'moved', as: 'knowledge', agentToolId: tool.id, ...(named.renamed && { why: MOVE_NOTE.renamed(named.name) }) }, extraNodes, extraEdges);
        snapshot.moved = { tool };
        continue;
      }

      const descriptor = resolved.descriptor;
      if (!descriptor.usableAsTool || (descriptor.kind === 'subnode' || (Array.isArray(descriptor.kind) && descriptor.kind.includes('subnode')))) {
        keep(KEEP_WHY.notATool);
        continue;
      }
      const parameters = structuredClone(sub.parameters ?? {}) as Record<string, unknown>;
      const same = config.tools.find((t) => t.type === 'node' && t.nodeType === sub.type && stable(t.parameters) === stable(parameters)) as NodeToolConfig | undefined;
      if (same) {
        const ours = credentialIds(credentials);
        if (credentialIds(same.credentials) === ours) {
          take({ outcome: 'same', as: 'tool', agentToolId: same.id });
          continue;
        }
        if (!forced) {
          keep(KEEP_WHY.credentialConflict(credentialNames(same.credentials), credentialNames(credentials)), { resolvable: 'useEverywhere' });
          continue;
        }
        if (denied) {
          keep(KEEP_WHY.credentialAccess(denied), { retry: true });
          continue;
        }
        if (Object.keys(credentials).length) same.credentials = credentials;
        else delete same.credentials;
        changed.add(agentId);
        take({ outcome: 'moved', as: 'tool', agentToolId: same.id });
        snapshot.moved = { tool: structuredClone(same) };
        continue;
      }
      if (denied) {
        keep(KEEP_WHY.credentialAccess(denied), { retry: true });
        continue;
      }
      const named = unique(snake(sub.name));
      const writes = writesOutside({ type: sub.type, parameters });
      const tool: NodeToolConfig = {
        id: `tool_${nanoid(8)}`,
        type: 'node',
        name: named.name,
        description: sub.notes?.trim() || descriptor.toolDescription || descriptor.description || sub.name,
        nodeType: sub.type,
        parameters,
        ...(Object.keys(credentials).length && { credentials }),
        requireApproval: false,
      };
      config.tools.push(tool);
      // Wave ag4 carryover (the live pass's E1): instructions that list the agent's jobs ("hand over when the request is
      // outside decoding, hashing or UUIDs") made it refuse the moved Slugify; one line says the tool is its job now too.
      if (typeof config.instructions === 'string' && !config.instructions.includes(named.name)) config.instructions = `${config.instructions.trimEnd()}\n${movedToolLine(named.name, tool.description)}`;
      changed.add(agentId);
      const notes = [named.renamed && MOVE_NOTE.renamed(named.name), writes && MOVE_NOTE.noAsk].filter(Boolean).join('; ');
      take({ outcome: 'moved', as: 'tool', agentToolId: tool.id, ...(notes && { why: notes }) });
      snapshot.moved = { tool };
    }
  }
  return { items, configs: new Map([...working].filter(([id]) => changed.has(id))), before: new Map([...before].filter(([id]) => changed.has(id))) };
}

/** The instructions' line for a tool moved in from a workflow: the agent uses it for what it does, not only its first jobs. */
export function movedToolLine(name: string, description: string): string {
  return `Also your job: ${name} (${description.replace(/\s+/g, ' ').trim().replace(/[.\s]+$/, '')}), moved in from a workflow that ran it: use it when a message asks for that.`;
}

// ---- the rows (R9, R10) ------------------------------------------------------------------------------------------

interface Row {
  id: string;
  workflow_id: string;
  node_id: string;
  sub_node_id: string;
  sub_node_name: string;
  slot: string;
  agent_id: string;
  outcome: string;
  moved_as: string | null;
  agent_tool_id: string | null;
  why: string | null;
  retry: number;
  resolvable: string | null;
  snapshot: string;
  version_before: string | null;
  moved_by: string;
  at: string;
  updated_at: string;
}

const COLUMNS = 'id, workflow_id, node_id, sub_node_id, sub_node_name, slot, agent_id, outcome, moved_as, agent_tool_id, why, retry, resolvable, snapshot, version_before, moved_by, at, updated_at';

function moveOfRow(row: Row, workflowName?: string): AgentMove {
  const agent = agentStore.get(row.agent_id);
  const subNodeId = row.sub_node_id;
  return {
    workflowId: row.workflow_id,
    ...(workflowName && { workflowName }),
    nodeId: row.node_id,
    subNodeId: subNodeId.split('@')[0]!,
    name: row.sub_node_name,
    slot: row.slot as BubbleSlot,
    agentId: row.agent_id,
    agentName: agent?.name ?? row.agent_id,
    outcome: row.outcome as AgentMove['outcome'],
    ...(row.moved_as && { as: row.moved_as as AgentMove['as'] }),
    ...(row.agent_tool_id && { agentToolId: row.agent_tool_id }),
    ...(row.why && { why: row.why }),
    ...(row.retry && { retry: true }),
    ...(row.resolvable === 'useEverywhere' && { resolvable: 'useEverywhere' as const }),
    by: row.moved_by,
    at: row.at,
    ...(row.outcome === 'moved' && agent && { state: stateOf(row, agent) }),
  };
}

/** `pending` (in the draft, not published), `live` (published) or `withdrawn` (a person took it out of the draft), read against the agent now. */
function stateOf(row: Row, agent: Agent): 'pending' | 'live' | 'withdrawn' {
  const moved = (JSON.parse(row.snapshot) as Snapshot).moved;
  if (row.moved_as === 'model') {
    if (!sameModel(agent.model, moved?.model)) return 'withdrawn';
    return sameModel(agent.published?.config.model, moved?.model) ? 'live' : 'pending';
  }
  const inDraft = agent.tools.some((t) => t.id === row.agent_tool_id);
  if (!inDraft) return 'withdrawn';
  return agent.published?.config.tools.some((t) => t.id === row.agent_tool_id) ? 'live' : 'pending';
}

// ---- moving a flow (R8) ------------------------------------------------------------------------------------------

export interface MoveOptions {
  /** `migration` (the start pass) or the person's id. */
  by: string;
  /** The `updatedAt` the caller loaded: a stored one that differs is a 412. */
  updatedAt?: string;
  subNodeIds?: readonly string[];
  resolve?: Readonly<Record<string, 'useEverywhere'>>;
  dryRun?: boolean;
}

/** 412: the caller's copy is not the stored one (the same answer `PUT /api/workflows/:id` gives; route files export nothing else). */
class MoveConflictError extends HttpError {
  static readonly errorName: string = 'MoveConflictError';
  constructor(current: Workflow) {
    super('This workflow changed since you opened it', 412, { code: 'workflow_conflict', details: { current: { updatedAt: current.updatedAt, ...(current.updatedBy && { updatedBy: current.updatedBy }) } } });
  }
}

export function liveLookup(actor: Actor): MoveLookup {
  return {
    agent: (id) => agentStore.get(id),
    teamLead: (teamId) => {
      const team = agentTeamStore.get(teamId);
      const lead = team && rootOf(team.published ?? team.draft);
      return lead?.kind === 'agent' ? lead.agentId : undefined;
    },
    resolve: (type) => registry.resolve(type),
    credentialUsable: (agentId, credentialId) => credentialUsableBy(credentialId, homeProjectId('agent', agentId)),
    canUpdateAgent: (agentId) => canResource(actor, 'agent', agentId, 'update'),
    workflows: () => store.listWorkflows(),
    protectedEnv: isProtectedEnvironment(),
  };
}

const rowOf = (workflowId: string, item: PlannedMove, by: string, at: string, versionBefore: string | undefined): Row => ({
  id: `${workflowId}:${item.move.subNodeId}`,
  workflow_id: workflowId,
  node_id: item.move.nodeId,
  sub_node_id: item.move.subNodeId,
  sub_node_name: item.move.name,
  slot: item.move.slot,
  agent_id: item.move.agentId,
  outcome: item.move.outcome,
  moved_as: item.move.as ?? null,
  agent_tool_id: item.move.agentToolId ?? null,
  why: item.move.why ?? null,
  retry: item.move.retry ? 1 : 0,
  resolvable: item.move.resolvable ?? null,
  snapshot: JSON.stringify(item.snapshot),
  version_before: versionBefore ?? null,
  moved_by: by,
  at,
  updated_at: at,
});

/**
 * Move every movable wired sub-node of a flow's bound nodes into the agents' drafts and save the flow without them, in one step.
 * The caller needs update access to the workflow (an agent it can't update keeps its items, `KEEP_WHY.access`).
 */
export function moveFlowOverrides(workflowId: string, actor: Actor, options: MoveOptions, lookup: MoveLookup = liveLookup(actor), db: Database = database()): AgentMoveResult {
  const workflow = store.getWorkflow(workflowId);
  if (!workflow) throw new HttpError('Workflow not found', 404);
  if (!canResource(actor, 'workflow', workflowId, 'update')) throw new HttpError('You can view this workflow but not change it', 403);
  if (options.updatedAt && workflow.updatedAt && options.updatedAt !== workflow.updatedAt) throw new MoveConflictError(workflow);

  const plan = planMoves(workflow, lookup, { ...(options.subNodeIds && { subNodeIds: options.subNodeIds }), ...(options.resolve && { resolve: options.resolve }) });
  const empty: AgentMoveResult = { workflowId, moved: [], kept: [], agents: [], ...(options.dryRun && { dryRun: true }) };
  if (!plan.items.length) return empty;
  const at = new Date().toISOString();
  const versionBefore = versionFor(workflow)?.id;
  let items = plan.items;
  let saved: Workflow | undefined;
  const writes = items.some((i) => i.move.outcome !== 'kept');

  if (writes && !options.dryRun) {
    // Everything from here to the save runs without an await: no concurrent edit of a draft is overwritten.
    const written: string[] = [];
    try {
      for (const [id, config] of plan.configs) {
        if (!agentStore.saveDraft(id, config)) throw new Error(`The agent ${id} is gone`);
        written.push(id);
      }
      const dropEdges = new Set(items.flatMap((i) => i.removeEdges));
      const candidates = new Set(items.flatMap((i) => i.removeNodes));
      const connections = workflow.connections.filter((c) => !dropEdges.has(c.id));
      const nodes = workflow.nodes.filter((n) => !(candidates.has(n.id) && !connections.some((c) => c.source === n.id)));
      saved = store.saveWorkflow({ ...workflow, nodes, connections }, { actor: actor.id });
    } catch (error) {
      for (const id of written) {
        const config = plan.before.get(id);
        if (config) agentStore.saveDraft(id, config);
      }
      logger.warn('moving a flow’s wiring into its agents failed; the drafts were put back', { 'landflow.workflow.id': workflowId, error: error instanceof Error ? error.message : String(error) });
      items = items.map((i) => (i.move.outcome === 'kept' ? i : { move: { ...i.move, outcome: 'kept' as const, why: KEEP_WHY.saved, retry: true }, snapshot: i.snapshot, removeEdges: [], removeNodes: [] }));
      saved = undefined;
    }
  }

  // The rows: a changed or new one is written; one that says what it said stays untouched (R10).
  const moves: AgentMove[] = [];
  const dry = Boolean(options.dryRun);
  for (const item of items) {
    const id = `${workflowId}:${item.move.subNodeId}`;
    const previous = db.get<Row>(`SELECT ${COLUMNS} FROM agent_flow_moves WHERE id = ?`, id);
    const next = rowOf(workflowId, item, options.by, at, versionBefore);
    const unchanged = previous && item.move.outcome === 'kept' && previous.outcome === 'kept' && previous.why === next.why && previous.retry === next.retry && previous.resolvable === next.resolvable && previous.agent_id === next.agent_id;
    if (unchanged) {
      moves.push(moveOfRow(previous, workflow.name));
      continue;
    }
    if (!dry) db.upsert('agent_flow_moves', next as never);
    moves.push(moveOfRow(next, workflow.name));
  }
  const agents = saved || dry
    ? [...plan.configs].flatMap(([id, planned]) => {
        const agent = agentStore.get(id);
        if (!agent) return [];
        const draft = saved ? configOf(agent) : planned;
        return [{ id, name: agent.name, draftDiffers: JSON.stringify(draft) !== JSON.stringify(agent.published ? configOf(agent.published.config) : null) }];
      })
    : [];
  return {
    workflowId,
    moved: moves.filter((m) => m.outcome !== 'kept'),
    kept: moves.filter((m) => m.outcome === 'kept'),
    agents,
    ...(saved?.updatedAt && { updatedAt: saved.updatedAt }),
    ...(dry && { dryRun: true }),
  };
}

// ---- the host's start pass ---------------------------------------------------------------------------------------

/** The one who owns a workflow, for the start pass: its creator, else the instance owner. */
function ownerOf(workflow: Workflow): Actor | undefined {
  const creator = workflow.createdBy ? getUser(workflow.createdBy) : undefined;
  return creator ?? listUsers().find((u) => u.role === 'owner');
}

/**
 * The one-time migration, and the sweep of later starts: every saved flow that still wires sub-nodes into a bound node, moved as its
 * owner. Leader only (the service table says so). Never rejects: any failure is logged. `meta` remembers a first complete pass.
 */
export async function startPass(db: Database = database()): Promise<number> {
  let moved = 0;
  try {
    const lookupFor = (actor: Actor) => liveLookup(actor);
    const flows = store.listWorkflows().filter((w) => hasWiredOverrides(w) && w.nodes.some((n) => movableAgentOf(n)));
    // Grouped by agent, so the order of flows never matters (a model two flows disagree on is kept in both, whoever goes first).
    const keyOf = (w: Workflow) => w.nodes.map((n) => movableAgentOf(n)).find(Boolean) ?? '';
    flows.sort((a, b) => keyOf(a).localeCompare(keyOf(b)) || a.id.localeCompare(b.id));
    let complete = true;
    for (const flow of flows) {
      try {
        const owner = ownerOf(flow);
        if (!owner) continue;
        const result = moveFlowOverrides(flow.id, owner, { by: 'migration' }, lookupFor(owner), db);
        moved += result.moved.length;
      } catch (error) {
        complete = false;
        logger.warn('moving a flow’s wiring into its agents failed', { 'landflow.workflow.id': flow.id, error: error instanceof Error ? error.message : String(error) });
      }
    }
    if (complete && !db.get('SELECT value FROM meta WHERE key = ?', META_KEY)) db.upsert('meta', { key: META_KEY, value: new Date().toISOString() });
    if (moved) logger.info('moved flows’ own wiring into their agents’ drafts', { 'landflow.agents.flowMoves': moved });
  } catch (error) {
    logger.warn('the agent flow-move pass failed', { error: error instanceof Error ? error.message : String(error) });
  }
  return moved;
}

// ---- running before the agent is republished (R11) ---------------------------------------------------------------

/**
 * What a Run an Agent node adds to a run of the saved graph on the agent's published config: the model and tools that moved
 * from THIS node into the agent's draft and that config lacks. Only when all three hold: the node carries no pin
 * (`PIN_PARAM`: a production copy), the running graph no longer wires that sub-node (`wired`: the ids of the sub-nodes it wires;
 * `$model` when a chat model is wired), and the config the run uses lacks the item. So nothing runs twice and nothing is overlaid
 * on a production copy or on an editor run on the draft.
 */
export function pendingFor(
  workflowId: string,
  nodeId: string,
  agent: Agent,
  run: { pinned?: unknown; wired: ReadonlySet<string>; config: AgentConfig },
  db: Database = database(),
): { model?: AgentModel; tools?: AgentToolConfig[] } | undefined {
  if (run.pinned !== undefined && run.pinned !== null && run.pinned !== '') return undefined;
  const rows = db.all<Row>(`SELECT ${COLUMNS} FROM agent_flow_moves WHERE workflow_id = ? AND node_id = ? AND agent_id = ? AND outcome = 'moved'`, workflowId, nodeId, agent.id);
  let model: AgentModel | undefined;
  const tools: AgentToolConfig[] = [];
  for (const row of rows) {
    if (stateOf(row, agent) !== 'pending') continue;
    if (row.moved_as === 'model') {
      if (run.wired.has('$model') || run.wired.has(row.sub_node_id)) continue;
      const moved = (JSON.parse(row.snapshot) as Snapshot).moved?.model;
      if (moved && !sameModel(run.config.model, moved)) model = agent.model ?? moved;
      continue;
    }
    if (run.wired.has(row.sub_node_id.split('@')[0]!) || run.config.tools.some((t) => t.id === row.agent_tool_id)) continue;
    const tool = agent.tools.find((t) => t.id === row.agent_tool_id);
    if (tool && !tools.some((t) => t.id === tool.id)) tools.push(tool);
  }
  return model || tools.length ? { ...(model && { model }), ...(tools.length && { tools }) } : undefined;
}

// ---- the record (R9) ---------------------------------------------------------------------------------------------

/** The record of one flow or one agent, newest first, each moved item's state read against the agent now; only flows `actor` can read. */
export function movesOf(scope: { workflowId: string } | { agentId: string }, actor: Actor, db: Database = database()): AgentMove[] {
  const rows = 'workflowId' in scope
    ? db.all<Row>(`SELECT ${COLUMNS} FROM agent_flow_moves WHERE workflow_id = ? ORDER BY at DESC, id`, scope.workflowId)
    : db.all<Row>(`SELECT ${COLUMNS} FROM agent_flow_moves WHERE agent_id = ? ORDER BY at DESC, id`, scope.agentId);
  const visible = new Set(filterVisible(actor, 'workflow', [...new Set(rows.map((r) => r.workflow_id))].map((id) => ({ id }))).map((w) => w.id));
  return rows.filter((r) => visible.has(r.workflow_id)).map((r) => moveOfRow(r, store.getWorkflow(r.workflow_id)?.name));
}
