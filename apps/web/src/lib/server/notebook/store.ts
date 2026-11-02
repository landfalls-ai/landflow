/**
 * The team notebook's table (`team_notes`, migration 2010; docs/team-notebook.md): one row per note. Scope decides how long a
 * note lives and who sees it: a run's notes are kept 14 days unless promoted, a team's expire 30 days after they were last
 * used unless a person verified them, a project's stay until deleted. Reading a note for a run (search, the prompt block)
 * counts as using it, which is what keeps a team's notes that matter from expiring.
 */
import { nanoid } from 'nanoid';
import {
  EXPIRED_GRACE_DAYS,
  RUN_NOTE_DAYS,
  TEAM_NOTE_DAYS,
  type NoteCounts,
  type NoteKind,
  type NoteScope,
  type NoteSource,
  type NoteStatus,
  type TeamNote,
} from '../../shared/notebook';
import { database } from '../db';

const DAY_MS = 86_400_000;

interface Row {
  id: string;
  team_id: string;
  project_id: string | null;
  run_id: string | null;
  workflow_id: string | null;
  kind: string;
  text: string;
  scope: string;
  status: string;
  author: string;
  author_id: string | null;
  source: string;
  tainted: number;
  answer: string | null;
  embedding: string | null;
  embedding_model: string | null;
  dispute_of: string | null;
  superseded_by: string | null;
  promoted_from: string | null;
  proposal_id: string | null;
  verified_at: string | null;
  verified_by: string | null;
  created_at: string;
  updated_at: string;
  last_access_at: string;
  expires_at: string | null;
}

/** Everything but the embedding: lists don't carry vectors. */
const COLUMNS =
  'id, team_id, project_id, run_id, workflow_id, kind, text, scope, status, author, author_id, source, tainted, answer, (embedding IS NOT NULL) AS embedded, dispute_of, superseded_by, promoted_from, proposal_id, verified_at, verified_by, created_at, updated_at, last_access_at, expires_at';

type ListRow = Omit<Row, 'embedding' | 'embedding_model'> & { embedded: number };

