/**
 * What the Practices screens decide, as pure functions (docs/practices.md): how the view groups practices, when a row is
 * amber, the sentence a machine check reads as, the text a review diffs, what the review dialog allows and sends, and
 * the form's validation. The components only draw these. No zod: the browser loads this file.
 */
import {
  PRACTICE_HANDLE,
  PRACTICE_LEVEL_LABELS,
  PRACTICE_LIMITS,
  PRACTICE_REPO,
  PRACTICE_STRENGTH_LABELS,
  PRACTICE_TOPIC,
  type PracticeApproveInput,
  type PracticeCheck,
  type PracticeCitation,
  type PracticeConflict,
  type PracticeDraftInput,
  type PracticeLevel,
  type PracticeStrength,
  type PracticeVersion,
  type PracticeVersionState,
  type PracticeView,
} from '@/lib/shared/practices';
import { diffHunks, type DiffHunk } from '@/lib/shared/run-changes';

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------

export interface PracticeFolder {
  path: string;
  name: string;
  items: PracticeView[];
}
export interface PracticeGroup {
  /** `org` or `project:<id>`. */
  path: string;
  label: string;
  folders: PracticeFolder[];
  count: number;
}

const byHandle = (a: PracticeView, b: PracticeView) => a.handle.localeCompare(b.handle);
export const NO_TOPIC = 'general';

/** Organization first, then each project by name; inside each, a folder per first topic. Retired ones are returned apart. */
export function groupPractices(practices: PracticeView[], projectName: (id: string) => string): { groups: PracticeGroup[]; retired: PracticeView[] } {
  const live = practices.filter((p) => p.status !== 'retired');
  const retired = practices.filter((p) => p.status === 'retired').sort(byHandle);
  const keyOf = (p: PracticeView) => (p.level === 'org' || !p.projectId ? 'org' : `project:${p.projectId}`);
  const byGroup = new Map<string, PracticeView[]>();
  for (const p of live) byGroup.set(keyOf(p), [...(byGroup.get(keyOf(p)) ?? []), p]);
  const groups = [...byGroup.entries()].map(([path, items]): PracticeGroup => {
    const topics = new Map<string, PracticeView[]>();
    for (const p of items) {
      const topic = p.topics[0] ?? NO_TOPIC;
      topics.set(topic, [...(topics.get(topic) ?? []), p]);
    }
    const folders = [...topics.entries()]
      .sort(([a], [b]) => Number(a === NO_TOPIC) - Number(b === NO_TOPIC) || a.localeCompare(b))
      .map(([name, list]): PracticeFolder => ({ path: `${path}/${name}`, name, items: list.sort(byHandle) }));
    return { path, label: path === 'org' ? PRACTICE_LEVEL_LABELS.org : projectName(path.slice('project:'.length)), folders, count: items.length };
  });
  groups.sort((a, b) => Number(b.path === 'org') - Number(a.path === 'org') || a.label.localeCompare(b.label));
  return { groups, retired };
}

/** The version waiting for the viewer to approve, if there is one: amber with `!` in the view. */
export const waitingVersion = (p: Pick<PracticeView, 'canApprove' | 'drafts'>): number | undefined => (p.canApprove ? p.drafts[0]?.version : undefined);

/** The file name a practice has in a tab and the breadcrumbs. */
export const practiceFileName = (handle: string) => `${handle}.md`;

// ---------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------

/** A machine check in words. Code in backticks (the card draws it as code). */
export function checkSentence(check: PracticeCheck): string {
  switch (check.kind) {
    case 'pathExists':
      return check.when ? `When a file changes under \`${check.when}\`, a file matching \`${check.glob}\` must exist` : `A file matching \`${check.glob}\` must exist`;
    case 'pathAbsent':
      return check.unless ? `No file matching \`${check.glob}\` may exist, unless it also matches \`${check.unless}\`` : `No file matching \`${check.glob}\` may exist`;
    case 'fileMatches':
      return check.absent ? `No file matching \`${check.glob}\` may contain \`${check.pattern}\`` : `Every file matching \`${check.glob}\` must contain \`${check.pattern}\``;
  }
}

