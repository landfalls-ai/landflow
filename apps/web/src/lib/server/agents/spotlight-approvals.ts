/**
 * AG23: Spotlight approves its test runs' tool calls to given destinations (docs/agents.md#spotlight-approves-its-own-test-runs).
 *
 * The person's decision of 2026-11-18: "We can let Spotlight approve automatically when he's fixing." In an autonomous fix
 * session's editor run (the run body's `approvals: 'spotlight'`), a Run an Agent step lets Spotlight decide a call that asks first:
 * the call runs when every destination it reaches was already given (the agent's saved config, the flow, the person's words:
 * `spotlightMayApprove`); otherwise it is left for the person. A destination that is an expression or cannot be read is never given.
 */
import type { Workflow } from '@landflow/engine';
import type { ApprovalBy } from '../../shared/fix-autonomy';
import { normalDestination, spotlightMayApprove } from '../../shared/fix-autonomy';
import type { AgentConfig } from '../../shared/agents';
import { destinationsOf, hostOf, isUnreadHost, writesOutside } from '../../shared/run-check';

/** What an execution record carries for a Spotlight test run (`ExecutionRecord.spotlightApprovals`). */
export interface SpotlightRun {
  userId: string;
  sessionId: string;
  destinations: string[];
}

/** What the runtime needs to decide one run's calls as Spotlight. */
export interface SpotlightApprovals {
  by: ApprovalBy;
  given: string[];
  /** Whether a call Spotlight leaves can wait for the person in the editor (else it is refused, never run). */
  canWait: boolean;
}

/** What a destination reads as when its value is an expression, an unreadable address or empty: never given. */
export const NOT_GIVEN = '{{ … }}';

const isExpression = (text: string) => /\{\{|\$fromAI|^\s*=/.test(text);

/** The addresses in a comma- or semicolon-separated list (`Jane <jane@x.test>, bob@x.test`), lower-cased; an expression is NOT_GIVEN. */
export function addressesOf(value: unknown): string[] {
  if (typeof value !== 'string' || !value.trim()) return [];
  if (isExpression(value)) return [NOT_GIVEN];
  return value
    .split(/[,;]/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const angle = /<([^<>\s]+@[^<>\s]+)>/.exec(part);
      const address = (angle ? angle[1] : part).trim();
      return /^[^\s@/]+@[^\s@/]+$/.test(address) ? address.toLowerCase() : NOT_GIVEN;
    });
}

/**
 * Where a node call goes, from the parameters it runs with: an email's To, CC and BCC; an HTTP call's URL; a channel or chat id;
 * else `<type> <operation>` (the `destinationsOf` form). Empty when the call reaches nothing outside (a read).
 */
export function callDestinations(nodeType: string | undefined, parameters: Record<string, unknown>): string[] {
  const type = nodeType ?? '';
  const options = parameters.options && typeof parameters.options === 'object' ? (parameters.options as Record<string, unknown>) : {};
  const out: string[] = [];
  if (type === 'core.httpRequest') {
    const url = String(parameters.url ?? '');
    const host = hostOf(url);
    if (isUnreadHost(host) || isExpression(url) || !/^[a-z][a-z0-9+.-]*:\/\//i.test(url.trim())) return [NOT_GIVEN];
    return [normalDestination(url)];
  }
  for (const key of ['toEmail', 'to']) if (typeof parameters[key] === 'string' && (key === 'toEmail' || /email|mail/i.test(type))) out.push(...addressesOf(parameters[key]));
  out.push(...addressesOf(options.ccEmail ?? parameters.ccEmail), ...addressesOf(options.bccEmail ?? parameters.bccEmail));
  for (const key of ['channel', 'chatId', 'channelId']) {
    const value = parameters[key];
    if (typeof value === 'string' && value.trim()) out.push(isExpression(value) ? NOT_GIVEN : `${type} ${key} ${value.trim().toLowerCase()}`);
  }
  if (out.length) return out;
  const step = { type, parameters };
  if (!writesOutside(step)) return [];
  const [sent] = destinationsOf([{ name: '', ...step }]);
  return sent ? [sent.destination] : [];
}

/** The destinations an agent's own saved config fixes: each asks-first node tool's fixed To, CC, BCC, URL or channel (never an expression). */
export function agentDestinations(config: Pick<AgentConfig, 'tools'>): string[] {
  const given: string[] = [];
  for (const tool of config.tools) {
    if (tool.type !== 'node' || !tool.requireApproval) continue;
    given.push(...callDestinations(tool.nodeType, tool.parameters).filter((d) => d !== NOT_GIVEN));
  }
  return given;
}

/** The destinations the flow's own sending steps fix (`destinationsOf` on the run's graph, and their addresses). */
export function flowDestinations(workflow: Pick<Workflow, 'nodes'>): string[] {
  const given: string[] = [];
  for (const node of workflow.nodes) {
    if (node.disabled) continue;
    const step = { name: node.name ?? node.id, type: node.type, parameters: (node.parameters ?? {}) as Record<string, unknown> };
    given.push(...callDestinations(step.type, step.parameters), ...destinationsOf([step]).map((d) => d.destination));
  }
  return given.filter((d) => d !== NOT_GIVEN && !isUnreadHost(d));
}

/** Spotlight's verdict on one held call: it may approve it, or it is left for the person. */
export function spotlightVerdict(callDestinationList: readonly string[], given: readonly string[]): 'approve' | 'leave' {
  if (callDestinationList.includes(NOT_GIVEN) || callDestinationList.some(isUnreadHost)) return 'leave';
  return spotlightMayApprove({ destinations: callDestinationList }, given.filter((d) => d !== NOT_GIVEN)) ? 'approve' : 'leave';
}
