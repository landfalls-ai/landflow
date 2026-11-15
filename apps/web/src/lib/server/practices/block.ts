/**
 * The one block (docs/practices.md#how-agents-get-them): the text every path that gives practices to an agent says them
 * with. Pure. A summary is cleaned again here, whoever wrote it: a rule is text an agent reads, so it never carries a
 * secret, a heading, a quote or a fence that could pass for the prompt around it.
 */
import { PRACTICES_FOOTER, PRACTICES_HEADING, practiceLine, type PracticeStrength } from '../../shared/practices';
import { redactText, redactPatterns } from '../secrets/redact';

export interface BlockPractice {
  handle: string;
  version: number;
  strength: PracticeStrength;
  summary: string;
}

/** Control characters (and the Unicode line and paragraph separators) removed; tabs and line breaks stay, for the caller to turn into spaces. */
function stripControl(text: string): string {
  let out = '';
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (ch === '\n' || ch === '\r' || ch === '\t' || (c >= 0x20 && c !== 0x7f && !(c >= 0x80 && c <= 0x9f) && c !== 0x2028 && c !== 0x2029 && !(c >= 0x200b && c <= 0x200f) && !(c >= 0x202a && c <= 0x202e) && !(c >= 0x2060 && c <= 0x2069) && c !== 0xfeff)) out += ch;
  }
  return out;
}

/** A summary as one safe line of the block. */
export function cleanSummary(summary: string): string {
  const text = redactPatterns(redactText(stripControl(summary).replace(/[\r\n\t]+/g, ' ')))
    .replace(/^[\s#>-]+/, '')
    .replace(/```/g, "'''")
    .replace(/ {2,}/g, ' ');
  return text.trim();
}

/** The block for `list` (already in rank order) within `budget` characters; a line that does not fit is left out whole and counted. */
export function practicesBlock<T extends BlockPractice>(list: readonly T[], budget: number): { text: string; included: T[]; omitted: number } {
  if (!list.length) return { text: '', included: [], omitted: 0 };
  let used = PRACTICES_HEADING.length + PRACTICES_FOOTER.length + 2;
  const included: T[] = [];
  const lines: string[] = [];
  for (const p of list) {
    const line = practiceLine({ handle: p.handle, version: p.version, strength: p.strength, summary: cleanSummary(p.summary) });
    if (used + line.length + 1 > budget) continue;
    used += line.length + 1;
    included.push(p);
    lines.push(line);
  }
  if (!included.length) return { text: '', included: [], omitted: list.length };
  return { text: [PRACTICES_HEADING, ...lines, PRACTICES_FOOTER].join('\n'), included, omitted: list.length - included.length };
}
