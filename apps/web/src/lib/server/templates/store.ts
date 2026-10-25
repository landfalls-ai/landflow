/**
 * Templates saved on this instance, in the `templates` table (migration 1100): "Save as template" from a workflow and
 * imported template files. The row keeps the template document in `data`; built-in and remote templates never land
 * here. Instance-wide for now (every builder sees them), like n8n's.
 */
import { nanoid } from 'nanoid';
import type { TemplateCategory, TemplateCredentialSlot, TemplateDataTable } from '../../shared/templates';
import type { Workflow } from '../../shared/types';
import { database } from '../db';

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
}

type Document = Omit<LocalTemplate, 'id' | 'name' | 'author' | 'createdAt' | 'updatedAt'>;

function fromRow(row: TemplateRow): LocalTemplate | undefined {
  try {
    const data = JSON.parse(row.data) as Document;
    return { ...data, id: row.id, name: row.name, ...(row.created_by && { author: row.created_by }), createdAt: row.created_at, updatedAt: row.updated_at };
  } catch {
    return undefined;
  }
}

export const localTemplates = {
  list(): LocalTemplate[] {
    return database()
      .all<TemplateRow>('SELECT id, name, created_by, created_at, updated_at, data FROM templates ORDER BY created_at DESC')
      .flatMap((row) => fromRow(row) ?? []);
  },

  get(id: string): LocalTemplate | undefined {
    const row = database().get<TemplateRow>('SELECT id, name, created_by, created_at, updated_at, data FROM templates WHERE id = ?', id);
    return row && fromRow(row);
  },

  create(input: Omit<LocalTemplate, 'id' | 'createdAt' | 'updatedAt'>): LocalTemplate {
    const now = new Date().toISOString();
    const template: LocalTemplate = { ...input, id: `tpl_${nanoid(10)}`, createdAt: now, updatedAt: now };
    const { id, name, author, createdAt, updatedAt, ...data } = template;
    database().upsert('templates', { id, name, created_by: author ?? null, created_at: createdAt, updated_at: updatedAt, data: JSON.stringify(data) });
    return template;
  },

  delete(id: string): boolean {
    return database().delete('templates', { id }) > 0;
  },
};
