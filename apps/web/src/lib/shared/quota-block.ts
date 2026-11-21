/**
 * The Codex quota classifier (C05): is this record, or this error text, a provider stopping a turn because the quota or
 * the credits ran out? One pure function pair for the A2A node, an agent's A2A tool and a team member call, and later the
 * CLI watch and the Claude Code hooks, so every path agrees on what Blocked means. Imports nothing: browser-safe.
 */

export type BlockedKind = 'usage_limit' | 'credits_depleted' | 'unknown';
export type BlockVerdict = { blocked: true; kind: BlockedKind; message: string } | { blocked: false };

/** The kind in words, as the Run Trace and the node's error say it. */
export const BLOCKED_LABEL: Record<BlockedKind, string> = {
  usage_limit: 'Codex usage limit reached',
  credits_depleted: 'Codex credits depleted',
  unknown: 'Blocked by a provider limit',
};

const MAX_MESSAGE = 500;
const NOT_BLOCKED: BlockVerdict = { blocked: false };

const cut = (text: string) => (text.length > MAX_MESSAGE ? text.slice(0, MAX_MESSAGE) : text);
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown) => (typeof value === 'string' && value.trim() ? value : undefined);
const mentionsCredits = (value: unknown) => typeof value === 'string' && /credits?/i.test(value);

/**
 * A Codex rollout record (`event_msg` with a `task_complete` error, or a `token_count`) or the bare error shape an A2A
 * status data part carries. `context.rateLimitType` is the last `token_count`'s `rate_limit_reached_type`, which names
 * credits when a workspace ran out of them.
 */
export function classifyRecord(record: unknown, context: { rateLimitType?: string } = {}): BlockVerdict {
  if (!isObject(record)) return NOT_BLOCKED;
  const body = isObject(record.payload) ? record.payload : record;
  const error = isObject(body.error) ? body.error : body;
  const own = str(body.rate_limit_reached_type) ?? str(error.rate_limit_reached_type);
  const info = str(error.codex_error_info);
  const message = str(error.message) ?? str(body.message);
  const kindOf = (limitType: string | undefined): BlockedKind => (mentionsCredits(limitType) ? 'credits_depleted' : 'usage_limit');
  if (info === 'usage_limit_exceeded') return { blocked: true, kind: kindOf(own ?? context.rateLimitType), message: cut(message ?? BLOCKED_LABEL.usage_limit) };
  // Any other error info is an ordinary error.
  if (info) return NOT_BLOCKED;
  // A token_count (or a bare error shape) that itself names the limit it reached.
  if (own && (body.type === 'token_count' || !str(body.type))) return { blocked: true, kind: kindOf(own), message: cut(message ?? own) };
  return NOT_BLOCKED;
}

/**
 * Free text: an A2A status message or an error data string. Whole phrases only, so "rate limited by the gateway" and
 * "model not supported" stay ordinary failures. A kagent Codex runtime may not pass `codex_error_info` through, which is
 * why the words are matched at all (docs/limitations.md).
 */
export function classifyText(text: string | undefined): BlockVerdict {
  if (!text) return NOT_BLOCKED;
  const words = text.toLowerCase().replace(/[_-]+/g, ' ');
  if (/\bcredits depleted\b|\bout of credits\b/.test(words)) return { blocked: true, kind: 'credits_depleted', message: cut(text) };
  if (/\busage limit\b/.test(words)) return { blocked: true, kind: 'usage_limit', message: cut(text) };
  if (/\brate limit reached type\b/.test(words)) return { blocked: true, kind: 'unknown', message: cut(text) };
  return NOT_BLOCKED;
}
