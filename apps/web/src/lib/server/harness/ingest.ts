/**
 * The hook ingest (C04, C15): one Claude Code hook event in, a session's status out. In order: the registry says whether the
 * harness sends events (else 404); the per-key limits (else 429 with `retryAfter`); the binding of the event to a session by
 * (key owner, `session_id`), a Landflow agent's when the `X-Landflow-Agent` header on its first SessionStart names one the owner may run, else the owner's own; the
 * order key and the status machine (status.ts); the privacy view (privacy.ts); the store (store.ts, a conditional write);
 * the mirror into the agent's sessions; the live event. Never logs the payload: `cwd`, `transcript_path` and prompt text stay out.
 */
import { harnessById, sendsEvents, statusFor, type StatusVerdict } from '@landflow/protocol/harnesses';
import { HttpError } from '../errors';
import { agentStore } from '../agents/store';
import { bus } from '../bus';
import { contentOf } from '../journal/content';
import { canResource, type Actor } from '../projects/access';
import { classifyText, type BlockedKind } from '../../shared/quota-block';
import { countBlocked } from '../a2a/blocked';
import { logger } from '../telemetry/logger';
import { mayOpenSession, takeEvent } from './limits';
import { mirrorEvent } from './mirror';
import { countHarnessEvent, countUnknownEvent } from './metrics';
import { agentEventView, eventNameOf, ownEventView, repositoryOf } from './privacy';
import { orderKeyOf } from './status';
import { applyEvent, viewOf } from './store';
import { database } from '../db';

export type IngestResult = { status: 204 } | { status: 404 } | { status: 429; retryAfter: number };

export class HookPayloadError extends HttpError {
  static readonly errorName: string = 'HookPayloadError';
  constructor(message: string) {
    super(message, 400, { code: 'invalid_hook_event' });
  }
}

/** The header a person's hook setup adds on purpose to say "this Claude Code runs this Landflow agent" (picked on /connect). */
export const AGENT_HEADER = 'x-landflow-agent';

/**
 * The agent a session may bind to: the one the `X-Landflow-Agent` header names, when it exists and `actor` may run it. Nothing
 * in the payload can bind a session (a plugin's `agent_type` is just a name that anyone can reuse), only this explicit header.
 */
export function agentForHeader(actor: Actor, value: string | null | undefined): { id: string; name: string } | undefined {
  const id = value?.trim();
  if (!id || id.length > 100) return undefined;
  const agent = agentStore.get(id);
  return agent && canResource(actor, 'agent', agent.id, 'run') ? { id: agent.id, name: agent.name } : undefined;
}

const BLOCKED_KINDS: readonly BlockedKind[] = ['usage_limit', 'credits_depleted', 'unknown'];

/**
 * Blocked from a quota signal: Codex's `quota_blocked` event (its `kind`, else unknown: the watch's one event, C08), an explicit
 * `quota_blocked` field, or a StopFailure whose words say a usage limit or no credits.
 */
function blockedKindOf(name: string, payload: Record<string, unknown>): BlockedKind | undefined {
  if (name === 'quota_blocked') return BLOCKED_KINDS.find((kind) => kind === payload.kind) ?? 'unknown';
  if (payload.quota_blocked === true) return 'unknown';
  if (name !== 'StopFailure') return undefined;
  for (const field of ['error_details', 'last_assistant_message', 'error']) {
    const value = payload[field];
    const verdict = typeof value === 'string' ? classifyText(value) : { blocked: false as const };
    if (verdict.blocked) return verdict.kind;
  }
  return undefined;
}

export interface IngestInput {
  harness: string;
  /** The key's owner and the key. */
  actor: Actor;
  keyId: string;
  payload: unknown;
  headers: Pick<Headers, 'get'>;
  now?: number;
}

