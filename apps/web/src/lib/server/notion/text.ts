/** Rich text and Markdown limits of the Notion API (docs/features/notion-brain.md#how-landflow-talks-to-notion). */
import type { NotionRichText } from './port';

export const RICH_TEXT_RUN = 2000;
export const RICH_TEXT_RUNS = 100;
export const MARKDOWN_BLOCKS = 4500;
export const MARKDOWN_BYTES = 450_000;
export const CUT_LINE = 'Cut here: the rest is in Landflow';

/** Rich text for a property: runs of at most 2,000 characters, at most 100 runs; beyond that the text is cut with "…". */
export function richText(text: string): Array<{ type: 'text'; text: { content: string } }> {
  const chars = Array.from(text ?? '');
  const runs: string[] = [];
  for (let i = 0; i < chars.length; i += RICH_TEXT_RUN) runs.push(chars.slice(i, i + RICH_TEXT_RUN).join(''));
  if (runs.length > RICH_TEXT_RUNS) {
    runs.length = RICH_TEXT_RUNS;
    const last = Array.from(runs[RICH_TEXT_RUNS - 1]);
    runs[RICH_TEXT_RUNS - 1] = `${last.slice(0, RICH_TEXT_RUN - 1).join('')}…`;
  }
  return runs.map((content) => ({ type: 'text' as const, text: { content } }));
}

/** The text of rich text: Notion's `plain_text`, else the run's own content. */
export function plainText(rich: NotionRichText[] | undefined | null): string {
  return (rich ?? []).map((run) => run.plain_text ?? run.text?.content ?? '').join('');
}

const blocksOf = (lines: string[]) => lines.filter((line) => line.trim()).length;

/**
 * A page body that fits Notion's limits (about 4,500 blocks, 450 KB): longer text is cut at the last heading before the
 * limit (or at the limit when there is none) and ends with the line "Cut here: the rest is in Landflow".
 */
export function fitMarkdown(markdown: string): string {
  const lines = markdown.split('\n');
  if (blocksOf(lines) <= MARKDOWN_BLOCKS && Buffer.byteLength(markdown) <= MARKDOWN_BYTES) return markdown;
  let blocks = 0;
  let bytes = 0;
  let end = lines.length;
  let heading = -1;
  for (let i = 0; i < lines.length; i++) {
    const cost = Buffer.byteLength(lines[i]) + 1;
    if (lines[i].trim() && blocks + 1 > MARKDOWN_BLOCKS - 1) { end = i; break; }
    if (bytes + cost > MARKDOWN_BYTES - Buffer.byteLength(CUT_LINE) - 2) { end = i; break; }
    if (lines[i].trim()) blocks++;
    bytes += cost;
    if (/^#{1,6}\s/.test(lines[i])) heading = i;
  }
  const cutAt = heading > 0 ? heading : end;
  return `${lines.slice(0, cutAt).join('\n').replace(/\s+$/, '')}\n\n${CUT_LINE}\n`;
}
