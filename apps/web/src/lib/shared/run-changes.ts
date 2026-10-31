/**
 * Code changes of a run (docs/run-trace.md#artifacts-and-code-changes): the journal's file writes and edits by remote
 * agents folded into one entry per file — each agent's changes in order, the file's combined before and after, a
 * unified patch and +/− counts — and for every change whether it was pushed. Pure: the Artifacts tab and the detail
 * sheet read it; the changes route compares it with the branch as GitHub sees it.
 *
 * A change is **pushed** when the same actor later committed the file (a `git add` that names it, or `git commit -a`)
 * and then ran a successful `git push`; the Run report's delivery check (run-report.ts) reasons the same way but asks
 * only whether any push followed. Agents' own memory notes are left out, as the profiles do (run-profiles.ts).
 */
import { formatPatch, structuredPatch } from 'diff';
import { AGENT_NOTES } from './run-profiles';
import { toolInput, type JournalEvent, type RunActor } from './run-trace';

export type ChangeKind = 'write' | 'edit';

export interface FileChange {
  actor: RunActor;
  kind: ChangeKind;
  /** The tool step. */
  spanId: string;
  at: string;
  /** The text before and after. Whole-file when known (`partial` false); else the edit's own old and new text. */
  before: string;
  after: string;
  /** The edit's text could not be placed in a file the run showed: before and after are the fragments it passed. */
  partial: boolean;
  /** A write to a path the run had not shown before: shown as all lines added. */
  created: boolean;
  /** The tool input was cut by the journal (32 KB per event): the text is incomplete. */
  truncated: boolean;
  additions: number;
  deletions: number;
  /** A later successful push by the same actor carried it. */
  pushed: boolean;
  /** The push step that carried it. */
  pushSpanId?: string;
  pushedAt?: string;
  /** The commit's short SHA when the commit step printed one. */
  commit?: string;
}

/** What one actor did to one file. */
export interface ActorChanges {
  actor: RunActor;
  writes: number;
  edits: number;
  pushed: number;
  notPushed: number;
  /** The latest push that carried any of it. */
  commit?: string;
  pushSpanId?: string;
  lastAt: string;
}

export interface FileChanges {
  /** Relative to the clone root. */
  path: string;
  changes: FileChange[];
  actors: ActorChanges[];
  /** The text before the first change and after the last, when every change placed its text. */
  before?: string;
  after?: string;
  partial: boolean;
  created: boolean;
  /** Unified patch of the whole file's change (the changes' patches joined when partial). */
  patch: string;
  additions: number;
  deletions: number;
  pushed: number;
  notPushed: number;
  /** `all` pushed, `some`, or `none`. */
  delivery: 'all' | 'some' | 'none';
}

export interface RunChanges {
  /** Some agent used git (clone, add, commit or push): only then does "pushed" mean anything for this run. */
  git: boolean;
  files: FileChanges[];
  /** Agents that changed a file. */
  agents: RunActor[];
  changes: number;
  notPushed: number;
}

/** What GitHub says the branch holds beyond its base (the changes route; plugins/github Repository → Compare). */
export interface BranchFile {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  previousPath?: string | null;
  patch?: string | null;
}

export interface BranchChanges {
  base: string;
  head: string;
  status: string | null;
  aheadBy: number;
  behindBy: number;
  totalCommits: number;
  url: string | null;
  files: BranchFile[];
  truncated: boolean;
  note?: string;
}

/** `GET /api/executions/:id/changes`: the branch compared, or why it could not be. */
export type BranchReply =
  | { available: false; reason: string }
  | { available: true; repository: { owner: string; repo: string; url: string }; branch: BranchChanges; fetchedAt: string };

/** The journal's agent memory notes, left out exactly as the profiles do. */
const MEMORY_PATH = new RegExp(AGENT_NOTES, 'i');
const CUT = '…[cut]';
const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit']);
/** Where agents clone to when no clone command shows it. */
const DEFAULT_ROOTS = ['/tmp/work', '/tmp/workspace', '/workspace', '/data/workspace', '/work', '/repo', '/app'];

