/**
 * Whether a test run passed, for Spotlight's "Test and fix" (docs/assistant.md): Spotlight runs the workflow and, while
 * a run doesn't pass, asks the assistant for a fix. A run passes when it succeeded, no node failed, and items reached
 * the end of the flow. A run where every branch ended with no items stopped somewhere, which is a bug more often than not.
 */

export interface CheckedNode {
  id: string;
  name: string;
  /** Attached to an agent as its model, memory or a tool: not a step of the flow. */
  sub: boolean;
}

export interface CheckedRun {
  nodes: CheckedNode[];
  /** Main connections. */
  edges: Array<{ source: string; target: string }>;
  /** Node id → its run: the error, or how many items it put out. Nodes that didn't run are missing. */
  ran: Record<string, { error?: string; items: number }>;
  /** How the execution ended (success, error, canceled, waiting). */
  status?: string;
  error?: string;
}

/** `node`: where it went wrong (when one node did), or, on a pass, the last step that put out items. */
export type RunVerdict = { passed: boolean; node?: string; summary: string };

export function checkRun(run: CheckedRun): RunVerdict {
  const failed = run.nodes.find((n) => !n.sub && run.ran[n.id]?.error) ?? run.nodes.find((n) => run.ran[n.id]?.error);
  if (failed) return { passed: false, node: failed.name, summary: `failed at “${failed.name}”: ${run.ran[failed.id].error}` };
  if (run.status !== 'success') return { passed: false, summary: `ended with ${run.status ?? 'no result'}${run.error ? `: ${run.error}` : ''}` };
  const steps = run.nodes.filter((n) => !n.sub && run.ran[n.id]);
  // Where each branch stopped: a node that ran and none of whose next nodes did.
  const ends = steps.filter((n) => !run.edges.some((e) => e.source === n.id && run.ran[e.target]));
  const reached = ends.filter((n) => run.ran[n.id].items > 0);
  if (ends.length && !reached.length) return { passed: false, node: ends[0].name, summary: `“${ends[0].name}” put out no items, so nothing reached the end of the flow` };
  const items = reached.reduce((sum, n) => sum + run.ran[n.id].items, 0);
  const last = reached.at(-1)?.name;
  return { passed: true, ...(last && { node: last }), summary: `${steps.length} step${steps.length === 1 ? '' : 's'}${last ? `, ${items} item${items === 1 ? '' : 's'} reached “${last}”` : ''}` };
}

export interface CheckedStep {
  name: string;
  type: string;
  parameters: Record<string, unknown>;
}

const listOf = (value: unknown, key: string) => {
  const list = value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
  return Array.isArray(list) ? list : [];
};

/**
 * Steps that run without an error but do nothing: an If or Filter with no conditions (it keeps every item), a Set in
 * manual mode with no fields. A drafted flow often has them, and a run that "passes" through them doesn't do the job.
 */
export function hollowSteps(steps: CheckedStep[]): Array<{ node: string; problem: string }> {
  return steps.flatMap((step) => {
    const p = step.parameters;
    if ((step.type === 'core.filter' || step.type === 'core.if') && 'conditions' in p && !listOf(p.conditions, 'condition').length) {
      return [{ node: step.name, problem: `“${step.name}” has no conditions, so it keeps every item` }];
    }
    if (step.type === 'core.set' && (p.mode ?? 'manual') === 'manual' && 'fields' in p && !listOf(p.fields, 'values').length) {
      return [{ node: step.name, problem: `“${step.name}” sets no fields` }];
    }
    return [];
  });
}

/**
 * A Code node in "each" mode runs once per item and returns that item's result. When it puts out several items for each
 * one it got (10 in, 100 out), its code worked on all the items every time (`items` rather than `$json`): the run
 * passes, but every result comes out many times over.
 */
export function multipliedSteps(run: CheckedRun, steps: Array<CheckedStep & { id: string }>): Array<{ node: string; problem: string }> {
  return steps.flatMap((step) => {
    if (step.type !== 'core.code' || step.parameters.mode !== 'each') return [];
    const out = run.ran[step.id]?.items ?? 0;
    const got = run.edges.filter((e) => e.target === step.id).reduce((sum, e) => sum + (run.ran[e.source]?.items ?? 0), 0);
    if (got < 2 || out < got * 2) return [];
    return [{ node: step.name, problem: `“${step.name}” runs once per item but put out ${out} items from ${got}, so its code handles every item each time: use mode “all” to work on all items at once, or return only this item’s result` }];
  });
}

/** Something only a person can give the flow, read from a failed run's error. */
// SB03: 'blocked' (the host's outbound policy refused the destination).
export type PersonNeed = 'credential' | 'agent' | 'trigger' | 'blocked';

/**
 * A failed run that a fix can't help: a credential that isn't picked or is refused, an agent or team that isn't chosen,
 * a flow with nothing to start it. Spotlight asks the person instead of spending its fixes (docs/assistant.md#test-and-fix).
 */
