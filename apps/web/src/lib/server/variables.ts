/**
 * Variables (Settings → Variables): instance-wide key/value strings that
 * expressions read as `$vars.NAME`, kept in the `variables` table
 * (lib/server/db). VariableFile keeps them in a JSON file instead (the format
 * older versions used; tests use it too). The runner reads them fresh for every
 * run; the Code node and agent node tools see the same values. Read-only inside
 * workflows.
 *
 * Projects have variables too (./projects/variables.ts): a workflow's `$vars` is
 * its project's variables over the instance's (`variables.forWorkflow`), each
 * with its value for this environment where it has one.
 */
import { database, type Database } from './db';
import { variableRow } from './db/rows';
import { environmentValues } from './environments/variables';
import { projectVariables } from './projects/variables';
import { homeProjectId } from './projects/store';
import { auditVariable, VariableStore, type StoredVariable, type VariableChange } from './variable-store';

export { MAX_KEY_LENGTH, MAX_VALUE_LENGTH, MAX_VARIABLES, VARIABLE_KEY, VariableError, VariableFile, VariableStore, type Variable } from './variable-store';

/** Variables in the database's `variables` table: the instance's. */
export class VariableTable extends VariableStore {
  constructor(private readonly db: () => Database = database) {
    super();
  }

  protected read(): StoredVariable[] {
    return this.db()
      .all<{ key: string; value: string; created_at: string; updated_at: string }>('SELECT key, value, created_at, updated_at FROM variables ORDER BY key')
      .map((row) => ({ key: row.key, value: row.value, createdAt: row.created_at, updatedAt: row.updated_at }));
  }

  protected write(_list: StoredVariable[], change: VariableChange) {
    const db = this.db();
    db.transaction(() => {
      if (change.removed) db.delete('variables', { key: change.removed });
      if (change.saved) db.upsert('variables', variableRow(change.saved));
    });
  }
}

const table = new VariableTable();

/** The instance's variables (the `variables` table). */
export const variables = {
  file: (): VariableStore => table,
  list: () => variables.file().list(),
  /** The instance's `$vars`: with LANDFLOW_ENVIRONMENT, a variable's value for this environment where it has one (lib/server/environments). */
  record: () => environmentValues.overlay(variables.file().record()),
  /** What `$vars` sees in a project's workflows and agents: the project's variables first, then the instance's. */
  forProject: (projectId: string | undefined): Record<string, string> => {
    const instance = variables.record();
    if (!projectId) return instance;
    try {
      return { ...instance, ...projectVariables.record(projectId) };
    } catch {
      // No project variables table yet (an old database mid-upgrade): the instance's.
      return instance;
    }
  },
  /** `$vars` of a run of `workflowId` (`agent:<id>` for an agent's tools: the agent's project). */
  forWorkflow: (workflowId: string | undefined): Record<string, string> => {
    if (!workflowId) return variables.record();
    const project = workflowId.startsWith('agent:') ? homeProjectId('agent', workflowId.slice('agent:'.length)) : homeProjectId('workflow', workflowId);
    return variables.forProject(project);
  },
  get: (key: string) => variables.file().get(key),
  create: (input: { key: string; value: unknown }) => {
    const created = variables.file().create(input);
    auditVariable('create', created.key, {});
    return created;
  },
  update: (key: string, patch: { key?: string; value?: unknown }) => {
    const before = variables.file().get(key);
    const updated = variables.file().update(key, patch);
    if (updated.key !== key) environmentValues.rename(key, updated.key);
    // A PATCH that renamed nothing and kept the value records nothing (as the per-environment path does).
    const valueChanged = before?.value !== updated.value;
    if (updated.key !== key || valueChanged) auditVariable('update', updated.key, {}, { ...(updated.key !== key && { renamedFrom: key }), valueChanged });
    return updated;
  },
  delete: (key: string) => {
    const deleted = variables.file().delete(key);
    if (deleted) {
      environmentValues.remove(key);
      auditVariable('delete', key, {});
    }
    return deleted;
  },
};