/** `abc1234` for a commit, however long it was saved. */
export const shortSha = (sha: string) => sha.slice(0, 7);

export const CITATION_UNVERIFIED = 'not verified: read by a person’s tools, not by a flow';

/** What a citation says about itself: a tick and the commit, or the reason it has none. */
export const citationNote = (c: Pick<PracticeCitation, 'verified' | 'sha'>) => (c.verified ? { ok: true, text: `verified at ${shortSha(c.sha)}` } : { ok: false, text: CITATION_UNVERIFIED });

export const citationPlace = (c: PracticeCitation) => `${c.path}${c.lines ? `:${c.lines[0]}${c.lines[1] !== c.lines[0] ? `–${c.lines[1]}` : ''}` : ''}`;

export const VERSION_STATE_LABELS: Record<PracticeVersionState, string> = { approved: 'Approved', replaced: 'Replaced', pending: 'Waiting', rejected: 'Rejected' };

/** `user:<id>`, `agent:<id>` or `workflow:<id>` in words: who wrote or approved a version. */
export function actorWords(by?: string): string {
  const kind = by?.split(':')[0];
  return kind === 'agent' ? 'an agent' : kind === 'workflow' ? 'a flow' : 'a person';
}

export const SOURCE_WORDS = { person: 'written by a person', learned: 'read from a repository', agent: 'written by an agent' } as const;

/** The text of a version as lines, for the review's diff: its scope and strength, its summary, its checks and its rules. */
export function versionText(v: Pick<PracticeVersion, 'title' | 'strength' | 'topics' | 'repos' | 'paths' | 'summary' | 'body' | 'checks'>): string {
  const list = (items: string[]) => (items.length ? items.join(', ') : 'any');
  const lines = [
    `Title: ${v.title}`,
    `Strength: ${PRACTICE_STRENGTH_LABELS[v.strength]}`,
    `Topics: ${list(v.topics)}`,
    `Repositories: ${list(v.repos)}`,
    `Paths: ${list(v.paths)}`,
    `Summary: ${v.summary}`,
    ...(v.checks.length ? ['Checks:', ...v.checks.map((c) => `- ${checkSentence(c)}`)] : []),
    '',
    v.body,
  ];
  return `${lines.join('\n')}\n`;
}

/** The change a pending version makes to the approved one; a new practice is all added. */
export const versionDiff = (before: PracticeVersion | undefined, after: PracticeVersion): DiffHunk[] => diffHunks(before ? versionText(before) : '', versionText(after));

// ---------------------------------------------------------------------------
// The review dialog
// ---------------------------------------------------------------------------

export type ConflictAnswers = Record<string, 'supersede' | 'keep'>;

/** The conflicts the practice has plus those a 409 `PracticeConflict` named, each once. */
export function mergeConflicts(known: PracticeConflict[], named: unknown): PracticeConflict[] {
  const out = [...known];
  if (Array.isArray(named)) for (const c of named as PracticeConflict[]) if (c && typeof c.id === 'string' && !out.some((k) => k.id === c.id)) out.push(c);
  return out;
}

export const REJECT_REASON_HINT = `${PRACTICE_LIMITS.reasonMin} to ${PRACTICE_LIMITS.reason} characters`;
export const reasonValid = (reason: string) => reason.trim().length >= PRACTICE_LIMITS.reasonMin && reason.trim().length <= PRACTICE_LIMITS.reason;

/** What blocks Approve: an unread tainted version, a conflict with no answer. Empty: nothing does. */
export function approveBlockers({ tainted, reviewed, conflicts, answers }: { tainted: boolean; reviewed: boolean; conflicts: PracticeConflict[]; answers: ConflictAnswers }): string[] {
  const out: string[] = [];
  if (tainted && !reviewed) out.push('Tick that you read it against its sources.');
  const open = conflicts.filter((c) => !answers[c.id]).length;
  if (open) out.push(`Answer ${open === 1 ? 'the overlap' : `${open} overlaps`}: Supersede or Keep both.`);
  return out;
}

