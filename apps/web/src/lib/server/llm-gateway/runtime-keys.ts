/**
 * Virtual keys for agents that run outside Landflow (docs/llm-gateway.md, "Agents outside Landflow"): one key per agent and
 * runtime (kagent's own runtime, Claude Code on kagent), minted with the server's admin key, sealed with the credential vault
 * and written to the agent's kagent Secret. The key's budget is the agent's own dollar limit, with no headroom: nothing else
 * stops a call made on kagent. Keys are blocked when the agent leaves kagent, never deleted: removing data in LiteLLM is a
 * person's job in its UI.
 */
import { nanoid } from 'nanoid';
import { backstopBudget, LITELLM_IDS, type GatewayBudget, type LandflowSpendMetadata, type RuntimeKeyKind } from '../../shared/llm-gateway';
import { credentials } from '../credentials/vault';
import { database, type Database } from '../db';
import { singleton } from '../singleton';
import { logger } from '../telemetry/logger';
import { hashKey, type LiteLlmClient } from './client';
import { runtimeKeyChanged } from './events';
import { adminClient, gatewayConnection, type GatewayConnection } from './settings';

const MODELS_CACHE_MS = 60_000;
const MISSING_ADMIN = 'needs LANDFLOW_LLM_GATEWAY_URL and LANDFLOW_LLM_GATEWAY_ADMIN_KEY on the server';

/** A row of `llm_gateway_keys`. */
export interface RuntimeKeyRow {
  id: string;
  runtime: RuntimeKeyKind;
  agent_id: string;
  project_id: string | null;
  key_alias: string;
  key_hash: string;
  key_sealed: string;
  team_id: string | null;
  max_budget: number | null;
  budget_duration: string | null;
  blocked: number;
  created_at: string;
  updated_at: string;
}

/** Why an agent's model goes straight to its provider: shown in the deploy result as "Calls the model directly: <reason>". */
export interface DirectReason {
  reason: string;
  /** No gateway is configured at all: nothing to report (an instance without the gateway changes nothing). */
  silent?: true;
}

const modelCache = () => singleton<Map<string, { at: number; models: Set<string> }>>('llm-gateway-runtime-models', () => new Map());

/** Whether the model names are served by the gateway (cached for 60 s per gateway). */
async function servedModels(client: LiteLlmClient, base: string, now = Date.now()): Promise<Set<string>> {
  const cached = modelCache().get(base);
  if (cached && now - cached.at < MODELS_CACHE_MS) return cached.models;
  const models = new Set((await client.models()).map((m) => m.id));
  modelCache().set(base, { at: now, models });
  return models;
}

/** Forget the cached model lists (tests, and after the gateway's settings change). */
export const forgetServedModels = () => modelCache().clear();

/**
 * Whether an agent on kagent can call `model` through the gateway: the gateway has a cluster URL (how kagent reaches it) and
 * the server has an admin key, and the gateway serves the model.
 */
export async function routeThroughGateway(model: string): Promise<{ connection: GatewayConnection } | DirectReason> {
  const connection = await gatewayConnection();
  if (!connection) return { reason: 'no gateway is configured', silent: true };
  if (!connection.clusterUrl) return { reason: 'the gateway has no cluster URL (Settings → AI → LLM gateway, or LANDFLOW_LLM_GATEWAY_CLUSTER_URL)' };
  const admin = adminClient(connection);
  if (!admin) return { reason: `no admin key: ${MISSING_ADMIN}` };
  try {
    const served = await servedModels(admin, `${connection.adminBaseUrl}`);
    if (!served.has(model)) return { reason: `the gateway does not serve ${model}` };
  } catch (error) {
    return { reason: `the gateway could not be asked for its models (${(error as Error).message})` };
  }
  return { connection };
}

/** The budget a runtime key gets from an agent's settings: its dollar limits, no headroom. Undefined without a dollar limit. */
export const runtimeKeyBudget = (settings: { dailyCostLimit?: number; monthlyCostLimit?: number } | undefined): GatewayBudget | undefined =>
  backstopBudget({ dayCost: settings?.dailyCostLimit, monthCost: settings?.monthlyCostLimit }, 0);

export const runtimeKeyRows = (agentId: string, db: Database = database()): RuntimeKeyRow[] =>
  db.all<RuntimeKeyRow>('SELECT * FROM llm_gateway_keys WHERE agent_id = ? ORDER BY created_at', agentId);

const rowOf = (runtime: RuntimeKeyKind, agentId: string, db: Database): RuntimeKeyRow | undefined =>
  db.get<RuntimeKeyRow>('SELECT * FROM llm_gateway_keys WHERE runtime = ? AND agent_id = ?', runtime, agentId);

/** The key already minted for an agent on a runtime (opened), without minting or changing anything: undefined when none or blocked. */
export function existingRuntimeKey(runtime: RuntimeKeyKind, agentId: string, db: Database = database()): { key: string; alias: string } | undefined {
  const row = rowOf(runtime, agentId, db);
  if (!row || row.blocked) return undefined;
  try {
    return { key: credentials.openSecret(row.key_sealed), alias: row.key_alias };
  } catch {
    return undefined;
  }
}

export interface RuntimeKeyInput {
  agentId: string;
  runtime: RuntimeKeyKind;
  model: string;
  projectId?: string;
  budget?: GatewayBudget;
}

