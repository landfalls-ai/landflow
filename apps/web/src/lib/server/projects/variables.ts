/**
 * Project variables (migration 1400): a project's own `$vars`, in `project_variables`, with the same rules as the
 * instance's (../variables.ts: key syntax, value length, at most 500 per project). `$vars.KEY` in a workflow reads its
 * project's value first, then the instance's (`variables.forWorkflow`). Like instance variables, a project variable
 * may have a value per environment (`project_variable_environment_values`): on an instance whose LANDFLOW_ENVIRONMENT
 * matches, that value is used instead.
 *
 * Who may do what follows project roles (the routes under /api/projects/<id>/variables check them): members of the
 * project read its variables, its editors and admins change them; instance owners and admins do everything.
 */
import type { Variable } from '../../shared/platform';
import type { Database } from '../db';
import { currentEnvironment, ENVIRONMENT_NAME, EnvironmentError } from '../environments/settings';
import { auditVariable, auditVariableEnvironments, VariableStore } from '../variable-store';
import { projectsDb } from './db';

const MAX_VALUE_LENGTH = 10_000;

interface Row {
  project_id: string;
  key: string;
  value: string;
  created_at: string;
  updated_at: string;
}

interface EnvironmentRow {
  key: string;
  environment: string;
  value: string;
}

type StoredVariable = Variable & { createdAt: string; updatedAt: string };

/** One project's variables, with the instance variables' rules (VariableStore). */
class ProjectVariableTable extends VariableStore {
  constructor(
    readonly projectId: string,
    private readonly db: () => Database = projectsDb,
  ) {
    super();
  }

  protected read(): StoredVariable[] {
    return this.db()
      .all<Row>('SELECT * FROM project_variables WHERE project_id = ? ORDER BY key', this.projectId)
      .map((row) => ({ key: row.key, value: row.value, createdAt: row.created_at, updatedAt: row.updated_at }));
  }

  protected write(_list: StoredVariable[], change: { saved?: StoredVariable; removed?: string }) {
    const db = this.db();
    db.transaction(() => {
      if (change.removed) db.delete('project_variables', { project_id: this.projectId, key: change.removed });
      if (change.saved) db.upsert('project_variables', { project_id: this.projectId, key: change.saved.key, value: change.saved.value, created_at: change.saved.createdAt, updated_at: change.saved.updatedAt });
    });
  }
}

/** Per-environment values of a project's variables. */
const environmentValues = {
  of(projectId: string, key: string): Record<string, string> {
    return Object.fromEntries(
      projectsDb()
        .all<EnvironmentRow>('SELECT key, environment, value FROM project_variable_environment_values WHERE project_id = ? AND key = ? ORDER BY environment', projectId, key)
        .map((row) => [row.environment, row.value]),
    );
  },

  all(projectId: string): Record<string, Record<string, string>> {
    const out: Record<string, Record<string, string>> = {};
    for (const row of projectsDb().all<EnvironmentRow>('SELECT key, environment, value FROM project_variable_environment_values WHERE project_id = ? ORDER BY key, environment', projectId)) {
      (out[row.key] ??= {})[row.environment] = row.value;
    }
    return out;
  },

  /** Set (a string) or remove (`null`) values; other environments stay. */
  set(projectId: string, key: string, values: Record<string, string | null>): Record<string, string> {
    const before = this.of(projectId, key);
    const after = this.put(projectId, key, values);
    auditVariableEnvironments(key, { projectId }, before, values);
    return after;
  },

  /** `set` without the audit event (a rename moves the values; the variable's own `variable.update` covers it). */
  put(projectId: string, key: string, values: Record<string, string | null>): Record<string, string> {
    for (const [environment, value] of Object.entries(values)) {
      if (!ENVIRONMENT_NAME.test(environment)) throw new EnvironmentError(`“${environment}” is not an environment name`);
      if (value !== null && (typeof value !== 'string' || value.length > MAX_VALUE_LENGTH)) throw new EnvironmentError(`The ${environment} value of ${key} must be a string of at most ${MAX_VALUE_LENGTH} characters`);
    }
    const db = projectsDb();
    const now = new Date().toISOString();
    db.transaction(() => {
      for (const [environment, value] of Object.entries(values)) {
        if (value === null) db.delete('project_variable_environment_values', { project_id: projectId, key, environment });
        else db.upsert('project_variable_environment_values', { project_id: projectId, key, environment, value, updated_at: now });
      }
    });
    return this.of(projectId, key);
  },

  remove(projectId: string, key: string) {
    projectsDb().delete('project_variable_environment_values', { project_id: projectId, key });
  },

  rename(projectId: string, from: string, to: string) {
    const values = this.of(projectId, from);
    if (!Object.keys(values).length) return;
    this.remove(projectId, from);
    this.put(projectId, to, values);
  },
};

