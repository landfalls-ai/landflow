/**
 * C20: content-defined sections. The recursive splitter packs pieces greedily from the start of a text, so a paragraph
 * inserted near the top moves every later chunk boundary and no later chunk keeps its text (and so its embedding).
 * Cutting the text into sections first, at points chosen by the content of the blocks there and not by a running
 * count, makes the cuts after an edit land where they did before: only the sections around the edit change, and
 * the splitter runs inside each section. Used by the paths that diff (folder indexing, the Notion walk); the Vector
 * Store node keeps the splitter sub-node it is given.
 */
import { recursiveCharacterSplit, type SplitOptions } from './splitters';

/** A section ends before a block once it holds this many characters and the block's hash says "cut here"... */
export const SECTION_MIN = 2000;
/** ...or when the next block would push it past this many. */
export const SECTION_MAX = 6000;
/**
 * A heading starts a section once the one before it holds this many characters. Cutting at every heading would split a
 * short runbook into one-line chunks that answer nothing alone (and a short file would stop being one chunk, as it was).
 */
export const HEADING_MIN = 800;
/** A block's FNV-1a hash is a cut point when its low byte is below this (one block in four). */
const CUT_BELOW = 0x40;

/** 32-bit FNV-1a of a string. */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

const isHeading = (block: string) => /^#{1,6}\s/.test(block);

/**
 * Cut `text` into sections at block (blank-line) boundaries. A Markdown heading starts a section once the one before it holds HEADING_MIN characters; otherwise a
 * section ends before a block once it holds SECTION_MIN characters and that block's hash is a cut point, or when
 * the block would pass SECTION_MAX. Deterministic: the same blocks give the same cuts. A single block longer than
 * SECTION_MAX stays whole (the splitter cuts it later).
 */
export function contentSections(text: string): string[] {
  const blocks = text.split(/\n[ \t]*\n+/).map((block) => block.trim()).filter(Boolean);
  const sections: string[] = [];
  let current: string[] = [];
  let length = 0;
  const flush = () => {
    if (current.length) sections.push(current.join('\n\n'));
    current = [];
    length = 0;
  };
  for (const block of blocks) {
    const joined = length + block.length + (current.length ? 2 : 0);
    const cut = current.length > 0 && ((isHeading(block) && length >= HEADING_MIN) || joined > SECTION_MAX || (length >= SECTION_MIN && (fnv1a(block) & 0xff) < CUT_BELOW));
    if (cut) flush();
    current.push(block);
    length += block.length + (current.length > 1 ? 2 : 0);
  }
  flush();
  return sections;
}

/** The recursive splitter run on each section, flattened: chunks of the same size as before, boundaries that hold still. */
export function stableChunks(text: string, options: SplitOptions): string[] {
  return contentSections(text).flatMap((section) => recursiveCharacterSplit(section, options));
}
