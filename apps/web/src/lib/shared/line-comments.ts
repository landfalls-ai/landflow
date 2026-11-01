/**
 * Comments a person leaves on lines of a diff in the Artifacts tab. They are kept in that browser per run and go out as
 * the note of the Run report's Send back, one line each, so the agents that fix the work read where and what.
 */
export interface LineComment {
  id: string;
  path: string;
  /** Which side's line number: the new file's, or the old one's for a removed line. */
  side: 'new' | 'old';
  line: number;
  /** The line's text, so the note says which line even when numbers moved. */
  quote: string;
  text: string;
  at: string;
}

const QUOTE = 80;

/** The note for Send back: a heading, then `path line N (`quote`): comment` per comment, by file and line. */
export function lineCommentsNote(comments: LineComment[]): string {
  if (!comments.length) return '';
  const sorted = [...comments].sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
  const lines = sorted.map((c) => {
    const quote = c.quote.trim();
    const shown = quote.length > QUOTE ? `${quote.slice(0, QUOTE - 1)}…` : quote;
    return `- ${c.path} ${c.side === 'old' ? 'removed line' : 'line'} ${c.line}${shown ? ` (\`${shown.replace(/`/g, "'")}\`)` : ''}: ${c.text.trim()}`;
  });
  return `Line comments:\n${lines.join('\n')}`;
}

/** The comments that belong on this line of this file: same side, number and text. */
export const commentsOn = (comments: LineComment[], path: string, side: LineComment['side'], line: number, text: string) =>
  comments.filter((c) => c.path === path && c.side === side && c.line === line && c.quote === text);
