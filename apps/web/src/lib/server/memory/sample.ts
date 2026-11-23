/**
 * The sampled profile (docs/second-brain.md#memory-extract, C28 FR-7, FR-8): all of a container's static facts, ranked by how
 * many sources back them, plus a bounded sample of its dynamic ones chosen by weighted buckets, then rendered as Markdown
 * inside a token budget. No model and no randomness: the same facts always give the same profile, so a test can pin it.
 * Pure.
 */
import type { MemoryItem } from '../../shared/memory';

export interface SampleWeights {
  recent: number;
  confident: number;
  revised: number;
  old: number;
  inferred: number;
}

/** Supermemory's shape, behaviour only: 35 % recent, 25 % high-confidence, 15 % often revised, 5 % old, 10 % inferred; the 10 % left over goes to the newest. */
export const DEFAULT_WEIGHTS: SampleWeights = { recent: 0.35, confident: 0.25, revised: 0.15, old: 0.05, inferred: 0.1 };
export const DEFAULT_SAMPLE_SIZE = 60;
export const DEFAULT_TOKEN_BUDGET = 1_500;
/** A Landflow-written fact under this confidence is "inferred" (C28-D11). */
const INFERRED_BELOW = 0.8;

export interface SampledProfile {
  static: MemoryItem[];
  dynamic: MemoryItem[];
  /** Dynamic facts the sample did not take. */
  left: number;
  /** How many each bucket took (`rest` is the shortfall filled from the newest left). */
  buckets: Record<keyof SampleWeights | 'rest', number>;
}

const byRecent = (a: MemoryItem, b: MemoryItem) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id);
const BUCKET_ORDER: (keyof SampleWeights)[] = ['recent', 'confident', 'revised', 'old', 'inferred'];

/** Each bucket's candidates, best first. */
const BUCKETS: Record<keyof SampleWeights, { eligible: (item: MemoryItem) => boolean; order: (a: MemoryItem, b: MemoryItem) => number }> = {
  recent: { eligible: () => true, order: byRecent },
  confident: { eligible: (i) => i.confidence !== undefined, order: (a, b) => (b.confidence ?? 0) - (a.confidence ?? 0) || byRecent(a, b) },
  revised: { eligible: (i) => (i.version ?? 1) > 1, order: (a, b) => (b.version ?? 1) - (a.version ?? 1) || byRecent(a, b) },
  old: { eligible: () => true, order: (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id) },
  inferred: { eligible: (i) => i.origin === 'landflow' && (i.confidence ?? 1) < INFERRED_BELOW, order: byRecent },
};

export function sampleProfile(items: readonly MemoryItem[], options: { size?: number; weights?: Partial<SampleWeights> } = {}): SampledProfile {
  const size = Math.max(0, Math.floor(options.size ?? DEFAULT_SAMPLE_SIZE));
  const weights = { ...DEFAULT_WEIGHTS, ...options.weights };
  const statics = items
    .filter((i) => i.static)
    .sort((a, b) => (b.evidenceCount ?? 0) - (a.evidenceCount ?? 0) || byRecent(a, b));
  const pool = items.filter((i) => !i.static);
  const taken = new Set<string>();
  const buckets = { recent: 0, confident: 0, revised: 0, old: 0, inferred: 0, rest: 0 };

  const take = (name: keyof SampleWeights | 'rest', count: number, bucket: (typeof BUCKETS)[keyof SampleWeights]) => {
    for (const item of pool.filter((i) => !taken.has(i.id) && bucket.eligible(i)).sort(bucket.order)) {
      if (buckets[name] >= count || taken.size >= size) break;
      taken.add(item.id);
      buckets[name]++;
    }
  };
  for (const name of BUCKET_ORDER) take(name, Math.floor(size * Math.max(0, weights[name])), BUCKETS[name]);
  take('rest', size, BUCKETS.recent); // what the buckets could not fill, from the newest left

  const dynamic = pool.filter((i) => taken.has(i.id)).sort(byRecent);
  return { static: statics, dynamic, left: pool.length - dynamic.length, buckets };
}

/** About four characters a token: the same rough measure the rest of Landflow budgets with. */
const tokensOf = (text: string) => Math.ceil(text.length / 4);
const clean = (text: string) => text.replace(/\s+/g, ' ').trim();

/**
 * The profile as Markdown: "Always true" (static, ranked), then "Lately" (dynamic, newest first), cut to `budgetTokens`, and a
 * last line counting what is not shown (the sample's own `left` plus whatever the budget cut). Static facts go in first, so a
 * tight budget drops the newest context before it drops the standing facts.
 */
export function profileMarkdown(sampled: Pick<SampledProfile, 'static' | 'dynamic' | 'left'>, budgetTokens = DEFAULT_TOKEN_BUDGET): { markdown: string; left: number; tokens: number } {
  const total = sampled.static.length + sampled.dynamic.length;
  const footer = (left: number) => (left > 0 ? `\n_${left} more not shown_\n` : '');
  // Keep room for the longest footer this profile could need, so the finished text never goes over.
  const room = budgetTokens * 4 - footer(total + sampled.left).length;
  const lines: string[] = [];
  let used = 0;
  let shown = 0;
  const section = (title: string, list: readonly MemoryItem[]) => {
    const head = `${lines.length ? '\n' : ''}## ${title}\n`;
    let opened = false;
    for (const item of list) {
      const line = `- ${clean(item.text)}\n`;
      const cost = line.length + (opened ? 0 : head.length);
      if (used + cost > room) break;
      if (!opened) {
        lines.push(head);
        used += head.length;
        opened = true;
      }
      lines.push(line);
      used += line.length;
      shown++;
    }
  };
  section('Always true', sampled.static);
  section('Lately', sampled.dynamic);
  const left = total - shown + sampled.left;
  const markdown = `${lines.join('')}${footer(left)}`;
  return { markdown, left, tokens: tokensOf(markdown) };
}
