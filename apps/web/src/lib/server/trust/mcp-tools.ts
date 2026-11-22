/**
 * C27: the filter that holds changed MCP tools (docs/agents.md#changed-mcp-tools-are-held). An agent is published with a snapshot of
 * what each of its MCP servers listed (`trust_records`, subject `agent:<agentId>/<toolConfigId>`). At every listing the live
 * tools are compared with that snapshot: an unchanged tool is offered; a tool whose name, description, input schema or annotations
 * changed (and, when the config takes all tools, a tool the server added) is held, not offered, and written once as a pending
 * record the agent page and Needs you show. A tool the server dropped just goes. A config with no snapshot yet is snapshotted as
 * "first seen at run" and nothing is held (an agent published before this existed, or a server that did not answer at publish).
 *
 * This filters the LIST. C14's policy hooks (lib/server/mcp/client.ts) decide per CALL and are untouched.
 */
import type { Agent, McpServerToolConfig } from '../../shared/agents';
import { toolChanges, type HeldToolsView, type ToolChange, type ToolContent, type ToolField } from '../../shared/trust';
import { isGithubPreset } from '../mcp/github';
import { database } from '../db';
import { snapshotOf, toolsHash } from './canonical';
import { approveFirstSeen, currentApproval, pendingFor, recordPending, supersedePending, type TrustRecord } from './store';
import type { JsonObject } from '@landflow/protocol';

/** One MCP server config of one agent. */
export const mcpSubject = (agentId: string, toolConfigId: string): string => `agent:${agentId}/${toolConfigId}`;
/** The prefix of every subject of one agent. */
export const agentSubjects = (agentId: string): string => `agent:${agentId}/`;

export interface HoldResult<T> {
  offered: T[];
  held: ToolChange[];
}

export interface HoldOptions {
  /** The config offers every tool the server lists (not an explicit list): a tool the server adds is held too. */
  takesAll: boolean;
  /** Who published last: the first-seen snapshot is attributed to them. */
  lastPublisher?: string;
}

const FIELD_WORDS: Record<ToolField, string> = { description: 'description', inputSchema: 'input schema', annotations: 'annotations', title: 'title' };

/** The run notice for one held tool: what changed, and where to review it. */
export function heldLine(label: string, change: ToolChange): string {
  return change.change === 'added'
    ? `${label} · ${change.name}: held, it is new on the server since the agent was published. Review it on the agent page.`
    : `${label} · ${change.name}: held, its ${change.fields.map((f) => FIELD_WORDS[f]).join(' and ')} changed since the agent was published. Review it on the agent page.`;
}

/** Who published the agent's latest version (a user id), for a first-seen snapshot. */
export function lastPublisherOf(agentId: string): string | undefined {
  return database().get<{ published_by: string | null }>('SELECT published_by FROM agent_versions WHERE agent_id = ? ORDER BY version DESC LIMIT 1', agentId)?.published_by ?? undefined;
}

const summaryOf = (held: ToolChange[]) => held.map((c) => `${c.name} ${c.change === 'added' ? 'added' : `${c.fields.map((f) => FIELD_WORDS[f]).join('+')} changed`}`).join('; ');

/** Filter one config's listed tools against its approved snapshot (D9-D11); writes a pending record when something is held. */
export function holdChangedTools<T extends ToolContent>(subjectId: string, tools: T[], options: HoldOptions): HoldResult<T> {
  const approved = currentApproval('mcp-tools', subjectId);
  const live = snapshotOf(tools) as unknown as JsonObject;
  if (!approved) {
    approveFirstSeen(options.lastPublisher, 'mcp-tools', subjectId, toolsHash(tools), live, 'first seen at run');
    return { offered: tools, held: [] };
  }
  const known = ((approved.snapshot?.tools ?? []) as unknown as ToolContent[]) ?? [];
  const held = toolChanges(known, tools, options.takesAll);
  if (!held.length) {
    // The server is back to what was approved (or only dropped tools): a stale pending change is moot.
    if (pendingFor('mcp-tools', subjectId).some((record) => record.subjectId === subjectId)) supersedePending('mcp-tools', subjectId);
    return { offered: tools, held: [] };
  }
  recordPending('mcp-tools', subjectId, toolsHash(tools), live, summaryOf(held));
  const heldNames = new Set(held.map((c) => c.name));
  return { offered: tools.filter((tool) => !heldNames.has(tool.name)), held };
}

/** A pending record as the review lists it: the changes against the approved snapshot, computed now. */
export function changesOf(pending: TrustRecord, approved: TrustRecord | undefined, takesAll: boolean): ToolChange[] {
  const before = ((approved?.snapshot?.tools ?? []) as unknown as ToolContent[]) ?? [];
  const after = ((pending.snapshot?.tools ?? []) as unknown as ToolContent[]) ?? [];
  return toolChanges(before, after, takesAll);
}

/**
 * The agent's holds as the agent page shows them: per MCP server config, its newest pending change against the approved
 * snapshot. A config that is gone from the agent, or whose pending change no longer differs, is not listed.
 */
export function heldViewOf(agent: Agent): HeldToolsView[] {
  const configs = new Map<string, McpServerToolConfig>();
  for (const tool of [...agent.tools, ...(agent.published?.config.tools ?? [])]) if (tool.type === 'mcp') configs.set(tool.id, tool);
  const newest = new Map<string, TrustRecord>();
  for (const record of pendingFor('mcp-tools', agentSubjects(agent.id))) {
    const known = newest.get(record.subjectId);
    if (!known || known.firstSeenAt < record.firstSeenAt) newest.set(record.subjectId, record);
  }
  const view: HeldToolsView[] = [];
  for (const [subjectId, pending] of newest) {
    const config = configs.get(subjectId.slice(agentSubjects(agent.id).length));
    if (!config) continue;
    const takesAll = !isGithubPreset(config) && config.parameters.include !== 'selected';
    const changes = changesOf(pending, currentApproval('mcp-tools', subjectId), takesAll);
    if (changes.length) view.push({ subjectId, toolConfigName: config.name, hash: pending.hash, firstSeenAt: pending.firstSeenAt, changes });
  }
  return view.sort((a, b) => a.firstSeenAt.localeCompare(b.firstSeenAt));
}

/** The number of tools held across the agent's pending changes. */
export const heldCount = (view: HeldToolsView[]): number => view.reduce((sum, v) => sum + v.changes.length, 0);
