/**
 * The harness registry (C15): every coding harness Landflow knows, how to detect it, where its MCP config lives, how
 * Landflow can observe it and which hook events map to which status. One list for `/connect`, the hook ingest, the
 * kagent runtime labels and `landflow harness detect`. Plain objects and functions: it imports nothing (browser-safe,
 * no zod built at load, the CSP rule in docs/constitution.md) and the CLI reads it through the
 * `@landflow/protocol/harnesses` subpath.
 */

export type HarnessKind = 'cli' | 'ide' | 'desktop' | 'generic';
/** How Landflow can see what a harness is doing: native hooks, a plugin system, an extension, a wrapper that watches it, or not at all. */
export type HarnessStrategy = 'native-hooks' | 'plugin' | 'extension' | 'wrapper' | 'mcp-only';
export type HarnessStatus = 'thinking' | 'working' | 'compacting' | 'waiting' | 'idle' | 'error' | 'blocked' | 'ended';

/** One event's effect: a status, optionally only when a payload field has a value (`Notification` by `notification_type`). */
export interface HookEventRule {
  status: HarnessStatus;
  when?: { field: string; equals: string };
}

export interface HarnessEntry {
  id: string;
  label: string;
  /** The line under the label on `/connect`. */
  hint: string;
  kind: HarnessKind;
  /** Binary names looked for on PATH and config files whose presence says it is installed (`~` is the home folder). */
  detect: { binaries: string[]; configFiles: string[] };
  defaultCommand?: string;
  mcpConfig: { file: string; format: 'json-mcpServers' | 'json-servers' | 'toml' | 'none' };
  strategy: HarnessStrategy;
  /** The event names the harness sends and what each does to a session's status (only when it sends events). */
  hookEvents?: Record<string, HookEventRule | HookEventRule[]>;
  statusSignals: 'hooks' | 'rollout-file' | 'none';
  kagentRuntime?: 'claude' | 'codex';
  /** False: the entry was written from the harness's plan, not checked against the installed tool. */
  verified: boolean;
  note?: string;
}

/** What the status machine does with an event: a status, or `keep` for a known event that changes nothing. */
export type StatusVerdict = HarnessStatus | 'keep';

const always = (status: HarnessStatus): HookEventRule => ({ status });
const notification = (type: string, status: HarnessStatus): HookEventRule => ({ status, when: { field: 'notification_type', equals: type } });

/**
 * Claude Code's hooks, checked against the CLI's own event schemas (2.1.330 locally; kagent pins 2.1.285, which has the
 * same names: docs/specs/20-combined/notes/hooks.md). `Blocked` is not here: it comes from a quota signal (ingest).
 */
const CLAUDE_CODE_EVENTS: Record<string, HookEventRule | HookEventRule[]> = {
  SessionStart: always('idle'),
  UserPromptSubmit: always('thinking'),
  PreToolUse: always('working'),
  PostToolUse: always('thinking'),
  PostToolUseFailure: always('thinking'),
  PermissionRequest: always('waiting'),
  PreCompact: always('compacting'),
  PostCompact: always('thinking'),
  Notification: [notification('permission_prompt', 'waiting'), notification('idle_prompt', 'idle')],
  Stop: always('idle'),
  StopFailure: always('error'),
  SessionEnd: always('ended'),
};

const NOT_VERIFIED = 'Event names not checked against a live install: until they are, it is mcp-only (C15 open question 3).';

