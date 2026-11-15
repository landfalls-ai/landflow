/**
 * `landflow practices …`: the practices your admins approved (docs/practices.md), from a shell. `list` and `show` read
 * them; `check` runs their machine checks over your change with no model, sending nothing but the reads; `learn` sends
 * files from this checkout to the brain, which drafts practices for a person to approve. Needs no GitHub token.
 */
import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { flag, type Command, type Context } from '../command';
import { CliError, EXIT, usage } from '../errors';
import { plural, table } from '../output';
import { defaultRunner, originRepo, type Runner } from '../work/collect';
import { checkLabel, runChecks, type CheckResult } from '../practices/check';
import { parseChange } from '../practices/diff';
import { APPLICABLE_PATHS, LEARN_FILES, LEARN_FILE_CHARS, type ApplicablePractice, type ApplicableResponse, type FullPractice, type LearnResponse } from '../practices/types';

/** The CLI's Io, optionally with a command runner (tests may pass a fake one; the real CLI uses child_process). */
type GitIo = Context['io'] & { exec?: Runner };
const runner = (ctx: Context): Runner => (ctx.io as GitIo).exec ?? defaultRunner;

const REPO = /^[\w.-]{1,100}\/[\w.-]{1,100}$/;
const MAX_CHECK_CALLS = 60;
const SHA = /^[0-9a-f]{7,40}$/;

async function git(ctx: Context, args: string[]): Promise<string> {
  const out = await runner(ctx)('git', args, { cwd: ctx.io.cwd });
  if (out.code !== 0) throw new CliError('io', `git ${args.filter((a) => a !== '-c' && !a.startsWith('core.')).slice(0, 3).join(' ')} failed here (is this a git repository, and does the base branch exist? pass --base)`);
  return out.stdout;
}

/** `--repo`, else the origin remote of the current directory, else none. */
async function repoOf(ctx: Context): Promise<string | undefined> {
  const given = ctx.flags.repo as string | undefined;
  if (given !== undefined) {
    if (!REPO.test(given)) throw usage(`--repo is owner/name, got "${given}"`);
    return given;
  }
  return originRepo(runner(ctx), ctx.io.cwd);
}

const strengthMark = (p: { strength: string }) => (p.strength === 'required' ? 'required' : 'recommended');
const ref = (p: { handle: string; version: number }) => `${p.handle}@${p.version}`;

const listTable = (rows: ApplicablePractice[]) =>
  table(
    rows,
    [
      { label: 'practice', value: (p) => ref(p) },
      { label: 'strength', value: strengthMark },
      { label: 'level', value: (p) => p.level },
      { label: 'summary', value: (p) => p.summary, max: 90 },
    ],
    'No approved practices apply here.',
  );

async function applicable(ctx: Context, query: Record<string, string | string[] | undefined>): Promise<ApplicableResponse> {
  const body = await ctx.client.get<Partial<ApplicableResponse>>('/api/practices/applicable', { ...query, size: 'full', preview: '1' });
  return { practices: body.practices ?? [], text: body.text ?? '', ...(body.omitted !== undefined && { omitted: body.omitted }) };
}

/**
 * One approved practice in full, read the way delivery gives it (`GET /api/practices/resolve`): nothing while practices are
 * off, and the level (and project) of the one asked for, so an org practice never stands in for the project's.
 */
async function resolved(ctx: Context, handle: string, query: { repo?: string; path?: string[]; projectId?: string; level?: string }): Promise<FullPractice | undefined> {
  try {
    const body = await ctx.client.get<{ practice?: FullPractice }>('/api/practices/resolve', { handle, ...query });
    return body.practice;
  } catch (caught) {
    if (caught instanceof CliError && caught.code === 'not_found') return undefined;
    throw caught;
  }
}

export const list: Command = {
  name: 'practices list',
  summary: 'The approved practices that apply to a repository, a project or a path',
  usage: '[--repo owner/name] [--project <id>] [--path <p>]…',
  details: 'Reads only. The repository defaults to the origin remote of the current directory. Listing records nothing on the host.',
  flags: {
    repo: flag.string('owner/name (default: this directory’s origin)', 'owner/name'),
    project: flag.string('Also the practices of this project', 'id'),
    path: { type: 'string', multiple: true, description: 'A path in the repository (repeatable)', placeholder: 'path' },
  },
  args: { max: 0 },
  async run(ctx) {
    const repo = await repoOf(ctx);
    const paths = ((ctx.flags.path as string[] | undefined) ?? []).slice(0, APPLICABLE_PATHS);
    const got = await applicable(ctx, { repo, projectId: ctx.flags.project as string | undefined, path: paths.length ? paths : undefined });
    return {
      data: { repo: repo ?? null, practices: got.practices, text: got.text, omitted: got.omitted ?? 0 },
      human: () => [repo ? `Practices for ${repo}:` : 'Practices that apply to any repository:', listTable(got.practices), ...(got.omitted ? [`${got.omitted} more did not fit the block the host builds.`] : [])].join('\n'),
    };
  },
};

