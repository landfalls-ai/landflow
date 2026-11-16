/**
 * The pure guards of the builder chat (chat.ts re-exports them): they clean what a model sent (ops, ids, tool calls
 * written into text) and what it said (narration, repeats, claims that a change was applied). No state, no model calls.
 */
import type { ToolCall } from '@landflow/engine';
import type { AssistantOp } from '@/lib/shared/assistant-ops';
import { withAgentId, type AgentBrief } from '@/lib/shared/agent-brief';
import { withTeamId, type TeamBrief } from '@/lib/shared/agent-teams';
import { AT_IN_EXPRESSION, givenKept, lastAtOutside, urlHost, withoutEquals } from '@/lib/shared/run-check';
import type { PropertyDescriptor, Workflow } from '@/lib/shared/types';

const shorten = (value: string, max = 60) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);

/** The ops argument as the model sent it: an array, or a JSON string of one. */
/** The ops a model sent: an array, a single op, JSON text of either, or a wrapper with `ops` (local models vary). */
export function opsArgument(value: unknown): unknown {
  let ops = value;
  if (typeof ops === 'string') {
    try {
      ops = JSON.parse(ops);
    } catch {
      return [];
    }
  }
  if (ops && typeof ops === 'object' && !Array.isArray(ops)) {
    const one = ops as Record<string, unknown>;
    if (Array.isArray(one.ops)) return one.ops;
    if (typeof one.op === 'string') return [one];
  }
  return ops;
}
const REF_FIELDS = ['from', 'to', 'after', 'before', 'node'] as const;
/**
 * Ops with the refs of nodes added by earlier proposals in this reply written as those nodes' names: refs live inside one
 * proposal, but models keep using them ("connect Tech Lead → run_report" after proposing `run_report`).
 */
export function withEarlierRefs(ops: unknown, refs: Map<string, string>): unknown {
  if (!Array.isArray(ops) || !refs.size) return ops;
  const record = (op: unknown) => (op && typeof op === 'object' && !Array.isArray(op) ? (op as Record<string, unknown>) : undefined);
  const own = new Set(ops.flatMap((op) => (typeof record(op)?.ref === 'string' ? [record(op)!.ref as string] : [])));
  return ops.map((op) => {
    const fields = record(op);
    if (!fields) return op;
    const next = { ...fields };
    for (const field of REF_FIELDS) {
      const value = next[field];
      if (typeof value === 'string' && !own.has(value) && refs.has(value)) next[field] = refs.get(value);
    }
    return next;
  });
}


/** The chat's tool names: what a tool call recovered from text may name. */
export const TOOL_NAMES: ReadonlySet<string> = new Set(['search_nodes', 'get_node_docs', 'get_workflow', 'get_run_data', 'propose_changes']);

// SB02: ids, and the destinations (a channel, a table, an owner, an address, a URL) a person names; a model makes both up.
const ID_PARAMETER = /^id$|[a-z]Ids?$/;
const DESTINATION_PARAMETER = /^(channel|table|owner|repository|repo|email|to|cc|team|project|board|sheet)$/;
const URL_PARAMETER = /^(url|baseUrl|webhookUrl)$/;

const KIND = 'table|channel|sheet|repo|repository|project|board|team';

/**
 * Whether a plain word ("bugs") the person's text merely contains was named as that destination: a word like that is in
 * most asks ("get the new bugs … save each bug to a table"), so it counts only after a naming cue or in quotes.
 * A value with a "#", "@", ".", "/", "_", "-" or a digit is specific enough that finding it is the answer. The word for the
 * kind ("channel") and the app's own name (`app`: "slack" for "post it to Slack") are never a name.
 */
