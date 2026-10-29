/**
 * Templates saved on this instance, in the `templates` table (migration 1100): "Save as template" from a workflow and
 * imported template files. The row keeps the template document in `data`; built-in and remote templates never land
 * here. A saved template belongs to a project (`project_id`, migration 1401: its members see and use it, its editors
 * change it) or is instance-wide (no project: every builder sees it; owners and admins publish and change those).
 */
import { nanoid } from 'nanoid';
import type { TemplateCategory, TemplateCredentialSlot, TemplateDataTable, TemplateOrigin } from '../../shared/templates';
import type { Workflow } from '../../shared/types';
import { projectsDb } from '../projects/db';

/** What a saved template keeps. */
export interface LocalTemplate {
  id: string;
  name: string;
  description: string;
  categories: TemplateCategory[];
  credentials: TemplateCredentialSlot[];
  setup: string[];
  dataTables: TemplateDataTable[];
  workflow: Workflow;
  author?: string;
  /** The project it belongs to; none = instance-wide. */
  projectId?: string;
  /** A marketplace plugin's flow (kept in `data`, so no column). */
  origin?: TemplateOrigin;
  createdAt: string;
  updatedAt: string;
}

interface TemplateRow {
  id: string;
  name: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  data: string;
  project_id: string | null;
}

type Document = Omit<LocalTemplate, 'id' | 'name' | 'author' | 'projectId' | 'createdAt' | 'updatedAt'>;

const COLUMNS = 'id, name, created_by, created_at, updated_at, data, project_id';

function fromRow(row: TemplateRow): LocalTemplate | undefined {
  try {
    const { projectId: _ignored, ...data } = JSON.parse(row.data) as Document & { projectId?: string };
    return {
      ...data,
      id: row.id,
      name: row.name,
      ...(row.created_by && { author: row.created_by }),
      ...(row.project_id && { projectId: row.project_id }),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  } catch {
    return undefined;
  }
}

function save(template: LocalTemplate) {
  const { id, name, author, projectId, createdAt, updatedAt, ...data } = template;
  projectsDb().upsert('templates', { id, name, created_by: author ?? null, created_at: createdAt, updated_at: updatedAt, data: JSON.stringify(data), project_id: projectId ?? null });
}

export const localTemplates = {
  list(): LocalTemplate[] {
    return projectsDb()
      .all<TemplateRow>(`SELECT ${COLUMNS} FROM templates ORDER BY created_at DESC`)
      .flatMap((row) => fromRow(row) ?? []);
  },

  get(id: string): LocalTemplate | undefined {
    const row = projectsDb().get<TemplateRow>(`SELECT ${COLUMNS} FROM templates WHERE id = ?`, id);
    return row && fromRow(row);
  },

  create(input: Omit<LocalTemplate, 'id' | 'createdAt' | 'updatedAt'>): LocalTemplate {
    const now = new Date().toISOString();
    const template: LocalTemplate = { ...input, id: `tpl_${nanoid(10)}`, createdAt: now, updatedAt: now };
    save(template);
    return template;
  },

  /** Replace what `patch` names (edit in place: the id, author and creation time stay). */
  update(id: string, patch: Partial<Omit<LocalTemplate, 'id' | 'createdAt' | 'updatedAt' | 'author'>>): LocalTemplate | undefined {
    const current = localTemplates.get(id);
    if (!current) return undefined;
    const next: LocalTemplate = { ...current, ...patch, id, updatedAt: new Date().toISOString() };
    if (patch.projectId === undefined && 'projectId' in patch) delete next.projectId;
    save(next);
    return next;
  },

  delete(id: string): boolean {
    return projectsDb().delete('templates', { id }) > 0;
  },

  /** Hand a project's templates to another (`to`), or remove them (a deleted project without a transfer). */
  moveProject(from: string, to?: string): number {
    const rows = projectsDb().all<TemplateRow>(`SELECT ${COLUMNS} FROM templates WHERE project_id = ?`, from);
    for (const row of rows) {
      if (to) projectsDb().upsert('templates', { ...row, project_id: to });
      else projectsDb().delete('templates', { id: row.id });
    }
    return rows.length;
  },
};
