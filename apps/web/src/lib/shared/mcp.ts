/** Settings → MCP (the instance MCP server at /api/mcp): types shared by the API route and the client. */
import type { McpApprovalMode } from './mcp-approval';

export interface McpAccessView {
  /** Whether /api/mcp answers at all (off by default). */
  enabled: boolean;
  hasToken: boolean;
  /** The token's last characters, to tell tokens apart (the token itself is shown once). */
  tokenHint?: string;
  tokenCreatedAt?: string;
  /** The path of the server on this host. */
  path: '/api/mcp';
}

/** A change that created a token returns it, once. */
export interface McpAccessResponse {
  access: McpAccessView;
  token?: string;
}

// ---- MCP identity, grants, tokens and the gateway (docs/transports.md "The bundled MCP gateway"; lib/server/mcp) ----

/** What a Landflow-issued MCP token may do (the `scope` claim, space-separated). */
export const MCP_TOKEN_SCOPES = ['tools:list', 'tools:call', 'registry:read'] as const;
export type McpTokenScope = (typeof MCP_TOKEN_SCOPES)[number];

export const MCP_TOKEN_SCOPE_LABELS: Record<McpTokenScope, string> = {
  'tools:list': 'List the tools the grants allow',
  'tools:call': 'Call them',
  'registry:read': 'Read the plugin catalog (server.json, the registry API)',
};

/** A Landflow-issued MCP token as Settings → MCP lists it (never the token itself). */
export interface McpTokenView {
  id: string;
  label: string;
  /** The last characters of the token, to tell tokens apart. */
  hint: string;
  scopes: McpTokenScope[];
  createdAt: string;
  expiresAt: string;
  revokedAt?: string;
  lastUsedAt?: string;
  /** The user it acts as (admins see every user's tokens). */
  userId: string;
  userName?: string;
}

/** Who a grant is for: a user, a SCIM group, everyone in a project, a role, or the holder of one MCP token. */
export const MCP_GRANT_SUBJECT_KINDS = ['user', 'group', 'project', 'role', 'token'] as const;
export type McpGrantSubjectKind = (typeof MCP_GRANT_SUBJECT_KINDS)[number];

/** A tool grant (docs/protocol.md §15.5). */
export interface McpToolGrant {
  id: string;
  subject: { kind: McpGrantSubjectKind; id: string; name?: string };
  /** A plugin id, or `core` for the in-process nodes. */
  pluginId: string;
  /** Tool names on the plugin's endpoint, or '*' for every tool of the plugin; `!name` excludes one. */
  tools: string[] | '*';
  /** credentialType → credential id: the credential bound per credential type the plugin's nodes use. */
  credentials: Record<string, string>;
  /**
   * When the grant's tools need a person's OK before they run: `always`, `destructive` (the default: tools with
   * `destructiveHint`) or `never`. Absent: the instance default (`destructive`).
   */
  approval?: McpApprovalMode;
  /** Older boolean form of `approval`: true = `destructive`, false = `never`. Still accepted and returned. */
  requireApproval?: boolean;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
}

/** Settings → MCP: the gateway and identity configuration this host runs with (GET /api/mcp/status). */
export interface McpStatusView {
  gateway: {
    /** LANDFLOW_MCP_GATEWAY: `bundled` (agentgateway sidecar), `file` (a gateway of its own reading a YAML file) or `off`. */
    mode: 'bundled' | 'file' | 'off';
    /** LANDFLOW_MCP_GATEWAY_PUBLIC_URL, where agents connect. */
    publicUrl?: string;
    /** Whether the host has the secret the gateway sends (`x-landflow-gateway`); without it gateway calls are refused. */
    secretConfigured: boolean;
    /** The gateway sync (McpGatewaySync): `running` in this process, `off` in mode off, `stopped` before bootstrap started it. */
    sync: 'running' | 'off' | 'stopped';
    /**
     * The token check the host puts on the gateway's per-plugin routes (`mcpAuthentication` in
     * LANDFLOW_MCP_GATEWAY_ROUTE_POLICIES): whose tokens and the mode. Absent: those routes don't sign callers in, so
     * they're anonymous there. The gateway's own `/mcp` route signs in from its config file, which the host can't read.
     */
    signIn?: { issuer: string; mode: string };
  };
  /** This host's URL, the issuer of its MCP tokens. */
  instanceUrl: string;
  /** The identity provider agents can sign in with (LANDFLOW_OIDC_ISSUER), if any. */
  identityProvider?: { issuer: string };
  /** The MCP registry namespace (`<namespace>/<pluginId>` names). */
  namespace: string;
  /** Paths on this host. */
  paths: { jwks: string; registry: string; plugins: string; protectedResourceMetadata: string };
  /** Whether the signed-in user may manage grants (owners and admins). */
  canManage: boolean;
}

