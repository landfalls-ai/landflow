/**
 * Governance per project and per workflow, under the instance policy (./policy.ts):
 *
 * - **Project settings** (`project_settings`, migration 1401; the project's Settings tab, its admins): an optional
 *   allow-list of the plugins and node types the project's workflows may use, and who approves its publish requests
 *   (./project-approvers.ts, through `registerApproverCheck`).
 * - **Workflow policy** (`workflow_policies`; the workflow's settings, admins of its project): four-eyes publishing for
 *   this workflow even when the instance doesn't ask for it, and a stricter node allow-list.
 *
 * A node must pass the instance's rules, then the project's list, then the workflow's: each level only narrows. The
 * same checks as the instance's run everywhere (saving warns, publishing is refused, a run fails at the node, the node
 * creator hides them), through `scopedNodeBlocked` in ./policy.ts. Both documents are re-read at most once a second,
 * so a change reaches every process (hosts and workers). Plain server module: no Next.js imports.
 */
import { z } from 'zod';
import {
  DEFAULT_PROJECT_SETTINGS,
  DEFAULT_WORKFLOW_POLICY,
  type ProjectSettings,
  type ScopedNodePolicy,
  type WorkflowPolicy,
} from '../../shared/project-policy';
import { parse } from '../db/rows';
import { projectsDb } from '../projects/db';
import { getProject, homeProjectId } from '../projects/store';
import { singleton } from '../singleton';

const pattern = z.string().trim().min(1).max(300);
const list = z.array(pattern).max(500);

export const scopedNodePolicySchema = z.strictObject({ mode: z.enum(['off', 'allow']), plugins: list, types: list });

export const projectSettingsPatchSchema = z.strictObject({
  nodes: scopedNodePolicySchema.partial().optional(),
  approvers: z.enum(['default', 'admins', 'editors', 'instance']).optional(),
});

export const workflowPolicyPatchSchema = z.strictObject({
  fourEyes: z.boolean().optional(),
  nodes: scopedNodePolicySchema.partial().optional(),
});

const CACHE_MS = 1_000;
interface Cached<T> {
  at: number;
  value: T;
}
const caches = () =>
  singleton('governance-scope-cache', () => ({
    projects: new Map<string, Cached<ProjectSettings>>(),
    workflows: new Map<string, Cached<WorkflowPolicy | undefined>>(),
    /** A workflow's (or agent's) project, for the run-time checks of every node call. */
    homes: new Map<string, Cached<string | undefined>>(),
  }));