type Started = Extract<JournalEvent, { type: 'span.started' }>;
type Ended = Extract<JournalEvent, { type: 'span.ended' }>;
interface Step {
  start: Started;
  end?: Ended;
}

const record = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

/** A shell command split into words, honouring quotes. */
function words(command: string): string[] {
  return [...command.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
}

const trimSlash = (path: string) => (path.length > 1 ? path.replace(/\/+$/, '') : path);

/** Clone targets named in the run's commands (`git clone <url> /tmp/work`), longest first. */
function cloneRoots(steps: Step[]): string[] {
  const roots = new Set<string>();
  for (const { start } of steps) {
    const command = str(record(start.input).command);
    if (!command) continue;
    for (const segment of command.split(/&&|;|\n/)) {
      const w = words(segment.trim());
      const at = w.indexOf('clone');
      if (w[at - 1] !== 'git' || at < 0) continue;
      const args = w.slice(at + 1).filter((a) => !a.startsWith('-'));
      const target = args[1];
      if (target?.startsWith('/')) roots.add(trimSlash(target));
    }
  }
  return [...roots, ...DEFAULT_ROOTS].sort((a, b) => b.length - a.length);
}

/** A path relative to the clone root; a path outside every root keeps its absolute form. */
function relativePath(path: string, roots: string[]): string {
  for (const root of roots) if (path === root || path.startsWith(`${root}/`)) return path.slice(root.length).replace(/^\/+/, '');
  return path.replace(/^\.\//, '');
}

// ---------------------------------------------------------------------------
// Git: which files a commit carried and whether a push followed
// ---------------------------------------------------------------------------

/** Which files a `git add` / `git commit -a` names, as a test on a root-relative path. */
type Matcher = (path: string) => boolean;
const everything: Matcher = () => true;

function matcherOf(arg: string, cwd: string, roots: string[]): Matcher {
  let path = arg.startsWith('/') ? relativePath(arg, roots) : cwd ? `${cwd}/${arg}` : arg;
  path = path.replace(/^\.\//, '').replace(/\/\.$/, '').replace(/\/+$/, '');
  if (path === '' || path === '.') return everything;
  if (/[*?]/.test(path)) {
    const glob = new RegExp(`^${path.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*').replace(/\?/g, '[^/]')}$`);
    return (p) => glob.test(p);
  }
  return (p) => p === path || p.startsWith(`${path}/`);
}

type GitOp = { kind: 'add'; match: Matcher[] } | { kind: 'commit'; all: boolean } | { kind: 'push' };

/** The git operations a Bash command runs, in order. `cd` inside the command moves where relative paths point. */
function gitOps(command: string, roots: string[]): GitOp[] {
  const ops: GitOp[] = [];
  let cwd = '';
  for (const raw of command.split(/&&|;|\n/)) {
    // Whatever follows `||` runs only when the git command failed.
    const segment = raw.split('||')[0].trim();
    const w = words(segment);
    if (w[0] === 'cd' && w[1]) {
      cwd = w[1].startsWith('/') ? relativePath(w[1], roots) : w[1] === '..' ? cwd.split('/').slice(0, -1).join('/') : cwd ? `${cwd}/${w[1]}` : w[1];
      continue;
    }
    // `git -C dir add …` and `git -c k=v commit …`: skip git's own options.
    let i = w.indexOf('git');
    if (i < 0) continue;
    let dir = cwd;
    for (i++; i < w.length && w[i].startsWith('-'); i += w[i] === '-C' || w[i] === '-c' ? 2 : 1) if (w[i] === '-C' && w[i + 1]) dir = w[i + 1].startsWith('/') ? relativePath(w[i + 1], roots) : dir ? `${dir}/${w[i + 1]}` : w[i + 1];
    const sub = w[i];
    const args = w.slice(i + 1);
    if (sub === 'add') {
      const flags = args.filter((a) => a.startsWith('-'));
      const paths = args.filter((a) => !a.startsWith('-'));
      const all = flags.some((f) => /^(-A|--all|-u|--update)$/.test(f));
      ops.push({ kind: 'add', match: all || !paths.length ? [everything] : paths.map((p) => matcherOf(p, dir, roots)) });
    } else if (sub === 'commit') {
      ops.push({ kind: 'commit', all: args.some((a) => a === '--all' || /^-[a-zA-Z]*a[a-zA-Z]*$/.test(a)) });
    } else if (sub === 'push') ops.push({ kind: 'push' });
  }
  return ops;
}

interface Commit {
  ord: number;
  match: Matcher[];
  at: string;
  spanId: string;
  sha?: string;
}
interface Push {
  ord: number;
  at: string;
  spanId: string;
}

/** Each actor's commits (with what they carried) and pushes, in order, from their successful Bash steps. */
function gitHistory(steps: Step[], roots: string[]) {
  const commits = new Map<string, Commit[]>();
  const pushes = new Map<string, Push[]>();
  const staged = new Map<string, Matcher[]>();
  for (const step of steps) {
    const { start, end } = step;
    const command = start.kind === 'tool' && start.name === 'Bash' ? str(record(start.input).command) : undefined;
    // A step that failed may have stopped anywhere in a chain: nothing in it counts.
    if (!command || !end || end.status !== 'success' || !/\bgit\b/.test(command)) continue;
    const actor = start.actor.id;
    gitOps(command, roots).forEach((op, n) => {
      const ord = start.seq * 100 + n;
      if (op.kind === 'add') staged.set(actor, [...(staged.get(actor) ?? []), ...op.match]);
      else if (op.kind === 'commit') {
        const sha = /\[[^\]\n]+ ([0-9a-f]{7,40})\]/.exec(JSON.stringify(record(end.output).result ?? end.output ?? ''))?.[1];
        (commits.get(actor) ?? commits.set(actor, []).get(actor)!).push({ ord, match: op.all ? [everything] : (staged.get(actor) ?? []), at: start.at, spanId: start.spanId, ...(sha && { sha }) });
        staged.set(actor, []);
      } else (pushes.get(actor) ?? pushes.set(actor, []).get(actor)!).push({ ord, at: start.at, spanId: start.spanId });
    });
  }
  return { commits, pushes };
}

// ---------------------------------------------------------------------------
// Diffs
// ---------------------------------------------------------------------------

export interface DiffLine {
  type: 'add' | 'del' | 'ctx';
  text: string;
  /** Line numbers in the old and new text (absent on the side a line does not exist on). */
  oldNo?: number;
  newNo?: number;
}
export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

const lineKind = (c: string): DiffLine['type'] | undefined => (c === '+' ? 'add' : c === '-' ? 'del' : c === ' ' ? 'ctx' : undefined);

/** The hunks of a unified patch (GitHub's `patch` has no file header; a full patch's headers are skipped). */
export function parsePatchHunks(patch: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let hunk: DiffHunk | undefined;
  let oldNo = 0;
  let newNo = 0;
  for (const line of patch.split('\n')) {
    const head = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (head) {
      hunk = { header: line, lines: [] };
      hunks.push(hunk);
      oldNo = Number(head[1]);
      newNo = Number(head[2]);
      continue;
    }
    const type = hunk && lineKind(line[0]);
    if (!hunk || !type) continue;
    hunk.lines.push({ type, text: line.slice(1), ...(type !== 'add' && { oldNo: oldNo++ }), ...(type !== 'del' && { newNo: newNo++ }) });
  }
  return hunks;
}

/** A line diff of two texts, three lines of context. */
export function diffHunks(before: string, after: string, context = 3): DiffHunk[] {
  return parsePatchHunks(formatPatch(structuredPatch('a', 'b', before, after, undefined, undefined, { context }), { includeIndex: false, includeUnderline: false, includeFileHeaders: false }));
}

/** A unified patch with file headers, `/dev/null` as the old side of a new file. */
export function unifiedPatch(path: string, before: string, after: string, created = false): string {
  const patch = structuredPatch(created ? '/dev/null' : `a/${path}`, `b/${path}`, before, after, undefined, undefined, { context: 3 });
  return patch.hunks.length ? formatPatch(patch, { includeIndex: false, includeUnderline: false, includeFileHeaders: true }) : '';
}

const countLines = (hunks: DiffHunk[]) => ({
  additions: hunks.reduce((n, h) => n + h.lines.filter((l) => l.type === 'add').length, 0),
  deletions: hunks.reduce((n, h) => n + h.lines.filter((l) => l.type === 'del').length, 0),
});

// ---------------------------------------------------------------------------
// The fold
// ---------------------------------------------------------------------------

/** The edits a Write, Edit or MultiEdit tool step makes: the text it replaces and the text it puts there. */
function editsOf(name: string, input: Record<string, unknown>): Array<{ old: string; next: string; all: boolean }> {
  const one = (e: Record<string, unknown>) => ({ old: str(e.old_string) ?? '', next: str(e.new_string) ?? '', all: e.replace_all === true });
  if (name === 'MultiEdit') return Array.isArray(input.edits) ? input.edits.map((e) => one(record(e))) : [];
  return [one(input)];
}

const replaceText = (text: string, old: string, next: string, all: boolean) => (all ? text.split(old).join(next) : text.replace(old, () => next));

/** The file changes of a run, folded from its journal: pass the events up to a time to replay. */
export function foldChanges(events: JournalEvent[]): RunChanges {
  const steps = new Map<string, Step>();
  for (const e of [...events].sort((a, b) => a.seq - b.seq)) {
    if (e.type === 'span.started' && e.kind === 'tool') steps.set(e.spanId, { start: { ...e, input: toolInput(e.input) } });
    else if (e.type === 'span.ended') {
      const step = steps.get(e.spanId);
      if (step) step.end = e;
    }
  }
  const ordered = [...steps.values()];
  const roots = cloneRoots(ordered);
  const history = gitHistory(ordered, roots);

  const known = new Map<string, string>();
  const byPath = new Map<string, FileChange[]>();
  for (const { start, end } of ordered) {
    if (!FILE_TOOLS.has(start.name) || !end || end.status !== 'success' || start.actor.type === 'human') continue;
    const input = record(start.input);
    const absolute = str(input.file_path) ?? str(input.path);
    if (!absolute || MEMORY_PATH.test(absolute)) continue;
    const path = relativePath(absolute, roots);
    const make = (kind: ChangeKind, before: string, after: string, partial: boolean, created: boolean, truncated: boolean): FileChange => {
      const hunks = diffHunks(before, after);
      return { actor: start.actor, kind, spanId: start.spanId, at: start.at, before, after, partial, created, truncated, ...countLines(hunks), pushed: false };
    };
    const list = byPath.get(path) ?? byPath.set(path, []).get(path)!;
    if (start.name === 'Write') {
      const content = str(input.content);
      if (content === undefined) continue;
      const before = known.get(path);
      list.push(make('write', before ?? '', content, false, before === undefined, content.endsWith(CUT)));
      known.set(path, content);
      continue;
    }
    // Edits place their text in the file when the run showed it; else the fragments stand for the change.
    for (const edit of editsOf(start.name, input)) {
      const current = known.get(path);
      const truncated = edit.old.endsWith(CUT) || edit.next.endsWith(CUT);
      if (current !== undefined && edit.old && current.includes(edit.old)) {
        const after = replaceText(current, edit.old, edit.next, edit.all);
        list.push(make('edit', current, after, false, false, truncated));
        known.set(path, after);
      } else {
        list.push(make('edit', edit.old, edit.next, true, false, truncated));
        known.delete(path);
      }
    }
  }

  // Pushed: a commit by the same actor after the change that carried the file, then a push after that commit.
  for (const [path, list] of byPath) {
    for (const change of list) {
      const ord = steps.get(change.spanId)!.start.seq * 100;
      const commit = (history.commits.get(change.actor.id) ?? []).find((c) => c.ord > ord && c.match.some((m) => m(path)));
      const push = commit && (history.pushes.get(change.actor.id) ?? []).find((p) => p.ord > commit.ord);
      if (push) Object.assign(change, { pushed: true, pushSpanId: push.spanId, pushedAt: push.at, ...(commit.sha && { commit: commit.sha }) });
    }
  }

  const files: FileChanges[] = [...byPath]
    .filter(([, list]) => list.length)
    .map(([path, changes]) => {
      const partial = changes.some((c) => c.partial);
      const created = changes[0].created;
      const before = partial ? undefined : changes[0].before;
      const after = partial ? undefined : changes.at(-1)!.after;
      const patch = partial ? changes.map((c) => unifiedPatch(path, c.before, c.after)).filter(Boolean).join('') : unifiedPatch(path, before!, after!, created);
      const total = partial ? { additions: sum(changes, 'additions'), deletions: sum(changes, 'deletions') } : countLines(diffHunks(before!, after!));
      const actors = new Map<string, ActorChanges>();
      for (const c of changes) {
        const a = actors.get(c.actor.id) ?? actors.set(c.actor.id, { actor: c.actor, writes: 0, edits: 0, pushed: 0, notPushed: 0, lastAt: c.at }).get(c.actor.id)!;
        if (c.kind === 'write') a.writes++;
        else a.edits++;
        if (c.pushed) {
          a.pushed++;
          a.commit = c.commit ?? a.commit;
          a.pushSpanId = c.pushSpanId ?? a.pushSpanId;
        } else a.notPushed++;
        a.lastAt = c.at;
      }
      const pushed = changes.filter((c) => c.pushed).length;
      return {
        path,
        changes,
        actors: [...actors.values()],
        ...(before !== undefined && { before }),
        ...(after !== undefined && { after }),
        partial,
        created,
        patch,
        ...total,
        pushed,
        notPushed: changes.length - pushed,
        delivery: pushed === changes.length ? 'all' : pushed ? 'some' : 'none',
      } satisfies FileChanges;
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const agents = new Map<string, RunActor>();
  for (const f of files) for (const a of f.actors) agents.set(a.actor.id, a.actor);
  return {
    git: ordered.some(({ start, end }) => start.name === 'Bash' && end?.status === 'success' && /\bgit\s+(-\S+\s+)*(clone|add|commit|push)\b/.test(str(record(start.input).command) ?? '')),
    files,
    agents: [...agents.values()],
    changes: files.reduce((n, f) => n + f.changes.length, 0),
    notPushed: files.reduce((n, f) => n + f.notPushed, 0),
  };
}

const sum = (changes: FileChange[], key: 'additions' | 'deletions') => changes.reduce((n, c) => n + c[key], 0);

/** Where a file stands against the branch as GitHub sees it. */
export interface BranchState {
  /** The branch holds a change to this file. */
  onBranch: boolean;
  file?: BranchFile;
}

/** Each of the run's changed files against GitHub's comparison, plus what the branch holds that no agent in the run changed. */
export function compareWithBranch(changes: RunChanges, branch: BranchChanges): { byPath: Map<string, BranchState>; missing: string[]; others: BranchFile[] } {
  const onBranch = new Map(branch.files.map((f) => [f.path, f]));
  const byPath = new Map<string, BranchState>();
  for (const f of changes.files) byPath.set(f.path, { onBranch: onBranch.has(f.path), ...(onBranch.has(f.path) && { file: onBranch.get(f.path) }) });
  const seen = new Set(changes.files.map((f) => f.path));
  return {
    byPath,
    missing: changes.files.filter((f) => !onBranch.has(f.path)).map((f) => f.path),
    others: branch.files.filter((f) => !seen.has(f.path)),
  };
}

/** Whether a file path or an artifact is a Markdown document. */
export const isMarkdownPath = (path: string) => /\.(md|markdown|mdx)$/i.test(path);

/** Whether an artifact is a document in Markdown: by its type, its kind or its name. */
export const isMarkdownArtifact = (a: { name: string; kind?: string; mimeType?: string }) =>
  /markdown/i.test(a.mimeType ?? '') || a.kind === 'report' || a.kind === 'document' || isMarkdownPath(a.name);