const checkText = (c: FullPractice) => (c.checks.length ? c.checks.map((k) => `- ${checkLabel(k)}`).join('\n') : 'No machine checks.');

export const show: Command = {
  name: 'practices show',
  summary: 'One approved practice in full: its rules and machine checks',
  usage: '<handle> [--repo owner/name] [--project <id>]',
  details: 'Reads the practice the way delivery gives it: nothing while practices are off, and the project’s practice before the organization’s one of the same handle.',
  flags: {
    repo: flag.string('owner/name (default: this directory’s origin)', 'owner/name'),
    project: flag.string('The project, for a project practice', 'id'),
  },
  args: { min: 1, max: 1 },
  async run(ctx) {
    const handle = ctx.args[0];
    const p = await resolved(ctx, handle, { repo: await repoOf(ctx), projectId: ctx.flags.project as string | undefined });
    if (!p) throw new CliError('not_found', `No approved practice has the handle ${handle}`);
    return {
      data: { practices: [p] },
      human: () => [`${p.handle}@${p.version} (${strengthMark(p)}, ${p.scope.level}): ${p.title}`, '', p.body, '', 'Machine checks:', checkText(p)].join('\n'),
    };
  },
};

interface Verdict {
  handle: string;
  version: number;
  strength: string;
  /** `pass`, `fail` or `none` (no machine check). */
  result: 'pass' | 'fail' | 'none';
  checks: Array<{ check: string; pass: boolean; files: string[]; message?: string }>;
}

const view = (r: CheckResult) => ({ check: checkLabel(r.check), pass: r.pass, files: r.files, ...(r.message && { message: r.message }) });

