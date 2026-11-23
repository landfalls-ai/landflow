/**
 * The local models Settings → AI prices lists (docs/observability.md, "Prices"): every model seen in the last 30 days
 * on a provider that runs on your own hardware, whether Landflow called it (`ollama`) or the gateway did (`ollama_chat`,
 * kept in `ai_usage.gateway_provider`), with its calls and tokens and the override that prices it now. Numbers and
 * names only. A price applies from the moment it is saved; recorded calls keep the cost they had.
 */
import { database, type Database } from '../db';
import type { AiLocalModel } from '../../shared/ai-spend';
import type { ModelPrice } from '../../shared/ai-usage';
import { findPrice, isLocalProvider, LOCAL_PROVIDERS, priceOverrides } from './prices';

const DAY_MS = 86_400_000;
export const LOCAL_MODEL_DAYS = 30;

interface Row {
  provider: string;
  gateway_provider: string | null;
  model: string;
  calls: number | null;
  input: number | null;
  output: number | null;
  last_at: string | null;
}

/** `ollama_chat/qwen3-coder:30b` and `qwen3-coder:30b` are one model. */
export const localModelName = (model: string): string => model.replace(/^(?:ollama_chat|ollama)\//i, '');

/** The override that prices `model` now (any local provider's override covers it), or undefined: "Not priced". */
export function localPrice(model: string, overrides: ModelPrice[]): ModelPrice | undefined {
  return findPrice('ollama', model, overrides);
}

export function localModels(now: number = Date.now(), db: Database = database()): AiLocalModel[] {
  const marks = LOCAL_PROVIDERS.map(() => '?').join(', ');
  const rows = db.all<Row>(
    `SELECT provider, gateway_provider, model, COUNT(*) AS calls, COALESCE(SUM(input_tokens), 0) AS input, COALESCE(SUM(output_tokens), 0) AS output, MAX(at) AS last_at
     FROM ai_usage WHERE at >= ? AND (provider IN (${marks}) OR gateway_provider IN (${marks})) GROUP BY provider, gateway_provider, model`,
    new Date(now - LOCAL_MODEL_DAYS * DAY_MS).toISOString(),
    ...LOCAL_PROVIDERS,
    ...LOCAL_PROVIDERS,
  );
  const overrides = priceOverrides(db);
  const byModel = new Map<string, AiLocalModel>();
  for (const row of rows) {
    const model = localModelName(row.model);
    // The local name a row was seen under: the provider itself, else the gateway's name for it.
    const seenUnder = isLocalProvider(row.provider) ? row.provider : (row.gateway_provider ?? row.provider);
    const entry = byModel.get(model) ?? { model, providers: [], calls: 0, inputTokens: 0, outputTokens: 0, lastAt: '' };
    if (!entry.providers.includes(seenUnder)) entry.providers.push(seenUnder);
    entry.calls += Number(row.calls ?? 0);
    entry.inputTokens += Number(row.input ?? 0);
    entry.outputTokens += Number(row.output ?? 0);
    if (row.last_at && row.last_at > entry.lastAt) entry.lastAt = row.last_at;
    byModel.set(model, entry);
  }
  return [...byModel.values()]
    .map((entry) => {
      const price = localPrice(entry.model, overrides);
      return { ...entry, providers: entry.providers.sort(), ...(price && { price }) };
    })
    .sort((a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens) || a.model.localeCompare(b.model));
}
