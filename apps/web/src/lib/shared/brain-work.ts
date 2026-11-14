/**
 * Work items and the daily briefing (docs/work-and-briefings.md): what GET /api/brain/briefing answers and what the
 * clients (the Claude Code mod, `landflow work`, the Brain page) show. No runtime imports.
 */

export type WorkVisibility = 'private' | 'team' | 'org';

/** One piece of someone's work, as the briefing lists it. */
export interface WorkItem {
  /** The ledger row's id. */
  id: string;
  sourceId: string;
  source: string;
  kind: string;
  title: string;
  summary?: string;
  repo?: string;
  areas?: string[];
  /** When it happened (ISO). */
  at: string;
  endedAt?: string;
  url?: string;
  visibility: WorkVisibility;
}

/** A colleague whose work relates to yours, and why (empty until the person link and shared visibility land). */
export interface RelatedColleague {
  person: { name: string; userId?: string };
  items: WorkItem[];
  because: { type: 'repo' | 'initiative' | 'customer' | 'area' | 'similar'; name: string };
}

export interface Briefing {
  /** YYYY-MM-DD in the instance time zone. */
  day: string;
  generatedAt: string;
  /** `live` is built from the ledger on request; `flow` is one a workflow wrote. */
  source: 'live' | 'flow';
  today: WorkItem[];
  yesterday: WorkItem[];
  related: RelatedColleague[];
  summary?: string;
  /** The admin's setting: whether tools may send work on their own. */
  autoSend: 'allowed' | 'forbidden';
  brain: 'on' | 'off';
}

/** The instance's brain settings (`PATCH /api/settings`, `brain`). */
export interface BrainSettings {
  workAutoSend: 'allowed' | 'forbidden';
}
