/**
 * Instance governance (lib/server/governance): which node types and MCP servers workflows and agents may use, and
 * four-eyes publishing (a publish, rollback or unpublish needs a second person's approval). Shapes shared by the API
 * (/api/settings/governance, /api/publish-requests), Settings → Governance and the editor. No runtime imports.
 */
import type { PublicationStatus } from './publish';

/** `off`: no rule. `allow`: only what the list names. `block`: everything except what the list names. */
export type ListMode = 'off' | 'allow' | 'block';

export interface NodePolicy {
  mode: ListMode;
  /** Node type ids (`core.httpRequest`), `*` matches any characters (`messaging.*`). */
  types: string[];
  /** Plugin ids: every node type of the plugin. */
  plugins: string[];
  /** Block Code nodes whatever the mode. */
  blockCode: boolean;
}

/** Hosts the HTTP Request node may call. Patterns match the host name (`*.example.com`, `10.*`), or `host:port`. */
export interface HttpHostPolicy {
  mode: ListMode;
  hosts: string[];
}

/** MCP servers the MCP Client node and tool and agents may connect to: URL patterns (`https://mcp.example.com/*`) or host patterns. */
export interface McpPolicy {
  mode: 'off' | 'allow';
  urls: string[];
}

/** Who may approve: any other signed-in builder (`member`, the instance's editor role) or only owners and admins. */
export type ApproverRole = 'member' | 'admin';

export interface FourEyesPolicy {
  enabled: boolean;
  approverRole: ApproverRole;
  /** Unpublishing needs approval too (default on). */
  unpublish: boolean;
  /** Email the approvers (over the host's SMTP settings) when a request comes in, and the requester when it is decided. */
  notifyEmail: boolean;
  /** Alert channels (Settings → Alerts) that hear about new requests. */
  channelIds: string[];
}

export interface GovernancePolicy {
  nodes: NodePolicy;
  http: HttpHostPolicy;
  mcp: McpPolicy;
  fourEyes: FourEyesPolicy;
  updatedAt?: string;
  updatedBy?: string;
}

export const DEFAULT_GOVERNANCE_POLICY: GovernancePolicy = {
  nodes: { mode: 'off', types: [], plugins: [], blockCode: false },
  http: { mode: 'off', hosts: [] },
  mcp: { mode: 'off', urls: [] },
  fourEyes: { enabled: false, approverRole: 'member', unpublish: true, notifyEmail: true, channelIds: [] },
};

/** A node the policy doesn't allow. */
export interface PolicyViolation {
  nodeId: string;
  nodeName: string;
  nodeType: string;
  rule: 'node' | 'plugin' | 'code' | 'http' | 'mcp';
  message: string;
}

export type PublishRequestKind = 'publish' | 'rollback' | 'unpublish';
export type PublishRequestStatus = 'pending' | 'approved' | 'rejected' | 'canceled' | 'stale' | 'failed';

/** What a publish request would change, against what is live when it was made. */
export interface PublishRequestDiff {
  summary: string;
  nodesAdded: string[];
  nodesRemoved: string[];
  nodesChanged: string[];
  connectionsChanged: number;
  settingsChanged: boolean;
}

/** A request to publish, roll back or unpublish a workflow (GET /api/publish-requests). */
export interface PublishRequestView {
  id: string;
  workflowId: string;
  workflowName: string;
  kind: PublishRequestKind;
  status: PublishRequestStatus;
  /** The version it publishes (publish, rollback). */
  versionId?: string;
  versionNumber?: number;
  /** What was live when it was asked for. */
  baseVersionNumber?: number;
  note?: string;
  diff?: PublishRequestDiff;
  requestedBy: string;
  requestedByName?: string;
  requestedAt: string;
  decidedBy?: string;
  decidedByName?: string;
  decidedAt?: string;
  comment?: string;
  /** Why it went stale (the draft or the live version changed) or why the approved publish failed. */
  reason?: string;
  /** For the viewer: may approve or reject it, may withdraw it. */
  canApprove?: boolean;
  canCancel?: boolean;
}

/** GET /api/publish-requests */
export interface PublishRequestList {
  requests: PublishRequestView[];
  fourEyes: { enabled: boolean; approverRole: ApproverRole; unpublish: boolean };
  /** Pending requests the viewer may approve (the badge). */
  approvable: number;
}

/** 202 from POST /api/workflows/:id/publish and /unpublish when four-eyes publishing is on. */
export interface PublishRequestedResponse extends PublicationStatus {
  approvalRequired: true;
  request: PublishRequestView;
  triggerErrors: [];
}

/** PUT/POST /api/workflows: nodes the policy won't allow, as a warning (publishing them is refused). */
export interface PolicyWarnings {
  policyWarnings?: PolicyViolation[];
}
