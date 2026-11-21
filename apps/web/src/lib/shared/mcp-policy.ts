/**
 * MCP policy hooks (C14): the types and words the server, the routes and Settings → MCP → Policy hooks share. Browser
 * safe: no zod and no server imports (the schema lives in server/mcp/policy-hooks-schema.ts).
 */

/** The outbound MCP requests a hook can look at. */
export type McpPolicyMethod = 'tools/call' | 'resources/read' | 'prompts/get';

export const MCP_POLICY_METHODS: readonly McpPolicyMethod[] = ['tools/call', 'resources/read', 'prompts/get'];
export const MAX_POLICY_HOOKS = 20;
export const MIN_HOOK_TIMEOUT_MS = 100;
export const MAX_HOOK_TIMEOUT_MS = 5_000;
export const DEFAULT_HOOK_TIMEOUT_MS = 2_000;

export type McpPolicyAuth = 'hmac' | 'bearer' | 'none';

/** One policy hook as stored and shown (the credential by id only, never its value). */
export interface McpPolicyHook {
  id: string;
  name: string;
  enabled: boolean;
  url: string;
  auth: McpPolicyAuth;
  /** A vault credential of type `core.httpBearerAuth`: its token signs the request (hmac) or is sent as the bearer. */
  credentialId?: string;
  timeoutMs: number;
  /** What happens when the service does not answer: `closed` blocks the call, `open` lets it through. */
  failureMode: 'closed' | 'open';
  match: {
    /** Host patterns of the MCP server's URL (`mcp.example.com`, `*.example.com`, CIDR); empty: any server. */
    hosts: string[];
    /** The server URL's path starts with this. */
    pathPrefix?: string;
    /** Tool name patterns (`*` and `?`); empty: any. For resources and prompts the uri or prompt name. */
    tools: string[];
    methods: McpPolicyMethod[];
    /** Project ids; empty: calls from any project. */
    projects: string[];
  };
  createdAt: string;
  updatedAt: string;
}

/** The hook as the API shows it: the credential as its id and name. */
export type McpPolicyHookView = Omit<McpPolicyHook, 'credentialId'> & { credential?: { id: string; name: string } };

/** What the tool result (or the error) says for a denied call. */
export const blockedText = (hook: string, reason: string) => `Blocked by policy ${hook}: ${reason}`;
export const UNAVAILABLE = 'policy service unavailable';
export const BLOCKED_PREFIX = 'Blocked by policy ';

export const METHOD_WORDS: Record<McpPolicyMethod, string> = { 'tools/call': 'tool calls', 'resources/read': 'resource reads', 'prompts/get': 'prompts' };

/** One line for what a hook looks at: "tool calls to mcp.example.com for create_*". */
export function matchLine(hook: Pick<McpPolicyHook, 'match'>): string {
  const { match } = hook;
  const what = match.methods.map((m) => METHOD_WORDS[m]).join(', ') || 'nothing';
  const where = match.hosts.length ? ` to ${match.hosts.join(', ')}${match.pathPrefix ? match.pathPrefix : ''}` : match.pathPrefix ? ` under ${match.pathPrefix}` : '';
  const which = match.tools.length ? ` for ${match.tools.join(', ')}` : '';
  const who = match.projects.length ? ` in ${match.projects.length} project${match.projects.length === 1 ? '' : 's'}` : '';
  return `${what}${where}${which}${who}`;
}

/** The plain words for a failure mode (the dialog and the list). */
export const FAILURE_WORDS: Record<McpPolicyHook['failureMode'], string> = {
  closed: 'If the service does not answer: block the call',
  open: 'If the service does not answer: let the call through',
};
