/**
 * Globs and the three machine checks of a practice (docs/practices.md#machine-checks), run with no model over a change.
 * One implementation for the CLI (`landflow practices check`) and the Check Practices step (docs/practices.md#the-check-practices-step),
 * so a change passes in one exactly when it passes in the other. The web selector's own `matchesPracticeGlob`
 * (apps/web/src/lib/shared/practices.ts) follows the same rules; their tests share one table of cases.
 *
 * The three kinds, exactly:
 * - pathExists: when some changed file matches `when` (always, without it), some changed file matches `glob`;
 * - pathAbsent: no changed file matches `glob`, unless it also matches `unless`;
 * - fileMatches: every changed file matching `glob` has `pattern` (a regular expression) in its added lines, or never
 *   has it with `absent: true`.
 * "Changed files" are the added and modified ones. A deleted file is never present in the change, so deleting one that
 * a pathAbsent glob names is a pass.
 */

/** A machine check, as a practice stores it. */
export type PracticeCheck =
  | { kind: 'pathExists'; glob: string; when?: string }
  | { kind: 'pathAbsent'; glob: string; unless?: string }
  | { kind: 'fileMatches'; glob: string; pattern: string; absent?: boolean };

/** What a change touched: the files, and the lines each added or modified one gained. */
export interface PracticeChange {
  files: Array<{ path: string; status: 'A' | 'M' | 'D' }>;
  /** path → the lines the change added to it. */
  added: Map<string, string[]>;
}

export interface PracticeCheckResult {
  check: PracticeCheck;
  pass: boolean;
  /** The changed files that failed it (empty for a pathExists that failed: no file is to blame). */
  files: string[];
  /** In words, for a failure. */
  message?: string;
}

/**
 * `**` is any number of directories (also none), `*` and `?` stay within one path segment, the rest is literal.
 */
export function practiceGlob(glob: string): RegExp {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      i++;
      if (glob[i + 1] === '/') {
        i++;
        out += '(?:[^/]*/)*';
      } else out += '.*';
    } else if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

/** Whether a repository-relative path matches a glob (a leading `./` or `/` is ignored). */
export const matchesPracticeGlob = (glob: string, path: string): boolean => practiceGlob(glob).test(path.replace(/^\.?\//, ''));

/** A check in a line of words. */
export const practiceCheckLabel = (check: PracticeCheck): string =>
  check.kind === 'pathExists'
    ? `pathExists ${check.glob}${check.when ? ` (when ${check.when})` : ''}`
    : check.kind === 'pathAbsent'
      ? `pathAbsent ${check.glob}${check.unless ? ` (unless ${check.unless})` : ''}`
      : `fileMatches ${check.glob} ${check.absent ? 'never has' : 'has'} /${check.pattern}/`;

export function runPracticeCheck(check: PracticeCheck, change: PracticeChange): PracticeCheckResult {
  const present = change.files.filter((f) => f.status !== 'D').map((f) => f.path);
  if (check.kind === 'pathExists') {
    if (check.when && !present.some((p) => matchesPracticeGlob(check.when as string, p))) return { check, pass: true, files: [] };
    const ok = present.some((p) => matchesPracticeGlob(check.glob, p));
    return ok ? { check, pass: true, files: [] } : { check, pass: false, files: [], message: `no changed file matches ${check.glob}` };
  }
  if (check.kind === 'pathAbsent') {
    const bad = present.filter((p) => matchesPracticeGlob(check.glob, p) && !(check.unless && matchesPracticeGlob(check.unless, p)));
    return bad.length ? { check, pass: false, files: bad, message: `changed files match ${check.glob}` } : { check, pass: true, files: [] };
  }
  let pattern: RegExp;
  try {
    pattern = new RegExp(check.pattern, 'm');
  } catch {
    return { check, pass: false, files: [], message: `the pattern /${check.pattern}/ is not a regular expression` };
  }
  const bad = present.filter((p) => {
    if (!matchesPracticeGlob(check.glob, p)) return false;
    const has = pattern.test((change.added.get(p) ?? []).join('\n'));
    return check.absent ? has : !has;
  });
  return bad.length ? { check, pass: false, files: bad, message: check.absent ? `added lines match /${check.pattern}/` : `added lines never match /${check.pattern}/` } : { check, pass: true, files: [] };
}

export const runPracticeChecks = (checks: readonly PracticeCheck[], change: PracticeChange): PracticeCheckResult[] => checks.map((c) => runPracticeCheck(c, change));