export const projectVariables = {
  store: (projectId: string): VariableStore => new ProjectVariableTable(projectId),
  list: (projectId: string) => projectVariables.store(projectId).list(),
  get: (projectId: string, key: string) => projectVariables.store(projectId).get(key),
  create(projectId: string, input: { key: string; value: unknown }): Variable {
    const created = projectVariables.store(projectId).create(input);
    auditVariable('create', created.key, { projectId });
    return created;
  },
  update(projectId: string, key: string, patch: { key?: string; value?: unknown }): Variable {
    const before = projectVariables.get(projectId, key);
    const updated = projectVariables.store(projectId).update(key, patch);
    if (updated.key !== key) environmentValues.rename(projectId, key, updated.key);
    // A PATCH that renamed nothing and kept the value records nothing (as the per-environment path does).
    const valueChanged = before?.value !== updated.value;
    if (updated.key !== key || valueChanged) auditVariable('update', updated.key, { projectId }, { ...(updated.key !== key && { renamedFrom: key }), valueChanged });
    return updated;
  },
  delete(projectId: string, key: string): boolean {
    const deleted = projectVariables.store(projectId).delete(key);
    if (deleted) {
      environmentValues.remove(projectId, key);
      auditVariable('delete', key, { projectId });
    }
    return deleted;
  },
  environments: environmentValues,

  /** What the project adds to `$vars`: each variable's value, or its value for this environment where it has one. */
  record(projectId: string): Record<string, string> {
    const record = projectVariables.store(projectId).record();
    const environment = currentEnvironment();
    if (!environment || !Object.keys(record).length) return record;
    for (const row of projectsDb().all<EnvironmentRow>('SELECT key, environment, value FROM project_variable_environment_values WHERE project_id = ? AND environment = ?', projectId, environment)) {
      if (row.key in record) record[row.key] = row.value;
    }
    return record;
  },

  /** Hand a project's variables to another (deleting a project with a transfer); keys the target has already stay the target's. */
  moveAll(fromProjectId: string, toProjectId: string): number {
    const db = projectsDb();
    const taken = new Set(projectVariables.list(toProjectId).map((v) => v.key));
    let moved = 0;
    db.transaction(() => {
      for (const row of db.all<Row>('SELECT * FROM project_variables WHERE project_id = ?', fromProjectId)) {
        if (!taken.has(row.key)) {
          db.upsert('project_variables', { ...row, project_id: toProjectId });
          for (const [environment, value] of Object.entries(environmentValues.of(fromProjectId, row.key))) {
            db.upsert('project_variable_environment_values', { project_id: toProjectId, key: row.key, environment, value, updated_at: row.updated_at });
          }
          moved++;
        }
      }
      projectVariables.removeProject(fromProjectId);
    });
    return moved;
  },

  /** Forget a deleted project's variables. */
  removeProject(projectId: string) {
    const db = projectsDb();
    db.transaction(() => {
      for (const row of db.all<EnvironmentRow>('SELECT key, environment FROM project_variable_environment_values WHERE project_id = ?', projectId)) {
        db.delete('project_variable_environment_values', { project_id: projectId, key: row.key, environment: row.environment });
      }
      for (const row of db.all<Row>('SELECT key FROM project_variables WHERE project_id = ?', projectId)) db.delete('project_variables', { project_id: projectId, key: row.key });
    });
  },
};
