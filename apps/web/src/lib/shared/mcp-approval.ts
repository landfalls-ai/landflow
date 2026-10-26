/** Approvals of MCP tool calls (docs/transports.md "Credentials, permissions and audit"): types and labels shared by the routes and Settings → MCP. No runtime imports. */

/** How a grant treats approvals (docs/transports.md "Credentials, permissions and audit"; migration 1750). */
export const MCP_APPROVAL_MODES = ['always', 'destructive', 'never'] as const;
export type McpApprovalMode = (typeof MCP_APPROVAL_MODES)[number];
export const MCP_APPROVAL_LABELS: Record<McpApprovalMode, string> = {
  always: 'Always ask a person',
  destructive: 'Ask for destructive tools',
  never: 'Never ask',
};

/** An MCP tool call that waits for, or got, a person's answer (GET /api/mcp/approvals). */
export interface McpApprovalView {
  id: string;
  pluginId: string;
  tool: string;
  caller: string;
  /** What the call would do: the arguments, clipped. */
  summary: string;
  status: 'pending' | 'approved' | 'denied' | 'expired' | 'used';
  createdAt: string;
  expiresAt: string;
  decidedBy?: string;
  decidedAt?: string;
  /** Whether the signed-in user may answer it. */
  canDecide?: boolean;
}