function namedAs(value: string, known: string, app: readonly string[] = []): boolean {
  if (/[#@./_\-\d]/.test(value) || !/^[\w ]+$/.test(value)) return known.toLowerCase().includes(value.toLowerCase());
  // The word for the kind of thing ("channel") or the app's own name ("slack" for "post it to Slack") is no name of one.
  if (new RegExp(`^(?:${KIND})$`, 'i').test(value.trim()) || app.includes(value.trim().toLowerCase())) return false;
  const word = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const kind = KIND;
  const quote = '["\'“‘`]';
  const cue = `(?:called|named|${kind}|owner|into|in|to|on|at|by|with|as)`;
  return [
    `${quote}${word}${quote}`,
    `\\b${cue}\\s+(?:(?:the|a|an|our|my|your|this|that)\\s+)?["'“‘\`#@]?${word}\\b`,
    `\\b${word}\\s+(?:${kind})\\b`,
    `[/#@]${word}\\b`,
    `\\b${word}/`,
  ].some((pattern) => new RegExp(pattern, 'i').test(known));
}

/**
 * The type of the property `name` in a node type's properties JSON: the top-level property first (a nested one of the same
 * name, such as a collection's `to`, is another property); undefined when it has none.
 */
function propertyType(json: string, name: string): string | undefined {
  if (!json) return undefined;
  try {
    const list = JSON.parse(json) as unknown;
    const own = (items: unknown) => (Array.isArray(items) ? (items as Array<{ name?: string; type?: string }>).find((p) => p?.name === name && typeof p.type === 'string')?.type : undefined);
    const nested = (items: unknown): string | undefined => {
      if (!Array.isArray(items)) return undefined;
      for (const p of items as Array<{ values?: unknown; options?: unknown }>) {
        const inner = own(p?.values) ?? own(p?.options) ?? nested(p?.values) ?? nested(p?.options);
        if (inner) return inner;
      }
      return undefined;
    };
    return own(list) ?? nested(list);
  } catch {
    return undefined;
  }
}

/** Said of a URL's host that cannot be read: it is no host anybody gave. */
const UNREADABLE = 'an address that cannot be read';

/**
 * The host name of a URL a model wrote ("https://httpbin.org/post" → "httpbin.org"), parsed with `new URL`:
 * "https://evil.com#@good.com/" and "https://evil.com?@good.com/" are evil.com, as a fetch reads them. UNREADABLE for a
 * backslash ("https://evil.com\@good.com/") or a URL that does not parse; undefined when it names none.
 */
function hostOf(value: string): string | undefined {
  const parsed = urlHost(value);
  return parsed === 'unreadable' ? UNREADABLE : parsed?.hostname;
}

const hostNote = (key: string, node: unknown, host: string) => `${key} of “${String(node)}”: ${host === UNREADABLE ? 'an address that cannot be read' : `a host nobody gave (${host})`}, left for the user to fill in`;

/** Whether `text` names `host` as a whole host: "example.com" is not in "myexample.com" or "api.example.com". */
function mentionsHost(text: string, host: string): boolean {
  const escaped = host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^a-z0-9.-])${escaped}(?![a-z0-9-])`, 'i').test(text);
}

/**
 * The host a URL with expressions in it names in its literal start ("https://x.com/users/{{ $json.id }}" → "x.com"); undefined
 * when the value is a whole expression or the host itself is one (the literal part ends before the host does).
 */
function literalHostOf(raw: string): string | undefined {
  const value = withoutEquals(raw); // an n8n-style expression: "=https://…"
  const at = value.indexOf('{{');
  const prefix = value.slice(0, at);
  if (prefix.includes('\\')) return UNREADABLE;
  const rest = prefix.replace(/^\s*[a-z][a-z0-9+.-]*:\/\//i, '');
  const authority = /^[^/?#]*/.exec(rest)![0];
  const hostOfAuthority = (text: string) => {
    const parsed = urlHost(text);
    return parsed === 'unreadable' ? UNREADABLE : parsed?.hostname;
  };
  // An expression in the user name ("{{ user }}@evil.com", "user:{{ pw }}@evil.com"): the host is what follows the last "@".
  const whole = /^[^/?#]*/.exec(value.replace(/^\s*[a-z][a-z0-9+.-]*:\/\//i, ''))![0];
  const lastAt = lastAtOutside(whole);
  if (lastAt === AT_IN_EXPRESSION) return UNREADABLE; // an "@" inside an expression may be anything
  if (lastAt >= 0 && !whole.slice(lastAt + 1).includes('{{')) return hostOfAuthority(whole.slice(lastAt + 1));
  if (!authority) return undefined; // the whole host is an expression
  // A "/", "?" or "#" ended the authority before the expression: the host is all literal.
  if (authority.length < rest.length) return hostOfAuthority(authority);
  // The expression sits inside the authority. Part of the userinfo ("user:{{ pw }}@host", "{{ user }}@host"): the host is
  // what follows, not known here. A host that is cut short ("api.{{ env }}.com") is an expression's too.
  if (/^[^/?#]*@/.test(value.slice(at)) || /[@.\-_]$/.test(authority)) return undefined;
  // A port ("evil.com:{{ $json.port }}") is judged by the host in front of it.
  if (authority.endsWith(':')) return hostOfAuthority(authority.slice(0, -1));
  // A literal host followed straight by an expression ("good.com{{ '.evil.com' }}") may be any host.
  return UNREADABLE;
}

/**
 * An id, channel, table, owner, address or URL host the conversation, the workflow, its runs and the node type's own
 * options never mention (a Slack channel, a sheet, a user, a site) can only have been made up: local models write
 * plausible ones. Those parameters are left out, so the user fills them in. `typeText` gives the node type's properties
 * for an op (defaults and fixed options are known), `typeOf` the node type of an op (an existing node's too, for its app's name). A URL is judged by its host: a path on a host somebody gave is kept.
 */
export function withoutInventedIds(ops: unknown, known: string, typeText: (op: Record<string, unknown>) => string = () => '', typeOf: (op: Record<string, unknown>) => string | undefined = (op) => (op.op === 'addNode' ? String(op.type ?? '') : undefined)): { ops: unknown; invented: string[]; values: string[] } {
  if (!Array.isArray(ops)) return { ops, invented: [], values: [] };
  const invented: string[] = [];
  const values: string[] = [];
  const appNames = (op: Record<string, unknown>) => (typeOf(op) ?? '').toLowerCase().split('.');
  const clean = (op: Record<string, unknown>, node: unknown, parameters: unknown) => {
    if (!parameters || typeof parameters !== 'object') return parameters;
    const out = { ...(parameters as Record<string, unknown>) };
    for (const [key, value] of Object.entries(out)) {
      if (typeof value !== 'string' || !value.trim()) continue;
      const isId = ID_PARAMETER.test(key);
      if (value.includes('{{')) {
        // An expression is kept, but a URL that starts with a literal host nobody gave is judged like a plain one.
        const host = !isId && URL_PARAMETER.test(key) ? literalHostOf(value) : undefined;
        if (!host || (host !== UNREADABLE && (mentionsHost(known, host) || mentionsHost(typeText(op), host)))) continue;
        invented.push(hostNote(key, node, host));
        delete out[key];
        values.push(value);
        continue;
      }
      if (!isId && !DESTINATION_PARAMETER.test(key) && !URL_PARAMETER.test(key)) continue;
      // A property that is not text ("to" is the end of a date window on a dateTime) is no destination.
      if (!isId && propertyType(typeText(op), key) !== undefined && propertyType(typeText(op), key) !== 'string') continue;
      if (typeText(op).includes(JSON.stringify(value)) || (isId || URL_PARAMETER.test(key) ? known.includes(value) : namedAs(value, known, appNames(op)))) continue;
      if (!isId && URL_PARAMETER.test(key)) {
        const host = hostOf(value);
        if (!host || (host !== UNREADABLE && (mentionsHost(known, host) || mentionsHost(typeText(op), host)))) continue;
        invented.push(hostNote(key, node, host));
      } else {
        invented.push(`${key} of “${String(node)}”: ${isId ? 'an id' : `a ${key}`} nobody gave, left for the user to fill in`);
      }
      delete out[key];
      values.push(value);
    }
    return out;
  };
  const cleaned = ops.map((op) => {
    if (!op || typeof op !== 'object') return op;
    const o = op as Record<string, unknown>;
    if (o.op === 'addNode') return { ...o, parameters: clean(o, o.name ?? o.type, o.parameters) };
    if (o.op === 'setParameters') return { ...o, parameters: clean(o, o.node, o.parameters) };
    return op;
  });
  return { ops: cleaned, invented, values };
}

const UNIT_MS = { ms: 1, s: 1000, min: 60_000, h: 3_600_000 } as const;
type Unit = keyof typeof UNIT_MS;
const UNIT_NAME: Record<Unit, string> = { ms: 'milliseconds', s: 'seconds', min: 'minutes', h: 'hours' };
const DURATION = /(\d+(?:\.\d+)?)\s*(milliseconds?|ms|seconds?|secs?|s|minutes?|mins?|hours?|hrs?|h)\b/gi;
const unitOfWord = (word: string): Unit => (/^(ms|milli)/i.test(word) ? 'ms' : /^s/i.test(word) ? 's' : /^m/i.test(word) ? 'min' : 'h');
/** The unit a number field is in, from its label or description: "Timeout (ms)", "Wait (seconds)". */
const unitOfField = (p: PropertyDescriptor): Unit | undefined => {
  const text = `${p.displayName} ${p.description ?? ''}`;
  if (/\(ms\)|millisecond/i.test(text)) return 'ms';
  if (/\((s|sec|seconds?)\)|in seconds/i.test(text)) return 's';
  if (/\((min|minutes?)\)|in minutes/i.test(text)) return 'min';
  return undefined;
};

/**
 * Durations the request named that a proposal set in the wrong unit: "a 30 minute timeout" on a field in milliseconds
 * proposed as 30 or 1800. Each is said as the number it should be, for sending the proposal back.
 */
export function unitSlips(ops: unknown, request: string, propertiesOf: (op: Record<string, unknown>) => PropertyDescriptor[] | undefined): string[] {
  const durations = [...request.matchAll(DURATION)].map((m) => ({ text: m[0], value: Number(m[1]), ms: Number(m[1]) * UNIT_MS[unitOfWord(m[2])] }));
  if (!durations.length || !Array.isArray(ops)) return [];
  const slips: string[] = [];
  const check = (p: PropertyDescriptor | undefined, value: unknown) => {
    const unit = p?.type === 'number' ? unitOfField(p) : undefined;
    if (!unit || typeof value !== 'number') return;
    for (const d of durations) {
      const expected = d.ms / UNIT_MS[unit];
      const misread = [d.value, ...Object.values(UNIT_MS).map((ms) => d.ms / ms)].includes(value);
      if (value !== expected && misread) slips.push(`“${p!.displayName}” is in ${UNIT_NAME[unit]}: ${d.text} is ${expected}, not ${value}`);
    }
  };
  for (const op of ops) {
    if (!op || typeof op !== 'object' || !('parameters' in op)) continue;
    const properties = propertiesOf(op as Record<string, unknown>);
    const parameters = (op as { parameters?: unknown }).parameters;
    if (!properties || !parameters || typeof parameters !== 'object') continue;
    for (const [key, value] of Object.entries(parameters)) {
      const props = properties.filter((p) => p.name === key);
      const collection = props.find((p) => p.type === 'collection');
      if (collection && value && typeof value === 'object') for (const [k, v] of Object.entries(value)) check(collection.values?.find((p) => p.name === k), v);
      else check(props.find((p) => p.type === 'number'), value);
    }
  }
  return slips;
}

/**
 * A Run a Team node's team as the model wrote it: models put the team's name or its lead's title where the id goes
 * ("Tech Lead" for team_COGk…). A name that matches one published team becomes its id, and `teamName` is filled in from
 * the team, so the node shows it and runs. `typeOf` gives the type of a node a setParameters op names.
 */
export function withTeamIds(ops: unknown, teams: readonly TeamBrief[], typeOf: (node: string) => string | undefined = () => undefined): unknown {
  if (!Array.isArray(ops) || !teams.length) return ops;
  const resolve = (parameters: unknown) => withTeamId(parameters, teams);
  return ops.map((op) => {
    if (!op || typeof op !== 'object') return op;
    const o = op as Record<string, unknown>;
    if (o.op === 'addNode' && o.type === 'core.runTeam') return { ...o, parameters: resolve(o.parameters) };
    if (o.op === 'setParameters' && typeOf(String(o.node ?? '')) === 'core.runTeam') return { ...o, parameters: resolve(o.parameters) };
    return op;
  });
}

/**
 * A Run an Agent node's agent as the model wrote it: its name where the id goes becomes the id of the one published agent
 * of that name. A newAgent op names an agent that doesn't exist yet: any agentId on it is dropped (the editor sets it).
 */
export function withAgentIds(ops: unknown, agents: readonly AgentBrief[], typeOf: (node: string) => string | undefined = () => undefined): unknown {
  if (!Array.isArray(ops)) return ops;
  const resolve = (parameters: unknown) => withAgentId(parameters, agents);
  return ops.map((op) => {
    if (!op || typeof op !== 'object') return op;
    const o = op as Record<string, unknown>;
    if (o.op === 'newAgent' || (o.op === 'addNode' && o.newAgent)) {
      const { agentId: _agentId, ...parameters } = (o.parameters && typeof o.parameters === 'object' ? o.parameters : {}) as Record<string, unknown>;
      return { ...o, parameters };
    }
    if (o.op === 'addNode' && o.type === 'core.messageAgent') return { ...o, parameters: resolve(o.parameters) };
    if (o.op === 'setParameters' && typeOf(String(o.node ?? '')) === 'core.messageAgent') return { ...o, parameters: resolve(o.parameters) };
    return op;
  });
}

export const standInKey = (name: string) => name.trim().toLowerCase().replace(/\s+\d+$/, '').replace(/\s+agent$/, '');

/**
 * Local models propose a `newAgent` and then, in the same conversation, an AI Agent for the same job, or a chat model for
 * the new agent's node, believing it needs one (it runs with the agent's own). Those are left out, with what refers to
 * them, and the model is told why. `agents`: the new agents proposed so far, by `standInKey` of their names.
 */
export function withoutAgentStandIns(ops: unknown, agents: ReadonlySet<string>, kindOf: (type: string) => string | undefined = () => undefined): { ops: unknown; notes: string[] } {
  if (!Array.isArray(ops) || !agents.size) return { ops, notes: [] };
  const notes: string[] = [];
  const gone = new Set<string>();
  const isAgent = (name: unknown) => typeof name === 'string' && agents.has(standInKey(name));
  const kept = ops.filter((op) => {
    if (!op || typeof op !== 'object') return true;
    const o = op as Record<string, unknown>;
    if (o.op === 'addNode' && o.type === 'core.aiAgent' && isAgent(o.name)) {
      notes.push(`“${String(o.name)}” does the new agent's job: its Run an Agent step already runs it`);
      for (const handle of [o.ref, o.name]) if (typeof handle === 'string') gone.add(handle);
      return false;
    }
    const attached = (o.op === 'addNode' && kindOf(String(o.type ?? '')) === 'subnode' && isAgent(o.after)) || (o.op === 'connect' && typeof o.type === 'string' && o.type !== 'main' && isAgent(o.to));
    if (attached) {
      notes.push(`nothing attaches to the new agent's step: it runs with the agent's own model and tools`);
      for (const handle of [o.ref, o.name]) if (typeof handle === 'string') gone.add(handle);
      return false;
    }
    return !(o.op === 'connect' || o.op === 'disconnect') || !(gone.has(String(o.from)) || gone.has(String(o.to)));
  });
  return { ops: kept, notes: [...new Set(notes)] };
}

