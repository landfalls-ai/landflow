/**
 * A minimal MCP client for the host's instance server (`POST /api/mcp`, Streamable HTTP, JSON-RPC): one `tools/call`
 * per request, which the server answers statelessly. The same API key as the REST calls is the bearer token. A tool
 * that fails (`isError`) becomes a CliError; a tool's JSON text result is parsed.
 */
import type { Client } from './client';
import { CliError } from './errors';
import { VERSION } from './version';

let counter = 0;

interface Rpc {
  result?: { content?: Array<{ type: string; text?: string }>; isError?: boolean };
  error?: { code: number; message: string };
}

/** The JSON-RPC response in a body that is plain JSON or SSE `data:` events. */
function parseRpc(text: string): Rpc {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) return JSON.parse(trimmed);
  const data = trimmed
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .filter(Boolean);
  if (!data.length) throw new Error('empty answer');
  return JSON.parse(data[data.length - 1]);
}

/** Call an instance MCP tool and return its parsed JSON result (or the text when it isn't JSON). */
export async function callTool<T = Record<string, unknown>>(client: Client, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'mcp-protocol-version': '2025-06-18',
    'user-agent': `landflow-cli/${VERSION}`,
  };
  if (client.apiKey) headers.authorization = `Bearer ${client.apiKey}`;
  let response: Response;
  try {
    response = await client.fetchImpl(new URL('/api/mcp', `${client.url}/`).toString(), {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: ++counter, method: 'tools/call', params: { name, arguments: args } }),
    });
  } catch (caught) {
    throw new CliError('network', `Can't reach Landflow at ${client.url}: ${(caught as Error).message}`);
  }
  const text = await response.text();
  if (response.status === 401) throw new CliError('unauthorized', 'The MCP server refused the key (run `landflow login`, or set LANDFLOW_API_KEY)', { status: 401 });
  if (response.status === 403) throw new CliError('forbidden', 'The instance MCP server is off or the key may not use it (Settings → MCP)', { status: 403 });
  if (response.status === 404) throw new CliError('not_supported', 'This host has no POST /api/mcp (an older Landflow?)', { status: 404 });
  let rpc: Rpc;
  try {
    rpc = parseRpc(text);
  } catch {
    throw new CliError('server_error', `The MCP server answered ${response.status} with something that isn't JSON-RPC`, { status: response.status });
  }
  if (rpc.error) {
    const code = /not found|unknown tool/i.test(rpc.error.message) ? 'not_supported' : 'server_error';
    throw new CliError(code, `MCP ${name}: ${rpc.error.message}`);
  }
  const body = (rpc.result?.content ?? [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('\n');
  if (rpc.result?.isError) throw new CliError('bad_request', `MCP ${name}: ${body || 'failed'}`);
  try {
    return JSON.parse(body) as T;
  } catch {
    return body as unknown as T;
  }
}
