/**
 * The server side of MCP over Streamable HTTP, stateless: every POST gets a fresh McpServer and
 * transport that answer with JSON (no session id, no server-to-client stream), so a request needs
 * nothing from an earlier one. GET (the optional event stream) and DELETE (ending a session) get
 * 405, which clients take as "not offered". Used by /mcp/<path> (MCP Server Trigger) and /api/mcp
 * (the instance server).
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/** The version Landflow's MCP servers report. */
export const MCP_SERVER_VERSION = '0.1.0';

/** Answer one MCP request with a server made for it. */
export async function serveMcp(request: Request, create: () => McpServer | Promise<McpServer>): Promise<Response> {
  if (request.method !== 'POST') return methodNotAllowed();
  const server = await create();
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    // In JSON mode the response is complete when this resolves, so the server can close right after.
    return await transport.handleRequest(request);
  } finally {
    void server.close().catch(() => {});
  }
}

export function methodNotAllowed(): Response {
  return jsonRpcError(405, -32000, 'Method not allowed: this server is stateless, send JSON-RPC messages with POST', { allow: 'POST' });
}

/** An HTTP error with a JSON-RPC error body, as MCP clients expect. */
export function jsonRpcError(status: number, code: number, message: string, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** 401 with a bearer challenge (or none, for a custom header). */
export function unauthorized(message: string, scheme: 'bearer' | 'header' = 'bearer'): Response {
  return jsonRpcError(401, -32001, message, scheme === 'bearer' ? { 'www-authenticate': 'Bearer realm="landflow"' } : {});
}

/** The token of an `Authorization: Bearer …` header. */
export function bearerToken(request: Request): string | undefined {
  const match = /^Bearer\s+(.+)$/i.exec(request.headers.get('authorization')?.trim() ?? '');
  return match?.[1].trim() || undefined;
}

/** Constant-time comparison of two secrets (hashed first, so lengths don't leak either). */
export function sameSecret(given: string | undefined | null, expected: string): boolean {
  if (!given || !expected) return false;
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/** A tool result: text (JSON for anything but a string). */
export function textResult(value: unknown, isError = false): CallToolResult {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null, null, 2);
  return { content: [{ type: 'text', text }], ...(isError && { isError: true }) };
}
