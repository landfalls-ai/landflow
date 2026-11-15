/**
 * The budgets sync (docs/llm-gateway.md, "Budgets in LiteLLM"): Landflow's projects become LiteLLM teams, its people
 * customers (end users) and its dollar caps budgets a little above the Landflow cap, so Landflow's own, clearer stop
 * comes first and LiteLLM stops what slips past it. Idempotent: it looks first and writes only what differs. It never
 * deletes, blocks or changes anything that has no Landflow counterpart any more: that is listed as an orphan for an
 * admin to handle in LiteLLM's UI. Only ids go to LiteLLM, never a person's name or email.
 */
import type { AiCaps } from '../../shared/ai-usage';
import { backstopBudget, LITELLM_IDS, parseCapId, type GatewayBudget, type SyncCounts, type SyncReport } from '../../shared/llm-gateway';
import { envInt } from '../config';
import { agentStore } from '../agents/store';
import { aiCaps, capSetActive } from '../ai-usage/caps';
import { getUser, listUsers } from '../auth/users';
import { credentials } from '../credentials/vault';
import { database, type Database } from '../db';
import { getProject, listProjects } from '../projects/store';
import { singleton } from '../singleton';
import { logger } from '../telemetry/logger';
import type { Fetcher, LiteLlmClient } from './client';
import { onCapsChanged, onRuntimeKeyChanged } from './events';
import { adminClient, gatewayConnection, gatewaySettings, lastSyncReport, saveSyncReport, type GatewayConnection } from './settings';

const ORPHAN_NOTE = "Remove it in LiteLLM's UI if it is no longer needed";
const NEEDS_ADMIN = 'The budgets sync needs LANDFLOW_LLM_GATEWAY_URL and LANDFLOW_LLM_GATEWAY_ADMIN_KEY on the server';

const counts = (): SyncCounts => ({ created: 0, updated: 0, unchanged: 0, failed: 0 });
const emptyReport = (trigger: SyncReport['trigger'], errors: string[] = []): SyncReport => ({ at: new Date().toISOString(), trigger, teams: counts(), customers: counts(), keys: counts(), orphans: [], errors });

export interface SyncInput {
  trigger: SyncReport['trigger'];
  /** Only the objects these caps touch (`user:<id>`, `credential:<id>`, `agent:<id>`); workflow caps have no backstop. */
  capIds?: string[];
  fetcher?: Fetcher;
  db?: Database;
}

interface LinkRow {
  kind: 'team' | 'customer' | 'key';
  landflow_id: string;
  litellm_id: string;
  state: 'synced' | 'failed';
  budget: string | null;
  error: string | null;
  synced_at: string;
}

interface KeyRow {
  id: string;
  runtime: string;
  agent_id: string;
  project_id: string | null;
  key_alias: string;
  key_sealed: string;
  team_id: string | null;
  max_budget: number | null;
  budget_duration: string | null;
  blocked: number;
  created_at: string;
  updated_at: string;
}

const same = (budget: GatewayBudget | undefined, maxBudget: number | null | undefined, duration: string | null | undefined): boolean => {
  if (!budget) return !maxBudget;
  return typeof maxBudget === 'number' && Math.abs(maxBudget - budget.maxBudget) < 1e-9 && duration === budget.duration;
};

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 300);

/** One run at a time. A caller with the same scope joins the running one only if it started after the call. */
const running = () => singleton<{ current?: Promise<SyncReport>; key?: string }>('llm-gateway-sync-running', () => ({}));

export async function syncBudgets(input: SyncInput): Promise<SyncReport> {
  const state = running();
  const key = input.capIds ? [...input.capIds].sort().join(',') : '*';
  // Something is running: it may have read the caps already, so wait for it and run again (the callers that
  // wait together share that next run when their scope is the same).
  while (state.current) {
    const previous = state.current;
    await previous.catch(() => undefined);
    if (state.current && state.current !== previous && state.key === key) return state.current;
  }
  const run = runSync(input)
    .catch((error) => {
      logger.warn('llm gateway: the budgets sync failed', { error: message(error) });
      return emptyReport(input.trigger, [message(error)]);
    })
    .finally(() => {
      if (state.current === run) {
        state.current = undefined;
        state.key = undefined;
      }
    });
  state.current = run;
  state.key = key;
  return run;
}

