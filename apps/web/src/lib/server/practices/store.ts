/**
 * The practices store (docs/practices.md): the `practices`, `practice_versions` and `practice_applications` tables
 * (migrations 2400 to 2402). Everything written is cleaned here, hashed, and a new version is always a draft: only
 * approval (./approve) changes what agents get. `approvedPractices()` is what selection reads: approved versions only,
 * re-hashed on every read.
 */
import { createHash } from 'node:crypto';
import { nanoid } from 'nanoid';
import {
  PRACTICE_HANDLE,
  PRACTICE_LEVELS,
  PRACTICE_LIMITS,
  PRACTICE_REPO,
  PRACTICE_SHA,
  PRACTICE_STRENGTHS,
  PRACTICE_TOPIC,
  practiceGlob,
  type ApprovedPractice,
  type Practice,
  type PracticeApplication,
  type PracticeApplicationInput,
  type PracticeCheck,
  type PracticeCitation,
  type PracticeDraftInput,
  type PracticeLevel,
  type PracticeSource,
  type PracticeStatus,
  type PracticeStrength,
  type PracticeVersion,
} from '../../shared/practices';
import { recordAudit } from '../audit';
import { currentPrincipal } from '../auth/guard';
import { changeOrigin } from '../brain/store/origin'; // NB01
import { emitBrainChange } from '../brain/store/port'; // NB01
import { database } from '../db';
import { homeProjectId, getProject } from '../projects/store';
import { projectRole, type Actor } from '../projects/access';
import { projectRoleCan } from '../../shared/projects';
import { redactPatterns, redactText } from '../secrets/redact';
import { logger } from '../telemetry/logger';
import { verifyCitations } from './citations';
import { fileDraftSuggestion } from './inbox'; // PR09:
import { PracticeError, PracticeHandleTaken } from './errors';
import type { PracticeDraftOrigin } from './port';

/* -------------------------------------------------------------------------------------------------------------- rows */

interface PracticeRow {
  id: string;
  handle: string;
  scope_key: string;
  title: string;
  level: string;
  project_id: string | null;
  strength: string;
  topics: string;
  repos: string;
  paths: string;
  owner_id: string | null;
  status: string;
  approved_version: number | null;
  supersedes: string | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
}

interface VersionRow {
  practice_id: string;
  version: number;
  title: string;
  strength: string;
  topics: string;
  repos: string;
  paths: string;
  summary: string;
  body: string;
  checks: string;
  citations: string;
  source: string;
  tainted: number;
  drafted_by: string | null;
  created_at: string;
  approved_by: string | null;
  approved_at: string | null;
  rejected_by: string | null;
  rejected_at: string | null;
  reject_reason: string | null;
  sha256: string;
}

interface ApplicationRow {
  id: string;
  practice_id: string;
  version: number;
  kind: string;
  execution_id: string | null;
  agent_id: string | null;
  user_id: string | null;
  repo: string | null;
  reason: string | null;
  at: string;
}

const json = <T>(text: string, fallback: T): T => {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
};

export const scopeKey = (level: PracticeLevel, projectId?: string) => (level === 'project' && projectId ? projectId : '*');

export function practiceOf(row: PracticeRow): Practice {
  return {
    id: row.id,
    handle: row.handle,
    title: row.title,
    level: row.level as PracticeLevel,
    ...(row.project_id && { projectId: row.project_id }),
    strength: row.strength as PracticeStrength,
    topics: json<string[]>(row.topics, []),
    repos: json<string[]>(row.repos, []),
    paths: json<string[]>(row.paths, []),
    ...(row.owner_id && { ownerId: row.owner_id }),
    status: row.status as PracticeStatus,
    ...(row.approved_version !== null && { approvedVersion: Number(row.approved_version) }),
    ...(row.supersedes && { supersedes: row.supersedes }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.created_by && { createdBy: row.created_by }),
  };
}