export const check: Command = {
  name: 'practices check',
  summary: 'Check your change against the machine checks of the practices that apply',
  usage: '[--base main] [--repo owner/name]',
  details:
    'Reads the files your branch changed (git diff <base>...HEAD) and the practices that apply to them, then runs each practice’s machine checks here, with no model. Nothing leaves this machine but those reads. Exits 1 when a required practice fails; a recommended one only warns. A practice with no machine check is listed as such: a person or a reviewer judges it.',
  flags: {
    base: flag.string('The branch to compare against (default main)', 'branch'),
    repo: flag.string('owner/name (default: this directory’s origin)', 'owner/name'),
  },
  args: { max: 0 },
  async run(ctx) {
    const base = (ctx.flags.base as string | undefined) ?? 'main';
    if (!/^[\w./@{}^~-]+$/.test(base) || base.startsWith('-')) throw usage(`--base is a branch or commit, got "${base}"`);
    const range = `${base}...HEAD`;
    const flags = ['-c', 'core.quotepath=off', 'diff', '--no-color', '--no-ext-diff', '--no-renames'];
    const change = parseChange(await git(ctx, [...flags, '--name-status', range]), await git(ctx, [...flags, '-U0', range]));
    const repo = await repoOf(ctx);
    const touched = change.files.map((f) => f.path);
    // The route takes at most 20 paths a call: ask in groups and join the answers by handle.
    // Keyed by level too: an org and a project practice of one handle and version are two practices.
    const byHandle = new Map<string, ApplicablePractice>();
    // The paths each was delivered for, so the read of its rules gives exactly the practice that was delivered.
    const pathsOf = new Map<string, string[]>();
    const chunks: string[][] = [];
    for (let i = 0; i < touched.length; i += APPLICABLE_PATHS) chunks.push(touched.slice(i, i + APPLICABLE_PATHS));
    // The host lists only what fits its block and counts the rest as omitted. Ask again in smaller groups until nothing
    // is omitted; what still does not fit one path (or the call cap) is reported, never passed over.
    let omitted = 0;
    let calls = 0;
    const ask = async (paths: string[]): Promise<void> => {
      calls += 1;
      const got = await applicable(ctx, { repo, path: paths.length ? paths : undefined });
      for (const p of got.practices) {
        const key = `${p.level}:${p.handle}@${p.version}`;
        // The first call that delivered it: its paths alone reproduce that delivery (a union could pick another winner).
        if (!byHandle.has(key)) pathsOf.set(key, paths);
        byHandle.set(key, p);
      }
      const missed = got.omitted ?? 0;
      if (!missed) return;
      if (paths.length > 1 && calls < MAX_CHECK_CALLS) {
        const half = Math.ceil(paths.length / 2);
        await ask(paths.slice(0, half));
        await ask(paths.slice(half));
      } else omitted += missed;
    };
    for (const paths of chunks.length ? chunks : [[]]) await ask(paths);
    const verdicts: Verdict[] = [];
    let moved = 0;
    for (const p of [...byHandle.values()].sort((a, b) => a.handle.localeCompare(b.handle) || a.level.localeCompare(b.level))) {
      // The same level the delivery gave: an org practice never stands in for the project's of the same handle and version.
      const found = await resolved(ctx, p.handle, { repo, level: p.level, path: (pathsOf.get(`${p.level}:${p.handle}@${p.version}`) ?? []).slice(0, APPLICABLE_PATHS) });
      const row = found && found.version === p.version && found.scope.level === p.level ? found : undefined;
      if (!row) moved += 1;
      const checks = row?.checks ?? [];
      const results = runChecks(checks, change);
      verdicts.push({ handle: p.handle, version: p.version, strength: p.strength, result: !results.length ? 'none' : results.every((r) => r.pass) ? 'pass' : 'fail', checks: results.map(view) });
    }
    const failedRequired = verdicts.filter((v) => v.result === 'fail' && v.strength === 'required');
    const failedRecommended = verdicts.filter((v) => v.result === 'fail' && v.strength !== 'required');
    const ok = !failedRequired.length;
    return {
      data: { base, repo: repo ?? null, changed: change.files, ok, omitted, moved, practices: verdicts },
      ...(!ok && { exitCode: EXIT.error }),
      human: () => {
        const lines = [`${plural(change.files.length, 'file')} changed against ${base}; ${plural(verdicts.length, 'practice')} apply.`];
        for (const v of verdicts) {
          const head = `${v.result === 'pass' ? 'pass' : v.result === 'fail' ? (v.strength === 'required' ? 'FAIL' : 'warn') : 'no machine check'}  ${ref(v)} (${v.strength})`;
          lines.push(head);
          for (const c of v.checks.filter((x) => !x.pass)) lines.push(`      ${c.check}: ${c.message ?? 'failed'}${c.files.length ? `\n      ${c.files.slice(0, 10).join('\n      ')}${c.files.length > 10 ? `\n      … and ${c.files.length - 10} more` : ''}` : ''}`);
        }
        if (omitted) lines.push(`${plural(omitted, 'practice')} did not fit the host's block and ${omitted === 1 ? 'was' : 'were'} not checked. Check a smaller change, or read them with landflow practices list.`);
        if (moved) lines.push(`${plural(moved, 'practice')} changed version while checking, so ${moved === 1 ? 'its' : 'their'} machine checks were not run: run check again.`);
        const clean = !omitted && !moved;
        lines.push(ok ? (!clean ? 'No required practice failed, but the check is incomplete (see above).' : failedRecommended.length ? `Passed, with ${plural(failedRecommended.length, 'warning')}.` : 'Passed.') : `Failed: ${failedRequired.map((v) => v.handle).join(', ')} (required).`);
        return lines.join('\n');
      },
    };
  },
};

/** A text file's content, or why not. */
function readText(file: string): { text: string } | { skip: string } {
  const bytes = readFileSync(file);
  if (bytes.subarray(0, 8000).includes(0)) return { skip: 'not a text file' };
  const text = bytes.toString('utf8');
  if (text.includes('�')) return { skip: 'not UTF-8 text' };
  if (bytes.length > LEARN_FILE_CHARS) return { skip: `over ${LEARN_FILE_CHARS.toLocaleString('en-US')} bytes` };
  return { text };
}

const SKIP_DIRS = new Set(['.git', 'node_modules', '.next', 'dist', 'build', 'target', 'vendor', '.venv']);

/** The files under a path (a file itself, or a directory walked in name order), as paths relative to `root`. */
function filesUnder(root: string, path: string): string[] {
  const start = resolve(root, path);
  if (start !== root && !start.startsWith(root + sep)) throw usage(`${path} is outside this repository`);
  let stat;
  try {
    stat = lstatSync(start);
  } catch {
    throw new CliError('not_found', `${path} does not exist here`);
  }
  if (stat.isSymbolicLink()) return [];
  if (stat.isFile()) return [relative(root, start).split(sep).join('/')];
  if (!stat.isDirectory()) return [];
  const out: string[] = [];
  for (const name of readdirSync(start).sort()) {
    if (name.startsWith('.') || SKIP_DIRS.has(name)) continue;
    out.push(...filesUnder(root, relative(root, resolve(start, name))));
    if (out.length > 500) break;
  }
  return out;
}

