/** The rows of saved agent templates (`agent_templates`), apart from ./templates.ts so project transfers needn't load it. */
import { database } from '../db';

export interface AgentTemplateRow {
  id: string;
  name: string;
  project_id: string | null;
  created_by: string | null;
  created_at: string;
  data: string;
}

const COLUMNS = 'id, name, project_id, created_by, created_at, data';

export const agentTemplateRows = {
  list(): AgentTemplateRow[] {
    return database().all<AgentTemplateRow>(`SELECT ${COLUMNS} FROM agent_templates ORDER BY created_at DESC`);
  },
  get(id: string): AgentTemplateRow | undefined {
    return database().get<AgentTemplateRow>(`SELECT ${COLUMNS} FROM agent_templates WHERE id = ?`, id);
  },
  save(row: AgentTemplateRow) {
    database().upsert('agent_templates', { ...row });
  },
  delete(id: string): boolean {
    return database().delete('agent_templates', { id }) > 0;
  },
  /** Hand a project's templates to another (`to`), or remove them (a deleted project without a transfer). */
  moveProject(from: string, to?: string): number {
    const rows = database().all<AgentTemplateRow>(`SELECT ${COLUMNS} FROM agent_templates WHERE project_id = ?`, from);
    for (const row of rows) {
      if (to) database().upsert('agent_templates', { ...row, project_id: to });
      else database().delete('agent_templates', { id: row.id });
    }
    return rows.length;
  },
};