function cachedHome(workflowId: string): string | undefined {
  const homes = caches().homes;
  const hit = homes.get(workflowId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  let value: string | undefined;
  try {
    value = workflowId.startsWith('agent:') ? homeProjectId('agent', workflowId.slice('agent:'.length)) : homeProjectId('workflow', workflowId);
  } catch {
    value = undefined;
  }
  if (homes.size > 5_000) homes.clear();
  homes.set(workflowId, { at: Date.now(), value });
  return value;
}

const tidy = (items: string[] = []) => [...new Set(items.map((item) => item.trim()).filter(Boolean))];

function nodePolicy(saved: Partial<ScopedNodePolicy> | undefined, base: ScopedNodePolicy = DEFAULT_PROJECT_SETTINGS.nodes): ScopedNodePolicy {
  const merged = { ...base, ...saved };
  const parsed = scopedNodePolicySchema.safeParse({ mode: merged.mode, plugins: tidy(merged.plugins), types: tidy(merged.types) });
  return parsed.success ? parsed.data : { ...DEFAULT_PROJECT_SETTINGS.nodes };
}

function readRow(table: 'project_settings' | 'workflow_policies', column: 'project_id' | 'workflow_id', id: string): Record<string, unknown> | undefined {
  try {
    return parse<Record<string, unknown>>(projectsDb().get<{ data: string }>(`SELECT data FROM ${table} WHERE ${column} = ?`, id)?.data);
  } catch {
    // No table yet (a database mid-upgrade) or a broken row: no rules.
    return undefined;
  }
}

// ---- project settings -----------------------------------------------------------------------------------------

/** A project's settings (defaults: no allow-list, the instance's approvers). */
export function getProjectSettings(projectId: string | undefined): ProjectSettings {
  if (!projectId) return structuredClone(DEFAULT_PROJECT_SETTINGS);
  const cache = caches().projects;
  const hit = cache.get(projectId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const saved = readRow('project_settings', 'project_id', projectId) as Partial<ProjectSettings> | undefined;
  const approvers = projectSettingsPatchSchema.shape.approvers.safeParse(saved?.approvers);
  const value: ProjectSettings = {
    nodes: nodePolicy(saved?.nodes),
    approvers: (approvers.success && approvers.data) || 'default',
    ...(typeof saved?.updatedAt === 'string' && { updatedAt: saved.updatedAt }),
    ...(typeof saved?.updatedBy === 'string' && { updatedBy: saved.updatedBy }),
  };
  cache.set(projectId, { at: Date.now(), value });
  return value;
}

export function updateProjectSettings(projectId: string, patch: z.infer<typeof projectSettingsPatchSchema>, by?: string): ProjectSettings {
  const current = getProjectSettings(projectId);
  const now = new Date().toISOString();
  const next: ProjectSettings = {
    nodes: nodePolicy(patch.nodes, current.nodes),
    approvers: patch.approvers ?? current.approvers,
    updatedAt: now,
    ...(by && { updatedBy: by }),
  };
  projectsDb().upsert('project_settings', { project_id: projectId, data: JSON.stringify(next), updated_at: now, updated_by: by ?? null });
  caches().projects.delete(projectId);
  return getProjectSettings(projectId);
}

/** A deleted project's settings go with it. */
export function forgetProjectSettings(projectId: string) {
  try {
    projectsDb().delete('project_settings', { project_id: projectId });
  } catch {}
  caches().projects.delete(projectId);
}

// ---- workflow policies ----------------------------------------------------------------------------------------

/** A workflow's own policy, or undefined when it has none. */
export function getWorkflowPolicy(workflowId: string | undefined): WorkflowPolicy | undefined {
  if (!workflowId) return undefined;
  const cache = caches().workflows;
  const hit = cache.get(workflowId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const saved = readRow('workflow_policies', 'workflow_id', workflowId) as Partial<WorkflowPolicy> | undefined;
  const value: WorkflowPolicy | undefined = saved && {
    fourEyes: saved.fourEyes === true,
    nodes: nodePolicy(saved.nodes, DEFAULT_WORKFLOW_POLICY.nodes),
    ...(typeof saved.updatedAt === 'string' && { updatedAt: saved.updatedAt }),
    ...(typeof saved.updatedBy === 'string' && { updatedBy: saved.updatedBy }),
  };
  cache.set(workflowId, { at: Date.now(), value });
  return value;
}

export function updateWorkflowPolicy(workflowId: string, patch: z.infer<typeof workflowPolicyPatchSchema>, by?: string): WorkflowPolicy {
  const current = getWorkflowPolicy(workflowId) ?? structuredClone(DEFAULT_WORKFLOW_POLICY);
  const now = new Date().toISOString();
  const next: WorkflowPolicy = { fourEyes: patch.fourEyes ?? current.fourEyes, nodes: nodePolicy(patch.nodes, current.nodes), updatedAt: now, ...(by && { updatedBy: by }) };
  const db = projectsDb();
  // Nothing on: no row (the workflow follows its project and the instance).
  if (!next.fourEyes && next.nodes.mode === 'off' && !next.nodes.plugins.length && !next.nodes.types.length) db.delete('workflow_policies', { workflow_id: workflowId });
  else db.upsert('workflow_policies', { workflow_id: workflowId, data: JSON.stringify(next), updated_at: now, updated_by: by ?? null });
  caches().workflows.delete(workflowId);
  return getWorkflowPolicy(workflowId) ?? structuredClone(DEFAULT_WORKFLOW_POLICY);
}

/** A deleted workflow's policy goes with it. */
export function forgetWorkflowPolicy(workflowId: string) {
  try {
    projectsDb().delete('workflow_policies', { workflow_id: workflowId });
  } catch {}
  caches().workflows.delete(workflowId);
}

/** Whether `workflowId` asks for four-eyes publishing itself. */
export function workflowRequiresFourEyes(workflowId: string | undefined): boolean {
  return Boolean(getWorkflowPolicy(workflowId)?.fourEyes);
}

// ---- scopes ---------------------------------------------------------------------------------------------------

/** What applies below the instance policy to one workflow (or to whatever a project creates). */
export interface PolicyScope {
  project?: { id: string; name: string; nodes: ScopedNodePolicy };
  workflow?: { id: string; nodes: ScopedNodePolicy };
}

/** Where to look: a workflow (its project and its own policy; `agent:<id>` is an agent's tools: its project), or a project. */
export type ScopeTarget = { workflowId?: string; projectId?: string };

/** The project and workflow lists that apply to `target` (only the levels that have a list switched on). */
export function policyScope(target: ScopeTarget | undefined): PolicyScope {
  if (!target) return {};
  const workflowId = target.workflowId && !target.workflowId.startsWith('agent:') ? target.workflowId : undefined;
  const projectId = target.projectId ?? (target.workflowId ? cachedHome(target.workflowId) : undefined);
  const scope: PolicyScope = {};
  if (projectId) {
    const settings = getProjectSettings(projectId);
    if (settings.nodes.mode === 'allow') scope.project = { id: projectId, name: getProject(projectId)?.name ?? 'this project', nodes: settings.nodes };
  }
  const own = getWorkflowPolicy(workflowId);
  if (workflowId && own?.nodes.mode === 'allow') scope.workflow = { id: workflowId, nodes: own.nodes };
  return scope;
}

/** Forget cached homes (after a workflow moved to another project). */
export function invalidatePolicyScopes() {
  caches().homes.clear();
}

/** Whether a scope has a list to check. */
export const scopeActive = (scope: PolicyScope | undefined): boolean => Boolean(scope?.project || scope?.workflow);
