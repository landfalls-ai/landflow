/**
 * Networks and the runners registered to them (C29, docs/network-runners.md). A network is a name and, optionally, one
 * project (only that project's workflows may run in it); a runner is a process inside it with a token of its own
 * (`lf_run_…`, 32 base62 characters), returned once, kept as its SHA-256 (`token_hash`) and shown by its last four
 * characters, revocable alone, and with an optional list of addresses it may connect from (C17's `allowed`).
 *
 * What a runner last reported lives in `network_runner_seen`, apart from its row: a poll writes only that, so it can
 * never rewrite a revoke (two mains share the table). Presence is computed on read (online: seen in the last 30 s); a
 * runner's "connected" is audited at its first poll after a gap and its "disconnected" the first time a read finds it
 * gone for over a minute (no timer: plan D16). Every change is a high-value audit event; no event holds a token.
 */
import { randomBytes } from 'node:crypto';
import { nanoid } from 'nanoid';
import { RUNNER_ONLINE_MS, RUNNER_TOKEN_PREFIX, type NetworkView, type RegisteredRunner, type RunnerView } from '../../shared/networks';
import { auditedTransaction, recordAudit } from '../audit';
import { database } from '../db';
import { HttpError } from '../errors';
import { allowed, checkAllowList } from '../net/ip-allow';
import { clientAddress } from '../net/client-address';
import { sameSecret, tokenHash } from '../auth/passwords';
import type { UserRecord } from '../auth/users';
import { getProject, isInstanceAdmin, visibleProjectIds } from '../projects';
import { store as workflows } from '../store';
import { filterVisible } from '../projects/access';

export class NetworkError extends HttpError {
  static readonly errorName: string = 'NetworkError';
  constructor(message: string, status = 400, details?: Record<string, unknown>) {
    super(message, status, { expose: true, ...(details && { details }) });
  }
}

export interface RunnerRecord {
  id: string;
  networkId: string;
  name: string;
  allowedIps: string[];
}

