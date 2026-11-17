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

function toolsOf(message: string): string[] {
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

/** The job after "that|which|to": "reviews pull requests against our practices". */
function jobOf(message: string): string {
  const after = /\b(?:agent|assistant)\s+(?:that|which|to|who)\s+([^.!?\n]+)/i.exec(message) ?? /\b(?:that|which|who)\s+([^.!?\n]+)/i.exec(message);
  return (after?.[1] ?? '').split(/,\s*(?:and\s+)?(?:then\s+)?(?:run|put|add|place|insert|make|use)\b/i)[0].trim();
}

/** A short name from the job: "PR reviewer", "Docs answerer", "Incident summariser"; none when the job names no thing. */
function nameOf(job: string, knowledge: string | undefined): string | undefined {
  const m = /^([a-z]+?)(?:e?s)?\s+(?:(?:the|our|all|any|each|every|new|open|incoming|customer|support)\s+)*([a-z-]+(?:\s+[a-z-]+)?)/i.exec(job.toLowerCase());
  if (!m) return undefined;
  const verb = Object.keys(AGENT_NOUN).find((v) => m[1].startsWith(v) || (m[1].length >= 4 && v.startsWith(m[1])));
  if (!verb) return undefined;
  const role = AGENT_NOUN[verb];
  // "answers customer questions from the docs" is the Docs answerer; "reviews pull requests" the PR reviewer.
  if (verb === 'answer' && knowledge) return cap(`${knowledge.split(/\s+/).pop()} ${role}`).slice(0, 40);
  const words = m[2].split(/\s+/);
  let subject = words.filter((w) => !NOUN_STOP.has(w) && !/^(?:against|about|into|by|of|at|it|them|this|these|those|each|everything|anything)$/.test(w))[0] ?? '';
  if (/^pull$/.test(subject)) subject = 'PR';
  else subject = subject.replace(/ies$/, 'y').replace(/(?<=[^s])s$/, '');
  if (/^(?:pr|ci|qa|ui|api|sla|crm|seo|hr)$/i.test(subject)) subject = subject.toUpperCase();
  return subject ? `${subject[0].toUpperCase()}${subject.slice(1)} ${role}`.slice(0, 40) : undefined;
}

/** What the person asked for, as a sentence: without the "create an agent that" lead and the placement clause. */
function descriptionOf(message: string, job: string): string {
  const text = (job || message.trim().replace(new RegExp(`^.*?${CREATE}${OBJECT}\\s*(?:called|named)?\\s*`, 'i'), '')).replace(/\s+/g, ' ').trim() || message.trim();
  const sentence = text.replace(/[.!?]+$/, '');
  return `${cap(sentence)}.`.slice(0, 500);
}

/**
 * Whether `message` asks for an agent, and what it says about it. `nodeNames` are the steps on the canvas (an empty
 * canvas has none, so nothing is placed by name).
 */
export function agentAsk(message: string, nodeNames: string[] = []): AgentAsk | undefined {
  const full = message.trim();
  // "create a new agent named Sales helper that …": the name is the person's own, and the rest reads as "an agent that …".
  const named = /\b(?:named|called)\s+["“'‘]?([^"”'’,.!?\n]{2,40}?)["”'’]?\s+(?=that\b|which\b|who\b|to\b)/i.exec(full);
  const text = named ? full.replace(named[0], '') : full;
  if (!text || askKind(text) === 'question') return undefined;
  if (!AS_OBJECT.test(text) && !AS_SUBJECT.test(text)) return undefined;
  const knowledge = knowledgeOf(text);
  const job = jobOf(text);
  const name = named ? named[1].trim() : nameOf(job, knowledge);
  return { ...(name && { name }), description: descriptionOf(text, job), placed: isPlaced(text, nodeNames), tools: toolsOf(text), ...(knowledge && { knowledge }) };
}

/** A name for the card when the ask gave none (the design route keeps the name it is sent): "Weekly report agent". */
export function fallbackName(description: string): string {
  const skip = /^(?:a|an|the|our|its|my|your|their|with|for|to|of|in|on|from|and|or|that|which|about|it|them|new|any|all)$/;
  const words = description.replace(/[.!?]+$/, '').toLowerCase().split(/\s+/).slice(1).filter((w) => w && !skip.test(w)).slice(0, 2);
  return words.length ? `${cap(words.join(' '))} agent`.slice(0, 40) : 'New agent';
}

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
  return text.split(/[.!?\n;]+/).some((clause) => AG04_CHANGE.test(clause.trim())) ? 'change' : undefined;
}