export async function ingestHookEvent(input: IngestInput): Promise<IngestResult> {
  const entry = harnessById(input.harness);
  if (!entry || !sendsEvents(entry)) return { status: 404 };
  const now = input.now ?? Date.now();
  if (!(await takeEvent(input.keyId, input.actor.id, now))) {
    countHarnessEvent(entry.id, 'limited');
    return { status: 429, retryAfter: 1 };
  }
  const payload = typeof input.payload === 'object' && input.payload !== null && !Array.isArray(input.payload) ? (input.payload as Record<string, unknown>) : undefined;
  const name = payload && eventNameOf(payload);
  const sessionKey = payload && typeof payload.session_id === 'string' && payload.session_id.length <= 200 ? payload.session_id.trim() : '';
  if (!payload || !name || !sessionKey) {
    countHarnessEvent(entry.id, 'refused');
    throw new HookPayloadError('A hook event needs hook_event_name and session_id');
  }
  const ownerId = input.actor.id;
  const existing = database().get<{ agent_id: string | null }>('SELECT agent_id FROM harness_sessions WHERE owner_id = ? AND harness = ? AND session_key = ?', ownerId, entry.id, sessionKey);
  if (!existing && !mayOpenSession(ownerId, now)) {
    countHarnessEvent(entry.id, 'limited');
    return { status: 429, retryAfter: 30 };
  }
  // A session belongs to an agent only when its first event is a SessionStart sent with an `X-Landflow-Agent` header naming an
  // agent the owner may run: any other first event, or an agent the owner may not run (AS-7), makes the owner's own session.
  // The payload's `agent_type` never binds (a plugin of any author can use any name). This is only the proposal: the row the
  // write resolves decides the binding and the view (store.ts `applyEvent`), so a race cannot leak content into an own session.
  const agent = existing || name !== 'SessionStart' ? undefined : agentForHeader(input.actor, input.headers.get(AGENT_HEADER));
  const receivedAt = new Date(now);
  let verdict: StatusVerdict | undefined = statusFor(entry, name, payload);
  if (verdict === undefined) countUnknownEvent(entry.id);
  const blocked = blockedKindOf(name, payload);
  if (blocked && verdict !== undefined) verdict = 'blocked';
  const viewFor = (bound: boolean) => {
    const view = bound ? agentEventView(payload, contentOf(undefined)) : ownEventView(payload);
    if (blocked) view.blocked = blocked;
    return view;
  };
  const repository = repositoryOf(payload);
  const applied = await applyEvent({
    ownerId,
    harness: entry.id,
    sessionKey,
    ...(agent && { agentId: agent.id }),
    name,
    orderKey: orderKeyOf(input.headers, receivedAt),
    receivedAt: receivedAt.toISOString(),
    verdict,
    viewFor,
    ...(blocked && { blocked }),
    prompt: name === 'UserPromptSubmit',
    tool: name === 'PreToolUse',
    ...(repository && { repository }),
  });
  countHarnessEvent(entry.id, applied.applied ? 'applied' : 'late');
  // One entry into Blocked from the Codex watch counts once (the metric's harness label is a small fixed set).
  if (entry.id === 'codex' && blocked && applied.applied && applied.session.status === 'blocked' && (applied.created || applied.changed)) countBlocked(blocked, 'codex');
  if (applied.session.agent_id) {
    try {
      mirrorEvent(applied.session, { id: applied.eventId, name, view: applied.view, at: receivedAt.toISOString(), orderKey: orderKeyOf(input.headers, receivedAt).value }, !applied.applied);
    } catch (error) {
      logger.warn('harness mirror failed', { error });
    }
  }
  // A wake from stale with the same status still changes what a card reads (idle (stale) to working), so it is published too.
  if (applied.changed || applied.created || applied.woke) {
    bus.publish({ channel: 'harness', ownerId, ...(applied.session.agent_id && { agentId: applied.session.agent_id }), session: viewOf(applied.session, now) });
  }
  return { status: 204 };
}
