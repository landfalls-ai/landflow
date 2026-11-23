/**
 * The practice-drift detector (docs/second-brain.md#detectors, docs/practices.md#compliance): an approved practice that was
 * given at least 10 times in the last 14 days and was cited under 20% of the time, or whose checks failed more than half
 * the time, is rarely followed. It files advice with the numbers and a link to the practice's page: no edit operations,
 * and nothing is applied. A cited version that is no longer approved (citation drift) is not looked at yet.
 */
import type { PracticeStrength } from '../../shared/practices';
import { citeRate, failRate, percent } from '../../shared/practice-compliance';
import { countsByPractice, inProcessDelivered } from '../practices/compliance';
import type { DetectContext, Finding } from './detectors';
import { fingerprintOf } from './proposals';

const DAY_MS = 86_400_000;
export const DRIFT_DAYS = 14;
/** Given at least this many times before the detector looks (scaled by the detector's quiet factor). */
export const DRIFT_MIN_GIVEN = 10;
/**
 * A Landflow agent's block lists every practice that applies to its project, whatever the run is about, and the rows say
 * nothing of the task or the paths it touched. So a practice given in-process counts toward the floor at one in this many
 * (the floor, for in-process runs alone, is this times the floor above) while a delivery a person or a harness asked for
 * (a repository named) counts in full.
 */
export const DRIFT_IN_PROCESS_FACTOR = 3;
export const DRIFT_CITE_BELOW = 0.2;
export const DRIFT_FAIL_ABOVE = 0.5;

interface PracticeRow {
  id: string;
  handle: string;
  title: string;
  strength: string;
  approved_version: number | null;
}

export function practiceDrift(ctx: DetectContext): Finding[] {
  const min = Math.ceil(DRIFT_MIN_GIVEN * ctx.quiet('practice-drift'));
  const since = new Date(ctx.now - DRIFT_DAYS * DAY_MS).toISOString();
  const counts = countsByPractice(since, ctx.db);
  const inProcess = inProcessDelivered(since, ctx.db);
  const findings: Finding[] = [];
  for (const [practiceId, c] of counts) {
    // Deliveries asked for count one each; the block's in-process ones count a third each (see DRIFT_IN_PROCESS_FACTOR).
    const inBlock = Math.min(c.delivered, inProcess.get(practiceId) ?? 0);
    if (c.delivered - inBlock + inBlock / DRIFT_IN_PROCESS_FACTOR < min) continue;
    const cite = citeRate(c);
    const fail = failRate(c);
    const seldomCited = cite !== undefined && cite < DRIFT_CITE_BELOW;
    const oftenFailed = fail !== undefined && fail > DRIFT_FAIL_ABOVE;
    if (!seldomCited && !oftenFailed) continue;
    const practice = ctx.db.get<PracticeRow>(`SELECT id, handle, title, strength, approved_version FROM practices WHERE id = ? AND status = 'approved'`, practiceId);
    if (!practice) continue;
    const reasons = [seldomCited && `it was cited in ${percent(cite)} of the ${c.delivered} times it was given`, oftenFailed && `${c.checkFail} of ${c.checkPass + c.checkFail} checks failed`].filter(Boolean);
    const confidence = seldomCited && oftenFailed ? 0.85 : 0.7;
    findings.push({
      proposal: {
        source: 'detector',
        detector: 'practice-drift',
        fingerprint: fingerprintOf('practice-drift', practice.id),
        target: { type: 'instance', name: practice.handle },
        title: `Review ${practice.title}: rarely followed`,
        why: `In the last ${DRIFT_DAYS} days, ${reasons.join(' and ')}. ${(practice.strength as PracticeStrength) === 'required' ? 'It is required' : 'It is recommended'}, so either agents are not seeing what it asks or the rule no longer fits the work. Read it, then reword it, narrow its scope or retire it.`,
        evidence: [
          { label: 'Practice', value: practice.handle, href: `/brain/practices/${practice.id}` },
          { label: 'Given (14 days)', value: c.delivered },
          { label: 'Cited', value: `${c.cited} (${percent(cite)})` },
          { label: 'Checks passed', value: c.checkPass },
          { label: 'Checks failed', value: c.checkFail },
          ...(c.waived ? [{ label: 'Waived', value: c.waived }] : []),
        ],
        effect: 'A rule agents follow, or no rule that only looks followed',
        ops: [],
        risk: 'low',
        confidence,
        score: Math.round((c.delivered / 10) * confidence * 100) / 100,
      },
    });
  }
  return findings;
}
