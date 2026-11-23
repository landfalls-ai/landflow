/**
 * A sync directory on disk (the source-control working copy): write an export into it, removing managed files it
 * no longer has, and read its managed files back. Files the format doesn't own (a README, .git) are left alone.
 * The CLI has the same two operations for its `--dir` (packages/cli/src/sync/files.ts).
 */
import { lstatSync, mkdirSync, readdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DATA_TABLES_DIR, isManagedPath, isSafePath, WORKFLOWS_DIR, type SyncFile } from '@landflow/protocol';

/**
 * Every regular file under `root` as a `/`-separated relative path, skipping `.git` and other dot-directories.
 * Symbolic links are skipped, never followed: a repository can't point a managed path at a file outside it.
 */
function walk(root: string, prefix = ''): string[] {
  let entries: string[];
  try {
    entries = readdirSync(join(root, prefix));
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of entries.sort()) {
    const rel = prefix ? `${prefix}/${name}` : name;
    let stats;
    try {
      stats = lstatSync(join(root, rel));
    } catch {
      continue;
    }
    if (stats.isDirectory()) {
      if (!name.startsWith('.')) out.push(...walk(root, rel));
    } else if (stats.isFile()) out.push(rel);
  }
  return out;
}

/** The managed files of a directory. */
export function readSyncDir(root: string): SyncFile[] {
  return walk(root)
    .filter(isManagedPath)
    .map((path) => ({ path, content: readFileSync(join(root, path), 'utf8') }));
}

/** Remove directories under `dir` that became empty (deepest first); `dir` itself stays. */
function removeEmptyDirs(root: string, dir: string): boolean {
  const full = join(root, dir);
  let entries: string[];
  try {
    entries = readdirSync(full);
  } catch {
    return false;
  }
  let empty = true;
  for (const name of entries) {
    const rel = `${dir}/${name}`;
    let isDir = false;
    try {
      isDir = lstatSync(join(root, rel)).isDirectory();
    } catch {
      continue;
    }
    if (isDir && !name.startsWith('.') && removeEmptyDirs(root, rel)) {
      try {
        rmdirSync(join(root, rel));
        continue;
      } catch {
        // Not empty after all.
      }
    }
    empty = false;
  }
  return empty;
}

/** `path` (relative to `root`) or a directory on the way to it is a symbolic link. */
function throughSymlink(root: string, path: string): boolean {
  const parts = path.split('/');
  for (let i = 1; i <= parts.length; i++) {
    try {
      if (lstatSync(join(root, ...parts.slice(0, i))).isSymbolicLink()) return true;
    } catch {
      return false;
    }
  }
  return false;
}

/** Make `root` hold exactly `files` among its managed paths. Returns the paths written (changed or new) and removed. */
export function writeSyncDir(root: string, files: SyncFile[]): { written: string[]; removed: string[] } {
  const wanted = new Map(files.filter((f) => isSafePath(f.path) && isManagedPath(f.path)).map((f) => [f.path, f.content]));
  const written: string[] = [];
  const removed: string[] = [];
  for (const [path, content] of wanted) {
    const full = join(root, path);
    if (throughSymlink(root, path)) throw new Error(`${path} goes through a symbolic link: not writing it`);
    let current: string | undefined;
    try {
      current = readFileSync(full, 'utf8');
    } catch {
      current = undefined;
    }
    if (current === content) continue;
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
    written.push(path);
  }
  for (const path of walk(root)) {
    if (!isManagedPath(path) || wanted.has(path)) continue;
    unlinkSync(join(root, path));
    removed.push(path);
  }
  removeEmptyDirs(root, WORKFLOWS_DIR);
  removeEmptyDirs(root, DATA_TABLES_DIR);
  return { written, removed };
}
