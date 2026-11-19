/** Rich text and Markdown limits of the Notion API (docs/features/notion-brain.md#how-landflow-talks-to-notion). */
import type { NotionRichText } from './port';

export const RICH_TEXT_RUN = 2000;
export const RICH_TEXT_RUNS = 100;
export const MARKDOWN_BLOCKS = 4500;
export const MARKDOWN_BYTES = 450_000;
export const CUT_LINE = 'Cut here: the rest is in Landflow';

/**
 * Rich text for a property: runs of at most 2,000 characters, at most 100 runs; beyond that the text is cut with "…".
 * A run's length is counted as Notion counts it (UTF-16 units, JavaScript's `.length`), so a run of emoji is not twice too
 * long, and a run never ends inside a surrogate pair.
 */
export function richText(text: string): Array<{ type: 'text'; text: { content: string } }> {
  const runs: string[] = [];
  let run = '';
  for (const char of text ?? '') {
    if (run.length + char.length > RICH_TEXT_RUN) {
      runs.push(run);
      run = '';
      if (runs.length > RICH_TEXT_RUNS) break;
    }
    run += char;
  }
  if (run && runs.length <= RICH_TEXT_RUNS) runs.push(run);
  if (runs.length > RICH_TEXT_RUNS) {
    runs.length = RICH_TEXT_RUNS;
    let last = runs[RICH_TEXT_RUNS - 1];
    while (last.length > RICH_TEXT_RUN - 1) last = Array.from(last).slice(0, -1).join('');
    runs[RICH_TEXT_RUNS - 1] = `${last}…`;
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
  // NB04: a `# comment` inside a fenced code block reads as a heading, and a cut inside a fence would leave it open.
  let fenceStart = -1;
  let fenceAtEnd = -1;
  let fenceMarker = '```';
  for (let i = 0; i < lines.length; i++) {
    const cost = Buffer.byteLength(lines[i]) + 1;
    if (lines[i].trim() && blocks + 1 > MARKDOWN_BLOCKS - 1) { end = i; fenceAtEnd = fenceStart; break; }
    if (bytes + cost > MARKDOWN_BYTES - Buffer.byteLength(CUT_LINE) - 2) { end = i; fenceAtEnd = fenceStart; break; }
    if (lines[i].trim()) blocks++;
    bytes += cost;
    const fence = /^\s*(```|~~~)/.exec(lines[i]);
    if (fence) {
      if (fenceStart < 0) fenceMarker = fence[1];
      fenceStart = fenceStart < 0 ? i : -1;
    }
    else if (fenceStart < 0 && /^#{1,6}\s/.test(lines[i])) heading = i;
  }
  if (heading > 0 && (fenceAtEnd < 0 || heading < fenceAtEnd)) return `${lines.slice(0, heading).join('\n').replace(/\s+$/, '')}\n\n${CUT_LINE}\n`;
  if (fenceAtEnd > 0) return `${lines.slice(0, fenceAtEnd).join('\n').replace(/\s+$/, '')}\n\n${CUT_LINE}\n`;
  const kept = lines.slice(0, end).join('\n').replace(/\s+$/, '');
  return `${kept}${fenceAtEnd === 0 ? `\n${fenceMarker}` : ''}\n\n${CUT_LINE}\n`;
}
