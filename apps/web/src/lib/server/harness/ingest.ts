/**
 * The hook ingest (C04, C15): one Claude Code hook event in, a session's status out. In order: the registry says whether the
 * harness sends events (else 404); the per-key limits (else 429 with `retryAfter`); the binding of the event to a session by
 * (key owner, `session_id`), a Landflow agent's when `agent_type` names one the owner may run, else the owner's own; the
 * order key and the status machine (status.ts); the privacy view (privacy.ts); the store (store.ts, a conditional write);
 * the mirror into the agent's sessions; the live event. Never logs the payload: `cwd`, `transcript_path` and prompt text stay out.
 */
import { harnessById, sendsEvents, statusFor, type StatusVerdict } from '@landflow/protocol/harnesses';
import { HttpError } from '../errors';
import { agentStore } from '../agents/store';
import { bus } from '../bus';
import { contentOf } from '../journal/content';
import { slugOf } from '../marketplace/export';
import { canResource, type Actor } from '../projects/access';
import { classifyText } from '../../shared/quota-block';
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

/** `<slug>:<slug>` (a Landflow agent plugin and its agent), as exported by marketplace/export.ts. */
const AGENT_TYPE = /^([a-z0-9][a-z0-9-]{0,59}):([a-z0-9][a-z0-9-]{0,59})$/;

/** The one agent `agentType` names that `actor` may run, or undefined (no such agent, several, or not theirs to run). */
export function agentForType(actor: Actor, agentType: unknown): { id: string; name: string } | undefined {
  const match = typeof agentType === 'string' ? AGENT_TYPE.exec(agentType) : null;
  if (!match || match[1] !== match[2]) return undefined;
  const named = agentStore.list().filter((agent) => slugOf(agent.name) === match[1]);
  const runnable = named.filter((agent) => canResource(actor, 'agent', agent.id, 'run'));
  return runnable.length === 1 && named.length === 1 ? { id: runnable[0].id, name: runnable[0].name } : undefined;
}

/** Blocked from a quota signal: an explicit `quota_blocked` field, or a StopFailure whose words say a usage limit or no credits. */
function blockedKindOf(name: string, payload: Record<string, unknown>): string | undefined {
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
  if (!(await takeEvent(input.keyId, now))) {
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
  // The binding is fixed by the session's first event (an agent that cannot be run stays the owner's own, AS-7).
  const agent = existing ? (existing.agent_id ? { id: existing.agent_id } : undefined) : agentForType(input.actor, payload.agent_type);
  const receivedAt = new Date(now);
  let verdict: StatusVerdict | undefined = statusFor(entry, name, payload);
  if (verdict === undefined) countUnknownEvent(entry.id);
  const blocked = blockedKindOf(name, payload);
  if (blocked && verdict !== undefined) verdict = 'blocked';
  const view = agent ? agentEventView(payload, contentOf(undefined)) : ownEventView(payload);
  if (blocked) view.blocked = blocked;
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
    view,
    prompt: name === 'UserPromptSubmit',
    tool: name === 'PreToolUse',
    ...(repository && { repository }),
  });
  countHarnessEvent(entry.id, applied.applied ? 'applied' : 'late');
  if (agent) {
    try {
      mirrorEvent(applied.session, { id: applied.eventId, name, view, at: receivedAt.toISOString() }, !applied.applied);
    } catch (error) {
      logger.warn('harness mirror failed', { error });
    }
  }
  if (applied.changed || applied.created) {
    bus.publish({ channel: 'harness', ownerId, ...(applied.session.agent_id && { agentId: applied.session.agent_id }), session: viewOf(applied.session, now) });
  }
  return { status: 204 };
}