export function versionOf(row: VersionRow): PracticeVersion {
  return {
    practiceId: row.practice_id,
    version: Number(row.version),
    title: row.title,
    strength: row.strength as PracticeStrength,
    topics: json<string[]>(row.topics, []),
    repos: json<string[]>(row.repos, []),
    paths: json<string[]>(row.paths, []),
    summary: row.summary,
    body: row.body,
    checks: json<PracticeCheck[]>(row.checks, []),
    citations: json<PracticeCitation[]>(row.citations, []),
    source: row.source as PracticeSource,
    tainted: Boolean(Number(row.tainted)),
    ...(row.drafted_by && { draftedBy: row.drafted_by }),
    createdAt: row.created_at,
    ...(row.approved_by && { approvedBy: row.approved_by }),
    ...(row.approved_at && { approvedAt: row.approved_at }),
    ...(row.rejected_by && { rejectedBy: row.rejected_by }),
    ...(row.rejected_at && { rejectedAt: row.rejected_at }),
    ...(row.reject_reason && { rejectReason: row.reject_reason }),
    sha256: row.sha256,
  };
}

export function applicationOf(row: ApplicationRow): PracticeApplication {
  return {
    id: row.id,
    practiceId: row.practice_id,
    version: Number(row.version),
    kind: row.kind as PracticeApplication['kind'],
    ...(row.execution_id && { executionId: row.execution_id }),
    ...(row.agent_id && { agentId: row.agent_id }),
    ...(row.user_id && { userId: row.user_id }),
    ...(row.repo && { repo: row.repo }),
    ...(row.reason && { reason: row.reason }),
    at: row.at,
  };
}

/* ----------------------------------------------------------------------------------------------------- cleaning, hash */

type Fields = Pick<PracticeVersion, 'title' | 'strength' | 'topics' | 'repos' | 'paths' | 'summary' | 'body' | 'checks'>;

/** The hash agents' text is pinned by: title, strength, topics, repos, paths, summary, body and checks, in that key order. */
export const hashFields = (f: Fields): string =>
  createHash('sha256')
    .update(JSON.stringify({ title: f.title, strength: f.strength, topics: f.topics, repos: f.repos, paths: f.paths, summary: f.summary, body: f.body, checks: f.checks }))
    .digest('hex');

