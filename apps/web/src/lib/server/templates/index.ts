/**
 * The templates library: built-in templates (./builtin.ts), templates saved on this instance (./store.ts) and, when
 * LANDFLOW_TEMPLATES_URL is set, remote ones (./remote.ts). Ids tell them apart: built-in slugs, `tpl_…` for saved
 * ones, `n8n-<id>` for remote ones.
 *
 * Credentials never travel with a template. Its nodes point at credential slots (`credentials[key].id` = slot id);
 * using the template swaps in the saved credential picked for each slot (checked for its type) or drops the
 * reference. Saving a workflow as a template turns its credential references into slots, adds slots for required
 * credentials it lacks, and leaves out pinned data, its id, folder, tags, publication state and instance-specific
 * settings. Data tables are referenced by name and created on use. A template whose nodes are missing on this
 * instance, or blocked by its governance policy, is listed with its problems and can't be used.
 */
import { nanoid } from 'nanoid';
import { isPropertyVisible, withPropertyDefaults, type NodeDescriptor } from '@landflow/protocol';
import {
  isTemplateCategory,
  type TemplateCategory,
  type TemplateCredentialSlot,
  type TemplateDataTable,
  type TemplateDetail,
  type TemplateFile,
  type TemplateProblem,
  type TemplateSource,
  type TemplateSummary,
  type UseTemplateRequest,
  type UseTemplateResult,
} from '../../shared/templates';
import { normalizeGroups } from '../../shared/groups';
import type { Workflow, WorkflowNode } from '../../shared/types';
import { credentials as vault } from '../credentials/vault';
import { dataTables } from '../datatables/service';
import { folders } from '../folders';
import { workflowViolations } from '../governance/policy';
import { normalizeWorkflow, validateWorkflow } from '../mcp/workflows';
import { registry } from '../plugins/registry';
import { workflowSchema } from '../schemas';
import { store } from '../store';
import { BUILTIN_TEMPLATES } from './builtin';
import { getRemote, remoteBase, remoteLabel, REMOTE_PREFIX, searchRemote } from './remote';
import { fileSchema, LIMITS, type SaveTemplateInput } from './schema';
import { localTemplates, type LocalTemplate } from './store';

export { BUILTIN_TEMPLATES } from './builtin';
export { saveTemplateSchema } from './schema';

/** A template request that can't be served: `status` is the HTTP status. */
export class TemplateError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'TemplateError';
  }
}

/** Trigger nodes whose `path` is a URL on this instance: a template's paths are made unique when it is used. */
const PATH_TYPES = new Set(['core.webhook', 'core.formTrigger', 'core.chatTrigger', 'core.mcpTrigger']);

// ---- node types, credentials --------------------------------------------------------------------------------------

const descriptorOf = (type: string): NodeDescriptor | undefined => registry.nodeTypes().find((t) => t.type === type)?.descriptor;

/** A requirement name ("slackApi") as the qualified credential type ("messaging.slackApi"). */
const qualified = (nodeType: string, key: string) => (key.includes('.') ? key : `${nodeType.slice(0, nodeType.indexOf('.'))}.${key}`);

/** Missing node types and the governance policy's objections. */
export function templateProblems(workflow: Pick<Workflow, 'nodes'>): TemplateProblem[] {
  const known = registry.nodeTypes();
  const types = new Set(known.map((t) => t.type));
  const problems: TemplateProblem[] = [];
  for (const type of new Set(workflow.nodes.map((n) => n.type))) {
    if (types.has(type)) continue;
    const pluginId = type.includes('.') ? type.slice(0, type.indexOf('.')) : type;
    const plugin = known.find((t) => t.pluginId === pluginId);
    problems.push({
      kind: 'missing',
      nodeType: type,
      message: plugin ? `${plugin.pluginName} has no ${type.slice(pluginId.length + 1)} node on this instance` : `Needs the ${pluginId} plugin (${type})`,
    });
  }
  for (const violation of workflowViolations(workflow)) {
    if (!problems.some((p) => p.kind === 'blocked' && p.message === violation.message)) problems.push({ kind: 'blocked', nodeType: violation.nodeType, message: violation.message });
  }
  return problems;
}