/** The body of `POST /api/practices/:id/approve`. */
export function approveBody(version: Pick<PracticeVersion, 'version' | 'tainted'>, { reviewed, conflicts, answers }: { reviewed: boolean; conflicts: PracticeConflict[]; answers: ConflictAnswers }): PracticeApproveInput {
  const given: ConflictAnswers = {};
  for (const c of conflicts) if (answers[c.id]) given[c.id] = answers[c.id];
  return { version: version.version, ...(version.tainted && reviewed && { reviewedSources: true }), ...(conflicts.length && { conflicts: given }) };
}

/** A failed review step in words, and the conflicts a 409 named (merged by the dialog). */
export function reviewError(error: { status?: number; message: string; body?: unknown }): { message: string; conflicts?: unknown } {
  const body = (error.body ?? {}) as { code?: string; conflicts?: unknown };
  if (body.code === 'practice_conflict' || (error.status === 409 && Array.isArray(body.conflicts)))
    return { message: 'It overlaps another practice. Choose Supersede or Keep both for each, then approve.', conflicts: body.conflicts };
  if (body.code === 'practice_needs_review') return { message: 'Read its rules against their sources first.' };
  return { message: error.message };
}

// ---------------------------------------------------------------------------
// The form
// ---------------------------------------------------------------------------

export interface CheckRow {
  kind: PracticeCheck['kind'];
  glob: string;
  /** pathExists: `when`; pathAbsent: `unless`. */
  other: string;
  pattern: string;
  absent: boolean;
}
export interface PracticeFormValues {
  handle: string;
  title: string;
  level: PracticeLevel;
  projectId: string;
  strength: PracticeStrength;
  topics: string[];
  /** One per line. */
  repos: string;
  paths: string;
  summary: string;
  body: string;
  checks: CheckRow[];
}

export const emptyCheck = (kind: PracticeCheck['kind'] = 'pathExists'): CheckRow => ({ kind, glob: '', other: '', pattern: '', absent: false });
export const emptyForm = (): PracticeFormValues => ({ handle: '', title: '', level: 'org', projectId: '', strength: 'recommended', topics: [], repos: '', paths: '', summary: '', body: '', checks: [] });

const lines = (text: string) => [...new Set(text.split('\n').map((l) => l.trim()).filter(Boolean))];

/** The form for editing: the newest version's text, its handle and level as they are. */
export function formFrom(practice: Pick<PracticeView, 'handle' | 'level' | 'projectId'>, v: PracticeVersion): PracticeFormValues {
  return {
    handle: practice.handle,
    title: v.title,
    level: practice.level,
    projectId: practice.projectId ?? '',
    strength: v.strength,
    topics: [...v.topics],
    repos: v.repos.join('\n'),
    paths: v.paths.join('\n'),
    summary: v.summary,
    body: v.body,
    checks: v.checks.map((c) => ({ kind: c.kind, glob: c.glob, other: c.kind === 'pathExists' ? (c.when ?? '') : c.kind === 'pathAbsent' ? (c.unless ?? '') : '', pattern: c.kind === 'fileMatches' ? c.pattern : '', absent: c.kind === 'fileMatches' ? Boolean(c.absent) : false })),
  };
}

export function checkOf(row: CheckRow): PracticeCheck {
  const glob = row.glob.trim();
  const other = row.other.trim();
  if (row.kind === 'pathExists') return { kind: 'pathExists', glob, ...(other && { when: other }) };
  if (row.kind === 'pathAbsent') return { kind: 'pathAbsent', glob, ...(other && { unless: other }) };
  return { kind: 'fileMatches', glob, pattern: row.pattern, ...(row.absent && { absent: true }) };
}

const regexOk = (pattern: string) => {
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
};

