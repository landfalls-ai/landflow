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
 *
 * Saved templates belong to a project (its members see and use them, its editors change them) or are instance-wide
 * (everyone sees them; owners and admins publish and change them), like built-in ones. The library lists what the
 * viewer sees, or with `projectId` that project's plus the instance-wide ones. A saved template can be edited in
 * place: its name, description, categories and setup steps, its project, and its workflow, replaced from a workflow.
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
  type TemplateOrigin,
  type TemplateProblem,
  type TemplateSource,
  type TemplateSummary,
  type UseTemplateRequest,
  type UseTemplateResult,
} from '../../shared/templates';
import { normalizeGroups } from '../../shared/groups';
import { workflowCompositeIssues } from '../composites';
import type { FlowPreview } from '../../shared/marketplace';
import type { Workflow, WorkflowNode } from '../../shared/types';
import { credentials as vault } from '../credentials/vault';
import { tableInProject } from '../datatables/projects';
import { dataTables } from '../datatables/service';
import { folders } from '../folders';
import { scopeFor, workflowViolations } from '../governance/policy';
import { isInstanceAdmin, projectRole, visibleProjectIds, type Actor } from '../projects/access';
import { ensurePersonalProject, getProject, listProjects } from '../projects/store';
import { projectRoleCan } from '../../shared/projects';
import { normalizeWorkflow, validateWorkflow } from '../mcp/workflows';
import { registry } from '../plugins/registry';
import { workflowSchema } from '../schemas';
import { store } from '../store';
import { BUILTIN_TEMPLATES } from './builtin';
import { getRemote, remoteBase, remoteLabel, REMOTE_PAGE_SIZE, REMOTE_PREFIX, searchRemotePage } from './remote';
import { fileSchema, LIMITS, type SaveTemplateInput, type UpdateTemplateInput } from './schema';
import { localTemplates, type LocalTemplate } from './store';

export { BUILTIN_TEMPLATES } from './builtin';
export { saveTemplateSchema, updateTemplateSchema } from './schema';

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

