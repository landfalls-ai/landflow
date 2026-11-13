/**
 * Tool grants (docs/protocol.md §15.5; docs/transports.md "Who may call what"): who may list and call which tools of
 * which plugin through MCP, and which credential each tool binds. Kept in `mcp_grants` (migration 1724), managed in
 * Settings → MCP (/api/mcp/grants, owners and admins). A caller's effective tool set is the union of the grants that
 * apply to them (their user, their SCIM groups, the projects they belong to, their role, the MCP token they hold),
 * minus the governance allow-lists (lib/server/governance): a tool whose node type the instance blocks, or that a
 * project-scoped grant's project doesn't allow, is never listed. A tool with no applicable grant is not listed and
 * cannot be called; there are no implicit grants (an admin's signed-in session may browse every tool, see identity.ts).
 *
 * The tools of a plugin are the shared mapping over its current node descriptors (`mcpToolsFromDescriptors`,
 * packages/protocol/src/mcp-tools.ts), cached per plugin until its descriptors change.
 */
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { MCP_TOOL_META_KEY, MCP_TOOL_NAME_PATTERN, mcpToolsFromDescriptors, mcpTriggersFromDescriptors, type McpToolDefinition, type McpTriggerDefinition, type NodeDescriptor } from '@landflow/protocol';
import type { Role } from '../../shared/auth';
import { MCP_GRANT_SUBJECT_KINDS, type McpGrantSubjectKind, type McpToolGrant } from '../../shared/mcp';
import { MCP_APPROVAL_MODES, type McpApprovalMode } from '../../shared/mcp-approval';
import { strictestMode, weakens } from './approval-mode';
import { mcpDb } from './db';
import { getUser } from '../auth/users';
import { parse } from '../db/rows';
import { nodeTypeBlocked, scopedNodeBlocked } from '../governance/policy';
import { policyScope } from '../governance/scopes';
import { registry } from '../plugins/registry';
import { getProject, membershipsOf } from '../projects/store';
import { getGroup, groupsOf } from '../scim/groups';
import { singleton } from '../singleton';
import { HttpError } from '../errors';

/** A grant fails with a status the routes pass on. */
export class McpGrantError extends HttpError {
  constructor(
    message: string,
    status = 400,
  ) {
    super(message, status, { expose: true });
  }
}

/** The body of POST /api/mcp/grants (shared with the OpenAPI document). */
export const grantCreateSchema = z.strictObject({
  subject: z.strictObject({ kind: z.enum(MCP_GRANT_SUBJECT_KINDS), id: z.string().trim().min(1).max(200) }),
  pluginId: z.string().trim().min(1).max(200),
  tools: z.union([z.literal('*'), z.array(z.string().trim().min(1).max(65)).max(500)]),
  credentials: z.record(z.string().min(1).max(100), z.string().min(1).max(200)).optional(),
  requireApproval: z.boolean().nullable().optional(),
  approval: z.enum(MCP_APPROVAL_MODES).nullable().optional(),
});

/** The body of PATCH /api/mcp/grants/<id>. */
export const grantPatchSchema = z.strictObject({
  tools: z.union([z.literal('*'), z.array(z.string().trim().min(1).max(65)).max(500)]).optional(),
  credentials: z.record(z.string().min(1).max(100), z.string().min(1).max(200)).optional(),
  requireApproval: z.boolean().nullable().optional(),
  approval: z.enum(MCP_APPROVAL_MODES).nullable().optional(),
});

// ---- storage --------------------------------------------------------------------

