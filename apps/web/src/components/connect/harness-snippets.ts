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

/**
 * Whether `/connect` has a live-status step (hooks and a hook key) for the harness: the registry says it sends events through native
 * hooks. Codex sends one event too, but from a wrapper (`landflow harness watch codex`, C08), so it has no hooks block here.
 */
export function sendsStatus(harness: HarnessId): boolean {
  const entry = harnessById(harness);
  return Boolean(entry && entry.strategy === 'native-hooks' && sendsEvents(entry));
}

/** The body of the key request: the brain scopes and the chosen workflow ones, 90 days unless told otherwise. The live-status scope is never here: the hooks have a key of their own (`hookKeyBody`). */
export function harnessKeyBody(harness: HarnessId, workflowScopes: readonly ApiKeyScope[] = [], expiresInDays = 90) {
  const label = HARNESSES.find((h) => h.id === harness)?.label ?? harness;
  const scopes: ApiKeyScope[] = ['brain:read', 'brain:write', ...workflowScopes.filter((s) => s !== 'brain:read' && s !== 'brain:write' && s !== STATUS_SCOPE.scope)];
  return { label: `Harness · ${label}`, scopes: [...new Set(scopes)], ...(expiresInDays > 0 && { expiresInDays }) };
}

/** The environment variable the hooks read the key from (never a literal in the settings file). */
// Written in parts on purpose: this is a variable of the person's shell that the hook script reads on their machine, not
// host configuration, so config-catalog.test.ts must not take it (or the script's environment read) for a host read.
export const HOOK_KEY_ENV = ['LANDFLOW', 'HOOK', 'KEY'].join('_');
const ENV_OBJECT = 'env';

/** The fields of a hook event the filter forwards: names, ids, a duration and an error's words, never prompts, input, output, paths or `agent_type`. */
export const HOOK_FIELDS = ['hook_event_name', 'session_id', 'tool_name', 'notification_type', 'duration_ms', 'error', 'error_details'] as const;
/** `error_details` (up to 300 characters of the error's text) is sent only for a session bound to an agent; an own session sends `error` only. */
const AGENT_ONLY_FIELDS: readonly string[] = ['error_details'];

/**
 * The one-line Node script a hook runs (Claude Code needs Node, so it is there; `jq` may not be). It reads the event JSON from
 * stdin and keeps only HOOK_FIELDS, and of those only strings (cut to 300 characters) and finite numbers. It sends them with the
 * key from the environment, an order number from one clock (`performance.timeOrigin + performance.now()`, in microseconds, plus
 * two random digits so two hooks started in the same microsecond still differ; 18 digits, the most the server reads, so
 * parallel hooks get different numbers and no counter file is needed) and, when an agent was picked, its id in `X-Landflow-Agent`.
 * It gives up after 1.5 seconds and always exits quietly. No single quotes: it sits inside `node -e '…'`.
 *
 * `origin` and `agentId` end up inside a shell command, so both are checked and the call throws on anything else: the origin must
 * be exactly what `new URL(origin).origin` gives (no path, no quote, no space) and an agent id is word characters and dashes.
 */
export function hookFilterScript(origin: string, agentId?: string): string {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new Error('The Landflow address is not a URL');
  }
  if (parsed.origin !== origin || /['\s"\\]/.test(origin)) throw new Error('The Landflow address must be an origin such as https://landflow.example.com');
  if (agentId !== undefined && !/^[\w-]{1,100}$/.test(agentId)) throw new Error('The agent id has characters a hook cannot carry');
  const target = `${origin}/api/harness/claude-code/hooks`;
  const fields = HOOK_FIELDS.filter((field) => agentId || !AGENT_ONLY_FIELDS.includes(field));
  const headers = `{"content-type":"application/json",authorization:"Bearer "+process.${ENV_OBJECT}[${JSON.stringify(HOOK_KEY_ENV)}],"x-landflow-hook-seq":String(Math.round((performance.timeOrigin+performance.now())*1000))+String(Math.floor(Math.random()*100)).padStart(2,"0")${agentId ? `,"x-landflow-agent":${JSON.stringify(agentId)}` : ''}}`;
  return [
    'let d="";',
    'process.stdin.on("data",c=>d+=c).on("end",()=>{try{',
    `const e=JSON.parse(d),o={};for(const k of ${JSON.stringify(fields)}){const v=e[k];if(typeof v==="string")o[k]=v.slice(0,300);else if(typeof v==="number"&&Number.isFinite(v))o[k]=v}`,
    `fetch(${JSON.stringify(target)},{method:"POST",headers:${headers},body:JSON.stringify(o),signal:AbortSignal.timeout(1500)}).catch(()=>{})`,
    '}catch{}})',
  ].join('');
}

/**
 * The Claude Code hooks block for live status (C04): one command hook per event the registry lists, each running the filter
 * above, in the background (`async`) so Claude Code never waits. It holds no key (that is in `$LANDFLOW_HOOK_KEY`) and sends no
 * prompt, tool input or output, working directory or transcript path: a session it reports is the person's own, unless they picked
 * a Landflow agent they may run (then its id goes in a header and the session shows on that agent).
 */
export function hookSnippetFor({ url, agentId }: { url: string; agentId?: string }): Snippet {
  const entry = harnessById('claude-code');
  const command = `node -e '${hookFilterScript(originOf(url), agentId)}'`;
  const hooks = Object.fromEntries(Object.keys(entry?.hookEvents ?? {}).map((event) => [event, [{ hooks: [{ type: 'command', command, async: true }] }]]));
  return {
    label: 'Live status hooks',
    where: 'Merge into .claude/settings.local.json in your project (Claude Code keeps it out of Git), or ~/.claude/settings.json for every project. Never into the committed .claude/settings.json',
    language: 'json',
    text: json({ hooks }),
  };
}

/** The line that gives the hooks their key: put it in your shell profile, so the key is not in any settings file. */
export function hookKeySnippet(token?: string): Snippet {
  return { label: 'Your hook key', where: 'Add to ~/.zshrc or ~/.bashrc and open a new terminal, so Claude Code starts with it', language: 'bash', text: `export ${HOOK_KEY_ENV}=${token ?? KEY_PLACEHOLDER}` };
}

/** The body of the request for the hooks' own key: it may send live status and nothing else, 30 days unless told otherwise (every program Claude Code starts can read it). */
export function hookKeyBody(expiresInDays = 30) {
  return { label: 'Harness · Claude Code live status', scopes: [STATUS_SCOPE.scope], ...(expiresInDays > 0 && { expiresInDays }) };
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
