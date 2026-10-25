/** Settings → MCP (the instance MCP server at /api/mcp): types shared by the API route and the client. No runtime imports. */

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