export function needsPerson(error: string | undefined): PersonNeed | undefined {
  if (!error) return undefined;
  // SB03: a policy block is the person's (or an admin's) to resolve, and it is not a credential problem even as a 403.
  if (/^\s*Blocked: |OutboundBlockedError|\bBlocked: \S+ resolves to /.test(error)) return 'blocked';
  if (/no start node|no trigger/i.test(error)) return 'trigger';
  if (/no (agent|team) (selected|chosen|picked)|agentId is required|teamId is required|pick an agent|pick a team/i.test(error)) return 'agent';
  if (/credential/i.test(error) && /no |not |missing|select|choose|pick/i.test(error)) return 'credential';
  if (/\b(401|403)\b|unauthori[sz]ed|invalid[_ ]auth|not_authed|invalid api key|api key (is )?(missing|invalid)|authentication failed|forbidden/i.test(error)) return 'credential';
  return undefined;
}

/** The same failure with numbers, ids and quotes taken out: a fix that left it unchanged didn't help. */
export const sameFailure = (summary: string) =>
  summary
    .toLowerCase()
    .replace(/[0-9a-f]{8,}|\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim();

/** Whether a test run of this step sends or changes things outside the flow (the heuristic of `sendingSteps`). */
function sends(step: CheckedStep): boolean {
  const writes = /^(send|post|create|update|delete|remove|upload|write|publish|comment|add|merge|archive|reply|invite|insert|upsert|append|move|close|assign|execute|trigger)/i;
  const p = step.parameters;
  if (step.type === 'core.httpRequest') return String(p.method ?? 'GET').toUpperCase() !== 'GET';
  if (/email|smtp/i.test(step.type) && !/trigger|read/i.test(step.type)) return true;
  return typeof p.operation === 'string' && writes.test(p.operation);
}

/**
 * Steps that reach outside the flow when they run: an HTTP call that isn't a GET, or an app operation that sends,
 * posts, creates, changes or deletes. A test run executes them for real, so Spotlight asks first. A heuristic: a
 * node can read and still be listed, and one without an operation that writes isn't.
 */
export function sendingSteps(steps: CheckedStep[]): string[] {
  return steps.filter(sends).map((step) => step.name);
}

/**
 * Where each sending step reaches (SB03, contracts/sb1/needs-you.md): an HTTP Request's `host:port` (an expression host
 * is "{{ … }}", which always needs a yes) and, for an app node that writes, `<node type> <operation>`.
 */
export function destinationsOf(steps: CheckedStep[]): Array<{ node: string; destination: string }> {
  return steps.filter(sends).map((step) => {
    if (step.type === 'core.httpRequest') return { node: step.name, destination: hostOf(String(step.parameters.url ?? '')) };
    const operation = typeof step.parameters.operation === 'string' ? step.parameters.operation : '';
    return { node: step.name, destination: `${step.type}${operation ? ` ${operation}` : ''}` };
  });
}

/** What a destination is called when its host is an expression or a URL that cannot be read: it asks before every run. */
export const UNREAD_HOST = '{{ … }}';
/** What an empty URL is called: not a destination to say yes to, but something to fill in (a Needs-you row). */
export const NO_ADDRESS = 'an address not filled in yet';

/**
 * The host of a plain-text URL, parsed as the fetch would read it (`new URL`): `host` is `host:port` (the port only when it
 * is not the scheme's own), `hostname` the name alone. `'unreadable'` for a URL with a backslash (browsers read `\` as `/`,
 * so "https://evil.com\@good.com/" goes to evil.com, but a person never means that), an expression in the host, or one that
 * does not parse. `undefined` when the text names no URL at all.
 */
/** `lastAtOutside` said the last "@" sits inside an expression: the host cannot be told. */
export const AT_IN_EXPRESSION = -2;

/** The index of the last "@" of `text` that is outside `{{ }}`; -1 when there is none, `AT_IN_EXPRESSION` when the last "@" is inside one. */
export function lastAtOutside(text: string): number {
  let inside = false;
  let last = -1;
  let lastInside = false;
  for (let i = 0; i < text.length; i++) {
    if (!inside && text.startsWith('{{', i)) (inside = true, i++);
    else if (inside && text.startsWith('}}', i)) (inside = false, i++);
    else if (text[i] === '@') (last = i, lastInside = inside);
  }
  return lastInside ? AT_IN_EXPRESSION : last;
}

/** Strips an n8n-style "=" in front of an expression value (with the space around it). */
export const withoutEquals = (value: string) => value.trim().replace(/^=\s*/, '');

export function urlHost(value: string): { host: string; hostname: string; expression?: true } | 'unreadable' | undefined {
  const text = withoutEquals(value);
  if (!text || /^\/(?!\/)/.test(text)) return undefined; // a path: no host ("//host/x" is a protocol-relative URL)
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text);
  if (text.includes('\\')) return 'unreadable';
  const afterScheme = hasScheme ? text.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '') : text.replace(/^\/\//, '');
  const authority = /^[^/?#]*/.exec(afterScheme)![0];
  let readable = text;
  let userinfoExpression = false;
  if (authority.includes('{{')) {
    // An expression in the user name ("{{ user }}@evil.com"): the host is what follows the last "@", when that is literal.
    // The host can still move at run time ("/", "?", "#" or "@" in the value), so it is shown but asks every run.
    const at = lastAtOutside(authority);
    if (at < 0 || authority.slice(at + 1).includes('{{')) return 'unreadable';
    readable = `http://${afterScheme.slice(at + 1)}`;
    userinfoExpression = true;
  } else if (text.startsWith('//')) readable = `http:${text}`;
  try {
    const url = new URL(readable === text && !hasScheme ? `http://${text}` : readable);
    return url.host ? { host: url.host, hostname: url.hostname, ...(userinfoExpression && { expression: true as const }) } : 'unreadable';
  } catch {
    return hasScheme ? 'unreadable' : undefined;
  }
}

/** `host:port` of a URL; "{{ … }}" when the host is an expression or the URL cannot be read, `NO_ADDRESS` when it is empty. */
export function hostOf(url: string): string {
  if (!withoutEquals(url)) return NO_ADDRESS;
  const parsed = urlHost(url);
  if (parsed && parsed !== 'unreadable') return parsed.expression ? `${parsed.host}${UNREAD_HOST}` : parsed.host;
  // What is literal in front of the expression stays visible ("evil.com{{ … }}"), so the person sees where it may go.
  const literal = withoutEquals(url).replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split('{{')[0];
  const shown = url.includes('{{') && !literal.includes('\\') ? /^[^/?#\s]*/.exec(literal)![0].slice(0, 60) : '';
  return `${shown}${UNREAD_HOST}`;
}

/** What a card says after a yes to a sending test: an expression destination's yes covers the next run only. */
export function yesText(destinations: readonly string[] | undefined): string {
  if (destinations?.some(isUnreadHost)) return `You said yes for the next run only: it runs for real to ${destinations.join(', ')}, and the next test asks again.`;
  return `You said yes: tests of this workflow run for real${destinations?.length ? ` to ${destinations.join(', ')}` : ''}.`;
}

/** Whether a destination is an expression or an unreadable URL ("{{ … }}", maybe with its literal start): it asks every run. */
export const isUnreadHost = (destination: string) => destination.endsWith(UNREAD_HOST);

/** What a person gives that a fix may not change: a URL, an email address, a channel, an id. */
const GIVEN_VALUE = /^(?:https?:\/\/\S+|\S+@\S+\.\S+|[#@][\w.-]+|[\w-]{8,})$/i;
/** A bare word is a given value only when it looks like an id: a digit, an underscore or dash, or mixed case. */
const idLike = (value: string) => !/^[\w-]{8,}$/.test(value) || /\d|[_-]|(?=.*[a-z])(?=.*[A-Z])/.test(value);

/**
 * Why a session's fix must not be applied: it removes a step the request names, or changes a URL, address, channel or
 * id the person gave (SB03). Pure, so the session (client) and the chat (server) share it. `nodes` is the workflow
 * before the fix; `given` is what the person wrote (the goal, the description, their messages).
 */
export function givenKept(
  ops: ReadonlyArray<{ op: string; node?: string; parameters?: Record<string, unknown>; settings?: object }>,
  nodes: ReadonlyArray<{ id: string; name: string; parameters: Record<string, unknown> }>,
  given: string,
): string | undefined {
  if (!given.trim()) return undefined;
  const text = given.toLowerCase();
  const find = (ref: string | undefined) => (ref ? nodes.find((n) => n.name === ref || n.id === ref) : undefined);
  for (const op of ops) {
    const node = find(op.node);
    if (!node) continue;
    if (op.op === 'removeNode' && node.name.trim().length >= 3 && text.includes(node.name.trim().toLowerCase())) {
      return `the fix wanted to remove “${node.name}”, which you asked for.`;
    }
    if (op.op === 'setNodeSettings' && (op.settings as { disabled?: boolean } | undefined)?.disabled === true && node.name.trim().length >= 3 && text.includes(node.name.trim().toLowerCase())) {
      return `the fix wanted to turn off “${node.name}”, which you asked for.`;
    }
    if (op.op === 'setParameters' && op.parameters) {
      for (const [key, next] of Object.entries(op.parameters)) {
        const current = node.parameters[key];
        if (typeof current !== 'string') continue;
        const value = current.trim().replace(/^=(?=https?:)/i, '');
        if (!GIVEN_VALUE.test(value) || !idLike(value) || JSON.stringify(next) === JSON.stringify(current)) continue;
        if (text.includes(value.toLowerCase())) return `the fix wanted to change ${key} of “${node.name}” from ${value}, which you gave.`;
      }
    }
  }
  return undefined;
}