/** Missing node types and the governance policy's objections (with `projectId`, that project's allowed nodes too). */
export function templateProblems(workflow: Pick<Workflow, 'nodes'> & Partial<Pick<Workflow, 'connections' | 'groups'>>, projectId?: string): TemplateProblem[] {
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
  for (const violation of workflowViolations(workflow, undefined, scopeFor(projectId ? { projectId } : undefined))) {
    if (!problems.some((p) => p.kind === 'blocked' && p.message === violation.message)) problems.push({ kind: 'blocked', nodeType: violation.nodeType, message: violation.message });
  }
  // Composites (docs/composites.md): errors, and types this instance doesn't have, to fix before publishing.
  for (const issue of workflowCompositeIssues({ nodes: workflow.nodes, connections: workflow.connections ?? [], groups: workflow.groups })) {
    if (issue.severity !== 'error' && issue.code !== 'unknown-type') continue;
    const type = workflow.groups?.find((g) => g.id === issue.groupId)?.composite?.type ?? '';
    problems.push({ kind: 'contract', nodeType: type, message: issue.message });
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

function finish(detail: Omit<TemplateDetail, 'usable' | 'problems' | 'nodeTypes' | 'nodeCount'> & Partial<Pick<TemplateDetail, 'nodeTypes'>>, scopeProject?: string): TemplateDetail {
  const problems = templateProblems(detail.workflow, scopeProject ?? detail.projectId);
  return {
    ...detail,
    nodeTypes: nodeTypesOf(detail.workflow),
    nodeCount: detail.workflow.nodes.length,
    credentials: withSlotNodes(detail.credentials, detail.workflow),
    usable: !problems.some((p) => p.kind !== 'contract'),
    problems,
  };
}

/** Who may see and change a saved template (built-in and remote ones: everyone sees them, nobody changes them). */
export function templateAccess(actor: Actor | undefined, template: Pick<TemplateSummary, 'source' | 'projectId'>): { read: boolean; edit: boolean } {
  if (template.source !== 'local') return { read: true, edit: false };
  if (!template.projectId) return { read: true, edit: isInstanceAdmin(actor) };
  const role = projectRole(actor, template.projectId);
  return { read: Boolean(role), edit: projectRoleCan.create(role) };
}

function localDetail(t: LocalTemplate, viewer?: Actor, scopeProject?: string): TemplateDetail {
  const project = t.projectId ? getProject(t.projectId) : undefined;
  return finish(
    {
      ...t,
      source: 'local',
      workflow: { ...t.workflow, id: '' },
      ...(project && { projectName: project.name }),
      ...(viewer && { canEdit: templateAccess(viewer, { source: 'local', projectId: t.projectId }).edit }),
    },
    scopeProject,
  );
}

function builtinDetail(t: TemplateDetail, scopeProject?: string): TemplateDetail {
  return finish(structuredClone(t), scopeProject);
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
  /**
   * Remote templates: on when LANDFLOW_TEMPLATES_URL is set; `error` when the API couldn't be reached. With remote
   * results, the page they are (from 1), how many there are in all (when the API says) and whether there are more.
   */
  remote: { enabled: boolean; label?: string; error?: string; page?: number; total?: number; hasMore?: boolean };
}

function matches(t: TemplateSummary, search: string, category?: string): boolean {
  if (category && !t.categories.includes(category as TemplateCategory)) return false;
  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const haystack = [t.name, t.description, ...t.nodeTypes, ...t.categories, t.author ?? ''].join(' ').toLowerCase();
  return words.every((w) => haystack.includes(w));
}

/** The saved templates `viewer` sees: instance-wide ones and those of their projects (with `projectId`: that project's only). */
function visibleLocal(viewer: Actor | undefined, projectId?: string): LocalTemplate[] {
  const all = localTemplates.list();
  if (projectId) return all.filter((t) => !t.projectId || t.projectId === projectId);
  if (!viewer) return all;
  const visible = visibleProjectIds(viewer);
  // Templates of a project that no longer exists show to owners and admins only.
  const known = new Set(listProjects().map((p) => p.id));
  return all.filter((t) => !t.projectId || (visible ? visible.has(t.projectId) : true) || (!known.has(t.projectId) && isInstanceAdmin(viewer)));
}

/**
 * Every template matching `search` (name, description, node types) and `category`; remote ones only when asked for
 * or searched (`page`: which 30 of them). `projectId`: that project's saved templates and the instance-wide ones, with
 * the project's allowed nodes counted in `usable`; else everything `viewer` sees.
 */
export async function listTemplates(options: { search?: string; category?: string; source?: TemplateSource; projectId?: string; viewer?: Actor; page?: number } = {}): Promise<TemplateListing> {
  const search = options.search?.trim() ?? '';
  const local = !options.source || options.source === 'local' ? visibleLocal(options.viewer, options.projectId).map((t) => summaryOf(localDetail(t, options.viewer, options.projectId))) : [];
  const builtin = !options.source || options.source === 'builtin' ? BUILTIN_TEMPLATES.map((t) => summaryOf(builtinDetail(t, options.projectId))) : [];
  const templates = [...local, ...builtin].filter((t) => matches(t, search, options.category));
  const remote: TemplateListing['remote'] = { enabled: Boolean(remoteBase()), ...(remoteLabel() && { label: remoteLabel() }) };
  if (remote.enabled && (options.source === 'remote' || (!options.source && search))) {
    try {
      // The API searched; categories are mapped here.
      const found = await searchRemotePage(search, options.page);
      templates.push(...found.templates.filter((t) => matches(t, '', options.category)));
      remote.page = found.page;
      if (found.total !== undefined) remote.total = found.total;
      remote.hasMore = found.total !== undefined ? found.page * REMOTE_PAGE_SIZE < found.total : found.templates.length >= REMOTE_PAGE_SIZE;
    } catch (caught) {
      remote.error = (caught as Error).message;
    }
  }
  return { templates, remote };
}

/** One template with its workflow, setup steps and state on this instance (`viewer`: whether they may edit it). */
export async function getTemplate(id: string, viewer?: Actor, scopeProject?: string): Promise<TemplateDetail | undefined> {
  const builtin = BUILTIN_TEMPLATES.find((t) => t.id === id);
  if (builtin) return builtinDetail(builtin, scopeProject);
  if (id.startsWith('tpl_')) {
    const local = localTemplates.get(id);
    return local && localDetail(local, viewer, scopeProject);
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

/**
 * Hooks the route passes in so new workflows and tables land in the caller's project. `projectId` is that project:
 * its allowed nodes count, a folder must be one of its folders, and only its data tables are reused (data tables are
 * per project).
 */
export interface UseHooks {
  createWorkflow(save: () => Workflow, id: string): Workflow;
  createTable(create: () => { id: string; name: string }): { id: string; name: string };
  projectId?: string;
}

const directHooks: UseHooks = { createWorkflow: (save) => save(), createTable: (create) => create() };

/** Create a workflow from a template: credentials remapped, data tables created, saved as an inactive draft. */
export async function useTemplate(id: string, request: UseTemplateRequest, hooks: UseHooks = directHooks): Promise<UseTemplateResult> {
  const detail = await getTemplate(id, undefined, hooks.projectId);
  if (!detail) throw new TemplateError('Template not found', 404);
  if (!detail.usable) throw new TemplateError(`This template can’t be used here: ${detail.problems.map((p) => p.message).join('; ')}`, 409, { problems: detail.problems });
  if (request.folderId && !folders.get(request.folderId)) throw new TemplateError('Folder not found', 404);
  if (request.folderId && hooks.projectId && folders.projectOf(request.folderId) !== hooks.projectId) throw new TemplateError('That folder belongs to another project', 400);

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
    // The project's table of that name is reused; another project's isn't (names are unique per project: it makes its own).
    const existing = dataTables().findTable(table.name, hooks.projectId);
    if (existing && (hooks.projectId === undefined || tableInProject(existing.id, hooks.projectId))) {
      tableIds.set(table.name, existing.id);
      continue;
    }
    const created = hooks.createTable(() => dataTables().createTable({ name: table.name, columns: table.columns, projectId: hooks.projectId }));
    tableIds.set(table.name, created.id);
    createdTables.push(created.name);
  }

  const built = instantiate(detail, picks, tableIds, takenPaths());
  const workflowId = `wf_${nanoid(10)}`;
  const parsed = workflowSchema.safeParse({ ...built, id: workflowId, name: (request.name?.trim() || detail.name).slice(0, LIMITS.name) });
  if (!parsed.success) throw new TemplateError(`The template’s workflow is invalid: ${parsed.error.issues[0]?.path.join('.')}: ${parsed.error.issues[0]?.message}`, 422);
  const { folderId: _folder, active: _active, pinData: _pins, ...data } = parsed.data as Workflow;
  const workflow = hooks.createWorkflow(() => store.saveWorkflow({ ...data, active: false, ...(request.folderId && { folderId: request.folderId }) } as Workflow), workflowId);
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

/**
 * The project a saved template goes to: `requested` (an id: the caller must be an editor there; `null`: instance-wide,
 * owners and admins only); not given: instance-wide for owners and admins (as before projects had templates), else
 * the caller's personal project. No actor (system callers, tests): as asked, else instance-wide.
 */
export function templateProject(actor: Actor | undefined, requested: string | null | undefined): string | undefined {
  if (requested) {
    const project = getProject(requested);
    if (!project) throw new TemplateError('Project not found', 404);
    if (actor && !projectRoleCan.create(projectRole(actor, project.id))) throw new TemplateError(`You can’t add templates to “${project.name}”`, 403);
    return project.id;
  }
  if (!actor || isInstanceAdmin(actor)) return undefined;
  if (requested === null) throw new TemplateError('Only owners and admins publish templates for the whole instance: pick a project', 403);
  return ensurePersonalProject(actor.id);
}

/** A workflow as a template's parts: portable, data tables by name, credentials as slots (declared ones kept). */
function templateParts(source: Workflow, name: string, description: string, declared: TemplateCredentialSlot[] = []) {
  const base = portable(source, name, description);
  const { nodes: tableNodes, tables } = portableTables(base.nodes);
  const { nodes, slots } = slotCredentials({ nodes: tableNodes }, declared);
  return { workflow: { ...base, nodes }, credentials: slots, dataTables: tables };
}

/** "Save as template": a local template from a workflow, credentials turned into slots, pinned data left out. */
export function saveTemplate(input: SaveTemplateInput, author?: string, actor?: Actor): TemplateDetail {
  const projectId = templateProject(actor, input.projectId);
  const source = checkedWorkflow(input.workflow, input.name);
  const parts = templateParts(source, input.name, input.description || source.description || '');
  const template = localTemplates.create({
    name: input.name,
    description: input.description || source.description || '',
    categories: categoriesOf(input.categories),
    setup: input.setup.map((s) => s.trim()).filter(Boolean),
    ...parts,
    ...(author && { author }),
    ...(projectId && { projectId }),
  });
  return createdDetail(template, actor);
}

/**
 * Edit a saved template in place (its id, author and creation time stay): name, description, categories, setup
 * steps, its project (`null`: instance-wide), and its workflow, replaced from `source` (a saved workflow the route
 * loaded) with credentials turned into slots again. The caller must be allowed to edit it (`templateAccess`).
 */
export function updateTemplate(id: string, patch: UpdateTemplateInput, actor?: Actor, source?: Workflow): TemplateDetail {
  if (!id.startsWith('tpl_')) throw new TemplateError('Only templates saved on this instance can be edited', 400);
  const current = localTemplates.get(id);
  if (!current) throw new TemplateError('Template not found', 404);
  if (actor && !templateAccess(actor, { source: 'local', projectId: current.projectId }).edit) throw new TemplateError('You can’t edit this template', 403);
  const next: Partial<LocalTemplate> = {};
  if (patch.name !== undefined) next.name = patch.name.trim();
  if (patch.description !== undefined) next.description = patch.description;
  if (patch.categories !== undefined) next.categories = categoriesOf(patch.categories);
  if (patch.setup !== undefined) next.setup = patch.setup.map((s) => s.trim()).filter(Boolean);
  if (patch.projectId !== undefined) {
    const projectId = patch.projectId === null ? (actor && !isInstanceAdmin(actor) ? templateProject(actor, null) : undefined) : templateProject(actor, patch.projectId);
    next.projectId = projectId;
  }
  if (source) {
    const name = next.name ?? current.name;
    Object.assign(next, templateParts(checkedWorkflow(source as unknown as Record<string, unknown>, name), name, next.description ?? current.description));
  }
  const updated = localTemplates.update(id, next);
  if (!updated) throw new TemplateError('Template not found', 404);
  return localDetail(updated, actor);
}

/**
 * Import a template file (from "Export"): kept as a local template, its references checked against its slots.
 * `origin`: a marketplace plugin's flow, removed again when the plugin is uninstalled.
 */
/** A template file's contents as a template keeps them: a checked, portable workflow, credentials as slots. */
function fromFile(data: unknown) {
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
  return {
    name: template.name,
    description: template.description,
    categories: categoriesOf(template.categories),
    credentials: slots,
    setup: template.setup.map((s) => s.trim()).filter(Boolean),
    dataTables: template.dataTables,
    workflow: { ...base, nodes },
  };
}

export function importTemplate(data: unknown, author?: string, actor?: Actor, requestedProject?: string | null, origin?: TemplateOrigin): TemplateDetail {
  const projectId = templateProject(actor, requestedProject);
  const parts = fromFile(data);
  return createdDetail(localTemplates.create({ ...parts, ...(author && { author }), ...(projectId && { projectId }), ...(origin && { origin }) }), actor);
}

/**
 * The detail of a template just saved. If it can't be built, the template is deleted again: the caller never got its
 * id, so it couldn't roll it back (a marketplace install that fails removes only the templates it was handed).
 */
function createdDetail(template: Parameters<typeof localDetail>[0], actor?: Actor): TemplateDetail {
  try {
    return localDetail(template, actor);
  } catch (error) {
    localTemplates.delete(template.id);
    throw error;
  }
}

/** A template file as its page would show it, without saving it (a marketplace flow's share page). */
export function previewTemplate(data: unknown): FlowPreview {
  const { name, description, categories, credentials, setup, dataTables, workflow, nodeTypes, nodeCount, problems } = finish({ id: '', source: 'local', ...fromFile(data) });
  return { name, description, categories, credentials, setup, dataTables, workflow, nodeTypes, nodeCount, problems };
}

/** A template as an export file (any source). */
export function templateFile(detail: TemplateDetail): TemplateFile {
  const { name, description, categories, setup, dataTables: tables, workflow } = detail;
  const credentials = detail.credentials.map(({ nodes: _nodes, ...slot }) => slot);
  return { kind: 'landflow/template', version: 1, template: { name, description, categories, credentials, setup, dataTables: tables, workflow: { ...workflow, id: '' } } };
}

/** Delete a saved template (built-in and remote ones can't be); `actor` must be allowed to edit it. */
export function deleteTemplate(id: string, actor?: Actor) {
  if (!id.startsWith('tpl_')) throw new TemplateError('Only templates saved on this instance can be deleted', 400);
  const current = localTemplates.get(id);
  if (!current) throw new TemplateError('Template not found', 404);
  if (actor && !templateAccess(actor, { source: 'local', projectId: current.projectId }).edit) throw new TemplateError('You can’t delete this template', 403);
  if (!localTemplates.delete(id)) throw new TemplateError('Template not found', 404);
}
