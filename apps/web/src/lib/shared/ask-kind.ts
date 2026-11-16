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
  'split', 'merge', 'route', 'pass', 'call', 'point', 'configure', 'edit', 'modify', 'adjust', 'correct', 'extend', 'wrap', 'skip', 'stop', 'start', 'schedule', 'trigger', 'post', 'write',
];
const VERB = `(?:${CHANGE_VERBS.join('|')})`;
const IMPERATIVE = new RegExp(`^${VERB}\\b`);

/** Words that open a request without being the request: "please", "can you", "I want it to", "let's". */
const LEAD = /^(?:please|pls|kindly|ok(?:ay)?|so|hey|just|now|also|then|and|go ahead and|(?:can|could|would|will) you(?: please)?|i(?:'d| would)? (?:want|need|like)(?: you| it| this| that| them)? to|i (?:want|need)|let'?s)\b[,\s]*/;

/** "it should retry", "the HTTP step must send…", "make sure …": a wish stated as a fact. */
const WISH = /^(?:(?:it|this|that|they|these|those|the [\w' -]{1,40}?) (?:should|must|needs? to|has to|have to|ought to)\b|make sure\b)/;

const QUESTION_START = /^(?:why|what|how|which|where|when|who|whose|is|are|was|were|does|do|did|has|have|should|could|would|can|explain|tell me|show me why)\b/;

type Clause = 'change' | 'question' | 'other';

function clauseKind(raw: string): Clause {
  let clause = raw.trim().toLowerCase().replace(/^["'“‘(\s]+/, '');
  if (!clause) return 'other';
  if (WISH.test(clause)) return 'change';
  // Strip the lead-ins, then the imperative stands at the start.
  let rest = clause;
  for (let i = 0; i < 4; i++) {
    const next = rest.replace(LEAD, '');
    if (next === rest) break;
    rest = next;
  }
  if (IMPERATIVE.test(rest) || WISH.test(rest)) return 'change';
  if (QUESTION_START.test(clause) || raw.trim().endsWith('?')) return 'question';
  return 'other';
}

/** What the person's message asks for. Deterministic: the model never decides it. */
export function askKind(message: string): AskKind {
  const text = message.trim();
  if (!text) return 'change';
  // One clause per sentence, per "label: request" and per "…, and then …".
  const clauses = text
    .split(/[.!?\n:;]+|,\s*(?:and|then|also)\s+|\s+and then\s+/i)
    .map((c) => c.trim())
    .filter(Boolean);
  const kinds = clauses.map((c, i) => clauseKind(i === clauses.length - 1 && text.endsWith('?') ? `${c}?` : c));
  if (kinds.includes('change')) return 'change';
  if (!kinds.includes('question')) return 'change';
  // A question with something unclear beside it is not a question that may drop it ("why did it fail? the one at noon" is fine, a longer rider is not).
  const riders = clauses.filter((_, i) => kinds[i] === 'other');
  return riders.some((c) => c.split(/\s+/).length > 2) ? 'change' : 'question';
}