/** Triggers first, then the order the nodes come in. */
function nodeTypesOf(workflow: Pick<Workflow, 'nodes'>): string[] {
  const kind = (type: string) => descriptorOf(type)?.kind;
  const types = [...new Set(workflow.nodes.map((n) => n.type))];
  return [...types.filter((t) => kind(t) === 'trigger'), ...types.filter((t) => kind(t) !== 'trigger')];
}

/** Slots with the names of the nodes that use them. */
function withSlotNodes(slots: TemplateCredentialSlot[], workflow: Pick<Workflow, 'nodes'>): TemplateCredentialSlot[] {
  return slots.map((slot) => ({ ...slot, nodes: workflow.nodes.filter((n) => Object.values(n.credentials ?? {}).some((c) => c.id === slot.id)).map((n) => n.name) }));
}

/**
 * Credential references → slots. References to `declared` slots stay; any other reference becomes a slot (one per
 * credential type and referenced credential); a required credential a node lacks gets a slot of its type. Returns
 * the workflow with every reference pointing at a slot, and the slots.
 */
export function slotCredentials(source: Pick<Workflow, 'nodes'>, declared: TemplateCredentialSlot[] = []): { nodes: WorkflowNode[]; slots: TemplateCredentialSlot[] } {
  const slots = [...declared];
  const declaredIds = new Set(declared.map((s) => s.id));
  const byRef = new Map<string, TemplateCredentialSlot>();
  const slotOf = (type: string, ref: string, name: string) => {
    const key = `${type}\u0000${ref}`;
    let slot = byRef.get(key);
    if (!slot) {
      const base = type.slice(type.indexOf('.') + 1).replace(/[^\w-]/g, '') || 'credential';
      let id = base;
      for (let i = 2; slots.some((s) => s.id === id); i++) id = `${base}_${i}`;
      slot = { id, type, name: registry.credentialType(type)?.descriptor.displayName ?? name };
      slots.push(slot);
      byRef.set(key, slot);
    }
    return slot;
  };
  const nodes = source.nodes.map((node) => {
    const credentials: NonNullable<WorkflowNode['credentials']> = {};
    for (const [key, ref] of Object.entries(node.credentials ?? {})) {
      if (declaredIds.has(ref.id)) credentials[key] = { id: ref.id, name: declared.find((s) => s.id === ref.id)!.name };
      else {
        const slot = slotOf(qualified(node.type, key), ref.id || key, key);
        credentials[key] = { id: slot.id, name: slot.name };
      }
    }
    const descriptor = descriptorOf(node.type);
    if (descriptor) {
      const parameters = withPropertyDefaults(descriptor.properties, node.parameters);
      for (const requirement of descriptor.credentials ?? []) {
        if (!requirement.required || credentials[requirement.name] || !isPropertyVisible(requirement, parameters)) continue;
        const slot = slotOf(qualified(node.type, requirement.name), '', requirement.name);
        credentials[requirement.name] = { id: slot.id, name: slot.name };
      }
    }
    const { credentials: _old, ...rest } = node;
    return { ...rest, ...(Object.keys(credentials).length && { credentials }) };
  });
  const used = new Set(nodes.flatMap((n) => Object.values(n.credentials ?? {}).map((c) => c.id)));
  return { nodes, slots: slots.filter((s) => used.has(s.id)) };
}

// ---- the three sources ------------------------------------------------------------------------------------------

function finish(detail: Omit<TemplateDetail, 'usable' | 'problems' | 'nodeTypes' | 'nodeCount'> & Partial<Pick<TemplateDetail, 'nodeTypes'>>): TemplateDetail {
  const problems = templateProblems(detail.workflow);
  return {
    ...detail,
    nodeTypes: nodeTypesOf(detail.workflow),
    nodeCount: detail.workflow.nodes.length,
    credentials: withSlotNodes(detail.credentials, detail.workflow),
    usable: !problems.length,
    problems,
  };
}

function localDetail(t: LocalTemplate): TemplateDetail {
  return finish({ ...t, source: 'local', workflow: { ...t.workflow, id: '' } });
}

function builtinDetail(t: TemplateDetail): TemplateDetail {
  return finish(structuredClone(t));
}

async function remoteDetail(id: string): Promise<TemplateDetail | undefined> {
  const remote = await getRemote(id, descriptorOf);
  if (!remote) return undefined;
  const { nodes, slots } = slotCredentials(remote.workflow);
  return finish({ ...remote, workflow: { ...remote.workflow, nodes }, credentials: slots });
}