/**
 * A new AI Agent step that wouldn't run here (no chat model attached, so OpenAI's, or a hosted one) becomes a dedicated
 * agent: a newAgent the Agent architect designs on a local model, with the tools and knowledge base it needs. One with an
 * Ollama chat model stays, as a small inline step. Its sub-nodes go with withoutAgentStandIns, given the names returned.
 */
export function asNewAgents(ops: unknown, typeOf: (name: string) => string | undefined = () => undefined, already: ReadonlySet<string> = new Set(), kindOf: (type: string) => string | undefined = () => undefined, displayName: (type: string) => string | undefined = () => undefined): { ops: unknown; names: string[]; handles: string[]; notes: string[] } {
  if (!Array.isArray(ops)) return { ops, names: [], handles: [], notes: [] };
  const handles = (o: Record<string, unknown>) => [o.ref, o.name].filter((h): h is string => typeof h === 'string');
  const added = new Map<string, string>();
  for (const op of ops) {
    const o = op as Record<string, unknown>;
    if (o?.op === 'addNode' && typeof o.type === 'string') for (const h of handles(o)) added.set(h, o.type);
  }
  const typeOfHandle = (h: unknown) => (typeof h === 'string' ? (added.get(h) ?? typeOf(h)) : undefined);
  const LOCAL = 'core.ollamaChatModel';
  const runsHere = (agent: Record<string, unknown>) =>
    ops.some((op) => {
      const o = op as Record<string, unknown>;
      return (o?.op === 'addNode' && o.type === LOCAL && handles(agent).includes(String(o.after))) || (o?.op === 'connect' && o.type === 'ai_languageModel' && handles(agent).includes(String(o.to)) && typeOfHandle(o.from) === LOCAL);
    });
  const names: string[] = [];
  const agentHandles: string[] = [];
  const out = ops.map((op) => {
    const o = op as Record<string, unknown>;
    // One named after a new agent already proposed is its stand-in: withoutAgentStandIns drops it.
    if (o?.op !== 'addNode' || o.type !== 'core.aiAgent' || runsHere(o) || (typeof o.name === 'string' && already.has(standInKey(o.name)))) return op;
    const p = (o.parameters && typeof o.parameters === 'object' ? o.parameters : {}) as Record<string, unknown>;
    const said = (v: unknown) => (typeof v === 'string' && v.trim() && !v.trim().startsWith('{{') ? v.trim() : undefined);
    const name = (typeof o.name === 'string' && o.name.trim()) || 'Agent';
    names.push(name);
    agentHandles.push(name, ...(typeof o.ref === 'string' ? [o.ref] : []));
    const instructions = said(p.systemMessage) ?? said(p.prompt) ?? '';
    // SB05: the tool nodes it had (attached by `after` or an ai_tool connection) become the new agent's tool hints.
    const mine = handles(o);
    // Only a sub-node placed `after` the agent is a tool: any other node placed after it is the next step of the flow.
    const nameOf = (x: Record<string, unknown>) => String((typeof x.type === 'string' && displayName(x.type)) || x.name || x.type);
    const toolNames = [...new Set(ops.flatMap((t) => {
      const x = t as Record<string, unknown>;
      if (x?.op === 'addNode' && typeof x.type === 'string' && x.type !== LOCAL && !/chatmodel|memory/i.test(x.type) && kindOf(x.type) === 'subnode' && mine.includes(String(x.after))) return [nameOf(x)];
      if (x?.op === 'connect' && x.type === 'ai_tool' && mine.includes(String(x.to))) {
        const node = ops.map((n) => n as Record<string, unknown>).find((n) => n.op === 'addNode' && handles(n).includes(String(x.from)));
        return [String(node ? nameOf(node) : x.from)];
      }
      return [];
    }))].slice(0, 8).map((t) => t.slice(0, 80));
    return {
      op: 'newAgent',
      name,
      ...(toolNames.length && { tools: toolNames }),
      description: (instructions.split(/(?<=[.!?])\s/)[0] ?? '').slice(0, 300) || name,
      instructions,
      ...(typeof p.prompt === 'string' && p.prompt.trim() && { parameters: { message: p.prompt } }),
      ...Object.fromEntries((['ref', 'after', 'before', 'output'] as const).filter((k) => o[k] !== undefined).map((k) => [k, o[k]])),
    };
  });
  return { ops: out, names, handles: agentHandles, notes: names.map((n) => `“${n}” is a dedicated agent (newAgent), designed on a local model: an AI Agent step here has no chat model it can run on`) };
}

