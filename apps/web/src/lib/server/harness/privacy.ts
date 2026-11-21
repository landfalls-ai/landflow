/**
 * What a hook event may leave behind (C04 FR-7, FR-8). Two views of one payload:
 * - an own session (a person's own Claude Code) keeps status facts only: the event name, the tool name, its duration and a
 *   repository the sender named (the brain mod sends it only for an allowed one). Prompt text, tool input and output, file
 *   paths, `cwd` and `transcript_path` never reach storage or the logs.
 * - an agent session (it runs a Landflow agent the key owner may run) keeps the content, secret-redacted as run data is, then
 *   cut by the content setting as the Run Trace does: `full` (each text to 16 KB), `summaries` (texts cut short, no tool
 *   outputs), `off` (names and timings).
 */
import { JOURNAL_SUMMARY_CHARS, type TraceContent } from '../../shared/run-trace';
import { cutStrings, cutText } from '../journal/content';
import { redactValue } from '../secrets/redact';

export const CONTENT_MAX_BYTES = 16 * 1024;
const REPOSITORY = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const TOOL_NAME = /^[A-Za-z0-9_.:@-]{1,120}$/;

const record = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const text = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);

/** The event name, or undefined for a payload that names none (the route refuses it). */
export const eventNameOf = (payload: Record<string, unknown>): string | undefined => {
  const name = text(payload.hook_event_name);
  // Letters, and underscores for Codex's `quota_blocked` (C08).
  return name && /^[A-Za-z][A-Za-z_]{0,39}$/.test(name) ? name : undefined;
};

/** The `owner/name` the sender gave in `repository`, if it is one. */
export const repositoryOf = (payload: Record<string, unknown>): string | undefined => {
  const value = text(payload.repository);
  return value && REPOSITORY.test(value) ? value : undefined;
};

/** The tool name, only when it looks like one (a name, never a path or a command). */
const toolOf = (payload: Record<string, unknown>): string | undefined => {
  const name = text(payload.tool_name);
  return name && TOOL_NAME.test(name) ? name : undefined;
};

const durationOf = (payload: Record<string, unknown>): number | undefined => (typeof payload.duration_ms === 'number' && Number.isFinite(payload.duration_ms) && payload.duration_ms >= 0 ? Math.round(payload.duration_ms) : undefined);

/** What an own session's event keeps. */
export function ownEventView(payload: Record<string, unknown>): Record<string, unknown> {
  const tool = toolOf(payload);
  const duration = durationOf(payload);
  return { event: eventNameOf(payload), ...(tool && { tool }), ...(duration !== undefined && { durationMs: duration }) };
}

/** A value bounded to `max` bytes of JSON: whole when it fits, else its JSON text cut. */
function bounded(value: unknown, max: number): unknown {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return cutText(value, max);
  const json = JSON.stringify(value);
  return json.length > max ? cutText(json, max) : value;
}

/** What an agent session's event keeps, under the content setting. */
export function agentEventView(payload: Record<string, unknown>, content: TraceContent): Record<string, unknown> {
  const event = eventNameOf(payload);
  const tool = toolOf(payload);
  const duration = durationOf(payload);
  const callId = text(payload.tool_use_id)?.slice(0, 100);
  const view: Record<string, unknown> = { event, ...(tool && { tool }), ...(callId && { callId }), ...(duration !== undefined && { durationMs: duration }) };
  if (content === 'off') return view;
  const full = content === 'full';
  const shape = (value: unknown, bytes: number) => (value === undefined ? undefined : full ? bounded(redactValue(value), bytes) : cutStrings(redactValue(value), JOURNAL_SUMMARY_CHARS));
  const prompt = text(payload.prompt);
  if (prompt) view.prompt = shape(prompt, CONTENT_MAX_BYTES);
  if (payload.tool_input !== undefined) view.input = shape(record(payload.tool_input), CONTENT_MAX_BYTES);
  // Summaries drop tool outputs altogether (AS-6).
  if (full && payload.tool_response !== undefined) view.output = shape(payload.tool_response, CONTENT_MAX_BYTES);
  const reply = text(payload.last_assistant_message);
  if (reply) view.reply = shape(reply, CONTENT_MAX_BYTES);
  const error = text(payload.error);
  if (error) view.error = cutText(String(redactValue(error)), 200);
  const details = text(payload.error_details);
  if (details) view.details = shape(details, 2000);
  return view;
}