const summaryOf = ({ workflow: _w, setup: _s, dataTables: _d, report: _r, ...summary }: TemplateDetail): TemplateSummary => summary;

export interface TemplateListing {
  templates: TemplateSummary[];
  /** Remote templates: on when LANDFLOW_TEMPLATES_URL is set; `error` when the API couldn't be reached. */
  remote: { enabled: boolean; label?: string; error?: string };
}

function matches(t: TemplateSummary, search: string, category?: string): boolean {
  if (category && !t.categories.includes(category as TemplateCategory)) return false;
  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const haystack = [t.name, t.description, ...t.nodeTypes, ...t.categories, t.author ?? ''].join(' ').toLowerCase();
  return words.every((w) => haystack.includes(w));
}

/** Every template matching `search` (name, description, node types) and `category`; remote ones only when asked for or searched. */
export async function listTemplates(options: { search?: string; category?: string; source?: TemplateSource } = {}): Promise<TemplateListing> {
  const search = options.search?.trim() ?? '';
  const local = !options.source || options.source === 'local' ? localTemplates.list().map((t) => summaryOf(localDetail(t))) : [];
  const builtin = !options.source || options.source === 'builtin' ? BUILTIN_TEMPLATES.map((t) => summaryOf(builtinDetail(t))) : [];
  const templates = [...local, ...builtin].filter((t) => matches(t, search, options.category));
  const remote: TemplateListing['remote'] = { enabled: Boolean(remoteBase()), ...(remoteLabel() && { label: remoteLabel() }) };
  if (remote.enabled && (options.source === 'remote' || (!options.source && search))) {
    try {
      // The API searched; categories are mapped here.
      templates.push(...(await searchRemote(search)).filter((t) => matches(t, '', options.category)));
    } catch (caught) {
      remote.error = (caught as Error).message;
    }
  }
  return { templates, remote };
}

/** One template with its workflow, setup steps and state on this instance. */
export async function getTemplate(id: string): Promise<TemplateDetail | undefined> {
  const builtin = BUILTIN_TEMPLATES.find((t) => t.id === id);
  if (builtin) return builtinDetail(builtin);
  if (id.startsWith('tpl_')) {
    const local = localTemplates.get(id);
    return local && localDetail(local);
  }
  if (id.startsWith(REMOTE_PREFIX)) {
    if (!remoteBase()) return undefined;
    try {
      return await remoteDetail(id);
    } catch (caught) {
      throw new TemplateError(`Could not load the template: ${(caught as Error).message}`, 502);
    }
  }
  return undefined;
}

// ---- use ----------------------------------------------------------------------------------------------------------

/** Paths of URL triggers already taken by workflows on this instance. */
function takenPaths(): Set<string> {
  return new Set(store.listWorkflows().flatMap((w) => w.nodes.filter((n) => PATH_TYPES.has(n.type) && typeof n.parameters.path === 'string').map((n) => String(n.parameters.path))));
}

/**
 * The workflow a template creates, before saving: slots replaced by the credentials picked for them (or dropped),
 * data table names replaced by table ids (`tableIds`), URL paths made unique, defaults filled in.
 */
export function instantiate(detail: Pick<TemplateDetail, 'workflow' | 'credentials'>, picks: Record<string, { id: string; name: string } | undefined>, tableIds: Map<string, string>, taken: Set<string>): Workflow {
  const slotIds = new Set(detail.credentials.map((s) => s.id));
  const nodes = structuredClone(detail.workflow.nodes).map((node) => {
    const credentials: NonNullable<WorkflowNode['credentials']> = {};
    for (const [key, ref] of Object.entries(node.credentials ?? {})) {
      const pick = slotIds.has(ref.id) ? picks[ref.id] : undefined;
      if (pick) credentials[key] = { id: pick.id, name: pick.name };
    }
    const parameters = { ...node.parameters };
    if (node.type === 'core.dataTable' && typeof parameters.dataTableId === 'string' && tableIds.has(parameters.dataTableId)) parameters.dataTableId = tableIds.get(parameters.dataTableId);
    if (PATH_TYPES.has(node.type) && typeof parameters.path === 'string' && parameters.path) {
      const base = parameters.path;
      let path = base;
      for (let i = 2; taken.has(path); i++) path = `${base}-${i}`;
      taken.add(path);
      parameters.path = path;
    }
    const { credentials: _old, ...rest } = node;
    return { ...rest, parameters, ...(Object.keys(credentials).length && { credentials }) };
  });
  return normalizeWorkflow({ ...structuredClone(detail.workflow), nodes }) as unknown as Workflow;
}