/** One resource the gateway sync wants in the gateway, and whether the gateway has it as rendered (GET /api/mcp/gateway). */
export interface McpGatewayTargetView {
  /** The resource id in agentgateway (a target name = the plugin's gateway name; a route name). */
  name: string;
  pluginId: string;
  kind: 'mcp.target' | 'traffic.route';
  /** What the target stands for: a plugin, the Landflow instance server, or a published workflow's MCP Server Trigger. */
  serverKind: 'plugin' | 'instance' | 'workflow';
  /** A human label for the target (the plugin id, "Landflow instance server", or the workflow name and path). */
  label: string;
  /** `in-step`: as rendered; `drift`: present but different; `missing`: wanted, absent; `stale`: Landflow's but no longer wanted; `unknown`: the gateway can't be read back (file mode). */
  state: 'in-step' | 'drift' | 'missing' | 'stale' | 'unknown';
}

/** Settings → MCP: the gateway sync's status (GET /api/mcp/gateway; POST /api/mcp/gateway/sync forces a reconcile). */
export interface McpGatewayStatusView {
  mode: 'bundled' | 'file' | 'off';
  /** `agentgateway` (the config API) or `file`. */
  adapter?: string;
  /** The admin URL or the file the adapter writes. */
  location?: string;
  /** The URL the gateway reaches this host at (LANDFLOW_MCP_GATEWAY_HOST_URL). */
  hostUrl: string;
  /** Whether per-plugin routes (`/mcp/plugins/<name>`, `…/server-card`) are written too. */
  routes: boolean;
  running: boolean;
  health?: { ok: boolean; version?: string; message?: string };
  targets: McpGatewayTargetView[];
  inStep: number;
  drift: number;
  lastSyncAt?: string;
  lastChangeAt?: string;
  lastError?: string;
  secretConfigured: boolean;
}

// ---- the per-plugin MCP endpoints and the tool browser (lib/server/mcp/plugin-servers.ts; GET /api/mcp/tools) ----

/** One MCP tool of an exposed plugin, as the tool browser in Settings → MCP shows it (docs/protocol.md §15.1). */
export interface McpToolView {
  pluginId: string;
  pluginName: string;
  /** The name on the plugin's own endpoint (/api/mcp/plugins/<pluginId>). */
  name: string;
  /** The name on the gateway's shared endpoint (`<pluginId>_<name>`). */
  gatewayName: string;
  title: string;
  description: string;
  annotations: { title?: string; readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };
  /** JSON Schema 2020-12 of the arguments. */
  inputSchema: Record<string, unknown>;
  /** JSON Schema of `structuredContent` (`{ items: [...] }`), when the node declares one. */
  outputSchema?: Record<string, unknown>;
  /** The node behind the tool (`<pluginId>.<node>`), its version, and the resource/operation the tool fixes. */
  nodeType: string;
  typeVersion: number;
  resource?: string;
  operation?: string;
  /** Credential types the node can use (bound by a grant or the caller's credentials, never arguments). */
  credentials: string[];
  /** Why the governance policy blocks the node on this instance, when it does. */
  blocked?: string;
  /** Whether the plugin is online now (an offline plugin's tools answer with an error). */
  online: boolean;
}

export interface McpToolsResponse {
  tools: McpToolView[];
  /** The exposed plugins with their endpoint paths and tool counts, including ones with zero tools. */
  plugins: Array<{ id: string; name: string; path: string; tools: number; online: boolean }>;
}

/** The result `_meta` key under which a tool call names the execution it ran as. */
export const MCP_EXECUTION_META_KEY = 'dev.landflow/execution';
