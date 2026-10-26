/** When an MCP grant's tools need a person's OK (docs/transports.md "Credentials, permissions and audit"): the pure rules. */
import type { McpToolDefinition } from '@landflow/protocol';
import type { McpApprovalMode } from '../../shared/mcp-approval';

const RANK: Record<McpApprovalMode, number> = { never: 0, destructive: 1, always: 2 };

/** The instance default (LANDFLOW_MCP_APPROVAL: always | destructive | never), `destructive` unless set. */
export function defaultApprovalMode(): McpApprovalMode {
  const value = String(process.env.LANDFLOW_MCP_APPROVAL ?? '').toLowerCase();
  return value === 'always' || value === 'never' || value === 'destructive' ? value : 'destructive';
}

/** The strictest mode among the grants that allow a tool (a grant that says nothing counts as the default). */
export function strictestMode(modes: Array<McpApprovalMode | undefined>): McpApprovalMode {
  const effective = modes.map((m) => m ?? defaultApprovalMode());
  return effective.reduce((a, b) => (RANK[b] > RANK[a] ? b : a), 'never' as McpApprovalMode);
}

/** Whether a call of `tool` under `mode` waits for a person. */
export function needsApproval(mode: McpApprovalMode, tool: Pick<McpToolDefinition, 'annotations'>): boolean {
  return mode === 'always' || (mode === 'destructive' && tool.annotations.destructiveHint === true);
}

/** Is `next` weaker than `current`? (Only a grant's creator may turn approvals down.) */
export const weakens = (current: McpApprovalMode | undefined, next: McpApprovalMode | undefined) => RANK[next ?? defaultApprovalMode()] < RANK[current ?? defaultApprovalMode()];