interface NetworkRow {
  id: string;
  name: string;
  description: string | null;
  project_id: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

interface RunnerRow {
  id: string;
  network_id: string;
  name: string;
  token_hash: string;
  token_hint: string;
  allowed_ips: string | null;
  created_by: string | null;
  created_at: string;
  revoked_at: string | null;
}

interface SeenRow {
  runner_id: string;
  last_seen_at: string;
  connected_since: string | null;
  version: string | null;
  address: string | null;
}

/** A runner unseen this long counts as gone: "disconnected" is audited and a new poll is a new connection. */
const GONE_MS = 60_000;
/** A poll writes its presence at most this often (a long poll loops every 100 ms; a row a minute is plenty). */
const SEEN_EVERY_MS = 5_000;

const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
/** `lf_run_` and 32 base62 characters (bytes ≥ 248 are skipped so every character is equally likely). */
function newToken(): string {
  let out = '';
  while (out.length < 32) for (const byte of randomBytes(48)) if (byte < 248 && out.length < 32) out += BASE62[byte % 62];
  return `${RUNNER_TOKEN_PREFIX}${out}`;
}

const db = () => database();
const iso = (ms: number) => new Date(ms).toISOString();

function checkName(name: string, exceptId?: string): string {
  const clean = name.trim();
  if (!clean || clean.length > 60) throw new NetworkError('A network name is 1 to 60 characters');
  const taken = db().get<{ id: string }>('SELECT id FROM networks WHERE name = ?', clean);
  if (taken && taken.id !== exceptId) throw new NetworkError(`A network named “${clean}” already exists`, 409);
  return clean;
}

const parseIps = (text: string | null): string[] => {
  try {
    const list: unknown = text ? JSON.parse(text) : [];
    return Array.isArray(list) ? list.filter((entry): entry is string => typeof entry === 'string') : [];
  } catch {
    return [];
  }
};

function runnerView(row: RunnerRow, seen: SeenRow | undefined, now: number): RunnerView {
  const lastSeen = seen && Date.parse(seen.last_seen_at);
  const status = row.revoked_at ? 'revoked' : lastSeen !== undefined && now - lastSeen <= RUNNER_ONLINE_MS ? 'online' : 'offline';
  return {
    id: row.id,
    name: row.name,
    hint: row.token_hint,
    status,
    allowedIps: parseIps(row.allowed_ips),
    ...(seen?.version && { version: seen.version }),
    ...(seen?.address && { address: seen.address }),
    ...(seen && { lastSeenAt: seen.last_seen_at }),
    createdAt: row.created_at,
    ...(row.revoked_at && { revokedAt: row.revoked_at }),
  };
}

/** The workflows with an HTTP Request node set to run in `networkId`. */
export function workflowsUsing(networkId: string): Array<{ id: string; name: string }> {
  return workflows
    .listWorkflows()
    .filter((workflow) => workflow.nodes.some((node) => node.type === 'core.httpRequest' && node.parameters?.runIn === networkId))
    .map((workflow) => ({ id: workflow.id, name: workflow.name }));
}

/** Whether `actor` may see a network: instance-wide ones are everyone's, a project's only its members' (and admins'). */
function visibleTo(actor: UserRecord, row: NetworkRow): boolean {
  if (!row.project_id || isInstanceAdmin(actor)) return true;
  return visibleProjectIds(actor)?.has(row.project_id) ?? true;
}

function view(row: NetworkRow, actor: UserRecord | undefined, now: number): NetworkView {
  const runners = db().all<RunnerRow>('SELECT * FROM network_runners WHERE network_id = ? ORDER BY created_at', row.id);
  const seen = new Map(db().all<SeenRow>(`SELECT * FROM network_runner_seen WHERE runner_id IN (SELECT id FROM network_runners WHERE network_id = ?)`, row.id).map((s) => [s.runner_id, s]));
  const using = workflowsUsing(row.id);
  return {
    id: row.id,
    name: row.name,
    ...(row.description && { description: row.description }),
    ...(row.project_id && { projectId: row.project_id, ...(getProject(row.project_id) && { projectName: getProject(row.project_id)!.name }) }),
    runners: runners.map((runner) => runnerView(runner, seen.get(runner.id), now)),
    workflows: actor ? filterVisible(actor, 'workflow', using) : using,
    createdAt: row.created_at,
  };
}

/** Audit "disconnected" for the runners that were connected and are gone (once each), the first read that finds them so. */
function sweepPresence(now: number) {
  const gone = db().all<SeenRow & { network_id: string; name: string }>(
    `SELECT s.*, r.network_id, r.name FROM network_runner_seen s JOIN network_runners r ON r.id = s.runner_id WHERE s.connected_since IS NOT NULL AND s.last_seen_at < ?`,
    iso(now - GONE_MS),
  );
  for (const row of gone) {
    db().upsert('network_runner_seen', { runner_id: row.runner_id, last_seen_at: row.last_seen_at, connected_since: null, version: row.version, address: row.address });
    const network = db().get<NetworkRow>('SELECT * FROM networks WHERE id = ?', row.network_id);
    recordAudit({ action: 'network.runner.disconnected', actor: 'system', target: { type: 'network', id: row.network_id, name: network?.name }, project: network?.project_id ?? null, summary: `Runner ${row.name} disconnected`, details: { runnerId: row.runner_id, network: network?.name } });
  }
}

/** The networks `actor` may see, with their runners' status and the workflows using each. */
export function listNetworks(actor: UserRecord, now = Date.now()): NetworkView[] {
  sweepPresence(now);
  return db()
    .all<NetworkRow>('SELECT * FROM networks ORDER BY name')
    .filter((row) => visibleTo(actor, row))
    .map((row) => view(row, actor, now));
}

export function getNetwork(id: string): NetworkView | undefined {
  const row = db().get<NetworkRow>('SELECT * FROM networks WHERE id = ?', id);
  return row && view(row, undefined, Date.now());
}

/** A network's name and project without the runners: what a node's checks need. */
export function networkRow(id: string): { id: string; name: string; projectId?: string } | undefined {
  const row = db().get<NetworkRow>('SELECT id, name, project_id FROM networks WHERE id = ?', id);
  return row && { id: row.id, name: row.name, ...(row.project_id && { projectId: row.project_id }) };
}

/** The networks a run-in menu offers (names only; the project rule is checked when the node runs). */
export function networkChoices(): Array<{ id: string; name: string; projectId?: string }> {
  return db()
    .all<NetworkRow>('SELECT id, name, project_id FROM networks ORDER BY name')
    .map((row) => ({ id: row.id, name: row.name, ...(row.project_id && { projectId: row.project_id }) }));
}

export function createNetwork(input: { name: string; description?: string; projectId?: string }, actor: UserRecord): NetworkView {
  if (input.projectId && !getProject(input.projectId)) throw new NetworkError(`That project doesn’t exist`);
  return auditedTransaction(() => {
    const name = checkName(input.name);
    const now = iso(Date.now());
    const id = `net_${nanoid(10)}`;
    db().insertNew('networks', { id, name, description: input.description?.trim() || null, project_id: input.projectId ?? null, created_by: actor.id, created_at: now, updated_at: now });
    recordAudit({ action: 'network.created', target: { type: 'network', id, name }, project: input.projectId ?? null, summary: `Created the network ${name}`, details: { from: null, to: input.projectId ? `project ${input.projectId}` : 'instance-wide' } });
    return getNetwork(id)!;
  });
}

export function updateNetwork(id: string, patch: { name?: string; description?: string | null }, actor: UserRecord): NetworkView {
  return auditedTransaction(() => {
    const row = db().get<NetworkRow>('SELECT * FROM networks WHERE id = ?', id);
    if (!row) throw new NetworkError('Network not found', 404);
    const name = patch.name !== undefined ? checkName(patch.name, id) : row.name;
    const description = patch.description === undefined ? row.description : patch.description?.trim() || null;
    db().upsert('networks', { ...row, name, description, updated_at: iso(Date.now()) });
    recordAudit({ action: 'network.updated', target: { type: 'network', id, name }, project: row.project_id, summary: `Changed the network ${name}`, details: { from: row.name, to: name, by: actor.id } });
    return getNetwork(id)!;
  });
}

/** Delete a network; its runners are revoked first (their tokens stop working at once) and then removed with it. */
export function deleteNetwork(id: string, actor: UserRecord): void {
  auditedTransaction(() => {
    const row = db().get<NetworkRow>('SELECT * FROM networks WHERE id = ?', id);
    if (!row) throw new NetworkError('Network not found', 404);
    const runners = db().all<RunnerRow>('SELECT * FROM network_runners WHERE network_id = ?', id);
    for (const runner of runners) {
      db().delete('network_runner_seen', { runner_id: runner.id });
      db().delete('network_runners', { id: runner.id });
    }
    db().delete('network_calls', { network_id: id });
    db().delete('networks', { id });
    recordAudit({ action: 'network.deleted', target: { type: 'network', id, name: row.name }, project: row.project_id, summary: `Deleted the network ${row.name}`, details: { runners: runners.length, by: actor.id } });
  });
}

/** Register a runner: the token is in the answer and nowhere else, ever. */
export function registerRunner(networkId: string, input: { name: string; allowedIps?: string[] }, actor: UserRecord): RegisteredRunner {
  const network = db().get<NetworkRow>('SELECT * FROM networks WHERE id = ?', networkId);
  if (!network) throw new NetworkError('Network not found', 404);
  const name = input.name.trim();
  if (!name || name.length > 60) throw new NetworkError('A runner name is 1 to 60 characters');
  const checked = checkAllowList(input.allowedIps ?? []);
  if (!checked.ok) throw new NetworkError(checked.problem);
  const token = newToken();
  const id = `run_${nanoid(10)}`;
  auditedTransaction(() => {
    db().insertNew('network_runners', { id, network_id: networkId, name, token_hash: tokenHash(token), token_hint: token.slice(-4), allowed_ips: checked.entries.length ? JSON.stringify(checked.entries) : null, created_by: actor.id, created_at: iso(Date.now()), revoked_at: null });
    recordAudit({ action: 'network.runner.registered', target: { type: 'network', id: networkId, name: network.name }, project: network.project_id, summary: `Registered the runner ${name} in ${network.name}`, details: { runnerId: id, runner: name, ips: checked.entries.length } });
  });
  const row = db().get<RunnerRow>('SELECT * FROM network_runners WHERE id = ?', id)!;
  return { runner: runnerView(row, undefined, Date.now()), token };
}

/** Revoke a runner: its token is refused from the next check on, and calls it holds fail as lost. */
export function revokeRunner(networkId: string, runnerId: string, actor: UserRecord): RunnerView {
  return auditedTransaction(() => {
    const row = db().get<RunnerRow>('SELECT * FROM network_runners WHERE id = ? AND network_id = ?', runnerId, networkId);
    if (!row) throw new NetworkError('Runner not found', 404);
    if (row.revoked_at) return runnerView(row, undefined, Date.now());
    const revoked = { ...row, revoked_at: iso(Date.now()) };
    db().upsert('network_runners', revoked);
    const network = db().get<NetworkRow>('SELECT * FROM networks WHERE id = ?', networkId);
    recordAudit({ action: 'network.runner.revoked', target: { type: 'network', id: networkId, name: network?.name }, project: network?.project_id ?? null, summary: `Revoked the runner ${row.name}`, details: { runnerId: runnerId, runner: row.name, by: actor.id } });
    return runnerView(revoked, db().get<SeenRow>('SELECT * FROM network_runner_seen WHERE runner_id = ?', runnerId), Date.now());
  });
}

const BEARER = /^Bearer\s+(\S+)$/i;

/**
 * The runner a request's bearer token belongs to: the hash matches, the runner isn't revoked and the caller's address
 * passes the runner's own list. Undefined for anything else (the route answers 401 without saying which).
 */
export function authenticateRunner(request: Request): RunnerRecord | undefined {
  const token = BEARER.exec(request.headers.get('authorization') ?? '')?.[1];
  if (!token?.startsWith(RUNNER_TOKEN_PREFIX)) return undefined;
  const row = db().get<RunnerRow>('SELECT * FROM network_runners WHERE token_hash = ?', tokenHash(token));
  if (!row || row.revoked_at || !sameSecret(tokenHash(token), row.token_hash)) return undefined;
  const ips = parseIps(row.allowed_ips);
  if (ips.length && !allowed(clientAddress(request), ips)) return undefined;
  return { id: row.id, networkId: row.network_id, name: row.name, allowedIps: ips };
}

/** Whether a runner (by id) is still valid: not revoked, not deleted. A long poll asks this between checks. */
export function runnerActive(runnerId: string): boolean {
  const row = db().get<{ revoked_at: string | null }>('SELECT revoked_at FROM network_runners WHERE id = ?', runnerId);
  return Boolean(row && !row.revoked_at);
}

/** Record that a runner was seen (a poll). The first one after a gap is "connected" in the audit log. */
export function markSeen(runnerId: string, info: { version?: string; address?: string } = {}, now = Date.now()) {
  const before = db().get<SeenRow>('SELECT * FROM network_runner_seen WHERE runner_id = ?', runnerId);
  const last = before && Date.parse(before.last_seen_at);
  const fresh = !before || before.connected_since === null || (last !== undefined && now - last > GONE_MS);
  if (!fresh && last !== undefined && now - last < SEEN_EVERY_MS && (!info.version || info.version === before?.version)) return;
  db().upsert('network_runner_seen', { runner_id: runnerId, last_seen_at: iso(now), connected_since: fresh ? iso(now) : before!.connected_since, version: info.version ?? before?.version ?? null, address: info.address ?? before?.address ?? null });
  if (!fresh) return;
  const runner = db().get<RunnerRow>('SELECT * FROM network_runners WHERE id = ?', runnerId);
  const network = runner && db().get<NetworkRow>('SELECT * FROM networks WHERE id = ?', runner.network_id);
  recordAudit({ action: 'network.runner.connected', actor: 'system', target: { type: 'network', id: runner?.network_id, name: network?.name }, project: network?.project_id ?? null, summary: `Runner ${runner?.name ?? runnerId} connected`, details: { runnerId, version: info.version } });
}

/** How many of a network's runners were seen in the last 30 s (and aren't revoked). */
export function onlineRunnerCount(networkId: string, now = Date.now()): number {
  return Number(
    db().get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM network_runner_seen s JOIN network_runners r ON r.id = s.runner_id WHERE r.network_id = ? AND r.revoked_at IS NULL AND s.last_seen_at >= ?`,
      networkId,
      iso(now - RUNNER_ONLINE_MS),
    )?.n ?? 0,
  );
}

/** When a runner was last seen (epoch ms), if ever. */
export function lastSeenMs(runnerId: string): number | undefined {
  const row = db().get<{ last_seen_at: string }>('SELECT last_seen_at FROM network_runner_seen WHERE runner_id = ?', runnerId);
  return row ? Date.parse(row.last_seen_at) : undefined;
}