/**
 * SB05: a new agent (a `newAgent`, or the addNode it became) placed `before` a step with no `after`, when the clause that
 * names the agent says "after <a step in the flow>", goes after that step instead. A message that says "before <X>" keeps
 * it. `next` gives the steps a step feeds on the main path: when X already feeds the `before` step the op is left alone;
 * otherwise `after: X` is set, with `before: Y` when X feeds exactly one step Y, so the agent sits between them and its
 * answer still reaches Y.
 */
export function placedAsAsked(ops: unknown, message: string, nodeNames: string[], next: (name: string) => string[] = () => []): { ops: unknown; notes: string[] } {
  if (!Array.isArray(ops)) return { ops, notes: [] };
  const whole = message.toLowerCase();
  const quote = `["“”'‘’]?`;
  const said = (text: string, word: 'after' | 'before', name: string) => new RegExp(`\\b${word}\\s+(?:the\\s+)?(?:(?:step|node)\\s+)?${quote}${escapeRegExp(name.toLowerCase())}${quote}(?![\\w-])`).test(text);
  const names = [...nodeNames].sort((a, b) => b.length - a.length);
  const clauses = whole.split(/[.;,!?\n]|\balso\b|\bthen\b|\band\b(?=\s+(?:put|add|place|insert|make)\b)/);
  const notes: string[] = [];
  const out = ops.map((op) => {
    const o = op as Record<string, unknown>;
    if (!o || !(o.op === 'newAgent' || (o.op === 'addNode' && o.newAgent))) return op;
    const hasBefore = typeof o.before === 'string';
    const afterOnly = typeof o.after === 'string' && o.before === undefined;
    if (!hasBefore && !afterOnly) return op;
    if (o.output !== undefined) return op; // an output of the step it follows was chosen: that is a placement of its own
    if (hasBefore && o.after !== undefined) return op;
    if (hasBefore && said(whole, 'before', o.before as string)) return op;
    const mine = [o.name, o.ref].filter((h): h is string => typeof h === 'string' && !!h.trim()).map((h) => h.toLowerCase());
    const named = clauses.filter((c) => /\bagents?\b/.test(c) || mine.some((h) => new RegExp(`(?<![\\w-])${escapeRegExp(h)}(?![\\w-])`).test(c)));
    const after = names.find((n) => named.some((c) => said(c, 'after', n)));
    if (!after) return op;
    if (afterOnly) {
      // The model wrote `after: X` alone: the agent would hang off X as a dead-end branch. Put it in front of the one step X feeds.
      if (o.after !== after) return op;
      const feeds = next(after);
      // A step already placed after the agent (a connect from it, or an addNode after it) is where its answer goes.
      const onward = ops.some((x) => {
        const y = x as Record<string, unknown> | null;
        if (x === op || !y || typeof y !== 'object') return false;
        return (y.op === 'connect' && mine.includes(String(y.from ?? '').toLowerCase())) || (y.op === 'addNode' && mine.includes(String(y.after ?? '').toLowerCase()));
      });
      if (feeds.length !== 1 || onward) return op;
      notes.push(`placed “${String(o.name ?? 'the agent')}” between “${after}” and “${feeds[0]}”, as asked`);
      return { ...o, before: feeds[0] };
    }
    const feeds = next(after);
    if (feeds.includes(o.before as string)) return op; // already after it: `before` keeps the agent between the two
    const { before: _before, ...rest } = o;
    notes.push(`placed “${String(o.name ?? 'the agent')}” after “${after}”, as asked`);
    return { ...rest, after, ...(feeds.length === 1 && { before: feeds[0] }) };
  });
  return { ops: out, notes };
}

