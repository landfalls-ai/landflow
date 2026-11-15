/**
 * Machine checks over a change, with no model (docs/practices.md#machine-checks). The three kinds, exactly:
 * - pathExists: when some changed file matches `when` (always, without it), some changed file matches `glob`;
 * - pathAbsent: no changed file matches `glob`, unless it also matches `unless`;
 * - fileMatches: every changed file matching `glob` has `pattern` (a regular expression) in its added lines, or never
 *   has it with `absent: true`.
 * "Changed files" are the added and modified ones. A deleted file is never present in the change, so deleting one that
 * a pathAbsent glob names is a pass.
 */
import { matchesPracticeGlob } from './glob';
import type { Change } from './diff';
import type { PracticeCheck } from './types';

export interface CheckResult {
  check: PracticeCheck;
  pass: boolean;
  /** The changed files that failed it (empty for a pathExists that failed: no file is to blame). */
  files: string[];
  /** In words, for a failure. */
  message?: string;
}

const describe = (check: PracticeCheck): string =>
  check.kind === 'pathExists' ? `pathExists ${check.glob}${check.when ? ` (when ${check.when})` : ''}` : check.kind === 'pathAbsent' ? `pathAbsent ${check.glob}${check.unless ? ` (unless ${check.unless})` : ''}` : `fileMatches ${check.glob} ${check.absent ? 'never has' : 'has'} /${check.pattern}/`;

export const checkLabel = describe;

export function runCheck(check: PracticeCheck, change: Change): CheckResult {
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

export const runChecks = (checks: readonly PracticeCheck[], change: Change): CheckResult[] => checks.map((c) => runCheck(c, change));
