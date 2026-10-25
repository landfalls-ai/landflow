/**
 * One-time import of the JSON files older versions kept in the data directory: workflows/,
 * executions/, poll-state.json, workflow-versions/, folders.json, settings.json, variables.json and
 * data-tables/. Everything is inserted in one transaction, then each imported file or directory is
 * renamed to `<name>.imported-<YYYY-MM-DD>` (never deleted).
 *
 * Idempotent: rows that already exist are left alone (insert-if-absent), and renamed files are not
 * seen again, so an import interrupted between the commit and the renames simply runs again.
 * Unreadable files are skipped and stay in the renamed directory. Credentials, the encryption key,
 * insights.json and the agent and marketplace files are not part of the database.
 */
import { existsSync, readdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Workflow } from '@landflow/engine';
import type { DataTable, DataTableRow } from '../../shared/data-tables';
import type { ExecutionRecord, Folder, WorkflowVersion, WorkflowVersionSummary } from '../../shared/types';
import { logger } from '../telemetry/logger';
import type { Database } from './database';
import { dataTableRow, executionRow, folderRow, INSTANCE_SETTINGS, pollRow, tableRowRow, trimRunData, variableRow, versionRow, workflowRow, type StoredVariable } from './rows';

/** The files and directories the import reads, in the order it reads them. */
export const IMPORTED_PATHS = ['workflows', 'workflow-versions', 'executions', 'poll-state.json', 'folders.json', 'settings.json', 'variables.json', 'data-tables'] as const;

export interface ImportSummary {
  /** Rows inserted per kind (rows that already existed are not counted). */
  counts: Record<string, number>;
  /** What was renamed, as `from → to` names. */
  renamed: string[];
  /** Files that could not be read (left in the renamed directory). */
  skipped: string[];
}

const ID = /^[\w-]+$/;

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

const jsonFiles = (dir: string) =>
  readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .sort();

/** `<name>.imported-<date>`, with `-2`, `-3`… when that exists already. */
function renameTarget(dir: string, name: string, day: string): string {
  let target = `${name}.imported-${day}`;
  for (let n = 2; existsSync(join(dir, target)); n++) target = `${name}.imported-${day}-${n}`;
  return target;
}

/** Import whatever JSON data files `dir` still has into `db`, then rename them. */
export function importJsonData(db: Database, dir: string, now = new Date()): ImportSummary {
  const present = IMPORTED_PATHS.filter((name) => existsSync(join(dir, name)));
  const summary: ImportSummary = { counts: {}, renamed: [], skipped: [] };
  if (!present.length) return summary;
  const count = (kind: string, inserted: boolean) => {
    if (inserted) summary.counts[`landflow.db.imported.${kind}`] = (summary.counts[`landflow.db.imported.${kind}`] ?? 0) + 1;
  };
  const skip = (path: string) => summary.skipped.push(path.slice(dir.length + 1));

  db.transaction(() => {
    for (const name of present) {
      const path = join(dir, name);
      const isDir = statSync(path).isDirectory();
      switch (name) {
        case 'workflows':
          if (!isDir) break;
          for (const file of jsonFiles(path)) {
            const workflow = readJson<Workflow>(join(path, file));
            if (!workflow?.id || !Array.isArray(workflow.nodes)) skip(join(path, file));
            else count('workflows', db.insertNew('workflows', workflowRow({ ...workflow, connections: workflow.connections ?? [] })));
          }
          break;
        case 'workflow-versions':
          if (!isDir) break;
          for (const workflowId of readdirSync(path).filter((d) => ID.test(d))) {
            const versionDir = join(path, workflowId);
            if (!statSync(versionDir).isDirectory()) continue;
            const index = readJson<WorkflowVersionSummary[]>(join(versionDir, 'index.json')) ?? [];
            for (const entry of index) {
              const version = ID.test(entry.id) ? readJson<WorkflowVersion>(join(versionDir, `${entry.id}.json`)) : undefined;
              if (!version?.workflow) skip(join(versionDir, `${entry.id}.json`));
              else count('versions', db.insertNew('workflow_versions', versionRow({ ...version, ...entry, workflow: version.workflow })));
            }
          }
          break;
        case 'executions':
          if (!isDir) break;
          for (const file of jsonFiles(path)) {
            const record = readJson<ExecutionRecord>(join(path, file));
            if (!record?.executionId || !record.startedAt) skip(join(path, file));
            else count('executions', db.insertNew('executions', executionRow(trimRunData({ ...record, runData: record.runData ?? {}, executionOrder: record.executionOrder ?? [] }))));
          }
          break;
        case 'poll-state.json': {
          const polls = readJson<Record<string, unknown>>(path);
          if (!polls || typeof polls !== 'object') skip(path);
          else for (const [key, record] of Object.entries(polls)) count('polls', db.insertNew('poll_state', pollRow(key, record)));
          break;
        }
        case 'folders.json': {
          const data = readJson<{ folders?: Folder[] }>(path);
          if (!data) skip(path);
          for (const folder of Array.isArray(data?.folders) ? data.folders : []) if (folder?.id && folder.name) count('folders', db.insertNew('folders', folderRow(folder)));
          break;
        }
        case 'settings.json': {
          const settings = readJson<Record<string, unknown>>(path);
          if (!settings) skip(path);
          else count('settings', db.insertNew('settings', { key: INSTANCE_SETTINGS, value: JSON.stringify(settings) }));
          break;
        }
        case 'variables.json': {
          const data = readJson<{ variables?: StoredVariable[] }>(path);
          if (!data) skip(path);
          const stamp = now.toISOString();
          for (const variable of data?.variables ?? []) {
            if (typeof variable?.key !== 'string' || typeof variable.value !== 'string') continue;
            count('variables', db.insertNew('variables', variableRow({ ...variable, createdAt: variable.createdAt ?? stamp, updatedAt: variable.updatedAt ?? stamp })));
          }
          break;
        }
        case 'data-tables':
          if (!isDir) break;
          for (const file of jsonFiles(path)) {
            const doc = readJson<{ table?: DataTable; nextId?: number; rows?: DataTableRow[] }>(join(path, file));
            if (!doc?.table?.id) {
              skip(join(path, file));
              continue;
            }
            const rows = Array.isArray(doc.rows) ? doc.rows : [];
            const nextId = doc.nextId ?? rows.reduce((max, row) => Math.max(max, row.id), 0) + 1;
            if (!db.insertNew('data_tables', dataTableRow(doc.table, nextId))) continue;
            count('data_tables', true);
            for (const row of rows) db.insertNew('data_table_rows', tableRowRow(doc.table.id, row));
          }
          break;
      }
    }
  });

  // Committed: now move the files out of the way, so the next boot doesn't read them again.
  const day = now.toISOString().slice(0, 10);
  for (const name of present) {
    const target = renameTarget(dir, name, day);
    try {
      renameSync(join(dir, name), join(dir, target));
      summary.renamed.push(`${name} → ${target}`);
    } catch (error) {
      // Another process renamed it first (or it vanished): the rows are in, nothing is lost.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') logger.warn('could not rename an imported data file', { error, 'file.path': join(dir, name) });
    }
  }
  if (summary.skipped.length) logger.warn('some data files could not be read and were not imported', { 'landflow.db.skipped': summary.skipped.join(', ') });
  return summary;
}