/** An id-like token in prose: a capital, then 8 or more capitals, digits, `_` or `-`, with a digit among them (C057L43652P). */
const ID_TOKEN = /\b(?=[A-Z\d_-]*\d)[A-Z][A-Z\d_-]{8,}\b/g;
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The reply's text gets the same check as proposals: an id that nobody gave (one left out of a proposal, or an id-like
 * token the conversation, the workflow and its runs never mention) is not repeated as if it were real. In brackets it
 * goes; anywhere else it reads "the right id".
 */
export function withoutMadeUpIds(text: string, known: string, invented: Iterable<string> = []): string {
  const made = new Set([...invented].filter((value) => value.length >= 6 && /\d/.test(value)));
  for (const token of text.match(ID_TOKEN) ?? []) if (!known.includes(token)) made.add(token);
  let out = text;
  for (const value of made) {
    const id = `[“"'\`]?${escapeRegExp(value)}[”"'\`]?`;
    out = out.replace(new RegExp(`\\s*\\(\\s*${id}\\s*\\)`, 'g'), '').replace(new RegExp(id, 'g'), 'the right id');
  }
  return out;
}

const SENTENCE = /(?<=[^\d\s][.!?])\s+/;
const LIST_MARKER = /^\s*(?:\d+[.)]|[-*•])\s*/;

