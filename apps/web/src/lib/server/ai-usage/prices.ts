/**
 * The price table: USD per million input and output tokens, by provider and model. Built-in defaults
 * cover Anthropic and OpenAI list prices; Ollama (and anything else that runs locally) costs nothing.
 * Settings → AI prices overrides or adds entries; they are kept in the `settings` table under
 * `ai_prices`. Lookup: exact model id first, then the longest default/override that is a prefix of it
 * (dated snapshots such as `gpt-4o-mini-2024-07-18`), within the provider, then across providers (an
 * OpenAI-compatible proxy serving Claude). `vendor/` prefixes (OpenRouter's `anthropic/…`) are ignored.
 */
import { z } from 'zod';
import type { ModelPrice, PriceTable } from '../../shared/ai-usage';
import { database, type Database } from '../db';

export const PRICES_KEY = 'ai_prices';

const round = (value: number) => Math.round(value * 1e6) / 1e6;
/** Anthropic: a cache read costs 0.1× the input price, a (5-minute) cache write 1.25×. */
const anthropic = (model: string, input: number, output: number): ModelPrice => ({ provider: 'anthropic', model, input, output, cacheRead: round(input * 0.1), cacheWrite: round(input * 1.25) });
/** OpenAI: cached input has its own list price; there is no charge for writing to the cache. */
const openai = (model: string, input: number, output: number, cacheRead?: number): ModelPrice => ({ provider: 'openai', model, input, output, ...(cacheRead !== undefined && { cacheRead }) });

/** List prices, USD per 1M tokens (input / output). */
export const DEFAULT_PRICES: ModelPrice[] = [
  anthropic('claude-fable-5-1', 10, 50),
  anthropic('claude-fable-5', 10, 50),
  anthropic('claude-opus-5-5', 4, 20),
  anthropic('claude-opus-5', 5, 25),
  anthropic('claude-opus-4-8', 5, 25),
  anthropic('claude-opus-4-7', 5, 25),
  anthropic('claude-opus-4-6', 5, 25),
  anthropic('claude-opus-4-5', 5, 25),
  anthropic('claude-opus-4-1', 15, 75),
  anthropic('claude-opus-4', 15, 75),
  anthropic('claude-sonnet-5-5', 2, 10),
  anthropic('claude-sonnet-5', 2, 10),
  anthropic('claude-sonnet-4-6', 3, 15),
  anthropic('claude-sonnet-4-5', 3, 15),
  anthropic('claude-sonnet-4', 3, 15),
  anthropic('claude-3-7-sonnet', 3, 15),
  anthropic('claude-3-5-sonnet', 3, 15),
  anthropic('claude-haiku-5-5', 0.1, 0.5),
  anthropic('claude-haiku-4-5', 1, 5),
  anthropic('claude-3-5-haiku', 0.8, 4),
  anthropic('claude-3-haiku', 0.25, 1.25),
  openai('gpt-5', 1.25, 10, 0.125),
  openai('gpt-5-mini', 0.25, 2, 0.025),
  openai('gpt-5-nano', 0.05, 0.4, 0.005),
  openai('gpt-4.1', 2, 8, 0.5),
  openai('gpt-4.1-mini', 0.4, 1.6, 0.1),
  openai('gpt-4.1-nano', 0.1, 0.4, 0.025),
  openai('gpt-4o', 2.5, 10, 1.25),
  openai('gpt-4o-mini', 0.15, 0.6, 0.075),
  openai('o3', 2, 8, 0.5),
  openai('o3-mini', 1.1, 4.4, 0.55),
  openai('o4-mini', 1.1, 4.4, 0.275),
  openai('o1', 15, 60, 7.5),
  openai('text-embedding-3-small', 0.02, 0),
  openai('text-embedding-3-large', 0.13, 0),
  openai('text-embedding-ada-002', 0.1, 0),
];

const priceSchema = z.object({
  provider: z.string().trim().min(1).max(40),
  model: z.string().trim().min(1).max(200),
  input: z.number().min(0).max(100_000),
  output: z.number().min(0).max(100_000),
  cacheRead: z.number().min(0).max(100_000).optional(),
  cacheWrite: z.number().min(0).max(100_000).optional(),
});
export const priceOverridesSchema = z.array(priceSchema).max(500);

/** Providers that run on your own hardware: free unless priced in Settings. */
const LOCAL = new Set(['ollama']);

const normal = (model: string) => model.trim().toLowerCase().replace(/^[a-z0-9_.-]+\//, '');

/** Saved overrides (Settings → AI prices). */
export function priceOverrides(db: Database = database()): ModelPrice[] {
  try {
    const raw = db.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', PRICES_KEY)?.value;
    const parsed = priceOverridesSchema.safeParse(raw ? JSON.parse(raw) : []);
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

export function savePriceOverrides(overrides: unknown, db: Database = database()): ModelPrice[] {
  const parsed = priceOverridesSchema.parse(overrides);
  db.upsert('settings', { key: PRICES_KEY, value: JSON.stringify(parsed) });
  return parsed;
}

export function priceTable(db?: Database): PriceTable {
  return { defaults: DEFAULT_PRICES, overrides: priceOverrides(db) };
}

/** The price that applies to `provider`/`model`; undefined when nothing matches (the call costs $0). */
export function findPrice(provider: string, model: string, overrides: ModelPrice[] = []): ModelPrice | undefined {
  const id = normal(model);
  const system = provider.trim().toLowerCase();
  // Overrides first, then (for hosted providers) the defaults; each: exact, then longest prefix.
  const lists = LOCAL.has(system) ? [overrides] : [overrides, DEFAULT_PRICES];
  for (const sameProvider of [true, false]) {
    for (const list of lists) {
      const candidates = list.filter((p) => !sameProvider || p.provider.toLowerCase() === system);
      const exact = candidates.find((p) => normal(p.model) === id);
      if (exact) return exact;
      const prefix = candidates.filter((p) => id.startsWith(normal(p.model))).sort((a, b) => b.model.length - a.model.length)[0];
      if (prefix) return prefix;
    }
    // A local provider only takes overrides for itself.
    if (LOCAL.has(system)) return undefined;
  }
  return undefined;
}

/**
 * Estimated cost in USD. `inputTokens` is the whole prompt; the cached parts (`cacheReadTokens`, `cacheWriteTokens`)
 * are priced at the model's cache prices (the input price when it has none) and the rest at the input price.
 */
export function estimateCost(price: ModelPrice | undefined, inputTokens: number, outputTokens: number, cacheReadTokens = 0, cacheWriteTokens = 0): number {
  if (!price) return 0;
  const cached = Math.min(inputTokens, cacheReadTokens + cacheWriteTokens);
  const read = cached ? Math.min(cacheReadTokens, cached) : 0;
  const write = cached - read;
  const plain = Math.max(0, inputTokens - cached);
  return (plain * price.input + read * (price.cacheRead ?? price.input) + write * (price.cacheWrite ?? price.input) + outputTokens * price.output) / 1_000_000;
}
