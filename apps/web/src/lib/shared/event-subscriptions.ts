/**
 * Event subscriptions (C19, docs/features/event-subscriptions.md): a project's webhooks for its runs' events, the
 * shapes the routes answer with and the card shows, and the limits both sides know.
 */

export const RUN_EVENT_TYPES = ['run.started', 'run.finished', 'run.failed', 'node.finished'] as const;
export type RunEventType = (typeof RUN_EVENT_TYPES)[number];

export const RUN_EVENT_LABELS: Record<RunEventType, string> = {
  'run.started': 'A run starts',
  'run.finished': 'A run finishes',
  'run.failed': 'A run fails',
  'node.finished': 'A chosen step finishes',
};

/** Subscriptions one project may have. */
export const MAX_SUBSCRIPTIONS_PER_PROJECT = 20;
/** The longest event body Landflow sends. */
export const MAX_EVENT_BODY_BYTES = 64 * 1024;
/** Undelivered rows kept per subscription; the dispatcher dead-letters the oldest beyond it. */
export const MAX_BACKLOG_PER_SUBSCRIPTION = 10_000;
/** The most payload bytes a subscription's waiting events may hold (the oldest are given up on beyond it). */
export const MAX_BACKLOG_BYTES = 128 * 1024 * 1024;
/** How long a row is retried before it is dead-lettered. */
export const DEAD_AFTER_MS = 72 * 3_600_000;
/** How many items of the last step an event carries with "include output". */
export const MAX_OUTPUT_ITEMS = 5;

export interface SubscriptionDelivery {
  at: string;
  /** The receiver's HTTP status, absent when it could not be reached. */
  status?: number;
  ms: number;
  error?: string;
}

/** What the API and the card see of a subscription: never the secret. */
export interface EventSubscriptionView {
  id: string;
  projectId: string;
  name: string;
  url: string;
  events: RunEventType[];
  /** Null: every workflow of the project. */
  workflowIds: string[] | null;
  /** The steps `node.finished` is sent for. */
  nodeNames: string[];
  includeOutput: boolean;
  /** Delivered one after another in the order they were created. */
  ordered: boolean;
  enabled: boolean;
  disabledReason: string | null;
  createdAt: string;
  updatedAt: string;
  lastDelivery: SubscriptionDelivery | null;
  /** Events waiting to be delivered (live rows). */
  backlog: number;
  /** Events given up on after 72 hours; Retry now brings them back. */
  dead: number;
  /** The newest failure of a waiting or dead event. */
  lastError: string | null;
  oldestAgeSeconds: number;
}

/** The one-line state the card shows for a subscription. */
export function subscriptionState(view: Pick<EventSubscriptionView, 'enabled' | 'disabledReason' | 'backlog' | 'dead' | 'lastError'>): { tone: 'ok' | 'warn' | 'danger' | 'muted'; label: string } {
  if (!view.enabled) return { tone: 'muted', label: `Disabled${view.disabledReason ? `: ${view.disabledReason}` : ''}` };
  if (view.dead > 0) return { tone: 'danger', label: `${view.dead} given up${view.lastError ? `: ${view.lastError}` : ''}` };
  if (view.lastError && view.backlog > 0) return { tone: 'warn', label: `Failing: ${view.lastError}` };
  if (view.backlog > 0) return { tone: 'warn', label: `Backlog ${view.backlog}` };
  return { tone: 'ok', label: 'Delivering' };
}

export interface EventSubscriptionInput {
  name: string;
  url: string;
  events: RunEventType[];
  workflowIds?: string[] | null;
  nodeNames?: string[];
  includeOutput?: boolean;
  ordered?: boolean;
}