export const learn: Command = {
  name: 'practices learn',
  summary: 'Draft practices from files in this checkout (a person approves each draft in the brain)',
  usage: '[paths…] [--repo owner/name] [--project <id>] [--topic <t>]…',
  details:
    `Reads up to ${LEARN_FILES} text files under the paths (default CLAUDE.md and deploy/; each at most ${LEARN_FILE_CHARS.toLocaleString('en-US')} bytes, others are listed as skipped) and sends them with this checkout’s commit to the brain, whose model drafts practices. Drafts are saved for a person to approve on /brain → Practices; nothing is approved here. This sends the files’ text to your Landflow host: read the list before you run it in a private repository. Needs no GitHub token.`,
  flags: {
    repo: flag.string('owner/name (default: this directory’s origin)', 'owner/name'),
    project: flag.string('Draft project-level practices for this project', 'id'),
    topic: { type: 'string', multiple: true, description: 'A topic tag to put on the drafts (repeatable)', placeholder: 't' },
  },
  async run(ctx) {
    const repo = await repoOf(ctx);
    if (!repo) throw usage('Say which repository: --repo owner/name (this directory has no origin remote that names it)');
    const root = (await git(ctx, ['rev-parse', '--show-toplevel'])).trim() || ctx.io.cwd;
    const sha = (await git(ctx, ['rev-parse', 'HEAD'])).trim();
    if (!SHA.test(sha)) throw new CliError('io', 'Could not read this repository’s commit');
    // Git reports the real path of the top; resolve the paths against the real current directory too.
    const here = realpathSync(ctx.io.cwd);
    const exists = (p: string) => {
      try {
        statSync(resolve(here, p));
        return true;
      } catch {
        return false;
      }
    };
    const paths = ctx.args.length ? ctx.args : ['CLAUDE.md', 'deploy/'].filter(exists);
    if (!paths.length) throw usage('Nothing to read: name paths (landflow practices learn docs/ CLAUDE.md)');
    const found = [...new Set(paths.flatMap((p) => filesUnder(root, relative(root, resolve(here, p)))))];
    const files: Array<{ path: string; content: string }> = [];
    const skipped: Array<{ path: string; reason: string }> = [];
    for (const path of found) {
      if (files.length >= LEARN_FILES) {
        skipped.push({ path, reason: `more than ${LEARN_FILES} files` });
        continue;
      }
      const got = readText(resolve(root, path));
      if ('skip' in got) skipped.push({ path, reason: got.skip });
      else files.push({ path, content: got.text });
    }
    if (!files.length) throw usage(`No readable text files under ${paths.join(', ')}${skipped.length ? ` (${plural(skipped.length, 'file')} skipped)` : ''}`);
    const topics = (ctx.flags.topic as string[] | undefined) ?? [];
    const project = ctx.flags.project as string | undefined;
    const body = { repo, sha, files, ...(topics.length && { topics }), ...(project && { level: 'project', projectId: project }) };
    const got = await ctx.client.post<Partial<LearnResponse>>('/api/practices/learn', body);
    const drafts = got.drafts ?? [];
    const dropped = got.skipped ?? [];
    return {
      data: { repo, sha, sent: files.map((f) => f.path), skippedFiles: skipped, drafts, skipped: dropped },
      human: () =>
        [
          `Read ${plural(files.length, 'file')} at ${sha.slice(0, 7)}: ${files.map((f) => f.path).join(', ')}`,
          ...(skipped.length ? [`Skipped files: ${skipped.map((s) => `${s.path} (${s.reason})`).join('; ')}`] : []),
          drafts.length ? `Drafted ${plural(drafts.length, 'practice')}, waiting for a person to approve them on /brain → Practices:\n${drafts.map((d) => `  ${d.handle}@${d.version}${d.url ? `  ${d.url}` : ''}`).join('\n')}` : 'The brain drafted nothing.',
          ...dropped.map((s) => `Not kept${s.handle ? ` ${s.handle}` : ''}: ${s.reason}`),
        ].join('\n'),
    };
  },
};

export const practicesCommands: Command[] = [list, show, check, learn];