/** Hooks the route passes in so new workflows and tables land in the caller's project. */
export interface UseHooks {
  createWorkflow(save: () => Workflow): Workflow;
  createTable(create: () => { id: string; name: string }): { id: string; name: string };
}

const directHooks: UseHooks = { createWorkflow: (save) => save(), createTable: (create) => create() };

/** Create a workflow from a template: credentials remapped, data tables created, saved as an inactive draft. */
export async function useTemplate(id: string, request: UseTemplateRequest, hooks: UseHooks = directHooks): Promise<UseTemplateResult> {
  const detail = await getTemplate(id);
  if (!detail) throw new TemplateError('Template not found', 404);
  if (!detail.usable) throw new TemplateError(`This template can’t be used here: ${detail.problems.map((p) => p.message).join('; ')}`, 409, { problems: detail.problems });
  if (request.folderId && !folders.get(request.folderId)) throw new TemplateError('Folder not found', 404);

  const picks: Record<string, { id: string; name: string } | undefined> = {};
  const warnings: string[] = [];
  for (const slot of detail.credentials) {
    const chosen = request.credentials?.[slot.id];
    if (!chosen) {
      if (!slot.optional) warnings.push(`${slot.name}: no credential picked; choose one in ${slot.nodes?.length === 1 ? `“${slot.nodes[0]}”` : 'the nodes that need it'} before running`);
      continue;
    }
    const credential = vault.get(chosen);
    if (!credential) throw new TemplateError(`${slot.name}: credential ${chosen} not found`, 400);
    if (credential.type !== slot.type) throw new TemplateError(`${slot.name}: “${credential.name}” is a ${credential.type} credential; this needs ${slot.type}`, 400);
    picks[slot.id] = { id: credential.id, name: credential.name };
  }

  const tableIds = new Map<string, string>();
  const createdTables: string[] = [];
  for (const table of detail.dataTables) {
    const existing = dataTables().findTable(table.name);
    if (existing) {
      tableIds.set(table.name, existing.id);
      continue;
    }
    const created = hooks.createTable(() => dataTables().createTable({ name: table.name, columns: table.columns }));
    tableIds.set(table.name, created.id);
    createdTables.push(created.name);
  }

  const built = instantiate(detail, picks, tableIds, takenPaths());
  const parsed = workflowSchema.safeParse({ ...built, id: `wf_${nanoid(10)}`, name: (request.name?.trim() || detail.name).slice(0, LIMITS.name) });
  if (!parsed.success) throw new TemplateError(`The template’s workflow is invalid: ${parsed.error.issues[0]?.path.join('.')}: ${parsed.error.issues[0]?.message}`, 422);
  const { folderId: _folder, active: _active, pinData: _pins, ...data } = parsed.data as Workflow;
  const workflow = hooks.createWorkflow(() => store.saveWorkflow({ ...data, active: false, ...(request.folderId && { folderId: request.folderId }) } as Workflow));
  for (const warning of validateWorkflow(workflow).errors) warnings.push(warning);
  return { workflow, createdTables, warnings, ...(detail.report && { report: detail.report }) };
}

// ---- save, import, export, delete ---------------------------------------------------------------------------------

const categoriesOf = (values: string[]): TemplateCategory[] => [...new Set(values.filter(isTemplateCategory))];

/** A workflow as a template's: no ids of this instance, no pinned data, no publication state, nothing instance-specific. */
function portable(source: Workflow, name: string, description: string): Workflow {
  const { errorWorkflowId: _error, callerIds: _callers, callerPolicy, ...settings } = source.settings ?? {};
  return {
    id: '',
    name,
    ...(description && { description }),
    nodes: structuredClone(source.nodes),
    connections: structuredClone(source.connections),
    ...(Object.keys(settings).length || (callerPolicy && callerPolicy !== 'list') ? { settings: { ...settings, ...(callerPolicy && callerPolicy !== 'list' && { callerPolicy }) } } : {}),
    ...(source.stickyNotes?.length && { stickyNotes: structuredClone(source.stickyNotes) }),
    ...(source.groups?.length && { groups: normalizeGroups(source.groups, source.nodes.map((n) => n.id)) }),
  };
}

