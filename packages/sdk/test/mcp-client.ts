/** A minimal 2026-07-28 MCP client for tests: one JSON-RPC request with the per-request `_meta` envelope and the matching headers. */
const MCP_META = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientCapabilities': {},
  'io.modelcontextprotocol/clientInfo': { name: 'conformance-runner', version: '1' },
};

export async function mcpRequest(url: string, method: string, params: Record<string, unknown>, options: { token?: string; signal?: AbortSignal; name?: string } = {}) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2026-07-28',
      'mcp-method': method,
      ...(options.name && { 'mcp-name': options.name }),
      ...(options.token && { authorization: `Bearer ${options.token}` }),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { _meta: MCP_META, ...params } }),
    signal: options.signal,
  });
  const text = await response.text();
  const data = text.startsWith('event:') || text.startsWith('data:') ? JSON.parse(text.split('\n').find((line) => line.startsWith('data:'))!.slice(5)) : text ? JSON.parse(text) : undefined;
  return { status: response.status, headers: response.headers, body: data as { result?: Record<string, unknown>; error?: { code: number; message: string } } | undefined };
}

