/**
 * What the model router and the response cache saved, in USD, estimated from the sessions' own steps and the price table
 * (docs/agents.md "Layers"). Two estimates, each only as good as the prices:
 * - routing: for each answer the cheap model gave, what the agent's own model would have charged for the same tokens, less what the
 *   cheap model charged;
 * - cache: for each answer the cache gave, what an average answer of the agent's own model cost (from its answers in the same
 *   sessions); nothing when there are none to average.
 * A model with no price (a local Ollama model) costs $0, so routing to it saves the whole price of the agent's model.
 */
import { estimateCost, findPrice } from '../ai-usage/prices';
import type { ModelPrice } from '../../shared/ai-usage';
import type { AgentSession, TimelineEntry, TokenUsage } from '../../shared/agents';

export interface Savings {
  routing: number;
  cache: number;
}

export interface ModelRef {
  provider: string;
  model: string;
}

type Assistant = Extract<TimelineEntry, { type: 'assistant' }>;

const cost = (overrides: ModelPrice[], ref: ModelRef, usage: TokenUsage) =>
  estimateCost(findPrice(ref.provider, ref.model, overrides), usage.inputTokens, usage.outputTokens, usage.cacheReadTokens ?? 0, usage.cacheWriteTokens ?? 0);

/** An answer's model as the session records it: `<provider>/<model>`; the cache and guardrail are not models. */
function modelOf(entry: Assistant): ModelRef | undefined {
  if (!entry.model || entry.model === 'response cache' || entry.model === 'guardrail') return undefined;
  const slash = entry.model.indexOf('/');
  return slash > 0 ? { provider: entry.model.slice(0, slash), model: entry.model.slice(slash + 1) } : undefined;
}

/** `since` (an ISO time) limits it to the steps from then on. `own` is the agent's own model. */
export function estimateSavings(sessions: AgentSession[], own: ModelRef | undefined, overrides: ModelPrice[], since?: string): Savings {
  const savings: Savings = { routing: 0, cache: 0 };
  if (!own) return savings;
  let ownAnswers = 0;
  let ownCost = 0;
  let cacheHits = 0;
  for (const session of sessions) {
    const routed = session.timeline.some((e) => e.type === 'notice' && e.message.startsWith('Routed to '));
    for (const entry of session.timeline) {
      if (since && entry.at < since) continue;
      if (entry.type === 'notice' && entry.message.startsWith('Answered from the response cache')) cacheHits++;
      if (entry.type !== 'assistant' || !entry.usage) continue;
      const used = modelOf(entry);
      if (!used) continue;
      const actual = cost(overrides, used, entry.usage);
      const wouldBe = cost(overrides, own, entry.usage);
      if (routed) savings.routing += Math.max(0, wouldBe - actual);
      else {
        ownAnswers++;
        ownCost += actual;
      }
    }
  }
  if (ownAnswers) savings.cache = (ownCost / ownAnswers) * cacheHits;
  return savings;
}
