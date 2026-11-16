/**
 * A byte-level BPE in TypeScript (the GPT-2 family: Qwen, Llama 3), built from the vocabulary Ollama's
 * `POST /api/show {"verbose": true}` returns (`tokenizer.ggml.tokens` and `tokenizer.ggml.merges`). It counts tokens of
 * the model's own tokenizer, with no network. No text is kept past a `count()` call (the memo of repeated pre-tokens lives for
 * one call). Special tokens in a text are counted as plain text. A single pre-token longer than `SLICE` characters (an
 * unbroken run of letters, spaces or CJK) is counted in fixed slices, so a piece costs time linear in its length, never
 * quadratic; the error is a few tokens at each cut.
 *
 * Only the pre-tokenizers named in `PRE_PATTERNS` are known; any other `tokenizer.ggml.pre` is not counted (the caller
 * falls back to an estimate).
 */

/** GPT-2's byte-to-unicode table: every byte has a printable symbol, so a vocabulary is a list of strings. */
const BYTE_SYMBOLS: string[] = (() => {
  const keep = new Set<number>();
  for (let b = 0x21; b <= 0x7e; b++) keep.add(b);
  for (let b = 0xa1; b <= 0xac; b++) keep.add(b);
  for (let b = 0xae; b <= 0xff; b++) keep.add(b);
  const table: string[] = [];
  let extra = 0;
  for (let b = 0; b < 256; b++) table.push(String.fromCodePoint(keep.has(b) ? b : 256 + extra++));
  return table;
})();

// The contractions are spelled out because inline `(?i:...)` groups are not in every Node.
const CONTRACTION = "(?:'[sS]|'[tT]|'[rR][eE]|'[vV][eE]|'[mM]|'[lL][lL]|'[dD])";
const TAIL = '[^\\r\\n\\p{L}\\p{N}]?\\p{L}+';
const SYMBOLS = ' ?[^\\s\\p{L}\\p{N}]+[\\r\\n]*';
const SPACES = '\\s*[\\r\\n]+|\\s+(?!\\S)|\\s+';

/** `tokenizer.ggml.pre` → the pre-tokenizer's split pattern (single digits for qwen2, runs of up to three for llama-bpe). */
const PRE_PATTERNS: Record<string, RegExp> = {
  qwen2: new RegExp(`${CONTRACTION}|${TAIL}|\\p{N}|${SYMBOLS}|${SPACES}`, 'gu'),
  'llama-bpe': new RegExp(`${CONTRACTION}|${TAIL}|\\p{N}{1,3}|${SYMBOLS}|${SPACES}`, 'gu'),
};

/** Longest pre-token merged in one piece (characters). */
const SLICE = 256;

export const supportsPre = (pre: string | undefined): boolean => pre !== undefined && pre in PRE_PATTERNS;

export interface BpeVocabulary {
  pre: string;
  /** Not read: a vocabulary holds every byte symbol, so a merged piece is a token by construction. Kept for the shape Ollama returns. */
  tokens?: ArrayLike<string>;
  merges: ArrayLike<string>;
}

export class ByteLevelBpe {
  private readonly ranks = new Map<string, number>();
  private readonly pattern: RegExp;
  private readonly encoder = new TextEncoder();

  constructor(input: BpeVocabulary) {
    const pattern = PRE_PATTERNS[input.pre];
    if (!pattern) throw new Error(`unsupported pre-tokenizer "${input.pre}"`);
    this.pattern = pattern;
    for (let i = 0; i < input.merges.length; i++) if (!this.ranks.has(input.merges[i]!)) this.ranks.set(input.merges[i]!, i);
  }

  /** Tokens of `text` (no special tokens added). */
  count(text: string): number {
    if (!text) return 0;
    const memo = new Map<string, number>();
    let total = 0;
    for (const match of text.matchAll(this.pattern)) {
      const chunk = match[0];
      for (let at = 0; at < chunk.length; at += SLICE) {
        let end = Math.min(chunk.length, at + SLICE);
        const last = chunk.charCodeAt(end - 1);
        if (end < chunk.length && last >= 0xd800 && last <= 0xdbff) end++; // never cut a surrogate pair
        total += this.piece(chunk.slice(at, end), memo);
        at = end - SLICE; // the loop adds SLICE
      }
    }
    return total;
  }

  /** Tokens of one pre-token: merge the lowest-ranked adjacent pair until none is left. */
  private piece(chunk: string, memo: Map<string, number>): number {
    const known = memo.get(chunk);
    if (known !== undefined) return known;
    const symbols: string[] = Array.from(this.encoder.encode(chunk), (b) => BYTE_SYMBOLS[b]!);
    while (symbols.length > 1) {
      let best = -1;
      let bestRank = Infinity;
      for (let i = 0; i < symbols.length - 1; i++) {
        const rank = this.ranks.get(`${symbols[i]} ${symbols[i + 1]}`);
        if (rank !== undefined && rank < bestRank) {
          bestRank = rank;
          best = i;
        }
      }
      if (best < 0) break;
      const merged = symbols[best]! + symbols[best + 1]!;
      symbols.splice(best, 2, merged);
    }
    const tokens = symbols.length;
    memo.set(chunk, tokens);
    return tokens;
  }
}