/** The data tables a workflow's Data Table nodes use, referenced by name from now on. */
function portableTables(nodes: WorkflowNode[]): { nodes: WorkflowNode[]; tables: TemplateDataTable[] } {
  const tables = new Map<string, TemplateDataTable>();
  const next = nodes.map((node) => {
    if (node.type !== 'core.dataTable' || typeof node.parameters.dataTableId !== 'string' || !node.parameters.dataTableId) return node;
    const table = dataTables().findTable(node.parameters.dataTableId);
    if (!table) return node;
    tables.set(table.name, { name: table.name, columns: table.columns.map((c) => ({ name: c.name, type: c.type as TemplateDataTable['columns'][number]['type'] })) });
    return { ...node, parameters: { ...node.parameters, dataTableId: table.name } };
  });
  return { nodes: next, tables: [...tables.values()].slice(0, LIMITS.tables) };
}

function checkedWorkflow(raw: Record<string, unknown>, name: string): Workflow {
  const { id: _id, ...rest } = raw;
  const parsed = workflowSchema.safeParse({ ...rest, name });
  if (!parsed.success) throw new TemplateError(`The workflow is invalid: ${parsed.error.issues[0]?.path.join('.') || 'workflow'}: ${parsed.error.issues[0]?.message}`, 400);
  return { ...(parsed.data as Workflow), id: '' };
}

/** "Save as template": a local template from a workflow, credentials turned into slots, pinned data left out. */
export function saveTemplate(input: SaveTemplateInput, author?: string): TemplateDetail {
  const source = checkedWorkflow(input.workflow, input.name);
  const base = portable(source, input.name, input.description || source.description || '');
  const { nodes: tableNodes, tables } = portableTables(base.nodes);
  const { nodes, slots } = slotCredentials({ nodes: tableNodes });
  const template = localTemplates.create({
    name: input.name,
    description: input.description || source.description || '',
    categories: categoriesOf(input.categories),
    credentials: slots,
    setup: input.setup.map((s) => s.trim()).filter(Boolean),
    dataTables: tables,
    workflow: { ...base, nodes },
    ...(author && { author }),
  });
  return localDetail(template);
}

/** Import a template file (from "Export"): kept as a local template, its references checked against its slots. */
export function importTemplate(data: unknown, author?: string): TemplateDetail {
  let raw = data;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      throw new TemplateError('That isn’t JSON');
    }
  }
  const parsed = fileSchema.safeParse(raw);
  if (!parsed.success) throw new TemplateError(`Not a Landflow template file: ${parsed.error.issues[0]?.path.join('.') || 'file'}: ${parsed.error.issues[0]?.message}`);
  const { template } = parsed.data;
  const source = checkedWorkflow(template.workflow, template.name);
  const base = portable(source, template.name, template.description);
  const declared = template.credentials.filter((slot, i, all) => all.findIndex((s) => s.id === slot.id) === i);
  const { nodes, slots } = slotCredentials(base, declared);
  return localDetail(
    localTemplates.create({
      name: template.name,
      description: template.description,
      categories: categoriesOf(template.categories),
      credentials: slots,
      setup: template.setup.map((s) => s.trim()).filter(Boolean),
      dataTables: template.dataTables,
      workflow: { ...base, nodes },
      ...(author && { author }),
    }),
  );
}

/** A template as an export file (any source). */
export function templateFile(detail: TemplateDetail): TemplateFile {
  const { name, description, categories, setup, dataTables: tables, workflow } = detail;
  const credentials = detail.credentials.map(({ nodes: _nodes, ...slot }) => slot);
  return { kind: 'landflow/template', version: 1, template: { name, description, categories, credentials, setup, dataTables: tables, workflow: { ...workflow, id: '' } } };
}

/** Delete a saved template (built-in and remote ones can't be). */
export function deleteTemplate(id: string) {
  if (!id.startsWith('tpl_')) throw new TemplateError('Only templates saved on this instance can be deleted', 400);
  if (!localTemplates.delete(id)) throw new TemplateError('Template not found', 404);
}
