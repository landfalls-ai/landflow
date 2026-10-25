/**
 * What the templates API accepts: "Save as template" bodies and template files (`landflow/template`, version 1). No
 * server state here, so the OpenAPI document (lib/server/openapi.ts) can describe the bodies without loading the
 * library.
 */
import { z } from 'zod';
import { TEMPLATE_FILE_KIND } from '../../shared/templates';

export const LIMITS = { name: 200, description: 2000, setup: 20, step: 2000, slots: 50, tables: 20 };

const slotSchema = z.object({
  id: z.string().regex(/^[\w-]{1,60}$/),
  type: z.string().regex(/^[\w-]+\.[\w-]+$/),
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  optional: z.boolean().optional(),
});

const tableSchema = z.object({
  name: z.string().min(1).max(120),
  columns: z.array(z.object({ name: z.string().min(1).max(120), type: z.enum(['string', 'number', 'boolean', 'date', 'json']) })).max(100),
});

/** What "Save as template" sends: the workflow (as in the editor) and how to present it. */
export const saveTemplateSchema = z.object({
  workflow: z.record(z.string(), z.unknown()),
  name: z.string().trim().min(1).max(LIMITS.name),
  description: z.string().max(LIMITS.description).default(''),
  categories: z.array(z.string()).max(8).default([]),
  setup: z.array(z.string().max(LIMITS.step)).max(LIMITS.setup).default([]),
});

export type SaveTemplateInput = z.infer<typeof saveTemplateSchema>;

/** A template file, as "Export" writes it. */
export const fileSchema = z.object({
  kind: z.literal(TEMPLATE_FILE_KIND),
  version: z.literal(1),
  template: z.object({
    name: z.string().trim().min(1).max(LIMITS.name),
    description: z.string().max(LIMITS.description).default(''),
    categories: z.array(z.string()).max(8).default([]),
    credentials: z.array(slotSchema).max(LIMITS.slots).default([]),
    setup: z.array(z.string().max(LIMITS.step)).max(LIMITS.setup).default([]),
    dataTables: z.array(tableSchema).max(LIMITS.tables).default([]),
    workflow: z.record(z.string(), z.unknown()),
  }),
});