interface GrantRow {
  id: string;
  subject_kind: string;
  subject_id: string;
  plugin_id: string;
  tools: string;
  credentials: string;
  require_approval: number | bigint | null;
  approval_mode: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

const isKind = (value: string): value is McpGrantSubjectKind => (MCP_GRANT_SUBJECT_KINDS as readonly string[]).includes(value);

const isMode = (value: unknown): value is McpApprovalMode => (MCP_APPROVAL_MODES as readonly string[]).includes(value as string);

/** The approval mode a row holds: `approval_mode`, else the older boolean (1 = destructive, 0 = never); nothing for the instance default. */
function approvalOf(row: GrantRow): Pick<McpToolGrant, 'approval' | 'requireApproval'> {
  const legacy = row.require_approval === null || row.require_approval === undefined ? undefined : Number(row.require_approval) === 1 ? 'destructive' : 'never';
  const mode = isMode(row.approval_mode) ? row.approval_mode : legacy;
  return mode ? { approval: mode, requireApproval: mode !== 'never' } : {};
}

/** The mode a request body asks for: `approval`, else the older `requireApproval` boolean; `null` clears it, `undefined` leaves it. */
function requestedMode(input: { approval?: McpApprovalMode | null; requireApproval?: boolean | null }): McpApprovalMode | null | undefined {
  if (input.approval !== undefined) return input.approval;
  if (input.requireApproval === undefined) return undefined;
  return input.requireApproval === null ? null : input.requireApproval ? 'destructive' : 'never';
}

/** The two columns for a mode (`require_approval` stays written for builds that only know the boolean). */
const modeColumns = (mode: McpApprovalMode | null) => ({ approval_mode: mode, require_approval: mode === null ? null : mode === 'never' ? 0 : 1 });

function fromRow(row: GrantRow): McpToolGrant {
  const tools = row.tools === '*' ? '*' : (parse<string[]>(row.tools) ?? []);
  const kind = isKind(row.subject_kind) ? row.subject_kind : 'user';
  return {
    id: row.id,
    subject: { kind, id: row.subject_id, ...(subjectName(kind, row.subject_id) && { name: subjectName(kind, row.subject_id) }) },
    pluginId: row.plugin_id,
    tools,
    credentials: parse<Record<string, string>>(row.credentials) ?? {},
    ...approvalOf(row),
    ...(row.created_by && { createdBy: row.created_by }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** A display name for the subject (the user's name, the group's or project's name, the token's label). */
function subjectName(kind: McpGrantSubjectKind, id: string): string | undefined {
  try {
    if (kind === 'user') return getUser(id)?.name;
    if (kind === 'group') return getGroup(id)?.displayName;
    if (kind === 'project') return getProject(id)?.name;
    if (kind === 'token') return mcpDb().get<{ label: string }>('SELECT label FROM mcp_tokens WHERE id = ?', id)?.label;
  } catch {}
  return undefined;
}

export interface GrantInput {
  subject: { kind: McpGrantSubjectKind; id: string };
  pluginId: string;
  tools: string[] | '*';
  credentials?: Record<string, string>;
  requireApproval?: boolean | null;
  approval?: McpApprovalMode | null;
}

/** Validate the parts of a grant that the schema can't: tool names, the subject's existence. */
function validate(input: Partial<GrantInput>) {
  if (input.tools && input.tools !== '*') {
    for (const name of input.tools) {
      if (name === '*') continue;
      const bare = name.startsWith('!') ? name.slice(1) : name;
      if (!MCP_TOOL_NAME_PATTERN.test(bare)) throw new McpGrantError(`“${name}” is not a tool name (letters, digits, _ and -, at most 64 characters; !name excludes)`);
    }
  }
  if (input.subject) {
    const { kind, id } = input.subject;
    if (kind === 'user' && !getUser(id)) throw new McpGrantError(`No user ${id}`, 404);
    if (kind === 'project' && !getProject(id)) throw new McpGrantError(`No project ${id}`, 404);
    if (kind === 'group' && !getGroup(id)) throw new McpGrantError(`No group ${id}`, 404);
    if (kind === 'role' && !['owner', 'admin', 'member'].includes(id)) throw new McpGrantError(`No role ${id}`);
    if (kind === 'token' && !mcpDb().get('SELECT id FROM mcp_tokens WHERE id = ?', id)) throw new McpGrantError(`No MCP token ${id}`, 404);
  }
}

export function listGrants(filter: { pluginId?: string } = {}): McpToolGrant[] {
  const db = mcpDb();
  const rows = filter.pluginId
    ? db.all<GrantRow>('SELECT * FROM mcp_grants WHERE plugin_id = ? ORDER BY created_at', filter.pluginId)
    : db.all<GrantRow>('SELECT * FROM mcp_grants ORDER BY created_at');
  return rows.map(fromRow);
}

export function getGrant(id: string): McpToolGrant | undefined {
  const row = mcpDb().get<GrantRow>('SELECT * FROM mcp_grants WHERE id = ?', id);
  return row && fromRow(row);
}

export function createGrant(input: GrantInput, createdBy?: string): McpToolGrant {
  validate(input);
  const now = new Date().toISOString();
  const row: GrantRow = {
    id: `mcpg_${nanoid(12)}`,
    subject_kind: input.subject.kind,
    subject_id: input.subject.id,
    plugin_id: input.pluginId,
    tools: input.tools === '*' ? '*' : JSON.stringify([...new Set(input.tools)]),
    credentials: JSON.stringify(input.credentials ?? {}),
    ...modeColumns(requestedMode(input) ?? null),
    created_by: createdBy ?? null,
    created_at: now,
    updated_at: now,
  };
  mcpDb().insertNew('mcp_grants', { ...row });
  return fromRow(row);
}

/**
 * Change a grant. Turning approvals down (to a weaker mode than the grant has now) is for the person who created the
 * grant alone: `actor` is who asks, and a grant nobody created (from a config file or an old row) may be turned down by
 * an instance owner. Turning them up is for any manager.
 */
export function updateGrant(id: string, patch: Partial<Omit<GrantInput, 'subject' | 'pluginId'>>, actor?: { id: string; role?: string }): McpToolGrant {
  const db = mcpDb();
  const row = db.get<GrantRow>('SELECT * FROM mcp_grants WHERE id = ?', id);
  if (!row) throw new McpGrantError('Grant not found', 404);
  validate(patch);
  const mode = requestedMode(patch);
  if (actor && mode !== undefined && weakens(approvalOf(row).approval, mode ?? undefined)) {
    const mine = row.created_by ? row.created_by === actor.id : actor.role === 'owner';
    if (!mine) throw new McpGrantError('Only the person who created this grant can turn its approvals down', 403);
  }
  const next: GrantRow = {
    ...row,
    ...(patch.tools !== undefined && { tools: patch.tools === '*' ? '*' : JSON.stringify([...new Set(patch.tools)]) }),
    ...(patch.credentials !== undefined && { credentials: JSON.stringify(patch.credentials) }),
    ...(mode !== undefined && modeColumns(mode)),
    updated_at: new Date().toISOString(),
  };
  db.upsert('mcp_grants', { ...next });
  return fromRow(next);
}

export function deleteGrant(id: string): boolean {
  return mcpDb().delete('mcp_grants', { id }) > 0;
}

// ---- the tools of a plugin ---------------------------------------------------------

interface ToolCache {
  stamp: string;
  tools: McpToolDefinition[];
}

const toolCache = () => singleton('mcp-plugin-tools', () => new Map<string, ToolCache>());

/** The MCP tools a plugin exposes right now (§15.1 over its current node descriptors); empty for an unknown plugin. */
export function pluginTools(pluginId: string): McpToolDefinition[] {
  const nodes: NodeDescriptor[] = registry
    .nodeTypes()
    .filter((n) => n.pluginId === pluginId)
    .map((n) => n.descriptor);
  if (!nodes.length) {
    toolCache().delete(pluginId);
    return [];
  }
  const stamp = nodes.map((n) => `${n.name}@${n.version ?? ''}:${n.properties?.length ?? 0}`).join(',');
  const cached = toolCache().get(pluginId);
  if (cached && cached.stamp === stamp) return cached.tools;
  const tools = mcpToolsFromDescriptors(pluginId, nodes);
  toolCache().set(pluginId, { stamp, tools });
  return tools;
}

/** The plugin ids that have at least one tool. */
export function pluginsWithTools(): string[] {
  const ids = [...new Set(registry.nodeTypes().map((n) => n.pluginId))];
  return ids.filter((id) => pluginTools(id).length > 0);
}

// ---- who gets what --------------------------------------------------------------

/** The subjects a caller stands for: used to pick the grants that apply. */
export interface GrantSubjects {
  userId?: string;
  role?: Role;
  tokenId?: string;
}

/** Every (kind, id) pair the grants of `caller` may name: the user, their groups, their projects, their role, their token. */
export function subjectsOf(caller: GrantSubjects): Array<{ kind: McpGrantSubjectKind; id: string }> {
  const out: Array<{ kind: McpGrantSubjectKind; id: string }> = [];
  if (caller.userId) {
    out.push({ kind: 'user', id: caller.userId });
    try {
      for (const m of membershipsOf(caller.userId)) out.push({ kind: 'project', id: m.projectId });
      for (const g of groupsOf(caller.userId)) out.push({ kind: 'group', id: g.id });
    } catch {}
    const role = caller.role ?? getUser(caller.userId)?.role;
    if (role) out.push({ kind: 'role', id: role });
  }
  if (caller.tokenId) out.push({ kind: 'token', id: caller.tokenId });
  return out;
}

/** The grants that apply to `caller` for `pluginId` (or every plugin). */
export function grantsFor(caller: GrantSubjects, pluginId?: string): McpToolGrant[] {
  const subjects = subjectsOf(caller);
  if (!subjects.length) return [];
  return listGrants(pluginId ? { pluginId } : {}).filter((g) => subjects.some((s) => s.kind === g.subject.kind && s.id === g.subject.id));
}

/** Whether `grant` names `tool` (`*` or the name, and not `!name`). */
export function grantCovers(grant: Pick<McpToolGrant, 'tools'>, tool: string): boolean {
  if (grant.tools === '*') return true;
  if (grant.tools.includes(`!${tool}`)) return false;
  return grant.tools.includes(tool) || grant.tools.includes('*');
}

/** Why a tool's node is off limits by governance (the instance rules; a project grant adds the project's allow-list). */
function governanceBlocks(tool: McpToolDefinition, grant: McpToolGrant): boolean {
  const nodeType = tool._meta[MCP_TOOL_META_KEY].nodeType;
  if (grant.subject.kind === 'project') return Boolean(scopedNodeBlocked(nodeType, undefined, policyScope({ projectId: grant.subject.id })));
  return Boolean(nodeTypeBlocked(nodeType));
}

export interface EffectiveTool {
  tool: McpToolDefinition;
  /** The grants that allow it (the first one's credentials bind). */
  grants: McpToolGrant[];
  /** The credential bound per credential type, from the grants (first grant that binds a type wins). */
  credentials: Record<string, string>;
  /** The strictest approval mode among the grants that allow it. */
  approval?: McpApprovalMode;
}

/** The tools of `pluginId` that `caller` may use, with the credentials to bind. Empty when nothing applies. */
export function effectiveTools(caller: GrantSubjects, pluginId: string): EffectiveTool[] {
  const grants = grantsFor(caller, pluginId);
  if (!grants.length) return [];
  const out: EffectiveTool[] = [];
  for (const tool of pluginTools(pluginId)) {
    const allowing = grants.filter((g) => grantCovers(g, tool.name) && !governanceBlocks(tool, g));
    if (!allowing.length) continue;
    const credentials: Record<string, string> = {};
    for (const g of allowing) for (const [type, id] of Object.entries(g.credentials)) credentials[type] ??= id;
    const approval = allowing.map((g) => g.requireApproval).filter((v): v is boolean => v !== undefined);
    out.push({ tool, grants: allowing, credentials, approval: strictestMode(allowing.map((g) => g.approval)), ...(approval.length && { requireApproval: approval.some(Boolean) }) });
  }
  return out;
}

/** One tool, if the caller may use it. */
export function effectiveTool(caller: GrantSubjects, pluginId: string, toolName: string): EffectiveTool | undefined {
  return effectiveTools(caller, pluginId).find((t) => t.tool.name === toolName);
}

// ---- the triggers of a plugin (resources) --------------------------------------------

interface TriggerCache {
  stamp: string;
  triggers: McpTriggerDefinition[];
}

const triggerCache = () => singleton('mcp-plugin-triggers', () => new Map<string, TriggerCache>());

/** The trigger resources a plugin exposes right now (docs/protocol.md §15.9); empty for an unknown plugin or one without poll or app webhook triggers. */
export function pluginTriggers(pluginId: string): McpTriggerDefinition[] {
  const nodes: NodeDescriptor[] = registry
    .nodeTypes()
    .filter((n) => n.pluginId === pluginId)
    .map((n) => n.descriptor);
  const triggers = nodes.filter((n) => n.kind === 'trigger');
  if (!triggers.length) {
    triggerCache().delete(pluginId);
    return [];
  }
  const stamp = triggers.map((n) => `${n.name}@${n.version ?? ''}:${n.triggerSource}:${n.mcp === false}:${n.properties?.length ?? 0}`).join(',');
  const cached = triggerCache().get(pluginId);
  if (cached && cached.stamp === stamp) return cached.triggers;
  const defs = mcpTriggersFromDescriptors(pluginId, nodes);
  triggerCache().set(pluginId, { stamp, triggers: defs });
  return defs;
}

export interface EffectiveTrigger {
  trigger: McpTriggerDefinition;
  grants: McpToolGrant[];
  /** The credential bound per credential type, from the grants (first grant that binds a type wins). */
  credentials: Record<string, string>;
}

/**
 * The triggers of `pluginId` that `caller` may subscribe to: a grant must cover the trigger's name (`trigger_<node>`, or `*`)
 * and the node type must not be blocked by governance, exactly as for a tool.
 */
export function effectiveTriggers(caller: GrantSubjects, pluginId: string): EffectiveTrigger[] {
  const defs = pluginTriggers(pluginId);
  if (!defs.length) return [];
  const grants = grantsFor(caller, pluginId);
  if (!grants.length) return [];
  const out: EffectiveTrigger[] = [];
  for (const trigger of defs) {
    const nodeType = trigger._meta[MCP_TOOL_META_KEY].nodeType;
    const allowing = grants.filter((g) => grantCovers(g, trigger.name) && !(g.subject.kind === 'project' ? scopedNodeBlocked(nodeType, undefined, policyScope({ projectId: g.subject.id })) : nodeTypeBlocked(nodeType)));
    if (!allowing.length) continue;
    const credentials: Record<string, string> = {};
    for (const g of allowing) for (const [type, id] of Object.entries(g.credentials)) credentials[type] ??= id;
    out.push({ trigger, grants: allowing, credentials });
  }
  return out;
}

export function effectiveTrigger(caller: GrantSubjects, pluginId: string, name: string): EffectiveTrigger | undefined {
  return effectiveTriggers(caller, pluginId).find((t) => t.trigger.name === name);
}
