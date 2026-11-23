/**
 * The shared, pure part of the Git sync format `landflow-sync/v1`: its name, the file and directory names, which paths
 * the format owns and which are safe, and the manifest's shape. The host (apps/web/src/lib/server/sync/format.ts, which
 * also serializes and parses the files) and the CLI (packages/cli/src/sync/files.ts, which reads and writes a sync
 * directory) both import it, so the layout has one source. No Node imports: it is plain string logic.
 */

export const SYNC_FORMAT = 'landflow-sync/v1';
export const MANIFEST_FILE = 'landflow-sync.json';
export const VARIABLES_FILE = 'variables.json';
export const CREDENTIALS_FILE = 'credentials.json';
export const DATA_TABLES_DIR = 'data-tables';
export const WORKFLOWS_DIR = 'workflows';
export const FOLDER_FILE = '.folder.json';
export const WORKFLOW_SUFFIX = '.workflow.json';
export const TABLE_SUFFIX = '.schema.json';
export const ROWS_SUFFIX = '.rows.json';

/** The manifest (`landflow-sync.json`): it names the format so a reader can refuse a layout it doesn't know. */
export interface SyncManifest {
  format: typeof SYNC_FORMAT;
}

/** One file of a sync directory: a `/`-separated path relative to the directory, and its text. */
export interface SyncFile {
  path: string;
  content: string;
}

/** True for the paths the format owns: pull writes and removes them, push reads them; anything else is left alone. */
export function isManagedPath(path: string): boolean {
  if (path === MANIFEST_FILE || path === VARIABLES_FILE || path === CREDENTIALS_FILE) return true;
  const parts = path.split('/');
  // A table's schema, and (written by promotion for opted-in tables) its rows.
  if (parts[0] === DATA_TABLES_DIR) return parts.length === 2 && (path.endsWith(TABLE_SUFFIX) || path.endsWith(ROWS_SUFFIX));
  if (parts[0] === WORKFLOWS_DIR) return parts.length >= 2 && (path.endsWith(WORKFLOW_SUFFIX) || parts.at(-1) === FOLDER_FILE);
  return false;
}

/** A relative path without `..`, empty segments, backslashes or a leading slash. */
export function isSafePath(path: string): boolean {
  return Boolean(path) && !path.startsWith('/') && !path.includes('\\') && !path.includes('\0') && path.split('/').every((p) => p && p !== '.' && p !== '..');
}
