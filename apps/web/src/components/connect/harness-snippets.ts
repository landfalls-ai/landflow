/**
 * The setup text for each harness (pure: no React, no zod, so the page and its tests share it). `snippetFor` gives the
 * text to paste for Claude Code, Cursor, Codex CLI, Gemini CLI, VS Code or any MCP client; the key goes in once per
 * snippet, or a placeholder until one is made. The harness list and its words come from the registry
 * (`@landflow/protocol/harnesses`, C15); `hookSnippetFor` is the live-status hooks block (C04). `harnessKeyBody` is the body of the `POST /api/api-keys` the page sends.
 */
import { CONNECT_HARNESS_IDS, harnessById, sendsEvents } from '@landflow/protocol/harnesses';
import type { ApiKeyScope } from '@/lib/shared/auth';

export const HARNESS_IDS = CONNECT_HARNESS_IDS;
export type HarnessId = (typeof CONNECT_HARNESS_IDS)[number];

/** What `/connect` lists: the registry's entries for the ids it has setup text for, in its order. */
export const HARNESSES: readonly { id: HarnessId; label: string; hint: string }[] = CONNECT_HARNESS_IDS.map((id) => {
  const entry = harnessById(id);
  return { id, label: entry?.label ?? id, hint: entry?.hint ?? '' };
});

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

/** The scope that lets a key send live status, offered only for a harness that sends events (C04). */
export const STATUS_SCOPE: { scope: ApiKeyScope; label: string } = { scope: 'harness:write', label: 'Send live status' };

/** Whether `/connect` has a live-status step for the harness: the registry says it sends events. */
export function sendsStatus(harness: HarnessId): boolean {
  const entry = harnessById(harness);
  return Boolean(entry && sendsEvents(entry));
}

/** The body of the key request: the brain scopes, the chosen workflow ones (and live status, for a harness that sends it), 90 days unless told otherwise. */
export function harnessKeyBody(harness: HarnessId, workflowScopes: readonly ApiKeyScope[] = [], expiresInDays = 90) {
  const label = HARNESSES.find((h) => h.id === harness)?.label ?? harness;
  const scopes: ApiKeyScope[] = ['brain:read', 'brain:write', ...workflowScopes.filter((s) => s !== 'brain:read' && s !== 'brain:write' && (s !== STATUS_SCOPE.scope || sendsStatus(harness)))];
  return { label: `Harness · ${label}`, scopes: [...new Set(scopes)], ...(expiresInDays > 0 && { expiresInDays }) };
}

/**
 * The Claude Code `settings.json` block that reports status (C04): one command hook per event the registry lists. Each
 * runs `curl` with the key, a per-process counter in the `X-Landflow-Hook-Seq` header (events arrive on separate
 * connections, so they carry their own order) and `--max-time 2` so Claude Code never waits. The hook body is the
 * event's JSON on stdin; Landflow keeps status and counts, never prompt text (docs/connect-your-harness.md).
 */
export function hookSnippetFor({ url, token }: SnippetInput): Snippet {
  const entry = harnessById('claude-code');
  const target = `${originOf(url)}/api/harness/claude-code/hooks`;
  const key = token ?? KEY_PLACEHOLDER;
  const counter = 'f="${TMPDIR:-/tmp}/landflow-hook-$PPID"; n=$(( $(cat "$f" 2>/dev/null || echo 0) + 1 )); echo $n > "$f"';
  const command = `${counter}; curl -s --max-time 2 -X POST ${target} -H "Authorization: ${bearer(key)}" -H "Content-Type: application/json" -H "X-Landflow-Hook-Seq: $n" --data-binary @- >/dev/null 2>&1 || true`;
  const hooks = Object.fromEntries(Object.keys(entry?.hookEvents ?? {}).map((event) => [event, [{ hooks: [{ type: 'command', command }] }]]));
  return { label: 'Live status hooks', where: 'Merge into .claude/settings.json in your project, or ~/.claude/settings.json for every project (do not commit it: it holds your key)', language: 'json', text: json({ hooks }) };
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
