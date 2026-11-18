/**
 * AG24 (wave ag5): the rules a designed test case follows after the model wrote it, pure and deterministic. A case for an agent
 * that reads data or documents asks for what its tool holds without stating it (the live run's replacement cases put *North £120k,
 * South £80k* in the question, so they tested copying, not the tool), is never a removed case again, and names only what the
 * agent's own sources hold (a runbook its folder lacks held the gate at 3.0). The design route calls `checkCases`.
 */
import type { AgentCaseDraft } from '../../shared/agent-card';
import type { AgentConfig, KnowledgeBaseToolConfig } from '../../shared/agents';

/** An agent with a data or knowledge tool: a read node (databases), a knowledge base or an MCP server. */
export function isDataAgent(config: Partial<AgentConfig>): boolean {
  return (config.tools ?? []).some((t) => t.type === 'knowledge' || t.type === 'mcp' || (t.type === 'node' && /^databases\./.test(t.nodeType)));
}

/** A case's input in one form: lower case, quotes and punctuation folded, spaces collapsed. */
export const foldInput = (input: string): string =>
  input
    .toLowerCase()
    .replace(/[‘’“”"'`]/g, '')
    .replace(/[^a-z0-9£$€%\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const KILO = '[kmb]';
/** The figures a text states: currency amounts, percentages, and numbers of two or more digits (a plain year is a date, not a figure). */
export function figuresOf(text: string): { all: Set<string>; money: Set<string> } {
  const all = new Set<string>();
  const money = new Set<string>();
  const norm = (v: string) => v.toLowerCase().replace(/[\s,]/g, '').replace(/[.]+$/, '');
  for (const m of text.matchAll(new RegExp(`[£$€]\\s?\\d[\\d,.]*(?:\\s?${KILO}\\b)?`, 'gi'))) {
    all.add(norm(m[0]));
    money.add(norm(m[0]));
  }
  for (const m of text.matchAll(/\d[\d,.]*\s?%/g)) {
    all.add(norm(m[0]));
    money.add(norm(m[0]));
  }
  for (const m of text.matchAll(new RegExp(`\\d[\\d,.]*(?:\\s?${KILO}\\b)?`, 'gi'))) {
    const v = norm(m[0]);
    if (v.replace(/\D/g, '').length < 2) continue;
    if (/^(?:19|20)\d{2}$/.test(v)) continue;
    all.add(v);
  }
  // the number inside a currency amount or a percentage counts once, as the amount
  for (const v of [...all]) if (!/^[£$€]/.test(v) && !v.endsWith('%') && [...money].some((x) => x.replace(/^[£$€]/, '').replace(/%$/, '') === v)) all.delete(v);
  return { all, money };
}

const DOCUMENT_NOUN = /\b((?:[A-Za-z][\w-]*\s+){0,3}?)(runbooks?|playbooks?|policy|policies|handbook|guide|procedure|contract|manual|SOP|spec(?:ification)?|report|memo)\b/gi;
const FILLER = new Set('the and for with our your its that this what does say about from into how when which per any all are was has have not but one two their there tell what whats'.split(' '));
const words = (v: string) => v.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !FILLER.has(w));

/** The documents a text names ("the payments runbook"): the words before the noun that say which one. Empty for "the runbook" alone. */
function namedDocuments(text: string): string[][] {
  const out: string[][] = [];
  for (const m of text.matchAll(DOCUMENT_NOUN)) {
    const before = words(m[1] ?? '').filter((w) => !/^(?:read|find|check|search|summari[sz]e|explain|show|give|list|open|use)$/.test(w));
    if (before.length) out.push(before);
  }
  return out;
}

export interface CaseCheck {
  kept: AgentCaseDraft[];
  dropped: Array<{ input: string; reason: string }>;
}

/**
 * The cases that stay. `removedInputs` are the inputs of the cases this change removes (never written again); `titles` are the file
 * names of the agent's knowledge base (absent when not read: nothing is judged by them).
 */
export function checkCases(cases: AgentCaseDraft[], context: { config: Partial<AgentConfig>; removedInputs?: string[]; titles?: string[] }): CaseCheck {
  const removed = new Set((context.removedInputs ?? []).map(foldInput));
  const data = isDataAgent(context.config);
  const titleWords = context.titles ? new Set(context.titles.flatMap((t) => words(t.replace(/\.[a-z0-9]{1,5}$/i, '')))) : undefined;
  const kept: AgentCaseDraft[] = [];
  const dropped: CaseCheck['dropped'] = [];
  for (const c of cases) {
    const drop = (reason: string) => dropped.push({ input: c.input, reason });
    if (removed.has(foldInput(c.input))) {
      drop('it is a case this change removes, written again');
      continue;
    }
    if (data) {
      const asked = figuresOf(c.input);
      const answered = figuresOf(c.expected ?? '');
      const shared = [...asked.all].filter((f) => answered.all.has(f));
      if (shared.length) {
        drop(`its question states ${shared.slice(0, 3).join(', ')}, which the answer repeats: a data agent's case asks for what its tool holds, never states it`);
        continue;
      }
      const invented = [...answered.money].filter((f) => !asked.money.has(f));
      if (invented.length) {
        drop(`its answer gives ${invented.slice(0, 3).join(', ')}, figures nobody knows: say it reads them from the tool`);
        continue;
      }
    }
    if (titleWords) {
      const lacking = [...namedDocuments(c.input), ...namedDocuments(c.expected ?? '')].find((doc) => doc.every((w) => !titleWords.has(w) && ![...titleWords].some((t) => t.startsWith(w) || w.startsWith(t))));
      if (lacking) {
        drop(`it names a document (${lacking.join(' ')}) that the knowledge base does not hold`);
        continue;
      }
    }
    kept.push(c);
  }
  return { kept, dropped };
}

/** The file names of an agent's knowledge bases (the collections it searches), or undefined when none can be read. */
export async function sourceTitles(config: Partial<AgentConfig>, read: (tool: KnowledgeBaseToolConfig) => Promise<string[]>): Promise<string[] | undefined> {
  const tools = (config.tools ?? []).filter((t): t is KnowledgeBaseToolConfig => t.type === 'knowledge');
  if (!tools.length) return undefined;
  const titles: string[] = [];
  for (const tool of tools) {
    try {
      titles.push(...(await read(tool)));
    } catch {
      return undefined; // a source that cannot be read judges nothing
    }
  }
  return titles.length ? titles : undefined;
}
