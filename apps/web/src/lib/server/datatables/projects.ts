/**
 * Data tables per project, for the Data Table node: a workflow only reads and writes the tables of its own project
 * (data tables aren't shared between projects). Runs check it per table (`tableProblem`); the node's pickers
 * (load options) list the tables of the workflow being edited, which the load-options route puts in scope
 * (`withTableScope`). Instance owners and admins see every table on the Data tables page, but a workflow still only
 * uses its project's.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { DataTable, DataTableSummary } from '../../shared/data-tables';
import { filterVisible, type Actor } from '../projects/access';
import { defaultProjectId, getProject, homeProjectId, homeProjects } from '../projects/store';
import { singleton } from '../singleton';
import { dataTables } from './service';

/** What a picker sees: the tables of `projectId` (the workflow being edited), else those `actor` sees. */
export interface TableScope {
  projectId?: string;
  actor?: Actor;
}

const storage = () => singleton('data-table-scope', () => new AsyncLocalStorage<TableScope>());

export function withTableScope<T>(scope: TableScope, fn: () => T): T {
  return storage().run(scope, fn);
}

export function tableScope(): TableScope | undefined {
  return storage().getStore();
}

/** The project of a run's workflow (`agent:<id>`: the agent's). */
export function workflowProject(workflowId: string | undefined): string | undefined {
  if (!workflowId) return defaultProjectId();
  return workflowId.startsWith('agent:') ? homeProjectId('agent', workflowId.slice('agent:'.length)) : homeProjectId('workflow', workflowId);
}

/** Whether a table belongs to `projectId` (a table without a row belongs to the default project). */
export function tableInProject(tableId: string, projectId: string | undefined): boolean {
  return homeProjectId('dataTable', tableId) === projectId;
}

/** Why a workflow of `projectId` can't use `table`, or undefined when it can. */
export function tableProblem(table: Pick<DataTable, 'id' | 'name'>, projectId: string | undefined): { message: string; description: string } | undefined {
  if (tableInProject(table.id, projectId)) return undefined;
  const owner = getProject(homeProjectId('dataTable', table.id) ?? '');
  const mine = getProject(projectId ?? '');
  return {
    message: `Data table “${table.name}” belongs to ${owner ? `the “${owner.name}” project` : 'another project'}`,
    description: `A workflow only uses the data tables of its own project${mine ? ` (“${mine.name}”)` : ''}. Pick one of its tables, or move the table to this workflow’s project.`,
  };
}

/** The tables a picker in `scope` offers, by name. */
export function tablesInScope(scope: TableScope | undefined): DataTableSummary[] {
  const all = dataTables().listTables();
  if (scope?.projectId) {
    const homes = homeProjects('dataTable');
    const fallback = defaultProjectId();
    return all.filter((table) => (homes.get(table.id) ?? fallback) === scope.projectId);
  }
  return scope?.actor ? filterVisible(scope.actor, 'dataTable', all) : all;
}

/** A table the picker in `scope` may show (for its columns): undefined when it is another project's. */
export function scopedTable(ref: string, scope: TableScope | undefined): DataTable | undefined {
  const table = dataTables().findTable(ref);
  if (!table || !scope) return table;
  if (scope.projectId) return tableInProject(table.id, scope.projectId) ? table : undefined;
  return scope.actor && !filterVisible(scope.actor, 'dataTable', [table]).length ? undefined : table;
}

/** A table name not taken in `projectId` (names are unique per project): `name`, else `name 2`, `name 3`… */
export function freeTableName(name: string, projectId?: string): string {
  const taken = new Set(dataTables().inProject(dataTables().listTables(), projectId).map((t) => t.name.toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  for (let i = 2; ; i++) if (!taken.has(`${name} ${i}`.toLowerCase())) return `${name} ${i}`;
}
