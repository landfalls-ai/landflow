/**
 * Text splitters for RAG (the Recursive Character and Token Text Splitter
 * sub-nodes). The recursive splitter follows LangChain's algorithm, which n8n
 * uses: split on the first separator that occurs, merge the pieces back into
 * chunks of at most `chunkSize` characters with `chunkOverlap` characters
 * carried over, and recurse into pieces that are still too long with the next
 * separator. The token splitter counts approximate tokens (a GPT-style
 * pre-tokenizer, not an exact BPE vocabulary) so it needs no model files.
 */

export interface SplitOptions {
  /** Maximum chunk length: characters (recursive) or tokens (token splitter). */
  chunkSize: number;
  /** How much of the previous chunk the next one repeats. Must be smaller than `chunkSize`. */
  chunkOverlap: number;
}

export interface RecursiveSplitOptions extends SplitOptions {
  /** Tried in order; '' splits between characters. Default: paragraphs, lines, words, characters. */
  separators?: string[];
  /** Keep each separator at the start of the piece it precedes (LangChain's default) instead of dropping it. */
  keepSeparator?: boolean;
}

export const DEFAULT_SEPARATORS = ['\n\n', '\n', ' ', ''];

/** Separator presets of the "Split Code" option (LangChain's language lists). */
export const CODE_SEPARATORS: Record<string, string[]> = {
  markdown: ['\n## ', '\n### ', '\n#### ', '\n##### ', '\n###### ', '```\n\n', '\n\n***\n\n', '\n\n---\n\n', '\n\n___\n\n', '\n\n', '\n', ' ', ''],
  js: ['\nfunction ', '\nconst ', '\nlet ', '\nvar ', '\nclass ', '\nif ', '\nfor ', '\nwhile ', '\nswitch ', '\ncase ', '\ndefault ', '\n\n', '\n', ' ', ''],
  python: ['\nclass ', '\ndef ', '\n\tdef ', '\n\n', '\n', ' ', ''],
  go: ['\nfunc ', '\nvar ', '\nconst ', '\ntype ', '\nif ', '\nfor ', '\nswitch ', '\ncase ', '\n\n', '\n', ' ', ''],
  html: ['<body', '<div', '<p', '<br', '<li', '<h1', '<h2', '<h3', '<h4', '<h5', '<h6', '<span', '<table', '<tr', '<td', '<th', '<ul', '<ol', '<header', '<footer', '<nav', '<head', '<style', '<script', '<meta', '<title', ''],
};

function checkOptions({ chunkSize, chunkOverlap }: SplitOptions) {
  if (!Number.isFinite(chunkSize) || chunkSize < 1) throw new Error(`Chunk size must be at least 1 (got ${chunkSize})`);
  if (!Number.isFinite(chunkOverlap) || chunkOverlap < 0) throw new Error(`Chunk overlap can't be negative (got ${chunkOverlap})`);
  if (chunkOverlap >= chunkSize) throw new Error(`Chunk overlap (${chunkOverlap}) must be smaller than the chunk size (${chunkSize})`);
}

/** Split `text` on `separator`; with `keep`, each separator stays at the start of the piece after it. */
function splitOn(text: string, separator: string, keep: boolean): string[] {
  if (separator === '') return [...text];
  const parts = text.split(separator);
  const pieces = keep ? parts.map((part, i) => (i ? separator + part : part)) : parts;
  return pieces.filter((piece) => piece !== '');
}

/** Merge small pieces into chunks of at most `chunkSize`, carrying `chunkOverlap` over (LangChain's mergeSplits). */
function mergePieces(pieces: string[], separator: string, { chunkSize, chunkOverlap }: SplitOptions): string[] {
  const chunks: string[] = [];
  const current: string[] = [];
  let total = 0;
  const join = () => current.join(separator).trim();
  for (const piece of pieces) {
    const extra = current.length ? separator.length : 0;
    if (total + piece.length + extra > chunkSize && current.length) {
      const chunk = join();
      if (chunk) chunks.push(chunk);
      // Drop pieces from the front until what is left fits the overlap and leaves room for the new piece.
      while (current.length && (total > chunkOverlap || total + piece.length + (current.length ? separator.length : 0) > chunkSize)) {
        total -= current[0].length + (current.length > 1 ? separator.length : 0);
        current.shift();
      }
    }
    current.push(piece);
    total += piece.length + (current.length > 1 ? separator.length : 0);
  }
  const last = join();
  if (last) chunks.push(last);
  return chunks;
}

function splitRecursive(text: string, separators: string[], options: RecursiveSplitOptions): string[] {
  const keep = options.keepSeparator ?? true;
  let separator = separators[separators.length - 1] ?? '';
  let rest: string[] = [];
  for (const [i, candidate] of separators.entries()) {
    if (candidate === '' || text.includes(candidate)) {
      separator = candidate;
      rest = separators.slice(i + 1);
      break;
    }
  }
  const joiner = keep ? '' : separator;
  const chunks: string[] = [];
  let small: string[] = [];
  for (const piece of splitOn(text, separator, keep)) {
    if (piece.length < options.chunkSize) {
      small.push(piece);
      continue;
    }
    if (small.length) chunks.push(...mergePieces(small, joiner, options));
    small = [];
    if (rest.length) chunks.push(...splitRecursive(piece, rest, options));
    else chunks.push(piece.trim());
  }
  if (small.length) chunks.push(...mergePieces(small, joiner, options));
  return chunks.filter(Boolean);
}

/** Recursive character splitting: chunks of at most `chunkSize` characters, cut at the coarsest separator that works. */
export function recursiveCharacterSplit(text: string, options: RecursiveSplitOptions): string[] {
  checkOptions(options);
  if (!text.trim()) return [];
  return splitRecursive(text, options.separators?.length ? options.separators : DEFAULT_SEPARATORS, options);
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

/** GPT-2 / cl100k-style pre-tokenization: contractions, words, numbers, punctuation runs and whitespace. */
const PRE_TOKEN = /'(?:[sdmt]|ll|ve|re)| ?\p{L}+| ?\p{N}{1,3}| ?[^\s\p{L}\p{N}]+|\s+(?!\S)|\s+/gu;
/** Longer words are several tokens in a real BPE vocabulary; counting them in pieces keeps the estimate close. */
const MAX_TOKEN_CHARS = 8;

/** Approximate tokens of `text`; joined, they give back the text exactly. */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  for (const [match] of text.matchAll(PRE_TOKEN)) {
    for (let start = 0; start < match.length; start += MAX_TOKEN_CHARS) tokens.push(match.slice(start, start + MAX_TOKEN_CHARS));
  }
  return tokens;
}

/** Token splitting: windows of `chunkSize` approximate tokens, each starting `chunkSize - chunkOverlap` tokens after the previous one. */
export function tokenSplit(text: string, options: SplitOptions): string[] {
  checkOptions(options);
  const tokens = tokenize(text);
  const chunks: string[] = [];
  const step = options.chunkSize - options.chunkOverlap;
  for (let start = 0; start < tokens.length; start += step) {
    const chunk = tokens.slice(start, start + options.chunkSize).join('').trim();
    if (chunk) chunks.push(chunk);
    if (start + options.chunkSize >= tokens.length) break;
  }
  return chunks;
}