/** A one-line value: secrets redacted, control characters removed, newlines to spaces, spaces collapsed. */
const oneLine = (value: string) =>
  redactPatterns(redactText(value))
    .replace(/\r\n|\r|\n|\t/g, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/** Markdown: secrets redacted, control characters other than newline and tab removed. */
const multiLine = (value: string) =>
  redactPatterns(redactText(value))
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .trim();

const bare = (value: string) => value.replace(/[\u0000-\u001f\u007f]/g, '').trim();

const fail = (message: string): never => {
  throw new PracticeError(message, 400);
};

function cleanList(values: readonly string[] | undefined, name: string, max: number, ok: (v: string) => boolean, rule: string): string[] {
  const out = [...new Set((values ?? []).map((v) => bare(String(v))).filter(Boolean))].sort();
  if (out.length > max) fail(`At most ${max} ${name}`);
  const bad = out.find((v) => !ok(v));
  if (bad !== undefined) fail(`“${bad}” is not a valid ${rule}`);
  return out;
}

function compilesGlob(glob: string): boolean {
  try {
    practiceGlob(glob);
    return true;
  } catch {
    return false;
  }
}

function cleanGlob(value: unknown, name: string): string {
  const glob = bare(String(value ?? ''));
  if (!glob) fail(`${name} needs a glob`);
  if (glob.length > PRACTICE_LIMITS.glob) fail(`${name} is longer than ${PRACTICE_LIMITS.glob} characters`);
  if (!compilesGlob(glob)) fail(`${name} “${glob}” is not a glob`);
  return glob;
}

function cleanChecks(input: readonly PracticeCheck[] | undefined): PracticeCheck[] {
  const list = input ?? [];
  if (list.length > PRACTICE_LIMITS.checks) fail(`At most ${PRACTICE_LIMITS.checks} checks`);
  return list.map((check, index): PracticeCheck => {
    const at = `Check ${index + 1}`;
    const raw = check as unknown as Record<string, unknown>;
    if (raw.kind === 'pathExists') return { kind: 'pathExists', glob: cleanGlob(raw.glob, `${at} glob`), ...(raw.when !== undefined && raw.when !== '' && { when: cleanGlob(raw.when, `${at} when`) }) };
    if (raw.kind === 'pathAbsent') return { kind: 'pathAbsent', glob: cleanGlob(raw.glob, `${at} glob`), ...(raw.unless !== undefined && raw.unless !== '' && { unless: cleanGlob(raw.unless, `${at} unless`) }) };
    if (raw.kind === 'fileMatches') {
      const pattern = bare(String(raw.pattern ?? ''));
      if (!pattern) fail(`${at} needs a pattern`);
      if (pattern.length > PRACTICE_LIMITS.pattern) fail(`${at} pattern is longer than ${PRACTICE_LIMITS.pattern} characters`);
      try {
        new RegExp(pattern);
      } catch {
        fail(`${at} pattern “${pattern}” is not a regular expression`);
      }
      return { kind: 'fileMatches', glob: cleanGlob(raw.glob, `${at} glob`), pattern, ...(raw.absent === true && { absent: true }) };
    }
    return fail(`${at} has an unknown kind`);
  });
}

/** What the draft says about itself, cleaned: throws PracticeError 400 naming what is wrong. */
export function cleanFields(input: Pick<PracticeDraftInput, 'title' | 'strength' | 'topics' | 'repos' | 'paths' | 'summary' | 'body' | 'checks'>): Fields {
  const title = oneLine(String(input.title ?? ''));
  const summary = oneLine(String(input.summary ?? ''));
  const body = multiLine(String(input.body ?? ''));
  if (!title) fail('Give the practice a title');
  if (title.length > PRACTICE_LIMITS.title) fail(`The title is longer than ${PRACTICE_LIMITS.title} characters`);
  if (!summary) fail('Give the practice a one-line summary');
  if (summary.length > PRACTICE_LIMITS.summary) fail(`The summary is longer than ${PRACTICE_LIMITS.summary} characters`);
  if (!body) fail('Write the rules in the body');
  if (body.length > PRACTICE_LIMITS.body) fail(`The body is longer than ${PRACTICE_LIMITS.body} characters`);
  if (!PRACTICE_STRENGTHS.includes(input.strength)) fail('Strength is required or recommended');
  const paths = cleanList(input.paths, 'paths', PRACTICE_LIMITS.paths, () => true, 'glob');
  for (const glob of paths) cleanGlob(glob, 'A path');
  return {
    title,
    strength: input.strength,
    topics: cleanList(input.topics, 'topics', PRACTICE_LIMITS.topics, (v) => PRACTICE_TOPIC.test(v), 'topic (lowercase letters, digits and dashes)'),
    repos: cleanList(input.repos, 'repositories', PRACTICE_LIMITS.repos, (v) => PRACTICE_REPO.test(v), 'repository (owner/name)'),
    paths,
    summary,
    body,
    checks: cleanChecks(input.checks),
  };
}

/** Citations checked for shape; `verified` set only by `verifyCitations` against the files a trusted flow read. */
function cleanCitations(input: PracticeDraftInput['citations'], files: PracticeDraftOrigin['files'], earlier: readonly PracticeCitation[]): PracticeCitation[] {
  const list = input ?? [];
  if (list.length > PRACTICE_LIMITS.citations) fail(`At most ${PRACTICE_LIMITS.citations} citations`);
  const shaped = list.map((c, index) => {
    const at = `Citation ${index + 1}`;
    const repo = bare(String(c.repo ?? ''));
    const sha = bare(String(c.sha ?? '')).toLowerCase();
    const path = bare(String(c.path ?? ''));
    const excerpt = String(c.excerpt ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
    if (!PRACTICE_REPO.test(repo)) fail(`${at}: the repository is owner/name`);
    if (!PRACTICE_SHA.test(sha)) fail(`${at}: the commit is 7 to 40 hex characters`);
    if (!path || path.length > 300) fail(`${at}: give the file path`);
    if (!excerpt.trim()) fail(`${at}: quote the lines it rests on`);
    if (excerpt.length > PRACTICE_LIMITS.excerpt) fail(`${at}: the excerpt is longer than ${PRACTICE_LIMITS.excerpt} characters`);
    const lines = c.lines && Number.isInteger(c.lines[0]) && Number.isInteger(c.lines[1]) && c.lines[0] >= 1 && c.lines[1] >= c.lines[0] ? ([c.lines[0], c.lines[1]] as [number, number]) : undefined;
    return { repo, sha, path, ...(lines && { lines }), excerpt };
  });
  return verifyCitations(shaped, files).map((citation) => {
    // The same excerpt of the same file that an earlier version had verified stays verified: the text is the same.
    const kept = earlier.some((e) => e.verified && e.repo === citation.repo && e.sha === citation.sha && e.path === citation.path && e.excerpt === citation.excerpt);
    return { ...citation, verified: citation.verified || kept, excerpt: redactPatterns(redactText(citation.excerpt)) };
  });
}

/* ----------------------------------------------------------------------------------------------------------- reads */

const db = () => database();

export function getPractice(id: string): Practice | undefined {
  const row = db().get<PracticeRow>('SELECT * FROM practices WHERE id = ?', id);
  return row && practiceOf(row);
}

/** Newest first. */
export function versionsOf(practiceId: string): PracticeVersion[] {
  return db().all<VersionRow>('SELECT * FROM practice_versions WHERE practice_id = ? ORDER BY version DESC', practiceId).map(versionOf);
}

export function getVersion(practiceId: string, version: number): PracticeVersion | undefined {
  const row = db().get<VersionRow>('SELECT * FROM practice_versions WHERE practice_id = ? AND version = ?', practiceId, version);
  return row && versionOf(row);
}

/** Versions of many practices at once (newest first within each). */
export function versionsFor(ids: readonly string[]): Map<string, PracticeVersion[]> {
  const out = new Map<string, PracticeVersion[]>();
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const rows = db().all<VersionRow>(`SELECT * FROM practice_versions WHERE practice_id IN (${chunk.map(() => '?').join(',')}) ORDER BY version DESC`, ...chunk);
    for (const row of rows) out.set(row.practice_id, [...(out.get(row.practice_id) ?? []), versionOf(row)]);
  }
  return out;
}

export interface PracticeFilter {
  status?: PracticeStatus[];
  level?: PracticeLevel;
  projectId?: string;
  /** Only org practices and those of these projects (a viewer who is not an owner or admin). */
  withinProjects?: readonly string[];
  topic?: string;
  q?: string;
  limit?: number;
}

export function listPractices(filter: PracticeFilter = {}): Practice[] {
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (filter.status?.length) {
    where.push(`status IN (${filter.status.map(() => '?').join(',')})`);
    params.push(...filter.status);
  }
  if (filter.level) {
    where.push('level = ?');
    params.push(filter.level);
  }
  if (filter.projectId) {
    where.push('project_id = ?');
    params.push(filter.projectId);
  }
  if (filter.withinProjects) {
    const ids = filter.withinProjects.slice(0, 500);
    where.push(`(level = 'org'${ids.length ? ` OR project_id IN (${ids.map(() => '?').join(',')})` : ''})`);
    params.push(...ids);
  }
  if (filter.topic) {
    where.push(`topics LIKE ? ESCAPE '\\'`);
    params.push(`%"${filter.topic.replace(/[\\%_]/g, '\\$&')}"%`);
  }
  if (filter.q) {
    where.push(`(LOWER(handle) LIKE ? ESCAPE '\\' OR LOWER(title) LIKE ? ESCAPE '\\')`);
    const like = `%${filter.q.toLowerCase().replace(/[\\%_]/g, '\\$&')}%`;
    params.push(like, like);
  }
  const sql = `SELECT * FROM practices${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY updated_at DESC, id LIMIT ?`;
  return db()
    .all<PracticeRow>(sql, ...params, Math.min(filter.limit ?? PRACTICE_LIMITS.list, PRACTICE_LIMITS.list))
    .map(practiceOf);
}

/** Practices with a version nobody has decided on: [practice id, version] pairs. */
export function pendingVersions(): Array<{ practiceId: string; version: number }> {
  return db()
    .all<{ practice_id: string; version: number }>(
      `SELECT v.practice_id, v.version FROM practice_versions v JOIN practices p ON p.id = v.practice_id
       WHERE v.rejected_at IS NULL AND v.approved_at IS NULL AND v.version > COALESCE(p.approved_version, 0)`,
    )
    .map((r) => ({ practiceId: r.practice_id, version: Number(r.version) }));
}

/** Approved practices as selection reads them: org ones and those of `projectIds`, approved versions only, re-hashed here. */
export function approvedPractices(scope: { projectIds: readonly string[] | 'all' }): ApprovedPractice[] {
  const rows: PracticeRow[] = [];
  if (scope.projectIds === 'all') {
    rows.push(...db().all<PracticeRow>(`SELECT * FROM practices WHERE status = 'approved' AND approved_version IS NOT NULL`));
  } else {
    rows.push(...db().all<PracticeRow>(`SELECT * FROM practices WHERE status = 'approved' AND approved_version IS NOT NULL AND level = 'org'`));
    for (let i = 0; i < scope.projectIds.length; i += 200) {
      const chunk = scope.projectIds.slice(i, i + 200);
      rows.push(...db().all<PracticeRow>(`SELECT * FROM practices WHERE status = 'approved' AND approved_version IS NOT NULL AND project_id IN (${chunk.map(() => '?').join(',')})`, ...chunk));
    }
  }
  const out: ApprovedPractice[] = [];
  for (const row of rows) {
    const practice = practiceOf(row);
    const version = getVersion(practice.id, practice.approvedVersion!);
    if (!version?.approvedAt) {
      logger.warn('a practice has no approved version row; left out', { 'landflow.practice.handle': practice.handle });
      continue;
    }
    if (hashFields(version) !== version.sha256) {
      logger.warn('a practice version no longer matches its hash; left out', { 'landflow.practice.handle': practice.handle, 'landflow.practice.version': version.version });
      continue;
    }
    out.push({
      id: practice.id,
      handle: practice.handle,
      title: version.title,
      level: practice.level,
      ...(practice.projectId && { projectId: practice.projectId }),
      strength: version.strength,
      topics: version.topics,
      repos: version.repos,
      paths: version.paths,
      version: version.version,
      summary: version.summary,
      body: version.body,
      checks: version.checks,
      sha256: version.sha256,
      approvedAt: version.approvedAt,
      ...(practice.supersedes && { supersedes: practice.supersedes }),
    });
  }
  return out;
}

/** NB01: one change for a practice (the project it lives in; none for org). */
function emitPractice(practice: Practice, version: number, op: 'upsert' | 'delete', explicit?: 'notion'): void {
  emitBrainChange({ kind: 'practice', key: practice.id, ...(practice.projectId && { projectId: practice.projectId }), op, version, ...changeOrigin(explicit), at: new Date().toISOString() });
}

/* ------------------------------------------------------------------------------------------------------ drafting */

/** Whether `actor` may draft at this level and project (an org practice: anyone signed in). */
export function canDraftAt(actor: Actor | undefined, level: PracticeLevel, projectId: string | undefined): boolean {
  if (!actor) return false;
  return level === 'org' ? true : projectRoleCan.create(projectRole(actor, projectId));
}

function mayDraft(level: PracticeLevel, projectId: string | undefined, origin: PracticeDraftOrigin): boolean {
  // NB01: the Notion puller (server code acting for a link a project admin made) drafts at project level only; org practices are never pulled.
  if (origin.source === 'notion') return level === 'project' && Boolean(projectId);
  if (canDraftAt(origin.actor, level, projectId)) return true;
  if (!origin.workflowId) return false;
  return level === 'org' || homeProjectId('workflow', origin.workflowId) === projectId;
}

const draftedBy = (origin: PracticeDraftOrigin): string | undefined =>
  origin.agentId ? `agent:${origin.agentId}` : origin.workflowId ? `workflow:${origin.workflowId}` : origin.actor ? `user:${origin.actor.id}` : undefined;

/**
 * Who a request's draft comes from: a signed-in session's own typing is a person's; anything else (an API key, MCP, the mod)
 * is `learned` when it cites a repository and `agent` when it does not, and is tainted.
 */
export function routeOrigin(citations: number): PracticeDraftOrigin {
  const principal = currentPrincipal();
  const person = principal?.via === 'session' || principal?.via === 'test';
  return { source: person ? 'person' : citations ? 'learned' : 'agent', ...(principal && { actor: principal.user }) };
}

/**
 * Save a draft version: a new practice, or the next version of `input.practiceId`. A new version changes nothing agents
 * get until a person approves it. Throws PracticeError (400, 403, 404) or PracticeHandleTaken (409).
 */
export function draftPractice(input: PracticeDraftInput, origin: PracticeDraftOrigin): { practice: Practice; version: PracticeVersion } {
  const existing = input.practiceId ? getPractice(input.practiceId) : undefined;
  if (input.practiceId && !existing) throw new PracticeError('Practice not found', 404);
  const level = existing?.level ?? input.level;
  const projectId = existing ? existing.projectId : input.projectId;
  const handle = existing?.handle ?? bare(String(input.handle ?? ''));

  if (!existing) {
    if (!PRACTICE_LEVELS.includes(level)) fail('Level is org or project');
    if (!PRACTICE_HANDLE.test(handle)) fail('The handle is two or three lowercase parts, such as helm/chart-location');
    if (level === 'org' && projectId) fail('An org practice has no project');
    if (level === 'project') {
      if (!projectId) fail('A project practice needs a projectId');
      if (!getProject(projectId!)) throw new PracticeError('Project not found', 404);
    }
  }
  if (!mayDraft(level, projectId, origin)) {
    if (existing && level === 'project' && origin.actor && !projectRole(origin.actor, projectId)) throw new PracticeError('Practice not found', 404);
    throw new PracticeError(level === 'org' ? 'Sign in to draft a practice' : 'Only editors and admins of the project can draft a project practice', 403);
  }

  const fields = cleanFields(input);
  const earlier = existing ? versionsOf(existing.id) : [];
  const newest = earlier[0];
  const citations = cleanCitations(input.citations, origin.files, newest?.citations ?? []);
  const person = origin.source === 'person' && Boolean(origin.actor);
  const source: PracticeSource = person ? 'person' : origin.source === 'person' ? 'agent' : origin.source;
  // A person's edit of a draft nobody has reviewed yet does not make it reviewed.
  const tainted = !person || Boolean(newest?.tainted && !newest.approvedAt);
  const now = new Date().toISOString();
  const by = draftedBy(origin);
  const key = scopeKey(level, projectId);

  const saved = db().transaction(() => {
    let practice = existing;
    if (!practice) {
      if (db().get('SELECT id FROM practices WHERE scope_key = ? AND handle = ?', key, handle)) throw new PracticeHandleTaken(handle);
      practice = {
        id: `prc_${nanoid(10)}`,
        handle,
        title: fields.title,
        level,
        ...(level === 'project' && projectId && { projectId }),
        strength: fields.strength,
        topics: fields.topics,
        repos: fields.repos,
        paths: fields.paths,
        ...(origin.actor && person && { ownerId: origin.actor.id }),
        status: 'draft',
        createdAt: now,
        updatedAt: now,
        ...(by && { createdBy: by }),
      };
      db().insertNew('practices', {
        id: practice.id,
        handle,
        scope_key: key,
        title: fields.title,
        level,
        project_id: practice.projectId ?? null,
        strength: fields.strength,
        topics: JSON.stringify(fields.topics),
        repos: JSON.stringify(fields.repos),
        paths: JSON.stringify(fields.paths),
        owner_id: practice.ownerId ?? null,
        status: 'draft',
        approved_version: null,
        supersedes: null,
        created_at: now,
        updated_at: now,
        created_by: by ?? null,
      });
    } else {
      patchPractice(practice.id, { updated_at: now });
      practice = { ...practice, updatedAt: now };
    }
    const version: PracticeVersion = {
      practiceId: practice.id,
      version: (newest?.version ?? 0) + 1,
      ...fields,
      citations,
      source,
      tainted,
      ...(by && { draftedBy: by }),
      createdAt: now,
      sha256: hashFields(fields),
    };
    db().insertNew('practice_versions', {
      practice_id: version.practiceId,
      version: version.version,
      title: fields.title,
      strength: fields.strength,
      topics: JSON.stringify(fields.topics),
      repos: JSON.stringify(fields.repos),
      paths: JSON.stringify(fields.paths),
      summary: fields.summary,
      body: fields.body,
      checks: JSON.stringify(fields.checks),
      citations: JSON.stringify(citations),
      source,
      tainted: tainted ? 1 : 0,
      drafted_by: by ?? null,
      created_at: now,
      approved_by: null,
      approved_at: null,
      rejected_by: null,
      rejected_at: null,
      reject_reason: null,
      sha256: version.sha256,
    });
    return { practice, version };
  });

  recordAudit({
    action: 'practice.drafted',
    target: { type: 'practice', id: saved.practice.id, name: saved.practice.handle },
    details: { version: saved.version.version, source, tainted, level },
    project: saved.practice.projectId ?? null,
  });
  fileDraftSuggestion(saved.practice, saved.version); // PR09: the draft waits in the inbox
  emitPractice(saved.practice, saved.version.version, 'upsert', origin.source === 'notion' ? 'notion' : undefined); // NB01
  return saved;
}

/* ------------------------------------------------------------------------------------------- decisions (./approve) */

/** Rewrite the named columns of one row (a whole row goes to `upsert`, so the NOT NULL columns are always there). */
function patchPractice(id: string, patch: Partial<Record<keyof PracticeRow, string | number | null>>): void {
  const row = db().get<PracticeRow>('SELECT * FROM practices WHERE id = ?', id);
  if (row) db().upsert('practices', { ...row, ...patch });
}

function patchVersion(practiceId: string, version: number, patch: Partial<Record<keyof VersionRow, string | number | null>>): void {
  const row = db().get<VersionRow>('SELECT * FROM practice_versions WHERE practice_id = ? AND version = ?', practiceId, version);
  if (row) db().upsert('practice_versions', { ...row, ...patch });
}

/** Write the approval: the version's own fields move to the practice, which is `approved` from now on. */
export function markApproved(practice: Practice, version: PracticeVersion, by: string, superseded: string[]): Practice {
  const now = new Date().toISOString();
  patchVersion(practice.id, version.version, { approved_by: by, approved_at: now });
  patchPractice(practice.id, {
    title: version.title,
    strength: version.strength,
    topics: JSON.stringify(version.topics),
    repos: JSON.stringify(version.repos),
    paths: JSON.stringify(version.paths),
    status: 'approved',
    approved_version: version.version,
    supersedes: superseded[0] ?? practice.supersedes ?? null,
    updated_at: now,
  });
  const approved = getPractice(practice.id)!;
  emitPractice(approved, version.version, 'upsert'); // NB01
  return approved;
}

export function markRejected(practiceId: string, version: number, by: string, reason: string): void {
  const now = new Date().toISOString();
  patchVersion(practiceId, version, { rejected_by: by, rejected_at: now, reject_reason: reason });
  patchPractice(practiceId, { updated_at: now });
  const practice = getPractice(practiceId); // NB01
  if (practice) emitPractice(practice, version, 'upsert');
}

export function markRetired(practiceId: string): Practice {
  patchPractice(practiceId, { status: 'retired', updated_at: new Date().toISOString() });
  const retired = getPractice(practiceId)!;
  emitPractice(retired, retired.approvedVersion ?? versionsOf(practiceId)[0]?.version ?? 0, 'upsert'); // NB01
  return retired;
}

/* -------------------------------------------------------------------------------------------------- applications */

export function insertApplication(row: Omit<PracticeApplication, 'id' | 'at'> & { at?: string }): PracticeApplication {
  const id = `pap_${nanoid(10)}`;
  const at = row.at ?? new Date().toISOString();
  db().insertNew('practice_applications', {
    id,
    practice_id: row.practiceId,
    version: row.version,
    kind: row.kind,
    execution_id: row.executionId ?? null,
    agent_id: row.agentId ?? null,
    user_id: row.userId ?? null,
    repo: row.repo ?? null,
    reason: row.reason ?? null,
    at,
  });
  return { id, practiceId: row.practiceId, version: row.version, kind: row.kind, ...(row.executionId && { executionId: row.executionId }), ...(row.agentId && { agentId: row.agentId }), ...(row.userId && { userId: row.userId }), ...(row.repo && { repo: row.repo }), ...(row.reason && { reason: row.reason }), at };
}

/** Never throws: a failed record is logged and the run goes on. */
export function recordApplication(row: PracticeApplicationInput): void {
  try {
    insertApplication(row);
  } catch (caught) {
    logger.warn('a practice application could not be recorded', { error: caught });
  }
}

export function findWaiver(practiceId: string, executionId: string): PracticeApplication | undefined {
  const row = db().get<ApplicationRow>(`SELECT * FROM practice_applications WHERE practice_id = ? AND execution_id = ? AND kind = 'waived' ORDER BY at, id LIMIT 1`, practiceId, executionId);
  return row && applicationOf(row);
}

/** Newest first, keyset-paged on (at, id). */
export function applicationsOf(practiceId: string, limit: number, after?: { s: string; i: string }): { applications: PracticeApplication[]; next?: { s: string; i: string } } {
  const rows = after
    ? db().all<ApplicationRow>(`SELECT * FROM practice_applications WHERE practice_id = ? AND (at < ? OR (at = ? AND id < ?)) ORDER BY at DESC, id DESC LIMIT ?`, practiceId, after.s, after.s, after.i, limit + 1)
    : db().all<ApplicationRow>(`SELECT * FROM practice_applications WHERE practice_id = ? ORDER BY at DESC, id DESC LIMIT ?`, practiceId, limit + 1);
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return { applications: page.map(applicationOf), ...(rows.length > limit && last && { next: { s: last.at, i: last.id } }) };
}
