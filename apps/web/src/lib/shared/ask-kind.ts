/**
 * What a typed message asks of Spotlight: a question (answer it, change nothing) or a change (docs/assistant.md, "A
 * question is answered"). Deterministic and pure: the model never decides it, and the browser and the server read the
 * same rules (contract: backbone/contracts/sb1/ask-kind.md, finding 2.1: "why did the last run fail?" rewrote the flow).
 */
export type AskKind = 'question' | 'change';

/** The verbs of a request, as the first word of a clause. */
const CHANGE_VERBS = [
  'fix', 'change', 'add', 'remove', 'delete', 'set', 'make', 'update', 'replace', 'connect', 'rename', 'retry', 'send', 'use', 'put', 'build', 'create', 'move', 'turn', 'give', 'attach',
  'insert', 'swap', 'disconnect', 'rewire', 'duplicate', 'copy', 'drop', 'wire', 'switch', 'enable', 'disable', 'apply', 'run', 'try', 'clear', 'increase', 'decrease', 'reduce', 'limit', 'filter',
  'split', 'merge', 'route', 'pass', 'call', 'point', 'configure', 'edit', 'modify', 'adjust', 'correct', 'extend', 'wrap', 'skip', 'stop', 'start', 'schedule', 'trigger', 'post', 'write', 'log', 'store', 'save', 'notify', 'alert', 'email',
];
const VERB = `(?:${CHANGE_VERBS.join('|')})`;
const IMPERATIVE = new RegExp(`^${VERB}\\b`);

/** Words that open a request without being the request: "please", "can you", "I want it to", "let's". */
const LEAD = /^(?:please|pls|kindly|ok(?:ay)?|so|hey|just|now|also|then|and|go ahead and|(?:can|could|would|will|shall) (?:you|we|i)(?: please)?|i(?:'d| would)? (?:want|need|like)(?: you| it| this| that| them)? to|i (?:want|need)|let'?s)\b[,\s]*/;

/** "it should retry", "the HTTP step must send…", "make sure …": a wish stated as a fact. */
const WISH = /^(?:(?:it|this|that|they|these|those|the [\w' -]{1,40}?) (?:should|must|needs? to|has to|have to|ought to)\b|make sure\b)/;

/** "what I want is a retry", "what we need is …": a wish stated as a fact. */
const WANT = /^what (?:i|we) (?:want|need)(?: it| this| them)?(?: to do)? is\b/;

/** Words that are a question wherever they open a clause. */
const QUESTION_WORD = /^(?:why|what|how|which|who|whose|explain|tell me|show me why)\b/;
/** "when did it fail", "where is the webhook": an auxiliary right after; "when the total is over 100, …" is a condition. */
const WH_AUX = /^(?:when|where)\s+(?:did|does|do|is|are|was|were|will|can|could|should|would|has|have)\b/;
/** Third-person auxiliaries read as a question without a "?" ("does Check total run twice"), unless negated. */
const AUX_SUBJECT = /^(?:is|are|was|were|does|did|has)\b(?!\s+not\b)(?!\s+to\b)(?!\s+\w+ing\b)/;
type Clause = 'change' | 'question' | 'other';

function isChange(part: string): boolean {
  const clause = part.trim().toLowerCase().replace(/^["'“‘(\s]+/, '');
  if (!clause) return false;
  if (WISH.test(clause) || WANT.test(clause)) return true;
  // Strip the lead-ins, then the imperative stands at the start.
  let rest = clause;
  for (let i = 0; i < 4; i++) {
    const next = rest.replace(LEAD, '');
    if (next === rest) break;
    rest = next;
  }
  return IMPERATIVE.test(rest) || WISH.test(rest);
}

function clauseKind(raw: string): Clause {
  const clause = raw.trim().toLowerCase().replace(/^["'“‘(\s]+/, '');
  if (!clause) return 'other';
  // "when it fails, retry 3 times", "where it says #bugs, change it": a comma clause that is a request makes it a change.
  if (clause.split(/,\s*/).some(isChange)) return 'change';
  const marked = raw.trim().endsWith('?');
  if (QUESTION_WORD.test(clause) || WH_AUX.test(clause) || AUX_SUBJECT.test(clause) || marked) return 'question';
  return 'other';
}

/** What the person's message asks for. Deterministic: the model never decides it. */
export function askKind(message: string): AskKind {
  const text = message.trim();
  if (!text) return 'change';
  // One clause per sentence, per "label: request" and per "…, and then …"; a "?" stays with the clause it ends.
  const clauses: string[] = [];
  for (const sentence of text.match(/[^.!?\n:;]+[.!?\n:;]*/g) ?? []) {
    const parts = sentence.split(new RegExp(`,\\s*(?:and|then|also)\\s+|\\s+and then\\s+|\\s+and\\s+(?=(?:${CHANGE_VERBS.join('|')}|please|can you|could you)\\b)`, 'i')).map((c) => c.trim());
    if (/\?\s*$/.test(sentence)) parts[parts.length - 1] += '?';
    clauses.push(...parts.map((c) => c.replace(/[.!\n:;]+$/, '')).filter((c) => c.replace(/[?\s]/g, '')));
  }
  const kinds = clauses.map(clauseKind);
  if (kinds.includes('change')) return 'change';
  if (!kinds.includes('question')) return 'change';
  // A question with something unclear beside it is not a question that may drop it ("why did it fail? the one at noon" is fine, a longer rider is not).
  const riders = clauses.filter((_, i) => kinds[i] === 'other');
  return riders.some((c) => c.split(/\s+/).length > 2) ? 'change' : 'question';
}
