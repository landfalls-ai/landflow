/**
 * "Create an agent that …", read from a typed message (docs/assistant.md "Agents from Spotlight"): the one place that
 * decides whether a message is an ask for an agent, so the composer, the scenarios and the chat's new agent read the same
 * words. Deterministic and pure like `askKind`: the model never decides it. English words only (docs/limitations.md).
 *
 * An agent ask is a creation verb with "an agent" as its object, or a message that starts "an agent that|which|to …";
 * never a question, "my/the <name> agent" (an agent that exists), or an "AI agent" step. `placed` says the person named
 * where in this flow it goes ("after Sample PR", "add it to this flow", "as a step"): that ask stays the chat's `newAgent`.
 */
import { askKind } from './ask-kind';

export interface AgentAsk {
  /** A short name from the job ("PR reviewer"); absent when the job gave none (the architect's request names it). */
  name?: string;
  /** What the person asked for, as a sentence. */
  description: string;
  /** The ask names where in this flow the agent goes. */
  placed: boolean;
  /** The apps and actions it names ("Linear: look up issues"): at most 8, 80 characters each (the design route's limits). */
  tools: string[];
  /** What it answers from ("docs"). */
  knowledge?: string;
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const CREATE = "(?:create|make|build|design|set up|setup|add|i need|i want|i'd like|i would like|we need|we want|we'd like|give me)";
/** "make me an agent", "create a new agent", "i need an assistant agent": a few filler words, then the agent; never "… agent step". */
const OBJECT = "(?:\\s+(?:me|us|for me|for us|please|myself))*\\s+(?:an?|another|one)\\s+(?:new\\s+)?(?:assistant\\s+)?agent\\b(?!\\s+(?:step|node|block)\\b)";
const AS_OBJECT = new RegExp(`\\b${CREATE}${OBJECT}`, 'i');
const AS_SUBJECT = /^(?:an?|another)\s+(?:new\s+)?(?:assistant\s+)?agent\s+(?:that|which|to)\b/i;

/** Where in the flow: "after|before <a step>", "to this flow", "as a step". */
function isPlaced(message: string, nodeNames: string[]): boolean {
  const quote = `["“”'‘’]?`;
  for (const name of nodeNames) {
    if (!name.trim()) continue;
    if (new RegExp(`\\b(?:after|before)\\s+(?:the\\s+)?(?:(?:step|node)\\s+)?${quote}${escape(name)}${quote}(?![\\w-])`, 'i').test(message)) return true;
  }
  return /\b(?:to|in|into|onto|on)\s+(?:this|the|my|our)\s+(?:flow|workflow|canvas)\b/i.test(message) || /\bas\s+(?:a|an|the)\s+(?:step|node)\b/i.test(message);
}

/** The apps a message may name, with what a bare "with a <App> tool" lets the agent use. */
const APPS: Array<{ name: string; pattern: string; noun: string }> = [
  { name: 'Linear', pattern: 'linear', noun: 'issues' },
  { name: 'Slack', pattern: 'slack', noun: 'messages' },
  { name: 'GitHub', pattern: 'github', noun: 'pull requests' },
  { name: 'Jira', pattern: 'jira', noun: 'issues' },
  { name: 'Notion', pattern: 'notion', noun: 'pages' },
  { name: 'Gmail', pattern: 'gmail', noun: 'emails' },
  { name: 'Google Sheets', pattern: 'google sheets|sheets', noun: 'rows' },
  { name: 'Salesforce', pattern: 'salesforce', noun: 'records' },
  { name: 'HubSpot', pattern: 'hubspot', noun: 'records' },
  { name: 'Zendesk', pattern: 'zendesk', noun: 'tickets' },
  { name: 'Stripe', pattern: 'stripe', noun: 'payments' },
  { name: 'Discord', pattern: 'discord', noun: 'messages' },
  { name: 'Attio', pattern: 'attio', noun: 'records' },
];
const READ_VERBS = 'look up|lookup|look at|read|search|find|fetch|list|get|check|query|pull|summari[sz]e';
const WRITE_VERBS = 'create|update|comment on|close|assign|open|file|label';
const SEND_VERBS = 'post|send|write|notify|message|reply|share|publish';
/** The third-person forms after "an agent that …": "reads", "looks up", "creates" (the suffix goes on the first word). */
const variants = (verbs: string) => verbs.split('|').map((v) => v.replace(/^(\S+)/, '$1(?:e?s)?')).join('|').replace('query(?:e?s)?', 'quer(?:y|ies)');
const baseVerb = (verbs: string, said: string) => verbs.split('|').find((v) => new RegExp(`^(?:${variants(v)})$`, 'i').test(said)) ?? said;
const FILLER = '(?:(?:the|our|its|all|open|new|any|my|your|their|a|an)\\s+)*';
const NOUN_STOP = new Set(['and', 'or', 'to', 'for', 'from', 'with', 'in', 'on', 'that', 'which', 'when', 'then', 'tool', 'tools', 'integration', 'access', 'as']);

/** AG02: a node or plugin the editor offers, by the names a person types ("Send Email", "Grafana"); the editor passes its non-core node types. */
export interface AskCatalogEntry {
  displayName: string;
  pluginName?: string;
  /** A core node: it names no plugin, so it never decides an agent's name. */
  core?: boolean;
}

/**
 * AG02: the node types a message may name as tools: every plugin node, and a core node whose display name has two or more
 * words ("HTTP Request"), so a one-word core node ("Code", "Merge") never matches ordinary text.
 */
export function askCatalog(types: Array<{ pluginId: string; pluginName?: string; descriptor: { displayName: string } }>): AskCatalogEntry[] {
  return types
    .filter((t) => t.pluginId !== 'core' || /\S\s+\S/.test(t.descriptor.displayName.trim()))
    .map((t) => (t.pluginId === 'core' ? { displayName: t.descriptor.displayName, core: true } : { displayName: t.descriptor.displayName, pluginName: t.pluginName }));
}

/** AG02: whether `name` is in `message` as whole words ("field statistics"), allowing a plural on its last word. */
function names(message: string, name: string): boolean {
  const text = name.trim();
  if (text.length < 4) return false;
  const body = /[^aeiou]y$/i.test(text) ? `${escape(text.slice(0, -1)).replace(/\s+/g, '[\\s-]+')}(?:y|ies|ied)` : `${escape(text).replace(/\s+/g, '[\\s-]+')}(?:e?s)?`;
  return new RegExp(`(?<![\\w-])${body}(?![\\w-])`, 'i').test(message);
}

/** AG02: a plugin node of two or more words whose every word is in the message in some form, in any order ("decodes JWTs" names JWT Decode). */
function wordsNamed(message: string, entry: AskCatalogEntry): boolean {
  const words = entry.displayName.trim().split(/\s+/);
  if (entry.core || words.length < 2 || words.some((w) => w.length < 3)) return false;
  // -ise and -ize, -yse and -yze are one word ("normalise" names Normalize Alert, "analyse" Analyze Logs).
  const stem = (w: string) => escape(w.replace(/e$/i, '')).replace(/([iy])[sz]$/i, '$1[sz]');
  return words.every((w) => new RegExp(`(?<![\\w-])${stem(w)}(?:e?s|e?d|ing|e)?(?![\\w-])`, 'i').test(message));
}

/** AG02: "email/mail/send/forward … to <address>": a message that sends to an address it was given. */
export const MAIL_TO = /\b(?:e-?mail|mail|send|forward)(?:e?s|ed)?\b[^.!?\n]*?\bto\s+[^\s@,;]+@[^\s@,;]+/i;

/** The tools a message names: apps by what it does with them ("Linear: read issues"), and catalog nodes and plugins by name (ag1-int: a revise reads its change with it too). */
export function toolsOf(message: string, catalog: AskCatalogEntry[] = []): string[] {
  const found: string[] = [];
  const add = (tool: string) => {
    const cut = tool.slice(0, 80);
    if (!found.includes(cut)) found.push(cut);
  };
  for (const app of APPS) {
    const name = `(?:${app.pattern})`;
    // "can look up Linear issues", "read Slack messages", "create Linear issues": the verb and what it works on.
    const verbed = new RegExp(`\\b(${variants(READ_VERBS)}|${variants(WRITE_VERBS)})\\s+${FILLER}${name}(?:'s)?(?:\\s+([a-z]+(?:\\s+requests)?))?`, 'gi');
    for (const m of message.matchAll(verbed)) {
      const noun = m[2] && !NOUN_STOP.has(m[2].toLowerCase()) ? m[2].toLowerCase() : app.noun;
      const verb = baseVerb(`${READ_VERBS}|${WRITE_VERBS}`, m[1].toLowerCase().replace(/\s+/g, ' '));
      add(`${app.name}: ${verb.replace('lookup', 'look up')} ${noun}`);
    }
    // "post to Slack", "send it to Slack", "notify Slack".
    if (new RegExp(`\\b(?:${variants(SEND_VERBS)})\\b(?:\\s+[\\w#@.'’-]+){0,5}?\\s+(?:to|in|on|into|via|through)\\s+(?:the\\s+|our\\s+)?${name}\\b`, 'i').test(message)) add(`${app.name}: post a message`);
    // "with a Linear tool", "using Slack", "a GitHub integration".
    if (new RegExp(`\\b(?:with|using|via|through)\\s+(?:a\\s+|the\\s+|our\\s+)?${name}(?:\\s+(?:tool|integration|access))?\\b|\\b${name}\\s+(?:tool|integration)\\b`, 'i').test(message)) {
      if (!found.some((t) => t.startsWith(`${app.name}:`))) add(`${app.name}: use ${app.noun}`);
    }
  }
  // AG02: the nodes and plugins the message names by their display names ("Normalize Alert", "SQLite", "Grafana"): a plugin's name only when none of its nodes is named.
  const nodes = catalog.filter((c) => names(message, c.displayName) || wordsNamed(message, c));
  for (const entry of nodes) add(entry.displayName);
  for (const plugin of new Set(catalog.map((c) => c.pluginName).filter((n): n is string => Boolean(n)))) {
    if (!names(message, plugin) || nodes.some((n) => n.pluginName === plugin)) continue;
    add(plugin);
  }
  // AG02: "email a short summary to oncall@…" names the catalog's mail-sending node (a plugin node called Send … Email/Mail) even when its name is not typed.
  if (MAIL_TO.test(message) && !found.some((t) => /^send\s.*\b(?:e-?mail|mail)\b/i.test(t))) {
    const mailers = catalog.filter((c) => !c.core && /^send\b/i.test(c.displayName.trim()) && /\b(?:e-?mail|mail)\b/i.test(c.displayName));
    if (mailers.length === 1) add(mailers[0].displayName);
    else if (mailers.length > 1) found.push(`Send email: several nodes match (${mailers.slice(0, 3).map((c) => c.displayName).join(', ')}), pick one`); // whole: it is the Not added row's text
  }
  return found.slice(0, 8);
}

const LEAD_WORDS = /^(?:(?:the|our|a|an|your|its|my|from|in|on|with|and|to|using|of)\s+)+/i;

/** What it answers from: "from our docs", "the docs knowledge base", "from the product wiki". */
function knowledgeOf(message: string): string | undefined {
  const base = /((?:[\w-]+\s+){1,2})knowledge\s*base\b/i.exec(message);
  if (base) {
    const words = base[1].trim().replace(LEAD_WORDS, '').trim();
    if (words && !/^(?:a|the|new|its|our|an)$/i.test(words)) return words.toLowerCase().slice(0, 60);
  }
  const from = /\bfrom\s+(?:(?:our|the|its|my|your|this)\s+)?((?:[\w-]+\s+){0,2}?)(docs|documentation|documents|wiki|handbook|runbooks?|policies|playbooks?|notes|help\s*center|faq)\b/i.exec(message);
  if (from) {
    const kind = /^documentation$|^documents$/i.test(from[2]) ? 'docs' : from[2].toLowerCase();
    return `${from[1].trim().toLowerCase()} ${kind}`.trim().slice(0, 60);
  }
  return undefined;
}

const AGENT_NOUN: Record<string, string> = { review: 'reviewer', answer: 'answerer', summari: 'summariser', triage: 'triager', monitor: 'monitor', watch: 'watcher', write: 'writer', draft: 'drafter', classify: 'classifier', route: 'router', check: 'checker', label: 'labeller', translate: 'translator', research: 'researcher', report: 'reporter', plan: 'planner', find: 'finder', track: 'tracker', prioriti: 'prioritiser', respond: 'responder', reply: 'replier', handle: 'handler', analy: 'analyst', extract: 'extractor' };

const cap = (text: string) => (text ? text[0].toUpperCase() + text.slice(1) : text);

/** AG02: the sentences of a text: split only at `.`, `!` or `?` followed by a space or the end, never inside an address, a domain, a number or a file name. */
export function sentencesOf(text: string): string[] {
  return text.split(/(?<=[.!?])\s+/).map((t) => t.trim()).filter(Boolean);
}

/** The job after "that|which|to", with the sentences that follow it (up to 500 characters): "reviews pull requests against our practices". */
function jobOf(message: string): string {
  const after = /\b(?:agent|assistant)\s+(?:that|which|to|who)\s+([\s\S]+)/i.exec(message) ?? /\b(?:that|which|who)\s+([\s\S]+)/i.exec(message); // AG02: the whole ask, not up to the first dot
  const [first = '', ...others] = sentencesOf(after?.[1] ?? '');
  const head = first.split(/,\s*(?:and\s+)?(?:then\s+)?(?:run|put|add|place|insert|make|use)\b/i)[0].trim();
  const kept: string[] = [];
  for (const sentence of [head, ...others]) {
    if (kept.length && kept.join(' ').length + sentence.length + 1 > 500) break;
    kept.push(sentence);
  }
  return kept.join(' ').trim();
}

/** AG02: words a name never starts with or keeps: articles, pronouns, question words, fillers. */
const NAME_STOP = new Set(['a', 'an', 'the', 'our', 'its', 'my', 'your', 'their', 'his', 'her', 'me', 'us', 'we', 'you', 'it', 'them', 'this', 'that', 'these', 'those', 'what', 'which', 'who', 'whether', 'if', 'is', 'are', 'be', 'been', 'any', 'all', 'each', 'every', 'some', 'new', 'open', 'incoming', 'customer', 'support', 'against', 'about', 'into', 'by', 'of', 'at', 'it', 'everything', 'anything', 'and', 'or', 'to', 'for', 'from', 'with', 'in', 'on', 'then', 'tool', 'tools', 'integration', 'access', 'as']);
/** AG02: plural nouns that stay plural in a name ("Sales data analyst"). */
const KEEP_PLURAL = /^(?:sales|news|analytics|metrics|logs|data|status|series)$/;

/** A short name from the job: "Alert triager", "Sales data analyst", "PR reviewer", "Docs answerer"; none when the job names no thing. */
function nameOf(job: string, knowledge: string | undefined): string | undefined {
  const m = /^([a-z]+?)(?:e?s)?\s+((?:[a-z-]+\s+){0,4}[a-z-]+)/i.exec(job.toLowerCase());
  if (!m) return undefined;
  const verb = Object.keys(AGENT_NOUN).find((v) => m[1].startsWith(v) || (m[1].length >= 4 && v.startsWith(m[1])));
  if (!verb) return undefined;
  const role = AGENT_NOUN[verb];
  // "answers customer questions from the docs" is the Docs answerer; "reviews pull requests" the PR reviewer.
  if (verb === 'answer' && knowledge) return cap(`${knowledge.split(/\s+/).pop()} ${role}`).slice(0, 40);
  const words = m[2].split(/\s+/).filter((w) => !NAME_STOP.has(w));
  let subject = words[0] ?? '';
  if (/^pull$/.test(subject)) subject = 'PR';
  else if (role === 'analyst' && words[1] === 'data' && subject !== 'data') subject = `${subject} data`; // "analyses sales data": the Sales data analyst
  else if (!KEEP_PLURAL.test(subject)) subject = subject.replace(/ies$/, 'y').replace(/(?<=[^s])s$/, '');
  if (/^(?:pr|ci|qa|ui|api|sla|crm|seo|hr)$/i.test(subject)) subject = subject.toUpperCase();
  return subject ? `${subject[0].toUpperCase()}${subject.slice(1)} ${role}`.slice(0, 40) : undefined;
}

/** What the person asked for, as a sentence: without the "create an agent that" lead and the placement clause. */
function descriptionOf(message: string, job: string): string {
  const text = (job || message.trim().replace(new RegExp(`^.*?${CREATE}${OBJECT}\\s*(?:called|named)?\\s*`, 'i'), '')).replace(/\s+/g, ' ').trim() || message.trim();
  const sentence = text.replace(/[.!?]+$/, '');
  return `${cap(sentence)}.`.slice(0, 500); // AG02: `jobOf` already keeps the whole ask's sentences, an address whole
}

/**
 * Whether `message` asks for an agent, and what it says about it. `nodeNames` are the steps on the canvas (an empty
 * canvas has none, so nothing is placed by name). `catalog` (AG02): the nodes and plugins the editor offers, so the tools
 * the message names by their display names ("Send Email", "SQLite") are read too.
 */
export function agentAsk(message: string, nodeNames: string[] = [], catalog: AskCatalogEntry[] = []): AgentAsk | undefined {
  const full = message.trim();
  // "create a new agent named Sales helper that …": the name is the person's own, and the rest reads as "an agent that …".
  const named = /\b(?:named|called)\s+["“'‘]?([^"”'’,.!?\n]{2,40}?)["”'’]?\s+(?=that\b|which\b|who\b|to\b)/i.exec(full);
  const text = named ? full.replace(named[0], '') : full;
  if (!text || askKind(text) === 'question') return undefined;
  if (!AS_OBJECT.test(text) && !AS_SUBJECT.test(text)) return undefined;
  const knowledge = knowledgeOf(text);
  const job = jobOf(text);
  const tools = toolsOf(text, catalog);
  const description = descriptionOf(text, job);
  const name = named ? named[1].trim() : nameOf(sentencesOf(job)[0] ?? job, knowledge); // none when the job names no thing: the card then uses `fallbackName`
  return { ...(name && { name }), description, placed: isPlaced(text, nodeNames), tools, ...(knowledge && { knowledge }) };
}

/**
 * A name for the card when the ask gave none: a short noun name with no article, pronoun or comma. One plugin's nodes
 * named ("Get Alerts" of Grafana): "Grafana alerts agent"; three or more tools of different plugins: "Utility helper";
 * else the description's first nouns ("Weekly report agent").
 */
export function fallbackName(description: string, tools: string[] = [], catalog: AskCatalogEntry[] = []): string {
  const plugins = new Set<string>();
  for (const tool of tools) {
    // Two plugins can have a node of the same name (Grafana's Get Alerts and another's): the one whose plugin the ask names wins.
    const same = catalog.filter((c) => c.displayName.toLowerCase() === tool.toLowerCase());
    const entry = same.find((c) => c.pluginName && description.toLowerCase().includes(c.pluginName.toLowerCase())) ?? same[0];
    if (entry?.core) continue; // a core node (HTTP Request) belongs to no plugin
    plugins.add(entry?.pluginName ?? entry?.displayName ?? tool.split(':')[0]);
  }
  const [app] = plugins;
  if (plugins.size === 1 && app) {
    const noun = tools.map((t) => t.split(/\s+/).pop() ?? '').find((w) => /^[A-Za-z]{4,}s$/.test(w));
    return `${cap(app)}${noun && noun.toLowerCase() !== app.toLowerCase() ? ` ${noun.toLowerCase()}` : ''} agent`.slice(0, 40);
  }
  if (tools.length >= 3 && plugins.size >= 2) return 'Utility helper';
  const words = description.replace(/[.!?]+$/, '').toLowerCase().split(/\s+/).slice(1).map((w) => w.replace(/[^a-z0-9-]/g, '')).filter((w) => w && !NAME_STOP.has(w)).slice(0, 2);
  return words.length ? `${cap(words.join(' '))} agent`.slice(0, 40) : 'New agent';
}

/** AG02: the message reads tokens, hashes or keys (a JWT decoder, a hasher): its input is not secret-masked (the agent's own job is to read them). */
export const readsTokens = (text: string): boolean => /\b(?:jwts?|json web tokens?|tokens?|hash(?:es|ing|ed)?|sha-?\d+|md5|passwords?|api[ -]?keys?|decod(?:e|es|ed|ing)|base-?64)\b/i.test(text);

/**
 * A `newAgent` op (as the chat proposes it: `{ op: 'newAgent' }`, or an `addNode` carrying `newAgent`) that has no `tools`
 * or `knowledge` gets the ones the message names, never more than `agentAsk` read from it: a model that dropped "can look
 * up Linear issues" still reaches the proposal with the tool, and what the model wrote itself is kept.
 */
export function withAskedTools(ops: unknown, message: string, nodeNames: string[] = []): unknown {
  if (!Array.isArray(ops)) return ops;
  const ask = agentAsk(message, nodeNames);
  if (!ask || (!ask.tools.length && !ask.knowledge)) return ops;
  const fill = (spec: Record<string, unknown>) => ({
    ...spec,
    ...(ask.tools.length && !(Array.isArray(spec.tools) && spec.tools.length) && { tools: ask.tools }),
    ...(ask.knowledge && !(typeof spec.knowledge === 'string' && spec.knowledge.trim()) && { knowledge: ask.knowledge }),
  });
  return ops.map((op) => {
    const o = op as Record<string, unknown> | null;
    if (o?.op === 'newAgent') return fill(o);
    if (o?.op === 'addNode' && o.newAgent && typeof o.newAgent === 'object') return { ...o, newAgent: fill(o.newAgent as Record<string, unknown>) };
    return op;
  });
}

// AG04:
/** A change in words, as the first words of a clause: "add Slugify as a tool", "also send it to Slack", "use Haiku", "it should be shorter". */
const AG04_CHANGE =
  /^(?:(?:please|pls|kindly|ok(?:ay)?|so|hey|just|now|also|then|and|go ahead and|(?:can|could|would|will) (?:you|we)(?: please)?|i(?:'d| would)? (?:want|need|like)(?: you| it)? to|i (?:want|need)|let'?s)\b[,\s]*)*(?:add|remove|delete|drop|use|make|call|rename|change|set|switch|swap|replace|send|post|include|give|let|allow|stop|keep|enable|disable|limit|require|ask|connect|attach|tell|update|shorten|lengthen|extend|reduce|increase|turn|put|don't|do not|never|always|only|it should|it must|the agent should|the agent must)\b/i;

/**
 * What a message typed about an agent that exists (or a card not yet created) asks: `'question'` ("why does it need the Hash
 * tool?": answer it, change nothing), `'change'` ("add Slugify as a tool", "use Haiku", "call it Alert triager"), or undefined
 * (neither: "create an agent that …" is a new agent's ask, and anything else is left to the chat). Deterministic and pure,
 * like `askKind`: the model never decides it (docs/assistant.md "Changing an agent").
 */
export function agentChangeAsk(message: string): 'question' | 'change' | undefined {
  const text = message.trim();
  if (!text || agentAsk(text)) return undefined;
  if (askKind(text) === 'question') return 'question';
  return text.split(/[.!?\n;]+/).some((clause) => AG04_CHANGE.test(clause.trim()) || ALSO_DOES.test(clause.trim())) ? 'change' : undefined;
}

/** ag1-int: "also slugify titles in upper case": "also" and a verb the list above lacks (a tool's own verb) is a change too. */
const ALSO_DOES = /^also,?\s+(?!(?:thanks|thank|ok|okay|why|what|how|who|when|where|which|is|are|was|does|do|did|can|could|would|should|i|it'?s|this|that|the)\b)[a-z][a-z-]+\s+\S/i;
