/**
 * How a practice is followed (docs/practices.md#compliance): the `practice_applications` rows of a window added up, and a
 * run's practices. Reads only; the rows are written by delivery, citing, checks and the waiver route.
 */
import { COMPLIANCE_DAYS, emptyCounts, FOLLOWED_BY_MAX, type ComplianceCounts, type ComplianceVersion, type PracticeCompliance, type RunPracticeRow } from '../../shared/practice-compliance';
import { agentStore } from '../agents/store';
import { database, type Database } from '../db';
import { canResource, type Actor } from '../projects/access';
import { getPractice } from './store';
import { visiblePractice } from './views';

const DAY_MS = 86_400_000;

const clampDays = (days: number | undefined) => Math.max(COMPLIANCE_DAYS.min, Math.min(COMPLIANCE_DAYS.max, Math.floor(days ?? COMPLIANCE_DAYS.default) || COMPLIANCE_DAYS.default));

/** What a row counts as for `delivered` and `cited`: its run (a run that cites twice, in the answer and by `practice_cite`, is one); a row without a run counts alone. */
const RUN_KEY = 'COALESCE(execution_id, id)';

/** Add one row group to counts: `delivered` and `cited` in distinct runs (`runs`), the checks and waivers per row (`n`). */
function add(counts: ComplianceCounts, kind: string, n: number, runs: number): void {
  if (kind === 'delivered') counts.delivered += runs;
  else if (kind === 'cited') counts.cited += runs;
  else if (kind === 'check-pass') counts.checkPass += n;
  else if (kind === 'check-fail') counts.checkFail += n;
  else if (kind === 'waived') counts.waived += n;
}

/** The counts of every practice over a window, for the detector: one query. */
export function countsByPractice(since: string, db: Database = database()): Map<string, ComplianceCounts> {
  const rows = db.all<{ practice_id: string; kind: string; n: number; runs: number }>(
    `SELECT practice_id, kind, COUNT(*) AS n, COUNT(DISTINCT ${RUN_KEY}) AS runs FROM practice_applications WHERE at >= ? GROUP BY practice_id, kind`,
    since,
  );
  const out = new Map<string, ComplianceCounts>();
  for (const row of rows) {
    const counts = out.get(row.practice_id) ?? emptyCounts();
    add(counts, row.kind, Number(row.n), Number(row.runs));
    out.set(row.practice_id, counts);
  }
  return out;
}

/**
 * How many of each practice's `delivered` runs were in-process deliveries: a Landflow agent's or team's block, written for
 * every practice in it whether or not the work touched it (docs/practices.md#compliance). The drift detector asks more of
 * these than of a delivery a person or a harness asked for (`practices_for`, the CLI), which names a repository.
 */
export function inProcessDelivered(since: string, db: Database = database()): Map<string, number> {
  const rows = db.all<{ practice_id: string; runs: number }>(
    `SELECT practice_id, COUNT(DISTINCT execution_id) AS runs FROM practice_applications WHERE at >= ? AND kind = 'delivered' AND execution_id IS NOT NULL AND repo IS NULL GROUP BY practice_id`,
    since,
  );
  return new Map(rows.map((r) => [r.practice_id, Number(r.runs)]));
}

/**
 * The compliance of a practice the viewer may see (undefined: they may not, so the route answers 404). Agents the viewer
 * may not read are counted in `otherAgents` and never named.
 */
export function complianceOf(viewer: Actor, practiceId: string, days?: number, now = Date.now()): PracticeCompliance | undefined {
  if (!visiblePractice(viewer, practiceId)) return undefined;
  const window = clampDays(days);
  const since = new Date(now - window * DAY_MS).toISOString();
  const db = database();
  const rows = db.all<{ version: number; kind: string; n: number; runs: number; last: string }>(
    `SELECT version, kind, COUNT(*) AS n, COUNT(DISTINCT ${RUN_KEY}) AS runs, MAX(at) AS last FROM practice_applications WHERE practice_id = ? AND at >= ? GROUP BY version, kind`,
    practiceId,
    since,
  );
  const total = emptyCounts();
  const versions = new Map<number, ComplianceVersion>();
  let lastApplied: string | undefined;
  for (const row of rows) {
    const version = Number(row.version);
    const entry = versions.get(version) ?? { version, ...emptyCounts() };
    add(entry, row.kind, Number(row.n), Number(row.runs));
    versions.set(version, entry);
    add(total, row.kind, Number(row.n), Number(row.runs));
    // A waiver is a person's decision, not the practice being applied.
    if (row.kind !== 'waived' && (!lastApplied || row.last > lastApplied)) lastApplied = row.last;
  }
  const newest = db.all<{ execution_id: string }>(
    `SELECT execution_id FROM practice_applications WHERE practice_id = ? AND at >= ? AND kind <> 'waived' AND execution_id IS NOT NULL ORDER BY at DESC, id DESC LIMIT 1`,
    practiceId,
    since,
  )[0];
  const citing = db.all<{ agent_id: string; n: number }>(
    `SELECT agent_id, COUNT(*) AS n FROM practice_applications WHERE practice_id = ? AND at >= ? AND kind = 'cited' AND agent_id IS NOT NULL GROUP BY agent_id ORDER BY n DESC, agent_id`,
    practiceId,
    since,
  );
  const followedBy: PracticeCompliance['followedBy'] = [];
  let otherAgents = 0;
  for (const { agent_id: agentId } of citing) {
    const agent = agentStore.get(agentId);
    if (agent && canResource(viewer, 'agent', agentId, 'read')) {
      if (followedBy.length < FOLLOWED_BY_MAX) followedBy.push({ agentId, name: agent.name });
      else otherAgents++;
    } else otherAgents++;
  }
  return { days: window, ...total, followedBy, otherAgents, ...(lastApplied && { lastApplied }), ...(newest && { lastRunId: newest.execution_id }), byVersion: [...versions.values()].sort((a, b) => b.version - a.version) };
}

/**
 * The practices one run was given or checked, as `handle@version`, only those the viewer may see. A check's outcome is the
 * newest of pass, fail and waived the run has for that practice (a waiver settles a failed check).
 */
export function runPractices(viewer: Actor, executionId: string): RunPracticeRow[] {
  const rows = database().all<{ practice_id: string; version: number; kind: string }>(
    'SELECT practice_id, version, kind FROM practice_applications WHERE execution_id = ? ORDER BY at, id',
    executionId,
  );
  const out = new Map<string, RunPracticeRow & { practiceId: string }>();
  const seen = new Map<string, boolean>();
  for (const row of rows) {
    const version = Number(row.version);
    const key = `${row.practice_id}@${version}`;
    let visible = seen.get(row.practice_id);
    if (visible === undefined) {
      visible = Boolean(visiblePractice(viewer, row.practice_id));
      seen.set(row.practice_id, visible);
    }
    if (!visible) continue;
    let entry = out.get(key);
    if (!entry) {
      const practice = getPractice(row.practice_id);
      if (!practice) continue;
      entry = { practiceId: row.practice_id, handle: practice.handle, version, delivered: false, cited: false };
      out.set(key, entry);
    }
    if (row.kind === 'delivered') entry.delivered = true;
    else if (row.kind === 'cited') entry.cited = true;
    else if (row.kind === 'check-pass') entry.check = 'pass';
    else if (row.kind === 'check-fail') entry.check = 'fail';
    else if (row.kind === 'waived') entry.check = 'waived';
  }
  return [...out.values()].map(({ practiceId: _id, ...rest }) => rest).sort((a, b) => a.handle.localeCompare(b.handle) || a.version - b.version);
}
