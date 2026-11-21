/**
 * Agent sessions mirrored into the agent's sessions (C04 FR-8): one `AgentSession` per harness session, source `harness`,
 * id = the harness session's id. Entries follow the events in order-key order: an event in its normal place is appended; a
 * late one makes the timeline be rebuilt from the stored events, so it lands in its own place (AS-3). What an event keeps is
 * decided by privacy.ts before it is stored; the mirror only reads those stored views.
 */
import type { HarnessStatus } from '@landflow/protocol/harnesses';
import type { AgentSession, SessionStatus, TimelineEntry } from '../../shared/agents';
import { agentStore } from '../agents/store';
import { singleton } from '../singleton';
import { eventsOf, MIRROR_TAIL, tailStartKey, type SessionRow } from './store';

type View = Record<string, unknown>;
const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const recordOf = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : { value });

/** The session's status as the Sessions tab knows it. */
export const sessionStatusOf = (status: HarnessStatus): SessionStatus => (status === 'error' || status === 'blocked' ? 'error' : status === 'idle' || status === 'ended' ? 'idle' : 'running');

/** Put one event into a timeline (pure over `timeline`: it is changed in place). */
export function applyToTimeline(timeline: TimelineEntry[], name: string, view: View, eventId: string, at: string): void {
  const callId = str(view.callId) ?? `call_${eventId}`;
  const tool = str(view.tool) ?? 'tool';
  const entryOf = () => timeline.find((entry): entry is Extract<TimelineEntry, { type: 'tool' }> => entry.type === 'tool' && entry.callId === callId);
  switch (name) {
    case 'UserPromptSubmit':
      timeline.push({ id: `u_${eventId}`, type: 'user', text: str(view.prompt) ?? '[content off]', at });
      return;
    case 'PreToolUse':
      if (!entryOf()) timeline.push({ id: `t_${callId}`, type: 'tool', callId, tool, label: tool, kind: 'a2a', input: recordOf(view.input), status: 'running', at });
      return;
    case 'PostToolUse':
    case 'PostToolUseFailure': {
      const failed = name === 'PostToolUseFailure';
      const existing = entryOf();
      const done = { status: failed ? ('error' as const) : ('success' as const), ...(view.output !== undefined && { output: view.output }), ...(typeof view.durationMs === 'number' && { durationMs: view.durationMs }), ...(failed && { error: str(view.error) ?? 'The tool failed' }) };
      if (existing) Object.assign(existing, done);
      else timeline.push({ id: `t_${callId}`, type: 'tool', callId, tool, label: tool, kind: 'a2a', input: recordOf(view.input), ...done, at });
      return;
    }
    case 'Stop':
      if (str(view.reply)) timeline.push({ id: `a_${eventId}`, type: 'assistant', text: str(view.reply)!, at, usage: { inputTokens: 0, outputTokens: 0 } });
      return;
    case 'StopFailure':
      timeline.push({ id: `e_${eventId}`, type: 'error', message: str(view.details) ?? str(view.error) ?? 'The turn failed', at });
      return;
    case 'PermissionRequest':
      timeline.push({ id: `n_${eventId}`, type: 'notice', message: `Waiting for you: ${tool === 'tool' ? 'permission' : `permission to use ${tool}`}`, at });
      return;
    case 'PreCompact':
      timeline.push({ id: `n_${eventId}`, type: 'notice', message: 'Compacting the conversation', at });
      return;
    default:
  }
}

const empty = (row: SessionRow, agentName: string, title: string): AgentSession => ({
  id: row.id,
  agentId: row.agent_id!,
  agentName,
  source: 'harness',
  userId: row.owner_id,
  title,
  status: 'idle',
  version: 'draft',
  messages: [],
  timeline: [],
  usage: { inputTokens: 0, outputTokens: 0 },
  traceIds: [],
  ...(row.project_id && { context: { projectId: row.project_id } as AgentSession['context'] }),
  createdAt: row.opened_at,
  updatedAt: row.last_event_at,
});

/** The mirrored timeline's serialized size is capped (the oldest entries go first): many large tool outputs must not make a huge row. */
export const MIRROR_MAX_BYTES = 2_000_000;
/** A session's timeline is rebuilt at most this often (ms); a late event inside the throttle marks it for the next chance. */
export const REBUILD_EVERY_MS = 1000;

/** Drop the oldest entries until the timeline serializes within `max` bytes (always keeps the newest entry). */
export function capTimelineSize(timeline: TimelineEntry[], max = MIRROR_MAX_BYTES): TimelineEntry[] {
  const sizes = timeline.map((entry) => JSON.stringify(entry).length + 1);
  let total = sizes.reduce((a, b) => a + b, 2);
  let drop = 0;
  while (total > max && drop < timeline.length - 1) total -= sizes[drop++]!;
  return drop ? timeline.slice(drop) : timeline;
}

/** Per session: when it was last rebuilt, and whether a late event is waiting for the next rebuild. */
const rebuilds = singleton('harness.mirror.rebuilds', () => new Map<string, { at: number; dirty: boolean }>());

/**
 * Mirror one stored event into its agent session. `late`: the event was not newer than the last applied one, so the whole
 * timeline is rebuilt from the stored events in order-key order.
 */
export function mirrorEvent(row: SessionRow, event: { id: string; name: string; view: View; at: string; orderKey?: string }, late: boolean, now = Date.now()): AgentSession | undefined {
  if (!row.agent_id) return undefined;
  const agent = agentStore.get(row.agent_id);
  if (!agent) return undefined;
  const session = agentStore.getSession(row.id) ?? empty(row, agent.name, 'Claude Code session');
  // A late event only matters to the mirror when it falls inside the newest MIRROR_TAIL events, and a session is rebuilt at most once a second.
  const state = rebuilds.get(row.id) ?? { at: 0, dirty: false };
  let rebuild = false;
  if (late) {
    const start = event.orderKey ? tailStartKey(row.id, MIRROR_TAIL) : undefined;
    if (!event.orderKey || start === undefined || event.orderKey >= start) {
      if (now - state.at >= REBUILD_EVERY_MS) rebuild = true;
      else state.dirty = true;
    }
  } else if (state.dirty && now - state.at >= REBUILD_EVERY_MS) rebuild = true;
  if (rebuild) {
    state.at = now;
    state.dirty = false;
  }
  if (rebuilds.size > 5000) rebuilds.clear();
  rebuilds.set(row.id, state);
  if (rebuild) {
    session.timeline = [];
    // Only the newest events are read back: a long session's rebuild stays bounded.
    for (const stored of eventsOf(row.id, MIRROR_TAIL)) applyToTimeline(session.timeline, stored.name, stored.data, stored.id, stored.receivedAt);
  } else if (!late) {
    applyToTimeline(session.timeline, event.name, event.view, event.id, event.at);
  }
  // The mirror keeps the newest entries only (the events table keeps the rest until pruned), within a size bound.
  if (session.timeline.length > MIRROR_TAIL) session.timeline = session.timeline.slice(-MIRROR_TAIL);
  session.timeline = capTimelineSize(session.timeline);
  const firstPrompt = session.timeline.find((entry) => entry.type === 'user');
  if (firstPrompt && firstPrompt.type === 'user' && firstPrompt.text !== '[content off]') session.title = firstPrompt.text.replace(/\s+/g, ' ').slice(0, 80);
  session.status = sessionStatusOf(row.status);
  return agentStore.saveSession(session);
}
