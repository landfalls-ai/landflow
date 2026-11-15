/**
 * The setup text for each harness (pure: no React, no zod, so the page and its tests share it). `snippetFor` gives the
 * text to paste for Claude Code, Cursor, Codex CLI, Gemini CLI, VS Code or any MCP client; the key goes in once per
 * snippet, or a placeholder until one is made. `harnessKeyBody` is the body of the `POST /api/api-keys` the page sends.
 */
import type { ApiKeyScope } from '@/lib/shared/auth';

export const HARNESS_IDS = ['claude-code', 'cursor', 'codex', 'gemini', 'vscode', 'generic'] as const;
export type HarnessId = (typeof HARNESS_IDS)[number];

export const HARNESSES: readonly { id: HarnessId; label: string; hint: string }[] = [
  { id: 'claude-code', label: 'Claude Code', hint: 'A .mcp.json entry, or one command, and the brain mod' },
  { id: 'cursor', label: 'Cursor', hint: '.cursor/mcp.json' },
  { id: 'codex', label: 'Codex CLI', hint: '~/.codex/config.toml' },
  { id: 'gemini', label: 'Gemini CLI', hint: '~/.gemini/settings.json' },
  { id: 'vscode', label: 'VS Code', hint: '.vscode/mcp.json' },
  { id: 'generic', label: 'Any MCP client', hint: 'The URL and the header' },
];

/** What the shown token stands in for until a key is made. */
export const KEY_PLACEHOLDER = '<your-key>';

export interface SnippetInput {
  /** The MCP endpoint, as given: `https://host/api/mcp`. */
  url: string;
  /** The key (`lf_…`); without one the placeholder shows. */
  token?: string;
}

export interface Snippet {
  /** What it is, e.g. "`.mcp.json`". */
  label: string;
  /** Where it goes. */
  where: string;
  language: 'json' | 'toml' | 'bash' | 'text';
  text: string;
}

const SERVER = 'landflow';
/** The repository whose `.claude-plugin/marketplace.json` lists the landflow-brain mod (docs/landflow-brain-mod.md#install-and-set-up). */
export const MOD_MARKETPLACE = 'landfalls-ai/landflow';

const bearer = (token: string) => `Bearer ${token}`;
const json = (value: unknown) => JSON.stringify(value, null, 2);

/** The Landflow origin from the MCP URL (the mod asks for the origin, not the endpoint). */
export function originOf(url: string): string {
  return url.replace(/\/api\/mcp\/?$/, '').replace(/\/+$/, '');
}

/** The setup to paste for `harness`: one or more snippets. */
export function snippetFor(harness: HarnessId, { url, token }: SnippetInput): Snippet[] {
  const key = token ?? KEY_PLACEHOLDER;
  const headers = { Authorization: bearer(key) };
  switch (harness) {
    case 'claude-code':
      return [
        { label: 'One command', where: 'Run it in a terminal', language: 'bash', text: `claude mcp add --transport http ${SERVER} ${url} --header "Authorization: ${bearer(key)}"` },
        { label: '.mcp.json', where: 'Or put this in .mcp.json in your project (do not commit it: it holds your key)', language: 'json', text: json({ mcpServers: { [SERVER]: { type: 'http', url, headers } } }) },
        { label: 'The landflow-brain mod', where: 'Install it from the Landflow repository’s marketplace. It journals your sessions and brings yesterday back', language: 'bash', text: `claude plugin marketplace add ${MOD_MARKETPLACE}\nclaude plugin install landflow-brain` },
        { label: 'Or from a checkout', where: 'In a clone of the Landflow repository', language: 'bash', text: 'claude plugin install apps/web/claude-plugins/landflow-brain' },
        { label: 'The mod’s options', where: 'Claude Code asks for these when you install it', language: 'text', text: `url: ${originOf(url)}\nkey: ${key}\nrepos: owner/name\nmode: review` },
      ];
    case 'cursor':
      return [{ label: 'mcp.json', where: '.cursor/mcp.json in your project, or ~/.cursor/mcp.json for every project', language: 'json', text: json({ mcpServers: { [SERVER]: { url, headers } } }) }];
    case 'codex':
      return [{ label: 'config.toml', where: '~/.codex/config.toml', language: 'toml', text: `[mcp_servers.${SERVER}]\nurl = ${JSON.stringify(url)}\nhttp_headers = { Authorization = ${JSON.stringify(bearer(key))} }` }];
    case 'gemini':
      return [{ label: 'settings.json', where: '~/.gemini/settings.json, or .gemini/settings.json in your project', language: 'json', text: json({ mcpServers: { [SERVER]: { httpUrl: url, headers } } }) }];
    case 'vscode':
      return [{ label: 'mcp.json', where: '.vscode/mcp.json in your project', language: 'json', text: json({ servers: { [SERVER]: { type: 'http', url, headers } } }) }];
    case 'generic':
      return [
        { label: 'The server', where: 'Streamable HTTP, with this header on every request', language: 'text', text: `URL: ${url}\nAuthorization: ${bearer(key)}` },
        { label: 'As JSON', where: 'For clients that read an mcpServers block', language: 'json', text: json({ mcpServers: { [SERVER]: { type: 'http', url, headers } } }) },
      ];
  }
}

/** The scopes the page offers beyond the brain's, with the words for each. */
export const WORKFLOW_SCOPES: readonly { scope: ApiKeyScope; label: string }[] = [
  { scope: 'workflows:read', label: 'Read workflows' },
  { scope: 'workflows:write', label: 'Edit workflows' },
  { scope: 'run', label: 'Run' },
];

/** The body of the key request: the brain scopes, the chosen workflow ones, 90 days unless told otherwise. */
export function harnessKeyBody(harness: HarnessId, workflowScopes: readonly ApiKeyScope[] = [], expiresInDays = 90) {
  const label = HARNESSES.find((h) => h.id === harness)?.label ?? harness;
  const scopes: ApiKeyScope[] = ['brain:read', 'brain:write', ...workflowScopes.filter((s) => s !== 'brain:read' && s !== 'brain:write')];
  return { label: `Harness · ${label}`, scopes: [...new Set(scopes)], ...(expiresInDays > 0 && { expiresInDays }) };
}

/** The `tools/list` request that tests a key. */
export const TOOLS_LIST_REQUEST = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} } as const;

/** The tool names in a `tools/list` answer (plain JSON or one SSE `data:` event), or undefined if it is neither. */
export function toolNames(body: string): string[] | undefined {
  const dataLine = body.split('\n').find((line) => line.startsWith('data:'));
  try {
    const parsed = JSON.parse(dataLine ? dataLine.slice(5).trim() : body) as { result?: { tools?: { name?: unknown }[] } };
    const tools = parsed.result?.tools;
    return Array.isArray(tools) ? tools.map((t) => String(t.name)) : undefined;
  } catch {
    return undefined;
  }
}