async function runSync(input: SyncInput): Promise<SyncReport> {
  const db = input.db ?? database();
  const connection = await gatewayConnection(db);
  const client = adminClient(connection, input.fetcher);
  if (!connection || !client) {
    const report = emptyReport(input.trigger, [NEEDS_ADMIN]);
    saveSyncReport(report, db);
    return report;
  }
  const headroom = gatewaySettings(db).headroomPercent;
  const report = emptyReport(input.trigger);
  const scoped = input.capIds !== undefined;
  const scope = scopeOf(input.capIds ?? []);
  const now = () => new Date().toISOString();

  const link = (kind: LinkRow['kind'], landflowId: string, litellmId: string, budget: GatewayBudget | undefined, failure?: string) => {
    db.upsert('llm_gateway_links', { kind, landflow_id: landflowId, litellm_id: litellmId, state: failure ? 'failed' : 'synced', budget: budget ? JSON.stringify(budget) : null, error: failure ?? null, synced_at: now() });
  };
  const fail = (kind: 'teams' | 'customers' | 'keys', what: string, error: unknown) => {
    report[kind].failed += 1;
    report.errors.push(`${what}: ${message(error)}`);
  };

  // ---- teams ------------------------------------------------------------------------------------------------
  const teamsOk = new Map<string, boolean>();
  const ensureTeam = async (projectId: string, tally: boolean): Promise<boolean> => {
    const known = teamsOk.get(projectId);
    if (known !== undefined) return known;
    const project = getProject(projectId);
    if (!project) return false;
    const teamId = LITELLM_IDS.team(project.id);
    // A personal project is named after its person: the team gets a generic alias (no names go to LiteLLM).
    const alias = project.type === 'team' ? project.name : 'Personal project';
    const bump = (key: keyof SyncCounts) => {
      if (tally) report.teams[key] += 1;
    };
    try {
      const info = await client.teamInfo(teamId);
      // Teams carry no budget: a LiteLLM team budget resets on its own 30-day window, not the calendar month a project's budget
      // runs on, and the team's spend counts calls Landflow never stops (a local model through the gateway), so a backstop
      // here would refuse what Landflow allows. The project's budget is enforced in Landflow (lib/server/budgets).
      if (!info) {
        await client.createTeam({ team_id: teamId, team_alias: alias, metadata: { landflow: 'project' } });
        bump('created');
      } else if (info.team_alias !== alias) {
        await client.updateTeam({ team_id: teamId, team_alias: alias, metadata: { landflow: 'project' } });
        bump('updated');
      } else bump('unchanged');
      if (tally) link('team', project.id, teamId, undefined);
      teamsOk.set(projectId, true);
      return true;
    } catch (error) {
      if (tally) {
        fail('teams', `Team ${teamId}`, error);
        link('team', project.id, teamId, undefined, message(error));
      }
      teamsOk.set(projectId, false);
      return false;
    }
  };
  if (!scoped) for (const project of listProjects()) await ensureTeam(project.id, true);

  // ---- customers --------------------------------------------------------------------------------------------
  const caps = aiCaps(db);
  const linked = (kind: LinkRow['kind']) => db.all<LinkRow>('SELECT * FROM llm_gateway_links WHERE kind = ?', kind);
  const everyone = caps.allUsers;
  const activeUsers = listUsers().filter((user) => !user.disabledAt);
  const wanted = new Map<string, GatewayBudget | undefined>();
  for (const user of activeUsers) {
    const own = caps.users[user.id];
    const set = capSetActive(own) ? own : everyone;
    const budget = backstopBudget(set, headroom);
    if (budget || capSetActive(own)) wanted.set(user.id, budget);
  }
  // Someone whose cap was removed keeps their customer (never deleted) with no budget.
  for (const row of linked('customer')) {
    const person = wanted.has(row.landflow_id) ? undefined : getUser(row.landflow_id);
    if (person && !person.disabledAt) wanted.set(row.landflow_id, undefined);
  }
  for (const [userId, budget] of wanted) {
    if (scoped && !scope.users.has(userId)) continue;
    const customerId = LITELLM_IDS.customer(userId);
    try {
      const info = await client.customerInfo(customerId);
      if (!info) {
        if (!budget) {
          // Nothing to mirror and nothing in LiteLLM: not worth creating.
          report.customers.unchanged += 1;
          link('customer', userId, customerId, undefined);
          continue;
        }
        await client.createCustomer({ user_id: customerId, max_budget: budget.maxBudget, budget_duration: budget.duration });
        report.customers.created += 1;
      } else if (!same(budget, info.max_budget, info.budget_duration)) {
        await client.updateCustomer({ user_id: customerId, max_budget: budget?.maxBudget ?? null, budget_duration: budget?.duration ?? null });
        report.customers.updated += 1;
      } else report.customers.unchanged += 1;
      link('customer', userId, customerId, budget);
    } catch (error) {
      fail('customers', `Customer ${customerId}`, error);
      link('customer', userId, customerId, budget, message(error));
    }
  }

  // ---- keys -------------------------------------------------------------------------------------------------
  // A key named by a credential is not mirrored: a credential's data can be edited by project editors, and the admin
  // key must not change a budget on a key that data picked. Only server configuration names the gateway key.
  if (connection.source !== 'credential') await syncGatewayKey(connection, client, caps.credentials, headroom, scoped ? scope.credentials : undefined, report, link, fail);
  const runtimeKeys = db.all<KeyRow>('SELECT * FROM llm_gateway_keys WHERE blocked = 0 ORDER BY created_at');
  for (const row of runtimeKeys) {
    if (scoped && !scope.agents.has(row.agent_id)) continue;
    await syncRuntimeKey(row, client, ensureTeam, report, link, fail, db);
  }

  // ---- orphans: never deleted, blocked or changed -------------------------------------------------------------
  // A scoped run does not look for orphans: it keeps the last full run's list.
  if (scoped) report.orphans = lastSyncReport(db)?.orphans ?? [];
  else {
    for (const row of [...linked('team'), ...linked('customer'), ...linked('key')]) {
      const gone = row.kind === 'team' ? !getProject(row.landflow_id) : row.kind === 'customer' ? !getUser(row.landflow_id) : orphanKey(row.landflow_id);
      if (gone) report.orphans.push({ kind: row.kind, litellmId: row.litellm_id, note: ORPHAN_NOTE });
    }
  }

  saveSyncReport(report, db);
  return report;
}

