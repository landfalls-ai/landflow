/**
 * The parts of the practices routes the CLI reads and sends, declared here because `packages/` never import `apps/`
 * (docs/practices.md). The shapes follow `apps/web/src/lib/shared/practices.ts`.
 */
export type PracticeStrength = 'required' | 'recommended';

/** A machine check, run with no model over a change's added and modified files (see check.ts). */
export type PracticeCheck =
  | { kind: 'pathExists'; glob: string; when?: string }
  | { kind: 'pathAbsent'; glob: string; unless?: string }
  | { kind: 'fileMatches'; glob: string; pattern: string; absent?: boolean };

/** One line of `GET /api/practices/applicable`'s `practices`. */
export interface ApplicablePractice {
  /** `prc_…`: what `GET /api/practices/resolve?id=` reads it back by. */
  id: string;
  /** A project practice's project; none for an org practice. */
  projectId?: string;
  handle: string;
  version: number;
  title: string;
  level: string;
  strength: PracticeStrength;
  summary: string;
  topics: string[];
  repos: string[];
  paths: string[];
}

export interface ApplicableResponse {
  practices: ApplicablePractice[];
  text: string;
  budget?: number;
  omitted?: number;
}

/** The approved version of a `PracticeView`. */
export interface ApprovedVersion {
  version: number;
  body: string;
  checks: PracticeCheck[];
  summary?: string;
}

/** `GET /api/practices/resolve`: one approved practice in full, as delivery would give it (redacted, hash-checked). */
export interface FullPractice {
  handle: string;
  version: number;
  title: string;
  strength: PracticeStrength;
  scope: { level: string; projectId?: string; topics: string[]; repos: string[]; paths: string[] };
  summary: string;
  body: string;
  checks: PracticeCheck[];
}

export interface LearnResponse {
  drafts: Array<{ practiceId: string; handle: string; version: number; url?: string }>;
  skipped: Array<{ handle?: string; reason: string }>;
}

/** Limits the routes refuse above (`PRACTICE_LIMITS`). */
export const LEARN_FILES = 20;
export const LEARN_FILE_CHARS = 20_000;
/** `GET /api/practices/applicable` takes at most this many `path` parameters. */
export const APPLICABLE_PATHS = 20;
