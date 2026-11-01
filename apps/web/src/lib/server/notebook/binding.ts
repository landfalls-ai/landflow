/**
 * Which run a Claude Code member's note belongs to (docs/team-notebook.md#claude-code-members-on-kagent).
 *
 * A Landflow agent's notebook tools are built for one team, run and member, so they cannot write anywhere else. A Claude
 * Code member on kagent reaches the same tools over MCP, at the endpoint of the Landflow agent it is deployed from
 * (kagent/mcp.ts), and that endpoint serves every run of every team the agent is in. So the run is bound from the other end:
 * while the team runtime has a call in flight to a remote member, it registers an *open call* here, keyed by the member's
 * A2A address, holding the team, run and member it is made for. A note tool call on the agent's MCP endpoint then finds the
 * open calls of the agent it was made to:
 *
 * - exactly one: the note lands on that call's run, as that call's member;
 * - none: the call is refused (the notebook is only open while a team has asked the agent something);
 * - several (two runs asking the same agent at once): the call must name its run with the `run` argument, a key the
 *   request told the agent, and is refused without it. A note never lands on a guess.
 *
 * The registry lives in this process and an open call ends with the request, so a note arriving after the member answered
 * is refused too.
 */
import { randomBytes } from 'node:crypto';
import type { Agent } from '../../shared/agents';
import { agentStore } from '../agents/store';
import { singleton } from '../singleton';
import type { NotebookBinding } from './service';

export interface OpenCall {
  key: string;
  /** The member's A2A address, as the team calls it. */
  endpoint: string;
  binding: NotebookBinding;
  /** The span of the request in the Run Trace: notes made during it point there. */
  spanId?: string;
  /** Names of the tools the member used so far in this request (from the mod's trace), to spot a page it read. */
  tools: string[];
  openedAt: number;
}

const calls = () => singleton('notebook-open-calls', () => new Map<string, OpenCall>());
const trimmed = (url: string) => url.trim().replace(/\/+$/, '');

/** Whether `agent` (deployed to kagent) is what the A2A address calls: its stored address, else the kagent name the address ends with. */
export function agentMatchesEndpoint(agent: Agent, endpoint: string): boolean {
  if (!agent.kagent) return false;
  const url = trimmed(endpoint);
  const stored = agent.kagent.trace?.a2aUrl;
  if (stored && trimmed(stored) === url) return true;
  const name = /\/agents\/[^/]+\/([^/?#]+)$/.exec(url)?.[1];
  return Boolean(name) && decodeURIComponent(name!) === agent.kagent.name;
}

/** The Landflow agent on kagent that an A2A address calls, when one does (and exactly one: a name two agents share is no binding). */
export function agentAtEndpoint(endpoint: string): Agent | undefined {
  const matches = agentStore.list().filter((agent) => agentMatchesEndpoint(agent, endpoint));
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * Register a call in flight to a remote member. `close` ends it (always: in a `finally`); `used` tells it which tools the
 * member has used, as its steps arrive.
 */
export function openNotebookCall(endpoint: string, binding: NotebookBinding, spanId?: string): { key: string; close(): void; used(names: string[]): void } {
  const key = `nbk_${randomBytes(6).toString('base64url')}`;
  const call: OpenCall = { key, endpoint: trimmed(endpoint), binding, ...(spanId && { spanId }), tools: [], openedAt: Date.now() };
  calls().set(key, call);
  return {
    key,
    close: () => void calls().delete(key),
    used: (names) => void (call.tools = names),
  };
}

/** The open calls made to this agent. */
export const openCallsFor = (agent: Agent): OpenCall[] => [...calls().values()].filter((call) => agentMatchesEndpoint(agent, call.endpoint));

export type Resolved = { call: OpenCall } | { error: string };

/** The call a note tool's MCP request belongs to (see the file comment): one open call, or the one named by `key`. */
export function resolveCall(agent: Agent, key?: string): Resolved {
  const open = openCallsFor(agent);
  if (key?.trim()) {
    const named = open.find((call) => call.key === key.trim());
    return named ? { call: named } : { error: `The run key ${key.trim()} is not open on this agent: use the one in the request you were given` };
  }
  if (open.length === 1) return { call: open[0] };
  if (!open.length) return { error: 'No team run is using this agent right now, so there is no notebook to write to. The notebook tools only work while a team has asked you something' };
  return { error: `${open.length} team runs are asking this agent at once: pass "run" with the notebook run key from your request (${open.map((call) => call.key).join(', ')}) so the note lands on the right run` };
}

/** Whether a team (draft or published) calls this agent as a remote member: its notebook tools are exposed on kagent. */
export function isTeamMember(agent: Agent, members: Array<{ kind: string; parameters?: Record<string, unknown> }>): boolean {
  return members.some((m) => m.kind === 'a2a' && typeof m.parameters?.agentUrl === 'string' && agentMatchesEndpoint(agent, m.parameters.agentUrl));
}

/** For tests. */
export function resetCalls() {
  calls().clear();
}