function revive(row: ListRow): TeamNote {
  let source: NoteSource = {};
  try {
    source = JSON.parse(row.source) as NoteSource;
  } catch {
    // A source that doesn't parse is a note without provenance, not a broken notebook.
  }
  return {
    id: row.id,
    teamId: row.team_id,
    ...(row.project_id && { projectId: row.project_id }),
    ...(row.run_id && { runId: row.run_id }),
    ...(row.workflow_id && { workflowId: row.workflow_id }),
    kind: row.kind as NoteKind,
    text: row.text,
    scope: row.scope as NoteScope,
    status: row.status as NoteStatus,
    author: row.author,
    ...(row.author_id && { authorId: row.author_id }),
    source,
    tainted: Boolean(row.tainted),
    ...(row.answer && { answer: row.answer }),
    ...(row.superseded_by && { supersededBy: row.superseded_by }),
    ...(row.dispute_of && { disputes: row.dispute_of }),
    ...(row.promoted_from && { promotedFrom: row.promoted_from as NoteScope }),
    ...(row.proposal_id && { proposalId: row.proposal_id }),
    ...(row.verified_at && { verifiedAt: row.verified_at }),
    ...(row.verified_by && { verifiedBy: row.verified_by }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastAccessAt: row.last_access_at,
    ...(row.expires_at && { expiresAt: row.expires_at }),
    embedded: Boolean(row.embedded),
  };
}

const iso = (ms: number) => new Date(ms).toISOString();

/** Change columns of a row. An upsert needs the whole row (the NOT NULL columns are checked before the conflict), so it is read first. */
function change(id: string, columns: Record<string, string | number | null>): boolean {
  const row = database().get<Row>('SELECT * FROM team_notes WHERE id = ?', id);
  if (!row) return false;
  database().upsert('team_notes', { ...row, ...columns });
  return true;
}

/** When a note goes, by its scope and standing, counted from `now`. Undefined: never. */
export function expiryOf(scope: NoteScope, verified: boolean, now = Date.now()): string | undefined {
  if (scope === 'project') return undefined;
  if (scope === 'run') return iso(now + RUN_NOTE_DAYS * DAY_MS);
  return verified ? undefined : iso(now + TEAM_NOTE_DAYS * DAY_MS);
}

export interface NewNote {
  teamId: string;
  projectId?: string;
  runId?: string;
  workflowId?: string;
  kind: NoteKind;
  text: string;
  scope?: NoteScope;
  status?: NoteStatus;
  author: string;
  authorId?: string;
  source?: NoteSource;
  tainted?: boolean;
  disputes?: string;
  verifiedBy?: string;
}

export interface NoteFilter {
  teamId: string;
  /** The team's project: its project-scope notes (from any team there) are included. */
  projectId?: string;
  /** Include this run's notes (else run-scope notes are left out). */
  runId?: string;
  /** Include the notes of every run (the Notebook tab, which a person reads across runs). */
  allRuns?: boolean;
  scopes?: NoteScope[];
  kinds?: NoteKind[];
  statuses?: NoteStatus[];
  /** Only notes of this run, whatever their scope. */
  onlyRun?: string;
  expired?: boolean;
  limit?: number;
}

export const noteStore = {
  insert(input: NewNote): TeamNote {
    const now = Date.now();
    const scope = input.scope ?? 'run';
    const status = input.status ?? (input.kind === 'open_question' ? 'open' : 'unverified');
    const verified = status === 'verified';
    const row = {
      id: `note_${nanoid(10)}`,
      team_id: input.teamId,
      project_id: input.projectId ?? null,
      run_id: input.runId ?? null,
      workflow_id: input.workflowId ?? null,
      kind: input.kind,
      text: input.text,
      scope,
      status,
      author: input.author,
      author_id: input.authorId ?? null,
      source: JSON.stringify(input.source ?? {}),
      tainted: input.tainted ? 1 : 0,
      dispute_of: input.disputes ?? null,
      verified_at: verified ? iso(now) : null,
      verified_by: verified ? (input.verifiedBy ?? input.author) : null,
      created_at: iso(now),
      updated_at: iso(now),
      last_access_at: iso(now),
      expires_at: expiryOf(scope, verified, now) ?? null,
    };
    database().upsert('team_notes', row);
    return this.get(row.id)!;
  },

  get(id: string): TeamNote | undefined {
    const row = database().get<ListRow>(`SELECT ${COLUMNS} FROM team_notes WHERE id = ?`, id);
    return row ? revive(row) : undefined;
  },

  /** The notes a team (and, for run-scope ones, a run) sees, newest first. */
  list(filter: NoteFilter): TeamNote[] {
    const where: string[] = [];
    const params: Array<string | number | null> = [];
    if (filter.onlyRun) {
      where.push('team_id = ? AND run_id = ?');
      params.push(filter.teamId, filter.onlyRun);
    } else {
      // Team notes of this team, project notes of its project (or that it wrote), and the run's own.
      const parts = ['(team_id = ? AND scope = ?)', '(scope = ? AND (team_id = ?' + (filter.projectId ? ' OR project_id = ?' : '') + '))'];
      params.push(filter.teamId, 'team', 'project', filter.teamId);
      if (filter.projectId) params.push(filter.projectId);
      if (filter.allRuns) {
        parts.push('(team_id = ? AND scope = ?)');
        params.push(filter.teamId, 'run');
      } else if (filter.runId) {
        parts.push('(team_id = ? AND scope = ? AND run_id = ?)');
        params.push(filter.teamId, 'run', filter.runId);
      }
      where.push(`(${parts.join(' OR ')})`);
    }
    if (filter.scopes?.length) {
      where.push(`scope IN (${filter.scopes.map(() => '?').join(', ')})`);
      params.push(...filter.scopes);
    }
    if (filter.kinds?.length) {
      where.push(`kind IN (${filter.kinds.map(() => '?').join(', ')})`);
      params.push(...filter.kinds);
    }
    if (filter.statuses?.length) {
      where.push(`status IN (${filter.statuses.map(() => '?').join(', ')})`);
      params.push(...filter.statuses);
    } else if (!filter.expired) where.push("status <> 'expired'");
    const rows = database().all<ListRow>(`SELECT ${COLUMNS} FROM team_notes WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ${Math.max(1, Math.min(1000, filter.limit ?? 500))}`, ...params);
    return rows.map(revive);
  },

  /** Every note a team wrote, whatever its scope or standing (for settling disputes and deleting). */
  all(teamId: string): TeamNote[] {
    return database().all<ListRow>(`SELECT ${COLUMNS} FROM team_notes WHERE team_id = ? ORDER BY created_at DESC LIMIT 5000`, teamId).map(revive);
  },

  /** A note's changes (columns by name): `updated_at` moves with them. */
  patch(id: string, columns: Record<string, string | number | null>): TeamNote | undefined {
    return change(id, { ...columns, updated_at: iso(Date.now()) }) ? this.get(id) : undefined;
  },

  delete(id: string): boolean {
    return database().delete('team_notes', { id }) > 0;
  },

  /** The vectors of some notes, by id (only those that have one). */
  vectors(ids: string[]): Map<string, number[]> {
    const out = new Map<string, number[]>();
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200);
      for (const row of database().all<{ id: string; embedding: string }>(`SELECT id, embedding FROM team_notes WHERE embedding IS NOT NULL AND id IN (${chunk.map(() => '?').join(', ')})`, ...chunk)) {
        try {
          out.set(row.id, JSON.parse(row.embedding) as number[]);
        } catch {
          // An unreadable vector is a note found by its words.
        }
      }
    }
    return out;
  },

  setEmbedding(id: string, vector: number[], model: string) {
    change(id, { embedding: JSON.stringify(vector), embedding_model: model });
  },

  /** Notes were read for a run: their last access moves, and an unverified team note's expiry with it. */
  touch(notes: TeamNote[], now = Date.now()) {
    for (const note of notes) {
      if (note.status === 'expired') continue;
      const expires: Record<string, string | null> = note.scope === 'team' && note.status !== 'verified' ? { expires_at: expiryOf('team', false, now) ?? null } : {};
      change(note.id, { last_access_at: iso(now), ...expires });
    }
  },

  /** The tab's headline: what the list holds under the same scope (and run), whatever kind or status the tab picked, so the tiles can switch between kinds. */
  counts(teamId: string, projectId?: string, within: Pick<NoteFilter, 'scopes' | 'onlyRun' | 'expired'> = {}): NoteCounts {
    const notes = this.list({ teamId, ...(projectId && { projectId }), allRuns: true, ...within });
    const count = (test: (n: TeamNote) => boolean) => notes.filter(test).length;
    return {
      open: count((n) => n.kind === 'open_question' && n.status === 'open'),
      decisions: count((n) => n.kind === 'decision'),
      facts: count((n) => n.kind !== 'decision' && n.kind !== 'open_question'),
      disputed: count((n) => n.status === 'disputed'),
      total: notes.length,
    };
  },

  /**
   * Time passes: notes past their expiry become `expired` (the tab can still show them for a while), and those expired
   * longer than the grace period are deleted. Returns how many of each.
   */
  expire(now = Date.now()): { expired: number; deleted: number } {
    const db = database();
    const due = db.all<{ id: string }>("SELECT id FROM team_notes WHERE expires_at IS NOT NULL AND expires_at <= ? AND status <> 'expired'", iso(now));
    for (const { id } of due) change(id, { status: 'expired', updated_at: iso(now) });
    const deleted = db.deleteBefore('team_notes', 'expires_at', iso(now - EXPIRED_GRACE_DAYS * DAY_MS));
    return { expired: due.length, deleted };
  },

  /** Every note of a team (when it is deleted). */
  deleteTeam(teamId: string): number {
    return database().delete('team_notes', { team_id: teamId });
  },
};
