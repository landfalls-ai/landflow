/**
 * What the browser sees of a harness session (C04): the live status of a Claude Code session, as listed by
 * `GET /api/harness/sessions` and carried by the `harness` bus event. Types and constants only (browser-safe).
 */
import type { HarnessStatus } from '@landflow/protocol/harnesses';

export type { HarnessStatus };

export interface HarnessSessionView {
  id: string;
  /** The registry id of the harness that sent it (`claude-code`). */
  harness: string;
  status: HarnessStatus;
  /** True when no event arrived for 30 minutes: the status is then shown as idle (stale). */
  stale: boolean;
  /** When the status last changed (ISO). */
  changedAt: string;
  lastEventAt: string;
  openedAt: string;
  closedAt?: string;
  /** The Landflow agent this session runs (an agent session), else it is the owner's own. */
  agentId?: string;
  /** `owner/name`, only when the sender said so (the brain mod sends it for allowed repositories only). */
  repository?: string;
  prompts: number;
  toolCalls: number;
}

/** The status in words (docs/ui-review.md words), for a chip. */
export const HARNESS_STATUS_LABELS: Record<HarnessStatus, string> = {
  thinking: 'Thinking',
  working: 'Working',
  compacting: 'Compacting',
  waiting: 'Waiting for you',
  idle: 'Idle',
  error: 'Error',
  blocked: 'Blocked',
  ended: 'Ended',
};

/** The bus event's payload channel name (docs/harnesses.md#live-status). */
export const HARNESS_CHANNEL = 'harness';

/** The chip's words: a stale session (no event for 30 minutes) reads "Idle (stale)", whatever its last status was. */
export function harnessChipLabel(session: Pick<HarnessSessionView, 'status' | 'stale'>): string {
  return session.stale && session.status !== 'ended' ? 'Idle (stale)' : HARNESS_STATUS_LABELS[session.status];
}

export type HarnessChipTone = 'accent' | 'warning' | 'danger' | 'muted';

/** Its colour: busy is the accent, waiting and blocked ask for a person, error is red, idle and ended are quiet. */
export function harnessChipTone(session: Pick<HarnessSessionView, 'status' | 'stale'>): HarnessChipTone {
  if (session.stale) return 'muted';
  switch (session.status) {
    case 'thinking':
    case 'working':
    case 'compacting':
      return 'accent';
    case 'waiting':
    case 'blocked':
      return 'warning';
    case 'error':
      return 'danger';
    default:
      return 'muted';
  }
}

/** The open sessions after a live event: the session replaces its old row (or joins), a closed or ended one leaves, newest event first. */
export function mergeHarnessSession(list: readonly HarnessSessionView[], session: HarnessSessionView): HarnessSessionView[] {
  const rest = list.filter((s) => s.id !== session.id);
  if (session.closedAt || session.status === 'ended') return rest;
  return [session, ...rest].sort((a, b) => b.lastEventAt.localeCompare(a.lastEventAt));
}

/** Each agent's newest open session, for the Agents page (the list is newest first). */
export function newestByAgent(list: readonly HarnessSessionView[]): Map<string, HarnessSessionView> {
  const out = new Map<string, HarnessSessionView>();
  for (const s of list) if (s.agentId && !s.closedAt && !out.has(s.agentId)) out.set(s.agentId, s);
  return out;
}
