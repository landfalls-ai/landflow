/**
 * The model router of a standalone agent (docs/agents.md "Model router"): short, simple questions go to a cheaper model, the
 * rest to the agent's own. The rule is plain and local so the choice is predictable; the cheap model is any model the agent
 * could use (a local Ollama model, or an OpenAI-compatible gateway), so the components behind it can be swapped.
 */
import type { AgentModel } from './agents';

export const ROUTER_MAX_CHARS_DEFAULT = 400;
export const ROUTER_MAX_CHARS_LIMIT = 20_000;

export interface AgentRouter {
  /** `fixed`: always the agent's model. `auto`: the cheap model for a request the rule calls easy. */
  mode: 'fixed' | 'auto';
  /** The model for easy requests. */
  cheapModel?: AgentModel;
  /** A message longer than this is not easy. */
  maxChars: number;
  /** Also send easy requests to the cheap model when the agent has tools (off by default: a small model calls tools less reliably). */
  allowTools: boolean;
}

export const DEFAULT_ROUTER: AgentRouter = { mode: 'fixed', maxChars: ROUTER_MAX_CHARS_DEFAULT, allowTools: false };

export type Tier = 'cheap' | 'strong';

export interface RouteChoice {
  tier: Tier;
  /** Why, in a few words: shown in the session and the trace. */
  reason: string;
}

/** A complete router from partial or missing input; `undefined` when it would change nothing (fixed, no cheap model). */
export function cleanRouter(input: Partial<AgentRouter> | undefined): AgentRouter | undefined {
  if (!input) return undefined;
  const cheapModel = input.cheapModel?.model ? input.cheapModel : undefined;
  const mode = input.mode === 'auto' ? 'auto' : 'fixed';
  if (mode === 'fixed' && !cheapModel) return undefined;
  const maxChars = Math.min(ROUTER_MAX_CHARS_LIMIT, Math.max(20, Math.round(Number(input.maxChars) || ROUTER_MAX_CHARS_DEFAULT)));
  return { mode, ...(cheapModel && { cheapModel }), maxChars, allowTools: Boolean(input.allowTools) };
}

/** Which tier a request goes to. A resumed run (no new message) keeps the agent's own model. */
export function chooseTier(router: AgentRouter | undefined, request: { message?: string; toolCount: number }): RouteChoice {
  if (!router || router.mode !== 'auto') return { tier: 'strong', reason: 'routing is off' };
  if (!router.cheapModel?.model) return { tier: 'strong', reason: 'no cheap model chosen' };
  const message = request.message?.trim();
  if (!message) return { tier: 'strong', reason: 'resuming a run' };
  if (message.length > router.maxChars) return { tier: 'strong', reason: `longer than ${router.maxChars} characters` };
  if (request.toolCount > 0 && !router.allowTools) return { tier: 'strong', reason: 'the agent has tools' };
  return { tier: 'cheap', reason: `short request (${message.length} characters)` };
}
