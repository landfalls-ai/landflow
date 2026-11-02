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
  /** The project it belongs to (the caller edits there), or `null`: instance-wide (owners and admins). */
  projectId: z.string().nullable().optional(),
});

export type SaveTemplateInput = z.infer<typeof saveTemplateSchema>;

/** PATCH /api/templates/:id: what to change in place. */
export const updateTemplateSchema = z.strictObject({
  name: z.string().trim().min(1).max(LIMITS.name).optional(),
  description: z.string().max(LIMITS.description).optional(),
  categories: z.array(z.string()).max(8).optional(),
  setup: z.array(z.string().max(LIMITS.step)).max(LIMITS.setup).optional(),
  /** Replace the workflow with a saved workflow's (the caller must see it). */
  workflowId: z.string().min(1).optional(),
  projectId: z.string().nullable().optional(),
});

export type UpdateTemplateInput = z.infer<typeof updateTemplateSchema>;

/** A team template's bundle in a file: the team and agent configs are cleaned by their stores when the template is used. */
const bundleSchema = z.object({
  teamKey: z.string().min(1).max(100),
  team: z.object({ name: z.string().max(200).default(''), goal: z.string().max(1000).optional(), description: z.string().max(1000).optional(), members: z.array(z.record(z.string(), z.unknown())).max(50) }),
  teamPublished: z.boolean().optional(),
  agents: z.array(z.object({ key: z.string().min(1).max(100), config: z.record(z.string(), z.unknown()), published: z.boolean().optional() })).max(30),
  hasWorkflow: z.boolean(),
  workflowKey: z.string().max(100).optional(),
});

/** "Save as template" on a team page: the team, its agents, and optionally one workflow that runs it. */
export const saveTeamTemplateSchema = z.object({
  name: z.string().trim().min(1).max(LIMITS.name),
  description: z.string().max(LIMITS.description).default(''),
  categories: z.array(z.string()).max(8).default([]),
  setup: z.array(z.string().max(LIMITS.step)).max(LIMITS.setup).default([]),
  /** A workflow with a Run a Team node set to this team (the caller must see it). */
  workflowId: z.string().min(1).optional(),
  projectId: z.string().nullable().optional(),
});

export type SaveTeamTemplateInput = z.infer<typeof saveTeamTemplateSchema>;

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
    bundle: bundleSchema.optional(),
  }),
});