/** What `capIds` touch: users (customers), credentials (the gateway key) and agents (runtime keys). */
export function scopeOf(capIds: string[]) {
  const scope = { users: new Set<string>(), credentials: new Set<string>(), agents: new Set<string>() };
  for (const id of capIds) {
    const cap = parseCapId(id);
    // Workflow caps (and ids that are no cap) have no backstop: nothing to do for them. PC14: nor has a project's budget.
    if (!cap || cap.kind === 'workflow' || cap.kind === 'project') continue;
    if (cap.kind === 'user') scope.users.add(cap.subjectId);
    else if (cap.kind === 'credential') scope.credentials.add(cap.subjectId);
    else scope.agents.add(cap.subjectId);
  }
  return scope;
}

/** Whether a key link no longer has its Landflow object: a removed credential or agent. */
function orphanKey(landflowId: string): boolean {
  if (landflowId.startsWith('credential:')) return !credentials.list().some((c) => c.id === landflowId.slice('credential:'.length));
  const match = /^runtime:([^:]+):(.+)$/.exec(landflowId);
  if (!match) return false;
  return !agentStore.get(match[2]!);
}

type Link = (kind: LinkRow['kind'], landflowId: string, litellmId: string, budget: GatewayBudget | undefined, failure?: string) => void;
type Fail = (kind: 'teams' | 'customers' | 'keys', what: string, error: unknown) => void;

/** The gateway credential's own virtual key gets that credential's cap (with headroom). */
async function syncGatewayKey(connection: GatewayConnection, client: LiteLlmClient, credentialCaps: AiCaps['credentials'], headroom: number, only: Set<string> | undefined, report: SyncReport, link: Link, fail: Fail) {
  const id = connection.credentialId;
  if (!id || !connection.apiKey || connection.apiKey === connection.adminKey) return;
  if (only && !only.has(id)) return;
  const budget = backstopBudget(credentialCaps[id], headroom);
  try {
    const info = await client.keyInfo(connection.apiKey);
    if (!info) {
      fail('keys', `Key of credential ${id}`, 'LiteLLM does not know the key');
      return;
    }
    const alias = info.key_alias || `credential:${id}`;
    if (same(budget, info.max_budget, info.budget_duration)) report.keys.unchanged += 1;
    else {
      await client.updateKey({ key: connection.apiKey, max_budget: budget?.maxBudget ?? null, budget_duration: budget?.duration ?? null });
      report.keys.updated += 1;
    }
    link('key', `credential:${id}`, alias, budget);
  } catch (error) {
    fail('keys', `Key of credential ${id}`, error);
    link('key', `credential:${id}`, `credential:${id}`, budget, message(error));
  }
}