export const HARNESS_REGISTRY: readonly HarnessEntry[] = [
  {
    id: 'claude-code',
    label: 'Claude Code',
    hint: 'A .mcp.json entry, or one command, and the brain mod',
    kind: 'cli',
    detect: { binaries: ['claude'], configFiles: ['~/.claude/settings.json'] },
    defaultCommand: 'claude',
    mcpConfig: { file: '.mcp.json', format: 'json-mcpServers' },
    strategy: 'native-hooks',
    hookEvents: CLAUDE_CODE_EVENTS,
    statusSignals: 'hooks',
    kagentRuntime: 'claude',
    verified: true,
  },
  { id: 'cursor', label: 'Cursor', hint: '.cursor/mcp.json', kind: 'ide', detect: { binaries: ['cursor'], configFiles: ['~/.cursor/mcp.json'] }, mcpConfig: { file: '.cursor/mcp.json', format: 'json-mcpServers' }, strategy: 'mcp-only', statusSignals: 'none', verified: false },
  {
    id: 'codex',
    label: 'Codex CLI',
    hint: '~/.codex/config.toml',
    kind: 'cli',
    detect: { binaries: ['codex'], configFiles: ['~/.codex/config.toml'] },
    defaultCommand: 'codex',
    mcpConfig: { file: '~/.codex/config.toml', format: 'toml' },
    strategy: 'mcp-only',
    statusSignals: 'none',
    kagentRuntime: 'codex',
    verified: false,
    note: `Planned as a wrapper (hooks plus the rollout file). ${NOT_VERIFIED}`,
  },
  { id: 'gemini', label: 'Gemini CLI', hint: '~/.gemini/settings.json', kind: 'cli', detect: { binaries: ['gemini'], configFiles: ['~/.gemini/settings.json'] }, defaultCommand: 'gemini', mcpConfig: { file: '~/.gemini/settings.json', format: 'json-mcpServers' }, strategy: 'mcp-only', statusSignals: 'none', verified: false },
  { id: 'vscode', label: 'VS Code', hint: '.vscode/mcp.json', kind: 'ide', detect: { binaries: ['code'], configFiles: [] }, mcpConfig: { file: '.vscode/mcp.json', format: 'json-servers' }, strategy: 'mcp-only', statusSignals: 'none', verified: false },
  { id: 'generic', label: 'Any MCP client', hint: 'The URL and the header', kind: 'generic', detect: { binaries: [], configFiles: [] }, mcpConfig: { file: '', format: 'none' }, strategy: 'mcp-only', statusSignals: 'none', verified: true },
  {
    id: 'opencode',
    label: 'OpenCode',
    hint: 'opencode.json',
    kind: 'cli',
    detect: { binaries: ['opencode'], configFiles: ['~/.config/opencode/opencode.json'] },
    defaultCommand: 'opencode',
    mcpConfig: { file: 'opencode.json', format: 'json-mcpServers' },
    strategy: 'mcp-only',
    statusSignals: 'none',
    verified: false,
    note: `Planned as a plugin. ${NOT_VERIFIED}`,
  },
  {
    id: 'claude-desktop',
    label: 'Claude Desktop',
    hint: 'claude_desktop_config.json',
    kind: 'desktop',
    detect: { binaries: [], configFiles: ['~/Library/Application Support/Claude/claude_desktop_config.json', '~/.config/Claude/claude_desktop_config.json'] },
    mcpConfig: { file: 'claude_desktop_config.json', format: 'json-mcpServers' },
    strategy: 'mcp-only',
    statusSignals: 'none',
    verified: false,
  },
];

/** The harnesses `/connect` shows, in its order (OpenCode and Claude Desktop are registered but have no setup text yet). */
export const CONNECT_HARNESS_IDS = ['claude-code', 'cursor', 'codex', 'gemini', 'vscode', 'generic'] as const;

/** The kagent runtime names, in one wording for the card and the deploy messages (C15 FR-4). */
export const KAGENT_RUNTIME_LABELS = { kagent: 'kagent (ADK)', claude: 'Claude Code', codex: 'Codex', byo: 'Own image' } as const satisfies Record<'kagent' | 'claude' | 'codex' | 'byo', string>;

export function harnessById(id: string): HarnessEntry | undefined {
  return HARNESS_REGISTRY.find((entry) => entry.id === id);
}

/** Whether Landflow accepts status events from this harness (its strategy sends them and the entry lists them). */
export function sendsEvents(entry: HarnessEntry): boolean {
  return entry.strategy !== 'mcp-only' && Boolean(entry.hookEvents);
}

/**
 * What `eventName` does to a session. `undefined`: the entry does not list the name (ingest stores it and counts it);
 * `keep`: it lists the name but no rule matches this payload (a `Notification` of another type).
 */
export function statusFor(entry: HarnessEntry, eventName: string, payload: Record<string, unknown>): StatusVerdict | undefined {
  const rules = entry.hookEvents && Object.prototype.hasOwnProperty.call(entry.hookEvents, eventName) ? entry.hookEvents[eventName] : undefined;
  if (!rules) return undefined;
  for (const rule of Array.isArray(rules) ? rules : [rules]) {
    if (!rule.when || payload[rule.when.field] === rule.when.equals) return rule.status;
  }
  return 'keep';
}
