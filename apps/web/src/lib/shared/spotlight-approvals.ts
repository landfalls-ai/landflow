/**
 * AG23: Spotlight approves its test runs' tool calls to given destinations (docs/agents.md#spotlight-approves-its-own-test-runs).
 *
 * The person's decision of 2026-11-18: "We can let Spotlight approve automatically when he's fixing." In an autonomous fix
 * session's editor run (the run body's `approvals: 'spotlight'`), a Run an Agent step lets Spotlight decide a call that asks first:
 * the call runs when every destination it reaches was already given (the agent's saved config, the flow, the person's words:
 * `spotlightMayApprove`); otherwise it is left for the person. A destination that is an expression or cannot be read is never given.
 */
import type { Workflow } from '@landflow/engine';
import type { ApprovalBy } from './fix-autonomy';
import { normalDestination, spotlightMayApprove } from './fix-autonomy';
import type { AgentConfig } from './agents';
import { destinationsOf, hostOf, isUnreadHost, writesOutside } from './run-check';

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
export function callDestinations(nodeType: string | undefined, parameters: Record<string, unknown>, opts: { fallback?: boolean } = {}): string[] {
  const fallback = opts.fallback ?? true;
  const type = nodeType ?? '';
  const options = parameters.options && typeof parameters.options === 'object' ? (parameters.options as Record<string, unknown>) : {};
  const out: string[] = [];
  if (type === 'core.httpRequest') {
    const url = String(parameters.url ?? '');
    const host = hostOf(url);
    if (isUnreadHost(host) || isExpression(url) || !/^[a-z][a-z0-9+.-]*:\/\//i.test(url.trim())) return [NOT_GIVEN];
    return [normalDestination(url)];
  }
  // Recipient fields are read on any messaging type (`to`, `recipient*`, `sendTo`, phone numbers), not only email.
  const messaging = /email|mail|sms|twilio|whatsapp|telegram|slack|message|phone|call|chat|teams|discord/i.test(type);
  for (const [key, value] of Object.entries(parameters)) {
    if (typeof value !== 'string' || !value.trim()) continue;
    const recipient = key === 'toEmail' || (messaging && /^(to|sendTo|recipient\w*|\w*phone\w*|toNumber|toPhone)$/i.test(key));
    if (!recipient) continue;
    if (isExpression(value)) out.push(NOT_GIVEN);
    else if (key === 'toEmail' || /@/.test(value)) out.push(...addressesOf(value));
    else out.push(`${type} ${key} ${value.trim().toLowerCase()}`);
  }
  out.push(...addressesOf(options.ccEmail ?? parameters.ccEmail), ...addressesOf(options.bccEmail ?? parameters.bccEmail));
  for (const key of ['channel', 'chatId', 'channelId']) {
    const value = parameters[key];
    if (typeof value === 'string' && value.trim()) out.push(isExpression(value) ? NOT_GIVEN : `${type} ${key} ${value.trim().toLowerCase()}`);
  }
  if (out.length) return out;
  if (!fallback) return [];
  // AG23 (ag5 fix pass): a call Spotlight decides never reads "no destination found" as "approve": the stand-in is the
  // `destinationsOf` form whether or not `writesOutside` calls the operation a write (a GitHub commit, a Landfall declare).
  const operation = typeof parameters.operation === 'string' ? parameters.operation : '';
  return [`${type}${operation ? ` ${operation}` : ''}`];
}

/**
 * The destinations an agent's own saved config fixes: each asks-first node tool's fixed To, CC, BCC, URL, channel or recipient
 * (never an expression, never the `<type> <operation>` stand-in: a write that names no address is not given by being configured).
 */
export function agentDestinations(config: Pick<AgentConfig, 'tools'>): string[] {
  const given: string[] = [];
  for (const tool of config.tools) {
    if (tool.type !== 'node' || !tool.requireApproval) continue;
    given.push(...callDestinations(tool.nodeType, tool.parameters, { fallback: false }).filter((d) => d !== NOT_GIVEN));
  }
  return given;
}

/** The destinations the flow's own sending steps fix (their concrete addresses and HTTP hosts; never the `<type> <operation>` stand-in). */
export function flowDestinations(workflow: Pick<Workflow, 'nodes'>): string[] {
  const given: string[] = [];
  for (const node of workflow.nodes) {
    if (node.disabled) continue;
    const step = { name: node.name ?? node.id, type: node.type, parameters: (node.parameters ?? {}) as Record<string, unknown> };
    if (!writesOutside(step)) continue; // a read (an HTTP GET, a Slack lookup) gives nothing
    // Concrete addresses only: a call that can only be named `<type> <operation>` is given by the person's destinations, never by the flow.
    given.push(...callDestinations(step.type, step.parameters, { fallback: false }));
    if (step.type === 'core.httpRequest') given.push(...destinationsOf([step]).map((d) => d.destination));
  }
  return given.filter((d) => d !== NOT_GIVEN && !isUnreadHost(d));
}

/** A stand-in with no operation: `<plugin>.<node>` with no scheme, address, space or port (what `callDestinations` gives a call that names nothing). */
const isStandIn = (d: string): boolean => /^[a-z][a-z0-9-]*\.[A-Za-z][A-Za-z0-9]*$/.test(d.trim()) && !/^(?:https?|ftp)$/i.test(d);

/** Spotlight's verdict on one held call: it may approve it, or it is left for the person. */
export function spotlightVerdict(callDestinationList: readonly string[], given: readonly string[]): 'approve' | 'leave' {
  if (callDestinationList.includes(NOT_GIVEN) || callDestinationList.some(isUnreadHost)) return 'leave';
  const known = given.filter((d) => d !== NOT_GIVEN);
  // A stand-in with no operation (`databases.postgres`) is a plain name, never a host: it is compared as written, so a URL on a host of that name does not give it.
  const plain = new Set(known.filter(isStandIn).map((d) => d.trim().toLowerCase()));
  const real = callDestinationList.filter((d) => !isStandIn(d));
  if (!callDestinationList.filter(isStandIn).every((d) => plain.has(d.trim().toLowerCase()))) return 'leave';
  return spotlightMayApprove({ destinations: real }, known.filter((d) => !isStandIn(d))) ? 'approve' : 'leave';
}

/**
 * The destinations Spotlight judges for one call of a tool: what the tool reports, and never an empty list (a tool that reports
 * none, errors, or finds nothing is read as a destination nobody gave, so the call waits: no destination never means approve).
 */
export async function spotlightDestinations<C>(
  tool: { destinationsOf?(input: Record<string, unknown>, ctx: C): Promise<string[]> },
  input: Record<string, unknown>,
  ctx: C,
): Promise<string[]> {
  const found = tool.destinationsOf ? await tool.destinationsOf(input, ctx).catch(() => [NOT_GIVEN]) : [NOT_GIVEN];
  return found.length ? found : [NOT_GIVEN];
}
