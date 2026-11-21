/**
 * The provider quota classifier (C05): is this record, or this error text, a provider stopping a turn because the quota
 * or the credits ran out? One pure function pair for the A2A node, an agent's A2A tool and a team member call, and later
 * the CLI watch and the Claude Code hooks, so every path agrees on what Blocked means. Imports nothing: browser-safe.
 */

export type BlockedKind = 'usage_limit' | 'credits_depleted' | 'unknown';
/** `label` is the kind in words: "Codex ..." only when the verdict came from Codex's own `codex_error_info`. */
export type BlockVerdict = { blocked: true; kind: BlockedKind; message: string; label: string } | { blocked: false };

/** The kind in words for a verdict that came from Codex's own error info. */
export const BLOCKED_LABEL: Record<BlockedKind, string> = {
  usage_limit: 'Codex usage limit reached',
  credits_depleted: 'Codex credits depleted',
  unknown: 'Blocked by a provider limit',
};

/** The kind in words for a verdict read from text or another provider's error shape: no provider is named. */
export const NEUTRAL_LABEL: Record<BlockedKind, string> = {
  usage_limit: 'Usage limit reached',
  credits_depleted: 'Credits depleted',
  unknown: 'Blocked by a provider limit',
};

const MAX_MESSAGE = 500;
const NOT_BLOCKED: BlockVerdict = { blocked: false };

const cut = (text: string) => (text.length > MAX_MESSAGE ? text.slice(0, MAX_MESSAGE) : text);
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown) => (typeof value === 'string' && value.trim() ? value : undefined);
const mentionsCredits = (value: unknown) => typeof value === 'string' && /credits?/i.test(value);
/** A `rate_limit_reached_type` that names a limit (credits, or something `*_limit*`); window names like "primary" do not count. */
const namesLimit = (value: string | undefined): value is string => value !== undefined && /credits?|limit/i.test(value);

const verdict = (kind: BlockedKind, message: string, codex: boolean): BlockVerdict => ({ blocked: true, kind, message: cut(message), label: (codex ? BLOCKED_LABEL : NEUTRAL_LABEL)[kind] });

/**
 * A Codex rollout record (`event_msg` with a `task_complete` error, or a `token_count`) or the bare error shape an A2A
 * status data part carries; OpenAI's `insufficient_quota` error code or type is credits depleted. `context.rateLimitType`
 * is the last `token_count`'s `rate_limit_reached_type`, which names credits when a workspace ran out of them.
 */
export function classifyRecord(record: unknown, context: { rateLimitType?: string } = {}): BlockVerdict {
  if (!isObject(record)) return NOT_BLOCKED;
  const body = isObject(record.payload) ? record.payload : record;
  const error = isObject(body.error) ? body.error : body;
  const limits = isObject(body.rate_limits) ? body.rate_limits : undefined;
  const own = str(limits?.rate_limit_reached_type) ?? str(body.rate_limit_reached_type) ?? str(error.rate_limit_reached_type);
  const info = str(error.codex_error_info);
  const message = str(error.message) ?? str(body.message);
  const kindOf = (limitType: string | undefined): BlockedKind => (mentionsCredits(limitType) ? 'credits_depleted' : 'usage_limit');
  if (info === 'usage_limit_exceeded') return verdict(kindOf(own ?? context.rateLimitType), message ?? BLOCKED_LABEL.usage_limit, true);
  // Any other Codex error info is an ordinary error.
  if (info) return NOT_BLOCKED;
  if (error.code === 'insufficient_quota' || error.type === 'insufficient_quota') return verdict('credits_depleted', message ?? NEUTRAL_LABEL.credits_depleted, false);
  // A token_count (or a bare error shape) that itself names the limit it reached.
  if (namesLimit(own) && (body.type === 'token_count' || !str(body.type))) return verdict(kindOf(own), message ?? own, true);
  return NOT_BLOCKED;
}

/**
 * Free text: an A2A status message or an error data string. Provider phrasing only ("hit your usage limit", "usage limit
 * reached", "out of credits", OpenAI's "exceeded your current quota", Anthropic's "credit balance is too low"), so
 * "model not supported", "rate limited by the gateway", "Container exceeded its memory usage limit" and "No usage limit is
 * set" stay ordinary failures. A kagent Codex runtime may not pass `codex_error_info` through, which is why the words are
 * matched at all (docs/limitations.md).
 */
export function classifyText(text: string | undefined): BlockVerdict {
  if (!text) return NOT_BLOCKED;
  const words = text.toLowerCase().replace(/[_-]+/g, ' ');
  if (/\bcredits? depleted\b|\bout of credits\b|\binsufficient quota\b|\bexceeded your current quota\b|\bcredit balance is too low\b/.test(words)) return verdict('credits_depleted', text, false);
  if (/(?<!\b(?:memory|cpu|disk|storage|no) )(?:\b(?:hit|reached) (?:your )?usage limit\b|\busage limit (?:reached|exceeded)\b)/.test(words)) return verdict('usage_limit', text, false);
  return NOT_BLOCKED;
}
