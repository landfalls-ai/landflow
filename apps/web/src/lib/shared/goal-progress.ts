/**
 * Goal progress (docs/projects-and-goals.md#progress): what moved a goal in a window, counted only from what the viewer may
 * see. No runtime imports, no zod. Wave 10 contract: PC17 owns it, PC18 copies it byte for byte.
 */

/** The windows the routes accept: days counted back from now. The nightly sync uses its own one-day window on the server. */
export const PROGRESS_WINDOWS = [7, 30] as const;
export type ProgressWindow = (typeof PROGRESS_WINDOWS)[number];

export interface GoalProgress {
  goalId: string;
  /** Days counted back from now (1 only in the nightly sync's own reads; the routes answer 7 or 30). */
  window: 1 | ProgressWindow;
  /**
   * Finished runs (one `executions` row each) in the window of the workflows whose home is a project that serves the goal
   * or one of its sub-goals, among the projects the viewer may see. `ok`: status success; `failed`: status error.
   */
  runs: { ok: number; failed: number };
  /** AI spend (USD) attributed to the goal or a sub-goal (`ai_usage.goal_id`), from projects the viewer may see. */
  costUsd: number;
  /**
   * Work events (`usage_events` of kind `work.*`) in the window that the viewer may see by the ledger's one visibility
   * rule (their own; `team` ones of teammates; `org` ones), linked to the goal or a sub-goal: by goal, by a serving
   * project, or by a linked initiative. Never another person's private event, whatever the viewer's role.
   */
  updates: number;
  /** Something happened in the window: runs.ok + runs.failed + updates > 0, or costUsd > 0. */
  moved: boolean;
  /** The newest of those runs, spend rows and updates (ISO). */
  lastActivityAt?: string;
}

/** GET /api/goals/:id/progress?window=7|30, and `progress` of GET /api/goals?progress=1&window=7|30. */
export interface GoalProgressResponse {
  progress: GoalProgress[];
}

/** One goal in the nightly briefing's "Goals that moved" (GatheredWork.goalsMoved, lib/shared/brain-work.ts). */
export interface GoalMoved {
  goalId: string;
  title: string;
  /** Short and count-only, e.g. "4 runs ok, 2 updates". Never a title, name or text of a work event. */
  because: string;
}
