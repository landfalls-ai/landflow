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
