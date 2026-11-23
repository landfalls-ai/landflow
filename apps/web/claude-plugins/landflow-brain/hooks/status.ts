/**
 * Opt-in status sharing (docs/landflow-brain-mod.md#status-sharing, C04): while the person has turned it on, a session in a
 * listed repository tells Landflow its status as the Claude Code hook an event stands for, so /connect and the person's own
 * view show Thinking, Working, Idle. The body holds the hook name, a session id, the repository (a listed one only) and, for
 * a tool, its name. Never prompt text, tool input or output, a path or the working directory. Pure: the sending is in register.ts.
 */
import type { Config } from './client'

/** The mod events that report, and the Claude Code hook name each stands for (the names the registry maps to a status). */
export const STATUS_HOOKS = {
  'session.start': 'SessionStart',
  'prompt.submit': 'UserPromptSubmit',
  'tool.before': 'PreToolUse',
  'tool.after': 'PostToolUse',
  'turn.complete': 'Stop',
  'session.end': 'SessionEnd',
} as const
export type StatusEvent = keyof typeof STATUS_HOOKS

/** Off unless the stored value is exactly `true` (written by `/brain status-sharing on`). */
export const sharingOn = (stored: unknown): boolean => stored === true

/** `on` or `off` from the command's argument; anything else is not a choice. */
export function parseSharing(arg: string): 'on' | 'off' | undefined {
  const word = arg.trim().toLowerCase()
  return word === 'on' || word === 'off' ? word : undefined
}

export interface StatusFacts {
  sessionId: string
  /** `owner/name`, only for a repository the person listed. */
  repository?: string
  /** The tool's name, for a tool event. */
  tool?: string
}

/** The JSON body for one event: built field by field, so nothing else can ride along. */
export function statusBody(event: StatusEvent, facts: StatusFacts): Record<string, string> {
  return {
    hook_event_name: STATUS_HOOKS[event],
    session_id: facts.sessionId,
    ...(facts.repository && { repository: facts.repository }),
    ...((event === 'tool.before' || event === 'tool.after') && facts.tool && { tool_name: facts.tool }),
  }
}

/** The request to send: the hook route, the key, and an order number (events go out on their own connections, so each carries its own). */
export function statusRequest(config: Config, body: Record<string, string>, seq: number) {
  return {
    url: `${config.url}/api/harness/claude-code/hooks`,
    init: { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${config.key}`, 'x-landflow-hook-seq': String(seq) }, body: JSON.stringify(body) },
  }
}