/** Drop the sentences `drop` picks, keeping lines and list items in place. Undefined when nothing was dropped. */
function dropSentences(text: string, drop: (sentence: string) => boolean): string | undefined {
  let dropped = false;
  const lines = text.split('\n');
  const kept = lines.map((line) => {
    const sentences = line.split(SENTENCE);
    const left = sentences.filter((sentence) => !drop(sentence.replace(LIST_MARKER, '')));
    if (left.length !== sentences.length) dropped = true;
    return left.join(' ');
  });
  if (!dropped) return undefined;
  return kept
    .filter((line, i) => line.trim() || !lines[i].trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const DONE = 'updated|added|applied|inserted|connected|removed|deleted|changed|modified|created|configured|replaced|renamed|fixed';
// A sentence may open with a past tense ("Added a Slack node"), not with "Set up", which is also an instruction.
const APPLIED_CLAIM = new RegExp(
  `^(?:${DONE})\\b|\\b(?:has|have) (?:now )?been (?:${DONE}|set up|made)\\b|\\bI(?:'ve| have)?(?: just| now)? (?:${DONE}|set up|made)\\b|\\bis now (?:connected|added|configured|in place)\\b|\\bis (?:now )?ready to\\b|\\bnow (?:has|have|contains|includes)\\b|\\b(?:was|were) (?:${DONE}|set up)\\b|\\bwill now\\b|\\bnow (?:posts|sends|runs|writes|saves|calls|replies|returns|uses|keeps|filters)\\b`,
  'i',
);

/**
 * Local models sometimes say a proposed change "has been added" (or "the workflow will now post…") although nothing
 * changes until the user clicks Apply. In a reply that proposed something those sentences are dropped, so the panel
 * never says a change was made. Lines and list items keep their layout; a list number stays with its item.
 */
export function withoutAppliedClaims(text: string): string {
  const out = dropSentences(text, (sentence) => APPLIED_CLAIM.test(sentence));
  if (out === undefined) return text;
  return out || 'Review the change on the card, then click Apply to make it.';
}

/** The notes the conversation history gives of earlier proposals and test runs ("[Proposed “…”: applied]"). */
const ECHOED_NOTE = /^[ \t]*\[(?:Proposed “[^”]*”|Test run \d+ \w+): [^\]\n]*\][ \t]*(?:\n|$)/gm;

/** A local model may copy those notes into its text as if writing one made a change: they are left out. */
export function withoutEchoedNotes(text: string): string {
  return text.replace(ECHOED_NOTE, '').replace(/\n{3,}/g, '\n\n').trim();
}

/** Content words (four letters or more, a plural "s" off) for telling a repeated sentence. */
const contentWords = (text: string) => new Set((text.toLowerCase().match(/[\p{L}\d][\p{L}\d'-]*/gu) ?? []).map((w) => w.replace(/'s$/, '').replace(/s$/, '')).filter((w) => w.length >= 4));

/**
 * A local model often answers, calls a tool to check, then answers again in other words. A later sentence whose
 * content words (six or more) were nearly all said earlier in the same reply is left out.
 */
export function withoutRepeats(text: string, earlier: string): string {
  if (!earlier.trim()) return text;
  const said = contentWords(earlier);
  const plain = (sentence: string) => sentence.toLowerCase().replace(/[^\p{L}\d]+/gu, ' ').trim();
  const sentences = new Set(earlier.split('\n').flatMap((line) => line.split(SENTENCE)).map(plain));
  return (
    dropSentences(text, (sentence) => {
      if (plain(sentence).length > 12 && sentences.has(plain(sentence))) return true;
      const own = [...contentWords(sentence)];
      return own.length >= 6 && own.filter((w) => said.has(w)).length / own.length >= 0.8;
    }) ?? text
  );
}

/** A reply that says only the person can fix it: a credential, an account, a key, an id. */
export const PERSON_ONLY = /\b(credential|api key|access token|sign in|log in|permission|blocked by (?:this|the) host|blocked by (?:this|the) outbound policy|outbound|not allowed to reach)s?\b/i; // SB03: the host's outbound policy, in its words (a bare "blocked" is also what a stuck step is)

/** The model saying what it is about to do or what it looked at, before the answer. */
const NARRATION = /^(?:let me|let's|i'll|i will|i need to|i'm going to|now i|now,? let|first,|next,|looking at|based on|i can see|i see that|to fix this|the user (?:wants|needs|asked))\b/i;

/** Sentences that narrate instead of answer are left out; the answer stays (and all of it, when nothing else is left). */
export function withoutNarration(text: string): string {
  const out = dropSentences(text, (sentence) => NARRATION.test(sentence.trim()));
  return out === undefined || !out.trim() ? text : out;
}

export { withoutLeakedMarkup } from '@/lib/shared/leaked-markup';

/**
 * Why a test-and-fix session's fix would be wasted, if it is: it touches neither the failing step nor anything that feeds
 * it, it removes a node and adds the same kind back, or it only adds a No Operation step.
 */
export function wastedFix(ops: AssistantOp[], workflow: Workflow, failingId: string | undefined): string | undefined {
  if (!ops.length) return undefined;
  const byRef = (ref: string | undefined) => workflow.nodes.find((n) => n.name === ref || n.id === ref);
  const removed = ops.flatMap((op) => (op.op === 'removeNode' ? [byRef(op.node)] : [])).filter((n): n is NonNullable<typeof n> => Boolean(n));
  const readded = ops.find((op) => op.op === 'addNode' && removed.some((n) => n.type === op.type));
  if (readded?.op === 'addNode') return `removing “${removed.find((n) => n.type === readded.type)?.name}” and adding the same kind of node back changes nothing.`;
  if (ops.every((op) => op.op === 'addNode' && op.type === 'core.noOp')) return 'a No Operation step changes nothing.';
  const failing = failingId ? workflow.nodes.find((n) => n.id === failingId) : undefined;
  if (!failing) return undefined;
  // The failing step and every node upstream of it.
  const near = new Set([failing.id]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const c of workflow.connections) if (near.has(c.target) && !near.has(c.source)) (near.add(c.source), (grew = true));
  }
  const touches = ops.some((op) => {
    const refs = [
      'node' in op ? op.node : undefined,
      'from' in op ? op.from : undefined,
      'to' in op ? op.to : undefined,
      'after' in op ? op.after : undefined,
      'before' in op ? op.before : undefined,
    ];
    return refs.some((ref) => typeof ref === 'string' && near.has(byRef(ref)?.id ?? ''));
  });
  return touches ? undefined : `the run failed at “${failing.name}”, and this change touches neither it nor what feeds it.`;
}

/**
 * SB03: why a session's fix would drop a step the request names or change a URL, address, channel or id the person
 * gave, or `undefined`. `given` is what the person wrote; only they can change those.
 */
export function givenValuesKept(ops: AssistantOp[], workflow: Workflow, given: string): string | undefined {
  return givenKept(ops, workflow.nodes, given);
}

export const APPLY_REQUEST = /\bclick (?:on )?(?:the )?["“]?apply\b|\bapply (?:this|that|the|these|those|my)(?: \w+)? (?:change|fix|proposal)e?s?\b|\b(?:run|test) (?:the workflow|it) again\b/i;

/** A line that is only a JSON object: a tool call or its result written as text (`{"error": "No change needed"}`). */
const JSON_LINE = /^[ \t]*\{[^\n]*\}[ \t]*(?:\n|$)/gm;

/**
 * In a test-and-fix session Spotlight applies and runs by itself: "click Apply" and "run it again" are left out, and so
 * are lines that are only a JSON object (the session's text is a log of what happened, not a place for data).
 */
export function withoutApplyRequests(text: string): string {
  const prose = text.replace(JSON_LINE, '').replace(/\n{3,}/g, '\n\n').trim();
  return dropSentences(prose, (sentence) => APPLY_REQUEST.test(sentence)) ?? prose;
}

// SB12: the words of a change claimed with no card ("I've set the retry to 3", "The step now retries"), not a question and not a plan.
export const CHANGE_CLAIM = /\bI(?:'ve| have) (?:just |now )?(?:set|changed|added|updated|fixed|removed|connected)\b|\b(?:has|have) been (?:set|changed|added|updated)\b|\bnow (?:retries|posts|sends|reads|uses)\b|\bis now (?:set|connected|configured)\b/i;

// SB12: whether the text says a change was made. A sentence that asks, or says what would, could or will happen, is not a claim.
export function claimsAChange(text: string): boolean {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .some((sentence) => CHANGE_CLAIM.test(sentence) && !/\?\s*$|\b(?:would|could|will|should|might)\b/i.test(sentence));
}

/**
 * Local models (qwen3-coder in particular) sometimes write a tool call as text,
 * `<function=name><parameter=key>value</parameter></function>`, instead of a
 * structured one. Read those back so the turn still works.
 */
export function recoverToolCalls(text: string, names: ReadonlySet<string> = TOOL_NAMES): { text: string; calls: ToolCall[] } {
  const calls: ToolCall[] = [];
  const rest = text
    .replace(/<function=([\w-]+)>([\s\S]*?)<\/function>/g, (whole, name: string, body: string) => {
      if (!names.has(name)) return whole;
      const input: Record<string, unknown> = {};
      for (const [, key, value] of body.matchAll(/<parameter=([\w-]+)>\s*([\s\S]*?)\s*<\/parameter>/g)) {
        try {
          input[key] = JSON.parse(value);
        } catch {
          input[key] = value;
        }
      }
      calls.push({ id: `call_text_${Date.now().toString(36)}_${calls.length}`, name, input });
      return '';
    })
    .replace(/<\/?tool_call>/g, '')
    .trim();
  return calls.length ? { text: rest, calls } : { text, calls };
}