export type FormErrors = Partial<Record<'handle' | 'title' | 'projectId' | 'topics' | 'repos' | 'paths' | 'summary' | 'body' | 'checks', string>>;

/** The form against the API's limits and patterns, before it sends anything. Editing keeps handle, level and project as they are. */
export function validatePracticeForm(v: PracticeFormValues, { editing = false }: { editing?: boolean } = {}): FormErrors {
  const errors: FormErrors = {};
  const L = PRACTICE_LIMITS;
  if (!editing && !PRACTICE_HANDLE.test(v.handle.trim())) errors.handle = 'Two or three lowercase parts, such as helm/chart-location.';
  if (!v.title.trim()) errors.title = 'Give it a title.';
  else if (v.title.trim().length > L.title) errors.title = `At most ${L.title} characters.`;
  if (!editing && v.level === 'project' && !v.projectId) errors.projectId = 'Choose a project.';
  const topics = [...new Set(v.topics.map((t) => t.trim()).filter(Boolean))];
  if (topics.length > L.topics) errors.topics = `At most ${L.topics} topics.`;
  else if (topics.some((t) => !PRACTICE_TOPIC.test(t))) errors.topics = 'A topic is lowercase letters, digits and dashes.';
  const repos = lines(v.repos);
  if (repos.length > L.repos) errors.repos = `At most ${L.repos} repositories.`;
  else if (repos.some((r) => !PRACTICE_REPO.test(r))) errors.repos = 'Write each as owner/name, one per line.';
  const paths = lines(v.paths);
  if (paths.length > L.paths) errors.paths = `At most ${L.paths} paths.`;
  else if (paths.some((p) => p.length > L.glob)) errors.paths = `A path is at most ${L.glob} characters.`;
  if (!v.summary.trim()) errors.summary = 'Write the one-line rule agents are given.';
  else if (v.summary.trim().length > L.summary) errors.summary = `At most ${L.summary} characters.`;
  if (!v.body.trim()) errors.body = 'Write the rules.';
  else if (v.body.length > L.body) errors.body = `At most ${L.body} characters.`;
  if (v.checks.length > L.checks) errors.checks = `At most ${L.checks} checks.`;
  else
    for (const [i, row] of v.checks.entries()) {
      const n = i + 1;
      if (!row.glob.trim()) errors.checks = `Check ${n} needs a path pattern.`;
      else if (row.glob.trim().length > L.glob || row.other.trim().length > L.glob) errors.checks = `Check ${n}: a path pattern is at most ${L.glob} characters.`;
      else if (row.kind === 'fileMatches' && !row.pattern.trim()) errors.checks = `Check ${n} needs the text to look for.`;
      else if (row.kind === 'fileMatches' && (row.pattern.length > L.pattern || !regexOk(row.pattern))) errors.checks = `Check ${n}: the text is not a valid pattern of at most ${L.pattern} characters.`;
      if (errors.checks) break;
    }
  return errors;
}

/** The version an edit starts from: the newest that was not rejected, as the API builds a PATCH (all rejected: the newest). */
export function editBase<T extends { state: PracticeVersionState }>(versions: T[]): T | undefined {
  return versions.find((v) => v.state !== 'rejected') ?? versions[0];
}

/** The body of `POST /api/practices`. */
export function draftInput(v: PracticeFormValues): PracticeDraftInput {
  return { ...scopeAndText(v), handle: v.handle.trim(), level: v.level, ...(v.level === 'project' && { projectId: v.projectId }) };
}

/** The body of `PATCH /api/practices/:id`: everything an edit may change. */
export function editInput(v: PracticeFormValues) {
  return scopeAndText(v);
}

function scopeAndText(v: PracticeFormValues) {
  return {
    title: v.title.trim(),
    strength: v.strength,
    topics: [...new Set(v.topics.map((t) => t.trim()).filter(Boolean))],
    repos: lines(v.repos),
    paths: lines(v.paths),
    summary: v.summary.trim(),
    body: v.body,
    checks: v.checks.map(checkOf),
  };
}
