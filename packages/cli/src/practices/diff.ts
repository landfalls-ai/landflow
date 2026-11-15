/**
 * What a change touched, from git's own output: `git diff --name-status` (which files, how) and `git diff -U0` (the
 * lines each added or modified file gained). Pure parsing; the command runs `git`.
 */
export interface ChangedFile {
  path: string;
  /** `A` added, `M` modified, `D` deleted (renames are read as a delete and an add: the command passes --no-renames). */
  status: 'A' | 'M' | 'D';
}

export interface Change {
  files: ChangedFile[];
  /** path → the lines the change added to it. */
  added: Map<string, string[]>;
}

/** `git diff --name-status --no-renames`: `M<TAB>path` per line. A type git has that is not A, M or D (T, U) counts as modified. */
export function parseNameStatus(output: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  for (const line of output.split('\n')) {
    const [code, ...rest] = line.split('\t');
    const path = rest.join('\t').trim();
    if (!code || !path) continue;
    const letter = code[0];
    files.push({ path, status: letter === 'A' ? 'A' : letter === 'D' ? 'D' : 'M' });
  }
  return files;
}

/** `git diff -U0`: the `+` lines under each file's `+++ b/<path>` header. A deleted file (`+++ /dev/null`) adds nothing. */
export function parseAdded(output: string): Map<string, string[]> {
  const added = new Map<string, string[]>();
  let current: string[] | undefined;
  let inHunk = false;
  for (const line of output.split('\n')) {
    if (line.startsWith('diff --git ')) {
      current = undefined;
      inHunk = false;
    } else if (!inHunk && line.startsWith('+++ ')) {
      const target = line.slice(4).split('\t')[0];
      if (target === '/dev/null') current = undefined;
      else {
        const path = target.replace(/^"?b\//, '').replace(/"$/, '');
        current = added.get(path) ?? [];
        added.set(path, current);
      }
    } else if (line.startsWith('@@')) inHunk = true;
    else if (inHunk && current && line.startsWith('+')) current.push(line.slice(1));
  }
  return added;
}

export const parseChange = (nameStatus: string, diff: string): Change => ({ files: parseNameStatus(nameStatus), added: parseAdded(diff) });
