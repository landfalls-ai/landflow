/**
 * Globs of a practice's `paths` and checks. The same rules as `practiceGlob` in apps/web/src/lib/shared/practices.ts
 * (the CLI can't import `apps/`): their tests share one table (docs/practices.md#globs).
 *
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