const sameNumber = (a: number | null | undefined, b: number | null | undefined) => (a ?? null) === (b ?? null);

/**
 * The agent's virtual key on a runtime: minted when there is none, taken up again when it was blocked (LiteLLM keeps key
 * aliases unique), brought in line with the model, team and budget when they changed. Needs the server's admin key.
 */
export async function ensureRuntimeKey(input: RuntimeKeyInput, options: { db?: Database; admin?: LiteLlmClient } = {}): Promise<{ key: string; alias: string }> {
  const db = options.db ?? database();
  const admin = options.admin ?? adminClient(await gatewayConnection(db));
  if (!admin) throw new Error(`The LLM gateway ${MISSING_ADMIN}`);
  const alias = LITELLM_IDS.runtimeKeyAlias(input.runtime, input.agentId);
  const team = input.projectId && (await admin.teamInfo(LITELLM_IDS.team(input.projectId))) ? LITELLM_IDS.team(input.projectId) : undefined;
  const budget = input.budget;
  const metadata = {
    spend_logs_metadata: {
      landflow: 'runtime',
      runtime: input.runtime,
      agent: input.agentId,
      ...(input.projectId && { project: input.projectId }),
    } satisfies LandflowSpendMetadata,
  };
  const now = new Date().toISOString();
  const row = rowOf(input.runtime, input.agentId, db);

  let key: string | undefined;
  let changed = false;
  if (row) {
    try {
      key = credentials.openSecret(row.key_sealed);
    } catch {
      key = undefined;
    }
    if (key) {
      if (row.blocked) {
        await admin.unblockKey(key);
        changed = true;
      }
      const info = await admin.keyInfo(key);
      if (!info) key = undefined;
      else {
        const modelChanged = !(info.models?.length === 1 && info.models[0] === input.model);
        const teamChanged = (team ?? null) !== (info.team_id ?? null) && team !== undefined;
        const budgetChanged = !sameNumber(budget?.maxBudget, info.max_budget) || (budget?.duration ?? null) !== (info.budget_duration ?? null);
        if (modelChanged || teamChanged || budgetChanged) {
          await admin.updateKey({
            key,
            models: [input.model],
            ...(team && { team_id: team }),
            max_budget: budget?.maxBudget ?? null,
            budget_duration: budget?.duration ?? null,
            metadata,
          });
          changed = true;
        }
        if (changed) {
          db.upsert('llm_gateway_keys', {
            ...row,
            project_id: input.projectId ?? null,
            team_id: team ?? row.team_id,
            max_budget: budget?.maxBudget ?? null,
            budget_duration: budget?.duration ?? null,
            blocked: 0,
            updated_at: now,
          });
          void runtimeKeyChanged(input.agentId);
        }
        return { key, alias: row.key_alias };
      }
    }
  }
  const made = await admin.generateKey({
    key_alias: alias,
    models: [input.model],
    ...(team && { team_id: team }),
    ...(budget && { max_budget: budget.maxBudget, budget_duration: budget.duration }),
    metadata,
  });
  db.upsert('llm_gateway_keys', {
    id: row?.id ?? `lgk_${nanoid(14)}`,
    runtime: input.runtime,
    agent_id: input.agentId,
    project_id: input.projectId ?? null,
    key_alias: alias,
    key_hash: hashKey(made.key),
    key_sealed: credentials.sealSecret(made.key),
    team_id: team ?? null,
    max_budget: budget?.maxBudget ?? null,
    budget_duration: budget?.duration ?? null,
    blocked: 0,
    created_at: row?.created_at ?? now,
    updated_at: now,
  });
  logger.info('llm gateway: a virtual key was minted for an agent outside Landflow', { agentId: input.agentId, runtime: input.runtime, alias });
  void runtimeKeyChanged(input.agentId);
  return { key: made.key, alias };
}

/**
 * Block an agent's keys (all, or all but the runtime it moved to): the agent was removed from kagent, or moved to the other
 * runtime. Never deletes. A key that could not be blocked stays marked unblocked and is logged. Returns the aliases blocked.
 */
export async function blockRuntimeKeys(agentId: string, except?: RuntimeKeyKind, options: { db?: Database; admin?: LiteLlmClient } = {}): Promise<string[]> {
  const db = options.db ?? database();
  const rows = runtimeKeyRows(agentId, db).filter((row) => !row.blocked && row.runtime !== except);
  if (!rows.length) return [];
  const admin = options.admin ?? adminClient(await gatewayConnection(db));
  const blocked: string[] = [];
  for (const row of rows) {
    if (!admin) {
      logger.warn(`llm gateway: a key of a removed agent could not be blocked: the gateway ${MISSING_ADMIN}`, { agentId, alias: row.key_alias });
      continue;
    }
    try {
      await admin.blockKey(credentials.openSecret(row.key_sealed));
      db.upsert('llm_gateway_keys', { ...row, blocked: 1, updated_at: new Date().toISOString() });
      blocked.push(row.key_alias);
    } catch (error) {
      logger.warn('llm gateway: a key of a removed agent could not be blocked', { agentId, alias: row.key_alias, error: (error as Error).message });
    }
  }
  if (blocked.length) void runtimeKeyChanged(agentId);
  return blocked;
}
