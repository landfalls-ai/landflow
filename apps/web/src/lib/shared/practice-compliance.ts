/**
 * How a practice is followed (docs/practices.md#compliance): the counts the application rows add up to, the rates and the
 * bar's segments. Pure and shared (the server's reader, the Brain page and the tests). No runtime imports and no zod (the
 * browser loads it).
 */

/** What the rows of one practice (or one version) add up to. */
export interface ComplianceCounts {
  delivered: number;
  cited: number;
  checkPass: number;
  checkFail: number;
  waived: number;
}

export interface ComplianceVersion extends ComplianceCounts {
  version: number;
}

/** GET /api/practices/:id/compliance */
export interface PracticeCompliance extends ComplianceCounts {
  /** The window, in days. */
  days: number;
  /** The agents that cited it most (at most 10) and that the caller may read. */
  followedBy: Array<{ agentId: string; name: string }>;
  /** Agents that cited it that the caller may not read or that are gone: counted, never named ("2 other agents"). */
  otherAgents: number;
  /** The newest delivery, citation or check in the window (ISO). */
  lastApplied?: string;
  /** The run of the newest delivery, citation or check that has one (for the Run Trace link). */
  lastRunId?: string;
  /** Newest version first. */
  byVersion: ComplianceVersion[];
}

/** One practice in a run, as GET /api/executions/:id/practices lists it. */
export interface RunPracticeRow {
  handle: string;
  version: number;
  delivered: boolean;
  cited: boolean;
  check?: 'pass' | 'fail' | 'waived';
}

export const FOLLOWED_BY_MAX = 10;
export const COMPLIANCE_DAYS = { min: 1, max: 90, default: 30 } as const;

export const emptyCounts = (): ComplianceCounts => ({ delivered: 0, cited: 0, checkPass: 0, checkFail: 0, waived: 0 });

/** `part` of `whole`, 0..1; undefined when there is nothing to divide by (never NaN, never Infinity). */
export const share = (part: number, whole: number): number | undefined => (whole > 0 ? Math.min(1, Math.max(0, part / whole)) : undefined);

/** How often it was cited when it was given. */
export const citeRate = (c: Pick<ComplianceCounts, 'delivered' | 'cited'>): number | undefined => share(c.cited, c.delivered);

/** Checks passed of the checks that decided (pass and fail; a waiver is neither). */
export const passRate = (c: Pick<ComplianceCounts, 'checkPass' | 'checkFail'>): number | undefined => share(c.checkPass, c.checkPass + c.checkFail);

/** A failed check's share of the checks that decided. */
export const failRate = (c: Pick<ComplianceCounts, 'checkPass' | 'checkFail'>): number | undefined => share(c.checkFail, c.checkPass + c.checkFail);

/** A rate as "62%", or "–" when there is nothing yet. */
export const percent = (rate: number | undefined): string => (rate === undefined ? '–' : `${Math.round(rate * 100)}%`);

export type ComplianceSegmentKind = 'pass' | 'fail' | 'waived';

/** The bar's segments, each a share of the checks (pass, fail and waived); none when nothing was checked. */
export function complianceSegments(c: Pick<ComplianceCounts, 'checkPass' | 'checkFail' | 'waived'>): Array<{ kind: ComplianceSegmentKind; count: number; share: number }> {
  const total = c.checkPass + c.checkFail + c.waived;
  if (total <= 0) return [];
  return (
    [
      { kind: 'pass', count: c.checkPass },
      { kind: 'fail', count: c.checkFail },
      { kind: 'waived', count: c.waived },
    ] as const
  )
    .filter((s) => s.count > 0)
    .map((s) => ({ ...s, share: s.count / total }));
}

/** "2 other agents". */
export const otherAgentsText = (n: number): string => `${n} other agent${n === 1 ? '' : 's'}`;
