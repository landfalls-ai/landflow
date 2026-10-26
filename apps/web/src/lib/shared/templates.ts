/**
 * The templates library (lib/server/templates, /api/templates, /templates): ready-made workflows to start from. Three
 * sources: built-in templates that ship with Landflow, templates saved on this instance ("Save as template", or an
 * imported template file), and, when LANDFLOW_TEMPLATES_URL points at an n8n-compatible templates API, remote ones
 * converted by the n8n importer. Shapes shared by the API and the pages. No runtime imports.
 */
import type { ImportReport, Workflow } from './types';

export const TEMPLATE_CATEGORIES = [
  { id: 'ai', name: 'AI' },
  { id: 'sales', name: 'Sales' },
  { id: 'it-ops', name: 'IT Ops' },
  { id: 'marketing', name: 'Marketing' },
  { id: 'data', name: 'Data' },
  { id: 'support', name: 'Support' },
  { id: 'engineering', name: 'Engineering' },
  { id: 'productivity', name: 'Productivity' },
] as const;

export type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number]['id'];

export const isTemplateCategory = (value: unknown): value is TemplateCategory => TEMPLATE_CATEGORIES.some((c) => c.id === value);

/** `builtin`: ships with Landflow. `local`: saved on this instance. `remote`: from LANDFLOW_TEMPLATES_URL. */
export type TemplateSource = 'builtin' | 'local' | 'remote';

/**
 * A credential the template needs. The template's nodes point at it with `credentials[key].id = slot.id`; using the
 * template replaces that with the saved credential picked (or created) in the setup step.
 */
export interface TemplateCredentialSlot {
  id: string;
  /** Qualified credential type (`core.openAiApi`, `messaging.slackApi`). */
  type: string;
  /** What the setup step calls it ("OpenAI account"). */
  name: string;
  description?: string;
  /** The workflow runs without it (an Anthropic model behind a local proxy, say). */
  optional?: boolean;
  /** Names of the nodes that use it (filled in by the server). */
  nodes?: string[];
}

/** A data table the template reads or writes, created (by name) when the template is used unless it exists. */
export interface TemplateDataTable {
  name: string;
  columns: { name: string; type: 'string' | 'number' | 'boolean' | 'date' | 'json' }[];
}

/** Why a template can't be used (or needs attention) on this instance. */
export interface TemplateProblem {
  kind: 'missing' | 'blocked';
  nodeType: string;
  message: string;
}

export interface TemplateSummary {
  id: string;
  source: TemplateSource;
  name: string;
  description: string;
  categories: TemplateCategory[];
  /** Distinct node types, triggers first (the card shows their icons). */
  nodeTypes: string[];
  nodeCount: number;
  credentials: TemplateCredentialSlot[];
  /** Who made it: "Landflow", the user who saved it, or the remote author. */
  author?: string;
  createdAt?: string;
  updatedAt?: string;
  /** False when a node type is missing on this instance or blocked by its governance policy (see `problems`). */
  usable: boolean;
  problems: TemplateProblem[];
  /** Saved templates: the project it belongs to (none: instance-wide, like the built-in ones). */
  projectId?: string;
  projectName?: string;
  /** The viewer may edit or delete it (editors of its project; owners and admins for instance-wide ones). */
  canEdit?: boolean;
}

export interface TemplateDetail extends TemplateSummary {
  /** The workflow the template creates: credentials point at slots, no ids of this instance, no pinned data. */
  workflow: Workflow;
  /** Steps to finish the setup, in Markdown. */
  setup: string[];
  dataTables: TemplateDataTable[];
  /** Remote templates: what the n8n importer did with the workflow. */
  report?: ImportReport;
}

/** A template as an export file, for sharing between instances. */
export interface TemplateFile {
  kind: 'landflow/template';
  version: 1;
  template: Pick<TemplateDetail, 'name' | 'description' | 'categories' | 'credentials' | 'setup' | 'dataTables' | 'workflow'>;
}

export const TEMPLATE_FILE_KIND = 'landflow/template';

/** PATCH /api/templates/:id: edit a saved template in place. */
export interface UpdateTemplateRequest {
  name?: string;
  description?: string;
  categories?: TemplateCategory[];
  setup?: string[];
  /** Replace its workflow with a saved workflow's (credentials become slots, pinned data is left out). */
  workflowId?: string;
  /** Move it to a project, or `null`: instance-wide (owners and admins). */
  projectId?: string | null;
}

/** POST /api/templates/:id/use */
export interface UseTemplateRequest {
  name?: string;
  folderId?: string;
  /** Slot id → saved credential id; a slot left out (or null) leaves its nodes without a credential. */
  credentials?: Record<string, string | null>;
}

export interface UseTemplateResult {
  workflow: Workflow;
  /** Data tables created for the workflow (existing ones with the same name are reused). */
  createdTables: string[];
  warnings: string[];
  report?: ImportReport;
}