/** A key Landflow minted for an agent: the agent's dollar limits as they are (no headroom) and its project's team. */
async function syncRuntimeKey(row: KeyRow, client: LiteLlmClient, ensureTeam: (projectId: string, tally: boolean) => Promise<boolean>, report: SyncReport, link: Link, fail: Fail, db: Database) {
  const landflowId = `runtime:${row.runtime}:${row.agent_id}`;
  const agent = agentStore.get(row.agent_id);
  // An agent that is gone: the orphan list names its key; nothing changes.
  if (!agent) return;
  const settings = agent.published?.config.settings ?? agent.settings;
  const dayCost = typeof settings?.dailyCostLimit === 'number' ? settings.dailyCostLimit : undefined;
  const monthCost = typeof settings?.monthlyCostLimit === 'number' ? settings.monthlyCostLimit : undefined;
  const budget = backstopBudget({ dayCost, monthCost }, 0);
  try {
    const key = credentials.openSecret(row.key_sealed);
    const teamId = row.project_id && (await ensureTeam(row.project_id, false)) ? LITELLM_IDS.team(row.project_id) : undefined;
    const info = await client.keyInfo(key);
    if (!info) {
      fail('keys', `Key ${row.key_alias}`, 'LiteLLM does not know the key');
      link('key', landflowId, row.key_alias, budget, 'LiteLLM does not know the key');
      return;
    }
    const teamDiffers = teamId !== undefined && info.team_id !== teamId;
    if (same(budget, info.max_budget, info.budget_duration) && !teamDiffers) report.keys.unchanged += 1;
    else {
      await client.updateKey({ key, max_budget: budget?.maxBudget ?? null, budget_duration: budget?.duration ?? null, ...(teamDiffers && { team_id: teamId }) });
      report.keys.updated += 1;
    }
    // Re-read just before writing (no await between): another writer may have blocked, moved or re-minted the key
    // while the network calls ran, and the stale snapshot must not undo that.
    const fresh = db.get<KeyRow>('SELECT * FROM llm_gateway_keys WHERE id = ?', row.id);
    const mirrored = { max_budget: budget?.maxBudget ?? null, budget_duration: budget?.duration ?? null, team_id: teamId ?? fresh?.team_id ?? null };
    if (fresh && !fresh.blocked && (mirrored.max_budget !== fresh.max_budget || mirrored.budget_duration !== fresh.budget_duration || mirrored.team_id !== fresh.team_id)) {
      db.upsert('llm_gateway_keys', { ...fresh, ...mirrored, updated_at: new Date().toISOString() });
    }
    link('key', landflowId, row.key_alias, budget);
  } catch (error) {
    fail('keys', `Key ${row.key_alias}`, error);
    link('key', landflowId, row.key_alias, budget, message(error));
  }
}

// ---- the service -------------------------------------------------------------------------------------------------

const clamp = (seconds: number) => Math.min(86_400, Math.max(60, seconds));

/**
 * Runs the sync on cap changes and on a timer while Settings → AI → LLM gateway has it on. A process that is not the
 * leader does not register the listeners; the leader's periodic reconcile catches the change up.
 */
export const budgetsSync = singleton('llm-gateway-budgets-sync', () => {
  let timer: ReturnType<typeof setInterval> | undefined;
  let off: Array<() => void> = [];

  const guarded = (trigger: SyncReport['trigger'], capIds?: string[]) => {
    if (!gatewaySettings().sync) return Promise.resolve();
    return syncBudgets({ trigger, ...(capIds && { capIds }) }).then(
      () => undefined,
      () => undefined,
    );
  };

  return {
    start() {
      if (timer) return;
      off = [
        onCapsChanged((trigger, capIds) => guarded(trigger === 'approval' ? 'approval' : 'change', capIds)),
        // A key was minted, moved or blocked: reconcile that agent's key (and the rest, cheaply: everything is looked at first).
        onRuntimeKeyChanged((agentId) => guarded('change', [`agent:${agentId}:day:cost`])),
      ];
      const seconds = clamp(envInt('LANDFLOW_LLM_GATEWAY_SYNC_SECONDS', { fallback: 600 }));
      timer = setInterval(() => void guarded('schedule'), seconds * 1000);
      timer.unref?.();
    },
    stop() {
      for (const stop of off) stop();
      off = [];
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
});
