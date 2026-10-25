/**
 * What a sync directory remembers about each instance it was synced with, in `<dir>/.landflow/state.json` (the
 * directory ignores itself with a `.gitignore`, so it never reaches the repository):
 *
 *   files   sha256 of each managed file as of the last pull or push: a file that differs now was edited locally, and
 *           `pull` won't overwrite it without --force
 *   hashes  the instance's entity hashes after that sync: `push` sends them as the base, so edits made on the
 *           instance since then come back as conflicts
 *   values  the last pull wrote variable values
 *
 * State is per instance URL, so one directory can be pulled from staging and pushed to production.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CliError } from '../errors';
import { sha256, type SyncFiles } from './files';

export const STATE_DIR = '.landflow';
const STATE_FILE = 'state.json';
const STATE_FORMAT = 'landflow-cli-sync/v1';

export interface InstanceState {
  url: string;
  /** When the last pull or push finished. */
  at: string;
  values: boolean;
  files: Record<string, string>;
  hashes: Record<string, string>;
}

export interface DirState {
  format: string;
  instances: Record<string, InstanceState>;
}

export function readState(dir: string): DirState {
  let text: string;
  try {
    text = readFileSync(join(dir, STATE_DIR, STATE_FILE), 'utf8');
  } catch {
    return { format: STATE_FORMAT, instances: {} };
  }
  try {
    const parsed = JSON.parse(text) as Partial<DirState>;
    return { format: STATE_FORMAT, instances: parsed.instances && typeof parsed.instances === 'object' ? parsed.instances : {} };
  } catch {
    throw new CliError('io', `${join(dir, STATE_DIR, STATE_FILE)} isn't valid JSON: delete it (the next pull rebuilds it, asking for --force over local files)`);
  }
}

export function writeState(dir: string, state: DirState) {
  const base = join(dir, STATE_DIR);
  try {
    mkdirSync(base, { recursive: true });
    writeFileSync(join(base, '.gitignore'), '*\n');
    const tmp = join(base, `${STATE_FILE}.${process.pid}.tmp`);
    writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
    renameSync(tmp, join(base, STATE_FILE));
  } catch (caught) {
    throw new CliError('io', `Can't write ${join(base, STATE_FILE)}: ${(caught as NodeJS.ErrnoException).code ?? (caught as Error).message}`);
  }
}

export const fileHashes = (files: SyncFiles): Record<string, string> => Object.fromEntries([...files].map(([path, content]) => [path, sha256(content)]));

/** Local edits since the last sync with an instance: managed files added, changed or deleted. */
export function localChanges(files: SyncFiles, instance: InstanceState | undefined): { added: string[]; modified: string[]; deleted: string[] } {
  const recorded = instance?.files ?? {};
  const added: string[] = [];
  const modified: string[] = [];
  for (const [path, content] of files) {
    if (!(path in recorded)) added.push(path);
    else if (recorded[path] !== sha256(content)) modified.push(path);
  }
  const deleted = Object.keys(recorded)
    .filter((path) => !files.has(path))
    .sort();
  return { added, modified, deleted };
}
